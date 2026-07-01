# yarms-core — the Master Rule Stack

**Read this first.** `yarms-core` is the shared platform layer every Yarms client
codebase (`yarms_co_portal`, `nyfta`, `command_center/personal_os`, future clients)
references instead of reimplementing. It exists so the cross-cutting concerns are
defined **once**, learn from **all** clients, and push improvements **back** to them.

## The idea: a loop, not a library

Today the cross-cutting concerns (usage logging, model choice, bug review,
improvements, the daily build report) are copy-pasted into each repo and drift.
`yarms-core` replaces that with a **two-way loop**:

```
   client runs on model from the Registry ──▶ emits usage + eval-samples + git activity
          ▲                                                   │
          │                                                   ▼
     Registry / rules updated  ◀── you approve in Slack ◀── Control Plane analyzes
     (clients read on next call)                            (A/B, savings, findings, drafts)
```

Clients feed signal to the center; the center learns and pushes improved config and
standards back; clients adopt on their next run. **The clients and the master rules
iterate on each other.** A human approves every change — the loop proposes, you decide.

## Three layers

### 1. The shared package (`yarms-core`, this repo)
The canonical modules clients `import` instead of owning copies:

- **`logger`** — the one true usage logger. Writes `call` + `run` rows to the central
  `usage_log` tagged `client / agent / call_type / model / tokens / cost`. Ends the
  "same schema as command_center's copy" drift.
- **`llm`** — model-agnostic call layer (Vercel AI SDK). The model for a task is
  **resolved from the Registry by `taskKey`**, not hardcoded — falling back to the
  caller's `*_MODEL` env. Records `eval_samples` for A/B. This is the knob the
  efficiency loop turns.
- **`registry`** — reads `model_registry` (cached, short TTL) and writes `eval_samples`.
- **`signals`** — emit bug / improvement / build-activity events to `findings`.

Versioned; a client picks up changes on a version bump (or a git-dep pull).

### 2. The Registry (central datastore)
Lives in the central usage Supabase (`USAGE_SUPABASE_*`), service-role only. Tables in
`schema.sql`:

- **`usage_log`** *(exists)* — per-call telemetry.
- **`model_registry`** — `task_key → model + rationale + evidence + updated_by`. The
  source of truth the `llm` layer resolves against.
- **`eval_samples`** — sampled `{task_key, model, system, prompt, output, tokens}` for
  replay-based A/B. (Holds client prompts — central, service-role, internal only.)
- **`findings`** — bugs + improvements surfaced by the review loops.

### 3. The Control Plane (the loops)
Scheduled jobs (one small service, or jobs inside an existing deployed one). Every loop
has the **same shape — read signal → draft → Slack review → write back on approval**:

| Loop | Reads | Produces |
|---|---|---|
| **Model Efficiency** | `usage_log` + `eval_samples` | model-registry downgrade proposals, proven by A/B (replay sampled inputs on the cheaper model, judge parity) + $ savings |
| **Bug review** | code + telemetry | ranked bugs → `findings` |
| **Improvement review** | code + telemetry | improvement suggestions → `findings` |
| **Daily build report** | git activity + session | Shipped + build-in-public draft → `build-log/` |

**The loop never auto-applies.** It posts to Slack; a human approves; then it writes the
Registry / doc.

## The contract layer (stays in `CLAUDE.md`)
The root `C:\Build_Things!\CLAUDE.md` remains the **human contract** — the pure standards
enforced per-repo (Doppler/prd, RLS-first, depcheck, "build right not fast"). `yarms-core`
is the **machine enforcement** of the parts that learn. Together they are the master rule
stack. A new client plugs in by: following `CLAUDE.md` + `npm i yarms-core` and using its
`logger` / `llm` / `signals`.

## Model routing resolution order
For any LLM call the effective model is resolved as:
1. `model_registry[taskKey].model` (if present) — what the efficiency loop set,
2. else the caller's explicit `model` / `*_MODEL` env — the repo default,
3. else the library default (`claude-sonnet-4-6`).

So acting on an efficiency suggestion is a single Registry row update, and every client
picks it up on its next call (within the cache TTL) — no redeploy.

## Distribution
`yarms-core` is consumed as a dependency by independently-deployed repos, so it needs a
real install path (not `file:` / workspace). Decision pending (see README): private git
dependency + a read token on Railway, or a private package registry. Runtime secrets are
never in the package — the consuming app provides `USAGE_SUPABASE_*` etc. via its own env.

## Build sequence
1. **Foundation** *(here)* — package + `logger` + registry-driven `llm` + `registry` +
   `schema.sql`; dogfood on `yarms_co_portal`.
2. **Eval capture** — `llm` samples inputs/outputs into `eval_samples`.
3. **Model Efficiency Loop** — first Control Plane job, evidence-based (A/B) before it posts.
4. **Bug + Improvement reviews**, then **Daily build report**.
