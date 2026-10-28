# security-audit — vendored from Cloudflare

Every other file in this folder is Cloudflare's `security-audit` skill, copied unchanged:

- Source: https://github.com/cloudflare/security-audit-skill (`skills/security-audit/`)
- Commit: `c1c8a8c1471069fb0e188eeaff69b8e8db6564a8` (pushed 2026-09-14)
- License: MIT (`LICENSE`, kept with the files)

It is copied in at a fixed commit rather than installed with `npx skills add`, so the
version we audit with is versioned with the standards, and an upstream change reaches us as
a reviewed diff. **Do not edit Cloudflare's files here.** Yarms-specific rules go in this file.
To update: re-copy the folder at a newer commit, run both `*.test.cjs` on Linux, and change
the commit above.

## How we use it

- **On demand:** "security audit this codebase" in any session. The pointer at
  `C:\Build_Things!\.claude\skills\security-audit\SKILL.md` makes it discoverable.
- **In the cloud:** `yarms-control-plane/.github/workflows/security-audit.yml` runs it
  headless against one repo on a Linux runner.

## Rules on top of Cloudflare's

- **Never run an audit under `doppler run`.** The auditor reads code it does not trust; its
  environment carries the model key and nothing else.
- **Output goes outside the repo** (the skill's default `~/security-audit-skill/<repo>/run-<N>`).
  Audit reports describe open vulnerabilities; they are never committed.
- **Source only.** We have no OS-enforced sandbox (no network, allowlisted env, write-only
  scratch), so the skill must not execute target code. Anything it cannot prove from source
  stays `needs_validation`, which is the skill's own rule when the sandbox is missing.
- **Always select `AI-AND-LLM.md` when the target calls a model** (anything using
  `yarms-core`'s `llm`, the Vercel AI SDK `ai` package, or a provider SDK). Our agents feed
  text we do not control (Gmail, Slack, Granola, client-entered fields, bank and QuickBooks
  data) into prompts, and model output decides what gets posted, sent or stored. That is the
  prompt-injection surface the companion exists for, even where the model looks like
  "notification glue". The first portal pilot (2026-10-28) excluded it on exactly that
  reasoning while the portal's context brain feeds mail and Slack into prompts.
  **A prior run's companion selection does not carry this rule forward:** if a prior run did
  not apply `AI-AND-LLM.md` to a target that calls a model, seed its units now as current
  work. (Portal run-2 inherited run-1's plan and audited no model surface at all.)
- **Findings, not fixes.** The audit changes nothing. A confirmed finding's fix goes through
  the Code Review Agent's **approval** lane, never the auto lane: a security fix is never a
  change that "cannot change a business output".

## Known limitation: Windows

`validate-findings.cjs` refuses to read input without OS no-follow file protection, which
Windows does not provide ("OS no-follow and nonblocking input protection is unavailable";
7 of its 29 tests fail on Windows for this reason alone, all pass on Linux). A full audit run on
this laptop therefore stops at Phase 4. Run full audits through the cloud workflow;
guidance mode (focused questions, reviewing one area) works anywhere.
