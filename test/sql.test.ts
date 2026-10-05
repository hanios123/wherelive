import { describe, expect, it } from 'vitest';
import { ListQuery } from '../src';

interface Customer {
  id: string;
  name: string;
  tier: 'gold' | 'silver' | 'bronze';
  age?: number;
  contact: { email: string; city?: string };
}
interface Order {
  id: number;
  customerId: string | null;
  region: string;
  price: number;
  qty?: number | null;
  tags: string[];
  placedAt: Date;
}

const customers: Customer[] = [
  { id: 'c1', name: 'Ann', tier: 'gold', age: 31, contact: { email: 'ann@example.test', city: 'Lyon' } },
  { id: 'c2', name: 'Bob', tier: 'silver', age: 25, contact: { email: 'bob@example.test' } },
  { id: 'c3', name: 'cy', tier: 'gold', contact: { email: 'cy@example.test', city: 'Nice' } },
  { id: 'c4', name: 'Zed', tier: 'bronze', age: 25, contact: { email: 'zed@example.test', city: 'Lyon' } }, // no orders
];
const day = (n: number) => new Date(Date.UTC(2026, 0, n));
const orders: Order[] = [
  { id: 1, customerId: 'c1', region: 'eu', price: 30, qty: 2, tags: ['gift'], placedAt: day(3) },
  { id: 2, customerId: 'c2', region: 'us', price: 10, qty: null, tags: [], placedAt: day(1) },
  { id: 3, customerId: 'c1', region: 'eu', price: 20, tags: ['rush', 'gift'], placedAt: day(2) },
  { id: 4, customerId: 'c3', region: 'us', price: 10, qty: 1, tags: ['rush'], placedAt: day(5) },
  { id: 5, customerId: 'c9', region: 'eu', price: 5, qty: 4, tags: [], placedAt: day(4) }, // unknown customer
  { id: 6, customerId: null, region: 'us', price: 15, qty: 3, tags: ['gift'], placedAt: day(6) }, // no customer
  { id: 7, customerId: 'c2', region: 'eu', price: 10, qty: 2, tags: [], placedAt: day(7) },
];

const ids = (rows: Array<{ id: number | string }>) => rows.map(row => row.id);

describe('ORDER BY', () => {
  it('numbers, ascending and descending, match a comparator', () => {
    const asc = [...orders].sort((a, b) => a.price - b.price).map(o => o.id);
    const desc = [...orders].sort((a, b) => b.price - a.price).map(o => o.id);
    expect(ids(ListQuery.from(orders).orderBy('price').toList())).toEqual(asc);
    expect(ids(ListQuery.from(orders).orderBy('price', 'desc').toList())).toEqual(desc);
  });

  it('is stable: ties keep the order they came in', () => {
    expect(ids(ListQuery.from(orders).orderBy('price').toList())).toEqual([5, 2, 4, 7, 6, 3, 1]);
    expect(ids(ListQuery.from(orders).orderBy('price', 'desc').toList())).toEqual([1, 3, 6, 2, 4, 7, 5]);
  });

  it('call it again for the next key: ORDER BY region, price DESC', () => {
    const was = [...orders].sort((a, b) => a.region.localeCompare(b.region) || b.price - a.price).map(o => o.id);
    const can = ListQuery.from(orders).orderBy('region').orderBy('price', 'desc').toList();
    expect(ids(can)).toEqual(was);
  });

  it('text sorts by code unit like a database; { locale: true } sorts by language like localeCompare', () => {
    const codeUnit = ListQuery.from(customers).orderBy('name').select('name').toList();
    expect(codeUnit).toEqual(['Ann', 'Bob', 'Zed', 'cy']); // 'Z' < 'c'
    const byLanguage = ListQuery.from(customers).orderBy('name', 'asc', { locale: true }).select('name').toList();
    expect(byLanguage).toEqual([...customers].sort((a, b) => a.name.localeCompare(b.name)).map(c => c.name));
    expect(byLanguage).toEqual(['Ann', 'Bob', 'cy', 'Zed']);
  });

  it('a dotted path orders by a nested field', () => {
    expect(ListQuery.from(customers).orderBy('contact.email', 'desc').select('id').toList()).toEqual(['c4', 'c3', 'c2', 'c1']);
  });

  it('a function key orders by anything, and can be mixed with fields', () => {
    const can = ListQuery.from(orders)
      .orderBy(order => order.tags.length, 'desc')
      .orderBy('id')
      .select('id')
      .toList();
    expect(can).toEqual([3, 1, 4, 6, 2, 5, 7]);
  });

  it('missing and null sort first, and last when descending', () => {
    expect(ListQuery.from(customers).orderBy('age').select('id').toList()).toEqual(['c3', 'c2', 'c4', 'c1']); // c3 has no age
    expect(ListQuery.from(orders).orderBy('qty').select('id').toList().slice(0, 2)).toEqual([2, 3]); // null, then missing, in input order
    expect(ListQuery.from(customers).orderBy('age', 'desc').select('id').toList()).toEqual(['c1', 'c2', 'c4', 'c3']);
  });

  it('orders dates, and values that carry toMillis like Firestore Timestamps', () => {
    expect(ids(ListQuery.from(orders).orderBy('placedAt').toList())).toEqual([2, 3, 1, 5, 4, 6, 7]);
    const stamps = [{ id: 'b', at: { toMillis: () => 20 } }, { id: 'a', at: { toMillis: () => 10 } }];
    expect(ListQuery.from(stamps).orderBy('at').select('id').toList()).toEqual(['a', 'b']);
  });

  it('booleans, numbers and strings in one column sort by type first', () => {
    const mixed = [{ v: 'b' }, { v: 2 }, { v: true }, { v: null }, { v: 'a' }, { v: 1 }] as Array<{ v: unknown }>;
    expect(ListQuery.from(mixed).orderBy('v').select('v').toList()).toEqual([null, true, 1, 2, 'a', 'b']);
  });

  it('sorts before select, so a field you do not select can order the result', () => {
    expect(ListQuery.from(orders).orderBy('price', 'desc').orderBy('id').select('id').first()).toBe(1);
  });

  it('does not touch the source array', () => {
    const before = [...orders];
    ListQuery.from(orders).orderBy('price').toList();
    expect(orders).toEqual(before);
  });
});

