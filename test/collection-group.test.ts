import { describe, expect, it } from 'vitest';
import { collectionGroup, firestoreBackend, schema } from '../src';
import { MemoryFirestoreTransport } from '../src/testing';
import type { FirestoreTransport } from '../src/transport';
import { definition, snapshotsOnly } from './fixtures';

// Across a collection group one document id repeats under different parents: orders/o1/lines/a and
// orders/o2/lines/a are two documents. A live list must keep them as two rows, so its key is the full path.

interface Line {
  sku: string;
  qty: number;
}
const groups = { lines: collectionGroup<Line>() };
const first = 'orders/o1/lines/a';
const second = 'orders/o2/lines/a';

type Change = { key: string; attribute: string; value: unknown; removed?: boolean };

/** What a caller who keeps a row per key ends up holding. */
function follow(listen: (next: (change: Change) => void) => () => void) {
  const rows = new Map<string, Record<string, unknown>>();
  const events: Change[] = [];
  const stop = listen(change => {
    events.push(change);
    if (change.removed) rows.delete(change.key);
    else rows.set(change.key, { ...rows.get(change.key), [change.attribute]: change.value });
  });
  return { rows, events, stop };
}

const ways: Array<[string, (t: MemoryFirestoreTransport) => FirestoreTransport]> = [
  ['the change feed', t => t],
  ['whole snapshots', snapshotsOnly],
];

describe.each(ways)('a live list over a collection group, following %s', (_label, wrap) => {
  const setup = () => {
    const transport = new MemoryFirestoreTransport();
    transport.set(first, { sku: 'x', qty: 1 });
    transport.set(second, { sku: 'y', qty: 2 });
    transport.set('orders/o2/lines/b', { sku: 'z', qty: 3 });
    return { transport, db: schema(groups, firestoreBackend(wrap(transport))) };
  };

  it('keeps two documents with one id as two rows, keyed by their full path', () => {
    const { db } = setup();
    const { rows } = follow(next => db.lines.select('sku', 'qty').listen(next));
    expect(Object.fromEntries(rows)).toEqual({
      [first]: { sku: 'x', qty: 1 },
      [second]: { sku: 'y', qty: 2 },
      'orders/o2/lines/b': { sku: 'z', qty: 3 },
    });
  });

  it('a change to one leaves the other alone', () => {
    const { db, transport } = setup();
    const { rows, events } = follow(next => db.lines.select('sku', 'qty').listen(next));
    events.length = 0;
    transport.set(first, { sku: 'x', qty: 10 });
    expect(events).toEqual([{ key: first, attribute: 'qty', value: 10 }]);
    expect(rows.get(first)).toEqual({ sku: 'x', qty: 10 });
    expect(rows.get(second)).toEqual({ sku: 'y', qty: 2 });
  });

  it('removing one removes only that row', () => {
    const { db, transport } = setup();
    const { rows, events } = follow(next => db.lines.select('sku').listen(next));
    events.length = 0;
    transport.delete(first);
    expect(events).toEqual([{ key: first, attribute: '*', value: undefined, removed: true }]);
    expect([...rows.keys()].sort()).toEqual([second, 'orders/o2/lines/b']);
  });

  it('a row that stops matching a check run here leaves, and its namesake stays', () => {
    const { db, transport } = setup();
    const { rows } = follow(next => db.lines.where(row => row.qty < 5).select('sku').listen(next));
    expect(rows.size).toBe(3);
    transport.set(second, { sku: 'y', qty: 50 });
    expect([...rows.keys()].sort()).toEqual([first, 'orders/o2/lines/b']);
    transport.set(first, { sku: 'x', qty: 1 });
    expect(rows.has(first)).toBe(true);
  });

  it('a caller who joins late is replayed every row, both of the shared id', async () => {
    const { db } = setup();
    const early = follow(next => db.lines.select('sku').listen(next));
    const late = follow(next => db.lines.select('sku').listen(next));
    await Promise.resolve();
    expect([...late.rows.keys()].sort()).toEqual([...early.rows.keys()].sort());
    expect(late.rows.size).toBe(3);
  });

  it('withKey still stamps the document id, which a check can read', () => {
    const { db } = setup();
    const { rows } = follow(next =>
      db.lines
        .withKey('id')
        .where(row => row.id === 'a')
        .select('sku')
        .listen(next),
    );
    expect(Object.fromEntries(rows)).toEqual({ [first]: { sku: 'x' }, [second]: { sku: 'y' } });
  });

  it('a list that is not a group keeps the document id as its key', () => {
    const transport = new MemoryFirestoreTransport();
    transport.set('customers/1', { name: 'Ann', age: 12 });
    transport.set('customers/2', { name: 'Bob', age: 14 });
    const db = schema(definition, firestoreBackend(wrap(transport)));
    const { rows } = follow(next => db.customers.select('name').listen(next));
    expect(Object.fromEntries(rows)).toEqual({ '1': { name: 'Ann' }, '2': { name: 'Bob' } });
  });
});

describe('a transport that gives no paths', () => {
  const lines = (...ids: string[]) => ids.map(id => ({ id, data: { sku: id, qty: 1 } }));
  const transportWith = (snapshots: Array<ReturnType<typeof lines>>): FirestoreTransport => ({
    onDocument: () => () => {},
    onCollection: (_path, _query, next) => {
      for (const rows of snapshots) next(rows);
      return () => {};
    },
    getDocument: async () => undefined,
    getCollection: async () => [],
  });

  it('still works while the ids in a group are all different, keyed by id as before', () => {
    const db = schema(groups, firestoreBackend(transportWith([lines('a', 'b')])));
    const { rows } = follow(next => db.lines.select('sku').listen(next));
    expect([...rows.keys()].sort()).toEqual(['a', 'b']);
  });

  it('fails the listen, and says why, when two rows in a group share an id and nothing can tell them apart', () => {
    const db = schema(groups, firestoreBackend(transportWith([lines('a', 'a')])));
    const errors: unknown[] = [];
    db.lines.select('sku').listen(() => {}, 'watcher', error => errors.push(error));
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toMatch(/more than one row with the id "a".*Set "path"/);
  });

  it('a list that is not a group never complains, whatever the ids', () => {
    const db = schema(definition, firestoreBackend(transportWith([lines('a', 'a')])));
    const errors: unknown[] = [];
    db.customers.select('name').listen(() => {}, 'watcher', error => errors.push(error));
    expect(errors).toEqual([]);
  });
});

