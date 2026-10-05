import { describe, expect, it } from 'vitest';
import { ListQuery, UnsupportedQueryError, leaf, realtimeBackend, schema } from '../src';
import { MemoryRealtimeTransport } from '../src/testing';

interface Item {
  name: string;
  group: number;
  score?: unknown;
}

/** One ordered field holding every kind of value Realtime Database keeps, so a wrong assumption about its order shows up. */
const items: Array<{ id: string; data: Item }> = [
  ...Array.from({ length: 20 }, (_, i) => ({ id: `s${String(i).padStart(2, '0')}`, data: { name: `n${String((i * 7) % 20).padStart(2, '0')}`, group: i % 3, score: (i * 7) % 13 } })),
  { id: 's20', data: { name: 'n20', group: 0, score: 'high' } },
  { id: 's21', data: { name: 'n21', group: 1, score: true } },
  { id: 's22', data: { name: 'n22', group: 2, score: false } },
  { id: 's23', data: { name: 'n23', group: 0 } }, // no score at all
  { id: 's24', data: { name: 'n24', group: 1, score: { deep: 1 } } },
  { id: 's25', data: { name: 'n25', group: 2, score: 100 } },
  { id: 's26', data: { name: 'n26', group: 0, score: 'a' } },
];
const every = items.map(item => item.data);
const definition = { items: (id: string) => leaf<Item>() };

function database(rows = items) {
  const transport = new MemoryRealtimeTransport({ items: Object.fromEntries(rows.map(row => [row.id, row.data])) });
  return { transport, db: schema(definition, realtimeBackend(transport)) };
}
const sent = async (build: (q: any) => any) => {
  const { db, transport } = database();
  await build(db.items).get();
  return transport.readLog.map(entry => entry.query);
};

/** Each of these must give the rows an array does, however much or little the server was asked to do. */
const plans: Array<[string, (query: any) => any]> = [
  ['an equality', q => q.where('group', '==', 1).orderBy('name')],
  ['a range from below (strings and booleans sort above numbers, so the server sends extras)', q => q.where('score', '>=', 5)],
  ['a range from above (missing, false and true sort below numbers)', q => q.where('score', '<', 4)],
  ['both ends of a range', q => q.where('score', '>', 3).where('score', '<=', 9).orderBy('name')],
  ['a range on a string', q => q.where('score', '>=', 'b')],
  ['order ascending + limit, over every kind of value', q => q.orderBy('score').limit(6)],
  ['order ascending + offset + limit', q => q.orderBy('score').offset(3).limit(5)],
  ['order ascending + limitToLast', q => q.orderBy('score').limitToLast(5)],
  ['order descending + limit', q => q.orderBy('score', 'desc').limit(6)],
  ['order descending + limitToLast', q => q.orderBy('score', 'desc').limitToLast(4)],
  ['an equality + limit', q => q.where('group', '==', 2).limit(3)],
  ['an equality ordered by the same child + limit', q => q.where('group', '==', 2).orderBy('group').limit(3)],
  ['an equality ordered by another child + limit', q => q.where('group', '==', 2).orderBy('score').limit(3)],
  ['a limit alone', q => q.limit(7)],
  ['a limitToLast alone', q => q.limitToLast(7)],
  ['a limit beside a local rule', q => q.where((row: Item) => row.group === 1).orderBy('score').limit(4)],
  ['two orders + limit', q => q.orderBy('group').orderBy('name').limit(5)],
  ['a range + limit (the range is not exact, so the limit stays here)', q => q.where('score', '>=', 5).orderBy('score').limit(4)],
  ['whereIn, or and a range together', q => q.whereIn('group', [0, 2]).whereAny((a: any) => a.where('score', '>', 10), (b: any) => b.where('name', '==', 'n03')).orderBy('name')],
];

describe('every Realtime Database query shape gives the rows an array does', () => {
  it.each(plans)('%s', async (_name, plan) => {
    const { db } = database();
    const fromDatabase = await plan(db.items).get();
    const fromArray = plan(ListQuery.from(every)).toList();
    expect(fromDatabase).toEqual(fromArray);
    expect(fromArray.length).toBeGreaterThan(0);
  });
});

