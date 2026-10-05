import { describe, expect, it } from 'vitest';
import { ListQuery, UnsupportedQueryError, collectionGroup, firestoreBackend, leaf, pathOf, realtimeBackend, schema } from '../src';
import type { FirestoreFilter, FirestoreWhere } from '../src/transport';
import { MemoryFirestoreTransport, MemoryRealtimeTransport } from '../src/testing';

interface Shopper {
  name: string;
  age: number;
  tier: string;
  tags: string[];
  labels: string[];
  contact: { email: string; city: string };
}

const cities = ['Lyon', 'Nice', 'Paris', 'Metz'];
const tiers = ['gold', 'silver', 'bronze'];
const shoppers: Array<{ id: string; data: Shopper }> = Array.from({ length: 40 }, (_, i) => ({
  id: `s${String(i).padStart(2, '0')}`,
  data: {
    name: `N${String((i * 7) % 40).padStart(2, '0')}`,
    age: 20 + ((i * 13) % 17),
    tier: tiers[i % 3] as string,
    tags: i % 2 ? ['a'] : ['a', 'b'],
    labels: [`l${i % 5}`, `m${i % 3}`],
    contact: { email: `e${i}@x.test`, city: cities[i % 4] as string },
  },
}));
const everyRow = shoppers.map(row => row.data);
const manyNames = Array.from({ length: 70 }, (_, i) => `N${String(i).padStart(2, '0')}`); // 40 exist
const manyLabels = [...Array.from({ length: 5 }, (_, i) => `l${i}`), ...Array.from({ length: 3 }, (_, i) => `m${i}`), ...Array.from({ length: 30 }, (_, i) => `z${i}`)]; // 38 values

const definition = { shoppers: (id: string) => leaf<Shopper>() };

function firestore() {
  const transport = new MemoryFirestoreTransport();
  for (const row of shoppers) transport.set(`shoppers/${row.id}`, row.data as never);
  return { transport, db: schema(definition, firestoreBackend(transport)) };
}
function realtime() {
  const transport = new MemoryRealtimeTransport({ shoppers: Object.fromEntries(shoppers.map(row => [row.id, row.data])) });
  return { transport, db: schema(definition, realtimeBackend(transport)) };
}
const wheres = (filters: readonly FirestoreFilter[]) => filters as unknown as Array<FirestoreWhere & { any?: FirestoreWhere[][] }>;

/** Every shape must give the same rows from a database as from an array you hold. */
const plans: Array<[string, (query: any) => any]> = [
  ['array-contains-any', q => q.whereIncludesAny('labels', ['l1', 'm2']).orderBy('name')],
  ['array-contains-any of 38 values (overlapping groups, so rows repeat until merged)', q => q.whereIncludesAny('labels', manyLabels).orderBy('name')],
  ['or of two alternatives', q => q.whereAny((a: any) => a.where('tier', '==', 'gold'), (b: any) => b.where('age', '>=', 30).where('contact.city', '==', 'Nice')).orderBy('name')],
  ['orWhere, then where: (gold or silver) and age < 28', q => q.where('tier', '==', 'gold').orWhere('tier', '==', 'silver').where('age', '<', 28).orderBy('name')],
  ['orWhere extended twice', q => q.where('tier', '==', 'gold').orWhere('tier', '==', 'silver').orWhere('age', '>', 34).orderBy('name')],
  ['or beside an IN of 70 values (the IN is split to leave room)', q => q.whereAny((a: any) => a.where('tier', '==', 'gold'), (b: any) => b.where('tier', '==', 'bronze')).whereIn('name', manyNames).orderBy('name')],
  ['or with your own rule inside (finished here) and a limit', q => q.whereAny((a: any) => a.where((row: Shopper) => row.age % 5 === 0), (b: any) => b.where('tier', '==', 'gold')).orderBy('name').limit(6)],
  ['an alternative that can never match', q => q.whereAny((a: any) => a.whereIn('tier', []), (b: any) => b.where('tier', '==', 'bronze')).orderBy('name')],
  ['an alternative that always matches', q => q.whereAny((a: any) => a.whereNotIn('tier', []), (b: any) => b.where('tier', '==', 'gold')).limit(5)],
  ['one alternative is just AND', q => q.whereAny((a: any) => a.where('tier', '==', 'gold').where('age', '>', 25)).orderBy('name')],
  ['or, array-contains and a range together', q => q.whereAny((a: any) => a.whereIncludes('tags', 'b'), (b: any) => b.where('age', '>', 33)).where('tier', '!=', 'silver').orderBy('name').limit(9)],
  ['cursor range: startAt and endBefore', q => q.orderBy('age').orderBy('name').startAt(25, 'N10').endBefore(30)],
  ['cursor with a limit, descending', q => q.orderBy('age', 'desc').orderBy('name').startAfter(30, 'N05').limit(7)],
  ['cursor beside a local rule, with a limit', q => q.where((row: Shopper) => row.age % 2 === 0).orderBy('age').orderBy('name').startAfter(24, 'N00').limit(4)],
  ['cursor on an order by language', q => q.orderBy('name', 'asc', { locale: true }).startAfter('N10').limit(5)],
  ['endAt with one value of two keys', q => q.orderBy('age').orderBy('name').endAt(24)],
  ['limitToLast', q => q.orderBy('age').orderBy('name').limitToLast(6)],
  ['limitToLast, filtered and descending', q => q.where('tier', '==', 'gold').orderBy('age', 'desc').orderBy('name').limitToLast(4)],
  ['limitToLast after an offset', q => q.orderBy('age').orderBy('name').offset(3).limitToLast(5)],
  ['limitToLast within a cursor', q => q.orderBy('age').orderBy('name').startAt(22).limitToLast(5)],
  ['limitToLast beside a local rule', q => q.where((row: Shopper) => row.age > 25).orderBy('age').orderBy('name').limitToLast(3)],
];

