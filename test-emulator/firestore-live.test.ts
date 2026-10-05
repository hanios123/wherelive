import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { deleteDoc, doc, setDoc, Timestamp, updateDoc } from 'firebase/firestore';
import { ListenError, collectionGroup, firestoreBackend, leaf, schema } from '../src';
import { firebaseFirestoreTransport } from '../src/firebase';
import type { FirestoreTransport } from '../src/transport';
import { clearFirestore, connectFirestore, eventually, settle } from './env';
import { follow, stopAll } from './follow';

// Live lists on the real Firebase SDK, against the emulator, followed both ways: by the SDK's own list of changes
// (what the shipped adapter reports) and by comparing whole snapshots (what a transport without a change feed gets).

interface Item {
  name: string;
  n: number;
  tag?: string;
  note?: string;
  placed?: Timestamp;
}
interface Line {
  sku: string;
  qty: number;
}
const definition = {
  items: (id: string) => leaf<Item>(),
  lines: collectionGroup<Line>(),
  locked: (id: string) => leaf<{ n: number }>(),
};

// A new connection for every test, because the SDK keeps its own cache of documents and would remember the ones the
// emulator was told to clear.
let connection: ReturnType<typeof connectFirestore>;
let shipped: FirestoreTransport;
let withoutChanges: FirestoreTransport;
beforeEach(async () => {
  await clearFirestore();
  connection = connectFirestore();
  shipped = firebaseFirestoreTransport(connection.firestore);
  const { onCollectionChanges: _feed, ...rest } = shipped;
  withoutChanges = rest;
});
afterEach(async () => {
  stopAll();
  await connection.close();
});

const put = (path: string, data: object) => setDoc(doc(connection.firestore, path), data);
const remove = (path: string) => deleteDoc(doc(connection.firestore, path));

/** The transport, counting how many live connections were opened through it and how many are still open. */
function counted(transport: FirestoreTransport) {
  const tally = { opened: 0, open: 0 };
  const watch = <A extends unknown[]>(open: (...args: A) => () => void) => (...args: A) => {
    tally.opened++;
    tally.open++;
    const stop = open(...args);
    return () => {
      tally.open--;
      stop();
    };
  };
  const wrapped: FirestoreTransport = {
    ...transport,
    onCollection: watch(transport.onCollection.bind(transport)),
    ...(transport.onCollectionChanges ? { onCollectionChanges: watch(transport.onCollectionChanges.bind(transport)) } : {}),
  };
  return { transport: wrapped, tally };
}

const ways: Array<[string, () => FirestoreTransport]> = [
  ['the SDK change feed', () => shipped],
  ['whole snapshots', () => withoutChanges],
];

