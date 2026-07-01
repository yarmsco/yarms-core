// Central usage/registry Supabase client (the ONE shared telemetry + rules store,
// USAGE_SUPABASE_*). Service-role. Memoized; returns null if unconfigured so every
// caller can no-op gracefully (logging/registry must never break a client's run).
const { createClient } = require('@supabase/supabase-js');

let _db = null;
let _resolved = false;

function usageDb() {
  if (_resolved) return _db;
  _resolved = true;
  const url = process.env.USAGE_SUPABASE_URL;
  const key = process.env.USAGE_SUPABASE_SERVICE_KEY;
  if (url && key) _db = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
  return _db;
}

module.exports = { usageDb };
