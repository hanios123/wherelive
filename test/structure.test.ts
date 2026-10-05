import { describe, expect, it } from 'vitest';
import { ListQuery, firestoreBackend, leaf, schema } from '../src';
import { CollectionQuery } from '../src/schema/collection';
import { QueryBuilder } from '../src/core/query-builder';
import { MemoryFirestoreTransport } from '../src/testing';

/** Public methods on a class and everything it inherits: the ones that do not start with `_`. */
function publicMethods(prototype: object): string[] {
  const names = new Set<string>();
  for (let level: object | null = prototype; level && level !== Object.prototype; level = Object.getPrototypeOf(level)) {
    for (const name of Object.getOwnPropertyNames(level)) {
      if (name === 'constructor' || name.startsWith('_')) continue;
      if (typeof Object.getOwnPropertyDescriptor(level, name)?.value === 'function') names.add(name);
    }
  }
  return [...names].sort();
}

const builders = publicMethods(QueryBuilder.prototype);

describe('a builder method is written once', () => {
  it('there are builder methods to share', () => {
    expect(builders).toEqual(
      expect.arrayContaining(['where', 'whereIn', 'whereAny', 'orWhere', 'orderBy', 'limit', 'limitToLast', 'startAfter', 'when', 'distinct', 'from']),
    );
  });

  it.each(builders)('%s is the same function on an array query and on a database list', name => {
    const shared = (QueryBuilder.prototype as unknown as Record<string, unknown>)[name];
    expect((ListQuery.prototype as unknown as Record<string, unknown>)[name]).toBe(shared);
    expect((CollectionQuery.prototype as unknown as Record<string, unknown>)[name]).toBe(shared);
  });

  it('the only names both classes define themselves are the ones that mean something different on each', () => {
    const own = (prototype: object) => publicMethods(prototype).filter(name => !builders.includes(name));
    const both = own(ListQuery.prototype).filter(name => own(CollectionQuery.prototype).includes(name));
    // select returns a different kind of query. count and aggregate answer at once on an array and by promise on a
    // database. A new name that lands here should be a decision, not a copy of a builder method.
    expect(both).toEqual(['aggregate', 'count', 'select']);
  });
});

describe('a schema list handle', () => {
  const transport = new MemoryFirestoreTransport();
  const db = schema({ orders: (id: string) => leaf<{ total: number }>() }, firestoreBackend(transport));
  const handle = db.orders as unknown as Record<string, unknown>;

  it.each(publicMethods(CollectionQuery.prototype))('exposes %s', name => {
    expect(typeof handle[name]).toBe('function');
  });

  it('does not expose the internals', () => {
    for (const name of ['_rebuild', '_with', '_derive', '_request', '_listener', 'context', 'plan', 'keyField']) {
      expect(handle[name], name).toBeUndefined();
    }
  });

  it('keeps being called with an id like a function', () => {
    expect(typeof db.orders).toBe('function');
    expect(typeof db.orders('o1').get).toBe('function');
  });
});

describe('the array and the database list agree on the rows', () => {
  it('the same chain, built once for each, has the same plan', () => {
    const chain = (q: any) => q.where('total', '>', 1).whereIn('total', [2, 3]).orderBy('total', 'desc').limit(2).startAfter(9);
    const transport = new MemoryFirestoreTransport();
    const list = chain(ListQuery.fromType<{ total: number }>());
    const collection = chain(schema({ orders: (id: string) => leaf<{ total: number }>() }, firestoreBackend(transport)).orders);
    expect(collection.plan).toEqual(list.plan);
  });
});
