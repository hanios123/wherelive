import { describe, expect, it } from 'vitest';
import { ListQuery, firestoreBackend, leaf, schema } from '../src';
import { MemoryFirestoreTransport } from '../src/testing';

/** What a Firestore `Timestamp` looks like to the library: an instant that says so, and knows how to compare itself. */
class Stamp {
  constructor(readonly ms: number) {}
  toMillis() {
    return this.ms;
  }
  isEqual(other: unknown) {
    return other instanceof Stamp && other.ms === this.ms;
  }
}

const day = (n: number) => new Date(Date.UTC(2026, 0, n));
interface Event {
  id: string;
  at: Date | Stamp;
  tags: Array<Date | string>;
}

describe('dates and Timestamps in local filters', () => {
  const events: Event[] = [
    { id: 'a', at: day(1), tags: [day(1), 'x'] },
    { id: 'b', at: new Stamp(day(2).getTime()), tags: [] },
    { id: 'c', at: day(3), tags: ['y'] },
    { id: 'd', at: new Stamp(day(4).getTime()), tags: [day(4)] },
  ];
  const ids = (query: ListQuery<Event, Event>) => query.select('id').toList();

  it('== finds the same instant, whether the row or the value is a Date or a Timestamp', () => {
    expect(ids(ListQuery.from(events).where('at', '==', day(2)))).toEqual(['b']);
    expect(ids(ListQuery.from(events).where('at', '==', new Stamp(day(3).getTime())))).toEqual(['c']);
    expect(ids(ListQuery.from(events).where('at', '==', new Date(day(1).getTime())))).toEqual(['a']);
  });

  it('!= is the opposite, and a range compares by time across both kinds', () => {
    expect(ids(ListQuery.from(events).where('at', '!=', day(2)))).toEqual(['a', 'c', 'd']);
    expect(ids(ListQuery.from(events).where('at', '>=', day(2)).where('at', '<', day(4)))).toEqual(['b', 'c']);
    expect(ids(ListQuery.from(events).where('at', '>', new Stamp(day(3).getTime())))).toEqual(['d']);
    expect(ids(ListQuery.from(events).where('at', '<=', day(1)))).toEqual(['a']);
  });

  it('IN and NOT IN compare by instant, and array-contains finds a date inside an array', () => {
    expect(ids(ListQuery.from(events).whereIn('at', [day(1), new Stamp(day(4).getTime())]))).toEqual(['a', 'd']);
    expect(ids(ListQuery.from(events).whereNotIn('at', [day(1), day(2)]))).toEqual(['c', 'd']);
    expect(ids(ListQuery.from(events).whereIncludes('tags', day(4)))).toEqual(['d']);
    expect(ids(ListQuery.from(events).whereIncludes('tags', 'x'))).toEqual(['a']);
  });

  it('orders and de-duplicates by instant', () => {
    expect(ids(ListQuery.from(events).orderBy('at', 'desc'))).toEqual(['d', 'c', 'b', 'a']);
    const twins = [{ at: day(5) }, { at: new Stamp(day(5).getTime()) }, { at: day(6) }];
    expect(ListQuery.from(twins).select('at').distinct().count()).toBe(2);
  });

  it('a range only compares two values of one kind: a number is not a date, a missing value is nothing', () => {
    const mixed = [{ v: 5 }, { v: '5' }, { v: undefined }, { v: null }, { v: day(1) }] as Array<{ v: unknown }>;
    expect(ListQuery.from(mixed).where('v', '>=', 5 as never).select('v').toList()).toEqual([5]);
    expect(ListQuery.from(mixed).where('v', '>=', '4' as never).select('v').toList()).toEqual(['5']);
    expect(ListQuery.from(mixed).where('v', '>', day(0) as never).select('v').toList()).toEqual([day(1)]);
  });

  it('== on arrays and objects compares content, as Firestore does', () => {
    const rows = [{ v: [1, 2] }, { v: [2, 1] }, { v: { a: 1 } }] as Array<{ v: unknown }>;
    expect(ListQuery.from(rows).where('v', '==', [1, 2] as never).count()).toBe(1);
    expect(ListQuery.from(rows).where('v', '==', { a: 1 } as never).count()).toBe(1);
  });
});

describe('reading documents whose fields are Timestamps', () => {
  interface Doc {
    name: string;
    at: Stamp | Date;
  }
  const definition = { docs: (id: string) => leaf<Doc>() };
  const rows: Doc[] = Array.from({ length: 12 }, (_, i) => ({ name: `d${String(i).padStart(2, '0')}`, at: i % 2 ? new Stamp(day(i + 1).getTime()) : day(i + 1) }));

  function seeded() {
    const transport = new MemoryFirestoreTransport();
    rows.forEach((row, i) => transport.set(`docs/r${String(i).padStart(2, '0')}`, row as never));
    return { transport, db: schema(definition, firestoreBackend(transport)) };
  }

  const plans: Array<[string, (query: any) => any]> = [
    ['a range on a Timestamp field', q => q.where('at', '>=', day(4)).where('at', '<', day(9)).orderBy('at')],
    ['an equality on an instant', q => q.where('at', '==', day(5))],
    ['IN on instants', q => q.whereIn('at', [day(2), day(3), day(10)]).orderBy('at')],
    ['order + limit on a Timestamp field', q => q.orderBy('at', 'desc').limit(4)],
    ['NOT IN on instants', q => q.whereNotIn('at', [day(1), day(2)]).orderBy('at').limit(3)],
  ];

  it.each(plans)('Firestore returns the rows an array does: %s', async (_name, plan) => {
    const { db } = seeded();
    const fromDatabase = (await plan(db.docs).get()) as Doc[];
    const fromArray = plan(ListQuery.from(rows)).toList() as Doc[];
    expect(fromDatabase.map(row => row.name)).toEqual(fromArray.map(row => row.name));
    expect(fromDatabase.length).toBeGreaterThan(0);
  });

  it('the stored Timestamps come back as the same objects, not as text', async () => {
    const { db } = seeded();
    const [row] = (await db.docs.where('name', '==', 'd01').get()) as Doc[];
    expect(row!.at).toBeInstanceOf(Stamp);
    const [dated] = (await db.docs.where('name', '==', 'd00').get()) as Doc[];
    expect(dated!.at).toBeInstanceOf(Date);
  });
});
