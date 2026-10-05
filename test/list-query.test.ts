import { describe, expect, it } from 'vitest';
import { ListQuery, type Holder } from '../src';

// ---- Rewriting plain filter/map loops keeps their result -------------------------
// Each "was" is the loop a caller would write by hand. Each "can" is the same thing as a query.

interface Product {
  sku: number;
  department: string;
  category: string;
  brand?: string;
}
interface Shelf {
  category: string;
  brand?: string;
}

const products: Holder<Product> = {
  a: { sku: 1, department: 'garden', category: 'plants', brand: 'acme' },
  b: { sku: 2, department: 'garden', category: 'plants', brand: 'bolt' },
  c: { sku: 3, department: 'garden', category: 'plants' },
  d: { sku: 4, department: 'garden', category: 'tools', brand: 'acme' },
  e: { sku: 5, department: 'kitchen', category: 'plants', brand: 'acme' },
  f: { sku: 6, department: 'garden', category: 'plants', brand: 'acme' },
};

describe('listing the SKUs on a shelf', () => {
  const was = (department: string, shelf: Shelf) =>
    Object.values(products)
      .filter(product => product.department === department && product.category === shelf.category && (!shelf.brand || product.brand === shelf.brand))
      .map(product => product.sku);

  const can = (department: string, shelf: Shelf) =>
    ListQuery.fromHolder(products)
      .where('department', '==', department)
      .where('category', '==', shelf.category)
      .when(shelf.brand, query => query.where('brand', '==', shelf.brand))
      .toList()
      .map(product => product.sku);

  const shelves: Shelf[] = [
    { category: 'plants' },
    { category: 'plants', brand: 'acme' },
    { category: 'plants', brand: 'bolt' },
    { category: 'plants', brand: 'zed' },
    { category: 'plants', brand: '' },
    { category: 'tools' },
    { category: 'nothing' },
  ];

  it.each(shelves.flatMap(shelf => ['garden', 'kitchen', 'toys'].map(department => [department, shelf] as const)))(
    'keeps the loop\'s result for department %s and shelf %j',
    (department, shelf) => {
      expect(can(department, shelf)).toEqual(was(department, shelf));
    },
  );
});

describe('finding a team by member', () => {
  interface Team {
    id: string;
    memberIds: string[];
  }
  const teams: Team[] = [
    { id: 't1', memberIds: ['u1', 'u2'] },
    { id: 't2', memberIds: ['u3'] },
    { id: 't3', memberIds: ['u2', 'u3'] },
  ];

  it.each(['u1', 'u2', 'u3', 'nobody'])('finds the same team for %s', id => {
    const was = teams.find(team => team.memberIds.includes(id));
    const can = ListQuery.from(teams).whereIncludes('memberIds', id).first();
    expect(can).toBe(was);
  });
});

describe('building a holder from a list', () => {
  interface Plan {
    id: string;
    name: string;
  }
  const plans: Plan[] = [
    { id: 'p1', name: 'basic' },
    { id: 'p2', name: 'pro' },
  ];

  it('builds the same holder as the loop', () => {
    let was: Holder<Plan> = {};
    for (const plan of plans) was = { ...was, [plan.id]: plan };
    expect(ListQuery.from(plans).toHolder('id')).toEqual(was);
  });

  it('is the reverse of fromHolder', () => {
    expect(ListQuery.from(ListQuery.fromHolder(products).toList()).toHolder('sku')).toEqual({
      1: products.a,
      2: products.b,
      3: products.c,
      4: products.d,
      5: products.e,
      6: products.f,
    });
  });

  it('keeps the last item when two share a key, as the loop did', () => {
    const rows = [
      { id: 'x', v: 1 },
      { id: 'x', v: 2 },
    ];
    expect(ListQuery.from(rows).toHolder('id')).toEqual({ x: { id: 'x', v: 2 } });
  });

  it('refuses a key that is not a string or number', () => {
    const rows = [{ id: undefined as unknown as string }];
    expect(() => ListQuery.from(rows).toHolder('id')).toThrow(/"id" must be a string or a number/);
  });
});

describe('checking a computed label with some()', () => {
  const activePlans = [
    { program: 'p', name: 'a' },
    { program: 'q', name: 'b' },
  ];
  const fullLabel = (program: string, name: string) => `${program}:${name}`;
  it.each(['p:a', 'q:b', 'p:b'])('matches the some() it replaces for %s', label => {
    const was = activePlans.some(plan => label === fullLabel(plan.program, plan.name));
    const can = ListQuery.from(activePlans)
      .where(plan => label === fullLabel(plan.program, plan.name))
      .some();
    expect(can).toBe(was);
  });
});

