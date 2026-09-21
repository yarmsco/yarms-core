# Build_Things — Engineering Standards & Go-Live Runbook (Yarms Co.)

The **single cross-project source of truth** for how we build here. Two halves:

1. **The standards** (the contract) — the rules *every* repo obeys, always. Apply from
   day one; don't rediscover them per project. (Hardened while building `yarms_co_portal`;
   this file exists so that pain never has to be repeated.)
2. **The go-live runbook** — empty repo → live, monitored cloud service. What you actually
   execute when standing up a new project or onboarding a client.

The **platform machine-layer** (the learning loops that turn this contract into automated
enforcement) lives with its code in **`yarms-core/ARCHITECTURE.md`** — read that for the
Registry / Control Plane / Model-Efficiency mechanics. This file is the human contract;
`yarms-core` is the machine enforcement of the parts that learn.

---

## North star

**Build it right, not fast.** Correctness, quality, and rigor over speed. Surface
flaws before they compound. Verify with real runs — never ship on "it should work."
This is the explicit, repeated preference: high quality is the point, not velocity.

---

## The stack in four principles

1. **Own the brain.** The agent code — personas, reasoning, context, memory, judgment —
   lives in *your* codebase and is never swapped. This is the differentiated product.
2. **The model is a swappable dependency.** Agents call a thin **model router** (the Vercel
   AI SDK), never a specific vendor. Today it's Claude; switching to Gemini/GPT is a config
   change (add the provider key + change the factory), not a rewrite. *This is the
   differentiator vs. anyone who just wires up one vendor's chatbot GUI.*
3. **One owned, cloud-based stack.** Everything runs on infrastructure you own and operate
   (Railway + Supabase). No state on laptops; swap machines or add teammates freely.
4. **Keep it code-first and lean.** This team builds its own integrations and runs
   scheduling in code — so there's **no n8n / no-code layer** (it'd only re-plumb working
   code). Fewer vendors, more control.

### The layers

| Layer | Tool (now) | Swappable to | Notes |
|---|---|---|---|
| Clients | Any laptop + GitHub org | — | Hold no state. Onboard = invite + clone. |
| **Brain** | **Your agent code** | never swapped | The product. Calls the model *through the router*, never a vendor directly. |
| **Model** | **Claude (Opus 4.8)** via the **Vercel AI SDK** router | Gemini · GPT · any | Provider is a one-line change; the SDK normalizes the rest. Anthropic **prompt caching** on the static prefix (2 ephemeral breakpoints via `providerOptions`) cuts repeat-send cost ~10×. Cost-route simple tasks to a cheaper tier per policy (see Model Efficiency, below). |
| **Data** | **Supabase** (managed Postgres) | any Postgres host | Postgres + JSONB; Storage for documents. QB tokens live here too (row + locking) for the client agents. |
| **Compute** | **Railway** | Render · Fly.io · VPS | Always-on services + **cron in code** (`node-cron` / Railway cron). Right shape for persistent Slack bots + long agent turns (serverless is *not* — ephemeral, time-limited). |

**No n8n.** Scheduling is cron-in-code; integrations are hand-built; QuickBooks
(judgment-heavy) stays in code with the Postgres-row+locking token fix rather than an n8n
connector. n8n would only earn its place with non-technical teammates or a flood of simple
SaaS glue — not this team.

### The trap to avoid

**Don't build the logic *inside* a vendor's product** (Claude Desktop, Skills, Projects,
built-in connectors, or a no-code GUI). That moves the brain into a house you don't own and
nothing ports to another model. Always call the model *as an API* from your own code,
through the router.

> Two roles for "Claude," don't conflate: (1) **Claude the model** — the current runtime
> brain, behind the router, *swappable*; (2) **Claude Code** — the dev tool used to *build*
> the stack, not part of the runtime.

---

## Ownership & client model

- **You own the factory; the client owns their goods.** Yarms owns/operates the infra
  (Railway, Supabase, the agent engine); the client always owns *their* accounts + data
  (QuickBooks company, files), connected via revocable credentials.
- **One shared multi-tenant stack** — not a new stack per client. Each client is
  config/rows keyed by client + `realmId`. NYFTA is just a tenant whose QB row carries its
  own app credentials.
