// Do a repo's Railway service settings match its railway.json?
//
//   node yarms-core/scripts/check-railway.js <repo dir> [<repo dir> …]
//
// WHY (2026-11-26). Railway stops reading railway.json / railway.toml on 2026-12-01
// ("Existing Config as Code files stop being read on 2026-12-01 (hard cutoff)"). From
// then on a service builds and starts from its dashboard settings, which were empty for
// every service: yarms_agents would have started with no start command and none of its
// agent folders installed, and the portal through `npm start`, which swallows SIGTERM
// so a deploy kills it mid-run (yarms-core lifecycle). The settings were copied into
// each service on 2026-11-26. railway.json stays in each repo as the record of what
// they must be, and this compares the two, so a change in one place is not lost.
// Read-only. Uses the Railway CLI's own login (~/.railway/config.json) and the link in
// each repo (`railway status --json`).

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execSync } = require('child_process');

// railway.json key → serviceInstance field.
const FIELDS = [
  ['build.buildCommand', 'buildCommand'],
  ['deploy.startCommand', 'startCommand'],
  ['deploy.healthcheckPath', 'healthcheckPath'],
  ['deploy.healthcheckTimeout', 'healthcheckTimeout'],
  ['deploy.restartPolicyType', 'restartPolicyType'],
  ['deploy.restartPolicyMaxRetries', 'restartPolicyMaxRetries'],
];
const get = (o, k) => k.split('.').reduce((a, p) => (a == null ? a : a[p]), o);

function token() {
  const cfg = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.railway', 'config.json'), 'utf8'));
  const t = cfg.user && (cfg.user.accessToken || cfg.user.token);
  if (!t) throw new Error('no Railway CLI login (run `railway login`)');
  return t;
}

async function gql(query) {
  const r = await fetch('https://backboard.railway.com/graphql/v2', {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token()}` },
    body: JSON.stringify({ query }),
  });
  const j = await r.json();
  if (j.errors) throw new Error(j.errors.map((e) => e.message).join('; '));
  return j.data;
}

async function check(dir) {
  const want = JSON.parse(fs.readFileSync(path.join(dir, 'railway.json'), 'utf8'));
  const st = JSON.parse(execSync('railway status --json', { cwd: dir, encoding: 'utf8' }));
  const env = st.environments.edges.map((e) => e.node).find((e) => e.name === 'production');
  const out = [];
  for (const si of env.serviceInstances.edges.map((e) => e.node)) {
    const live = (await gql(`query { serviceInstance(environmentId: "${env.id}", serviceId: "${si.serviceId}") { ${FIELDS.map((f) => f[1]).join(' ')} } }`)).serviceInstance;
    for (const [file, field] of FIELDS) {
      const w = get(want, file);
      if (w === undefined) continue;
      if (String(live[field]) !== String(w)) out.push(`${path.basename(dir)} · ${si.serviceName}: ${field} is ${JSON.stringify(live[field])}, railway.json says ${JSON.stringify(w)}`);
    }
  }
  return out;
}

(async () => {
  const dirs = process.argv.slice(2);
  if (!dirs.length) { console.error('usage: node scripts/check-railway.js <repo dir> …'); process.exit(2); }
  let bad = 0;
  for (const d of dirs) {
    const diffs = await check(path.resolve(d));
    if (diffs.length) { bad += diffs.length; diffs.forEach((x) => console.log(`✗ ${x}`)); }
    else console.log(`✓ ${path.basename(path.resolve(d))}: Railway settings match railway.json`);
  }
  process.exit(bad ? 1 : 0);
})().catch((e) => { console.error(e.message); process.exit(2); });