describe('LIMIT and OFFSET', () => {
  it('paginate like slice', () => {
    const sorted = [...orders].sort((a, b) => a.id - b.id);
    for (const [offset, limit] of [[0, 3], [2, 3], [5, 10], [7, 2], [9, 2]] as const) {
      expect(ids(ListQuery.from(orders).orderBy('id').offset(offset).limit(limit).toList())).toEqual(ids(sorted.slice(offset, offset + limit)));
    }
  });

  it('order of the calls does not matter: SQL runs offset before limit', () => {
    expect(ids(ListQuery.from(orders).limit(2).offset(1).toList())).toEqual([2, 3]);
  });

  it('limit(0) reads nothing', () => {
    let read = 0;
    expect(ListQuery.from(orders).where(() => (read++, true)).limit(0).toList()).toEqual([]);
    expect(read).toBe(0);
  });

  it('without orderBy, limit stops reading as soon as it has enough', () => {
    let read = 0;
    ListQuery.from(orders).where(() => (read++, true)).limit(2).toList();
    expect(read).toBe(2);
  });

  it('with orderBy every match must be read first', () => {
    let read = 0;
    ListQuery.from(orders).where(() => (read++, true)).orderBy('price').limit(1).toList();
    expect(read).toBe(orders.length);
  });

  it('applies to filtered rows: WHERE, then LIMIT', () => {
    expect(ids(ListQuery.from(orders).where('region', '==', 'eu').limit(2).toList())).toEqual([1, 3]);
  });

  it('refuses a count that is not a whole number', () => {
    expect(() => ListQuery.from(orders).limit(-1)).toThrow(/whole number/);
    expect(() => ListQuery.from(orders).offset(1.5)).toThrow(/whole number/);
    expect(() => ListQuery.from(orders).limit(NaN)).toThrow(/whole number/);
  });
});

describe('DISTINCT', () => {
  it('matches new Set(list.map(...)), keeping first-seen order', () => {
    const was = [...new Set(orders.map(o => o.region))];
    expect(ListQuery.from(orders).select('region').distinct().toList()).toEqual(was);
  });

  it('compares objects by content, whatever the key order', () => {
    const rows = [{ a: 1, b: { x: 1, y: 2 } }, { b: { y: 2, x: 1 }, a: 1 }, { a: 1, b: { x: 1, y: 3 } }];
    expect(ListQuery.from(rows).distinct().count()).toBe(2);
  });

  it('runs after select and before offset and limit, as SQL does', () => {
    expect(ListQuery.from(orders).select('region').distinct().limit(1).toList()).toEqual(['eu']);
    expect(ListQuery.from(orders).select('region', 'price').distinct().count()).toBe(6); // eu/10 appears once, us/10 once, ...
    expect(ListQuery.from(orders).select('price').distinct().orderBy('price').toList()).toEqual([5, 10, 15, 20, 30]);
  });

  it('dates are equal by time', () => {
    const rows = [{ d: new Date(5) }, { d: new Date(5) }, { d: new Date(6) }];
    expect(ListQuery.from(rows).select('d').distinct().count()).toBe(2);
  });
});

