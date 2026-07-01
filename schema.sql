-- ─────────────────────────────────────────────────────────────────────────────
-- yarms-core Registry — run in the CENTRAL usage Supabase (the same project as
-- `usage_log`, reached via USAGE_SUPABASE_*). Service-role only; these are the
-- master rules the Control Plane learns into and the clients read from.
-- ─────────────────────────────────────────────────────────────────────────────

create extension if not exists "pgcrypto";

-- Model mapping: the source of truth the llm layer resolves against by task_key.
-- The efficiency loop proposes changes; a human approves; this row is updated.
create table if not exists public.model_registry (
  task_key    text primary key,                 -- e.g. 'yarms_portal.brief'
  model       text not null,                    -- chosen model id
  rationale   text,
  evidence    jsonb not null default '{}',       -- A/B results, $ savings, sample sizes
  updated_by  text not null default 'default',   -- 'efficiency_loop' | 'human' | 'default'
  updated_at  timestamptz not null default now()
);

-- Sampled (input → output) per task-keyed call, for replay-based A/B in the loop.
-- Holds client prompts → central, service-role, internal only.
create table if not exists public.eval_samples (
  id            uuid primary key default gen_random_uuid(),
  task_key      text not null,
  model         text not null,
  system_prompt text,
  prompt        text,
  output        text,
  input_tokens  int,
  output_tokens int,
  created_at    timestamptz not null default now()
);
create index if not exists eval_samples_task_idx on public.eval_samples(task_key, created_at desc);

-- Bugs + improvements surfaced by the review loops (and client `signals`).
create table if not exists public.findings (
  id          uuid primary key default gen_random_uuid(),
  type        text not null,                    -- 'bug' | 'improvement' | 'model_efficiency' | 'build'
  client      text,
  agent       text,
  title       text not null,
  detail      text,
  severity    text,                             -- 'low' | 'med' | 'high'
  status      text not null default 'open',     -- open | approved | dismissed | done
  metadata    jsonb not null default '{}',
  created_at  timestamptz not null default now()
);
create index if not exists findings_status_idx on public.findings(status, type);

-- RLS on + EXPLICIT service_role grants (auto-expose-off safe; service_role is the
-- only user of these tables — the app/loops bypass RLS with it).
alter table public.model_registry enable row level security;
alter table public.eval_samples   enable row level security;
alter table public.findings       enable row level security;
grant all on public.model_registry to service_role;
grant all on public.eval_samples   to service_role;
grant all on public.findings       to service_role;
