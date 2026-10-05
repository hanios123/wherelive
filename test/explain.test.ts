import { describe, expect, it } from 'vitest';
import { collectionGroup, firestoreBackend, firestoreIndexes, leaf, realtimeBackend, schema, type IndexAdvice, type QueryExplanation } from '../src';
import { MemoryFirestoreTransport, MemoryRealtimeTransport } from '../src/testing';

// query.explain() says where each part of a query runs and which indexes Firebase needs. The index rules are the ones in
// Firebase's documentation; each case below names the rule it checks. No database is asked anything.

interface Item {
  n: number;
  m: number;
  name: string;
  tag: string;
  tags: string[];
}
interface Line {
  sku: string;
  qty: number;
}

function firestore() {
  const transport = new MemoryFirestoreTransport();
  const db = schema({ items: (id: string) => leaf<Item>(), lines: collectionGroup<Line>() }, firestoreBackend(transport));
  return { db, transport };
}
const { db } = firestore();
const explain = (build: (q: any) => any): QueryExplanation => build(db.items.withKey('$key')).explain();
const composites = (e: QueryExplanation) => e.indexes.filter((item): item is Extract<IndexAdvice, { kind: 'composite' }> => item.kind === 'composite');
const asc = (fieldPath: string) => ({ fieldPath, order: 'ASCENDING' as const });
const desc = (fieldPath: string) => ({ fieldPath, order: 'DESCENDING' as const });
const contains = (fieldPath: string) => ({ fieldPath, arrayConfig: 'CONTAINS' as const });

describe('Firestore: what the automatic single-field indexes serve needs nothing set up', () => {
  it.each([
    ['no conditions', (q: any) => q],
    ['an equality', (q: any) => q.where('tag', '==', 'a')],
    ['equalities on several fields', (q: any) => q.where('tag', '==', 'a').where('n', '==', 1).where('m', '==', 2)],
    ['an in', (q: any) => q.whereIn('tag', ['a', 'b'])],
    ['an in beside an equality', (q: any) => q.whereIn('tag', ['a', 'b']).where('n', '==', 1)],
    ['a range on one field', (q: any) => q.where('n', '>=', 1).where('n', '<', 5)],
    ['a range and an order on the same field, either way', (q: any) => q.where('n', '>', 1).orderBy('n', 'desc')],
    ['an order on one field', (q: any) => q.orderBy('n')],
    ['an order on one field, descending', (q: any) => q.orderBy('n', 'desc').limit(5)],
    ['an array-contains on its own', (q: any) => q.whereIncludes('tags', 'x')],
    ['an order by the key, ascending', (q: any) => q.orderBy('$key').limit(3)],
    ['an equality and the key ascending', (q: any) => q.where('tag', '==', 'a').orderBy('$key')],
  ])('%s', (_name, build) => {
    expect(explain(build).indexes).toEqual([]);
  });
});

describe('Firestore: a compound query with a range, or sorted by a different field, needs a composite index', () => {
  it.each([
    ['an equality and an order on another field', (q: any) => q.where('tag', '==', 'a').orderBy('n').limit(3), [asc('tag'), asc('n')]],
    ['an equality and a range on another field', (q: any) => q.where('tag', '==', 'a').where('n', '>=', 3), [asc('tag'), asc('n')]],
    ['an in and an order on another field', (q: any) => q.whereIn('tag', ['a', 'b']).orderBy('n').limit(3), [asc('tag'), asc('n')]],
    ['two orders', (q: any) => q.orderBy('n').orderBy('m', 'desc').limit(3), [asc('n'), desc('m')]],
    ['a range ordered by its own field, descending, beside an equality', (q: any) => q.where('tag', '==', 'a').where('n', '>', 1).orderBy('n', 'desc').limit(3), [asc('tag'), desc('n')]],
    ['a range, and an order on another field: equality, then sort, then range', (q: any) => q.where('tag', '==', 'a').where('n', '>=', 3).orderBy('name').limit(3), [asc('tag'), asc('name'), asc('n')]],
    ['ranges on two fields, in the order given', (q: any) => q.where('n', '>', 1).where('m', '<', 9), [asc('n'), asc('m')]],
    ['a != beside an equality on another field', (q: any) => q.where('tag', '==', 'a').where('n', '!=', 3), [asc('tag'), asc('n')]],
    ['a not-in beside an equality', (q: any) => q.where('tag', '==', 'a').whereNotIn('n', [1, 2]), [asc('tag'), asc('n')]],
    ['the equalities keep the order the query gave them', (q: any) => q.where('m', '==', 1).where('tag', '==', 'a').orderBy('n').limit(3), [asc('m'), asc('tag'), asc('n')]],
  ])('%s', (_name, build, fields) => {
    const [only, ...others] = composites(explain(build));
    expect(others).toEqual([]);
    expect(only?.need).toBe('required');
    expect(only?.index).toEqual({ collectionGroup: 'items', queryScope: 'COLLECTION', fields });
  });

  it('says which rule it applied', () => {
    const [only] = composites(explain(q => q.where('tag', '==', 'a').where('n', '>=', 3).orderBy('name').limit(3)));
    expect(only?.because).toMatch(/range or an inequality needs a composite index/);
    expect(only?.because).toMatch(/equality, then sort, then range/);
  });

  it('several range fields carry the note that their best order is not known from the query', () => {
    const [only] = composites(explain(q => q.where('n', '>', 1).where('m', '<', 9)));
    expect(only?.because).toMatch(/how selective they are/);
  });

  it('names the collection by its last segment, however deep it sits', () => {
    const deep = schema({ stores: (id: string) => ({ orders: (oid: string) => leaf<Item>() }) }, firestoreBackend(new MemoryFirestoreTransport()));
    const [only] = composites(deep.stores('s1').orders.where('tag', '==', 'a').orderBy('n').limit(3).explain());
    expect(only?.index.collectionGroup).toBe('orders');
    expect(only?.index.queryScope).toBe('COLLECTION');
  });
});

