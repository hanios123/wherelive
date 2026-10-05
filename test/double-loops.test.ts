import { describe, expect, it } from 'vitest';
import { ListQuery } from '../src';

interface Order {
  id: string;
  region: string;
  status: 'open' | 'closed';
  tags: string[];
}
interface Line {
  orderId: string;
  sku: string;
  qty: number;
}

const orders: Order[] = [
  { id: 'o1', region: 'eu', status: 'open', tags: ['gift'] },
  { id: 'o2', region: 'eu', status: 'closed', tags: [] },
  { id: 'o3', region: 'us', status: 'open', tags: ['gift', 'rush'] },
  { id: 'o4', region: 'us', status: 'open', tags: [] }, // no lines at all
  { id: 'o5', region: 'eu', status: 'open', tags: ['rush'] },
];

/** Lines hang off the parent by region and order id, and one stray line points at the wrong order. */
const linesByRegion: Record<string, Record<string, Line[]>> = {
  eu: {
    o1: [
      { orderId: 'o1', sku: 'a', qty: 1 },
      { orderId: 'o1', sku: 'b', qty: 2 },
      { orderId: 'o9', sku: 'stray', qty: 1 },
    ],
    o2: [{ orderId: 'o2', sku: 'c', qty: 1 }],
    o5: [
      { orderId: 'o5', sku: 'a', qty: 3 },
      { orderId: 'o5', sku: 'a', qty: 1 },
    ],
  },
  us: { o3: [{ orderId: 'o3', sku: 'd', qty: 4 }] },
};