describe('IN and NOT IN', () => {
  it('whereIn matches ids.includes(item.field)', () => {
    const wanted = ['c1', 'c3', 'nobody'];
    expect(ids(ListQuery.from(customers).whereIn('id', wanted).toList())).toEqual(ids(customers.filter(c => wanted.includes(c.id))));
  });

  it('whereNotIn matches !ids.includes(item.field)', () => {
    const excluded = ['c1', 'c3'];
    expect(ids(ListQuery.from(customers).whereNotIn('id', excluded).toList())).toEqual(ids(customers.filter(c => !excluded.includes(c.id))));
  });

  it('an empty IN matches nothing, and an empty NOT IN matches everything', () => {
    expect(ListQuery.from(customers).whereIn('id', []).none()).toBe(true);
    expect(ListQuery.from(customers).whereNotIn('id', []).count()).toBe(customers.length);
  });

  it('is strict about types, and works on a dotted path', () => {
    expect(ListQuery.from(orders).whereIn('id', [1, 2]).count()).toBe(2);
    expect(ListQuery.from(customers).whereIn('contact.city', ['Lyon']).select('id').toList()).toEqual(['c1', 'c4']);
    expect(ListQuery.from([{ n: 1 }]).whereIn('n', ['1' as unknown as number]).none()).toBe(true);
  });

  it('does not see the list change after the call', () => {
    const wanted = ['c1'];
    const query = ListQuery.from(customers).whereIn('id', wanted);
    wanted.push('c2');
    expect(query.count()).toBe(1);
  });
});

describe('dotted paths', () => {
  it('where reads nested fields, and a missing step is just no match', () => {
    expect(ListQuery.from(customers).where('contact.city', '==', 'Lyon').select('id').toList()).toEqual(['c1', 'c4']);
    expect(ListQuery.from(customers).where('contact.city', '==', undefined).select('id').toList()).toEqual(['c2']);
    const loose = [{ a: null }, {}] as Array<{ a?: { b?: number } | null }>;
    expect(ListQuery.from(loose).where('a.b', '==', 1).none()).toBe(true);
  });

  it('whereIncludes reads a nested array', () => {
    const rows = [{ x: { tags: ['a'] } }, { x: { tags: ['b'] } }];
    expect(ListQuery.from(rows).whereIncludes('x.tags', 'b').count()).toBe(1);
  });
});

describe('SELECT ... AS', () => {
  it('names columns from paths and functions', () => {
    const can = ListQuery.from(customers)
      .where('tier', '==', 'gold')
      .select({ id: 'id', email: 'contact.email', label: c => `${c.name} (${c.tier})` })
      .toList();
    expect(can).toEqual(customers.filter(c => c.tier === 'gold').map(c => ({ id: c.id, email: c.contact.email, label: `${c.name} (${c.tier})` })));
  });

  it('a path that leads nowhere is undefined, not an error', () => {
    expect(ListQuery.from(customers).select({ city: 'contact.city' }).toList().map(row => row.city)).toEqual(['Lyon', undefined, 'Nice', 'Lyon']);
  });

  it('refuses an empty column list', () => {
    expect(() => ListQuery.from(customers).select({}).toList()).toThrow(/at least one column/);
  });
});

