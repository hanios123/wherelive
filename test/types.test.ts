import type { Observable } from 'rxjs';
import { describe, expectTypeOf, it } from 'vitest';
import { ListQuery, collectionGroup, leaf, pathOf, schema, type AttributeChange, type RowChange } from '../src';
import { observe } from '../src/rxjs';
import { definition, type Customer } from './fixtures';

// This file is checked by `tsc --noEmit`. A `@ts-expect-error` that stops failing is itself an error,
// so these lines prove the compile errors the README promises.

interface Participant {
  name: string;
  tier: string;
  age: number;
  tags: string[];
  contact: { email: string; phone: string };
  nickname?: string;
}

/** The body is compiled by tsc and never run, so nothing here needs a backend or a database. */
const typeOnly = (check: () => void): void => {
  void check;
};

describe('types on the query', () => {
  it('where only accepts keys of the row and values of the field type', () =>
    typeOnly(() => {
    const query = ListQuery.from<Participant>([]);
    query.where('tier', '==', 'gold');
    // @ts-expect-error 'tir' is not a key
    query.where('tir', '==', 'gold');
    // @ts-expect-error age is a number
    query.where('age', '>', '11');
    }));

  it('whereIncludes only accepts array fields and their element type', () =>
    typeOnly(() => {
    const query = ListQuery.from<Participant>([]);
    query.whereIncludes('tags', 'x');
    // @ts-expect-error tier is not an array
    query.whereIncludes('tier', 'x');
    // @ts-expect-error tags holds strings
    query.whereIncludes('tags', 1);
    }));

  it('select names are checked and typed', () =>
    typeOnly(() => {
    const query = ListQuery.from<Participant>([]);
    expectTypeOf(query.select('name').toList()).toEqualTypeOf<string[]>();
    expectTypeOf(query.select('age').toList()).toEqualTypeOf<number[]>();
    expectTypeOf(query.select('name', 'age').toList()).toEqualTypeOf<{ name: string; age: number }[]>();
    expectTypeOf(query.select('name', 'age', 'contact.*').toList()).toEqualTypeOf<
      { name: string; age: number; email: string; phone: string }[]
    >();
    expectTypeOf(query.select('contact.*').toList()).toEqualTypeOf<{ email: string; phone: string }[]>();
    expectTypeOf(query.select('*').toList()).toEqualTypeOf<Participant[]>();
    expectTypeOf(query.select(row => row.age * 2).toList()).toEqualTypeOf<number[]>();
    // @ts-expect-error there is no attribute called nam
    query.select('nam');
    // @ts-expect-error a string cannot be spread
    query.select('name.*');
    // @ts-expect-error an array cannot be spread
    query.select('tags.*');
    }));

  it('toHolder only accepts string or number keys', () =>
    typeOnly(() => {
    const query = ListQuery.from<Participant>([]);
    query.toHolder('name');
    query.toHolder('age');
    // @ts-expect-error tags is an array
    query.toHolder('tags');
    }));

  it('when hands the present value to the clause', () =>
    typeOnly(() => {
    ListQuery.from<Participant>([]).when(undefined as string | undefined, (query, tier) => {
      expectTypeOf(tier).toEqualTypeOf<string>();
      return query.where('tier', '==', tier);
    });
    }));
});

describe('types on double loops', () => {
  it('flatMap, pairs, combine and toSet carry their row types', () =>
    typeOnly(() => {
      const query = ListQuery.from<Participant>([]);
      expectTypeOf(query.flatMap(row => row.tags).toList()).toEqualTypeOf<string[]>();
      expectTypeOf(query.flatMap(() => ListQuery.from<{ sku: string }>([]).select('sku')).toList()).toEqualTypeOf<string[]>();
      expectTypeOf(query.select('tags').flatMap(tags => tags).toList()).toEqualTypeOf<string[]>();
      expectTypeOf(query.select('name').toSet()).toEqualTypeOf<Set<string>>();
      expectTypeOf(ListQuery.pairs([1], ['a']).toList()).toEqualTypeOf<[number, string][]>();
      expectTypeOf(ListQuery.combine({ region: ['eu'], count: [1, 2] }).toList()).toEqualTypeOf<{ region: string; count: number }[]>();
      // the result is a query over the inner rows, so where is checked against them
      ListQuery.combine({ region: ['eu'] }).where('region', '==', 'eu');
      // @ts-expect-error there is no list called reg
      ListQuery.combine({ region: ['eu'] }).where('reg', '==', 'eu');
      // @ts-expect-error region holds strings
      ListQuery.combine({ region: ['eu'] }).where('region', '==', 1);
      // @ts-expect-error combine takes lists, not single values
      ListQuery.combine({ region: 'eu' });
    }));
});

