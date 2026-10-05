import { describe, expect, it } from 'vitest';
import { leaf, realtimeBackend, schema } from '../src';
import { MemoryFirestoreTransport, MemoryRealtimeTransport } from '../src/testing';
import type { FirestoreFilter, FirestoreQuery, FirestoreWhere } from '../src/transport';

// Each behavior here was checked against the real Firestore and Realtime Database emulators (see test-emulator/).
// They are pinned here too, so the memory transports keep them in an ordinary run with no emulator.

const where = (field: string, op: FirestoreWhere['op'], value: unknown): FirestoreWhere => ({ field, op, value });
const query = (filters: FirestoreFilter[] = [], orderBy: FirestoreQuery['orderBy'] = [], more: Partial<FirestoreQuery> = {}): FirestoreQuery => ({ where: filters, orderBy, ...more });
const asc = (field: string) => ({ field, direction: 'asc' as const });
const desc = (field: string) => ({ field, direction: 'desc' as const });

function firestore(docs: Record<string, Record<string, unknown>>) {
  const transport = new MemoryFirestoreTransport();
  for (const [path, data] of Object.entries(docs)) transport.set(path, data);
  return transport;
}
const idsOf = async (transport: MemoryFirestoreTransport, path: string, q: FirestoreQuery) => (await transport.getCollection(path, q)).map(row => row.id);

describe('Firestore: the order of a read', () => {
  const docs = firestore({
    'c/a': { n: 9, name: 'z' },
    'c/b': { n: 3, name: 'y' },
    'c/c': { n: 6, name: 'x' },
    'c/d': { n: 3, name: 'w' },
    'c/e': { name: 'v' }, // no n
    'c/f': { n: null, name: 'u' },
  });

  it('with no order, documents come back by name', async () => {
    expect(await idsOf(docs, 'c', query())).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
  });

  it('a comparison puts the documents in the order of the field it compares, then by name', async () => {
    expect(await idsOf(docs, 'c', query([where('n', '>=', 3)]))).toEqual(['b', 'd', 'c', 'a']);
    expect(await idsOf(docs, 'c', query([where('n', '<', 9)]))).toEqual(['b', 'd', 'c']);
  });

  it('so do != and not-in, and they skip a field that is null as well as one that is missing', async () => {
    expect(await idsOf(docs, 'c', query([where('n', '!=', 6)]))).toEqual(['b', 'd', 'a']);
    expect(await idsOf(docs, 'c', query([where('n', 'not-in', [6])]))).toEqual(['b', 'd', 'a']);
    expect(await idsOf(docs, 'c', query([where('n', '!=', null)]))).toEqual(['b', 'd', 'c', 'a']);
  });

  it('not-in with a null among its values matches nothing', async () => {
    expect(await idsOf(docs, 'c', query([where('n', 'not-in', [null, 6])]))).toEqual([]);
  });

  it('names that tie break in the direction of the last order', async () => {
    expect(await idsOf(docs, 'c', query([where('n', '>=', 3)], [desc('n')]))).toEqual(['a', 'c', 'd', 'b']);
    expect(await idsOf(docs, 'c', query([where('n', '>=', 3)], [asc('n')]))).toEqual(['b', 'd', 'c', 'a']);
  });

  it('a field the query compares is ordered after the fields you ordered by', async () => {
    expect(await idsOf(docs, 'c', query([where('n', '>', 0)], [asc('name')]))).toEqual(['d', 'c', 'b', 'a']);
  });

  it('a document that lacks the ordered field is left out of an or as well, because the or is ordered by it', async () => {
    const both = query([{ any: [[where('name', '==', 'v')], [where('n', '>=', 9)]] }]);
    expect(await idsOf(docs, 'c', both)).toEqual(['a']); // "e" matches the first alternative but has no n
  });
});

describe('Firestore: names are ordered by byte, path by path', () => {
  it('capitals before lowercase, digits before both, an underscore after the capitals', async () => {
    const docs = firestore(Object.fromEntries(['Z9', 'a1', 'B2', '_x', '10', '9', 'aa', 'A'].map(id => [`c/${id}`, { n: 1 }])));
    expect(await idsOf(docs, 'c', query())).toEqual(['10', '9', 'A', 'B2', 'Z9', '_x', 'a1', 'aa']);
    expect(await idsOf(docs, 'c', query([], [desc('n')]))).toEqual(['aa', 'a1', '_x', 'Z9', 'B2', 'A', '9', '10']);
  });

  it('a collection group is ordered by full path, and each row says where it is', async () => {
    const docs = firestore({
      'orders/o2/lines/a': { sku: 'x' },
      'orders/o1/lines/b': { sku: 'x' },
      'lines/top': { sku: 'x' },
      'orders/o1/lines/a': { sku: 'x' },
    });
    const rows = await docs.getCollection('lines', query([], [], { group: true }));
    expect(rows.map(row => row.path)).toEqual(['lines/top', 'orders/o1/lines/a', 'orders/o1/lines/b', 'orders/o2/lines/a']);
    expect(rows.map(row => row.id)).toEqual(['top', 'a', 'b', 'a']);
  });

  it('a list that is not a group carries no path', async () => {
    const rows = await firestore({ 'c/a': { n: 1 } }).getCollection('c', query());
    expect(rows).toEqual([{ id: 'a', data: { n: 1 } }]);
  });
});

