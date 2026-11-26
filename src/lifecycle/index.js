// lifecycle — a deploy lets the old process finish its runs instead of killing them,
// and only one process at a time runs the scheduled jobs.
//
//   const life = require('yarms-core/src/lifecycle').create({ service: 'yarms_agents', store });
//   life.wrapCron(require('node-cron'));   // before anything calls cron.schedule
//   life.addBusy('dispatch', () => [...]); // work this process owns that has no promise here
//   life.onDrain(() => stopTakingWork());  // runs once, on SIGTERM
//   setInterval(life.guard('payroll scan', scan), ms); // a timer loop, leased like a cron
//   life.install();                        // signal handlers + the lease
//
// WHY. Railway stops the old deployment once the new one is up: SIGTERM, then SIGKILL
// RAILWAY_DEPLOYMENT_DRAINING_SECONDS later — 0 by default, so every push killed
// whatever was running (a report, a bank rec, an hourly posting) mid-step, and the
// best we could do was notice afterwards and offer Retry (JY 2026-11-26: prevent it).
// On SIGTERM this stops taking new work, waits for the work in flight, then exits.
// The wait is the draining window, so the service sets that variable.
//
// THE LEASE. Waiting opens a gap the instant kill never had: for up to that window two
// processes are alive, and each one's crons would fire — two hourly bookkeeping posts
// over the same lines. So scheduled jobs fire only in the process holding the service's
// lease (one row in `store`). The old process keeps it until its last run ends and
// releases it on exit; the new one queues each job that came due meanwhile and runs it
// once as soon as the lease is its own. A process that dies without releasing stops
// beating, and its lease is taken over after STALE_MS. Slack events and dispatch rows
// are not leased: the socket goes to the new process, and a dispatch claim is already
// conditional per row.
//
// FAILS OPEN. With no store, or a store whose table does not exist yet, every process
// holds the lease — which is exactly how things ran before this existed. A store that
// keeps failing for FAIL_OPEN_MS is treated the same way, loudly: a missed hourly post
// is worse than the small chance of a double one with the database down anyway.

const os = require('os');
const crypto = require('crypto');

const BEAT_MS = 15_000;
const STALE_MS = 90_000;        // six missed beats
const FAIL_OPEN_MS = 2 * 60_000;
const POLL_MS = 2_000;          // how often a draining process looks at what is left
const MARGIN_MS = 5_000;        // exit this long before SIGKILL, so the lease is released

function instanceId() {
  const dep = process.env.RAILWAY_DEPLOYMENT_ID ? process.env.RAILWAY_DEPLOYMENT_ID.slice(0, 8) : os.hostname();
  return `${dep}-${process.pid}-${crypto.randomBytes(3).toString('hex')}`;
}

// The caller of cron.schedule, for a label a person can find: "bookkeeping/index.js:174".
function callerOf(stack) {
  const lines = String(stack || '').split('\n').slice(1);
  for (const l of lines) {
    if (/lifecycle[\\/]index\.js/.test(l) || l.includes('node_modules') || l.includes('node:')) continue;
    const m = l.match(/([^\\/()\s]+[\\/][^\\/()\s]+):(\d+):\d+\)?\s*$/);
    if (m) return `${m[1].replace(/\\/g, '/')}:${m[2]}`;
  }
  return null;
}

/**
 * A lease store over a Supabase table:
 *   create table public.service_leases (
 *     service text primary key, instance text not null,
 *     state text not null default 'running' check (state in ('running','draining')),
 *     heartbeat_at timestamptz not null default now());
 * Each method resolves; a missing table rejects with err.missing = true.
 */