- **Engine + per-client config packs.** Generic reusable engine; each client's specifics
  (personas, prompts, config) in a separable layer → a future handoff is a bounded,
  quotable job.
- **No lock-in.** A client can take their code in-house. `yarms-core` is designed as
  infrastructure (a dependency like `express`), not a closed service — env-driven, no
  hard-coded "phone home," degrades to a no-op without central creds. See
  `yarms-core/ARCHITECTURE.md` → *Portability* for the non-negotiable rules that keep this
  true (client code in its own portable repo; use `yarms-core` only at the edges).
- **Contract posture:** Yarms owns the engine (licensed while engaged); client owns bespoke
  config + data; handoff is a scoped, billable transition fee against a per-client
  extraction manifest. *(Lawyer reviews the actual language.)*

---

## Stack & patterns — apply to every new project

1. **Secrets → Doppler. No local `.env`.**
   Doppler project name = repo/folder name. Secrets live in the **`prd`** config
   (what Railway reads, and what we run locally against). Link the folder with
   `doppler setup`; run everything via `doppler run -- <cmd>`. Reuse shared creds by
   copying from existing Doppler configs (e.g. `ANTHROPIC_API_KEY`; the **Yarmy**
   `SLACK_BOT_TOKEN` lives in `yarms_agents/prd`; `USAGE_SUPABASE_*` in personal_os/nyfta).

2. **LLM calls → the Vercel AI SDK (`ai` + `@ai-sdk/*`).**
   Never wire a single vendor's SDK directly. The model is ONE swappable string
   behind a `*_MODEL` env var (`claude-*` → Anthropic web search, `gemini-*` → Google
   grounding). Model-agnostic is both a Yarms product principle and an internal standard.
   Prefer routing through `yarms-core`'s `llm` layer (resolves the model from the Registry
   by `taskKey`, falling back to the `*_MODEL` env).

3. **Every LLM call logs cost.**
   Write tokens + self-computed cost to the central `usage_log` (`USAGE_SUPABASE_*`), via
   `yarms-core`'s `logger` (the one true usage logger — ends the "same schema as
   command_center's copy" drift). Tag `client / agent / call_type / model`. Cost logging
   must be **cache-aware** (see gotchas) — the SDK's `inputTokens` is the *total*, so naive
   pricing over-counts ~10×.

4. **Supabase data layer, security-first.**
   Dedicated Supabase project per system (blast-radius isolation). At project
   creation: Data API on, **automatic RLS on**, **auto-expose new tables OFF**. RLS
   on every table; `service_role` = server-only; public/anon keys are
   insert-/least-privilege only with explicit grants. Schema lives in `schema.sql`.

5. **Slack is the cockpit, not a dashboard.**
   "Inputs, not outputs" — reduce decisions, don't build reporting UIs. **Yarmy** =
   business bot; **Covey** = personal-OS bot (separate bots, same workspace).
   Notifications are **data-event-driven** where possible (DB webhook → handler),
   not coupled to a single entry path.

6. **Reuse, don't rebuild.** Pull battle-tested integration clients from existing
   repos (Granola, Google Calendar, the usage logger, QuickBooks) rather than
   reimplementing. Cross-cutting concerns (logging, model routing, signals) come from
   `yarms-core` — never copy-paste them.

7. **Deploy:** Node services → **Railway** (push-to-deploy from `main`, in-process
   `node-cron`); static sites → **Cloudflare Workers**. DNS/custom domains on Cloudflare.

### Each project carries

- `ARCHITECTURE.md` — canonical design/vision (**read first**).
- `README.md` — setup/provisioning.
- `schema.sql` — the data model.
- A repo-level `CLAUDE.md` for project-specific conventions (this root file is the
  cross-project layer).

### Cloud by default — no accidental local state

Principle 3 ("no state on laptops") is an operational rule, not just a vision line.
**Anything the business depends on — data, agents, scheduled loops — lives in the cloud
(Railway compute + Supabase data). A thing is allowed to live only on the laptop *only if
explicitly agreed*, and if so it goes in the ledger below.** You should never open a local
folder and have to ask "why is this here" — either it's in the ledger, or it's a bug to fix.

- **Data is rows, not files.** Persistent data belongs in Supabase (the local-JSON era is
  over). Flat files in the workspace are a *stopgap until the table + loop exist*, never the
  destination — and they must say so.