describe('every Firebase query shape gives the rows an array does', () => {
  it.each(plans)('Firestore: %s', async (_name, plan) => {
    const { db } = firestore();
    const fromDatabase = await plan(db.shoppers).get();
    const fromArray = plan(ListQuery.from(everyRow)).toList();
    expect(fromDatabase).toEqual(fromArray);
    expect(fromArray.length).toBeGreaterThan(0);
  });

  it.each(plans)('Realtime Database: %s', async (_name, plan) => {
    const { db } = realtime();
    expect(await plan(db.shoppers).get()).toEqual(plan(ListQuery.from(everyRow)).toList());
  });
});

describe('array-contains-any', () => {
  it('matches a row whose array holds at least one of the values, and an empty list matches nothing', () => {
    expect(ListQuery.from(everyRow).whereIncludesAny('tags', ['b']).count()).toBe(20);
    expect(ListQuery.from(everyRow).whereIncludesAny('tags', []).none()).toBe(true);
    expect(ListQuery.from([{ v: 1 }] as never[]).whereIncludesAny('v' as never, [1] as never).none()).toBe(true); // not an array
  });

  it('is sent to Firestore as array-contains-any, split into groups of 30 when it is longer', async () => {
    const { db, transport } = firestore();
    await db.shoppers.whereIncludesAny('labels', ['l1', 'm2']).get();
    expect(wheres(transport.queryLog[0]!.query.where)).toEqual([{ field: 'labels', op: 'array-contains-any', value: ['l1', 'm2'] }]);
    transport.queryLog.length = 0;
    await db.shoppers.whereIncludesAny('labels', manyLabels).get();
    expect(transport.queryLog.map(entry => (wheres(entry.query.where)[0]!.value as unknown[]).length)).toEqual([30, 8]);
  });

  it('a live list uses it too, and refuses one that is too long', () => {
    const { db, transport } = firestore();
    const keys = new Set<string>();
    db.shoppers.whereIncludesAny('labels', ['l1']).select('name').listen(change => keys.add(change.key));
    expect(keys.size).toBe(8);
    expect(() => db.shoppers.whereIncludesAny('labels', manyLabels).select('name').listen(() => {})).toThrow(UnsupportedQueryError);
    expect(transport.listenerCount).toBe(1);
  });
});