function supabaseStore(db, table = 'service_leases') {
  const fail = (what, error) => {
    const e = new Error(`${table} ${what}: ${error.message}`);
    e.missing = error.code === '42P01' || error.code === 'PGRST205' || /does not exist|could not find the table/i.test(error.message || '');
    return e;
  };
  return {
    async get(service) {
      const { data, error } = await db.from(table).select('service, instance, state, heartbeat_at').eq('service', service).maybeSingle();
      if (error) throw fail('read', error);
      return data || null;
    },
    // → true when this call created the row.
    async insert(row) {
      const { data, error } = await db.from(table).upsert(row, { onConflict: 'service', ignoreDuplicates: true }).select('service');
      if (error) throw fail('insert', error);
      return !!(data && data.length);
    },
    // Take a lease from `from` only if it has not beaten since we read it.
    async take(service, from, row) {
      const { data, error } = await db.from(table).update(row)
        .eq('service', service).eq('instance', from.instance).eq('heartbeat_at', from.heartbeat_at).select('service');
      if (error) throw fail('take', error);
      return !!(data && data.length);
    },
    // → false when the lease is no longer ours.
    async beat(service, instance, state) {
      const { data, error } = await db.from(table).update({ state, heartbeat_at: new Date().toISOString() })
        .eq('service', service).eq('instance', instance).select('service');
      if (error) throw fail('beat', error);
      return !!(data && data.length);
    },
    async release(service, instance) {
      const { error } = await db.from(table).delete().eq('service', service).eq('instance', instance);
      if (error) throw fail('release', error);
    },
  };
}

