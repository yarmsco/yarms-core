// The ONE true usage logger. Writes call + run rows to the central `usage_log`,
// tagged client / agent / call_type / model / tokens / cost, so the Control Plane
// can attribute spend per task. Best-effort: a logging failure warns but never
// breaks the run. No-op if USAGE_SUPABASE_* is unset.
//
// Client codebases: `const { logger } = require('yarms-core')` — do NOT copy this.

const { usageDb } = require('../db');

// $/million tokens (self-computed → lower bound; provider console is truth).
// Keep in sync as models/prices change — the efficiency loop reads this to price swaps.
const PRICING = {
  'claude-opus-4-8': { in: 5.0, out: 25.0 },
  'claude-sonnet-4-6': { in: 3.0, out: 15.0 },
  'claude-haiku-4-5': { in: 1.0, out: 5.0 },
  'gemini-2.5-pro': { in: 1.25, out: 10.0 },
  'gemini-2.5-flash': { in: 0.30, out: 2.5 },
};
function cost(model, inTok, outTok) {
  const p = PRICING[model] || { in: 3.0, out: 15.0 };
  return parseFloat(((inTok / 1e6) * p.in + (outTok / 1e6) * p.out).toFixed(6));
}

// Default client name for a repo can be set once via YARMS_CLIENT env.
const DEFAULT_CLIENT = process.env.YARMS_CLIENT || 'unknown';

let _ctx = null;
let _calls = [];

function setRunContext({ client = DEFAULT_CLIENT, agent, label } = {}) {
  _ctx = { client, agent, label, runId: `${client}_${agent}_${Date.now()}` };
  _calls = [];
}

function logCall({ model, inputTokens = 0, outputTokens = 0, callType = 'commentary' }) {
  if (!_ctx) return;
  _calls.push({ model, inputTokens, outputTokens, callType, cost: cost(model, inputTokens, outputTokens) });
}

function row(level, e) {
  return {
    ts: new Date().toISOString(),
    level,
    client: _ctx.client,
    agent: _ctx.agent,
    label: _ctx.label || null,
    run_id: _ctx.runId,
    call_type: e.callType || null,
    model: e.model || null,
    input_tokens: e.inputTokens ?? null,
    output_tokens: e.outputTokens ?? null,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: e.cost ?? null,
    claude_calls: level === 'run' ? _calls.length : 1,
  };
}

async function finalizeRun() {
  if (!_ctx) return;
  const sum = (k) => _calls.reduce((s, e) => s + (e[k] || 0), 0);
  const runEntry = {
    model: _calls[0]?.model,
    inputTokens: sum('inputTokens'),
    outputTokens: sum('outputTokens'),
    cost: parseFloat(sum('cost').toFixed(6)),
  };
  try {
    const d = usageDb();
    if (d && _calls.length) {
      const rows = [..._calls.map((e) => row('call', e)), row('run', runEntry)];
      const { error } = await d.from('usage_log').insert(rows);
      if (error) throw error;
    }
  } catch (e) {
    console.warn('[yarms-core/usage] usage_log write failed (run still completed):', e.message);
  }
  _ctx = null;
  _calls = [];
}

module.exports = { setRunContext, logCall, finalizeRun, cost, PRICING };
