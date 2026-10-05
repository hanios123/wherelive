import { describe, expect, it, vi } from 'vitest';
import { ListenError, ListQuery, UnsupportedQueryError, firestoreBackend, leaf, realtimeBackend, schema } from '../src';
import { MemoryFirestoreTransport, MemoryRealtimeTransport } from '../src/testing';

interface Shopper {
  name: string;
  age: number;
  tier: string;
  tags: string[];
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
    contact: { email: `e${i}@x.test`, city: cities[i % 4] as string },
  },
}));
const everyRow = shoppers.map(row => row.data);

const definition = {
  shoppers: (id: string) => leaf<Shopper>(),
  labels: (id: string) => leaf<Shopper>().decode(raw => raw && raw.name.toUpperCase()),
  top: { ids: leaf<string[]>() },
};

function firestore(rows = shoppers) {
  const transport = new MemoryFirestoreTransport();
  for (const row of rows) transport.set(`shoppers/${row.id}`, row.data as never);
  return { transport, db: schema(definition, firestoreBackend(transport)) };
}
function realtime() {
  const transport = new MemoryRealtimeTransport({ shoppers: Object.fromEntries(shoppers.map(row => [row.id, row.data])), top: { ids: ['a', 'b'] } });
  return { transport, db: schema(definition, realtimeBackend(transport)) };
}

const manyNames = Array.from({ length: 70 }, (_, i) => `N${String(i).padStart(2, '0')}`); // 40 exist, 30 do not
const twelveNames = manyNames.slice(0, 12);

/** Every shape below must give the same rows read from a database as from an array you hold. */
const plans: Array<[string, (query: any) => any]> = [
  ['a filter', q => q.where('tier', '==', 'gold')],
  ['a range', q => q.where('age', '>=', 25).where('age', '<', 30)],
  ['IN, ordered by two keys', q => q.whereIn('tier', ['gold', 'bronze']).orderBy('age', 'desc').orderBy('name')],
  ['an IN of 70 values (split into groups of 30)', q => q.whereIn('name', manyNames).orderBy('name')],
  ['order + limit, all filters on the server', q => q.where('tier', '==', 'silver').orderBy('age').limit(5)],
  ['order + offset + limit', q => q.where('tier', '==', 'silver').orderBy('age', 'desc').orderBy('name').offset(3).limit(4)],
  ['a local check with order + limit', q => q.where((row: Shopper) => row.age % 2 === 0).orderBy('age').orderBy('name').limit(5)],
  ['order by language + limit', q => q.orderBy('name', 'asc', { locale: true }).limit(6)],
  ['order by a function + limit', q => q.orderBy((row: Shopper) => row.age, 'desc').orderBy('name').limit(3)],
  ['distinct values', q => q.select('tier').distinct()],
  ['distinct + limit', q => q.select('tier').distinct().limit(2)],
  ['aliased columns on a nested path', q => q.where('contact.city', '==', 'Lyon').select({ who: 'name', city: 'contact.city' }).orderBy('age').orderBy('name').limit(3)],
  ['array contains + NOT IN + order + limit', q => q.whereIncludes('tags', 'b').whereNotIn('tier', ['gold']).orderBy('age').orderBy('name').limit(7)],
  ['named attributes', q => q.where('contact.city', '==', 'Nice').select('name', 'age')],
  ['a NOT IN of 12 values (too many for Firestore) + limit', q => q.whereNotIn('name', twelveNames).limit(5)],
  ['limit 0', q => q.limit(0)],
  ['no match', q => q.where('age', '>', 1000)],
  ['a computed select', q => q.where('tier', '==', 'bronze').select((row: Shopper) => `${row.name}/${row.age}`)],
];

// With no orderBy a list has no promised order. Firestore puts a range first by the field it ranges over, so those
// plans are compared as sets here, and the order Firestore gives is pinned in its own test below.
const unorderedOnFirestore = new Set(['a range']);
const asSet = (rows: unknown[]) => [...rows].map(row => JSON.stringify(row)).sort();

