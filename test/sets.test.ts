import { describe, expect, it } from 'vitest';
import { ListQuery } from '../src';

type Kind = 'innerJoin' | 'leftJoin' | 'rightJoin' | 'outerJoin';
const flags: Record<Kind, [keepLeft: boolean, keepRight: boolean]> = {
  innerJoin: [false, false],
  leftJoin: [true, false],
  rightJoin: [false, true],
  outerJoin: [true, true],
};

/** The definition, written as loops: for each left its matches, then the right rows nothing matched. */
function reference<L, U>(lefts: L[], rights: U[], leftKey: (row: L) => unknown, rightKey: (row: U) => unknown, [keepLeft, keepRight]: [boolean, boolean]) {
  const rows: Array<{ left: L | undefined; right: U | undefined }> = [];
  const matched = new Set<number>();
  for (const left of lefts) {
    let any = false;
    rights.forEach((right, position) => {
      const a = leftKey(left);
      if (a !== undefined && a !== null && a === rightKey(right)) {
        rows.push({ left, right });
        matched.add(position);
        any = true;
      }
    });
    if (!any && keepLeft) rows.push({ left, right: undefined });
  }
  if (keepRight) rights.forEach((right, position) => matched.has(position) || rows.push({ left: undefined, right }));
  return rows;
}

interface Row {
  k?: number | string | null;
  v?: string;
}
const datasets: Array<[string, Row[], Row[]]> = [
  ['plain', [{ k: 1, v: 'a' }, { k: 2, v: 'b' }, { k: 3, v: 'c' }], [{ k: 2, v: 'x' }, { k: 3, v: 'y' }, { k: 4, v: 'z' }]],
  ['duplicates on both sides', [{ k: 1, v: 'a' }, { k: 1, v: 'b' }, { k: 2, v: 'c' }], [{ k: 1, v: 'x' }, { k: 1, v: 'y' }, { k: 3, v: 'z' }]],
  ['null and missing keys on both sides', [{ k: null }, {}, { k: 1 }], [{ k: undefined }, { k: null }, { k: 1 }, {}]],
  ['a string key is not a number key', [{ k: 1 }, { k: '1' }], [{ k: '1' }, { k: 1 }]],
  ['nothing matches', [{ k: 1 }, { k: 2 }], [{ k: 3 }, { k: 4 }]],
  ['everything matches', [{ k: 1 }, { k: 2 }], [{ k: 2 }, { k: 1 }]],
  ['empty left', [], [{ k: 1 }, { k: 2 }]],
  ['empty right', [{ k: 1 }, { k: 2 }], []],
  ['both empty', [], []],
];

describe.each(datasets)('joins over %s', (_name, lefts, rights) => {
  it.each(Object.keys(flags) as Kind[])('%s matches the loops that define it, row for row and in the same order', kind => {
    const can = ListQuery.from(lefts)[kind](rights, 'k', 'k').toList();
    expect(can).toEqual(reference(lefts, rights, row => row.k, row => row.k, flags[kind]));
  });

  it('outer = inner + the left rows nothing matched + the right rows nothing matched', () => {
    const inner = ListQuery.from(lefts).innerJoin(rights, 'k', 'k').count();
    const outer = ListQuery.from(lefts).outerJoin(rights, 'k', 'k').count();
    const onlyLeft = ListQuery.from(lefts).leftJoin(rights, 'k', 'k').where(row => row.right === undefined).count();
    const onlyRight = ListQuery.from(lefts).rightJoin(rights, 'k', 'k').where(row => row.left === undefined).count();
    expect(outer).toBe(inner + onlyLeft + onlyRight);
  });

  it('a left join and a right join are the same rows seen from either side', () => {
    const left = ListQuery.from(lefts).leftJoin(rights, 'k', 'k').toList();
    const swapped = ListQuery.from(rights).rightJoin(lefts, 'k', 'k').toList();
    const key = (row: { left?: Row; right?: Row }) => JSON.stringify([row.left ?? null, row.right ?? null]);
    expect(swapped.map(row => key({ left: row.right, right: row.left })).sort()).toEqual(left.map(key).sort());
  });
});

