import { ListQuery as Q, firestoreBackend, leaf, realtimeBackend, schema } from '../dist/index.js';
import { fmt, header, keep, pair, solo } from './harness.mjs';
import { makeOrders } from './data.mjs';
import { performance } from 'node:perf_hooks';

const definition = { orders: () => leaf() };

/** A Firestore transport that does nothing but hold the callback, so the numbers are the library's own. */
function stubFirestore() {
  const live = new Set();
  return {
    live,
    rows: [],
    onDocument(path, next, error) { const l = { next, error }; live.add(l); return () => live.delete(l); },
    onCollection(path, query, next, error) { const l = { path, query, next, error }; live.add(l); return () => live.delete(l); },
    async getDocument() { return undefined; },
    async getCollection() { return this.rows; },
    push(rows) { for (const l of live) l.next?.(rows); },
  };
}

/** The same, with a change feed: the backend is handed only what changed. */
function stubFirestoreChanges() {
  const live = new Set();
  return {
    live,
    onDocument() { return () => {}; },
    onCollection() { throw new Error('the change feed should have been used'); },
    onCollectionChanges(path, query, next, error) { const l = { next, error }; live.add(l); return () => live.delete(l); },
    async getDocument() { return undefined; },
    async getCollection() { return []; },
    push(changes) { for (const l of live) l.next?.(changes); },
  };
}

const toRows = orders => orders.map(({ id, ...data }) => ({ id, data }));
const flip = (rows, at) => rows.map((r, i) => (i === at ? { id: r.id, data: { ...r.data, total: r.data.total + 1 } } : r));

/** Like `measure`, for a function that must await (queued microtasks drain between samples). */
async function measureAsync(fn, { reps = 15, iters = 200, warm = 3 } = {}) {
  for (let i = 0; i < warm * iters; i++) await fn();
  const times = [];
  for (let r = 0; r < reps; r++) {
    globalThis.gc?.();
    const t = performance.now();
    for (let i = 0; i < iters; i++) await fn();
    times.push((performance.now() - t) / iters);
  }
  times.sort((a, b) => a - b);
  return { median: times[reps >> 1], spread: times[Math.floor(reps * 0.9)] / times[reps >> 1] };
}
const soloAsync = async (name, n, fn, opts, note = '') => {
  const r = await measureAsync(fn, opts);
  console.log(`${name.padEnd(46)}${String(n ?? '').padStart(8)}${fmt(r.median).padStart(12)}${''.padStart(12)}${''.padStart(10)}${n ? ((r.median * 1e6) / n).toFixed(0).padStart(9) : ''.padStart(9)}${r.spread.toFixed(2).padStart(7)}  ${note}`);
  return r;
};

// ---------------------------------------------------------------------------------------------
header('LIVE LIST (Firestore): initial snapshot, select(status,total)   [n = rows; ns/row]');
for (const n of [100, 1000, 10000, 100000]) {
  const rows = toRows(makeOrders(n));
  const t = stubFirestore();
  const db = schema(definition, firestoreBackend(t));
  let events = 0;
  const sink = () => { events++; };
  pair('live-initial', 'open listener + first snapshot of n rows (2 events/row)', n,
    () => { const stop = db.orders.select('status', 'total').listen(sink); t.push(rows); stop(); return events; },
    () => { let e = 0; for (const r of rows) { sink(r.id, 'status', r.data.status); sink(r.id, 'total', r.data.total); e += 2; } return e; });
}

header('LIVE LIST (Firestore): one field of one row changes in an n-row snapshot   [ns/row]');
for (const n of [100, 1000, 10000, 100000]) {
  const A = toRows(makeOrders(n));
  const B = flip(A, 5);
  const t = stubFirestore();
  const db = schema(definition, firestoreBackend(t));
  let events = 0;
  const stop = db.orders.select('status', 'total').listen(() => { events++; });
  t.push(A);
  let toggle = false;
  const prev = new Map(A.map(r => [r.id, { status: r.data.status, total: r.data.total }]));
  pair('live-update', 'snapshot with 1 changed value -> 1 event', n,
    () => { toggle = !toggle; t.push(toggle ? B : A); return events; },
    () => { toggle = !toggle; const snap = toggle ? B : A; let e = 0; for (const r of snap) { const p = prev.get(r.id); if (p.status !== r.data.status) { p.status = r.data.status; e++; } if (p.total !== r.data.total) { p.total = r.data.total; e++; } } return e; });
  stop();
}