describe('Firestore: an order alone is not sent, so it needs no index', () => {
  it('an equality and an order with no limit or cursor: the rows are ordered here', () => {
    const e = explain(q => q.where('tag', '==', 'a').orderBy('n'));
    expect(e.server).toEqual(['the collection "items"', 'tag == "a"']);
    expect(e.local).toEqual(['order by n ascending']);
    expect(e.indexes).toEqual([]);
  });

  it('with a limit the order travels, and so does the need for an index', () => {
    const e = explain(q => q.where('tag', '==', 'a').orderBy('n').limit(3));
    expect(e.server).toContain('order by n ascending');
    expect(composites(e)).toHaveLength(1);
  });
});

describe('Firestore: an array-contains beside other conditions is advised a composite index', () => {
  it('an equality and an array-contains', () => {
    const [only] = composites(explain(q => q.where('tag', '==', 'a').whereIncludes('tags', 'x')));
    expect(only?.need).toBe('recommended');
    expect(only?.index.fields).toEqual([asc('tag'), contains('tags')]);
    expect(only?.because).toMatch(/array-contains beside other conditions/);
  });

  it('an array-contains and an order is required, since it sorts by another field', () => {
    const [only] = composites(explain(q => q.whereIncludes('tags', 'x').orderBy('n', 'desc').limit(3)));
    expect(only?.need).toBe('required');
    expect(only?.index.fields).toEqual([contains('tags'), desc('n')]);
  });
});

describe('Firestore: the key is always last, and sorting it the other way needs its own index', () => {
  it('an equality and the key descending', () => {
    const [only] = composites(explain(q => q.where('tag', '==', 'a').orderBy('$key', 'desc').limit(3)));
    expect(only?.need).toBe('required');
    expect(only?.index.fields).toEqual([asc('tag'), desc('__name__')]);
    expect(only?.because).toMatch(/other direction/);
  });

  it('an order that ends descending takes the key descending for free', () => {
    const e = explain(q => q.where('tag', '==', 'a').orderBy('n', 'desc').orderBy('$key', 'desc').limit(3));
    expect(composites(e)[0]?.index.fields).toEqual([asc('tag'), desc('n')]);
  });

  it('a bare descending order by the key is not something the documentation settles, so nothing is claimed', () => {
    const e = explain(q => q.orderBy('$key', 'desc').limit(3));
    expect(e.indexes).toHaveLength(1);
    expect(e.indexes[0]?.kind).toBe('unknown');
  });

  it('a range on a field beside only an equality on the key is not supported', () => {
    const e = explain(q => q.where('n', '>=', 1).where('$key', '==', 'i1'));
    expect(e.indexes).toEqual([{ kind: 'unsupported', because: expect.stringMatching(/only equality conditions on the key/) }]);
  });

  it('but a range on the key itself is fine', () => {
    expect(explain(q => q.where('$key', '>', 'i3').orderBy('$key').limit(2)).indexes).toEqual([]);
  });
});

