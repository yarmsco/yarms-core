// Model-agnostic LLM layer (Vercel AI SDK). Consolidates yarms_agents'
// battle-tested modelClient (retry budget, cache-token accounting, Anthropic-shaped
// drop-in, document extraction) with registry-driven routing.
//
// The model for a call is resolved from the Registry by `taskKey` (falling back to
// the caller's `model` / *_MODEL env), so a task's model can be changed centrally
// with one Registry row. Two surfaces:
//   generate({ taskKey, model, system, prompt, webSearch })  → { text, model, tokens }
//   create({ taskKey, model, max_tokens, system, messages }) → Anthropic-shaped drop-in
// The AI SDK is ESM, loaded via a cached dynamic import().

const { resolveModel } = require('../registry');
const logger = require('../usage/logger');

// Retry budget for transient provider errors (429 / 500 / 529 Overloaded). ~5
// spans ~60s of exponential backoff — enough to ride out a multi-batch
// "Overloaded" window (the kind that wiped a period's commentary on 2026-06-05).
const MAX_RETRIES = Number(process.env.MODEL_MAX_RETRIES) || 5;

function providerOf(model) {
  return /^gemini/i.test(model) ? 'google' : 'anthropic';
}

let _sdk = null;
async function _loadSdk() {
  if (!_sdk) {
    const ai = await import('ai');
    _sdk = { generateText: ai.generateText, stepCountIs: ai.stepCountIs };
  }
  return _sdk;
}
async function _model(effModel) {
  if (providerOf(effModel) === 'google') {
    const { createGoogleGenerativeAI } = await import('@ai-sdk/google');
    const provider = createGoogleGenerativeAI({ apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY });
    return provider(effModel);
  }
  const { anthropic } = await import('@ai-sdk/anthropic');
  return anthropic(effModel);
}
// Usage across EVERY step of a generateText result, in Anthropic field names.
// result.usage / result.providerMetadata describe the LAST step only; a call that
// ran tools (web search, stopWhen) bills every step, so each step's raw Anthropic
// usage is summed. Non-Anthropic providers fall back to the SDK's totalUsage.
function usageOf(result) {
  const steps = result.steps?.length ? result.steps : [result];
  const raws = steps.map((s) => s.providerMetadata?.anthropic?.usage).filter(Boolean);
  if (raws.length === steps.length) {
    const n = (f) => raws.reduce((t, u) => t + (f(u) || 0), 0);
    return {
      input_tokens: n((u) => u.input_tokens),
      output_tokens: n((u) => u.output_tokens),
      cache_read_input_tokens: n((u) => u.cache_read_input_tokens),
      cache_creation_input_tokens: n((u) => u.cache_creation_input_tokens),
      cache_creation: { ephemeral_1h_input_tokens: n((u) => u.cache_creation?.ephemeral_1h_input_tokens) },
      server_tool_use: { web_search_requests: n((u) => u.server_tool_use?.web_search_requests) },
    };
  }
  const t = result.totalUsage || result.usage || {};
  const d = t.inputTokenDetails || {};
  const searches = steps.reduce((c, s) => c + (s.toolCalls || []).filter((tc) => /search/i.test(tc.toolName || '')).length, 0);
  return {
    input_tokens: d.noCacheTokens ?? Math.max(0, (t.inputTokens || 0) - (d.cacheReadTokens || 0) - (d.cacheWriteTokens || 0)),
    output_tokens: t.outputTokens || 0,
    cache_read_input_tokens: d.cacheReadTokens || 0,
    cache_creation_input_tokens: d.cacheWriteTokens || 0,
    server_tool_use: { web_search_requests: searches },
  };
}

// The model that served the call: the response's id, not the one asked for.
function servedModel(result, effModel) {
  const steps = result.steps || [];
  return steps[steps.length - 1]?.response?.modelId || result.response?.modelId || effModel;
}

// Research/one-shot call with optional web search + registry routing.
// Every call below is logged into the current run (logger.startRun().scope()),
// or as unattributed if there is none — callers never log model calls themselves.
async function generate({ taskKey, model, system, prompt, webSearch = true, maxOutputTokens = 2000, maxRetries = MAX_RETRIES, callType }) {
  const effModel = await resolveModel(taskKey, model || 'claude-sonnet-4-6');
  const { generateText, stepCountIs } = await _loadSdk();

  let tools;
  if (providerOf(effModel) === 'google') {
    const { google } = await import('@ai-sdk/google');
    tools = webSearch ? { google_search: google.tools.googleSearch({}) } : undefined;
  } else {
    const { anthropic } = await import('@ai-sdk/anthropic');
    tools = webSearch ? { web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }) } : undefined;
  }

  const res = await generateText({
    model: await _model(effModel), system, prompt, tools,
    stopWhen: stepCountIs(5), maxOutputTokens, maxRetries,
  });

  const usage = usageOf(res);
  const served = servedModel(res, effModel);
  await logger.record({ model: served, usage, callType, taskKey });
  return {
    text: (res.text || '').trim(), model: served, usage,
    inputTokens: usage.input_tokens, outputTokens: usage.output_tokens,
    cacheReadTokens: usage.cache_read_input_tokens, cacheWriteTokens: usage.cache_creation_input_tokens,
    webSearchRequests: usage.server_tool_use.web_search_requests,
  };
}

// Anthropic-shaped drop-in for message-style calls (retries + cache tokens).
// Returns { model, content:[{type:'text',text}], usage:{ input_tokens, ... } } so
// existing call sites + logger.logClaudeCall() need no changes.
async function create({ taskKey, model, max_tokens = 4096, system, messages, maxRetries = MAX_RETRIES, callType }) {
  const effModel = await resolveModel(taskKey, model);
  const { generateText } = await _loadSdk();
  const result = await generateText({ model: await _model(effModel), system: system || undefined, messages, maxOutputTokens: max_tokens, maxRetries });
  const usage = usageOf(result);
  const served = servedModel(result, effModel);
  await logger.record({ model: served, usage, callType, taskKey });
  return {
    model: served,
    content: [{ type: 'text', text: result.text || '' }],
    usage,
  };
}

// Document/vision extraction (e.g. a PDF) via the AI SDK's unified file part.
async function extractFromDocument({ taskKey, model, max_tokens = 2048, system, fileBuffer, mediaType = 'application/pdf', userText, maxRetries = MAX_RETRIES, callType }) {
  const effModel = await resolveModel(taskKey, model);
  const { generateText } = await _loadSdk();
  const result = await generateText({
    model: await _model(effModel), system: system || undefined,
    messages: [{ role: 'user', content: [{ type: 'file', data: fileBuffer, mediaType }, { type: 'text', text: userText }] }],
    maxOutputTokens: max_tokens, maxRetries,
  });
  const usage = usageOf(result);
  const served = servedModel(result, effModel);
  await logger.record({ model: served, usage, callType, taskKey });
  return { text: result.text || '', model: served, usage, finishReason: result.finishReason || null };
}

module.exports = { generate, create, messages: { create }, extractFromDocument, providerOf, usageOf };
