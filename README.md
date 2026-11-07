# yarms-core

The shared **master rule stack** for every Yarms client codebase. One place for usage
logging, registry-driven model routing, and signals — so no repo
copy-pastes them and they drift. **Read `ARCHITECTURE.md` first.**

## Install (in a client repo)

`yarms-core` is consumed by independently-deployed repos, so it needs a real install
path. **Distribution decision (pending):**
- **Private git dependency** — `"yarms-core": "github:yarmsco/yarms-core"`; Railway needs
  a read token (`.npmrc` + a GitHub PAT env) to pull a private repo at build.
- **Public repo** — same git dep with zero auth (the package holds no secrets; runtime
  config is the consumer's env). Simplest for CI/Railway.
- **Private package registry** (GitHub Packages) — cleanest versioning, most setup.

Until chosen, use `npm install file:../yarms-core` for local dogfooding.

## Use

```js
const { logger, llm, registry, signals } = require('yarms-core');

// 1) route + call inside a run — model resolved from the Registry by taskKey
//    (falls back to `model`). The llm layer logs the call into the run itself:
//    never log model calls by hand.
const out = await logger.withRun({ client: 'yarms_portal', agent: 'brief', label: company }, () =>
  llm.generate({
    taskKey: 'yarms_portal.brief',   // the routing key
    model: process.env.BRIEF_MODEL,  // fallback if the Registry has no override
    system, prompt, webSearch: true, callType: 'brief',
  }));
// or: const run = logger.startRun({...}); await run.scope(fn); await run.finish();

// 2) feed a finding back to the center
await signals.recordFinding({ type: 'improvement', agent: 'brief', title: '...', detail: '...' });
```

Set `YARMS_CLIENT` once per repo so logs/signals are attributed without repeating it.

## Runtime env (provided by the consuming app)
`USAGE_SUPABASE_URL`, `USAGE_SUPABASE_SERVICE_KEY` (central telemetry + Registry),
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. Everything no-ops gracefully if unset.

## Usage logging and pricing (v0.4.0)
Each run is its own object (`startRun` / `scope` / `finish`), so runs that overlap in one
process never mix their calls. Writers record facts only (model, tokens by kind, 1-hour
cache writes, web searches); the **price is set in the database** by `db/usage_pricing.sql`
(`model_prices` + a trigger on `usage_log`). A new model or a price change is one
`model_prices` row and `select reprice_usage_log();`, with no code change in any repo. A
row whose model has no price is marked `priced = false` and named in the daily usage report.
A model call outside any run is still logged, as `client = YARMS_CLIENT || 'unattributed'`.

## Registry setup
Run `schema.sql` once in the **central usage Supabase** (creates `model_registry`,
`findings`, `build_log` and the rest). Until then, routing falls back to the caller's `*_MODEL` env
and registry/signal writes no-op — nothing breaks.