describe('reading a list once gives the same rows as an array you hold', () => {
  it.each(plans)('Firestore: %s', async (name, plan) => {
    const { db } = firestore();
    const got = await plan(db.shoppers).get();
    const held = plan(ListQuery.from(everyRow)).toList();
    if (unorderedOnFirestore.has(name)) expect(asSet(got)).toEqual(asSet(held));
    else expect(got).toEqual(held);
  });

  it('Firestore: a range with no orderBy comes back ordered by the field it ranges over, then by document name', async () => {
    const { db } = firestore();
    const got = (await db.shoppers.where('age', '>=', 25).where('age', '<', 30).get()) as Shopper[];
    const ages = got.map(row => row.age);
    expect(ages).toEqual([...ages].sort((a, b) => a - b));
    expect(got.length).toBeGreaterThan(1);
  });

  it.each(plans)('Realtime Database: %s', async (_name, plan) => {
    const { db } = realtime();
    expect(await plan(db.shoppers).get()).toEqual(plan(ListQuery.from(everyRow)).toList());
  });
});

describe('Firestore: what is sent to the server', () => {
  const sent = async (build: (q: any) => any) => {
    const { db, transport } = firestore();
    await build(db.shoppers).get();
    return transport.queryLog.map(entry => entry.query);
  };

  it('filters run on the server, including IN and array-contains', async () => {
    const [query] = await sent(q => q.where('tier', '==', 'gold').whereIn('name', ['N00', 'N07']).whereIncludes('tags', 'a'));
    expect(query!.where).toEqual([
      { field: 'tier', op: '==', value: 'gold' },
      { field: 'name', op: 'in', value: ['N00', 'N07'] },
      { field: 'tags', op: 'array-contains', value: 'a' },
    ]);
  });

  it('an order alone is not sent: it only matters to a limit, and Firestore would drop documents that lack the field', async () => {
    const [query] = await sent(q => q.where('tier', '==', 'gold').orderBy('age'));
    expect(query).toEqual({ where: [{ field: 'tier', op: '==', value: 'gold' }], orderBy: [], limit: undefined });
  });

  it('an order and a limit are sent together when every filter runs on the server; offset is added to the limit', async () => {
    const [plain] = await sent(q => q.where('tier', '==', 'gold').orderBy('age', 'desc').limit(5));
    expect(plain).toEqual({ where: [{ field: 'tier', op: '==', value: 'gold' }], orderBy: [{ field: 'age', direction: 'desc' }], limit: 5 });
    const [paged] = await sent(q => q.orderBy('age').offset(10).limit(5));
    expect(paged!.limit).toBe(15);
  });

  it('a limit is NOT sent when a local check remains, since it would cut before the check', async () => {
    const [query] = await sent(q => q.where((row: Shopper) => row.age > 25).orderBy('age').limit(5));
    expect(query).toEqual({ where: [], orderBy: [], limit: undefined });
  });

  it('a limit is NOT sent for an order by language or by a function, or with distinct', async () => {
    expect((await sent(q => q.orderBy('name', 'asc', { locale: true }).limit(3)))[0]!.limit).toBeUndefined();
    expect((await sent(q => q.orderBy((row: Shopper) => row.age).limit(3)))[0]!.limit).toBeUndefined();
    expect((await sent(q => q.select('tier').distinct().limit(2)))[0]!.limit).toBeUndefined();
  });

  it('an IN of more than 30 values is split into groups of 30 and merged without duplicates', async () => {
    const queries = await sent(q => q.whereIn('name', manyNames));
    expect(queries.map(query => ((query.where[0] as { value: unknown }).value as unknown[]).length)).toEqual([30, 30, 10]);
  });

  it('a split IN with order and limit sends both to every group, then cuts the union', async () => {
    const { db, transport } = firestore();
    const rows = await db.shoppers.whereIn('name', manyNames).orderBy('age').orderBy('name').limit(4).get();
    expect(transport.queryLog.map(entry => entry.query.limit)).toEqual([4, 4, 4]);
    expect(rows).toEqual(ListQuery.from(everyRow).whereIn('name', manyNames).orderBy('age').orderBy('name').limit(4).toList());
  });

  it('an empty IN matches nothing without asking Firestore, and an empty NOT IN is dropped', async () => {
    const { db, transport } = firestore();
    expect(await db.shoppers.whereIn('tier', []).get()).toEqual([]);
    expect(transport.queryLog).toHaveLength(0);
    expect(await db.shoppers.whereNotIn('tier', []).get()).toHaveLength(40);
    expect(transport.queryLog[0]!.query.where).toEqual([]);
  });

  it('a NOT IN of up to 10 values runs on the server; more runs here', async () => {
    const ten = manyNames.slice(0, 10);
    expect((await sent(q => q.whereNotIn('name', ten)))[0]!.where).toEqual([{ field: 'name', op: 'not-in', value: ten }]);
    expect((await sent(q => q.whereNotIn('name', twelveNames)))[0]!.where).toEqual([]);
  });

  it('several IN lists that are each too long cannot be split together, and it says so', async () => {
    const { db } = firestore();
    await expect(db.shoppers.whereIn('name', manyNames).whereIn('age', Array.from({ length: 40 }, (_, i) => i)).get()).rejects.toThrow(UnsupportedQueryError);
  });
});

