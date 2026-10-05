import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { doc, setDoc } from 'firebase/firestore';
import { firebaseFirestoreTransport } from '../src/firebase';
import { DOCUMENT_ID } from '../src/firestore/backend';
import { MemoryFirestoreTransport } from '../src/testing';
import type { FirestoreFilter, FirestoreQuery, FirestoreRow, FirestoreTransport, FirestoreWhere } from '../src/transport';
import { clearFirestore, connectFirestore } from './env';

// The memory transport says it follows Firestore's own rules, so a test finds out what the real one would say.
// This holds it to that: every query below runs against the real emulator and against the memory transport,
// and the answers must match, or both must refuse.

const connection = connectFirestore();
let real: FirestoreTransport;
let memory: MemoryFirestoreTransport;

const tags = ['red', 'green', 'blue', 'gold'];
const pad = (i: number) => `i${String(i).padStart(2, '0')}`;

function item(i: number): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: `item-${i}`,
    flag: i % 2 === 0,
    tags: i % 3 === 0 ? ['a', 'b'] : i % 3 === 1 ? ['b'] : [],
    nested: { a: { b: i % 5 } },
  };
  if (i % 10 !== 0) data.n = (i % 7) * 3; // many ties, and some items with no n at all
  if (i === 5) data.n = null;
  if (i % 13 !== 0) data.tag = tags[i % 4];
  if (i % 2 === 0) data.placed = new Date(Date.UTC(2025, 0, i));
  return data;
}

const lines: Array<[string, Record<string, unknown>]> = [
  ['orders/o1/lines/a', { sku: 'x', qty: 1 }],
  ['orders/o2/lines/a', { sku: 'y', qty: 2 }],
  ['orders/o2/lines/b', { sku: 'x', qty: 3 }],
  ['orders/o3/lines/c', { sku: 'z', qty: 4 }],
  ['lines/top', { sku: 'x', qty: 5 }],
];

beforeAll(async () => {
  await clearFirestore();
  memory = new MemoryFirestoreTransport();
  for (let i = 1; i <= 40; i++) {
    await setDoc(doc(connection.firestore, `items/${pad(i)}`), item(i));
    memory.set(`items/${pad(i)}`, item(i));
  }
  for (const [path, data] of lines) {
    await setDoc(doc(connection.firestore, path), data);
    memory.set(path, data);
  }
  real = firebaseFirestoreTransport(connection.firestore);
});
afterAll(async () => {
  await clearFirestore();
  await connection.close();
});

/** Dates and Firestore Timestamps are the same instant, and only the rows' ids and data are being compared. */
function plain(value: unknown): unknown {
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object' && value !== null && typeof (value as { toDate?: unknown }).toDate === 'function') return (value as { toDate(): Date }).toDate().toISOString();
  if (Array.isArray(value)) return value.map(plain);
  if (typeof value === 'object' && value !== null) return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, plain(inner)]));
  return value;
}
const rowsOf = (rows: readonly FirestoreRow[]) => rows.map(row => ({ id: row.id, data: plain(row.data) }));

const where = (field: string, op: FirestoreWhere['op'], value: unknown): FirestoreWhere => ({ field, op, value });
const query = (filters: FirestoreFilter[] = [], orderBy: FirestoreQuery['orderBy'] = [], more: Partial<FirestoreQuery> = {}): FirestoreQuery => ({ where: filters, orderBy, ...more });
const asc = (field: string) => ({ field, direction: 'asc' as const });
const desc = (field: string) => ({ field, direction: 'desc' as const });
const many = (count: number, make: (i: number) => unknown) => Array.from({ length: count }, (_, i) => make(i));