- **Scheduled work runs in the cloud.** Any recurring job (audits, reports, the Control
  Plane loops) runs on Railway cron, so it does **not** depend on this machine being on. If
  a "loop" only runs because the laptop is awake, it isn't done.

**Local-only ledger (the complete list of what's deliberately not in the cloud):**
| Local path | Why it's OK to be local |
|---|---|
| `linkedin_refresh/` | Personal working scratch for a one-time GTM refresh; never a runtime dependency. |
| `.claude/` | This machine's Claude Code + memory config; inherently per-machine. |
| `yarms-biz-dev/` | **Parked** (JY, 2026-09-13): no outbound work is running, so it stays local by choice. It has no git remote, which means `draft-post.yml`'s daily 8am cron has never fired and its Dependabot config watches nothing — both are inert on purpose, not broken. Give it a remote when outbound restarts. |

If something new lands locally and isn't on this list, that's the signal to either move it
to the cloud or add a row here with the reason.

---

## Quality & review — ongoing, not one-time

- **Verify with real runs / smoke tests** before calling anything done.
- **depcheck guardrail** — CI fails on unused deps (every repo; add to a new repo with
  `pwsh C:\Users\jyarm\.claude\scripts\add-depcheck-guardrail.ps1 -RepoPath <repo>`,
  which also writes `.github/dependabot.yml` as of 2026-09-13). **The script lives in
  `~/.claude/scripts/`, outside this tree** — a search rooted at `C:\Build_Things!`
  finds nothing and wrongly reads as "deleted". Verify a dep is truly unused before
  deleting.
- **Dependabot — the standing version refresh (every repo, since 2026-09-13).**
  `.github/dependabot.yml` opens **grouped weekly** PRs for GitHub Actions + npm. It
  exists because nothing watched drift: `actions/checkout` and `actions/setup-node` sat
  on **v4 across all eight repos while upstream reached v7**, and **seven** depcheck
  workflows — every repo with a remote — pinned **Node 20, months past its April 2026
  EOL**. The deprecation warning printed on
  every single run the whole time — **a warning pages nobody**, which is precisely why
  the refresh has to be a bot opening PRs rather than a good intention. **It proposes;
  you decide** (the same rule the Model Efficiency Loop follows) — Railway auto-deploys
  from `main`, so anything auto-merged would deploy itself unreviewed. Majors are
  deliberately left ungrouped: read the changelog before taking one.
- **Continuous bug/improvement review** — codebases are reviewed periodically, not
  set-and-forget.
- **Model Efficiency Loop (periodic model-ROI audit).** Model choices are never locked —
  they're revisited on a cadence by an actual backend loop (in `yarms-core` / the Control
  Plane), not by goodwill. Because every LLM call is tagged in `usage_log`, the loop
  aggregates spend *per task*, flags premium-model tasks that could run on a cheaper tier
  (Haiku, Gemini Flash, open-source), proves it with evidence-based A/B on replayed real
  inputs, and posts ranked "downgrade candidates" to Slack. **It never auto-swaps — it
  proposes; you decide.** Acting on a suggestion is a one-line Registry/`*_MODEL` change.
  Current default for reasoning/brief tasks: **Claude Sonnet 4.6** (out-rigored Gemini 2.5
  Flash — caught a planted unverifiable fact). **Full mechanics: `yarms-core/ARCHITECTURE.md`.**

---

## Go-live runbook — empty repo → live, monitored cloud service

Takes a new project (an internal tool, the work/EA system, or a client agent) from empty
repo → **live, monitored, cloud service** on the standard stack:

**GitHub (code) → Railway (compute) → Supabase (data) → Vercel AI SDK (model) → Sentry +
Railway webhook + UptimeRobot (observability).**

Order matters where noted (schema before the code that reads it; env before deploy).
Split of labor: agent brain / data-access / schema / model router / deploy config live **in
code**; creating Supabase & Railway projects, setting secrets, and the QuickBooks OAuth
connect flow happen **in the GUIs** (you, in a browser).

### 0. Decide scope
- [ ] Own repo + Railway service, or a persona inside an existing project? → **Separate**
      when the domain will grow or has its own data (e.g., the work/EA + biz-dev system →
      its own thing, separate from the personal OS).
