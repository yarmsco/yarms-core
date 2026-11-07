// The ONE usage logger for yarms-core consumers (portal, control plane). Writes
// to the central `usage_log` (USAGE_SUPABASE_*). Best-effort: a logging failure
// warns, never breaks a run.
//
//   const { logger } = require('yarms-core');
//   const run = logger.startRun({ client: 'yarms_portal', agent: 'brief', label: company });
//   try {
//     await run.scope(async () => {
//       await llm.generate({ taskKey, ... });   // logged automatically — see below
//     });
//     await run.finish();                       // the run row: "this completed"
//   } ...
//
// ── WHY v0.4.0 CHANGED THIS (2026-11-07) ────────────────────────────────────
//
// v0.3.0 kept ONE run context per process (setRunContext / finalizeRun). The
// portal runs Express and node-cron in one process, so two runs overlapping —
// the 5-minute booking brief and an hourly bookkeeping guess, a web request and a
// cron — wiped each other's calls or dropped them once the other finalized. And
// every caller had to remember to call logCall, with its own model and tokens.
//
// Now:
//   · Each run is its own object, bound to the async work it starts
//     (AsyncLocalStorage), so overlapping runs never see each other.
//   · The llm layer logs every call itself, into the current run. Outside any run
//     it still logs — as an unattributed call row with a warning — because a call
//     nobody claimed still cost money.
//   · Call rows are written AS THEY HAPPEN. A run that throws spent the money too.
//   · Writers record facts only: model, token counts by kind, web searches. The
//     PRICE is set by the database (db/usage_pricing.sql: model_prices + a
//     trigger), so a new model or a price change is one row there, not an edit to
//     every logger — the drift that kept breaking this.

const { AsyncLocalStorage } = require('async_hooks');
const { usageDb } = require('../db');

// ── Facts from a response ───────────────────────────────────────────────────

// Anthropic-shaped usage ({ input_tokens, cache_creation: {...}, server_tool_use })
// → the columns usage_log stores. `cache_creation_input_tokens` is ALL writes; the
// 1-hour subset is reported separately because it bills at 2x, not 1.25x.
function factsFromUsage(u = {}) {
  return {
    inputTokens:      u.input_tokens || 0,
    outputTokens:     u.output_tokens || 0,
    cacheReadTokens:  u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    cacheWrite1hTokens: u.cache_creation?.ephemeral_1h_input_tokens || 0,
    webSearchRequests:  u.server_tool_use?.web_search_requests || 0,
  };
}

// ── Writing ─────────────────────────────────────────────────────────────────

// Columns added by db/usage_pricing.sql. If that migration has not been applied,
// an insert naming them fails, so the write is retried without them rather than
// losing the row.
const NEW_COLUMNS = ['cache_write_1h_tokens', 'web_search_requests'];
let _newColumnsMissing = false;

function _toRow(e) {
  const row = {
    ts: e.timestamp,
    level: e.level,
    client: e.client,
    agent: e.agent,
    label: e.label || null,
    run_id: e.runId || null,
    call_type: e.callType || null,
    model: e.model || null,
    input_tokens: e.inputTokens ?? null,
    output_tokens: e.outputTokens ?? null,
    cache_read_tokens: e.cacheReadTokens ?? null,
    cache_write_tokens: e.cacheWriteTokens ?? null,
    cache_write_1h_tokens: e.cacheWrite1hTokens ?? null,
    web_search_requests: e.webSearchRequests ?? null,
    qb_api_calls: e.qbApiCalls ?? null,
    claude_calls: e.claudeCalls ?? null,
  };
  if (_newColumnsMissing) for (const c of NEW_COLUMNS) delete row[c];
  return row;
}

async function _persistRows(entries) {
  const d = usageDb();
  if (!d) { console.warn('[yarms-core/usage] USAGE_SUPABASE_* not set — usage not logged'); return; }
  let { error } = await d.from('usage_log').insert(entries.map(_toRow));
  if (error && !_newColumnsMissing && NEW_COLUMNS.some((c) => String(error.message).includes(c))) {
    _newColumnsMissing = true;
    console.warn('[yarms-core/usage] usage_log lacks the db/usage_pricing.sql columns — writing without them');
    ({ error } = await d.from('usage_log').insert(entries.map(_toRow)));
  }
  if (error) throw error;
}