header('LIVE LIST (Firestore): the same single change, handed over as a change   [ns/row]');
for (const n of [100, 1000, 10000, 100000]) {
  const A = toRows(makeOrders(n));
  const B = flip(A, 5);
  const t = stubFirestoreChanges();
  const db = schema(definition, firestoreBackend(t));
  let events = 0;
  const stop = db.orders.select('status', 'total').listen(() => { events++; });
  t.push(A.map(row => ({ type: 'added', id: row.id, data: row.data })));
  const changeTo = row => [{ type: 'modified', id: row.id, data: row.data }];
  const forward = changeTo(B[5]);
  const back = changeTo(A[5]);
  let toggle = false;
  solo('live-changes', 'change feed: 1 changed value -> 1 event', n, () => { toggle = !toggle; t.push(toggle ? forward : back); return events; }, { note: 'cost does not depend on n' });
  stop();
}

header('FAN-OUT: K callers share ONE connection; a 100-row snapshot changes 1 value   [ns/row = ns per caller]');
{
  const A = toRows(makeOrders(100));
  const B = flip(A, 5);
  for (const K of [1, 10, 100, 1000, 10000]) {
    const t = stubFirestore();
    const db = schema(definition, firestoreBackend(t));
    let delivered = 0;
    const stops = [];
    for (let i = 0; i < K; i++) stops.push(db.orders.select('status', 'total').listen(() => { delivered++; }));
    if (t.live.size !== 1) throw new Error(`expected 1 shared connection, got ${t.live.size}`);
    await Promise.resolve(); // let the replay microtasks finish
    t.push(A);
    let toggle = false;
    solo('fanout', `K=${K} callers, 1 connection (checked)`, K, () => { toggle = !toggle; t.push(toggle ? B : A); return delivered; });
    stops.forEach(stop => stop());
  }
}

header('LISTEN / STOP CHURN  (planning + canonical key + registry; sync part only)   [ns/row = ns per listen+stop]');
{
  const regions20 = Array.from({ length: 20 }, (_, i) => `r${i}`);
  const t = stubFirestore();
  const db = schema(definition, firestoreBackend(t));
  const noop = () => {};
  const simple = () => db.orders.select('status');
  const complex = () => db.orders.where('status', '==', 'open').where('total', '>=', 50).whereIn('region', regions20).select('status', 'total', 'region');
  solo('churn', 'BUILD only: complex query chain (no listen)', undefined, () => complex());
  solo('churn', 'BUILD only: db.orders  (schema proxy access)', undefined, () => db.orders);
  // keep one caller open so the connection is shared, then measure joining and leaving it
  for (const [label, make] of [['simple', simple], ['complex', complex]]) {
    const holder = make().listen(noop);
    await Promise.resolve();
    const batch = 1000;
    const times = [];
    for (let rep = 0; rep < 25; rep++) {
      const t0 = performance.now();
      for (let i = 0; i < batch; i++) make().listen(noop)();
      times.push((performance.now() - t0) / batch);
      await new Promise(r => setTimeout(r, 0)); // drain the queued replay microtasks between batches
    }
    times.sort((a, b) => a - b);
    const med = times[times.length >> 1];
    console.log(`${(`join+leave a SHARED connection: ${label} query`).padEnd(46)}${''.padStart(8)}${fmt(med).padStart(12)}${''.padStart(12)}${''.padStart(10)}${''.padStart(9)}${(times[Math.floor(times.length * 0.9)] / med).toFixed(2).padStart(7)}`);
    holder();
  }
  // fresh connection each time: a different where value changes the canonical key
  let seq = 0;
  const times = [];
  for (let rep = 0; rep < 25; rep++) {
    const t0 = performance.now();
    for (let i = 0; i < 1000; i++) db.orders.where('total', '>=', seq++).select('status', 'total').listen(noop)();
    times.push((performance.now() - t0) / 1000);
    await new Promise(r => setTimeout(r, 0));
  }
  times.sort((a, b) => a - b);
  console.log(`${'open+close a NEW connection (stub transport)'.padEnd(46)}${''.padStart(8)}${fmt(times[12]).padStart(12)}`);
}

