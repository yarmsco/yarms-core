// Model-agnostic LLM layer (Vercel AI SDK). Consolidates yarms_agents'
// battle-tested modelClient (retry budget, cache-token accounting, Anthropic-shaped
// drop-in, document extraction) with registry-driven routing + eval sampling.
//
// The model for a call is resolved from the Registry by `taskKey` (falling back to
// the caller's `model` / *_MODEL env), so the efficiency loop can retune routing
// centrally. Two surfaces:
//   generate({ taskKey, model, system, prompt, webSearch })  → { text, model, tokens }
//   create({ taskKey, model, max_tokens, system, messages }) → Anthropic-shaped drop-in
// The AI SDK is ESM, loaded via a cached dynamic import().

const { resolveModel, recordEvalSample } = require('../registry');

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
function _cacheUsage(result) {
  const a = result.providerMetadata?.anthropic?.usage || {};
  const u = result.usage || {};
  return {
    input_tokens: a.input_tokens ?? u.inputTokens ?? 0,
    output_tokens: a.output_tokens ?? u.outputTokens ?? 0,
    cache_read_input_tokens: a.cache_read_input_tokens ?? 0,
    cache_creation_input_tokens: a.cache_creation_input_tokens ?? 0,
  };
}

// Research/one-shot call with optional web search + registry routing + eval sampling.
async function generate({ taskKey, model, system, prompt, webSearch = true, maxOutputTokens = 2000, maxRetries = MAX_RETRIES, sampleEval = true }) {
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

  const u = _cacheUsage(res);
  const out = { text: (res.text || '').trim(), model: effModel, inputTokens: u.input_tokens, outputTokens: u.output_tokens };

  if (taskKey && sampleEval) {
    await recordEvalSample({ taskKey, model: effModel, system, prompt, output: out.text, inputTokens: out.inputTokens, outputTokens: out.outputTokens });
  }
  return out;
}

// Anthropic-shaped drop-in for message-style calls (retries + cache tokens).
// Returns { model, content:[{type:'text',text}], usage:{ input_tokens, ... } } so
// existing call sites + logger.logClaudeCall() need no changes.
async function create({ taskKey, model, max_tokens = 4096, system, messages, maxRetries = MAX_RETRIES }) {
  const effModel = await resolveModel(taskKey, model);
  const { generateText } = await _loadSdk();
  const result = await generateText({ model: await _model(effModel), system: system || undefined, messages, maxOutputTokens: max_tokens, maxRetries });
  return {
    model: result.response?.modelId || effModel,
    content: [{ type: 'text', text: result.text || '' }],
    usage: _cacheUsage(result),
  };
}

// Document/vision extraction (e.g. a PDF) via the AI SDK's unified file part.
async function extractFromDocument({ taskKey, model, max_tokens = 2048, system, fileBuffer, mediaType = 'application/pdf', userText, maxRetries = MAX_RETRIES }) {
  const effModel = await resolveModel(taskKey, model);
  const { generateText } = await _loadSdk();
  const result = await generateText({
    model: await _model(effModel), system: system || undefined,
    messages: [{ role: 'user', content: [{ type: 'file', data: fileBuffer, mediaType }, { type: 'text', text: userText }] }],
    maxOutputTokens: max_tokens, maxRetries,
  });
  return { text: result.text || '', usage: _cacheUsage(result) };
}

module.exports = { generate, create, messages: { create }, extractFromDocument, providerOf };
