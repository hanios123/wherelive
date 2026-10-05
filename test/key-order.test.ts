import { describe, expect, it } from 'vitest';
import { ListQuery, UnsupportedQueryError, firestoreBackend, leaf, schema } from '../src';
import { MemoryFirestoreTransport } from '../src/testing';

// Firestore sorts by the name of a document last, and the emulator refuses an order with anything after it, and a
// backwards scan of the names on their own. The memory transport refuses the same, so a query the library should not
// send is caught here. Each case below is one the emulator was asked in test-emulator/ and answered as written.

interface Row {
  n: number;
  name: string;
  tag: string;
}
const rows = Array.from({ length: 9 }, (_, index): Row => ({ n: (index + 1) % 3, name: `x${index + 1}`, tag: (index + 1) % 2 ? 'a' : 'b' }));
const withKey = rows.map((row, index) => ({ ...row, $key: `i0${index + 1}` }));

function setup() {
  const transport = new MemoryFirestoreTransport();
  rows.forEach((row, index) => transport.set(`items/i0${index + 1}`, { ...row }));
  const db = schema({ items: (id: string) => leaf<Row>() }, firestoreBackend(transport));
  return { transport, db };
}

const plans: Array<[string, (q: any) => any]> = [
  ["a range on another field, ordered by the key, with a limit", q => q.where('n', '>=', 1).orderBy('$key').limit(3)],
  ["!= on another field, ordered by the key, with a limit", q => q.where('n', '!=', 1).orderBy('$key').limit(3)],
  ["a range on another field, ordered by the key, last rows", q => q.where('n', '>=', 1).orderBy('$key').limitToLast(3)],
  ["ordered by the key and then another field, with a limit", q => q.orderBy('$key').orderBy('n').limit(3)],
  ["a range on another field, ordered by the key, after a cursor", q => q.where('n', '>=', 1).orderBy('$key').startAfter('i02').limit(3)],
  ["a range on another field, ordered by the key, no limit", q => q.where('n', '>=', 1).orderBy('$key')],
  ["ordered by another field, then the key descending", q => q.orderBy('n').orderBy('$key', 'desc').limit(3)],
  ["an equality, ordered by the key descending, with a limit", q => q.where('tag', '==', 'a').orderBy('$key', 'desc').limit(2)],
  ["ordered by the key ascending with a limit", q => q.orderBy('$key').limit(3)],
  ["ordered by the key descending, with no limit", q => q.orderBy('$key', 'desc')],
  ["a range on the key, ordered by the key, with a limit", q => q.where('$key', '>', 'i03').orderBy('$key').limit(2)],
  ["in on the key, ordered by the key, with a limit", q => q.whereIn('$key', ['i01', 'i05', 'i07']).orderBy('$key').limit(2)],
  ["in on the key, ordered by the key descending, with a limit", q => q.whereIn('$key', ['i01', 'i05', 'i07', 'nope']).orderBy('$key', 'desc').limit(2)],
  ["== on the key, ordered by the key descending", q => q.where('$key', '==', 'i05').orderBy('$key', 'desc').limit(1)],
];