function _writer(writeRows) {
  const pending = new Set();
  const write = (entries) => {
    const p = Promise.resolve()
      .then(() => writeRows(entries))
      .catch((err) => console.warn(`[yarms-core/usage] usage_log write failed: ${err.message}`))
      .finally(() => pending.delete(p));
    pending.add(p);
    return p;
  };
  write.drain = () => Promise.all([...pending]);
  return write;
}

// ── Runs ────────────────────────────────────────────────────────────────────

const _scope = new AsyncLocalStorage();

function startRun({ client, agent, label }, { writeRows = _persistRows } = {}) {
  if (!client || !agent) throw new Error('startRun needs both client and agent');
  const ctx = { client, agent, label: label || null, runId: `${client}_${label || agent}_${Date.now()}`, startedAt: new Date().toISOString() };
  const calls = [];
  let qbCalls = 0;
  let finished = false;
  const write = _writer(writeRows);

  const run = {
    ...ctx,

    // One model call. `usage` is Anthropic-shaped; `model` is the model that
    // actually served it (the response's id, not the one asked for).
    logUsage({ model, usage, callType = null }) {
      const entry = {
        timestamp: new Date().toISOString(), level: 'call',
        client: ctx.client, agent: ctx.agent, label: ctx.label, runId: ctx.runId,
        callType, model: model || null, ...factsFromUsage(usage),
      };
      calls.push(entry);
      return write([entry]);
    },

    incrementQBCall() { qbCalls++; },

    // The run row. Only work that completed calls this; the database sums its
    // call rows for the cost.
    async finish() {
      if (finished) return;
      finished = true;
      const sum = (f) => calls.reduce((s, e) => s + (e[f] || 0), 0);
      await write.drain();   // call rows land before the row that closes them
      await write([{
        timestamp: new Date().toISOString(), level: 'run',
        client: ctx.client, agent: ctx.agent, label: ctx.label, runId: ctx.runId,
        model: calls[0]?.model || null,
        inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'),
        cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens'),
        cacheWrite1hTokens: sum('cacheWrite1hTokens'), webSearchRequests: sum('webSearchRequests'),
        qbApiCalls: qbCalls, claudeCalls: calls.length,
      }]);
    },

    // Run fn with this run as currentRun() for everything it awaits.
    scope(fn) { return _scope.run(run, fn); },
  };
  return run;
}

function currentRun() { return _scope.getStore() || null; }

// A call outside any run: still written, under YARMS_CLIENT (or 'unattributed')
// and the task key, with no run_id — so the daily report counts the spend and
// shows where an entry point forgot to start a run.
let _orphanWrite = null;
function _logOrphan({ model, usage, callType, taskKey }, writeRows = _persistRows) {
  if (!_orphanWrite) _orphanWrite = _writer(writeRows);
  const agent = taskKey || 'unattributed';
  console.warn(`[yarms-core/usage] model call (${callType || agent}) outside any run — logged as unattributed; wrap its entry point in logger.startRun().scope()`);
  return _orphanWrite([{
    timestamp: new Date().toISOString(), level: 'call',
    client: process.env.YARMS_CLIENT || 'unattributed', agent, label: 'unattributed',
    callType: callType || null, model: model || null, ...factsFromUsage(usage),
  }]);
}

// What the llm layer calls after every model call.
function record({ model, usage, callType, taskKey }) {
  const run = currentRun();
  if (run && typeof run.logUsage === 'function') return run.logUsage({ model, usage, callType: callType || taskKey || null });
  return _logOrphan({ model, usage, callType, taskKey });
}

// Run fn inside a fresh run, finishing it on success. The common case in one line.
async function withRun(ctx, fn, opts) {
  const run = startRun(ctx, opts);
  const out = await run.scope(() => fn(run));
  await run.finish();
  return out;
}

// v0.3.0's process-global API. Removed: it is the bug described above. Calling it
// throws so a stale caller fails loudly at the first test, not silently in prod.
function _removed(name) {
  return () => { throw new Error(`yarms-core logger.${name} was removed in v0.4.0 — use logger.startRun(...).scope(...) (see src/usage/logger.js)`); };
}

module.exports = {
  startRun, currentRun, withRun, record, factsFromUsage,
  setRunContext: _removed('setRunContext'), finalizeRun: _removed('finalizeRun'),
  logCall: _removed('logCall'), logClaudeCall: _removed('logClaudeCall'), getRunContext: _removed('getRunContext'),
  _toRow,
};