describe.each(ways)('a live list on the real SDK, following %s', (_label, transportOf) => {
  const database = () => schema(definition, firestoreBackend(transportOf()));

  it('delivers the rows that exist, then what is added, changed and removed', async () => {
    await put('items/a', { name: 'Ann', n: 1 });
    await put('items/b', { name: 'Bob', n: 2 });
    const { snapshot, events, stop } = follow(next => database().items.select('name', 'n').listen(next));
    await eventually(() => expect(snapshot()).toEqual({ a: { name: 'Ann', n: 1 }, b: { name: 'Bob', n: 2 } }));

    events.length = 0;
    await put('items/c', { name: 'Cy', n: 3 });
    await eventually(() => expect(snapshot().c).toEqual({ name: 'Cy', n: 3 }));

    events.length = 0;
    await updateDoc(doc(connection.firestore, 'items/a'), { n: 10 });
    await eventually(() => expect(events).toEqual([{ key: 'a', attribute: 'n', value: 10 }]));

    events.length = 0;
    await remove('items/b');
    await eventually(() => expect(events).toEqual([{ key: 'b', attribute: '*', value: undefined, removed: true }]));
    expect(Object.keys(snapshot()).sort()).toEqual(['a', 'c']);
    stop();
  });

  it('says nothing when only a field that was not selected changed, though the server sent a snapshot', async () => {
    await put('items/a', { name: 'Ann', n: 1, note: 'x' });
    const { events, stop } = follow(next => database().items.select('name', 'n').listen(next));
    await eventually(() => expect(events).toHaveLength(2));
    events.length = 0;
    await updateDoc(doc(connection.firestore, 'items/a'), { note: 'changed' });
    await settle();
    expect(events).toEqual([]);
    stop();
  });

  it('a filter Firestore runs: a row leaves when it stops matching and arrives when it starts', async () => {
    await put('items/a', { name: 'Ann', n: 1, tag: 'red' });
    await put('items/b', { name: 'Bob', n: 2, tag: 'green' });
    const { snapshot, stop } = follow(next => database().items.where('tag', '==', 'red').select('name').listen(next));
    await eventually(() => expect(snapshot()).toEqual({ a: { name: 'Ann' } }));
    await updateDoc(doc(connection.firestore, 'items/a'), { tag: 'green' });
    await updateDoc(doc(connection.firestore, 'items/b'), { tag: 'red' });
    await eventually(() => expect(snapshot()).toEqual({ b: { name: 'Bob' } }));
    stop();
  });

  it('a check only this library can run decides who is in the list, on every update', async () => {
    await put('items/a', { name: 'Ann', n: 1 });
    await put('items/b', { name: 'Bob', n: 9 });
    const { snapshot, stop } = follow(next => database().items.where(row => row.n > 5).select('name').listen(next));
    await eventually(() => expect(snapshot()).toEqual({ b: { name: 'Bob' } }));
    await updateDoc(doc(connection.firestore, 'items/a'), { n: 7 });
    await updateDoc(doc(connection.firestore, 'items/b'), { n: 2 });
    await eventually(() => expect(snapshot()).toEqual({ a: { name: 'Ann' } }));
    stop();
  });

  it('a limit window: a new row that sorts first pushes the last one out', async () => {
    await put('items/a', { name: 'A', n: 10 });
    await put('items/b', { name: 'B', n: 20 });
    await put('items/c', { name: 'C', n: 30 });
    const { snapshot, stop } = follow(next => database().items.orderBy('n').limit(2).select('name').listen(next));
    await eventually(() => expect(Object.keys(snapshot()).sort()).toEqual(['a', 'b']));
    await put('items/z', { name: 'Z', n: 5 });
    await eventually(() => expect(Object.keys(snapshot()).sort()).toEqual(['a', 'z']));
    await remove('items/z');
    await eventually(() => expect(Object.keys(snapshot()).sort()).toEqual(['a', 'b']));
    stop();
  });

  it('a document that is not in the list yet arrives when it is created', async () => {
    const { snapshot, stop } = follow(next => database().items.select('name').listen(next));
    await settle(150);
    expect(snapshot()).toEqual({});
    await put('items/late', { name: 'Late', n: 1 });
    await eventually(() => expect(snapshot()).toEqual({ late: { name: 'Late' } }));
    stop();
  });

  it('callers with the same query share one connection, each gets the events, and the last to stop closes it', async () => {
    await put('items/a', { name: 'Ann', n: 1 });
    const { transport: counting, tally } = counted(transportOf());
    const db = schema(definition, firestoreBackend(counting));
    const first = follow(next => db.items.select('name', 'n').listen(next));
    const second = follow(next => db.items.select('n', 'name').listen(next)); // the order of names does not matter
    await eventually(() => expect(second.snapshot()).toEqual({ a: { name: 'Ann', n: 1 } }));
    expect(tally).toEqual({ opened: 1, open: 1 });

    await put('items/b', { name: 'Bob', n: 2 });
    await eventually(() => expect(first.snapshot().b).toEqual({ name: 'Bob', n: 2 }));
    await eventually(() => expect(second.snapshot().b).toEqual({ name: 'Bob', n: 2 }));

    first.stop();
    expect(tally.open).toBe(1);
    await put('items/c', { name: 'Cy', n: 3 });
    await eventually(() => expect(second.snapshot().c).toEqual({ name: 'Cy', n: 3 }));
    second.stop();
    expect(tally.open).toBe(0);
  });

  it('a caller who joins late is replayed the rows that arrived before it', async () => {
    await put('items/a', { name: 'Ann', n: 1 });
    const db = database();
    const early = follow(next => db.items.select('name').listen(next));
    await eventually(() => expect(early.snapshot()).toEqual({ a: { name: 'Ann' } }));
    const late = follow(next => db.items.select('name').listen(next));
    await eventually(() => expect(late.snapshot()).toEqual({ a: { name: 'Ann' } }));
    early.stop();
    late.stop();
  });

  it('one document: its selected attributes arrive, then only what changes', async () => {
    await put('items/a', { name: 'Ann', n: 1, note: 'x' });
    const { events, stop } = follow(next => database().items('a').select('name', 'n').listen(next));
    await eventually(() => expect(events).toHaveLength(2));
    events.length = 0;
    await updateDoc(doc(connection.firestore, 'items/a'), { note: 'changed' });
    await settle(250);
    expect(events).toEqual([]);
    await updateDoc(doc(connection.firestore, 'items/a'), { n: 2 });
    await eventually(() => expect(events).toEqual([{ attribute: 'n', value: 2 }]));
    stop();
  });

  it('a Timestamp that is written again with the same instant is not a change', async () => {
    const instant = new Date(Date.UTC(2025, 0, 10, 12, 0, 0));
    await put('items/a', { name: 'Ann', n: 1, placed: instant });
    const { events, stop } = follow(next => database().items.select('placed').listen(next));
    await eventually(() => expect(events).toHaveLength(1));
    expect((events[0]?.value as Timestamp).toDate().toISOString()).toBe(instant.toISOString());
    events.length = 0;
    await put('items/a', { name: 'Ann renamed', n: 1, placed: new Date(instant.getTime()) });
    await settle();
    expect(events).toEqual([]);
    await put('items/a', { name: 'Ann renamed', n: 1, placed: new Date(instant.getTime() + 1000) });
    await eventually(() => expect(events).toHaveLength(1));
    stop();
  });

  it('a range on a date runs on the server and follows the list', async () => {
    await put('items/a', { name: 'Old', n: 1, placed: new Date(Date.UTC(2020, 0, 1)) });
    await put('items/b', { name: 'New', n: 2, placed: new Date(Date.UTC(2025, 0, 1)) });
    const { snapshot, stop } = follow(next => database().items.where('placed', '>=', Timestamp.fromDate(new Date(Date.UTC(2024, 0, 1)))).select('name').listen(next));
    await eventually(() => expect(snapshot()).toEqual({ b: { name: 'New' } }));
    stop();
  });
});

