import { describe, expect, it } from 'vitest';
import { ListQuery } from '../src';
import { getPath, pathReader } from '../src/core/path';

const order = { id: 'o1', total: 30, customer: { name: 'Ann', address: { city: 'Lyon' } }, tags: ['a', 'b'], gone: null };

describe('getPath', () => {
  it('reads a field and a dotted path', () => {
    expect(getPath(order, 'id')).toBe('o1');
    expect(getPath(order, 'customer.address.city')).toBe('Lyon');
    expect(getPath(order, 'customer')).toBe(order.customer);
  });

  it('a step that leads nowhere is undefined, not an error', () => {
    expect(getPath(order, 'nope')).toBeUndefined();
    expect(getPath(order, 'nope.deeper.still')).toBeUndefined();
    expect(getPath(order, 'customer.phone.number')).toBeUndefined();
    expect(getPath(order, 'gone.anything')).toBeUndefined();
    expect(getPath(order, 'total.anything')).toBeUndefined();
  });

  it('a missing value has no fields', () => {
    expect(getPath(undefined, 'id')).toBeUndefined();
    expect(getPath(null, 'a.b')).toBeUndefined();
  });

  it('reads an array element by index, and null as itself', () => {
    expect(getPath(order, 'tags.1')).toBe('b');
    expect(getPath(order, 'gone')).toBeNull();
  });

  it('keeps answering correctly after more distinct paths than it remembers', () => {
    const value = { a: { b: 1 } };
    for (let i = 0; i < 2000; i++) expect(getPath({ [`field${i}`]: i }, `field${i}`)).toBe(i);
    expect(getPath(value, 'a.b')).toBe(1);
    expect(getPath(order, 'customer.address.city')).toBe('Lyon');
  });
});

describe('pathReader', () => {
  it('reads what getPath reads, for the same path, on any value', () => {
    const values: unknown[] = [order, order.customer, undefined, null, 'text', 4, [1, 2], {}];
    for (const path of ['id', 'customer.address.city', 'tags.0', 'nope', 'a.b.c', 'length']) {
      const read = pathReader(path);
      for (const value of values) expect(read(value)).toEqual(getPath(value, path));
    }
  });

  it('can be built once and used on many rows', () => {
    const city = pathReader('customer.address.city');
    expect([order, { customer: {} }, { customer: { address: { city: 'Nice' } } }].map(city)).toEqual(['Lyon', undefined, 'Nice']);
  });
});

describe('queries on nested fields use the same paths', () => {
  const rows = [
    { id: 1, customer: { address: { city: 'Nice' } } },
    { id: 2, customer: { address: { city: 'Lyon' } } },
    { id: 3, customer: {} },
    { id: 4 },
    { id: 5, customer: { address: { city: 'Lyon' } } },
  ];

  it('where, orderBy and select agree on a dotted path, and on rows that lack it', () => {
    expect(ListQuery.from(rows).where('customer.address.city', '==', 'Lyon').select('id').toList()).toEqual([2, 5]);
    expect(ListQuery.from(rows).orderBy('customer.address.city').select('id').toList()).toEqual([3, 4, 2, 5, 1]);
    expect(ListQuery.from(rows).select({ id: 'id', city: 'customer.address.city' }).toList()).toEqual([
      { id: 1, city: 'Nice' },
      { id: 2, city: 'Lyon' },
      { id: 3, city: undefined },
      { id: 4, city: undefined },
      { id: 5, city: 'Lyon' },
    ]);
  });
});