- [ ] Own Supabase project, or a tenant/schema in a shared one? → **Separate project** for
      clean data isolation — especially keep **personal/health data away from work/client data**.
- [ ] Which integrations? (Slack, Google, QuickBooks, …)

### 1. Repo (GitHub)
- [ ] Create the repo under the right org.
- [ ] Scaffold from the engine — reuse the proven pieces: `src/db/supabase.js`,
      `src/utils/sentry.js`, the Vercel-AI-SDK `claudeClient.js` (model router + caching),
      an Express `/api/health` endpoint, the agent tool-loop pattern, and the
      conversation-history neutralizer.
- [ ] `.gitignore` excludes `.env`, `logs/`, any token files.
- [ ] **No cross-repo `require`s** — each repo must be self-contained (the `usageLogger`
      crash). Vendor shared utils or publish a package; never `require('../../../other_repo/…')`.

### 2. Database (Supabase)
- [ ] Create project (nearby region; **save the DB password**).
- [ ] At creation: Data API ON; "Automatically expose new tables" **OFF**; auto-RLS ON.
- [ ] Apply schema via SQL Editor (tables + indexes).
- [ ] **Run the `grant … to service_role` + `alter default privileges` block** — with
      auto-expose OFF the backend role gets no access otherwise (the `42501 permission
      denied` crash).
- [ ] Create private Storage bucket(s) if storing files (PDFs, etc.).
- [ ] Copy **Project URL** + **service_role key** for env.

### 3. Model (Vercel AI SDK)
- [ ] `npm i ai @ai-sdk/anthropic` (+ other providers if going multi-model).
- [ ] All model calls route through the SDK (swappable). Prompt caching via
      `providerOptions.anthropic.cacheControl` on the static system prefix.
- [ ] Provider keys for env (`ANTHROPIC_API_KEY`, etc.).

### 4. Secrets / env
- [ ] Assemble the env list — typical: `ANTHROPIC_API_KEY`, `SUPABASE_URL`,
      `SUPABASE_SERVICE_KEY`, `SENTRY_DSN`, + Slack/Google/QB as needed.
- [ ] **Do NOT set `PORT`** — Railway injects it; the app reads `process.env.PORT`.
- [ ] `.env` is local-only (gitignored); the real values live in Railway.
- [ ] Watch for stray leading spaces when pasting — clean variable names only.

### 5. Compute (Railway)
- [ ] New Railway project → **Deploy from the GitHub repo** (`main`); it auto-deploys on
      every push.
- [ ] Set env vars via the **Raw Editor** (paste `.env` minus `PORT`).
- [ ] Watch the deploy log for a clean boot — the first deploy often crashes on a missing
      env var or a cross-repo require; fix and it redeploys.
- [ ] **Stop any local instance** running the same Slack token (two connections fight over
      events + double-fire crons).
- [ ] Need an external health URL? service → Settings → Networking → **Generate Domain**.

### 6. Observability — all three layers
- [ ] **Sentry**: create a Node project → copy the DSN → set `SENTRY_DSN` in Railway →
      connect Sentry's Slack app to an alerts channel → **fire a test event and confirm the
      Slack alert lands.**
- [ ] **Railway → Slack webhook**: Project → Settings → **Webhooks** (NOT "Integrations") →
      paste a Slack incoming-webhook URL (reuse an existing Slack app's webhook — no new app
      needed) → scope to deploy-fail/crash.
- [ ] **UptimeRobot**: HTTP(s) monitor on `https://<railway-domain>/api/health` —
      **include the path** (bare `/` 404s) → set the alert contact.

### 7. QuickBooks (client / finance agents only)
- [ ] QB OAuth tokens → a **Postgres row with locking** (one row per `realmId`, single
      refresher) — fixes the cloud `invalid_grant` token clobbering.
- [ ] Update the Intuit app registration for the cloud host/IP if required.

### 8. Verify live
- [ ] Trigger a real end-to-end action → confirm the DB write / expected behavior (check
      the row, timestamped to now).
- [ ] Confirm the monitoring path once (test error → Slack).