describe('or / and', () => {
  it('whereAny is (a AND b) OR (c): a row passes when it satisfies every condition of one alternative', () => {
    const rows = [{ a: 1, b: 1 }, { a: 1, b: 2 }, { a: 2, b: 2 }, { a: 3, b: 3 }];
    const query = ListQuery.from(rows).whereAny(
      q => q.where('a', '==', 1).where('b', '==', 2),
      q => q.where('a', '==', 3),
    );
    expect(query.toList()).toEqual([{ a: 1, b: 2 }, { a: 3, b: 3 }]);
  });

  it('orWhere joins the clause before it, and a where after it applies to the whole group', () => {
    const rows = [1, 2, 3, 4, 5, 6].map(n => ({ n }));
    const query = ListQuery.from(rows).where('n', '==', 1).orWhere('n', '==', 2).orWhere('n', '>=', 5).where('n', '!=', 6);
    expect(query.select('n').toList()).toEqual([1, 2, 5]);
  });

  it('works with your own rules, on both sides', () => {
    const query = ListQuery.from([1, 2, 3, 4].map(n => ({ n }))).where(row => row.n === 1).orWhere(row => row.n === 4);
    expect(query.select('n').toList()).toEqual([1, 4]);
  });

  it('says what is wrong: nothing before orWhere, an empty alternative, a select inside one', () => {
    expect(() => ListQuery.from([{ n: 1 }]).orWhere('n', '==', 1)).toThrow(/no earlier where/);
    expect(() => ListQuery.from([{ n: 1 }]).whereAny()).toThrow(/at least one alternative/);
    expect(() => ListQuery.from([{ n: 1 }]).whereAny(q => q, q => q.where('n', '==', 1))).toThrow(/at least one condition/);
    expect(() => ListQuery.from([{ n: 1 }]).whereAny(q => q.where('n', '==', 1).limit(1), q => q.where('n', '==', 2))).toThrow(/conditions only/);
  });

  it('is sent to Firestore as one or() of and() groups', async () => {
    const { db, transport } = firestore();
    await db.shoppers.whereAny(a => a.where('tier', '==', 'gold'), b => b.where('age', '>=', 30).where('contact.city', '==', 'Nice')).get();
    expect(wheres(transport.queryLog[0]!.query.where)).toEqual([
      {
        any: [
          [{ field: 'tier', op: '==', value: 'gold' }],
          [{ field: 'age', op: '>=', value: 30 }, { field: 'contact.city', op: '==', value: 'Nice' }],
        ],
      },
    ]);
  });

  it('an IN beside an or is split to leave room: 2 alternatives x groups of 15 stay within 30 disjunctions', async () => {
    const { db, transport } = firestore();
    await db.shoppers.whereAny(a => a.where('tier', '==', 'gold'), b => b.where('tier', '==', 'bronze')).whereIn('name', manyNames).get();
    const sizes = transport.queryLog.map(entry => (wheres(entry.query.where).find(filter => 'op' in filter && filter.op === 'in')!.value as unknown[]).length);
    expect(sizes).toEqual([15, 15, 15, 15, 10]);
  });

  it('an or that cannot fit is finished here instead: it is left out of the query and a limit is not sent', async () => {
    const { db, transport } = firestore();
    // 20 values x 3 alternatives x 2 more = far past 30, and the IN alone is not long enough to split it down
    const lists = Array.from({ length: 12 }, (_, i) => `N${String(i).padStart(2, '0')}`);
    const rows = await db.shoppers
      .whereAny(a => a.whereIn('name', lists), b => b.whereIn('name', lists), c => c.whereIn('name', lists))
      .whereIn('tier', ['gold', 'silver', 'bronze'])
      .orderBy('name')
      .limit(5)
      .get();
    const sent = transport.queryLog[0]!.query;
    expect(wheres(sent.where).some(filter => 'any' in filter)).toBe(false); // the or stayed local
    expect(sent.limit).toBeUndefined(); // so the limit did too
    expect(rows).toEqual(
      ListQuery.from(everyRow)
        .whereIn('name', lists)
        .orderBy('name')
        .limit(5)
        .toList(),
    );
  });

  it('folds away what can never or always match, through an or', async () => {
    const { db, transport } = firestore();
    expect(await db.shoppers.whereAny(a => a.whereIn('tier', []), b => b.whereIn('tier', [])).get()).toEqual([]);
    expect(transport.queryLog).toHaveLength(0); // nothing to ask
    await db.shoppers.whereAny(a => a.whereNotIn('tier', []), b => b.where('tier', '==', 'gold')).limit(3).get();
    expect(transport.queryLog[0]!.query.where).toEqual([]); // the or is always true, so it is dropped
    expect(transport.queryLog[0]!.query.limit).toBe(3);
  });

  it('a live list follows an or on the server', () => {
    const { db, transport } = firestore();
    const keys = new Set<string>();
    db.shoppers.whereAny(a => a.where('tier', '==', 'gold'), b => b.where('age', '>', 34)).select('name').listen(change => keys.add(change.key));
    const expected = shoppers.filter(row => row.data.tier === 'gold' || row.data.age > 34).map(row => row.id);
    expect([...keys].sort()).toEqual(expected);
    expect('any' in wheres(transport.queryLog[0]!.query.where)[0]!).toBe(true);
  });

  it('shares one connection between equal ors written in a different order', () => {
    const { db, transport } = firestore();
    db.shoppers.whereAny(a => a.where('tier', '==', 'gold'), b => b.where('age', '>', 34)).select('name').listen(() => {});
    db.shoppers.whereAny(a => a.where('age', '>', 34), b => b.where('tier', '==', 'gold')).select('name').listen(() => {});
    expect(transport.listenerCount).toBe(1);
  });

  it('Realtime Database finishes an or locally on a read, and refuses to listen to one', async () => {
    const { db, transport } = realtime();
    const rows = await db.shoppers.whereAny(a => a.where('tier', '==', 'gold'), b => b.where('age', '>', 34)).get();
    expect(rows).toEqual(ListQuery.from(everyRow).whereAny(a => a.where('tier', '==', 'gold'), b => b.where('age', '>', 34)).toList());
    expect(() => db.shoppers.whereAny(a => a.where('tier', '==', 'gold'), b => b.where('age', '>', 34)).select('name').listen(() => {})).toThrow(/cannot run/);
    expect(transport.listenerCount).toBe(0);
  });
});

