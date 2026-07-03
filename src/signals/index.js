// Signals: how clients (and the review loops) feed findings back to the center.
// A bug, an improvement idea, or a build-activity note becomes a row in `findings`
// that the Control Plane triages and surfaces in Slack. Best-effort.

const { usageDb } = require('../db');

const DEFAULT_CLIENT = process.env.YARMS_CLIENT || 'unknown';

// type: 'bug' | 'improvement' | 'model_efficiency' | 'build'
async function recordFinding({ type, client = DEFAULT_CLIENT, agent = null, title, detail = null, severity = 'med', metadata = {} }) {
  try {
    const d = usageDb();
    if (!d) return null;
    const { data, error } = await d.from('findings')
      .insert([{ type, client, agent, title, detail, severity, metadata }])
      .select('id').single();
    if (error) throw error;
    return data.id;
  } catch (e) {
    console.warn('[yarms-core/signals] recordFinding failed (ignored):', e.message);
    return null;
  }
}

// Transition a finding by id — the missing half of the loop. Used to close a
// roadmap item (status='done') so it drops off the daily build report, or to
// reopen one (status='open') if it was closed by mistake. `metadata`, when given,
// is merged into the existing row (read-modify-write) so we don't clobber prior
// context — we record who/why closed it (closed_by, reason, sha) for audit + undo.
// Best-effort; returns true on success, false if unconfigured or the row is gone.
async function resolveFinding(id, { status = 'done', metadata = null } = {}) {
  try {
    const d = usageDb();
    if (!d || !id) return false;
    const patch = { status };
    if (metadata) {
      const { data: cur } = await d.from('findings').select('metadata').eq('id', id).single();
      patch.metadata = { ...(cur?.metadata || {}), ...metadata };
    }
    const { data, error } = await d.from('findings').update(patch).eq('id', id).select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0; // false if no row matched the id
  } catch (e) {
    console.warn('[yarms-core/signals] resolveFinding failed (ignored):', e.message);
    return false;
  }
}

module.exports = { recordFinding, resolveFinding };
