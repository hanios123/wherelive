import { describe, expect, it, vi } from 'vitest';
import { firestoreBackend, schema } from '../src';
import { MemoryFirestoreTransport } from '../src/testing';
import type { FirestoreChange, FirestoreQuery, FirestoreTransport } from '../src/transport';
import { definition, snapshotsOnly } from './fixtures';

const noQuery: FirestoreQuery = { where: [], orderBy: [] };
const makeDb = (transport: FirestoreTransport) => schema(definition, firestoreBackend(transport));

describe('the memory transport reports changes the way the SDK does', () => {
  const listen = (t: MemoryFirestoreTransport, query: FirestoreQuery = noQuery) => {
    const calls: FirestoreChange[][] = [];
    const stop = t.onCollectionChanges('items', query, changes => calls.push([...changes]), () => {});
    return { calls, stop };
  };

  it('lists every document as added first, and an empty result as an empty list', () => {
    const empty = listen(new MemoryFirestoreTransport());
    expect(empty.calls).toEqual([[]]);

    const t = new MemoryFirestoreTransport();
    t.set('items/a', { n: 1 });
    t.set('items/b', { n: 2 });
    expect(listen(t).calls).toEqual([
      [
        { type: 'added', id: 'a', data: { n: 1 } },
        { type: 'added', id: 'b', data: { n: 2 } },
      ],
    ]);
  });

  it('then reports only what changed', () => {
    const t = new MemoryFirestoreTransport();
    t.set('items/a', { n: 1 });
    t.set('items/b', { n: 2 });
    const { calls } = listen(t);
    calls.length = 0;

    t.set('items/b', { n: 20 });
    t.set('items/c', { n: 3 });
    t.delete('items/a');
    expect(calls).toEqual([
      [{ type: 'modified', id: 'b', data: { n: 20 } }],
      [{ type: 'added', id: 'c', data: { n: 3 } }],
      [{ type: 'removed', id: 'a' }],
    ]);
  });

  it('says nothing when a write leaves the result as it was', () => {
    const t = new MemoryFirestoreTransport();
    t.set('items/a', { n: 1 });
    const { calls } = listen(t, { where: [{ field: 'n', op: '==', value: 1 }], orderBy: [] });
    calls.length = 0;
    t.set('items/a', { n: 1 }); // the same data
    t.set('items/z', { n: 99 }); // outside the query
    t.set('other/q', { n: 1 }); // another collection
    expect(calls).toEqual([]);
  });

  it('a document that stops matching is removed, and one that starts is added', () => {
    const t = new MemoryFirestoreTransport();
    t.set('items/a', { n: 1 });
    const { calls } = listen(t, { where: [{ field: 'n', op: '==', value: 1 }], orderBy: [] });
    calls.length = 0;
    t.set('items/a', { n: 2 });
    t.set('items/a', { n: 1 });
    expect(calls).toEqual([[{ type: 'removed', id: 'a' }], [{ type: 'added', id: 'a', data: { n: 1 } }]]);
  });

  it('a limit window: one document pushed out is removed, the one that takes its place is added', () => {
    const t = new MemoryFirestoreTransport();
    for (const [id, n] of [['a', 10], ['b', 20], ['c', 30]] as const) t.set(`items/${id}`, { n });
    const { calls } = listen(t, { where: [], orderBy: [{ field: 'n', direction: 'asc' }], limit: 2 });
    expect(calls[0]?.map(change => change.id)).toEqual(['a', 'b']);
    calls.length = 0;
    t.set('items/z', { n: 5 });
    expect(calls).toEqual([[{ type: 'removed', id: 'b' }, { type: 'added', id: 'z', data: { n: 5 } }]]);
  });

  it('hands out copies, so a caller cannot change what the transport remembers', () => {
    const t = new MemoryFirestoreTransport();
    t.set('items/a', { n: 1, list: [1] });
    const { calls } = listen(t);
    (calls[0]?.[0] as unknown as { data: { list: number[] } }).data.list.push(2);
    calls.length = 0;
    t.set('items/a', { n: 1, list: [1] });
    expect(calls).toEqual([]);
  });

  it('stops after unsubscribe', () => {
    const t = new MemoryFirestoreTransport();
    const { calls, stop } = listen(t);
    stop();
    calls.length = 0;
    t.set('items/a', { n: 1 });
    expect(calls).toEqual([]);
    expect(t.listenerCount).toBe(0);
  });
});