describe('cursors: paging without offset', () => {
  it('startAfter walks the whole list page by page, and the pages join up exactly', async () => {
    const { db, transport } = firestore();
    const all = ListQuery.from(everyRow).orderBy('age').orderBy('name').toList();
    const pages: Shopper[][] = [];
    let last: Shopper | undefined;
    for (;;) {
      const base = db.shoppers.orderBy('age').orderBy('name').limit(7);
      const page = await (last ? base.startAfter(last.age, last.name) : base).get();
      if (page.length === 0) break;
      pages.push(page);
      last = page[page.length - 1];
    }
    expect(pages.map(page => page.length)).toEqual([7, 7, 7, 7, 7, 5]);
    expect(pages.flat()).toEqual(all);
    // every page asked Firestore for its own slice: the order, the cursor and the limit
    const second = transport.queryLog[1]!.query;
    expect(second.orderBy).toEqual([{ field: 'age', direction: 'asc' }, { field: 'name', direction: 'asc' }]);
    expect(second.start).toEqual({ values: [pages[0]![6]!.age, pages[0]![6]!.name], inclusive: false });
    expect(second.limit).toBe(7);
  });

  it('startAt keeps the row at the position and startAfter drops it; endAt keeps and endBefore drops', () => {
    const rows = [1, 2, 3, 4, 5].map(n => ({ n }));
    const of = (q: ListQuery<{ n: number }, { n: number }>) => q.select('n').toList();
    const ordered = ListQuery.from(rows).orderBy('n');
    expect(of(ordered.startAt(2).endAt(4))).toEqual([2, 3, 4]);
    expect(of(ordered.startAfter(2).endBefore(4))).toEqual([3]);
    expect(of(ListQuery.from(rows).orderBy('n', 'desc').startAt(4))).toEqual([4, 3, 2, 1]); // descending: position 4 is followed by the smaller ones
  });

  it('positions follow the direction of each key', () => {
    const rows = [1, 2, 3, 4, 5].map(n => ({ n }));
    expect(ListQuery.from(rows).orderBy('n', 'desc').startAfter(4).select('n').toList()).toEqual([3, 2, 1]);
    expect(ListQuery.from(rows).orderBy('n', 'desc').endAt(4).select('n').toList()).toEqual([5, 4]);
  });

  it('a cursor needs an orderBy, and no more values than keys', () => {
    expect(() => ListQuery.from([{ n: 1 }]).startAfter(1).toList()).toThrow(/needs an orderBy/);
    expect(() => ListQuery.from([{ n: 1 }]).orderBy('n').startAt(1, 2).toList()).toThrow(/give one per key, at most/);
    expect(() => ListQuery.from([{ n: 1 }]).orderBy('n').endBefore().toList()).toThrow(/gave 0 value/);
  });

  it('is sent to the server beside a local rule, because a cursor is only a test on the order values', async () => {
    const { db, transport } = firestore();
    await db.shoppers.where(row => row.age > 25).orderBy('age').orderBy('name').startAfter(24, 'N00').limit(4).get();
    const sent = transport.queryLog[0]!.query;
    expect(sent.start).toEqual({ values: [24, 'N00'], inclusive: false });
    expect(sent.orderBy).toHaveLength(2);
    expect(sent.limit).toBeUndefined(); // the limit would cut before the local rule, so it stayed here
  });

  it('an order by language or by a function keeps its cursor here, and is still right', async () => {
    const { db, transport } = firestore();
    const rows = await db.shoppers.orderBy('name', 'asc', { locale: true }).startAfter('N10').limit(5).get();
    expect(transport.queryLog[0]!.query.start).toBeUndefined();
    expect(rows).toEqual(ListQuery.from(everyRow).orderBy('name', 'asc', { locale: true }).startAfter('N10').limit(5).toList());
  });

  it('a live list can page, and refuses a cursor it cannot send', () => {
    const { db, transport } = firestore();
    const keys = new Set<string>();
    db.shoppers.orderBy('age').orderBy('name').startAfter(30, 'N00').limit(3).select('name').listen(change => keys.add(change.key));
    expect(keys.size).toBe(3);
    expect(transport.queryLog[0]!.query.start).toEqual({ values: [30, 'N00'], inclusive: false });
    expect(() => db.shoppers.orderBy('name', 'asc', { locale: true }).startAfter('N10').select('name').listen(() => {})).toThrow(/orderBy by fields/);
    expect(() => db.shoppers.startAfter(1).select('name').listen(() => {})).toThrow(/needs an orderBy/);
  });

  it('Realtime Database pages on a read, here, and refuses a live cursor', async () => {
    const { db } = realtime();
    const page = await db.shoppers.orderBy('age').orderBy('name').startAfter(30, 'N00').limit(3).get();
    expect(page).toEqual(ListQuery.from(everyRow).orderBy('age').orderBy('name').startAfter(30, 'N00').limit(3).toList());
    expect(() => db.shoppers.orderBy('age').startAfter(30).select('name').listen(() => {})).toThrow(/cannot page a live list with a cursor/);
  });
});

