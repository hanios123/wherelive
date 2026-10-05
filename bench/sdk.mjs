// A live list on the real Firebase SDK, fully offline: an in-memory cache with the network disabled and a
// placeholder project id, so no request leaves this process. It times one changed document arriving in an
// n-document query, three ways:
//
//   SDK docChanges()     what the SDK itself does for one change; the floor
//   SDK docs.map(data)   decoding every document on every snapshot, which is what the adapter used to do
//   wherelive snapshots  this library following whole snapshots, as a transport without a change feed is followed
//   wherelive changes    this library on the shipped Firebase adapter, which reports changes
//
// Run with `pnpm bench:sdk`. Set SIZES=1000,10000 to choose the query sizes.
import { initializeApp } from 'firebase/app';
import { collection, disableNetwork, doc, initializeFirestore, memoryLocalCache, onSnapshot, query, setDoc, setLogLevel, writeBatch } from 'firebase/firestore';
import { performance } from 'node:perf_hooks';
import { firestoreBackend, leaf, schema } from '../dist/index.js';
import { firebaseFirestoreTransport } from '../dist/firebase.js';
import { makeOrders } from './data.mjs';

setTimeout(() => {
  console.log('Timed out waiting for a snapshot.');
  process.exit(2);
}, 280000).unref();
setLogLevel('silent');

const sizes = (process.env.SIZES ?? '1000,10000').split(',').map(Number);
const median = values => [...values].sort((a, b) => a - b)[values.length >> 1];
const fmt = ms => (ms >= 1 ? `${ms.toFixed(2)} ms` : `${(ms * 1000).toFixed(0)} µs`);

const app = initializeApp({ projectId: 'wherelive-bench-offline', apiKey: 'offline-placeholder-not-a-credential' });
const db = initializeFirestore(app, { localCache: memoryLocalCache() });
await disableNetwork(db);

const shipped = firebaseFirestoreTransport(db);
// The same adapter without its change feed: the backend then compares whole snapshots.
const { onCollectionChanges: _changes, ...withoutChanges } = shipped;
const liveByChanges = schema({ orders: () => leaf() }, firestoreBackend(shipped));
const liveBySnapshots = schema({ orders: () => leaf() }, firestoreBackend(withoutChanges));

/** Median time from a local write to the listener seeing it, once the listener is warm. */
async function latency(attach, target, reps = 25) {
  let resolve;
  let expected = 0;
  const detach = await attach(value => {
    if (value === expected) resolve?.();
  });
  const times = [];
  for (let rep = 0; rep < reps + 4; rep++) {
    expected = 100000 + Math.floor(performance.now() * 1000) + rep;
    const done = new Promise(res => {
      resolve = res;
    });
    const started = performance.now();
    setDoc(target, { total: expected, status: 'open' }, { merge: true }).catch(() => {});
    await done;
    if (rep >= 4) times.push(performance.now() - started);
  }
  detach();
  return median(times);
}

console.log(`${'n docs'.padEnd(8)}${'SDK docChanges()'.padStart(20)}${'SDK docs.map(data)'.padStart(22)}${'wherelive snapshots'.padStart(22)}${'wherelive changes'.padStart(20)}`);
let seeded = 0;
for (const n of sizes) {
  const orders = makeOrders(n);
  for (let start = seeded; start < n; start += 500) {
    const batch = writeBatch(db);
    for (let i = start; i < Math.min(n, start + 500); i++) {
      const { id, ...data } = orders[i];
      batch.set(doc(db, `orders/${id}`), data);
    }
    batch.commit().catch(() => {}); // offline, the commit never settles; the local cache has the documents at once
  }
  seeded = n;

  const all = query(collection(db, 'orders'));
  const target = doc(db, 'orders/o5');

  const floor = await latency(async on => {
    let first = true;
    return onSnapshot(all, snapshot => {
      if (first) {
        first = false;
        return;
      }
      for (const change of snapshot.docChanges()) on(change.doc.data().total);
    });
  }, target);

  const decodeAll = await latency(async on => {
    let first = true;
    return onSnapshot(all, snapshot => {
      const rows = snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
      if (first) {
        first = false;
        return;
      }
      on(rows.find(row => row.id === 'o5')?.data.total);
    });
  }, target);

  const through = live => latency(async on => {
    const stop = live.orders.select('status', 'total').listen(change => {
      if (change.attribute === 'total') on(change.value);
    });
    await new Promise(resolve => setTimeout(resolve, 80)); // let the first snapshot land
    return stop;
  }, target);
  const bySnapshots = await through(liveBySnapshots);
  const byChanges = await through(liveByChanges);

  console.log(`${String(n).padEnd(8)}${fmt(floor).padStart(20)}${fmt(decodeAll).padStart(22)}${fmt(bySnapshots).padStart(22)}${fmt(byChanges).padStart(20)}`);
}
process.exit(0);