describe('where Firestore and an array differ, on purpose and written down', () => {
  const sparse = [
    { id: 'a', data: { name: 'A', age: 30, tier: 'gold', tags: [], contact: { email: '', city: 'X' } } },
    { id: 'b', data: { name: 'B', tier: 'gold', tags: [], contact: { email: '', city: 'X' } } }, // no age
    { id: 'c', data: { name: 'C', age: 20, tier: 'gold', tags: [], contact: { email: '', city: 'X' } } },
  ] as Array<{ id: string; data: Shopper }>;

  it('!= on Firestore skips a document that lacks the field, and an array does not', async () => {
    const { db } = firestore(sparse);
    expect((await db.shoppers.where('age', '!=', 30).select('name').get()).sort()).toEqual(['C']);
    expect(ListQuery.from(sparse.map(row => row.data)).where('age', '!=', 30).select('name').toList()).toEqual(['B', 'C']);
  });

  it('an order with a limit on Firestore leaves out a document that lacks the field, and an array sorts it first', async () => {
    const { db } = firestore(sparse);
    expect(await db.shoppers.orderBy('age').limit(3).select('name').get()).toEqual(['C', 'A']);
    expect(ListQuery.from(sparse.map(row => row.data)).orderBy('age').limit(3).select('name').toList()).toEqual(['B', 'C', 'A']);
  });

  it('an order without a limit is done here, so nothing is left out', async () => {
    const { db } = firestore(sparse);
    expect(await db.shoppers.orderBy('age').select('name').get()).toEqual(['B', 'C', 'A']);
  });
});

describe('a list read once, then SQL on the rows', () => {
  it('get() then group, join and aggregate, all as one flow', async () => {
    const { db } = firestore();
    const rows = await db.shoppers.where('tier', '!=', 'bronze').select({ city: 'contact.city', age: 'age' }).get();
    const summary = ListQuery.from(rows)
      .groupBy('city')
      .aggregate(a => ({ n: a.count(), oldest: a.max('age') }))
      .orderBy('n', 'desc')
      .orderBy('city')
      .toList();
    const expected = ListQuery.from(everyRow)
      .where('tier', '!=', 'bronze')
      .select({ city: 'contact.city', age: 'age' })
      .groupBy('city')
      .aggregate(a => ({ n: a.count(), oldest: a.max('age') }))
      .orderBy('n', 'desc')
      .orderBy('city')
      .toList();
    expect(summary).toEqual(expected);
    expect(summary.reduce((total, row) => total + row.n, 0)).toBe(ListQuery.from(everyRow).where('tier', '!=', 'bronze').count());
  });
});