function create({
  service, store = null, graceSeconds, log = console, exit = (code) => process.exit(code),
  now = () => Date.now(), beatMs = BEAT_MS, staleMs = STALE_MS, failOpenMs = FAIL_OPEN_MS, pollMs = POLL_MS,
  marginMs = MARGIN_MS, instance = instanceId(), proc = process,
} = {}) {
  if (!service) throw new Error('lifecycle: service is required');
  const graceMs = 1000 * Number(graceSeconds ?? process.env.RAILWAY_DEPLOYMENT_DRAINING_SECONDS ?? 0) || 0;

  const work = new Map();       // id → { label, since }
  const busy = new Map();       // name → () => [label]
  const hooks = [];
  const due = new Map();        // job label → () => void, jobs that came due without the lease
  const warned = new Set();
  let seq = 0;
  let draining = false;
  let drained = null;
  let holding = !store;         // no store: every process holds it (how it ran before)
  let unleased = !store;
  let failingSince = null;
  let waitingOn = null;
  let timer = null;

  const say = (m) => log.log(`[lifecycle] ${m}`);
  const warn = (m) => (log.warn || log.log)(`[lifecycle] ${m}`);

  function track(promise, label = 'work') {
    if (!promise || typeof promise.then !== 'function') return promise;
    const id = ++seq;
    work.set(id, { label, since: now() });
    const done = () => work.delete(id);
    promise.then(done, done);
    return promise;
  }

  function addBusy(name, fn) { busy.set(name, fn); }
  function onDrain(fn) { hooks.push(fn); }

  function inFlight() {
    const out = [...work.values()].map((w) => `${w.label} (${Math.round((now() - w.since) / 1000)}s)`);
    for (const [name, fn] of busy) {
      try { for (const l of fn() || []) out.push(`${name}: ${l}`); } catch (e) { out.push(`${name}: unknown (${e.message})`); }
    }
    return out;
  }

  // ── cron ──────────────────────────────────────────────────────────────────
  function guard(label, fn) {
    const run = (...args) => {
      if (draining) { say(`skipped ${label}: shutting down, the next process runs it`); return undefined; }
      if (!holding) {
        if (!due.has(label)) say(`${label} came due while ${waitingOn || 'another process'} holds the lease; it runs once the lease is ours`);
        due.set(label, () => run(...args));
        return undefined;
      }
      const r = fn(...args);
      if (r && typeof r.then === 'function') track(r, label);
      else if (!warned.has(label)) {
        warned.add(label);
        warn(`${label} returned no promise, so a shutdown cannot wait for it — return the work from the callback`);
      }
      return r;
    };
    return run;
  }

  function wrapCron(cron) {
    if (!cron || typeof cron.schedule !== 'function') throw new Error('lifecycle.wrapCron: not a node-cron module');
    if (cron.schedule.__lifecycle) return cron;
    const original = cron.schedule.bind(cron);
    const schedule = (expr, fn, opts) => {
      const where = callerOf(new Error().stack);
      const label = (opts && opts.name) || `${where || fn.name || 'cron'} [${expr}]`;
      return original(expr, guard(label, fn), opts);
    };
    schedule.__lifecycle = true;
    cron.schedule = schedule;
    return cron;
  }

  // ── the lease ─────────────────────────────────────────────────────────────
  function failOpen(why) {
    if (unleased) return;
    unleased = true;
    if (why) warn(`${why} — running scheduled jobs without a lease, as before it existed`);
    gain();
  }

  function gain() {
    const first = !holding;
    holding = true;
    waitingOn = null;
    if (first && !unleased) say(`${instance} holds the ${service} lease`);
    const queued = [...due.values()];
    due.clear();
    if (queued.length) say(`running ${queued.length} job(s) that came due while waiting`);
    for (const run of queued) {
      try { run(); } catch (e) { warn(`catch-up job failed: ${e.message}`); }
    }
  }

  async function step() {
    if (unleased) return;
    try {
      if (holding) {
        const still = await store.beat(service, instance, draining ? 'draining' : 'running');
        if (!still && !draining) { holding = false; warn(`lost the ${service} lease; scheduled jobs pause until it is ours again`); }
      } else if (!draining) {
        await acquire();
      }
      failingSince = null;
    } catch (e) {
      if (e.missing) return failOpen(`no lease table yet (${e.message})`);
      if (failingSince === null) failingSince = now();
      warn(`lease: ${e.message}`);
      if (!holding && now() - failingSince >= failOpenMs) failOpen(`the lease store has failed for ${Math.round(failOpenMs / 1000)}s`);
    }
  }

  async function acquire() {
    const row = { service, instance, state: 'running', heartbeat_at: new Date(now()).toISOString() };
    const cur = await store.get(service);
    if (!cur) {
      if (await store.insert(row)) return gain();
      return;
    }
    if (cur.instance === instance) return gain();
    const age = now() - new Date(cur.heartbeat_at).getTime();
    if (age >= staleMs) {
      if (await store.take(service, cur, row)) {
        say(`took the ${service} lease from ${cur.instance}, silent ${Math.round(age / 1000)}s`);
        return gain();
      }
      return;
    }
    const who = `${cur.instance} (${cur.state})`;
    if (waitingOn !== who) say(`waiting for ${who} to finish and hand over the ${service} lease`);
    waitingOn = who;
  }

  // ── shutdown ──────────────────────────────────────────────────────────────
  function drain(signal = 'SIGTERM') {
    if (drained) return drained;
    draining = true;
    drained = (async () => {
      const deadline = now() + Math.max(0, graceMs - marginMs);
      say(`${signal}: taking no new work; waiting up to ${Math.round(Math.max(0, graceMs - marginMs) / 1000)}s for what is running`);
      for (const fn of hooks) {
        try { await fn(); } catch (e) { warn(`a drain hook failed: ${e.message}`); }
      }
      if (holding && !unleased) await step();   // say 'draining' now, not at the next beat
      let lastReport = now();
      for (;;) {
        const left = inFlight();
        if (!left.length) { say('nothing left running'); break; }
        if (now() >= deadline) { warn(`out of time with ${left.length} still running, cut off: ${left.join('; ')}`); break; }
        if (now() - lastReport >= 60_000) { say(`still running: ${left.join('; ')}`); lastReport = now(); }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      if (timer) clearInterval(timer);
      timer = null;
      if (holding && !unleased) {
        try { await store.release(service, instance); say(`released the ${service} lease`); } catch (e) { warn(`release: ${e.message}`); }
      }
      exit(0);
    })();
    return drained;
  }

  function install() {
    proc.once('SIGTERM', () => drain('SIGTERM'));
    proc.once('SIGINT', () => drain('SIGINT'));
    if (store) {
      step();
      timer = setInterval(step, beatMs);
      if (timer.unref) timer.unref();
    }
    say(`${instance}: on SIGTERM, waits up to ${Math.round(graceMs / 1000)}s for running work${store ? '; scheduled jobs run only with the lease' : ''}`);
    return api;
  }

  const api = {
    track, addBusy, onDrain, wrapCron, guard, install, drain, step, inFlight,
    isDraining: () => draining,
    holdsLease: () => holding,
    instance,
    graceMs,
  };
  return api;
}

module.exports = { create, supabaseStore, callerOf, BEAT_MS, STALE_MS };
