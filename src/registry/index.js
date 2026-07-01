// The Registry: the center's model-mapping + eval-sample store. The llm layer
// resolves the model for a task here; the efficiency loop writes proposals here.
// Cached with a short TTL so a Registry change propagates to every client within
// the TTL — no redeploy needed to act on an approved downgrade.

const { usageDb } = require('../db');

const TTL_MS = Number(process.env.YARMS_REGISTRY_TTL_MS || 60000);
const _cache = new Map(); // task_key -> { model, exp }

// Resolve the model for a task: Registry override → caller fallback → lib default.
async function resolveModel(taskKey, fallback = 'claude-sonnet-4-6') {
  if (!taskKey) return fallback;
  const hit = _cache.get(taskKey);
  if (hit && hit.exp > Date.now()) return hit.model || fallback;

  let model = fallback;
  try {
    const d = usageDb();
    if (d) {
      const { data, error } = await d.from('model_registry').select('model').eq('task_key', taskKey).maybeSingle();
      if (error) throw error;
      if (data && data.model) model = data.model;
    }
  } catch (e) {
    console.warn('[yarms-core/registry] resolveModel failed, using fallback:', e.message);
  }
  _cache.set(taskKey, { model, exp: Date.now() + TTL_MS });
  return model;
}

// Set/replace a task's model mapping (used by the efficiency loop on approval, or seeding).
async function setModel(taskKey, model, { rationale = null, evidence = {}, updatedBy = 'human' } = {}) {
  const d = usageDb();
  if (!d) throw new Error('USAGE_SUPABASE_* not configured');
  const { error } = await d.from('model_registry').upsert(
    { task_key: taskKey, model, rationale, evidence, updated_by: updatedBy, updated_at: new Date().toISOString() },
    { onConflict: 'task_key' }
  );
  if (error) throw error;
  _cache.delete(taskKey);
}

// Store a sampled (input, output) for later A/B replay. Best-effort.
async function recordEvalSample({ taskKey, model, system, prompt, output, inputTokens, outputTokens }) {
  try {
    const d = usageDb();
    if (!d || !taskKey) return;
    await d.from('eval_samples').insert([{
      task_key: taskKey, model,
      system_prompt: system || null, prompt: prompt || null, output: output || null,
      input_tokens: inputTokens ?? null, output_tokens: outputTokens ?? null,
    }]);
  } catch (e) {
    console.warn('[yarms-core/registry] recordEvalSample failed (ignored):', e.message);
  }
}

function _clearCache() { _cache.clear(); } // for tests

module.exports = { resolveModel, setModel, recordEvalSample, _clearCache };