describe('types on decoding, paths and observe', () => {
  const db = schema({
    ...definition,
    stats: {
      ids: leaf<string[]>().decode(ids => new Set(ids ?? [])),
      audited: leaf<{ a: number; b: string; createdBy: string }>().except('createdBy'),
      chained: leaf<string[]>().decode(ids => (ids ?? []).length).decode(n => `${n} items`),
    },
    things: (id: string) => leaf<{ a: number }>().decode(raw => raw?.a ?? 0),
  });

  it('a decoded leaf reports what the decoder returned, and has no select', () =>
    typeOnly(() => {
      db.stats.ids.listen(ids => {
        expectTypeOf(ids).toEqualTypeOf<Set<string>>();
      });
      db.stats.chained.listen(text => {
        expectTypeOf(text).toEqualTypeOf<string>();
      });
      // @ts-expect-error a decoded leaf is listened to whole
      db.stats.ids.select('a');
    }));

  it('except takes keys of the value and removes them from the type', () =>
    typeOnly(() => {
      db.stats.audited.listen(value => {
        expectTypeOf(value).toEqualTypeOf<Omit<{ a: number; b: string; createdBy: string }, 'createdBy'> | undefined>();
      });
      leaf<{ a: number }>().except('a');
      // @ts-expect-error z is not a key
      leaf<{ a: number }>().except('z');
    }));

  it('decode on a raw leaf receives the value or undefined; a later decode receives the earlier result', () =>
    typeOnly(() => {
      leaf<string[]>().decode(raw => {
        expectTypeOf(raw).toEqualTypeOf<string[] | undefined>();
        return raw;
      });
      leaf<string[]>()
        .decode(raw => (raw ?? []).length)
        .decode(count => {
          expectTypeOf(count).toEqualTypeOf<number>();
          return count;
        });
    }));

  it('a list of decoded leaves is callable per id but has no list methods', () =>
    typeOnly(() => {
      db.things('1').listen(value => {
        expectTypeOf(value).toEqualTypeOf<number>();
      });
      // @ts-expect-error a decoded leaf cannot be a list
      db.things.where('a', '==', 1);
    }));

  it('pathOf returns a string and observe returns an Observable of what listen gives', () =>
    typeOnly(() => {
      expectTypeOf(pathOf(db.stats.ids)).toEqualTypeOf<string>();
      expectTypeOf(observe(db.summaries.store('a').productIds)).toEqualTypeOf<Observable<string[] | undefined>>();
      expectTypeOf(observe(db.stats.ids)).toEqualTypeOf<Observable<Set<string>>>();
      expectTypeOf(observe(db.customers.select('name'))).toEqualTypeOf<Observable<RowChange<Customer, 'name'>>>();
      // @ts-expect-error something without listen cannot be observed
      observe({});
    }));
});