describe('limitToLast', () => {
  it('is the last rows of the order, still in order', () => {
    const rows = [1, 2, 3, 4, 5].map(n => ({ n }));
    expect(ListQuery.from(rows).orderBy('n').limitToLast(2).select('n').toList()).toEqual([4, 5]);
    expect(ListQuery.from(rows).orderBy('n').limitToLast(9).select('n').toList()).toEqual([1, 2, 3, 4, 5]);
    expect(ListQuery.from(rows).orderBy('n').limitToLast(0).toList()).toEqual([]);
    expect(ListQuery.from(rows).orderBy('n', 'desc').limitToLast(2).select('n').toList()).toEqual([2, 1]);
  });

  it('replaces limit, and the later call wins', () => {
    const rows = [1, 2, 3, 4, 5].map(n => ({ n }));
    expect(ListQuery.from(rows).orderBy('n').limit(1).limitToLast(2).select('n').toList()).toEqual([4, 5]);
    expect(ListQuery.from(rows).orderBy('n').limitToLast(2).limit(1).select('n').toList()).toEqual([1]);
  });

  it('is sent to Firestore as the first rows of the reversed order, and comes back in order', async () => {
    const { db, transport } = firestore();
    const rows = await db.shoppers.orderBy('age').orderBy('name').limitToLast(6).get();
    const sent = transport.queryLog[0]!.query;
    expect(sent.orderBy).toEqual([{ field: 'age', direction: 'desc' }, { field: 'name', direction: 'desc' }]);
    expect(sent.limit).toBe(6);
    expect(rows).toEqual(ListQuery.from(everyRow).orderBy('age').orderBy('name').limitToLast(6).toList());
  });

  it('stays local with an offset, a cursor or a local rule, where reversing would change the answer', async () => {
    const { db, transport } = firestore();
    await db.shoppers.orderBy('age').orderBy('name').offset(3).limitToLast(5).get();
    await db.shoppers.orderBy('age').orderBy('name').startAt(22).limitToLast(5).get();
    await db.shoppers.where(row => row.age > 25).orderBy('age').limitToLast(5).get();
    expect(transport.queryLog.map(entry => entry.query.limit)).toEqual([undefined, undefined, undefined]);
  });

  it('a live list can follow the last rows, and refuses it with a cursor', () => {
    const { db, transport } = firestore();
    const keys = new Set<string>();
    db.shoppers.orderBy('age').orderBy('name').limitToLast(3).select('name').listen(change => keys.add(change.key));
    expect(keys.size).toBe(3);
    expect(transport.queryLog[0]!.query.orderBy[0]!.direction).toBe('desc');
    expect(() => db.shoppers.orderBy('age').startAt(30).limitToLast(3).select('name').listen(() => {})).toThrow(/cannot combine limitToLast with a cursor/);
  });
});