describe('the row order every join keeps', () => {
  it('each left row in turn with its matches, then the unmatched right rows in their order', () => {
    const lefts = [{ k: 2, v: 'L2' }, { k: 1, v: 'L1' }];
    const rights = [{ k: 9, v: 'R9' }, { k: 1, v: 'R1a' }, { k: 8, v: 'R8' }, { k: 2, v: 'R2' }, { k: 1, v: 'R1b' }];
    const rows = ListQuery.from(lefts).outerJoin(rights, 'k', 'k').select(row => `${row.left?.v ?? '-'}+${row.right?.v ?? '-'}`).toList();
    expect(rows).toEqual(['L2+R2', 'L1+R1a', 'L1+R1b', '-+R9', '-+R8']);
  });
});

describe('RIGHT and FULL joins on real-shaped data', () => {
  interface Customer {
    id: string;
    name: string;
  }
  interface Order {
    id: number;
    customerId: string | null;
    price: number;
  }
  const customers: Customer[] = [{ id: 'c1', name: 'Ann' }, { id: 'c2', name: 'Bob' }, { id: 'c3', name: 'Zed' }];
  const orders: Order[] = [
    { id: 1, customerId: 'c1', price: 30 },
    { id: 2, customerId: 'c1', price: 20 },
    { id: 3, customerId: 'ghost', price: 5 },
    { id: 4, customerId: null, price: 9 },
    { id: 5, customerId: 'c2', price: 10 },
  ];

  it('rightJoin lists every customer, with left absent for one who has no orders', () => {
    const rows = ListQuery.from(orders).rightJoin(customers, 'customerId', 'id').toList();
    expect(rows.map(row => [row.left?.id, row.right.name])).toEqual([[1, 'Ann'], [2, 'Ann'], [5, 'Bob'], [undefined, 'Zed']]);
  });

  it('outerJoin shows both problems at once: orders with no customer and customers with no orders', () => {
    const rows = ListQuery.from(orders).outerJoin(customers, 'customerId', 'id').toList();
    expect(rows.filter(row => !row.right).map(row => row.left?.id)).toEqual([3, 4]);
    expect(rows.filter(row => !row.left).map(row => row.right?.name)).toEqual(['Zed']);
  });

  it('LEFT JOIN ... COUNT(o.id) : orders per customer, including customers with none', () => {
    const perCustomer = ListQuery.from(orders)
      .rightJoin(customers, 'customerId', 'id')
      .select({ customer: row => row.right.name, order: row => row.left?.id })
      .groupBy('customer')
      .aggregate(a => ({ orders: a.count('order') }))
      .toList();
    expect(perCustomer).toEqual([
      { customer: 'Ann', orders: 2 },
      { customer: 'Bob', orders: 1 },
      { customer: 'Zed', orders: 0 },
    ]);
  });

  it('is a query like any other: filter, order and limit the joined rows', () => {
    const orphans = ListQuery.from(orders)
      .outerJoin(customers, 'customerId', 'id')
      .where(row => row.left !== undefined && row.right === undefined)
      .orderBy(row => row.left?.price, 'desc')
      .select(row => row.left?.id)
      .toList();
    expect(orphans).toEqual([4, 3]);
  });

  it('a right join on a dotted path, and against another query', () => {
    const nested = [{ owner: { id: 'c1' }, n: 1 }];
    const rows = ListQuery.from(nested).rightJoin(ListQuery.from(customers).where('id', '!=', 'c3'), 'owner.id', 'id').toList();
    expect(rows.map(row => [row.left?.n, row.right.name])).toEqual([[1, 'Ann'], [undefined, 'Bob']]);
  });

  it('indexes the other list once per run, for every kind', () => {
    for (const kind of Object.keys(flags) as Kind[]) {
      let walks = 0;
      const right = new Proxy([...customers], {
        get(target, property, receiver) {
          if (property === Symbol.iterator) walks++;
          return Reflect.get(target, property, receiver);
        },
      });
      ListQuery.from(orders)[kind](right, 'customerId', 'id').toList();
      expect(walks).toBe(1);
    }
  });
});