describe('types on the SQL constructs', () => {
  interface Sale {
    id: number;
    region: string;
    price: number;
    qty?: number | null;
    tags: string[];
    customer: { name: string; address: { city: string } };
  }
  interface Buyer {
    id: string;
    tier: string;
  }

  it('dotted paths are checked in where, orderBy and whereIn', () =>
    typeOnly(() => {
      const query = ListQuery.from<Sale>([]);
      query.where('customer.name', '==', 'x');
      query.where('customer.address.city', '==', 'x');
      query.orderBy('customer.address.city', 'desc').orderBy('id').limit(3).offset(1);
      query.whereIn('id', [1, 2]).whereNotIn('region', ['eu']);
      query.whereIncludes('tags', 'x');
      // @ts-expect-error customer has no field nam
      query.where('customer.nam', '==', 'x');
      // @ts-expect-error the name is a string
      query.where('customer.name', '==', 1);
      // @ts-expect-error there is no such field to order by
      query.orderBy('nope');
      // @ts-expect-error ids are numbers
      query.whereIn('id', ['a']);
      // @ts-expect-error limit takes a number
      query.limit('3');
    }));

  it('select({ alias: path | fn }) is typed from the paths and functions', () =>
    typeOnly(() => {
      const rows = ListQuery.from<Sale>([])
        .select({ id: 'id', city: 'customer.address.city', label: sale => `${sale.id}:${sale.region}` })
        .toList();
      expectTypeOf(rows).toEqualTypeOf<{ id: number; city: string; label: string }[]>();
      // @ts-expect-error not a path
      ListQuery.from<Sale>([]).select({ bad: 'customer.nope' });
    }));

  it('groupBy and aggregate return the keys and the aggregates, typed', () =>
    typeOnly(() => {
      const rows = ListQuery.from<Sale>([])
        .groupBy('region')
        .aggregate(a => ({ n: a.count(), total: a.sum('price'), avgQty: a.avg('qty'), top: a.max('price'), rows: a.collect(), ids: a.collect('id') }))
        .toList();
      expectTypeOf(rows).toEqualTypeOf<
        { region: string; n: number; total: number; avgQty: number | undefined; top: number | undefined; rows: Sale[]; ids: number[] }[]
      >();
      expectTypeOf(ListQuery.from<Sale>([]).aggregate(a => ({ n: a.count() })).toList()).toEqualTypeOf<{ n: number }[]>();
      // where after aggregate is checked against the group row
      ListQuery.from<Sale>([]).groupBy('region').aggregate(a => ({ n: a.count() })).where('n', '>', 1).orderBy('n', 'desc');
      // @ts-expect-error region is text, so it cannot be summed
      ListQuery.from<Sale>([]).aggregate(a => ({ bad: a.sum('region') }));
      // @ts-expect-error there is no such key to group by
      ListQuery.from<Sale>([]).groupBy('nope');
      // @ts-expect-error the group row has n, not m
      ListQuery.from<Sale>([]).groupBy('region').aggregate(a => ({ n: a.count() })).where('m', '>', 1);
    }));

  it('union takes rows of the same shape, and a key that is a path of that shape', () =>
    typeOnly(() => {
      const sales = ListQuery.from<Sale>([]);
      expectTypeOf(sales.union([] as Sale[], 'customer.name').toList()).toEqualTypeOf<Sale[]>();
      expectTypeOf(sales.unionAll(sales).toList()).toEqualTypeOf<Sale[]>();
      expectTypeOf(sales.select('id').union([1, 2]).toList()).toEqualTypeOf<number[]>();
      // @ts-expect-error the other list must hold the same rows
      sales.union([] as Buyer[]);
      // @ts-expect-error a key must be a path of the row
      sales.union([] as Sale[], 'nope');
    }));

  it('a select before groupBy changes the rows it groups', () =>
    typeOnly(() => {
      const rows = ListQuery.from<Sale>([])
        .select({ city: 'customer.address.city', price: 'price' })
        .groupBy('city')
        .aggregate(a => ({ total: a.sum('price') }))
        .toList();
      expectTypeOf(rows).toEqualTypeOf<{ city: string; total: number }[]>();
    }));

  it('joins return { left, right }, and leftJoin makes right optional', () =>
    typeOnly(() => {
      const inner = ListQuery.from<Sale>([]).innerJoin([] as Buyer[], 'customer.name', 'id');
      expectTypeOf(inner.toList()).toEqualTypeOf<{ left: Sale; right: Buyer }[]>();
      expectTypeOf(ListQuery.from<Sale>([]).leftJoin([] as Buyer[], 'id', 'tier').toList()).toEqualTypeOf<{ left: Sale; right: Buyer | undefined }[]>();
      expectTypeOf(ListQuery.from<Sale>([]).rightJoin([] as Buyer[], 'id', 'tier').toList()).toEqualTypeOf<{ left: Sale | undefined; right: Buyer }[]>();
      expectTypeOf(ListQuery.from<Sale>([]).outerJoin([] as Buyer[], 'id', 'tier').toList()).toEqualTypeOf<
        { left: Sale | undefined; right: Buyer | undefined }[]
      >();
      // @ts-expect-error Buyer has no field nope
      ListQuery.from<Sale>([]).rightJoin([] as Buyer[], 'id', 'nope');
      // @ts-expect-error Sale has no field nope
      ListQuery.from<Sale>([]).outerJoin([] as Buyer[], 'nope', 'id');
      // @ts-expect-error Buyer has no field nope
      ListQuery.from<Sale>([]).innerJoin([] as Buyer[], 'id', 'nope');
      // @ts-expect-error Sale has no field nope
      ListQuery.from<Sale>([]).innerJoin([] as Buyer[], 'nope', 'id');
    }));
});