describe('where a read comes from', () => {
  it('server, cache or default is passed to Firestore for a list and for a document', async () => {
    const { db, transport } = firestore();
    await db.shoppers.where('tier', '==', 'gold').get({ source: 'server' });
    await db.shoppers.where('tier', '==', 'gold').get({ identifier: 'loadGold', source: 'cache' });
    await db.shoppers.where('tier', '==', 'gold').get('justAName');
    expect(transport.queryLog.map(entry => entry.options?.source)).toEqual(['server', 'cache', undefined]);
    await db.shoppers('s00').get({ source: 'server' });
    await db.shoppers('s00').get();
    expect(transport.documentLog.map(entry => entry.options?.source)).toEqual(['server', undefined]);
  });

  it('a denied read is still named after the identifier when a source is given', async () => {
    const { db, transport } = firestore();
    transport.deny('shoppers');
    const error = (await db.shoppers.get({ identifier: 'loadAll', source: 'server' }).catch(e => e)) as Error;
    expect(error.message).toContain('(get --- loadAll)');
  });

  it('Realtime Database has no cache to choose, and ignores it', async () => {
    const { db } = realtime();
    expect(await db.shoppers.where('tier', '==', 'gold').get({ source: 'cache' })).toHaveLength(14);
  });
});

describe('collection groups', () => {
  interface Line {
    sku: string;
    qty: number;
  }
  const groups = { lines: collectionGroup<Line>(), items: collectionGroup<Line>('lines') };

  function seeded() {
    const transport = new MemoryFirestoreTransport();
    transport.set('orders/o1/lines/l1', { sku: 'a', qty: 1 });
    transport.set('orders/o1/lines/l2', { sku: 'b', qty: 5 });
    transport.set('orders/o2/lines/l3', { sku: 'a', qty: 3 });
    transport.set('archive/x1/lines/l4', { sku: 'a', qty: 9 });
    transport.set('lines/top', { sku: 'c', qty: 2 }); // a top-level collection with the same name counts too
    transport.set('orders/o1', { note: 'not a line' });
    transport.set('orders/o1/notes/n1', { sku: 'a', qty: 100 }); // a different collection
    return { transport, db: schema(groups, firestoreBackend(transport)) };
  }

  it('one query covers every collection with the name, wherever it sits', async () => {
    const { db, transport } = seeded();
    const rows = await db.lines.where('sku', '==', 'a').withKey('$key').orderBy('qty').get();
    expect(rows.map(row => [row.$key, row.qty])).toEqual([['l1', 1], ['l3', 3], ['l4', 9]]);
    expect(transport.queryLog[0]).toMatchObject({ path: 'lines', query: { group: true } });
  });

  it('the group can be named apart from the property, and pathOf gives that name', async () => {
    const { db } = seeded();
    expect(pathOf(db.lines)).toBe('lines');
    expect(pathOf(db.items)).toBe('lines');
    expect((await db.items.get()).map(row => row.sku).sort()).toEqual(['a', 'a', 'a', 'b', 'c']);
  });

  it('counts, aggregates and listens like any list', async () => {
    const { db, transport } = seeded();
    expect(await db.lines.where('sku', '==', 'a').count()).toBe(3);
    expect(transport.aggregateLog[0]!.query.group).toBe(true);
    const keys = new Set<string>();
    db.lines.where('qty', '>', 2).select('sku').listen(change => keys.add(change.key));
    // ids repeat across parents in a group, so a live row is keyed by its full path
    expect([...keys].sort()).toEqual(['archive/x1/lines/l4', 'orders/o1/lines/l2', 'orders/o2/lines/l3']);
  });

  it('Realtime Database has no collection groups, and says so', async () => {
    const backend = realtimeBackend(new MemoryRealtimeTransport());
    const db = schema(groups, backend);
    await expect(db.lines.get()).rejects.toThrow(/no collection groups/);
    expect(() => db.lines.select('sku').listen(() => {})).toThrow(UnsupportedQueryError);
  });
});