describe('Firestore: a collection group needs an index with collection group scope', () => {
  const groupDb = schema({ lines: collectionGroup<Line>() }, firestoreBackend(new MemoryFirestoreTransport()));

  it('a filter on one field', () => {
    const e = groupDb.lines.where('sku', '==', 'a').explain();
    expect(e.indexes).toEqual([{ kind: 'collection-group', fields: ['sku'], because: expect.stringMatching(/collection group scope/) }]);
    expect(e.server[0]).toBe('every collection called "lines"');
  });

  it('a compound query is a composite index with that scope', () => {
    const [only] = composites(groupDb.lines.where('sku', '==', 'a').orderBy('qty').limit(3).explain());
    expect(only?.index).toEqual({ collectionGroup: 'lines', queryScope: 'COLLECTION_GROUP', fields: [asc('sku'), asc('qty')] });
  });

  it('every line with no condition needs nothing', () => {
    expect(groupDb.lines.explain().indexes).toEqual([]);
  });
});

describe('Firestore: what the documentation read does not say, nothing is claimed about', () => {
  it('an or', () => {
    const e = explain(q => q.whereAny((a: any) => a.where('tag', '==', 'a'), (b: any) => b.where('n', '>', 3)));
    expect(e.indexes).toEqual([{ kind: 'unknown', because: expect.stringMatching(/how the alternatives of an or are indexed/) }]);
  });

  it('more than ten range fields is not supported', () => {
    const fields = Array.from({ length: 11 }, (_, index) => `f${index}`);
    const e = explain(q => fields.reduce((query: any, field) => query.where(field, '>', 0), q));
    expect(e.indexes[0]).toEqual({ kind: 'unsupported', because: expect.stringMatching(/10/) });
  });
});

describe('where each part of a query runs', () => {
  it('says what goes to the server and what is finished here', () => {
    const e = explain(q => q.where('tag', '==', 'a').where((row: Item) => row.n > 1).orderBy('name').limit(5).offset(2));
    expect(e.backend).toBe('firestore');
    expect(e.server).toEqual(['the collection "items"', 'tag == "a"']);
    expect(e.local).toEqual(['a where(item => boolean) check', 'order by name ascending', 'limit 5', 'skip the first 2 rows']);
  });

  it('sends an order and a limit together when the server can cut, and then finishes nothing here', () => {
    const e = explain(q => q.where('tag', '==', 'a').orderBy('n', 'desc').limit(5));
    expect(e.server).toEqual(['the collection "items"', 'tag == "a"', 'order by n descending', 'limit 5']);
    expect(e.local).toEqual([]);
  });

  it('describes an in that is split into several queries', () => {
    const values = Array.from({ length: 70 }, (_, index) => `v${index}`);
    const e = explain(q => q.whereIn('name', values));
    expect(e.server[1]).toMatch(/sent as 3 queries of up to 30 values each/);
  });

  it('a query that can match nothing sends nothing', () => {
    const e = explain(q => q.whereIn('name', []));
    expect(e.server).toEqual(['nothing is sent: no row can match']);
    expect(e.indexes).toEqual([]);
  });

  it('says whether the same query can be live, and why not', () => {
    expect(explain(q => q.where('tag', '==', 'a').select('name')).live).toEqual({ ok: true });
    expect(explain(q => q.offset(3)).live).toMatchObject({ ok: false, reason: expect.stringMatching(/offset or distinct/) });
    expect(explain(q => q.select((row: Item) => row.n)).live).toMatchObject({ ok: false, reason: expect.stringMatching(/computed or aliased select/) });
    expect(explain(q => q.where((row: Item) => row.n > 1).limit(3)).live).toMatchObject({ ok: false, reason: expect.stringMatching(/every filter to run on Firestore/) });
  });

  it('explains without asking the database anything', async () => {
    const { db: local, transport } = firestore();
    local.items.where('tag', '==', 'a').orderBy('n').explain();
    expect(transport.queryLog).toEqual([]);
    expect(transport.listenerCount).toBe(0);
  });

  it('needs a backend that can explain', () => {
    const bare = schema({ items: (id: string) => leaf<Item>() });
    expect(() => bare.items.explain()).toThrow(/no backend/);
  });
});

describe('what explain says is what a read sends', () => {
  const cases: Array<[string, (q: any) => any]> = [
    ['an equality', q => q.where('tag', '==', 'a')],
    ['an equality, an order and a limit', q => q.where('tag', '==', 'a').orderBy('n', 'desc').limit(5)],
    ['a range with a check run here', q => q.where('n', '>=', 2).where((row: Item) => row.m > 1).orderBy('n').limit(3)],
    ['an order by the key', q => q.orderBy('$key').startAfter('i03').limit(2)],
    ['a range beside an order by the key', q => q.where('n', '>=', 1).orderBy('$key').limit(3)],
    ['an in and an array-contains', q => q.whereIn('tag', ['a', 'b']).whereIncludes('tags', 'x')],
    ['limitToLast', q => q.orderBy('n').limitToLast(3)],
  ];
  it.each(cases)('%s', async (_name, build) => {
    const { db: local, transport } = firestore();
    const query = build(local.items.withKey('$key'));
    const explained = query.explain() as QueryExplanation;
    await query.get();
    expect(explained.sent).toEqual(transport.queryLog[0]?.query);
  });
});