describe('the row key', () => {
  it('withKey stamps each document id on the row, and select can pick it', async () => {
    const { db } = firestore();
    const rows = await db.shoppers.withKey('$key').where('tier', '==', 'gold').orderBy('name').limit(2).select('$key', 'name').get();
    const expected = ListQuery.from(shoppers)
      .where(row => row.data.tier === 'gold')
      .orderBy(row => row.data.name)
      .limit(2)
      .select(row => ({ $key: row.id, name: row.data.name }))
      .toList();
    expect(rows).toEqual(expected);
    expect(rows).toHaveLength(2);
  });

  it('is the list key on Realtime Database too', async () => {
    const { db } = realtime();
    const rows = await db.shoppers.withKey('$key').where('tier', '==', 'gold').select('$key').get();
    expect(rows).toEqual(ListQuery.from(shoppers).where(row => row.data.tier === 'gold').select(row => row.id).toList());
  });

  it('can be filtered and ordered on: a condition on the key is a condition on the document id', async () => {
    const { db, transport } = firestore();
    const one = await db.shoppers.withKey('$key').where('$key', '==', 's05').get();
    expect(one.map(row => row.$key)).toEqual(['s05']);
    const some = await db.shoppers.withKey('$key').whereIn('$key', ['s01', 's03', 'nope']).orderBy('$key', 'desc').limit(5).get();
    expect(some.map(row => row.$key)).toEqual(['s03', 's01']);
    // it went to Firestore as documentId(), not as a field called $key
    expect(transport.queryLog[0]!.query.where).toEqual([{ field: '__name__', op: '==', value: 's05' }]);
    expect(transport.queryLog[1]!.query.where).toEqual([{ field: '__name__', op: 'in', value: ['s01', 's03', 'nope'] }]);
    // the ids are given, so the read is small; a backwards scan of the names is one the emulator refuses, so the order runs here
    expect(transport.queryLog[1]!.query.orderBy).toEqual([]);
    expect(transport.queryLog[1]!.query.limit).toBeUndefined();
  });

  it('a key range pages through the list, and a key condition inside the key makes no sense', async () => {
    const { db } = firestore();
    const page = await db.shoppers.withKey('$key').where('$key', '>=', 's10').where('$key', '<', 's13').get();
    expect(page.map(row => row.$key)).toEqual(['s10', 's11', 's12']);
  });

  it('a live list can watch keys too', () => {
    const { db, transport } = firestore();
    const keys = new Set<string>();
    db.shoppers.withKey('$key').whereIn('$key', ['s01', 's02']).select('name').listen(change => keys.add(change.key));
    expect([...keys].sort()).toEqual(['s01', 's02']);
    expect(transport.queryLog[0]!.query.where).toEqual([{ field: '__name__', op: 'in', value: ['s01', 's02'] }]);
  });

  it('must come before select', () => {
    const { db } = firestore();
    expect(() => (db.shoppers.select('name') as any).withKey('$key')).toThrow(/before select/);
  });
});