header('LATE JOINER REPLAY: a caller joins a connection already holding n rows (2 attrs/row)   [ns/row]');
for (const n of [1000, 10000, 100000]) {
  const rows = toRows(makeOrders(n));
  const t = stubFirestore();
  const db = schema(definition, firestoreBackend(t));
  const first = db.orders.select('status', 'total').listen(() => {});
  t.push(rows);
  await soloAsync(`join, wait for replay of ${2 * n} events`, n, async () => { const stop = db.orders.select('status', 'total').listen(() => {}); await Promise.resolve(); stop(); }, { reps: 11, iters: n >= 100000 ? 2 : 10, warm: 1 });
  first();
}

header('RETAINED MEMORY of one open list listener   [bytes/row]');
for (const n of [1000, 10000, 100000]) {
  const samples = [];
  for (let rep = 0; rep < 5; rep++) {
    const rows = toRows(makeOrders(n));
    const t = stubFirestore();
    const db = schema(definition, firestoreBackend(t));
    globalThis.gc(); globalThis.gc();
    const before = process.memoryUsage().heapUsed;
    const stop = db.orders.select('status', 'total').listen(() => {});
    t.push(rows);
    globalThis.gc(); globalThis.gc();
    const after = process.memoryUsage().heapUsed;
    samples.push((after - before) / n);
    stop();
    keep(rows);
  }
  samples.sort((a, b) => a - b);
  console.log(`${'heap held by the listener (registry + row state)'.padEnd(46)}${String(n).padStart(8)}${(samples[2].toFixed(0) + ' B/row').padStart(14)}   total ${(samples[2] * n / 1048576).toFixed(1)} MB`);
}

header('REALTIME DATABASE LIST: n children x 3 selected attributes = 3n SDK listeners');
for (const n of [100, 1000, 10000]) {
  let opened = 0;
  let handlers;
  const transport = {
    onValue(path, next) { opened++; next(1); return () => { opened--; }; },
    onChildren(path, query, h) { handlers = h; return () => {}; },
    async getValue() { return undefined; },
    async getChildren() { return []; },
  };
  const db = schema(definition, realtimeBackend(transport));
  const times = [];
  for (let rep = 0; rep < 9; rep++) {
    const stop = db.orders.select('status', 'total', 'region').listen(() => {});
    const t0 = performance.now();
    for (let i = 0; i < n; i++) handlers.added(`k${i}`);
    times.push(performance.now() - t0);
    const live = opened;
    stop();
    if (rep === 0) console.log(`${('  (SDK listeners opened: ' + live + ', after stop: ' + opened + ')').padEnd(46)}`);
  }
  times.sort((a, b) => a - b);
  console.log(`${'attach n children (3 onValue each)'.padEnd(46)}${String(n).padStart(8)}${fmt(times[4]).padStart(12)}${''.padStart(12)}${''.padStart(10)}${((times[4] * 1e6) / n).toFixed(0).padStart(9)}`);
}

header('get() THROUGH THE SCHEMA vs the same work on the rows directly (stub returns n rows)');
for (const n of [100, 1000, 10000, 100000]) {
  const orders = makeOrders(n);
  const rows = toRows(orders);
  const t = stubFirestore();
  t.rows = rows;
  const db = schema(definition, firestoreBackend(t));
  const values = rows.map(r => ({ id: r.id, ...r.data }));
  const viaSchema = () => db.orders.where(o => o.total > 50).orderBy('total').limit(10).get();
  const direct = () => Q.from(values).where(o => o.total > 50).orderBy('total').limit(10).toList();
  const got = await viaSchema();
  if (got.length !== 10) throw new Error(`get() returned ${got.length} rows, expected 10`);
  const iters = n >= 100000 ? 3 : n >= 10000 ? 20 : 200;
  const a = await measureAsync(viaSchema, { reps: 11, iters, warm: 1 });
  const b = await measureAsync(async () => direct(), { reps: 11, iters, warm: 1 });
  console.log(`${'local-finish get() vs ListQuery on same rows'.padEnd(46)}${String(n).padStart(8)}${fmt(a.median).padStart(12)}${fmt(b.median).padStart(12)}${(a.median / b.median).toFixed(2).padStart(9) + 'x'}${((a.median * 1e6) / n).toFixed(0).padStart(9)}${Math.max(a.spread, b.spread).toFixed(2).padStart(7)}`);
}
{
  const t = stubFirestore();
  t.rows = toRows(makeOrders(10));
  const db = schema(definition, firestoreBackend(t));
  await soloAsync('get() fixed cost, 10 rows, where(status==open)', 10, () => db.orders.where('status', '==', 'open').get(), { reps: 15, iters: 500 });
}
