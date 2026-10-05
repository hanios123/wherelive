import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { firebaseRealtimeTransport } from '../src/firebase';
import { MemoryRealtimeTransport } from '../src/testing';
import type { RealtimeQuery, RealtimeTransport } from '../src/transport';
import { clearDatabase, connectDatabase, writeDatabase } from './env';

// The memory transport says it orders and bounds children the way Realtime Database does. This holds it to that:
// every query below runs against the real emulator and against the memory transport, and the answers must match,
// or both must refuse.

const connection = connectDatabase();
let real: RealtimeTransport;
let memory: MemoryRealtimeTransport;

const tags = ['red', 'green', 'blue', 'gold'];
const pad = (i: number) => `i${String(i).padStart(2, '0')}`;

/** Realtime Database keeps no null and no empty array, so an item that would have one simply lacks the field. */
function item(i: number): Record<string, unknown> {
  const data: Record<string, unknown> = {
    name: `item-${i}`,
    flag: i % 2 === 0,
    nested: { a: { b: i % 5 } },
  };
  if (i % 3 === 0) data.list = ['a', 'b'];
  if (i % 3 === 1) data.list = ['b'];
  if (i % 10 !== 0) data.n = (i % 7) * 3; // many ties, and some items with no n at all
  if (i % 13 !== 0) data.tag = tags[i % 4];
  if (i % 11 === 0) data.zero = 0;
  if (i % 9 === 0) data.no = false;
  if (i % 17 === 0) data.blank = '';
  return data;
}

beforeAll(async () => {
  await clearDatabase();
  const items = Object.fromEntries(Array.from({ length: 40 }, (_, k) => [pad(k + 1), item(k + 1)]));
  await writeDatabase('items', items);
  memory = new MemoryRealtimeTransport({ items });
  real = firebaseRealtimeTransport(connection.database);
});
afterAll(async () => {
  await clearDatabase();
  await connection.close();
});

const byChild = (child: string, more: Partial<RealtimeQuery> = {}): RealtimeQuery => ({ order: { child }, ...more });
const byKey = (more: Partial<RealtimeQuery> = {}): RealtimeQuery => ({ order: { key: true }, ...more });
const bound = (value: string | number | boolean | null, inclusive = true) => ({ value, inclusive });

const queries: Array<[string, RealtimeQuery | undefined]> = [
  ['no query: every child in key order', undefined],
  ['ordered by a child (children without it come first)', byChild('n')],
  ['ordered by a string child', byChild('tag')],
  ['ordered by a boolean child', byChild('flag')],
  ['ordered by a nested child', byChild('nested.a.b')],
  ['equalTo a number', byChild('n', { equalTo: 6 })],
  ['equalTo a string', byChild('tag', { equalTo: 'red' })],
  ['equalTo a boolean', byChild('flag', { equalTo: true })],
  ['equalTo false, which is a value and not a missing one', byChild('no', { equalTo: false })],
  ['equalTo zero', byChild('zero', { equalTo: 0 })],
  ['equalTo an empty string', byChild('blank', { equalTo: '' })],
  ['equalTo null matches the children that lack it', byChild('n', { equalTo: null })],
  ['equalTo on a nested child', byChild('nested.a.b', { equalTo: 2 })],
  ['startAt', byChild('n', { start: bound(6) })],
  ['startAfter', byChild('n', { start: bound(6, false) })],
  ['endAt', byChild('n', { end: bound(9) })],
  ['endBefore', byChild('n', { end: bound(9, false) })],
  ['a start and an end', byChild('n', { start: bound(3), end: bound(12, false) })],
  ['a range of strings', byChild('tag', { start: bound('g'), end: bound('r', false) })],
  ['a start at null (every child)', byChild('n', { start: bound(null) })],
  ['a range across kinds: startAt a string on numbers', byChild('n', { start: bound('a') })],
  ['limitToFirst', byChild('n', { limit: { first: 5 } })],
  ['limitToLast', byChild('n', { limit: { last: 5 } })],
  ['limitToFirst larger than the list', byChild('n', { limit: { first: 500 } })],
  ['a start and a limit', byChild('n', { start: bound(6), limit: { first: 4 } })],
  ['an equality and a limit', byChild('tag', { equalTo: 'blue', limit: { first: 3 } })],
  ['an equality and limitToLast', byChild('tag', { equalTo: 'blue', limit: { last: 3 } })],
  ['ordered by key', byKey()],
  ['a range of keys', byKey({ start: bound('i10'), end: bound('i20') })],
  ['limitToLast by key', byKey({ limit: { last: 6 } })],
  ['equalTo a key', byKey({ equalTo: 'i07' })],
  ['a limit with no order', { limit: { first: 5 } }],
];

describe('reading children: the memory transport gives what Realtime Database gives', () => {
  it.each(queries)('%s', async (_name, q) => {
    const [fromDatabase, fromMemory] = await Promise.allSettled([real.getChildren('items', q), memory.getChildren('items', q)]);
    if (fromDatabase.status === 'rejected') {
      expect(fromMemory.status, `Realtime Database refused this (${String(fromDatabase.reason)}) and the memory transport did not`).toBe('rejected');
      return;
    }
    expect(fromMemory.status, `Realtime Database answered and the memory transport refused (${fromMemory.status === 'rejected' ? String(fromMemory.reason) : ''})`).toBe('fulfilled');
    if (fromMemory.status === 'fulfilled') expect(fromMemory.value).toEqual(fromDatabase.value);
  });
});

describe('reading a value: the memory transport gives what Realtime Database gives', () => {
  const paths = [
    'items/i03', // an object
    'items/i03/list', // an array, stored as numbered children
    'items/i01/list', // an array of one
    'items/i02/list', // missing: the item has no list
    'items/i11/zero', // zero is a value
    'items/i09/no', // false is a value
    'items/i17/blank', // an empty string is a value
    'items/i03/nested/a/b', // deep
    'items/nope', // a node that does not exist
    'items/i03/list/0', // an element of an array
  ];
  it.each(paths)('%s', async path => {
    expect(await memory.getValue(path)).toEqual(await real.getValue(path));
  });
});

describe('what Realtime Database stores, and what the memory transport keeps of the same write', () => {
  it('drops an empty array and an empty object, and null, so the node is simply not there', async () => {
    const value = { keep: 1, emptyList: [], emptyObject: {}, nothing: null, deep: { gone: {} } };
    await writeDatabase('summaries/shape', value);
    const twin = new MemoryRealtimeTransport();
    twin.set('summaries/shape', value);
    const database = firebaseRealtimeTransport(connection.database);
    expect(await twin.getValue('summaries/shape')).toEqual(await database.getValue('summaries/shape'));
    expect(await database.getValue('summaries/shape')).toEqual({ keep: 1 });
  });

  it('gives an array back as an array when the keys run 0, 1, 2…', async () => {
    await writeDatabase('summaries/ids', ['p1', 'p2', 'p3']);
    const database = firebaseRealtimeTransport(connection.database);
    expect(await database.getValue('summaries/ids')).toEqual(['p1', 'p2', 'p3']);
  });
});
