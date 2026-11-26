// lifecycle: a shutdown waits for running work, and only the lease holder runs crons.
// Hermetic: an in-memory lease store, a fake node-cron, a fake process.
const { EventEmitter } = require('events');
const { create, callerOf } = require('../src/lifecycle');

let ok = true;
const check = (name, cond) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}`); ok = ok && cond; };
const quiet = { log: () => {}, warn: () => {} };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

function memStore({ failWith = null } = {}) {
  const rows = new Map();
  const maybeFail = () => { if (failWith) throw failWith(); };
  return {
    rows,
    async get(s) { maybeFail(); return rows.has(s) ? { ...rows.get(s) } : null; },
    async insert(r) { maybeFail(); if (rows.has(r.service)) return false; rows.set(r.service, { ...r }); return true; },
    async take(s, from, r) {
      maybeFail();
      const cur = rows.get(s);
      if (!cur || cur.instance !== from.instance || cur.heartbeat_at !== from.heartbeat_at) return false;
      rows.set(s, { ...r }); return true;
    },
    async beat(s, inst, state) {
      maybeFail();
      const cur = rows.get(s);
      if (!cur || cur.instance !== inst) return false;
      rows.set(s, { ...cur, state, heartbeat_at: new Date().toISOString() }); return true;
    },
    async release(s, inst) { maybeFail(); const cur = rows.get(s); if (cur && cur.instance === inst) rows.delete(s); },
  };
}

function fakeCron() {
  const jobs = [];
  return { jobs, schedule(expr, fn, opts) { jobs.push({ expr, fn, opts }); return { stop() {} }; } };
}

(async () => {
  // ── shutdown waits for tracked work, then exits ──────────────────────────
  {
    const proc = new EventEmitter();
    let exited = null;
    const life = create({ service: 's', graceSeconds: 60, log: quiet, exit: (c) => { exited = c; }, proc, pollMs: 5, marginMs: 0 });
    life.install();
    let finish;
    life.track(new Promise((r) => { finish = r; }), 'report');
    let stopped = false;
    life.onDrain(() => { stopped = true; });
    proc.emit('SIGTERM');
    await tick(20);
    check('SIGTERM runs the drain hooks', stopped);
    check('SIGTERM does not exit while a run is in flight', exited === null);
    check('in-flight work is listed by name', life.inFlight()[0].startsWith('report'));
    finish();
    await tick(20);
    check('exits once the run finishes', exited === 0);
  }

  // ── busy sources count too; the deadline cuts off ────────────────────────
  {
    let exited = null;
    const rows = ['row-1'];
    const life = create({ service: 's', graceSeconds: 0.06, log: quiet, exit: (c) => { exited = c; }, proc: new EventEmitter(), pollMs: 5, marginMs: 0 });
    life.addBusy('dispatch', () => rows);
    life.drain();
    await tick(20);
    check('a busy source holds the exit', exited === null);
    await tick(80);
    check('the grace window ends the wait', exited === 0);
  }
  {
    let exited = null;
    const life = create({ service: 's', graceSeconds: 0, log: quiet, exit: (c) => { exited = c; }, proc: new EventEmitter(), pollMs: 5 });
    life.track(new Promise(() => {}), 'stuck');
    await life.drain();
    check('no draining window → exits at once, as before', exited === 0);
  }

  // ── cron: tracked, skipped while draining ────────────────────────────────
  {
    const cron = fakeCron();
    const life = create({ service: 's', graceSeconds: 60, log: quiet, exit: () => {}, proc: new EventEmitter(), pollMs: 5, marginMs: 0 });
    life.wrapCron(cron);
    let runs = 0;
    let finish;
    cron.schedule('0 * * * *', () => { runs++; return new Promise((r) => { finish = r; }); });
    cron.jobs[0].fn();
    check('a cron run is tracked', runs === 1 && life.inFlight().length === 1 && /test-lifecycle\.js:\d+/.test(life.inFlight()[0]));
    life.drain();
    cron.jobs[0].fn();
    check('no new cron run starts while draining', runs === 1);
    finish();
    await tick(20);
    check('wrapCron twice is a no-op', life.wrapCron(cron) === cron);
  }

  // ── the lease ────────────────────────────────────────────────────────────
  {
    const store = memStore();
    const cronA = fakeCron();
    const cronB = fakeCron();
    let exitedA = null;
    const procA = new EventEmitter();
    const A = create({ service: 'svc', store, instance: 'A', graceSeconds: 60, log: quiet, exit: (c) => { exitedA = c; }, proc: procA, beatMs: 1e6, pollMs: 5, marginMs: 0 });
    A.wrapCron(cronA);
    let aRuns = 0;
    let finishA;
    cronA.schedule('* * * * *', () => { aRuns++; return new Promise((r) => { finishA = r; }); });
    A.install();
    await tick(5);
    check('the first process takes the lease', A.holdsLease() && store.rows.get('svc').instance === 'A');
    cronA.jobs[0].fn();
    check('the holder runs its crons', aRuns === 1);

    // B boots while A is still alive (Railway starts the new one first).
    const B = create({ service: 'svc', store, instance: 'B', graceSeconds: 60, log: quiet, exit: () => {}, proc: new EventEmitter(), beatMs: 1e6 });
    B.wrapCron(cronB);
    let bRuns = 0;
    cronB.schedule('* * * * *', () => { bRuns++; return Promise.resolve(); });
    B.install();
    await tick(5);
    check('a second process waits for the lease', !B.holdsLease());
    cronB.jobs[0].fn();
    cronB.jobs[0].fn();
    check('its crons do not fire without the lease', bRuns === 0);

    procA.emit('SIGTERM');
    await tick(10);
    check('the draining holder marks the lease draining and keeps it', store.rows.get('svc').state === 'draining' && store.rows.get('svc').instance === 'A');
    await B.step();
    check('the new process still waits while the old one drains', !B.holdsLease() && bRuns === 0);
    finishA();
    await tick(20);
    check('the old process exits and releases the lease', exitedA === 0 && !store.rows.has('svc'));
    await B.step();
    check('the new process takes the released lease', B.holdsLease() && store.rows.get('svc').instance === 'B');
    check('each job that came due runs once on takeover', bRuns === 1);
  }
  {
    // A holder that died without releasing: taken over once it is stale.
    const store = memStore();
    store.rows.set('svc', { service: 'svc', instance: 'dead', state: 'running', heartbeat_at: new Date(Date.now() - 10_000).toISOString() });
    const C = create({ service: 'svc', store, instance: 'C', log: quiet, exit: () => {}, proc: new EventEmitter(), beatMs: 1e6, staleMs: 60_000 });
    await C.step();
    check('a fresh lease of another process is respected', !C.holdsLease());
    const D = create({ service: 'svc', store, instance: 'D', log: quiet, exit: () => {}, proc: new EventEmitter(), beatMs: 1e6, staleMs: 5_000 });
    await D.step();
    check('a stale lease is taken over', D.holdsLease() && store.rows.get('svc').instance === 'D');
  }
  {
    // A missing table fails open: every process runs its crons, as before.
    const missing = () => Object.assign(new Error('relation "service_leases" does not exist'), { missing: true });
    const E = create({ service: 'svc', store: memStore({ failWith: missing }), instance: 'E', log: quiet, exit: () => {}, proc: new EventEmitter(), beatMs: 1e6 });
    await E.step();
    check('no lease table → runs without a lease', E.holdsLease());
    // A store that keeps erroring: waits, then fails open after failOpenMs.
    let t = 0;
    const F = create({ service: 'svc', store: memStore({ failWith: () => new Error('timeout') }), instance: 'F', log: quiet, exit: () => {}, proc: new EventEmitter(), beatMs: 1e6, now: () => t, failOpenMs: 1000 });
    await F.step();
    check('a failing store does not hand out the lease at once', !F.holdsLease());
    t = 1500;
    await F.step();
    check('a store failing past the limit fails open', F.holdsLease());
    const G = create({ service: 'svc', log: quiet, exit: () => {}, proc: new EventEmitter() });
    check('no store at all → holds it', G.holdsLease());
  }

  check('callerOf names file:line', callerOf('Error\n    at x (C:\\repo\\bookkeeping\\index.js:174:3)') === 'bookkeeping/index.js:174');

  if (!ok) process.exit(1);
  console.log('lifecycle: all passed');
})().catch((e) => { console.error('FAIL', e.stack); process.exit(1); });