describe.each(ways)('a live collection group on the real SDK, following %s', (_label, transportOf) => {
  const database = () => schema(definition, firestoreBackend(transportOf()));
  const first = 'orders/o1/lines/a';
  const second = 'orders/o2/lines/a';

  it('keeps two documents with one id under different parents as two rows, keyed by their full path', async () => {
    await put(first, { sku: 'x', qty: 1 });
    await put(second, { sku: 'y', qty: 2 });
    const { snapshot, events, stop } = follow(next => database().lines.select('sku', 'qty').listen(next));
    await eventually(() => expect(snapshot()).toEqual({ [first]: { sku: 'x', qty: 1 }, [second]: { sku: 'y', qty: 2 } }));

    events.length = 0;
    await updateDoc(doc(connection.firestore, first), { qty: 10 });
    await eventually(() => expect(events).toEqual([{ key: first, attribute: 'qty', value: 10 }]));
    expect(snapshot()[second]).toEqual({ sku: 'y', qty: 2 });

    events.length = 0;
    await remove(first);
    await eventually(() => expect(events).toEqual([{ key: first, attribute: '*', value: undefined, removed: true }]));
    expect(Object.keys(snapshot())).toEqual([second]);
    stop();
  });

  it('also lists a top-level collection with the same name, under its own path', async () => {
    await put('lines/top', { sku: 'z', qty: 5 });
    await put(first, { sku: 'x', qty: 1 });
    const { snapshot, stop } = follow(next => database().lines.select('sku').listen(next));
    await eventually(() => expect(snapshot()).toEqual({ 'lines/top': { sku: 'z' }, [first]: { sku: 'x' } }));
    stop();
  });
});

describe('a denied read is named after the caller', () => {
  const database = () => schema(definition, firestoreBackend(shipped));

  it('a live list reports a ListenError with the caller and the path', async () => {
    const onError = vi.fn();
    database().locked.select('n').listen(() => {}, 'watchLocked', onError);
    await eventually(() => expect(onError).toHaveBeenCalledOnce());
    const error = onError.mock.calls[0]?.[0] as ListenError;
    expect(error).toBeInstanceOf(ListenError);
    expect(error.code).toBe('PERMISSION_DENIED');
    expect(error.identifier).toBe('watchLocked');
    expect(error.path).toBe('locked');
    expect(error.message).toMatch(/^PERMISSION_DENIED: Permission denied \(listen --- watchLocked\): .* --- locked$/);
  });

  it('a one-time read rejects the same way', async () => {
    const error = (await database().locked.get('loadLocked').catch((caught: unknown) => caught)) as ListenError;
    expect(error).toBeInstanceOf(ListenError);
    expect(error.message).toMatch(/^PERMISSION_DENIED: Permission denied \(get --- loadLocked\): .* --- locked$/);
  });

  it('every caller on a shared denied connection hears it under its own name', async () => {
    const db = database();
    const a = vi.fn();
    const b = vi.fn();
    db.locked.select('n').listen(() => {}, 'first', a);
    db.locked.select('n').listen(() => {}, 'second', b);
    await eventually(() => expect(a).toHaveBeenCalledOnce());
    await eventually(() => expect(b).toHaveBeenCalledOnce());
    expect((a.mock.calls[0]?.[0] as ListenError).identifier).toBe('first');
    expect((b.mock.calls[0]?.[0] as ListenError).identifier).toBe('second');
  });
});
