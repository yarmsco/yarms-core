// The Registry: the center's task → model mapping. The llm layer resolves the
// model for a task here. Cached with a short TTL so a Registry change propagates to
// every client within the TTL — no redeploy needed to change a task's model.

const { usageDb } = require('../db');

const TTL_MS = Number(process.env.YARMS_REGISTRY_TTL_MS || 60000);
const _cache = new Map(); // task_key -> { model, exp }

// Resolve the model for a task: Registry override → caller fallback → lib default.
async function resolveModel(taskKey, fallback = 'claude-sonnet-4-6') {
  if (!taskKey) return fallback;
  const hit = _cache.get(taskKey);
  if (hit && hit.exp > Date.now()) return hit.model || fallback;

  let override = null;
  try {
    const d = usageDb();
    if (d) {
      const { data, error } = await d.from('model_registry').select('model').eq('task_key', taskKey).maybeSingle();
      if (error) throw error;
      if (data && data.model) override = data.model;
    }
  } catch (e) {
    console.warn('[yarms-core/registry] resolveModel failed, using fallback:', e.message);
  }
  // Only cache a real Registry override. If there is none, do not cache the
  // caller's fallback — another call site with the same taskKey may pass a
  // different fallback and must resolve to its own, not this one's.
  if (override) _cache.set(taskKey, { model: override, exp: Date.now() + TTL_MS });
  return override || fallback;
}

// Set/replace a task's model mapping (a manual model change, or seeding).
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

function _clearCache() { _cache.clear(); } // for tests

module.exports = { resolveModel, setModel, _clearCache };