describe('the backend uses the change feed when the transport has one', () => {
  it('follows the changes and never asks for whole snapshots', () => {
    const t = new MemoryFirestoreTransport();
    t.set('customers/1', { name: 'Ann', age: 12 });
    const whole = vi.spyOn(t, 'onCollection');
    const changes = vi.spyOn(t, 'onCollectionChanges');
    const seen: unknown[] = [];
    makeDb(t).customers.select('name', 'age').listen(change => seen.push(change));
    expect(changes).toHaveBeenCalledOnce();
    expect(whole).not.toHaveBeenCalled();
    expect(seen).toEqual([
      { key: '1', attribute: 'name', value: 'Ann' },
      { key: '1', attribute: 'age', value: 12 },
    ]);
  });

  it('falls back to whole snapshots when it has none', () => {
    const t = new MemoryFirestoreTransport();
    t.set('customers/1', { name: 'Ann', age: 12 });
    const plain = snapshotsOnly(t);
    const whole = vi.spyOn(plain, 'onCollection');
    const seen: unknown[] = [];
    makeDb(plain).customers.select('name').listen(change => seen.push(change));
    expect(whole).toHaveBeenCalledOnce();
    expect(seen).toEqual([{ key: '1', attribute: 'name', value: 'Ann' }]);
  });

  it('a predicate that throws fails the listen, as it does for snapshots', () => {
    const t = new MemoryFirestoreTransport();
    t.set('customers/1', { name: 'Ann', age: 12 });
    const errors: unknown[] = [];
    makeDb(t)
      .customers.where(() => {
        throw new Error('boom');
      })
      .select('name')
      .listen(() => {}, 'watcher', error => errors.push(error));
    expect(errors).toHaveLength(1);
  });

  it('a check on the row key still sees the key when the key is stamped with withKey', () => {
    const t = new MemoryFirestoreTransport();
    t.set('customers/1', { name: 'Ann', age: 12 });
    t.set('customers/2', { name: 'Bob', age: 14 });
    for (const transport of [t, snapshotsOnly(t)]) {
      const names: unknown[] = [];
      const stop = makeDb(transport)
        .customers.withKey('id')
        .where(row => row.id === '2')
        .select('name')
        .listen(change => names.push(change));
      expect(names).toEqual([{ key: '2', attribute: 'name', value: 'Bob' }]);
      stop();
    }
  });
});

// ---- the two ways of following a list agree ----------------------------------------------------

function random(seed: number): () => number {
  let state = seed;
  return () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
}

type Db = ReturnType<typeof makeDb>;
const queries: Array<[string, (db: Db) => { listen: (next: (change: any) => void) => () => void }]> = [
  ['every row', db => db.customers.select('name', 'age')],
  ['one attribute', db => db.customers.select('tier')],
  ['a filter Firestore runs', db => db.customers.where('tier', '==', 'gold').select('name', 'age')],
  ['a check only this library can run', db => db.customers.where(row => row.age % 2 === 0).select('name', 'age')],
  ['both kinds together', db => db.customers.where('tier', '==', 'gold').where(row => row.age > 13).select('name')],
  ['an array filter', db => db.customers.whereIncludes('tags', 'floor').select('name', 'tags')],
  ['nested attributes', db => db.customers.select('contact.*')],
  ['a limit window', db => db.customers.orderBy('age').limit(3).select('name', 'age')],
  ['a limit window with a filter', db => db.customers.where('tier', '==', 'gold').orderBy('age', 'desc').limit(2).select('name', 'age')],
];

describe('following a list by its changes gives exactly the events that comparing snapshots gives', () => {
  for (const [label, build] of queries) {
    it(`${label}: the same events after every write, over a long random run`, () => {
      const pick = random(label.length * 7919);
      const withChanges = new MemoryFirestoreTransport();
      const withSnapshots = new MemoryFirestoreTransport();
      const logChanges: unknown[] = [];
      const logSnapshots: unknown[] = [];
      const stopA = build(makeDb(withChanges)).listen(change => logChanges.push(change));
      const stopB = build(makeDb(snapshotsOnly(withSnapshots))).listen(change => logSnapshots.push(change));

      for (let step = 0; step < 160; step++) {
        const id = `customers/${1 + Math.floor(pick() * 10)}`;
        const write =
          pick() < 0.2
            ? (t: MemoryFirestoreTransport) => t.delete(id)
            : (() => {
                const data = {
                  name: `N${Math.floor(pick() * 5)}`,
                  age: 10 + Math.floor(pick() * 8),
                  tier: pick() < 0.5 ? 'gold' : 'silver',
                  tags: pick() < 0.5 ? ['floor'] : pick() < 0.5 ? ['floor', 'beam'] : [],
                  contact: { email: `e${Math.floor(pick() * 3)}@x.test`, phone: '1' },
                  note: `n${Math.floor(pick() * 4)}`,
                };
                return (t: MemoryFirestoreTransport) => t.set(id, data);
              })();
        write(withChanges);
        write(withSnapshots);
        expect(logChanges, `after write ${step} to ${id}`).toEqual(logSnapshots);
      }
      expect(logChanges.length).toBeGreaterThan(10); // the run did something
      stopA();
      stopB();
      expect(withChanges.listenerCount).toBe(0);
    });
  }

  it('the events add up to what a fresh read of the same query returns', async () => {
    const pick = random(4242);
    const t = new MemoryFirestoreTransport();
    const db = makeDb(t);
    const state = new Map<string, Record<string, unknown>>();
    db.customers
      .where('tier', '==', 'gold')
      .where(row => row.age > 12)
      .select('name', 'age')
      .listen(change => {
        if (change.removed) state.delete(change.key);
        else state.set(change.key, { ...state.get(change.key), [change.attribute]: change.value });
      });
    for (let step = 0; step < 200; step++) {
      const id = `customers/${1 + Math.floor(pick() * 12)}`;
      if (pick() < 0.25) t.delete(id);
      else t.set(id, { name: `N${Math.floor(pick() * 9)}`, age: 10 + Math.floor(pick() * 8), tier: pick() < 0.6 ? 'gold' : 'silver', tags: [], contact: { email: 'e', phone: 'p' }, note: 'x' });
    }
    const fresh = await db.customers
      .where('tier', '==', 'gold')
      .where(row => row.age > 12)
      .select('name', 'age')
      .get();
    const byName = (a: { name: string; age: number }, b: { name: string; age: number }) => a.name.localeCompare(b.name) || a.age - b.age;
    expect([...state.values()].sort(byName as never)).toEqual([...fresh].sort(byName));
  });
});