describe('an order by the key is answered the way the rows say, without sending what Firestore refuses', () => {
  it.each(plans)('%s', async (_name, plan) => {
    const { db } = setup();
    const got = await plan(db.items.withKey('$key')).get();
    expect(got).toEqual(plan(ListQuery.from(withKey)).toList());
  });

  it('sends the range and leaves the order and the limit to be finished here', async () => {
    const { db, transport } = setup();
    await db.items.withKey('$key').where('n', '>=', 1).orderBy('$key').limit(3).get();
    expect(transport.queryLog.map(entry => entry.query)).toEqual([{ where: [{ field: 'n', op: '>=', value: 1 }], orderBy: [], limit: undefined }]);
  });

  it('still sends an order by the key that Firestore accepts, so the server does the cut', async () => {
    const { db, transport } = setup();
    await db.items.withKey('$key').orderBy('$key').limit(3).get();
    await db.items.withKey('$key').where('tag', '==', 'a').orderBy('$key', 'desc').limit(2).get();
    expect(transport.queryLog.map(entry => [entry.query.orderBy, entry.query.limit])).toEqual([
      [[{ field: '__name__', direction: 'asc' }], 3],
      [[{ field: '__name__', direction: 'desc' }], 2],
    ]);
  });

  it('a live list that cannot be cut on the server says why, before anything connects', () => {
    const { db } = setup();
    expect(() => db.items.withKey('$key').where('n', '>=', 1).orderBy('$key').limit(3).select('name').listen(() => {})).toThrow(UnsupportedQueryError);
    expect(() => db.items.withKey('$key').where('n', '>=', 1).orderBy('$key').limit(3).select('name').listen(() => {})).toThrow(/puts the key last/);
  });
});

describe('the memory transport refuses what the emulator refuses', () => {
  const transport = new MemoryFirestoreTransport();
  rows.forEach((row, index) => transport.set(`items/i0${index + 1}`, { ...row }));
  const ask = (q: Parameters<MemoryFirestoreTransport['getCollection']>[1]) => transport.getCollection('items', q);
  const desc = [{ field: '__name__', direction: 'desc' as const }];

  it('a backwards scan of the names on their own, with or without a limit or a cursor', async () => {
    await expect(ask({ where: [], orderBy: desc })).rejects.toThrow('descending key scans');
    await expect(ask({ where: [], orderBy: desc, limit: 3 })).rejects.toThrow('descending key scans');
    await expect(ask({ where: [{ field: '__name__', op: '>', value: 'i03' }], orderBy: desc, limit: 2 })).rejects.toThrow('descending key scans');
  });

  it('but not one that a condition on another field narrows', async () => {
    expect((await ask({ where: [{ field: 'tag', op: '==', value: 'a' }], orderBy: desc, limit: 2 })).map(row => row.id)).toEqual(['i09', 'i07']);
    expect((await ask({ where: [{ field: 'n', op: 'in', value: [0, 1] }], orderBy: desc, limit: 3 })).map(row => row.id)).toEqual(['i09', 'i07', 'i06']);
  });

  it('a sort field after the name, or a range on another field beside an order by the name', async () => {
    const name = { field: '__name__', direction: 'asc' as const };
    await expect(ask({ where: [], orderBy: [name, { field: 'n', direction: 'asc' }] })).rejects.toThrow('more fields after the key');
    await expect(ask({ where: [{ field: 'n', op: '>=', value: 1 }], orderBy: [name] })).rejects.toThrow('more fields after the key');
    await expect(ask({ where: [{ field: 'n', op: '!=', value: 1 }], orderBy: desc })).rejects.toThrow('more fields after the key');
    expect((await ask({ where: [], orderBy: [{ field: 'n', direction: 'asc' }, { field: '__name__', direction: 'desc' }], limit: 4 })).map(row => row.id)).toEqual(['i09', 'i06', 'i03', 'i07']);
  });
});

describe('a refusal of a backwards scan reaches the caller as advice', () => {
  it('a limited order by the key, highest first, with nothing to narrow it', async () => {
    const { db } = setup();
    const refused = await db.items.withKey('$key').orderBy('$key', 'desc').limit(3).get().catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(UnsupportedQueryError);
    expect((refused as Error).message).toMatch(/descending key scans.*ascending.*equality filter.*without a limit/);
  });

  it('the same query narrowed by an equality works, and so does the order without the limit', async () => {
    const { db } = setup();
    expect((await db.items.withKey('$key').where('tag', '==', 'a').orderBy('$key', 'desc').limit(2).get()).map(row => row.$key)).toEqual(['i09', 'i07']);
    expect((await db.items.withKey('$key').orderBy('$key', 'desc').get()).map(row => row.$key)).toEqual(withKey.map(row => row.$key).reverse());
  });
});
