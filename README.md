# yarms-core

The shared **master rule stack** for every Yarms client codebase. One place for usage
logging, registry-driven model routing, eval sampling, and signals — so no repo
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

// 1) route + call — model resolved from the Registry by taskKey (falls back to `model`)
logger.setRunContext({ client: 'yarms_portal', agent: 'brief', label: company });
const out = await llm.generate({
  taskKey: 'yarms_portal.brief',   // the routing + eval key
  model: process.env.BRIEF_MODEL,  // fallback if the Registry has no override
  system, prompt, webSearch: true,
});
logger.logCall({ model: out.model, inputTokens: out.inputTokens, outputTokens: out.outputTokens, callType: 'brief' });
await logger.finalizeRun();

// 2) feed a finding back to the center
await signals.recordFinding({ type: 'improvement', agent: 'brief', title: '...', detail: '...' });
```

Set `YARMS_CLIENT` once per repo so logs/signals are attributed without repeating it.

## Runtime env (provided by the consuming app)
`USAGE_SUPABASE_URL`, `USAGE_SUPABASE_SERVICE_KEY` (central telemetry + Registry),
`ANTHROPIC_API_KEY`, `GEMINI_API_KEY`. Everything no-ops gracefully if unset.

## Registry setup
Run `schema.sql` once in the **central usage Supabase** (creates `model_registry`,
`eval_samples`, `findings`). Until then, routing falls back to the caller's `*_MODEL` env
and eval/registry writes no-op — nothing breaks.
