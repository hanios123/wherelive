import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { deleteDoc, doc, setDoc } from 'firebase/firestore';
import { ref, remove, set } from 'firebase/database';
import { collectionGroup, firestoreBackend, leaf, realtimeBackend, schema } from '../src';
import { firebaseFirestoreTransport, firebaseRealtimeTransport } from '../src/firebase';
import { MemoryFirestoreTransport, MemoryRealtimeTransport } from '../src/testing';
import { clearDatabase, clearFirestore, connectDatabase, connectFirestore, settle } from './env';
import { stopAll, type Change } from './follow';

// What a live list says while data changes, from the real database and from the memory transport, for the same
// writes. The events that one write causes may arrive in a different order, so each step compares them as a set.

const shape = (events: Change[]) =>
  events
    .map(change => JSON.stringify(change, (_key, value) => (value === undefined ? '__undefined__' : value)))
    .sort();

interface Step {
  name: string;
  real: () => Promise<unknown>;
  memory: () => void;
}

/** Start the same listener on both, apply each step to both, and require the same events after every one. */
async function compare(listenReal: (next: (change: Change) => void) => () => void, listenMemory: (next: (change: Change) => void) => () => void, steps: Step[]) {
  const fromReal: Change[] = [];
  const fromMemory: Change[] = [];
  const stops = [listenReal(change => fromReal.push(change)), listenMemory(change => fromMemory.push(change))];
  await settle(400);
  expect(shape(fromMemory), 'the first rows').toEqual(shape(fromReal));
  for (const step of steps) {
    fromReal.length = 0;
    fromMemory.length = 0;
    await step.real();
    step.memory();
    await settle(350);
    expect(shape(fromMemory), `after: ${step.name}`).toEqual(shape(fromReal));
  }
  stops.forEach(stop => stop());
}

afterEach(() => stopAll());

describe('a Firestore list says the same thing from the emulator and from the memory transport', () => {
  interface Doc {
    name: string;
    n: number;
    tag?: string;
    note?: string;
  }
  const definition = { items: (id: string) => leaf<Doc>(), lines: collectionGroup<{ sku: string }>() };
  let connection: ReturnType<typeof connectFirestore>;
  beforeEach(async () => {
    await clearFirestore();
    connection = connectFirestore();
  });
  afterEach(() => connection.close());

  const scenario = async (name: string, build: (db: ReturnType<typeof schema<typeof definition>>) => { listen: (next: (change: any) => void) => () => void }, seed: Array<[string, Record<string, unknown>]>, steps: Array<[string, string, Record<string, unknown> | null]>) => {
    const twin = new MemoryFirestoreTransport();
    for (const [path, data] of seed) {
      await setDoc(doc(connection.firestore, path), data);
      twin.set(path, data);
    }
    const realDb = schema(definition, firestoreBackend(firebaseFirestoreTransport(connection.firestore)));
    const memoryDb = schema(definition, firestoreBackend(twin));
    await compare(
      next => build(realDb).listen(next),
      next => build(memoryDb).listen(next),
      steps.map(([label, path, data]) => ({
        name: `${name}: ${label}`,
        real: () => (data === null ? deleteDoc(doc(connection.firestore, path)) : setDoc(doc(connection.firestore, path), data)),
        memory: () => (data === null ? twin.delete(path) : twin.set(path, data)),
      })),
    );
  };

  const seed: Array<[string, Record<string, unknown>]> = [['items/a', { name: 'Ann', n: 1, tag: 'red' }], ['items/b', { name: 'Bob', n: 2, tag: 'green' }]];

  it('every row, through adds, changes, unselected changes and deletes', async () => {
    await scenario('every row', db => db.items.select('name', 'n'), seed, [
      ['add a row', 'items/c', { name: 'Cy', n: 3 }],
      ['change a selected field', 'items/a', { name: 'Ann', n: 10, tag: 'red' }],
      ['change a field that is not selected', 'items/a', { name: 'Ann', n: 10, tag: 'red', note: 'x' }],
      ['write the same data again', 'items/a', { name: 'Ann', n: 10, tag: 'red', note: 'x' }],
      ['remove a selected field', 'items/b', { n: 2, tag: 'green' }],
      ['delete a row', 'items/c', null],
    ]);
  });

  it('a filter the server runs', async () => {
    await scenario('filter', db => db.items.where('tag', '==', 'red').select('name'), seed, [
      ['a row stops matching', 'items/a', { name: 'Ann', n: 1, tag: 'green' }],
      ['a row starts to match', 'items/b', { name: 'Bob', n: 2, tag: 'red' }],
      ['a matching row is added', 'items/c', { name: 'Cy', n: 3, tag: 'red' }],
      ['a matching row is deleted', 'items/b', null],
    ]);
  });

  it('a check only this library can run', async () => {
    await scenario('check', db => db.items.where(row => row.n > 1).select('name'), seed, [
      ['a row starts to pass', 'items/a', { name: 'Ann', n: 5, tag: 'red' }],
      ['a row stops passing', 'items/b', { name: 'Bob', n: 0, tag: 'green' }],
      ['a passing row is deleted', 'items/a', null],
    ]);
  });

  it('a limit window', async () => {
    await scenario('window', db => db.items.orderBy('n').limit(2).select('name'), [...seed, ['items/c', { name: 'Cy', n: 3 }]], [
      ['a row that sorts first pushes one out', 'items/z', { name: 'Zed', n: 0 }],
      ['it is deleted and the last comes back', 'items/z', null],
      ['a row in the window moves out of it', 'items/a', { name: 'Ann', n: 99 }],
    ]);
  });

  it('a collection group', async () => {
    await scenario(
      'group',
      db => db.lines.select('sku'),
      [['orders/o1/lines/a', { sku: 'x' }], ['orders/o2/lines/a', { sku: 'y' }]],
      [
        ['one of two namesakes changes', 'orders/o1/lines/a', { sku: 'x2' }],
        ['a third under another parent', 'orders/o3/lines/a', { sku: 'z' }],
        ['one namesake is deleted', 'orders/o2/lines/a', null],
      ],
    );
  });
});

