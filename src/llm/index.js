// Model-agnostic LLM layer (Vercel AI SDK). The model for a task is resolved from
// the Registry by `taskKey` (falling back to the caller's model / *_MODEL env), so
// the efficiency loop can retune routing centrally. Records an eval sample per
// task-keyed call for later A/B. The AI SDK is ESM, loaded via dynamic import().

const { resolveModel, recordEvalSample } = require('../registry');

function providerOf(model) {
  return /^gemini/i.test(model) ? 'google' : 'anthropic';
}

// generate({ taskKey?, model, system, prompt, webSearch, maxOutputTokens, sampleEval })
// Returns { text, model, inputTokens, outputTokens }. `model` is the EFFECTIVE model used.
async function generate({ taskKey, model, system, prompt, webSearch = true, maxOutputTokens = 2000, sampleEval = true }) {
  const effModel = await resolveModel(taskKey, model || 'claude-sonnet-4-6');
  const { generateText, stepCountIs } = await import('ai');

  let llm, tools;
  if (providerOf(effModel) === 'google') {
    const { createGoogleGenerativeAI, google } = await import('@ai-sdk/google');
    const provider = createGoogleGenerativeAI({
      apiKey: process.env.GEMINI_API_KEY || process.env.GOOGLE_GENERATIVE_AI_API_KEY,
    });
    llm = provider(effModel);
    tools = webSearch ? { google_search: google.tools.googleSearch({}) } : undefined;
  } else {
    const { anthropic } = await import('@ai-sdk/anthropic');
    llm = anthropic(effModel);
    tools = webSearch ? { web_search: anthropic.tools.webSearch_20250305({ maxUses: 5 }) } : undefined;
  }

  const res = await generateText({ model: llm, system, prompt, tools, stopWhen: stepCountIs(5), maxOutputTokens });

  const u = res.usage || {};
  const out = {
    text: (res.text || '').trim(),
    model: effModel,
    inputTokens: u.inputTokens ?? u.promptTokens ?? 0,
    outputTokens: u.outputTokens ?? u.completionTokens ?? 0,
  };

  // Feed the loop: sample this (input → output) so the efficiency loop can replay it
  // on a cheaper model and judge parity. Best-effort; only for task-keyed calls.
  if (taskKey && sampleEval) {
    await recordEvalSample({
      taskKey, model: effModel, system, prompt, output: out.text,
      inputTokens: out.inputTokens, outputTokens: out.outputTokens,
    });
  }

  return out;
}

module.exports = { generate, providerOf };
