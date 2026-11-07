-- usage_pricing.sql — the ONE place model spend is priced (central usage Supabase,
-- the project holding usage_log / model_registry). Apply in the Supabase SQL
-- editor. Idempotent: safe to re-run, and re-running it reprices all history.
--
-- Why it lives here and not in code (2026-11-07): three loggers (yarms_agents,
-- yarms-core, personal_os) each carried their own price table and froze a cost
-- into usage_log.cost_usd as they wrote. A new model meant three edits and three
-- deploys; a missed one priced the model as something else, silently, and the
-- wrong number stayed in history. Now writers record only what the API reported
-- (model, token counts, web searches) and this trigger prices every row from
-- model_prices. A new model or a price change is one row here, every writer is
-- right at once, and `select reprice_usage_log()` corrects history.
--
-- A model with no row is NOT guessed: the row keeps whatever cost the writer sent
-- (or null) and is marked priced = false, and the daily usage report names it.

-- ── Facts the writers now record ─────────────────────────────────────────────
alter table usage_log add column if not exists cache_write_1h_tokens integer;  -- subset of cache_write_tokens written with the 1-hour TTL (2x, not 1.25x)
alter table usage_log add column if not exists web_search_requests   integer;  -- server-side web searches, billed per search on top of tokens
alter table usage_log add column if not exists priced                boolean;  -- false = model not in model_prices; cost_usd is not trustworthy

-- ── Prices, $ per million tokens (web search: $ per 1,000 searches) ──────────
create table if not exists model_prices (
  model              text primary key,      -- exact id, without a -YYYYMMDD snapshot suffix
  input              numeric not null,      -- uncached input
  output             numeric not null,
  cache_read         numeric not null,      -- NOT a fixed 10%: 5% on Opus 5.5, 2.5% on Fable 5.1
  cache_write_5m     numeric not null,      -- 1.25x input
  cache_write_1h     numeric not null,      -- 2x input
  web_search_per_1k  numeric not null default 0,
  -- Long-prompt tier: when input + cache read + cache write exceeds the threshold,
  -- every rate above is multiplied by long_multiplier (Haiku 5.5: >100K → 5x).
  long_threshold     integer,
  long_multiplier    numeric,
  note               text,
  updated_at         timestamptz not null default now()
);

insert into model_prices (model, input, output, cache_read, cache_write_5m, cache_write_1h, web_search_per_1k, long_threshold, long_multiplier, note) values
  ('claude-fable-5-1',  10.00, 50.00, 0.25,  12.50, 20.00, 10, null, null, null),
  ('claude-fable-5',    10.00, 50.00, 1.00,  12.50, 20.00, 10, null, null, null),
  ('claude-opus-5-5',    4.00, 20.00, 0.20,   5.00,  8.00, 10, null, null, null),
  ('claude-opus-5',      5.00, 25.00, 0.50,   6.25, 10.00, 10, null, null, null),
  ('claude-opus-4-8',    5.00, 25.00, 0.50,   6.25, 10.00, 10, null, null, null),
  ('claude-opus-4-7',    5.00, 25.00, 0.50,   6.25, 10.00, 10, null, null, null),
  ('claude-opus-4-6',    5.00, 25.00, 0.50,   6.25, 10.00, 10, null, null, null),
  ('claude-opus-4-5',    5.00, 25.00, 0.50,   6.25, 10.00, 10, null, null, null),
  ('claude-sonnet-5-5',  2.00, 10.00, 0.20,   2.50,  4.00, 10, null, null, null),
  ('claude-sonnet-5',    2.00, 10.00, 0.20,   2.50,  4.00, 10, null, null, null),
  ('claude-sonnet-4-6',  3.00, 15.00, 0.30,   3.75,  6.00, 10, null, null, null),
  ('claude-sonnet-4-5',  3.00, 15.00, 0.30,   3.75,  6.00, 10, null, null, null),
  ('claude-haiku-5-5',   0.10,  0.50, 0.01,  0.125,  0.20, 10, 100000, 5, 'cache rates assumed at the standard 0.1x / 1.25x / 2x — confirm on the pricing page'),
  ('claude-haiku-4-5',   1.00,  5.00, 0.10,   1.25,  2.00, 10, null, null, null),
  -- Gemini: cache and grounding rates are approximate; yarms-core reports no Gemini cache tokens today.
  ('gemini-2.5-pro',     1.25, 10.00, 0.31,   1.25,  1.25, 35, 200000, 2, 'long tier is 2x input / 1.5x output; priced at 2x'),
  ('gemini-2.5-flash',   0.30,  2.50, 0.075,  0.30,  0.30, 35, null, null, null)