### Gotchas (learned the hard way on command_center)
- **Cross-repo `require`** → `MODULE_NOT_FOUND` on a standalone deploy. Keep repos self-contained.
- **Don't set `PORT`** in Railway.
- **Supabase auto-expose OFF** → you MUST grant `service_role` or every query 403s.
- **Uptime URL must include `/api/health`** — the bare domain 404s and reads as "down."
- **One live instance only** — local + Railway on the same Slack token = event races + double crons.
- **Phantom tool-calls:** loaded conversation history can make the model *pattern-complete
  fake confirmations* ("Logged/Booked/Saved…") instead of calling the tool. Neutralize the
  bot's prior confirmation lines in any agent that rebuilds Slack history and calls write tools.
- **Caching is per-provider** (Anthropic `cacheControl`): ~10% on reads, ~125% on writes,
  5-min TTL — biggest win is within a single turn's tool loop.
- **Cost logging must be cache-aware** — price uncached input full, cache reads ×0.10,
  cache writes ×1.25; the SDK's `inputTokens` is the *total*, so naive pricing over-counts ~10×.
- **Never install a CI tool with a single un-retried download.** `dopplerhq/cli-action@v3`
  does exactly that, and on 2026-09-11 a TLS handshake blip against `cli.doppler.com`
  (curl exit 35, HTTP 000) killed the nightly build report 9s in, before any of our code
  ran. Use Doppler's documented install (`curl --retry 3` + a `wget` fallback) inside a
  retry loop — and **prove success by running the binary**, because a failed download
  still pipes empty input into `sh`, which exits 0.
- **A scheduled job that can only report "now" loses that day permanently when it fails.**
  The build report had no way to ask for an older day, so one failed run = a hole in
  `build_log` that nothing could fill. Give every daily loop a `--date` backfill path from
  day one, bound the query at BOTH ends (`since` *and* `until`), and key the upsert on the
  date so re-running is safe.

---

## Daily build log → also the build-in-public feed

Each build day produces a dated entry with two parts:
- **Shipped** — what actually got built/deployed (technical, precise — this is the documentation).
- **Build-in-public** — a short, shareable narrative of the day's progress
  (LinkedIn / newsletter-ready). Outbound-marketing fuel: "building this in the open."

One habit produces both the project record *and* marketing content.

**Where it lives (a cloud artifact, not local files):**
- The **daily-build-report Control Plane loop** (`yarms-control-plane/src/build-report.js`)
  runs on **GitHub Actions** (cron `0 0 * * *` = 00:00 UTC / 8pm ET; GitHub queues scheduled
  jobs late, so runs actually land ~9:30–10:15pm ET — *not* dependent on this laptop): it
  pulls the day's commits across the org repos (GitHub API), summarizes what shipped **per
  repo** from the real diffs (via the `yarms-core` `llm` layer),
  posts a per-codebase report to Slack, and **writes one row per day to the `build_log`
  table in the central usage Supabase** (`USAGE_SUPABASE_*` — same project as
  `model_registry`/`eval_samples`/`findings`). That table is the durable, queryable history.
- **Live as of 2026-07-02:** `build_log` is applied in the central Supabase (`rsnny`) and the
  nightly loop persists to it; the four legacy `build-log/*.md` entries were backfilled
  (verbatim in `source_markdown`, verified) via `scripts/backfill-build-log.js`, and the local
  `build-log/` folder was removed. History is now cloud-only — query the `build_log` table.
- *Build-in-public narrative:* the loop currently produces the technical "shipped" view; the
  shareable/marketing narrative is a **reserved `build_in_public` column, not yet generated** —
  a future enhancement, not a live output.

---

## New-project checklist (TL;DR of the runbook above)

- [ ] Doppler project (name = repo), secrets in `prd`, folder linked, run via `doppler run --`
- [ ] LLM via the Vercel AI SDK, model behind a `*_MODEL` env (prefer `yarms-core`'s `llm`)
- [ ] Usage logging to the central `usage_log` from the first LLM call (tagged by
      `agent` + `call_type` so the Model Efficiency Loop can attribute cost per task)
- [ ] Supabase: dedicated project, RLS on, auto-expose off, least-privilege keys
- [ ] `ARCHITECTURE.md` + `README.md` + `schema.sql`
- [ ] depcheck guardrail in CI
- [ ] `.github/dependabot.yml` — grouped weekly Actions + npm refresh (proposes, never merges)
- [ ] Observability: Sentry + Railway→Slack webhook + UptimeRobot on `/api/health`
- [ ] Verified with a real run before "done"