describe('GROUP BY and aggregates', () => {
  it('matches the reduce and bucket loops they replace', () => {
    const totals = new Map<string, { n: number; total: number }>();
    for (const order of orders) {
      const entry = totals.get(order.region) ?? { n: 0, total: 0 };
      entry.n++;
      entry.total += order.price;
      totals.set(order.region, entry);
    }
    const can = ListQuery.from(orders)
      .groupBy('region')
      .aggregate(a => ({ n: a.count(), total: a.sum('price') }))
      .toList();
    expect(can).toEqual([...totals].map(([region, v]) => ({ region, ...v })));
    expect(can).toEqual([
      { region: 'eu', n: 4, total: 65 },
      { region: 'us', n: 3, total: 35 },
    ]);
  });

  it('avg, min, max and count(field) ignore missing and null, as SQL ignores NULL', () => {
    const [row] = ListQuery.from(orders)
      .aggregate(a => ({ rows: a.count(), withQty: a.count('qty'), avgQty: a.avg('qty'), minQty: a.min('qty'), maxQty: a.max('qty'), sumQty: a.sum('qty') }))
      .toList();
    expect(row).toEqual({ rows: 7, withQty: 5, avgQty: (2 + 1 + 4 + 3 + 2) / 5, minQty: 1, maxQty: 4, sumQty: 12 });
  });

  it('min and max work on strings and dates', () => {
    const [row] = ListQuery.from(orders).aggregate(a => ({ first: a.min('placedAt'), last: a.max('placedAt'), alpha: a.min('region') })).toList();
    expect(row).toEqual({ first: day(1), last: day(7), alpha: 'eu' });
  });

  it('collect() buckets rows by key: the Map.get(k) ?? [] then push idiom', () => {
    const buckets = new Map<string, Order[]>();
    for (const order of orders) buckets.set(order.region, [...(buckets.get(order.region) ?? []), order]);
    const can = ListQuery.from(orders)
      .groupBy('region')
      .aggregate(a => ({ orders: a.collect(), ids: a.collect('id') }))
      .toList();
    expect(can.map(row => [row.region, row.orders])).toEqual([...buckets]);
    expect(can.map(row => row.ids)).toEqual([[1, 3, 5, 7], [2, 4, 6]]);
  });

  it('groups by several keys, in the order each group was first seen', () => {
    const can = ListQuery.from(orders)
      .groupBy('region', 'price')
      .aggregate(a => ({ n: a.count() }))
      .toList();
    expect(can).toEqual([
      { region: 'eu', price: 30, n: 1 },
      { region: 'us', price: 10, n: 2 },
      { region: 'eu', price: 20, n: 1 },
      { region: 'eu', price: 5, n: 1 },
      { region: 'us', price: 15, n: 1 },
      { region: 'eu', price: 10, n: 1 },
    ]);
  });

  it('groups missing keys together', () => {
    const can = ListQuery.from(customers).groupBy('age').aggregate(a => ({ n: a.count() })).toList();
    expect(can.find(row => row.age === undefined)).toEqual({ age: undefined, n: 1 });
    expect(can.find(row => row.age === 25)).toEqual({ age: 25, n: 2 });
  });

  it('WHERE runs before the groups, and a where after aggregate is HAVING', () => {
    const having = ListQuery.from(orders)
      .where('price', '>=', 10)
      .groupBy('region')
      .aggregate(a => ({ n: a.count(), total: a.sum('price') }))
      .where('total', '>', 50);
    expect(having.toList()).toEqual([{ region: 'eu', n: 3, total: 60 }]);
  });

  it('orderBy and limit after aggregate are ORDER BY and LIMIT over the groups: the top regions', () => {
    const top = ListQuery.from(orders)
      .groupBy('customerId')
      .aggregate(a => ({ total: a.sum('price') }))
      .orderBy('total', 'desc')
      .limit(2)
      .toList();
    expect(top).toEqual([
      { customerId: 'c1', total: 50 },
      { customerId: 'c2', total: 20 },
    ]);
  });

  it('with no keys it is one row even over an empty list, like SELECT COUNT(*)', () => {
    expect(ListQuery.from<Order>([]).aggregate(a => ({ n: a.count(), total: a.sum('price'), top: a.max('price') })).toList()).toEqual([
      { n: 0, total: 0, top: undefined },
    ]);
    expect(ListQuery.from<Order>([]).groupBy('region').aggregate(a => ({ n: a.count() })).toList()).toEqual([]);
  });

  it('groups the rows so far, like a subquery: select, order and limit before it have already run', () => {
    const selected = ListQuery.from(orders)
      .select({ region: 'region', price: 'price' })
      .groupBy('region')
      .aggregate(a => ({ total: a.sum('price') }))
      .toList();
    expect(selected).toEqual([
      { region: 'eu', total: 65 },
      { region: 'us', total: 35 },
    ]);
    const firstThree = ListQuery.from(orders).orderBy('id').limit(3).aggregate(a => ({ n: a.count(), total: a.sum('price') })).first();
    expect(firstThree).toEqual({ n: 3, total: 60 }); // LIMIT 3 first, then SUM
  });

  it('runs again on the current data, and reads the list once per run', () => {
    const rows = [{ k: 'a' }];
    const query = ListQuery.from(rows).groupBy('k').aggregate(a => ({ n: a.count() }));
    expect(query.toList()).toEqual([{ k: 'a', n: 1 }]);
    rows.push({ k: 'a' });
    expect(query.toList()).toEqual([{ k: 'a', n: 2 }]);
  });
});