on conflict (model) do update set
  input = excluded.input, output = excluded.output, cache_read = excluded.cache_read,
  cache_write_5m = excluded.cache_write_5m, cache_write_1h = excluded.cache_write_1h,
  web_search_per_1k = excluded.web_search_per_1k, long_threshold = excluded.long_threshold,
  long_multiplier = excluded.long_multiplier, note = excluded.note, updated_at = now();

-- ── Pricing one row ──────────────────────────────────────────────────────────
-- Call rows are priced from their own tokens. A run row is the sum of its call
-- rows when they exist (a run can mix models; its own `model` is only the first
-- call's), else priced from its own tokens (older writers sent run rows only).
create or replace function usage_log_price() returns trigger language plpgsql as $$
declare
  p        model_prices%rowtype;
  inp      numeric := coalesce(new.input_tokens, 0);
  outp     numeric := coalesce(new.output_tokens, 0);
  cr       numeric := coalesce(new.cache_read_tokens, 0);
  cw_all   numeric := coalesce(new.cache_write_tokens, 0);
  cw_1h    numeric := least(coalesce(new.cache_write_1h_tokens, 0), coalesce(new.cache_write_tokens, 0));
  searches numeric := coalesce(new.web_search_requests, 0);
  mult     numeric := 1;
  call_sum numeric;
  call_ok  boolean;
begin
  if new.level = 'run' and new.run_id is not null then
    select sum(cost_usd), bool_and(coalesce(priced, false))
      into call_sum, call_ok
      from usage_log where level = 'call' and run_id = new.run_id;
    if call_sum is not null then
      new.cost_usd := round(call_sum, 6);
      new.priced   := call_ok;
      return new;
    end if;
  end if;

  if inp + outp + cr + cw_all + searches = 0 then
    new.cost_usd := coalesce(new.cost_usd, 0);   -- heartbeats, QuickBooks meters
    new.priced   := true;
    return new;
  end if;

  select * into p from model_prices
   where model = regexp_replace(coalesce(new.model, ''), '-[0-9]{8}$', '');
  if not found then
    new.priced := false;                          -- keep the writer's figure, flag it
    return new;
  end if;

  if p.long_threshold is not null and inp + cr + cw_all > p.long_threshold then
    mult := p.long_multiplier;
  end if;

  new.cost_usd := round(
    ( inp            * p.input
    + outp           * p.output
    + cr             * p.cache_read
    + (cw_all - cw_1h) * p.cache_write_5m
    + cw_1h          * p.cache_write_1h ) * mult / 1e6
    + searches * p.web_search_per_1k / 1e3, 6);
  new.priced := true;
  return new;
end $$;

drop trigger if exists usage_log_price on usage_log;
create trigger usage_log_price
  before insert or update of model, input_tokens, output_tokens, cache_read_tokens,
                             cache_write_tokens, cache_write_1h_tokens, web_search_requests, level
  on usage_log for each row execute function usage_log_price();

-- ── Repricing history ────────────────────────────────────────────────────────
-- Re-run after any model_prices change. Call rows first, so run rows sum the new figures.
create or replace function reprice_usage_log(since timestamptz default '-infinity') returns void
language sql as $$
  update usage_log set model = model where level = 'call' and ts >= since;
  update usage_log set model = model where level = 'run'  and ts >= since;
$$;

select reprice_usage_log();