describe('flatMap: a for inside a for, where the inner list hangs off the outer item', () => {
  const was = () => {
    const ids = new Set<string>();
    for (const order of orders) {
      if (order.status !== 'open') continue;
      const lines = linesByRegion[order.region]?.[order.id];
      if (!lines) continue;
      for (const line of lines) {
        if (line.orderId !== order.id) continue;
        ids.add(`${line.sku}_${order.region}`);
      }
    }
    return ids;
  };

  const can = () =>
    ListQuery.from(orders)
      .where('status', '==', 'open')
      .flatMap(order =>
        ListQuery.from(linesByRegion[order.region]?.[order.id] ?? [])
          .where('orderId', '==', order.id)
          .select(line => `${line.sku}_${order.region}`),
      )
      .toSet();

  it('builds the same set as the two loops, their continues, and the hand-built Set', () => {
    expect(can()).toEqual(was());
    expect([...can()]).toEqual([...was()]); // same order too
    expect([...can()]).toEqual(['a_eu', 'b_eu', 'd_us']);
  });

  it('toList keeps the duplicates that toSet collapses, in the loops\' order', () => {
    const was: string[] = [];
    for (const order of orders) for (const line of linesByRegion[order.region]?.[order.id] ?? []) was.push(line.sku);
    const skus = ListQuery.from(orders)
      .flatMap(order => ListQuery.from(linesByRegion[order.region]?.[order.id] ?? []).select('sku'))
      .toList();
    expect(skus).toEqual(was);
    expect(skus).toEqual(['a', 'b', 'stray', 'c', 'd', 'a', 'a']);
    expect(new Set(skus).size).toBe(5);
  });

  it('skips a parent with no children and a parent the outer query dropped', () => {
    const count = ListQuery.from(orders)
      .where('status', '==', 'open')
      .flatMap(order => linesByRegion[order.region]?.[order.id] ?? [])
      .count();
    expect(count).toBe(3 + 2 + 1); // o1, o5, o3. Not o2 (closed), not o4 (no lines)
  });

  it('each list is walked once: the outer once, and each parent\'s own list once', () => {
    const walks = { outer: 0, inner: new Map<string, number>() };
    const countWalks = <T>(items: T[], onWalk: () => void) =>
      new Proxy(items, {
        get(target, property, receiver) {
          if (property === Symbol.iterator) onWalk();
          return Reflect.get(target, property, receiver);
        },
      });
    const outer = countWalks(orders, () => walks.outer++);
    ListQuery.from(outer)
      .where('status', '==', 'open')
      .flatMap(order => {
        const lines = countWalks(linesByRegion[order.region]?.[order.id] ?? [], () => walks.inner.set(order.id, (walks.inner.get(order.id) ?? 0) + 1));
        return ListQuery.from(lines).where('orderId', '==', order.id);
      })
      .toList();
    expect(walks.outer).toBe(1);
    expect([...walks.inner]).toEqual([
      ['o1', 1],
      ['o3', 1],
      ['o4', 1],
      ['o5', 1],
    ]);
  });

  it('first() and some() stop at the first match across both levels', () => {
    let outerTests = 0;
    let innerTests = 0;
    const query = ListQuery.from(orders)
      .where(() => (outerTests++, true))
      .flatMap(order =>
        ListQuery.from(linesByRegion[order.region]?.[order.id] ?? []).where(line => (innerTests++, line.sku === 'b')),
      );
    expect(query.some()).toBe(true);
    expect(outerTests).toBe(1); // the second order is never read
    expect(innerTests).toBe(2); // 'a', then 'b' matches. The third line is never read
    outerTests = innerTests = 0;
    expect(query.first()).toEqual({ orderId: 'o1', sku: 'b', qty: 2 });
    expect([outerTests, innerTests]).toEqual([1, 2]);
  });

  it('nests for a third loop and matches three for loops', () => {
    const was: string[] = [];
    for (const region of ['eu', 'us']) {
      for (const order of orders) {
        if (order.region !== region) continue;
        for (const line of linesByRegion[region]?.[order.id] ?? []) was.push(`${region}/${order.id}/${line.sku}`);
      }
    }
    const can = ListQuery.from(['eu', 'us'])
      .flatMap(region =>
        ListQuery.from(orders)
          .where('region', '==', region)
          .flatMap(order => ListQuery.from(linesByRegion[region]?.[order.id] ?? []).select(line => `${region}/${order.id}/${line.sku}`)),
      )
      .toList();
    expect(can).toEqual(was);
  });

  it('the callback receives the row as select shaped it', () => {
    const tags = ListQuery.from(orders)
      .select('tags')
      .flatMap(tagList => tagList)
      .toList();
    expect(tags).toEqual(['gift', 'gift', 'rush', 'rush']);
  });

  it('reads plain arrays as well as queries, and the result is a query you can keep filtering', () => {
    const rushOrGift = ListQuery.from(orders)
      .flatMap(order => order.tags)
      .where(tag => tag !== 'gift')
      .toList();
    expect(rushOrGift).toEqual(['rush', 'rush']);
    const big = ListQuery.from(orders)
      .flatMap(order => linesByRegion[order.region]?.[order.id] ?? [])
      .where('qty', '>=', 3)
      .select('sku', 'qty')
      .toList();
    expect(big).toEqual([
      { sku: 'd', qty: 4 }, // o3 comes before o5
      { sku: 'a', qty: 3 },
    ]);
  });

  it('can be run again and sees the array as it is now', () => {
    const rows = [{ items: [1] }];
    const query = ListQuery.from(rows).flatMap(row => row.items);
    expect(query.toList()).toEqual([1]);
    rows.push({ items: [2, 3] });
    expect(query.toList()).toEqual([1, 2, 3]);
    expect(query.count()).toBe(3);
  });

  it('says so at once when there is no data to loop over', () => {
    expect(() => ListQuery.fromType<Order>().flatMap(() => [])).toThrow(/no data/);
  });
});

describe('pairs: every combination of two arrays', () => {
  it('matches a nested for, left list outermost', () => {
    const was: Array<[number, string]> = [];
    for (const n of [1, 2, 3]) for (const s of ['a', 'b']) was.push([n, s]);
    expect(ListQuery.pairs([1, 2, 3], ['a', 'b']).toList()).toEqual(was);
  });

  it('has left.length * right.length rows and none when either side is empty', () => {
    expect(ListQuery.pairs([1, 2, 3], ['a', 'b']).count()).toBe(6);
    expect(ListQuery.pairs([], ['a']).none()).toBe(true);
    expect(ListQuery.pairs([1], []).none()).toBe(true);
  });

  it('filters and selects like any query', () => {
    const ordered = ListQuery.pairs([1, 2, 3], [1, 2, 3])
      .where(([a, b]) => a < b)
      .select(([a, b]) => `${a}<${b}`)
      .toList();
    expect(ordered).toEqual(['1<2', '1<3', '2<3']);
  });
});

