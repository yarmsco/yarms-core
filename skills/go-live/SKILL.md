---
name: go-live
description: The Yarms Co go-live runbook — take a new project or client agent from an empty repo to a live, monitored cloud service (GitHub → Railway → Supabase → Vercel AI SDK → Sentry + Railway webhook + UptimeRobot), plus the gotchas learned the hard way and the new-project checklist. Use when standing up a new project or repo, onboarding a client, deploying a service, wiring secrets/env, connecting QuickBooks OAuth, or setting up monitoring.
---

# Go-live runbook

Moved here from the workspace `CLAUDE.md` on 2026-09-21: it is the same text, loaded
when a go-live is actually happening rather than in every session. The standards it
assumes — the stack principles, the ownership model, cloud-by-default — stay in
`CLAUDE.md`, which is always loaded.
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
- [ ] The values live in **Doppler `prd`** (project = repo name). No `.env`; run locally
      with `doppler run --`. Railway gets them from Doppler's sync (step 5), never by hand.

### 5. Compute (Railway)
- [ ] New Railway project → **Deploy from the GitHub repo** (`main`); it auto-deploys on
      every push.
- [ ] Env vars come from a **Doppler → Railway sync**: Doppler → project → `prd` →
      Integrations → Add Sync → Railway → project, `production`, and **the service**.
      **Never target "Shared"**: the service does not read shared variables unless each is
      referenced, so the sync reports success while the service never gets a value, and
      Doppler cannot retarget an existing sync (delete it and add a new one). Choose
      **don't import**. Never set a variable in Railway by hand; the sync won't remove it,
      and it drifts.
- [ ] Prove the credentials, not just the boot: a clean start only proves the Slack
      socket. Run a read-only check of every secret against Railway's values
      (`yarms_agents/scripts/verify-secrets.js` is the model; copy it per repo).
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
- **A Doppler sync pointed at Railway's "Shared" variables fails silently.** yarms_agents ran on
  hand-copied values while Doppler reported every sync a success; the first secret
  added after that (Rho, 2026-09-29) never arrived, and the next morning's pull failed with
  `RHO_TOKEN_KINETIC is not set`. Target the service; compare the names with
  `railway variables --kv` after any secrets change.
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

## New-project checklist (TL;DR of the runbook above)

- [ ] Doppler project (name = repo), secrets in `prd`, folder linked, run via `doppler run --`
- [ ] Doppler → Railway sync targets **the service** (never Shared); every secret verified live
- [ ] LLM via the Vercel AI SDK, model behind a `*_MODEL` env (prefer `yarms-core`'s `llm`)
- [ ] Usage logging to the central `usage_log` from the first LLM call (tagged by
      `agent` + `call_type` so the Model Efficiency Loop can attribute cost per task)
- [ ] Supabase: dedicated project, RLS on, auto-expose off, least-privilege keys
- [ ] `ARCHITECTURE.md` + `README.md` + `schema.sql`
- [ ] depcheck guardrail in CI
- [ ] `.github/dependabot.yml` — grouped weekly Actions + npm refresh (proposes, never merges)
- [ ] Observability: Sentry + Railway→Slack webhook + UptimeRobot on `/api/health`
- [ ] Verified with a real run before "done"