describe('UNION', () => {
  it('matches [...new Set([...a, ...b])] for values: duplicates dropped, first seen order', () => {
    const a = [3, 1, 2, 1];
    const b = [2, 5, 3, 4, 5];
    expect(ListQuery.from(a).union(b).toList()).toEqual([...new Set([...a, ...b])]);
    expect(ListQuery.from(a).union(b).toList()).toEqual([3, 1, 2, 5, 4]);
  });

  it('finds duplicates within each side as well as across them, as SQL UNION does', () => {
    expect(ListQuery.from(['x', 'x']).union(['y', 'y']).toList()).toEqual(['x', 'y']);
  });

  it('unionAll keeps every row', () => {
    expect(ListQuery.from([1, 1]).unionAll([1, 2]).toList()).toEqual([1, 1, 1, 2]);
  });

  it('compares objects by content, whatever the order of their keys', () => {
    const a = [{ id: 1, n: 'a' }, { id: 2, n: 'b' }];
    const b = [{ n: 'b', id: 2 }, { id: 3, n: 'c' }];
    expect(ListQuery.from(a).union(b).select('id').toList()).toEqual([1, 2, 3]);
  });

  it('with a key, rows sharing it are duplicates and the first one wins', () => {
    const a = [{ id: 1, n: 'from a' }, { id: 2, n: 'from a' }];
    const b = [{ id: 2, n: 'from b' }, { id: 3, n: 'from b' }];
    expect(ListQuery.from(a).union(b, 'id').toList()).toEqual([
      { id: 1, n: 'from a' },
      { id: 2, n: 'from a' },
      { id: 3, n: 'from b' },
    ]);
  });

  it('a key can be a dotted path, and a missing value counts as one value, as NULL does in SQL', () => {
    const a = [{ owner: { id: 'x' }, n: 1 }, { n: 2 }];
    const b = [{ owner: { id: 'x' }, n: 3 }, { n: 4 }];
    expect(ListQuery.from(a).union(b, 'owner.id').select('n').toList()).toEqual([1, 2]);
  });

  it('unions after select, and takes another query as the other side', () => {
    const people = [{ name: 'Ann', email: 'a@x.test' }, { name: 'Bob', email: 'b@x.test' }];
    const staff = [{ name: 'Bob', email: 'b@x.test' }, { name: 'Cy', email: 'c@x.test' }];
    const emails = ListQuery.from(people).select('email').union(ListQuery.from(staff).select('email')).toList();
    expect(emails).toEqual(['a@x.test', 'b@x.test', 'c@x.test']);
  });

  it('orderBy, offset and limit after it work on the combined list, not on each side', () => {
    const a = [{ id: 3, name: 'c' }, { id: 1, name: 'a' }];
    const b = [{ id: 4, name: 'd' }, { id: 2, name: 'b' }, { id: 1, name: 'a' }];
    const combined = [...new Map([...a, ...b].map(row => [row.id, row])).values()].sort((x, y) => x.name.localeCompare(y.name));
    const page = ListQuery.from(a).union(b, 'id').orderBy('name').offset(1).limit(2).toList();
    expect(page).toEqual(combined.slice(1, 3));
    expect(page.map(row => row.id)).toEqual([2, 3]);
  });

  it('is lazy: first() does not read the other side', () => {
    let read = 0;
    const other = { *[Symbol.iterator]() { read++; yield 99; } };
    expect(ListQuery.from([1, 2]).union(other).first()).toBe(1);
    expect(read).toBe(0);
    expect(ListQuery.from([1, 2]).union(other).toList()).toEqual([1, 2, 99]);
    expect(read).toBe(1);
  });

  it('runs again on the current data', () => {
    const a = [1];
    const query = ListQuery.from(a).union([2]);
    expect(query.toList()).toEqual([1, 2]);
    a.push(2, 3);
    expect(query.toList()).toEqual([1, 2, 3]);
  });

  it('chains: a union of three lists', () => {
    expect(ListQuery.from([1]).union([2, 1]).union([3, 2]).toList()).toEqual([1, 2, 3]);
  });
});