describe('a Realtime Database list says the same thing from the emulator and from the memory transport', () => {
  interface Customer {
    name: string;
    age: number;
    tier: string;
  }
  const definition = { customers: (id: string) => leaf<Customer>() };
  let connection: ReturnType<typeof connectDatabase>;
  beforeEach(async () => {
    await clearDatabase();
    connection = connectDatabase();
  });
  afterEach(() => connection.close());

  const seed = { 1: { name: 'Ann', age: 12, tier: 'gold' }, 2: { name: 'Bob', age: 14, tier: 'silver' } };

  const scenario = async (name: string, build: (db: ReturnType<typeof schema<typeof definition>>) => { listen: (next: (change: any) => void) => () => void }, steps: Array<[string, string, unknown]>) => {
    const twin = new MemoryRealtimeTransport({ customers: seed });
    await set(ref(connection.database, 'customers'), seed);
    const realDb = schema(definition, realtimeBackend(firebaseRealtimeTransport(connection.database)));
    const memoryDb = schema(definition, realtimeBackend(twin));
    await compare(
      next => build(realDb).listen(next),
      next => build(memoryDb).listen(next),
      steps.map(([label, path, value]) => ({
        name: `${name}: ${label}`,
        real: () => (value === null ? remove(ref(connection.database, path)) : set(ref(connection.database, path), value)),
        memory: () => twin.set(path, value),
      })),
    );
  };

  it('every row, through adds, changes, unselected changes and deletes', async () => {
    await scenario('every row', db => db.customers.select('name', 'age'), [
      ['add a row', 'customers/3', { name: 'Cy', age: 13, tier: 'gold' }],
      ['change a selected field', 'customers/1/age', 20],
      ['change a field that is not selected', 'customers/1/tier', 'silver'],
      ['remove a selected field', 'customers/2/name', null],
      ['delete a row', 'customers/3', null],
    ]);
  });

  it('an equality on a child', async () => {
    await scenario('equality', db => db.customers.where('tier', '==', 'gold').select('name'), [
      ['a row stops matching', 'customers/1/tier', 'silver'],
      ['a row starts to match', 'customers/2/tier', 'gold'],
      ['a matching row is added', 'customers/3', { name: 'Cy', age: 13, tier: 'gold' }],
      ['a matching row is deleted', 'customers/2', null],
    ]);
  });

  it('a limit window', async () => {
    await scenario('window', db => db.customers.orderBy('age').limit(2).select('name'), [
      ['a row that sorts first pushes one out', 'customers/3', { name: 'Zed', age: 1, tier: 'gold' }],
      ['it is deleted and the last comes back', 'customers/3', null],
    ]);
  });
});
