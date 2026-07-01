// The ONE true usage logger (consolidated from yarms_agents' battle-tested
// internal_tools/usage/usageLogger.js). Writes call + run rows to the central
// `usage_log` (USAGE_SUPABASE_*), tagged client/agent/call_type/model/tokens/cost,
// so the Control Plane can attribute spend per task. Cache-aware pricing + QB-call
// counting included. Best-effort: a logging failure warns, never breaks the run.
//
// Two ways to log a call:
//   logClaudeCall(rawResponse, callType)  — pass a raw Anthropic-shaped response
//   logCall({ model, inputTokens, outputTokens, callType })  — explicit numbers
// Clients: `const { logger } = require('yarms-core')` — do NOT copy this.

const { usageDb } = require('../db');

// $/million tokens. Keep in sync as models/prices change — the efficiency loop
// reads this to price swaps.
const PRICING = {
  'claude-opus-4-8':           { input: 5.0,  output: 25.0 },
  'claude-opus-4-7':           { input: 5.0,  output: 25.0 },
  'claude-opus-4-6':           { input: 5.0,  output: 25.0 },
  'claude-sonnet-4-6':         { input: 3.0,  output: 15.0 },
  'claude-haiku-4-5-20251001': { input: 1.0,  output: 5.0 },
  'claude-haiku-4-5':          { input: 1.0,  output: 5.0 },
  'gemini-2.5-pro':            { input: 1.25, output: 10.0 },
  'gemini-2.5-flash':          { input: 0.30, output: 2.5 },
};

// Cache-aware cost. Anthropic bills uncached input at full rate, cache READS at
// ~10%, cache WRITES (5-min ephemeral) at ~125%. Cache args default to 0, so
// non-caching callers price exactly as full input+output.
function _costUSD(model, inputTokens, outputTokens, cacheReadTokens = 0, cacheWriteTokens = 0) {
  const p = PRICING[model] || PRICING['claude-sonnet-4-6'];
  return parseFloat(
    ((inputTokens / 1e6) * p.input +
     (cacheReadTokens / 1e6) * p.input * 0.10 +
     (cacheWriteTokens / 1e6) * p.input * 1.25 +
     (outputTokens / 1e6) * p.output).toFixed(6)
  );
}
// Back-compat simple cost (no cache).
function cost(model, inTok, outTok) { return _costUSD(model, inTok, outTok, 0, 0); }

const DEFAULT_CLIENT = process.env.YARMS_CLIENT || 'unknown';

let _ctx = null;
let _calls = [];
let _qbCalls = 0;

function setRunContext({ client = DEFAULT_CLIENT, agent, label } = {}) {
  _ctx = { client, agent, label, runId: `${client}_${label || agent}_${Date.now()}`, startedAt: new Date().toISOString() };
  _calls = [];
  _qbCalls = 0;
}
function getRunContext() { return _ctx; }

function _push(e) {
  const costUSD = _costUSD(e.model, e.inputTokens, e.outputTokens, e.cacheReadTokens, e.cacheWriteTokens);
  _calls.push({ ...e, costUSD });
}

// Explicit-numbers path (e.g. the web-search `generate()` callers).
function logCall({ model, inputTokens = 0, outputTokens = 0, cacheReadTokens = 0, cacheWriteTokens = 0, callType = 'commentary' }) {
  if (!_ctx) return;
  _push({ model, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, callType });
}

// Raw Anthropic-shaped response path (message-style calls, cache-aware).
function logClaudeCall(response, callType = 'commentary') {
  if (!_ctx) return;
  const u = response.usage || {};
  _push({
    model: response.model || 'claude-sonnet-4-6',
    inputTokens: u.input_tokens || 0,
    outputTokens: u.output_tokens || 0,
    cacheReadTokens: u.cache_read_input_tokens || 0,
    cacheWriteTokens: u.cache_creation_input_tokens || 0,
    callType,
  });
}

function incrementQBCall() { if (_ctx) _qbCalls++; }

function _row(level, e) {
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
    cache_read_tokens: e.cacheReadTokens ?? 0,
    cache_write_tokens: e.cacheWriteTokens ?? 0,
    cost_usd: e.costUSD ?? null,
    qb_api_calls: level === 'run' ? _qbCalls : null,
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
    cacheReadTokens: sum('cacheReadTokens'),
    cacheWriteTokens: sum('cacheWriteTokens'),
    costUSD: parseFloat(sum('costUSD').toFixed(6)),
  };
  try {
    const d = usageDb();
    if (d && _calls.length) {
      const rows = [..._calls.map((e) => _row('call', e)), _row('run', runEntry)];
      const { error } = await d.from('usage_log').insert(rows);
      if (error) throw error;
    }
  } catch (e) {
    console.warn('[yarms-core/usage] usage_log write failed (run still completed):', e.message);
  }
  _ctx = null;
  _calls = [];
  _qbCalls = 0;
}

module.exports = { setRunContext, getRunContext, logCall, logClaudeCall, incrementQBCall, finalizeRun, cost, PRICING };