describe('Firestore: aggregates cover the documents that have every field they aggregate', () => {
  const docs = firestore({ 'c/a': { n: 3 }, 'c/b': { n: 4 }, 'c/c': {}, 'c/d': { n: null }, 'c/e': { other: 1 } });
  it('a count alone counts every document', async () => {
    expect(await docs.getAggregate('c', query(), { rows: { op: 'count' } })).toEqual({ rows: 5 });
  });
  it('a count beside a sum counts only the documents that have the summed field', async () => {
    expect(await docs.getAggregate('c', query(), { rows: { op: 'count' }, total: { op: 'sum', field: 'n' } })).toEqual({ rows: 3, total: 7 });
  });
  it('sums of two fields are each over the documents that have both', async () => {
    const two = firestore({ 'c/a': { x: 1, y: 10 }, 'c/b': { x: 2 }, 'c/c': { y: 30 } });
    expect(await two.getAggregate('c', query(), { x: { op: 'sum', field: 'x' }, y: { op: 'sum', field: 'y' } })).toEqual({ x: 1, y: 10 });
  });
});

describe('Realtime Database: what is stored and in what order events arrive', () => {
  it('an array is read into by position, as its numbered children are', async () => {
    const transport = new MemoryRealtimeTransport({ items: { a: { list: ['x', 'y', 'z'] } } });
    expect(await transport.getValue('items/a/list/1')).toBe('y');
    expect(await transport.getValue('items/a/list/9')).toBeUndefined();
    expect(await transport.getValue('items/a/list/first')).toBeUndefined();
  });

  it('keeps no empty array, no empty object and no null, so the node is not there', async () => {
    const transport = new MemoryRealtimeTransport();
    transport.set('x', { keep: 1, emptyList: [], emptyObject: {}, nothing: null, deep: { gone: {}, none: [] } });
    expect(await transport.getValue('x')).toEqual({ keep: 1 });
    transport.set('y', []);
    expect(await transport.getValue('y')).toBeUndefined();
  });

  it('a hole in an array reads as null, and an array of nothing is no node', async () => {
    const transport = new MemoryRealtimeTransport();
    transport.set('list', [1, null, 3]);
    expect(await transport.getValue('list')).toEqual([1, null, 3]);
    transport.set('nothing', [null, undefined]);
    expect(await transport.getValue('nothing')).toBeUndefined();
  });

  it('deleting a row: each selected attribute says undefined first, then the list says the row is gone', () => {
    const transport = new MemoryRealtimeTransport({ customers: { 1: { name: 'Ann', age: 12 }, 2: { name: 'Bob', age: 14 } } });
    const db = schema({ customers: (id: string) => leaf<{ name: string; age: number }>() }, realtimeBackend(transport));
    const events: Array<{ key?: string; attribute: string; value: unknown; removed?: boolean }> = [];
    db.customers.select('name', 'age').listen(change => events.push(change));
    events.length = 0;
    transport.set('customers/2', null);
    expect(events[events.length - 1]).toEqual({ key: '2', attribute: '*', value: undefined, removed: true });
    expect(events.slice(0, -1).map(change => [change.key, change.attribute, change.value]).sort()).toEqual([
      ['2', 'age', undefined],
      ['2', 'name', undefined],
    ]);
  });

  it('a row that only stops matching a filter is reported gone without touching its attributes', () => {
    const transport = new MemoryRealtimeTransport({ customers: { 1: { name: 'Ann', tier: 'gold' } } });
    const db = schema({ customers: (id: string) => leaf<{ name: string; tier: string }>() }, realtimeBackend(transport));
    const events: unknown[] = [];
    db.customers.where('tier', '==', 'gold').select('name').listen(change => events.push(change));
    events.length = 0;
    transport.set('customers/1/tier', 'silver');
    expect(events).toEqual([{ key: '1', attribute: '*', value: undefined, removed: true }]);
  });
});