describe('reading a node once', () => {
  it('a leaf resolves to its value, and undefined when it does not exist', async () => {
    const { db } = realtime();
    expect(await db.top.ids.get()).toEqual(['a', 'b']);
    const empty = schema({ nothing: { here: leaf<string[]>() } }, realtimeBackend(new MemoryRealtimeTransport()));
    expect(await empty.nothing.here.get()).toBeUndefined();
  });

  it('a document resolves to its data, decoded when the leaf has a decoder', async () => {
    const { db, transport } = firestore();
    transport.set('labels/s00', shoppers[0]!.data as never); // the decoded leaf lives at its own path
    expect(await db.shoppers('s00').get()).toEqual(shoppers[0]!.data);
    expect(await db.shoppers('nobody').get()).toBeUndefined();
    expect(await db.labels('s00').get()).toBe('N00');
    expect(await db.labels('nobody').get()).toBeUndefined();
  });

  it('select("*") reads whole too', async () => {
    const { db } = firestore();
    expect(await db.shoppers('s01').select('*').get()).toEqual(shoppers[1]!.data);
  });

  it('says so when there is no backend', async () => {
    const offline = schema(definition);
    await expect(offline.top.ids.get()).rejects.toThrow(/no backend to read from/);
    await expect(offline.shoppers.where('tier', '==', 'gold').get()).rejects.toThrow(/no backend to read from/);
  });
});

describe('a denied read is named after the caller', () => {
  it('on a node, a list, Firestore and Realtime Database', async () => {
    const fs = firestore();
    fs.transport.deny('shoppers');
    const list = (await fs.db.shoppers.where('tier', '==', 'gold').get('loadShoppers').catch(e => e)) as ListenError;
    expect(list).toBeInstanceOf(ListenError);
    expect(list.message).toBe('PERMISSION_DENIED: Permission denied (get --- loadShoppers): Missing or insufficient permissions. --- shoppers');
    const doc = (await fs.db.shoppers('s00').get('loadShopper').catch(e => e)) as ListenError;
    expect(doc.message).toContain('(get --- loadShopper)');
    expect(doc.path).toBe('shoppers/s00');

    const rt = realtime();
    rt.transport.deny('top');
    const node = (await rt.db.top.ids.get('loadIds').catch(e => e)) as ListenError;
    expect(node).toBeInstanceOf(ListenError);
    expect(node.identifier).toBe('loadIds');
    expect(node.message).toMatch(/^PERMISSION_DENIED: Permission denied \(get --- loadIds\)/);
  });

  it('errors that are not permission errors pass through untouched', async () => {
    const boom = new Error('offline');
    const transport = new MemoryFirestoreTransport();
    vi.spyOn(transport, 'getCollection').mockRejectedValue(boom);
    await expect(schema(definition, firestoreBackend(transport)).shoppers.where('tier', '==', 'gold').get('x')).rejects.toBe(boom);
  });
});

describe('Realtime Database: what is read', () => {
  it('the first equality runs on the server, on a dotted path too; everything else runs here', async () => {
    const { db, transport } = realtime();
    const rows = await db.shoppers.where('contact.city', '==', 'Lyon').where('age', '>', 25).orderBy('age').limit(3).get();
    expect(transport.readLog).toEqual([{ path: 'shoppers', query: { order: { child: 'contact.city' }, equalTo: 'Lyon' } }]);
    expect(rows).toEqual(ListQuery.from(everyRow).where('contact.city', '==', 'Lyon').where('age', '>', 25).orderBy('age').limit(3).toList());
  });

  it('a list with no equality reads every child', async () => {
    const { db, transport } = realtime();
    await db.shoppers.whereIn('tier', ['gold']).get();
    expect(transport.readLog).toEqual([{ path: 'shoppers' }]);
  });
});