describe('none()', () => {
  const rules = [{ region: 'eu', channel: 'web' }];
  it('none() is !some()', () => {
    const missing = ListQuery.from(rules).where('region', '==', 'us');
    const present = ListQuery.from(rules).where('region', '==', 'eu');
    expect(missing.none()).toBe(true);
    expect(present.none()).toBe(false);
    expect(present.some()).toBe(true);
  });
});

// ---- The library's own contract --------------------------------------------------

describe('one pass', () => {
  function counted<T>(items: T[]) {
    const counts = { iterations: 0, reads: 0 };
    const proxy = new Proxy(items, {
      get(target, property, receiver) {
        if (property === Symbol.iterator) counts.iterations++;
        if (typeof property === 'string' && /^\d+$/.test(property)) counts.reads++;
        return Reflect.get(target, property, receiver);
      },
    });
    return { proxy, counts };
  }

  it('three where calls walk the list once and test each item at most once per clause', () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ n: i, even: i % 2 === 0, big: i > 10 }));
    const calls = [0, 0, 0];
    const { proxy, counts } = counted(items);
    const result = ListQuery.from(proxy)
      .where(item => (calls[0]!++, item.even))
      .where(item => (calls[1]!++, item.big))
      .where(item => (calls[2]!++, item.n < 40))
      .toList();
    expect(result.map(item => item.n)).toEqual([12, 14, 16, 18, 20, 22, 24, 26, 28, 30, 32, 34, 36, 38]);
    expect(counts.iterations).toBe(1);
    expect(calls[0]).toBe(50);
    expect(calls[1]).toBe(25); // only the 25 even items reach the second clause
    expect(calls[2]).toBe(19);
  });

  it('first() and some() stop at the first match', () => {
    let tested = 0;
    const items = [1, 2, 3, 4, 5];
    const query = ListQuery.from(items).where(item => (tested++, item >= 2));
    expect(query.first()).toBe(2);
    expect(tested).toBe(2);
    tested = 0;
    expect(query.some()).toBe(true);
    expect(tested).toBe(2);
  });
});

describe('describing a query', () => {
  const rows = [
    { id: 1, tier: 'a', tags: ['x'], price: 10 },
    { id: 2, tier: 'b', tags: ['x', 'y'], price: 20 },
    { id: 3, tier: 'a', tags: [], price: 30 },
  ];

  it('never mutates: every call returns a new query', () => {
    const base = ListQuery.from(rows);
    const narrowed = base.where('tier', '==', 'a');
    expect(base.count()).toBe(3);
    expect(narrowed.count()).toBe(2);
  });

  it('supports every comparison', () => {
    const count = (op: '==' | '!=' | '>' | '>=' | '<' | '<=') => ListQuery.from(rows).where('price', op, 20).count();
    expect([count('=='), count('!='), count('>'), count('>='), count('<'), count('<=')]).toEqual([1, 2, 1, 2, 1, 2]);
  });

  it('whereIncludes needs an array; a non-array field does not match', () => {
    expect(ListQuery.from(rows).whereIncludes('tags', 'x').count()).toBe(2);
    const loose = [{ tags: 'x' }] as unknown as { tags: string[] }[];
    expect(ListQuery.from(loose).whereIncludes('tags', 'x').count()).toBe(0);
  });

  it('when adds the clause only when the value is present', () => {
    const q = (value: unknown) => ListQuery.from(rows).when(value as string | undefined, query => query.where('tier', '==', 'a'));
    expect(q(undefined).count()).toBe(3);
    expect(q(null).count()).toBe(3);
    expect(q('').count()).toBe(3);
    expect(q('a').count()).toBe(2);
  });

  it('when treats 0 and false as values, not as absent', () => {
    expect(ListQuery.from(rows).when(0, query => query.where('price', '>', 15)).count()).toBe(2);
    expect(ListQuery.from(rows).when(false, query => query.where('price', '>', 15)).count()).toBe(2);
  });

  it('count, first, some and none agree', () => {
    const none = ListQuery.from(rows).where('tier', '==', 'zzz');
    expect([none.count(), none.first(), none.some(), none.none()]).toEqual([0, undefined, false, true]);
  });

  it('an empty query returns everything', () => {
    expect(ListQuery.from(rows).toList()).toEqual(rows);
  });
});

