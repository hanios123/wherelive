import { describe, expect, it } from 'vitest';
import { ListQuery } from '../src';

interface Row {
  id: number;
  region: string;
  total?: number;
  tags: string[];
}

const rows: Row[] = [
  { id: 1, region: 'north', total: 10, tags: [] },
  { id: 2, region: 'north', total: 30, tags: [] },
  { id: 3, region: 'south', total: 5, tags: [] },
  { id: 4, region: 'south', tags: [] },
  { id: 5, region: 'south', total: 5, tags: [] },
];

describe('count() counts rows, not what select makes of them', () => {
  it('gives the same number with and without a select', () => {
    const base = ListQuery.from(rows).where('region', '==', 'south');
    expect(base.select('id').count()).toBe(3);
    expect(base.select({ id: 'id', total: 'total' }).count()).toBe(3);
    expect(base.select(row => row.total).count()).toBe(3);
    expect(base.count()).toBe(3);
  });

  it('does not run the select function', () => {
    let ran = 0;
    expect(
      ListQuery.from(rows)
        .select(row => (ran++, row.id))
        .count(),
    ).toBe(5);
    expect(ran).toBe(0);
  });

  it('still honours where, offset and limit', () => {
    expect(ListQuery.from(rows).select('id').offset(1).limit(3).count()).toBe(3);
    expect(ListQuery.from(rows).where('region', '==', 'north').orderBy('total', 'desc').select('id').limit(1).count()).toBe(1);
    expect(ListQuery.from(rows).select('id').limitToLast(2).count()).toBe(2);
  });

  it('counts different selected values when the query is distinct', () => {
    expect(ListQuery.from(rows).select('region').distinct().count()).toBe(2);
    expect(ListQuery.from(rows).select({ total: 'total' }).distinct().count()).toBe(4);
    expect(ListQuery.from(rows).select('region').distinct().offset(1).count()).toBe(1);
  });

  it('does not fail over an attribute some rows lack, because it never reads it; toList() still does', () => {
    const query = ListQuery.from(rows).select('total');
    expect(query.count()).toBe(5);
    expect(() => query.toList()).toThrow('attribute "total" is missing');
    expect(() => query.distinct().count()).toThrow('attribute "total" is missing'); // distinct compares the values, so it reads them
  });

  it('agrees with toList().length for a mix of queries', () => {
    const queries = [
      ListQuery.from(rows).select('region').distinct(),
      ListQuery.from(rows).where('total', '>', 5).select('id'),
      ListQuery.from(rows).orderBy('total').limit(2).select('id', 'region'),
      ListQuery.from(rows).select({ r: 'region' }).distinct().limit(1),
    ];
    for (const query of queries) expect(query.count()).toBe(query.toList().length);
  });
});

describe('aggregate() over the whole list', () => {
  const totals = (list: Row[]) => ListQuery.from(list).aggregate(a => ({ n: a.count(), total: a.sum('total'), most: a.max('total'), least: a.min('total'), seen: a.count('total') })).first();

  it('is one row of totals', () => {
    expect(totals(rows)).toEqual({ n: 5, total: 50, most: 30, least: 5, seen: 4 });
  });

  it('is still one row for an empty list, with nothing to total', () => {
    expect(totals([])).toEqual({ n: 0, total: 0, most: undefined, least: undefined, seen: 0 });
  });

  it('follows the filters before it', () => {
    expect(ListQuery.from(rows).where('region', '==', 'north').aggregate(a => ({ n: a.count(), total: a.sum('total') })).first()).toEqual({ n: 2, total: 40 });
  });

  it('collects every row in order', () => {
    expect(ListQuery.from(rows).aggregate(a => ({ ids: a.collect('id') })).first()).toEqual({ ids: [1, 2, 3, 4, 5] });
  });

  it('with keys it still groups, in the order first seen', () => {
    expect(ListQuery.from(rows).groupBy('region').aggregate(a => ({ n: a.count(), total: a.sum('total') })).toList()).toEqual([
      { region: 'north', n: 2, total: 40 },
      { region: 'south', n: 3, total: 10 },
    ]);
  });
});