describe('types on reading', () => {
  interface Doc {
    name: string;
    age: number;
    contact: { city: string };
  }
  const db = schema({
    docs: (id: string) => leaf<Doc>(),
    ids: leaf<string[]>(),
    labels: (id: string) => leaf<Doc>().decode(raw => raw?.name ?? ''),
  });

  it('get() resolves to what the handle holds', () =>
    typeOnly(() => {
      expectTypeOf(db.ids.get()).toEqualTypeOf<Promise<string[] | undefined>>();
      expectTypeOf(db.docs('1').get()).toEqualTypeOf<Promise<Doc | undefined>>();
      expectTypeOf(db.labels('1').get()).toEqualTypeOf<Promise<string>>();
      expectTypeOf(db.docs('1').select('*').get()).toEqualTypeOf<Promise<Doc | undefined>>();
      // @ts-expect-error a selection of attributes is listened to, not read as a whole
      db.docs('1').select('name').get();
    }));

  it('a list get() resolves to the rows the query selects', () =>
    typeOnly(() => {
      expectTypeOf(db.docs.get()).toEqualTypeOf<Promise<Doc[]>>();
      expectTypeOf(db.docs.where('contact.city', '==', 'x').orderBy('age', 'desc').limit(5).get()).toEqualTypeOf<Promise<Doc[]>>();
      expectTypeOf(db.docs.select('name').get()).toEqualTypeOf<Promise<string[]>>();
      expectTypeOf(db.docs.select({ who: 'name', city: 'contact.city' }).get()).toEqualTypeOf<Promise<{ who: string; city: string }[]>>();
      expectTypeOf(db.docs.select(doc => doc.age * 2).get()).toEqualTypeOf<Promise<number[]>>();
      db.docs.whereIn('name', ['a']).whereNotIn('age', [1]).offset(2).distinct();
      // @ts-expect-error there is no such field
      db.docs.where('nope', '==', 1);
      // @ts-expect-error ages are numbers
      db.docs.whereIn('age', ['a']);
    }));

  it('withKey adds the key to the row type, and select can pick it', () =>
    typeOnly(() => {
      expectTypeOf(db.docs.withKey('$key').get()).toEqualTypeOf<Promise<(Doc & { $key: string })[]>>();
      expectTypeOf(db.docs.withKey('$key').select('$key', 'name').get()).toEqualTypeOf<Promise<{ $key: string; name: string }[]>>();
      // @ts-expect-error the key only exists after withKey
      db.docs.select('$key');
    }));

  it('a computed or aliased select cannot be listened to; attribute names can', () =>
    typeOnly(() => {
      db.docs.select('name', 'age').listen(change => {
        expectTypeOf(change.key).toEqualTypeOf<string>();
      });
      // @ts-expect-error a computed select has no attribute to report
      db.docs.select(doc => doc.age).listen(() => {});
      // @ts-expect-error nor does an aliased one
      db.docs.select({ who: 'name' }).subscribe(() => {});
    }));
});

describe('types on the Firebase query features', () => {
  interface Doc {
    name: string;
    age: number;
    tags: string[];
    contact: { city: string };
  }
  interface Line {
    sku: string;
    qty: number;
  }
  const db = schema({ docs: (id: string) => leaf<Doc>(), lines: collectionGroup<Line>(), one: leaf<Doc>() });

  it('array-contains-any, or, and orWhere are checked against the row', () =>
    typeOnly(() => {
      db.docs.whereIncludesAny('tags', ['a', 'b']);
      db.docs.whereAny(a => a.where('age', '>', 1), b => b.where('contact.city', '==', 'x').whereIn('name', ['a']));
      db.docs.where('age', '>', 1).orWhere('age', '<', 0).orWhere(doc => doc.name === 'x');
      ListQuery.from<Doc>([]).whereAny(a => a.where('age', '>', 1)).orWhere('name', '==', 'x');
      // @ts-expect-error tags holds text
      db.docs.whereIncludesAny('tags', [1]);
      // @ts-expect-error name is not an array
      db.docs.whereIncludesAny('name', ['a']);
      // @ts-expect-error nope is not a field, inside an alternative too
      db.docs.whereAny(a => a.where('nope', '==', 1));
      // @ts-expect-error an alternative is conditions only: it has no select
      db.docs.whereAny(a => a.select('name'));
      // @ts-expect-error the value must have the field's type
      db.docs.where('age', '>', 1).orWhere('age', '<', 'zero');
    }));

  it('cursors, limitToLast and reading from a chosen source', () =>
    typeOnly(() => {
      db.docs.orderBy('age').orderBy('name').startAfter(30, 'N05').endBefore(40).limit(10);
      db.docs.orderBy('age').startAt(30).endAt(40).limitToLast(5);
      expectTypeOf(db.docs.orderBy('age').limitToLast(5).get()).toEqualTypeOf<Promise<Doc[]>>();
      db.docs.get('loadDocs');
      db.docs.get({ identifier: 'loadDocs', source: 'server' });
      db.one.get({ source: 'cache' });
      // @ts-expect-error a source is server, cache or default
      db.docs.get({ source: 'elsewhere' });
      // @ts-expect-error limitToLast takes a number
      db.docs.limitToLast('5');
    }));

  it('count and aggregate resolve to typed numbers, and sum only takes numeric fields', () =>
    typeOnly(() => {
      expectTypeOf(db.docs.where('age', '>', 1).count()).toEqualTypeOf<Promise<number>>();
      expectTypeOf(db.docs.aggregate(a => ({ n: a.count(), total: a.sum('age'), mean: a.avg('age'), oldest: a.max('age') }))).toEqualTypeOf<
        Promise<{ n: number; total: number; mean: number | undefined; oldest: number | undefined }>
      >();
      // @ts-expect-error a name cannot be summed
      db.docs.aggregate(a => ({ bad: a.sum('name') }));
      // @ts-expect-error nope is not a field
      db.docs.aggregate(a => ({ bad: a.max('nope') }));
    }));

  it('a collection group is a list you query but do not call with an id', () =>
    typeOnly(() => {
      expectTypeOf(db.lines.where('sku', '==', 'a').orderBy('qty').get()).toEqualTypeOf<Promise<Line[]>>();
      expectTypeOf(db.lines.withKey('$key').get()).toEqualTypeOf<Promise<(Line & { $key: string })[]>>();
      collectionGroup<Line>('lines');
      // @ts-expect-error a group has no id to call it with
      db.lines('x');
      // @ts-expect-error qty is a number
      db.lines.where('qty', '==', 'many');
    }));
});