describe('what a read asks Realtime Database for', () => {
  it('an equality is one orderByChild + equalTo, on a nested child too', async () => {
    expect(await sent(q => q.where('group', '==', 1))).toEqual([{ order: { child: 'group' }, equalTo: 1 }]);
    const transport = new MemoryRealtimeTransport({ people: { a: { contact: { city: 'Lyon' } }, b: { contact: { city: 'Nice' } } } });
    const people = schema({ people: (id: string) => leaf<{ contact: { city: string } }>() }, realtimeBackend(transport));
    expect(await people.people.where('contact.city', '==', 'Lyon').get()).toEqual([{ contact: { city: 'Lyon' } }]);
    expect(transport.readLog[0]!.query).toEqual({ order: { child: 'contact.city' }, equalTo: 'Lyon' });
  });

  it('a range is startAt and endAt on one child, and a strict bound is startAfter / endBefore', async () => {
    const [query] = await sent(q => q.where('score', '>', 3).where('score', '<=', 9));
    expect(query).toEqual({ order: { child: 'score' }, start: { value: 3, inclusive: false }, end: { value: 9, inclusive: true } });
  });

  it('order ascending with a limit is orderByChild + limitToFirst, with the offset added', async () => {
    expect(await sent(q => q.orderBy('score').limit(6))).toEqual([{ order: { child: 'score' }, limit: { first: 6 } }]);
    expect(await sent(q => q.orderBy('score').offset(3).limit(5))).toEqual([{ order: { child: 'score' }, limit: { first: 8 } }]);
  });

  it('order ascending with limitToLast is limitToLast, and a limit alone is by key', async () => {
    expect(await sent(q => q.orderBy('score').limitToLast(5))).toEqual([{ order: { child: 'score' }, limit: { last: 5 } }]);
    expect(await sent(q => q.limit(7))).toEqual([{ limit: { first: 7 } }]);
    expect(await sent(q => q.limitToLast(7))).toEqual([{ limit: { last: 7 } }]);
  });

  it('an equality with a limit keeps both', async () => {
    expect(await sent(q => q.where('group', '==', 2).limit(3))).toEqual([{ order: { child: 'group' }, equalTo: 2, limit: { first: 3 } }]);
  });

  it('a key equality is orderByKey + equalTo', async () => {
    const { db, transport } = database();
    const rows = await db.items.withKey('$key').where('$key', '==', 's05').get();
    expect(rows.map(row => row.$key)).toEqual(['s05']);
    expect(transport.readLog[0]!.query).toEqual({ order: { key: true }, equalTo: 's05' });
  });

  it('what would change the answer stays local: descending, a range with a limit, another order, a local rule, distinct', async () => {
    expect(await sent(q => q.orderBy('score', 'desc').limit(6))).toEqual([undefined]);
    expect(await sent(q => q.orderBy('score', 'desc').limitToLast(4))).toEqual([undefined]);
    expect((await sent(q => q.where('score', '>=', 5).orderBy('score').limit(4)))[0]!.limit).toBeUndefined();
    expect((await sent(q => q.where('group', '==', 2).orderBy('score').limit(3)))[0]!.limit).toBeUndefined();
    expect((await sent(q => q.where((row: Item) => row.group === 1).orderBy('score').limit(4)))[0]).toBeUndefined();
    expect((await sent(q => q.select('group').distinct().limit(2)))[0]).toBeUndefined();
    expect((await sent(q => q.orderBy('group').orderBy('name').limit(5)))[0]).toBeUndefined();
  });

  it('a cursor, whereIn and or are all finished here', async () => {
    expect((await sent(q => q.orderBy('score').startAfter(3)))[0]).toBeUndefined();
    expect((await sent(q => q.whereIn('group', [0, 2])))[0]).toBeUndefined();
  });
});

describe('Realtime Database orders keys its own way', () => {
  const numbered = ['1', '2', '10', '9', '100', 'a', 'B', 'a1'].map(id => ({ id, data: { name: id, group: 0 } as Item }));

  it('integer-like keys come first, in numeric order, then the rest as text; a read with no order keeps that', async () => {
    const { db } = database(numbered);
    const rows = await db.items.withKey('$key').select('$key').get();
    expect(rows).toEqual(['1', '2', '9', '10', '100', 'B', 'a', 'a1']);
  });

  it('an order by key is done here, because JavaScript would put "10" before "9"', async () => {
    const { db, transport } = database(numbered);
    const rows = await db.items.withKey('$key').orderBy('$key').limit(4).select('$key').get();
    expect(rows).toEqual(ListQuery.from(numbered).select(row => row.id).toList().sort().slice(0, 4));
    expect(transport.readLog[0]!.query).toBeUndefined();
  });
});

describe('a live list with an order and a limit', () => {
  it('follows the first rows, and a row that sorts in pushes the last one out', () => {
    const { db, transport } = database(items.slice(0, 8));
    const events: any[] = [];
    const stop = db.items.orderBy('score').limit(3).select('score').listen(change => events.push(change));
    const members = () => new Set(events.filter(event => !event.removed).map(event => event.key));
    expect(members().size).toBe(3);
    expect(transport.listenerCount).toBeGreaterThan(0);
    events.length = 0;
    transport.set('items/new', { name: 'zz', group: 0, score: -5 });
    expect(events.filter(event => event.removed)).toHaveLength(1);
    expect(events.find(event => event.key === 'new')).toEqual({ key: 'new', attribute: 'score', value: -5 });
    stop();
    expect(transport.listenerCount).toBe(0);
  });

  it('follows the last rows with limitToLast', () => {
    const { db } = database(items.slice(0, 8));
    const keys = new Set<string>();
    db.items.orderBy('score').limitToLast(2).select('score').listen(change => keys.add(change.key));
    expect(keys.size).toBe(2);
  });

  it('an equality with a limit, and a limit alone, are followed on the server too', () => {
    const { db, transport } = database();
    const keys = new Set<string>();
    db.items.where('group', '==', 2).limit(2).select('name').listen(change => keys.add(change.key));
    expect(keys.size).toBe(2);
    expect(transport.readLog).toEqual([]); // a live list is not a read
  });

  it('refuses what it could not follow exactly, before anything connects', () => {
    const { db, transport } = database();
    const refused = (build: (q: any) => any) => {
      expect(() => build(db.items).select('name').listen(() => {})).toThrow(UnsupportedQueryError);
      expect(transport.listenerCount).toBe(0);
    };
    refused(q => q.orderBy('score', 'desc').limit(3));
    refused(q => q.where('score', '>=', 5).limit(3));
    refused(q => q.where('score', '>=', 5));
    refused(q => q.startAfter(1).orderBy('score'));
    refused(q => q.whereIn('group', [1]));
  });

  it('an order without a limit is ignored, as for Firestore', () => {
    const { db, transport } = database();
    const keys = new Set<string>();
    db.items.orderBy('score').select('name').listen(change => keys.add(change.key));
    expect(keys.size).toBe(items.length);
    expect(transport.listenerCount).toBeGreaterThan(0);
  });
});