const queries: Array<[string, FirestoreQuery]> = [
  ['no conditions', query()],
  ['== a string', query([where('tag', '==', 'red')])],
  ['== a number', query([where('n', '==', 6)])],
  ['== a boolean', query([where('flag', '==', true)])],
  ['== null (a missing field is not null)', query([where('n', '==', null)])],
  ['== a nested field', query([where('nested.a.b', '==', 2)])],
  ['== an empty string that nothing has', query([where('tag', '==', '')])],
  ['!= skips documents without the field', query([where('tag', '!=', 'red')])],
  ['!= a number', query([where('n', '!=', 6)])],
  ['<', query([where('n', '<', 6)])],
  ['<=', query([where('n', '<=', 6)])],
  ['>', query([where('n', '>', 6)])],
  ['>=', query([where('n', '>=', 6)])],
  ['a range on strings', query([where('name', '>=', 'item-2'), where('name', '<', 'item-3')])],
  ['a range on dates', query([where('placed', '>=', new Date(Date.UTC(2025, 0, 10)))])],
  ['a range of two bounds on one field', query([where('n', '>', 3), where('n', '<', 12)])],
  ['in, three values', query([where('tag', 'in', ['red', 'blue', 'nope'])])],
  ['in, thirty values (the most allowed)', query([where('n', 'in', many(30, i => i))])],
  ['in, thirty-one values (refused)', query([where('n', 'in', many(31, i => i))])],
  ['in, none (refused)', query([where('n', 'in', [])])],
  ['in on the document id', query([where(DOCUMENT_ID, 'in', ['i03', 'i07', 'i99'])])],
  ['not-in, three values', query([where('tag', 'not-in', ['red', 'blue'])])],
  ['not-in, ten values (the most allowed)', query([where('n', 'not-in', many(10, i => i))])],
  ['not-in, eleven values (refused)', query([where('n', 'not-in', many(11, i => i))])],
  ['array-contains', query([where('tags', 'array-contains', 'a')])],
  ['array-contains-any', query([where('tags', 'array-contains-any', ['a', 'zzz'])])],
  ['array-contains-any, thirty-one values (refused)', query([where('tags', 'array-contains-any', many(31, i => `t${i}`))])],
  ['two equalities', query([where('tag', '==', 'red'), where('flag', '==', true)])],
  ['an equality and a range on another field', query([where('tag', '==', 'red'), where('n', '>=', 6)])],
  ['a range on two different fields', query([where('n', '>', 3), where('name', '<', 'item-3')])],
  ['!= and a range on one field', query([where('n', '!=', 3), where('n', '<', 12)])],
  ['or of two conditions', query([{ any: [[where('tag', '==', 'red')], [where('n', '>=', 15)]] }])],
  ['or of and-groups', query([{ any: [[where('tag', '==', 'red'), where('flag', '==', true)], [where('tag', '==', 'gold')]] }])],
  ['or beside another condition', query([where('flag', '==', true), { any: [[where('tag', '==', 'red')], [where('tag', '==', 'gold')]] }])],
  ['orderBy (drops documents without the field)', query([], [asc('n')])],
  ['orderBy descending', query([], [desc('n')])],
  ['orderBy two fields', query([], [asc('tag'), desc('n')])],
  ['orderBy a string field', query([], [asc('name')])],
  ['orderBy the document id', query([], [asc(DOCUMENT_ID)])],
  // The document name is always the last sort field, and the emulator will not scan names backwards on their own.
  ['orderBy the document id descending (refused)', query([], [desc(DOCUMENT_ID)])],
  ['the document id descending with a limit (refused)', query([], [desc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id descending with a cursor (refused)', query([], [desc(DOCUMENT_ID)], { start: { values: ['i05'], inclusive: false } })],
  ['the document id descending beside an equality', query([where('tag', '==', 'red')], [desc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id descending beside an in on another field', query([where('n', 'in', [0, 3])], [desc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id descending beside array-contains', query([where('tags', 'array-contains', 'a')], [desc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id descending beside an or of equalities', query([{ any: [[where('tag', '==', 'red')], [where('tag', '==', 'gold')]] }], [desc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id descending beside a condition on the id itself (refused)', query([where(DOCUMENT_ID, '>', 'i03')], [desc(DOCUMENT_ID)], { limit: 2 })],
  ['the document id descending beside a range on another field (refused)', query([where('n', '>=', 3)], [desc(DOCUMENT_ID)])],
  ['the document id descending beside != (refused)', query([where('n', '!=', 3)], [desc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id, then another field (refused)', query([], [asc(DOCUMENT_ID), asc('n')], { limit: 3 })],
  ['another field, then the document id descending', query([], [asc('n'), desc(DOCUMENT_ID)], { limit: 4 })],
  ['the document id ascending beside a range on another field (refused)', query([where('n', '>=', 3)], [asc(DOCUMENT_ID)], { limit: 3 })],
  ['the document id ascending beside an equality', query([where('tag', '==', 'red')], [asc(DOCUMENT_ID)], { limit: 3 })],
  ['a range with an order on another field', query([where('n', '>', 3)], [asc('name')])],
  ['a range ordered by its own field, descending', query([where('n', '>', 3)], [desc('n')])],
  ['!= null (null never matches a !=)', query([where('n', '!=', null)])],
  ['not-in with a null', query([where('n', 'not-in', [null, 3])])],
  ['orderBy and limit', query([], [asc('n')], { limit: 5 })],
  ['limit with no order', query([], [], { limit: 7 })],
  ['a filter, an order and a limit', query([where('flag', '==', true)], [desc('n')], { limit: 4 })],
  ['startAt', query([], [asc('n')], { start: { values: [6], inclusive: true } })],
  ['startAfter', query([], [asc('n')], { start: { values: [6], inclusive: false } })],
  ['endAt', query([], [asc('n')], { end: { values: [9], inclusive: true } })],
  ['endBefore', query([], [asc('n')], { end: { values: [9], inclusive: false } })],
  ['a start and an end', query([], [asc('n')], { start: { values: [3], inclusive: true }, end: { values: [12], inclusive: false } })],
  ['a cursor on two order keys', query([], [asc('tag'), asc('n')], { start: { values: ['green', 6], inclusive: true } })],
  ['a descending cursor', query([], [desc('n')], { start: { values: [12], inclusive: true } })],
  ['a cursor with no order (refused)', query([], [], { start: { values: [1], inclusive: true } })],
];

describe('reading a collection: the memory transport gives what Firestore gives', () => {
  it.each(queries)('%s', async (_name, q) => {
    const [fromFirestore, fromMemory] = await Promise.allSettled([real.getCollection('items', q), memory.getCollection('items', q)]);
    if (fromFirestore.status === 'rejected') {
      expect(fromMemory.status, `Firestore refused this (${String(fromFirestore.reason)}) and the memory transport did not`).toBe('rejected');
      return;
    }
    expect(fromMemory.status, `Firestore answered and the memory transport refused (${fromMemory.status === 'rejected' ? String(fromMemory.reason) : ''})`).toBe('fulfilled');
    if (fromMemory.status === 'fulfilled') expect(rowsOf(fromMemory.value)).toEqual(rowsOf(fromFirestore.value));
  });
});

describe('document names are ordered byte by byte, not by language', () => {
  const ids = ['Z9', 'a1', 'B2', '_x', '10', '9', 'aa', 'A'];
  beforeAll(async () => {
    for (const id of ids) {
      await setDoc(doc(connection.firestore, `customers/${id}`), { n: 1 });
      memory.set(`customers/${id}`, { n: 1 });
    }
  });
  it('an unordered read returns the names in that order', async () => {
    const fromFirestore = await real.getCollection('customers', query());
    const fromMemory = await memory.getCollection('customers', query());
    expect(fromFirestore.map(row => row.id)).toEqual(['10', '9', 'A', 'B2', 'Z9', '_x', 'a1', 'aa']);
    expect(rowsOf(fromMemory)).toEqual(rowsOf(fromFirestore));
  });
  it('and descending, when an order is given', async () => {
    const q = query([], [desc('n')]);
    expect(rowsOf(await memory.getCollection('customers', q))).toEqual(rowsOf(await real.getCollection('customers', q)));
  });
});

describe('a collection group: the memory transport gives what Firestore gives', () => {
  const group: Array<[string, FirestoreQuery]> = [
    ['every line, wherever it sits', query([], [], { group: true })],
    ['a filter across parents', query([where('sku', '==', 'x')], [], { group: true })],
    ['ordered', query([], [asc('qty')], { group: true })],
    ['ordered and limited', query([], [desc('qty')], { group: true, limit: 2 })],
    ['ordered by a field that ties, so the full path breaks the tie', query([where('sku', '==', 'x')], [asc('sku')], { group: true })],
    ['descending, where the tie-break runs backwards too', query([], [desc('sku')], { group: true })],
  ];
  it.each(group)('%s', async (_name, q) => {
    const fromFirestore = await real.getCollection('lines', q);
    const fromMemory = await memory.getCollection('lines', q);
    expect(rowsOf(fromMemory)).toEqual(rowsOf(fromFirestore));
  });

  it('gives each row the full path that tells two documents with one id apart', async () => {
    const rows = await memory.getCollection('lines', query([where('sku', 'in', ['x', 'y'])], [asc('qty')], { group: true }));
    expect(rows.map(row => row.path)).toEqual(['orders/o1/lines/a', 'orders/o2/lines/a', 'orders/o2/lines/b', 'lines/top']);
  });
});

describe('counts, sums and averages: the memory transport gives what Firestore gives', () => {
  const aggregates = { n: { op: 'count' as const }, total: { op: 'sum' as const, field: 'n' }, mean: { op: 'avg' as const, field: 'n' } };
  const cases: Array<[string, FirestoreQuery]> = [
    ['over everything', query()],
    ['over a filter', query([where('tag', '==', 'red')])],
    ['over nothing', query([where('tag', '==', 'nope')])],
    ['over a range', query([where('n', '>=', 6)])],
  ];
  it.each(cases)('%s', async (_name, q) => {
    const fromFirestore = await real.getAggregate?.('items', q, aggregates);
    const fromMemory = await memory.getAggregate('items', q, aggregates);
    expect(fromMemory).toEqual(fromFirestore);
  });
});