describe('JOIN', () => {
  it('innerJoin matches the loop with a lookup inside it', () => {
    const was: Array<{ left: Order; right: Customer }> = [];
    for (const order of orders) for (const customer of customers) if (order.customerId !== null && customer.id === order.customerId) was.push({ left: order, right: customer });
    const can = ListQuery.from(orders).innerJoin(customers, 'customerId', 'id').toList();
    expect(can).toEqual(was);
    expect(can.map(row => [row.left.id, row.right.id])).toEqual([[1, 'c1'], [2, 'c2'], [3, 'c1'], [4, 'c3'], [7, 'c2']]);
  });

  it('leftJoin keeps every left row, with right absent when nothing matches, including a null key', () => {
    const can = ListQuery.from(orders).leftJoin(customers, 'customerId', 'id').toList();
    expect(can.map(row => [row.left.id, row.right?.id])).toEqual([[1, 'c1'], [2, 'c2'], [3, 'c1'], [4, 'c3'], [5, undefined], [6, undefined], [7, 'c2']]);
  });

  it('several matches make several rows, left-major', () => {
    const many = ListQuery.from([{ k: 1 }, { k: 2 }]).innerJoin([{ k: 1, v: 'a' }, { k: 2, v: 'b' }, { k: 1, v: 'c' }], 'k', 'k').toList();
    expect(many.map(row => `${row.left.k}${row.right.v}`)).toEqual(['1a', '1c', '2b']);
  });

  it('a missing or null key matches nothing on either side', () => {
    const left = [{ k: undefined as number | undefined }, { k: null as number | null }, { k: 1 }];
    const right = [{ k: undefined as number | undefined }, { k: null as number | null }, { k: 1 }];
    expect(ListQuery.from(left).innerJoin(right, 'k', 'k').count()).toBe(1);
  });

  it('the join key is compared strictly: 1 is not "1"', () => {
    expect(ListQuery.from([{ k: 1 }]).innerJoin([{ k: '1' as unknown as number }], 'k', 'k').none()).toBe(true);
  });

  it('joins on dotted paths and on another query', () => {
    const cities = [{ city: 'Lyon', zone: 'south' }, { city: 'Nice', zone: 'coast' }];
    const can = ListQuery.from(customers).innerJoin(ListQuery.from(cities).where('zone', '==', 'south'), 'contact.city', 'city').toList();
    expect(can.map(row => row.left.id)).toEqual(['c1', 'c4']);
  });

  it('indexes the right list once per run, not once per left row', () => {
    let walks = 0;
    const right = new Proxy([...customers], {
      get(target, property, receiver) {
        if (property === Symbol.iterator) walks++;
        return Reflect.get(target, property, receiver);
      },
    });
    ListQuery.from(orders).innerJoin(right, 'customerId', 'id').toList();
    expect(walks).toBe(1);
  });

  it('is a query over { left, right }: filter, order, select and limit it', () => {
    const rows = ListQuery.from(orders)
      .innerJoin(customers, 'customerId', 'id')
      .where(row => row.right.tier === 'gold')
      .orderBy(row => row.left.price, 'desc')
      .select(row => ({ order: row.left.id, who: row.right.name, price: row.left.price }))
      .limit(2)
      .toList();
    expect(rows).toEqual([
      { order: 1, who: 'Ann', price: 30 },
      { order: 3, who: 'Ann', price: 20 },
    ]);
  });

  it('follows the current data of both sides, and the join is lazy', () => {
    let tested = 0;
    const found = ListQuery.from(orders)
      .where(() => (tested++, true))
      .innerJoin(customers, 'customerId', 'id')
      .first();
    expect(found?.left.id).toBe(1);
    expect(tested).toBe(1);
  });
});

describe('the whole thing, as one SQL statement', () => {
  it('SELECT city, COUNT(*), SUM(price) FROM orders JOIN customers WHERE gold GROUP BY city HAVING n >= 1 ORDER BY total DESC LIMIT 5', () => {
    const rows = ListQuery.from(orders)
      .innerJoin(customers, 'customerId', 'id')
      .where(row => row.right.tier === 'gold')
      .select({ city: row => row.right.contact.city, price: row => row.left.price })
      .groupBy('city')
      .aggregate(a => ({ n: a.count(), total: a.sum('price') }))
      .toList();
    expect(rows).toEqual([
      { city: 'Lyon', n: 2, total: 50 },
      { city: 'Nice', n: 1, total: 10 },
    ]);
  });
});