describe('types on the chain', () => {
  const db = schema(definition);

  it('a leaf is a real type and a wrong node is a compile error', () =>
    typeOnly(() => {
    db.summaries.store('store').productIds.listen(ids => {
      expectTypeOf(ids).toEqualTypeOf<string[] | undefined>();
    });
    db.summaries.store('store').featuredIds;
    // @ts-expect-error productId is a typo
    db.summaries.store('store').productId.listen(() => {});
    // @ts-expect-error there is no such segment
    db.summarie;
    // @ts-expect-error a function segment must be called with an id before its children exist
    db.summaries.store.productIds;
    }));

  it('an array leaf has no select', () =>
    typeOnly(() => {
    // @ts-expect-error a list of strings has no attributes to select
    db.summaries.store('store').productIds.select('name');
    }));

  it('select on a node reports typed attribute changes', () =>
    typeOnly(() => {
    db.customers('1')
      .select('name', 'age', 'contact.*')
      .listen(change => {
        expectTypeOf(change).toEqualTypeOf<AttributeChange<Customer, 'name' | 'age' | 'contact.*'>>();
        if (change.attribute === 'name') expectTypeOf(change.value).toEqualTypeOf<string | undefined>();
        if (change.attribute === 'age') expectTypeOf(change.value).toEqualTypeOf<number | undefined>();
        if (change.attribute === 'contact.email') expectTypeOf(change.value).toEqualTypeOf<string | undefined>();
        // @ts-expect-error contact.uncle does not exist
        if (change.attribute === 'contact.uncle') return;
      });
    // @ts-expect-error nam is not an attribute
    db.customers('1').select('nam');
    }));

  it('select("*") on a node listens to the whole value', () =>
    typeOnly(() => {
    db.customers('1')
      .select('*')
      .listen(customer => {
        expectTypeOf(customer).toEqualTypeOf<Customer | undefined>();
      });
    db.customers('1').listen(customer => {
      expectTypeOf(customer).toEqualTypeOf<Customer | undefined>();
    });
    }));

  it('a keyed list is a typed query as well as a function', () =>
    typeOnly(() => {
    db.customers('1');
    db.customers.where('tier', '==', 'gold');
    // @ts-expect-error tir is not a key of Customer
    db.customers.where('tir', '==', 'gold');
    expectTypeOf(db.customers.select('name', 'age').from([] as Customer[])).toEqualTypeOf<{ name: string; age: number }[]>();
    db.customers.select('name', 'age').listen(change => {
      expectTypeOf(change).toEqualTypeOf<RowChange<Customer, 'name' | 'age'>>();
      expectTypeOf(change.key).toEqualTypeOf<string>();
    });
    }));

  it('a function that returns objects is not a list', () =>
    typeOnly(() => {
    // @ts-expect-error store returns a set of leaves, not a leaf
    db.summaries.store.where('productIds', '==', []);
    }));
});