describe('firestoreIndexes collects the composite indexes of several queries', () => {
  const queries = [
    explain(q => q.where('tag', '==', 'a').orderBy('n').limit(3)),
    explain(q => q.where('tag', '==', 'b').orderBy('n').limit(3)), // the same index
    explain(q => q.orderBy('n').orderBy('m', 'desc').limit(3)),
    explain(q => q.where('tag', '==', 'a').whereIncludes('tags', 'x')), // only advised
    explain(q => q.where('tag', '==', 'a')), // needs none
  ];

  it('lists each required index once, in the shape the Firebase CLI reads', () => {
    expect(firestoreIndexes(queries)).toEqual({
      indexes: [
        { collectionGroup: 'items', queryScope: 'COLLECTION', fields: [asc('tag'), asc('n')] },
        { collectionGroup: 'items', queryScope: 'COLLECTION', fields: [asc('n'), desc('m')] },
      ],
    });
  });

  it('adds the advised ones when asked', () => {
    expect(firestoreIndexes(queries, { recommended: true }).indexes).toHaveLength(3);
  });

  it('hands out copies, so changing the file does not change an explanation', () => {
    const file = firestoreIndexes(queries);
    (file.indexes[0]!.fields as unknown[]).length = 0;
    expect(composites(queries[0]!)[0]?.index.fields).toHaveLength(2);
  });

  it('is empty for queries that need nothing', () => {
    expect(firestoreIndexes([explain(q => q.where('tag', '==', 'a'))])).toEqual({ indexes: [] });
  });
});

describe('Realtime Database: a query on a child is advised an index on it', () => {
  interface Customer {
    name: string;
    age: number;
    tier: string;
    contact: { city: string };
  }
  const rt = schema({ customers: (id: string) => leaf<Customer>() }, realtimeBackend(new MemoryRealtimeTransport()));

  it('an equality on a child', () => {
    const e = rt.customers.where('tier', '==', 'gold').explain();
    expect(e.backend).toBe('realtime');
    expect(e.server).toEqual(['the list "customers"', 'order by the child "tier"', 'equal to "gold"']);
    expect(e.indexes).toEqual([{ kind: 'child', need: 'recommended', path: 'customers', child: 'tier', because: expect.stringMatching(/\.indexOn/) }]);
    expect(e.live).toEqual({ ok: true });
  });

  it('a nested child is written with slashes, as the rules write it', () => {
    const e = rt.customers.where('contact.city', '==', 'Lyon').explain();
    expect(e.indexes[0]).toMatchObject({ kind: 'child', child: 'contact/city' });
  });

  it('a range, and what stays local', () => {
    const e = rt.customers.where('age', '>=', 18).where('tier', '==', 'gold').explain();
    expect(e.server).toContain('order by the child "tier"');
    expect(e.local).toEqual(['age >= 18']);
  });

  it('an order with a limit is sent, and needs the index', () => {
    const e = rt.customers.orderBy('age').limit(3).explain();
    expect(e.server).toEqual(['the list "customers"', 'order by the child "age"', 'the first 3']);
    expect(e.local).toEqual([]);
    expect(e.indexes[0]).toMatchObject({ child: 'age' });
  });

  it('a list with no conditions needs nothing', () => {
    expect(rt.customers.explain().indexes).toEqual([]);
  });

  it('a live list that Realtime Database cannot follow says why', () => {
    const e = rt.customers.where('tier', '==', 'gold').orderBy('age').startAt(3).explain();
    expect(e.live).toMatchObject({ ok: false, reason: expect.stringMatching(/cursor/) });
  });

  it('says what is sent, for someone checking it against a read', async () => {
    const transport = new MemoryRealtimeTransport({ customers: { 1: { tier: 'gold' } } });
    const db = schema({ customers: (id: string) => leaf<Customer>() }, realtimeBackend(transport));
    const query = db.customers.where('tier', '==', 'gold').limit(2);
    const explained = query.explain();
    await query.get();
    expect(explained.sent).toEqual(transport.readLog[0]?.query);
  });
});