describe('combine: the same combinations, named, for any number of lists', () => {
  const regions = ['eu', 'us', 'all'];
  const channels = ['web', 'app'];

  it('matches a nested for and names each list', () => {
    const was: Array<{ region: string; channel: string }> = [];
    for (const region of regions) for (const channel of channels) was.push({ region, channel });
    expect(ListQuery.combine({ region: regions, channel: channels }).toList()).toEqual(was);
  });

  it('a loop of five lists is the same call with five keys', () => {
    const lists = { a: [1, 2], b: ['x', 'y', 'z'], c: [true, false], d: [10, 20], e: ['p'] };
    const was: unknown[] = [];
    for (const a of lists.a) for (const b of lists.b) for (const c of lists.c) for (const d of lists.d) for (const e of lists.e) was.push({ a, b, c, d, e });
    const can = ListQuery.combine(lists).toList();
    expect(can).toHaveLength(2 * 3 * 2 * 2 * 1);
    expect(can).toEqual(was);
  });

  it('one list is just that list, named', () => {
    expect(ListQuery.combine({ n: [1, 2] }).toList()).toEqual([{ n: 1 }, { n: 2 }]);
  });

  it('an empty list makes no combinations, and no lists at all is refused', () => {
    expect(ListQuery.combine({ a: [1], b: [] as string[] }).none()).toBe(true);
    expect(() => ListQuery.combine({})).toThrow(/at least one list/);
  });

  it('every row is its own object, and running again gives the same rows', () => {
    const query = ListQuery.combine({ a: [1, 2], b: ['x'] });
    const first = query.toList();
    (first[0] as { a: number }).a = 99;
    expect(first[1]).toEqual({ a: 2, b: 'x' });
    expect(query.toList()).toEqual([
      { a: 1, b: 'x' },
      { a: 2, b: 'x' },
    ]);
  });

  it('is a query: where takes the names, and select reads them', () => {
    const eu = ListQuery.combine({ region: regions, channel: channels }).where('region', '==', 'eu').select('channel').toList();
    expect(eu).toEqual(['web', 'app']);
  });

  it('does not build every combination up front', () => {
    const big = Array.from({ length: 1000 }, (_, i) => i);
    let tested = 0;
    const found = ListQuery.combine({ a: big, b: big })
      .where(row => (tested++, row.a === 0 && row.b === 1))
      .some();
    expect(found).toBe(true);
    expect(tested).toBe(2); // (0,0) then (0,1). Not a million rows
  });

  it('answers "is there a combination that nothing matches", the double loop with an early return', () => {
    const specs = [
      { region: 'eu', channel: 'web' },
      { region: 'eu', channel: 'app' },
      { region: 'us', channel: 'web' },
    ];
    const was = (regionList: string[], channelList: string[]) => {
      for (const region of regionList) {
        for (const channel of channelList) {
          if (!specs.some(spec => (region === 'all' || spec.region === region) && (channel === 'all' || spec.channel === channel))) return true;
        }
      }
      return false;
    };
    const can = (regionList: string[], channelList: string[]) =>
      ListQuery.combine({ region: regionList, channel: channelList })
        .where(combination =>
          ListQuery.from(specs)
            .where(spec => (combination.region === 'all' || spec.region === combination.region) && (combination.channel === 'all' || spec.channel === combination.channel))
            .none(),
        )
        .some();
    for (const [r, c] of [
      [['eu'], ['web', 'app']],
      [['eu', 'us'], ['web', 'app']], // us + app has no spec
      [['all'], ['all']],
      [['nowhere'], ['web']],
      [[], ['web']],
    ] as Array<[string[], string[]]>) {
      expect(can(r, c)).toBe(was(r, c));
    }
  });
});

describe('iterating a query', () => {
  it('for...of and spread run the query, and each pass runs it again', () => {
    let tested = 0;
    const query = ListQuery.from([1, 2, 3, 4]).where(n => (tested++, n % 2 === 0));
    expect([...query]).toEqual([2, 4]);
    const seen: number[] = [];
    for (const n of query) seen.push(n);
    expect(seen).toEqual([2, 4]);
    expect(tested).toBe(8);
  });
});

describe('toSet', () => {
  it('collapses duplicates to their first occurrence, after select', () => {
    const rows = [{ tag: 'b' }, { tag: 'a' }, { tag: 'b' }, { tag: 'c' }];
    expect([...ListQuery.from(rows).select('tag').toSet()]).toEqual(['b', 'a', 'c']);
    expect(ListQuery.from(rows).where('tag', '!=', 'b').toSet().size).toBe(2);
  });
});
