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

// Edit a finding's content in place — the piece Slack "edit an item" needs. Only
// the fields passed are touched (agent/project, title, detail); `status` stays put
// (use resolveFinding for that). Best-effort; returns true if a row was updated.
async function updateFinding(id, { agent, title, detail } = {}) {
  try {
    const d = usageDb();
    if (!d || !id) return false;
    const patch = {};
    if (agent !== undefined) patch.agent = agent;
    if (title !== undefined) patch.title = title;
    if (detail !== undefined) patch.detail = detail;
    if (!Object.keys(patch).length) return false;
    const { data, error } = await d.from('findings').update(patch).eq('id', id).select('id');
    if (error) throw error;
    return Array.isArray(data) && data.length > 0;
  } catch (e) {
    console.warn('[yarms-core/signals] updateFinding failed (ignored):', e.message);
    return false;
  }
}

// List findings (default: open ones), oldest-first — so a Slack surface can build a
// board or an edit picker from the live rows rather than re-parsing message blocks.
// Best-effort; returns [] if unconfigured or on error.
async function listFindings({ type, status = 'open', client } = {}) {
  try {
    const d = usageDb();
    if (!d) return [];
    let q = d.from('findings').select('id,type,client,agent,title,detail,severity,status,created_at');
    if (type) q = q.eq('type', type);
    if (status) q = q.eq('status', status);
    if (client) q = q.eq('client', client);
    const { data, error } = await q.order('created_at', { ascending: true });
    if (error) throw error;
    return data || [];
  } catch (e) {
    console.warn('[yarms-core/signals] listFindings failed (ignored):', e.message);
    return [];
  }
}

module.exports = { recordFinding, resolveFinding, updateFinding, listFindings };