describe('counts and aggregates on the server', () => {
  it('count() asks Firestore to count, without reading the documents', async () => {
    const { db, transport } = firestore();
    expect(await db.shoppers.where('tier', '==', 'gold').count()).toBe(14);
    expect(transport.aggregateLog).toHaveLength(1);
    expect(transport.queryLog).toHaveLength(0); // no document was read
    expect(transport.aggregateLog[0]!.aggregates).toEqual({ n: { op: 'count' } });
  });

  it('sum and average run there too, and the numbers match an array', async () => {
    const { db, transport } = firestore();
    const got = await db.shoppers.where('tier', '==', 'gold').aggregate(a => ({ n: a.count(), total: a.sum('age'), mean: a.avg('age') }));
    const [expected] = ListQuery.from(everyRow).where('tier', '==', 'gold').aggregate(a => ({ n: a.count(), total: a.sum('age'), mean: a.avg('age') })).toList();
    expect(got).toEqual(expected);
    expect(transport.queryLog).toHaveLength(0);
    // a count and the aggregates of a field are asked for apart, so neither is computed over fewer documents than it should
    expect(transport.aggregateLog.map(entry => entry.aggregates)).toEqual([{ n: { op: 'count' } }, { total: { op: 'sum', field: 'age' }, mean: { op: 'avg', field: 'age' } }]);
  });

  it('a count beside a sum counts every row, even the ones that lack the summed field', async () => {
    const transport = new MemoryFirestoreTransport();
    const rows = [{ n: 3 }, { n: 4 }, {}, { n: null }, { other: 1 }] as Array<Record<string, unknown>>;
    rows.forEach((row, index) => transport.set(`things/t${index}`, row as never));
    const db = schema({ things: (id: string) => leaf<{ n?: number | null }>() }, firestoreBackend(transport));
    const build = (a: any) => ({ rows: a.count(), total: a.sum('n'), mean: a.avg('n') });
    const [expected] = ListQuery.from(rows as Array<{ n?: number | null }>).aggregate(build).toList();
    expect(await db.things.aggregate(build)).toEqual(expected);
    expect(expected).toEqual({ rows: 5, total: 7, mean: 3.5 });
  });

  it('sums of two fields are each over every row that has that field', async () => {
    const transport = new MemoryFirestoreTransport();
    const rows = [{ a: 1, b: 10 }, { a: 2 }, { b: 30 }, { a: 4, b: 40 }] as Array<Record<string, unknown>>;
    rows.forEach((row, index) => transport.set(`things/t${index}`, row as never));
    const db = schema({ things: (id: string) => leaf<{ a?: number; b?: number }>() }, firestoreBackend(transport));
    const build = (x: any) => ({ a: x.sum('a'), b: x.sum('b') });
    const [expected] = ListQuery.from(rows as Array<{ a?: number; b?: number }>).aggregate(build).toList();
    expect(await db.things.aggregate(build)).toEqual(expected);
    expect(expected).toEqual({ a: 7, b: 80 });
  });

  it('runs with an or, an IN and a range as long as every filter runs on the server', async () => {
    const { db, transport } = firestore();
    const query = (q: any) => q.whereAny((a: any) => a.where('tier', '==', 'gold'), (b: any) => b.where('age', '>', 34)).whereIn('contact.city', ['Lyon', 'Nice']);
    expect(await query(db.shoppers).count()).toBe(query(ListQuery.from(everyRow)).count());
    expect(transport.aggregateLog).toHaveLength(1);
  });

  it('reads the rows and aggregates here when the server cannot: min, max, collect, a local rule, a select, a limit', async () => {
    const { db, transport } = firestore();
    const expected = (build: (q: any) => any) => build(ListQuery.from(everyRow)).aggregate((a: any) => ({ n: a.count(), top: a.max('age') })).first();
    const check = async (label: string, build: (q: any) => any) => {
      transport.aggregateLog.length = 0;
      transport.queryLog.length = 0;
      const got = await build(db.shoppers).aggregate((a: any) => ({ n: a.count(), top: a.max('age') }));
      expect(got, label).toEqual(expected(build));
      expect(transport.aggregateLog, label).toHaveLength(0);
      expect(transport.queryLog.length, label).toBeGreaterThan(0);
    };
    await check('max is not a Firestore aggregate', q => q.where('tier', '==', 'gold'));
    const local = await db.shoppers.where(row => row.age > 30).aggregate(a => ({ n: a.count(), total: a.sum('age') }));
    expect(local).toEqual(ListQuery.from(everyRow).where(row => row.age > 30).aggregate(a => ({ n: a.count(), total: a.sum('age') })).first());
    const limited = await db.shoppers.orderBy('age').limit(5).aggregate(a => ({ n: a.count() }));
    expect(limited.n).toBe(5);
    const projected = await db.shoppers.select('age').aggregate(a => ({ n: a.count() }));
    expect(projected.n).toBe(40);
    expect(transport.aggregateLog).toHaveLength(0);
  });

  it('count of a field skips missing values, so it reads the rows: Firestore counts documents', async () => {
    const { db, transport } = firestore();
    const sparse = new MemoryFirestoreTransport();
    sparse.set('shoppers/a', { name: 'A', age: 1 } as never);
    sparse.set('shoppers/b', { name: 'B' } as never);
    const got = await schema(definition, firestoreBackend(sparse)).shoppers.aggregate(a => ({ withAge: a.count('age'), all: a.count() }));
    expect(got).toEqual({ withAge: 1, all: 2 });
    expect(transport.aggregateLog).toHaveLength(0);
    void db;
  });

  it('an empty IN counts nothing without asking, and a transport without aggregates falls back to reading', async () => {
    const { db, transport } = firestore();
    expect(await db.shoppers.whereIn('tier', []).aggregate(a => ({ n: a.count(), total: a.sum('age'), mean: a.avg('age') }))).toEqual({ n: 0, total: 0, mean: undefined });
    expect(transport.aggregateLog).toHaveLength(0);
    expect(transport.queryLog).toHaveLength(0);

    const plain = new MemoryFirestoreTransport();
    for (const row of shoppers) plain.set(`shoppers/${row.id}`, row.data as never);
    const bare = { onDocument: plain.onDocument.bind(plain), onCollection: plain.onCollection.bind(plain), getDocument: plain.getDocument.bind(plain), getCollection: plain.getCollection.bind(plain) };
    expect(await schema(definition, firestoreBackend(bare)).shoppers.where('tier', '==', 'gold').count()).toBe(14);
    expect(plain.queryLog.length).toBeGreaterThan(0);
  });

  it('a read from the cache is aggregated here, since Firestore aggregates always come from the server', async () => {
    const { db, transport } = firestore();
    expect(await db.shoppers.where('tier', '==', 'gold').count({ source: 'cache' })).toBe(14);
    expect(transport.aggregateLog).toHaveLength(0);
    expect(transport.queryLog[0]!.options?.source).toBe('cache');
  });

  it('Realtime Database counts by reading, and a denied count is named', async () => {
    const rt = realtime();
    expect(await rt.db.shoppers.where('tier', '==', 'gold').count()).toBe(14);
    const fs = firestore();
    fs.transport.deny('shoppers');
    const error = (await fs.db.shoppers.count('countShoppers').catch(e => e)) as Error;
    expect(error.message).toMatch(/^PERMISSION_DENIED: Permission denied \(get --- countShoppers\)/);
  });
});