describe('fromType and from(items)', () => {
  it('describes once and runs on any array', () => {
    const adults = ListQuery.fromType<{ age: number }>().where('age', '>=', 18);
    expect(adults.from([{ age: 10 }, { age: 30 }])).toEqual([{ age: 30 }]);
    expect(adults.from([{ age: 40 }])).toEqual([{ age: 40 }]);
  });

  it('a query with no data explains itself when asked for its own list', () => {
    expect(() => ListQuery.fromType<number>().toList()).toThrow(/no data/);
  });

  it('from(items) on a bound query uses the items you pass', () => {
    expect(ListQuery.from([1, 2, 3]).where(n => n > 1).from([0, 5])).toEqual([5]);
  });
});

describe('select', () => {
  interface Person {
    name: string;
    age: number;
    contact: { email: string; phone: string };
  }
  const people: Person[] = [
    { name: 'Ann', age: 12, contact: { email: 'ann@example.test', phone: '555-0101' } },
    { name: 'Bob', age: 14, contact: { email: 'bob@example.test', phone: '555-0102' } },
  ];

  it('one name returns that value', () => {
    expect(ListQuery.from(people).select('name').toList()).toEqual(['Ann', 'Bob']);
    expect(ListQuery.from(people).select('age').toList()).toEqual([12, 14]);
  });

  it('several names return an object with only those attributes', () => {
    expect(ListQuery.from(people).select('name', 'age').toList()).toEqual([
      { name: 'Ann', age: 12 },
      { name: 'Bob', age: 14 },
    ]);
  });

  it('contact.* copies every field and leaves contact out, same as the spread it replaces', () => {
    const was = people.map(person => ({ name: person.name, age: person.age, ...person.contact }));
    const can = ListQuery.from(people).select('name', 'age', 'contact.*').toList();
    expect(can).toEqual(was);
    expect(Object.keys(can[0]!)).toEqual(['name', 'age', 'email', 'phone']);
    expect(ListQuery.from(people).select('contact.*').toList()).toEqual([
      { email: 'ann@example.test', phone: '555-0101' },
      { email: 'bob@example.test', phone: '555-0102' },
    ]);
    expect(ListQuery.from(people).select('name', 'contact.*').toList()[0]).toEqual({ name: 'Ann', email: 'ann@example.test', phone: '555-0101' });
  });

  it('* is the whole row, and only on its own', () => {
    expect(ListQuery.from(people).select('*').toList()).toEqual(people);
    expect(() => ListQuery.from(people).select('*', 'name')).toThrow(/cannot be combined/);
  });

  it('an empty or mixed select fails when it is written, not when it runs', () => {
    expect(() => (ListQuery.from(people) as any).select()).toThrow(/at least one attribute/);
    expect(() => ListQuery.from(people).select('*', 'name')).toThrow(/cannot be combined/);
  });

  it('a repeated name is one name', () => {
    expect(ListQuery.from(people).select('name', 'name').toList()).toEqual(['Ann', 'Bob']);
  });

  it('a missing attribute throws', () => {
    const loose = [{ name: 'Ann' }] as unknown as Person[];
    expect(() => ListQuery.from(loose).select('age').toList()).toThrow(/attribute "age" is missing/);
    expect(() => ListQuery.from(loose).select('contact.*').toList()).toThrow(/attribute "contact" is missing/);
  });

  it('x.* needs x to be an object', () => {
    const loose = [{ contact: 'none' }] as unknown as Person[];
    expect(() => ListQuery.from(loose).select('contact.*').toList()).toThrow(/needs "contact" to be an object/);
  });

  it('an attribute that exists with value undefined is not missing', () => {
    const rows = [{ a: undefined as string | undefined }];
    expect(ListQuery.from(rows).select('a').toList()).toEqual([undefined]);
  });

  it('select(item => value) stays for a computed value', () => {
    expect(ListQuery.from(people).select(person => `${person.name}:${person.age}`).toList()).toEqual(['Ann:12', 'Bob:14']);
  });

  it('filters run on the source rows even when select comes first', () => {
    expect(ListQuery.from(people).select('name').where('age', '>', 12).toList()).toEqual(['Bob']);
  });

  it('works with first, some and toHolder on the selected shape', () => {
    expect(ListQuery.from(people).where('age', '>', 12).select('name').first()).toBe('Bob');
    expect(ListQuery.from(people).select('name', 'age').toHolder('name')).toEqual({
      Ann: { name: 'Ann', age: 12 },
      Bob: { name: 'Bob', age: 14 },
    });
  });
});