describe('a live list: what it can and cannot say', () => {
  it('Firestore listens with an order and a limit sent to the server, and rows enter and leave the cut', () => {
    const { db, transport } = firestore();
    const changes: any[] = [];
    const stop = db.shoppers.orderBy('age', 'desc').orderBy('name').limit(2).select('name', 'age').listen(change => changes.push(change));
    expect(transport.queryLog[0]!.query).toEqual({
      where: [],
      orderBy: [
        { field: 'age', direction: 'desc' },
        { field: 'name', direction: 'asc' },
      ],
      limit: 2,
    });
    const before = new Set(changes.map(change => change.key));
    expect(before.size).toBe(2);
    changes.length = 0;
    transport.set('shoppers/newcomer', { name: 'Zoe', age: 99, tier: 'gold', tags: [], contact: { email: '', city: '' } });
    expect(changes.filter(change => change.removed)).toHaveLength(1); // someone falls out of the top 2
    expect(changes.filter(change => change.key === 'newcomer').map(change => change.attribute)).toEqual(['name', 'age']);
    stop();
    expect(transport.listenerCount).toBe(0);
  });

  it('an order without a limit is ignored, so it neither changes the request nor blocks sharing', () => {
    const { db, transport } = firestore();
    db.shoppers.select('name').listen(() => {});
    db.shoppers.orderBy('age').select('name').listen(() => {});
    expect(transport.listenerCount).toBe(1);
  });

  it('a different limit is a different connection', () => {
    const { db, transport } = firestore();
    db.shoppers.orderBy('age').limit(2).select('name').listen(() => {});
    db.shoppers.orderBy('age').limit(3).select('name').listen(() => {});
    expect(transport.listenerCount).toBe(2);
  });

  it('an empty IN has nothing to hear, so nothing connects', () => {
    const { db, transport } = firestore();
    const seen: unknown[] = [];
    const stop = db.shoppers.whereIn('tier', []).select('name').listen(change => seen.push(change));
    expect(seen).toEqual([]);
    expect(transport.listenerCount).toBe(0);
    stop();
  });

  it('IN and NOT IN listen on the server', () => {
    const { db, transport } = firestore();
    const keys = new Set<string>();
    db.shoppers.whereIn('tier', ['gold']).select('name').listen(change => keys.add(change.key));
    expect(transport.queryLog[0]!.query.where).toEqual([{ field: 'tier', op: 'in', value: ['gold'] }]);
    expect(keys.size).toBe(shoppers.filter(row => row.data.tier === 'gold').length);
  });

  it.each([
    ['an IN of more than 30 values', (q: any) => q.whereIn('name', manyNames).select('name'), /more than 30 values.*get\(\)/],
    ['a limit next to a local check', (q: any) => q.where((row: Shopper) => row.age > 1).orderBy('age').limit(3).select('name'), /every filter to run on Firestore/],
    ['an offset', (q: any) => q.offset(2).select('name'), /no offset or distinct/],
    ['distinct', (q: any) => q.distinct().select('name'), /no offset or distinct/],
    ['a computed select', (q: any) => q.select((row: Shopper) => row.name), /attribute names/],
    ['aliased columns', (q: any) => q.select({ who: 'name' }), /attribute names/],
    ['a limit ordered by language', (q: any) => q.orderBy('name', 'asc', { locale: true }).limit(2).select('name'), /only be ordered by fields/],
    ['a limit ordered by a function', (q: any) => q.orderBy((row: Shopper) => row.age).limit(2).select('name'), /only be ordered by fields/],
  ])('Firestore refuses %s before anything connects', (_name, build, message) => {
    const { db, transport } = firestore();
    expect(() => build(db.shoppers).listen(() => {})).toThrow(UnsupportedQueryError);
    expect(() => build(db.shoppers).listen(() => {})).toThrow(message);
    expect(transport.listenerCount).toBe(0);
  });

  it.each([
    ['a limit beside a range', (q: any) => q.where('age', '>', 1).limit(2).select('name'), /cannot run "age > 1"/],
    ['a limit that has to be ordered descending', (q: any) => q.orderBy('age', 'desc').limit(2).select('name'), /can limit a live list only when.*get\(\)/],
    ['IN', (q: any) => q.whereIn('tier', ['gold']).select('name'), /cannot run "tier in/],
    ['a range', (q: any) => q.where('age', '>', 1).select('name'), /cannot run "age > 1"/],
  ])('Realtime Database refuses %s on a live list, and points at get()', (_name, build, message) => {
    const { db, transport } = realtime();
    expect(() => build(db.shoppers).listen(() => {})).toThrow(UnsupportedQueryError);
    expect(() => build(db.shoppers).listen(() => {})).toThrow(message);
    expect(transport.listenerCount).toBe(0);
  });

  it('Realtime Database ignores an order without a limit', () => {
    const { db, transport } = realtime();
    const keys = new Set<string>();
    db.shoppers.orderBy('age').select('name').listen(change => keys.add(change.key));
    expect(keys.size).toBe(40);
    expect(transport.listenerCount).toBeGreaterThan(0);
  });
});

describe('the statement in the README', () => {
  interface OrderDoc {
    status: string;
    customerId: string;
    price: number;
  }
  interface CustomerDoc {
    tier: string;
    contact: { city: string };
  }
  const shop = {
    orders: (id: string) => leaf<OrderDoc>(),
    customers: (id: string) => leaf<CustomerDoc>(),
  };
  const customerDocs: Record<string, CustomerDoc> = {
    c1: { tier: 'gold', contact: { city: 'Lyon' } },
    c2: { tier: 'silver', contact: { city: 'Nice' } },
    c3: { tier: 'gold', contact: { city: 'Lyon' } },
    c4: { tier: 'gold', contact: { city: 'Metz' } },
  };
  const orderDocs: OrderDoc[] = [
    { status: 'open', customerId: 'c1', price: 30 },
    { status: 'paid', customerId: 'c3', price: 20 },
    { status: 'open', customerId: 'c2', price: 99 }, // silver, so out
    { status: 'cancelled', customerId: 'c1', price: 500 }, // not open or paid, so out
    { status: 'paid', customerId: 'c4', price: 5 },
    { status: 'open', customerId: 'ghost', price: 7 }, // no such customer, so out of the inner join
  ];

  it('SELECT city, COUNT(*), SUM(price) FROM orders JOIN customers WHERE ... GROUP BY city ORDER BY total DESC LIMIT 5', async () => {
    const transport = new MemoryFirestoreTransport();
    Object.entries(customerDocs).forEach(([id, doc]) => transport.set(`customers/${id}`, doc as never));
    orderDocs.forEach((doc, i) => transport.set(`orders/o${i}`, doc as never));
    const db = schema(shop, firestoreBackend(transport));

    const rows = ListQuery.from(await db.orders.whereIn('status', ['open', 'paid']).get())
      .innerJoin(await db.customers.withKey('id').where('tier', '==', 'gold').get(), 'customerId', 'id')
      .select({ city: row => row.right.contact.city, price: row => row.left.price })
      .groupBy('city')
      .aggregate(a => ({ n: a.count(), total: a.sum('price') }))
      .orderBy('total', 'desc')
      .limit(5)
      .toList();

    expect(rows).toEqual([
      { city: 'Lyon', n: 2, total: 50 },
      { city: 'Metz', n: 1, total: 5 },
    ]);
    // the two reads asked Firestore for exactly what it can run
    expect(transport.queryLog.map(entry => [entry.path, entry.query.where])).toEqual([
      ['orders', [{ field: 'status', op: 'in', value: ['open', 'paid'] }]],
      ['customers', [{ field: 'tier', op: '==', value: 'gold' }]],
    ]);
  });
});

describe('OR across fields: union of two reads', () => {
  it('Firestore has no OR in this library, so read each side and union them by key', async () => {
    const { db } = firestore();
    const gold = await db.shoppers.withKey('$key').where('tier', '==', 'gold').get();
    const older = await db.shoppers.withKey('$key').where('age', '>=', 32).get();
    const either = ListQuery.from(gold).union(older, '$key').orderBy('$key').toList();
    const expected = shoppers
      .filter(row => row.data.tier === 'gold' || row.data.age >= 32)
      .map(row => ({ ...row.data, $key: row.id }));
    expect(either).toEqual(expected);
    expect(either.length).toBeLessThan(gold.length + older.length); // some rows are in both, and appear once
  });
});
