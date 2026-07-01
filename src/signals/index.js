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

module.exports = { recordFinding };
