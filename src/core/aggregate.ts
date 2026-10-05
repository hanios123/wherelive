import { compareValues, stableKey } from './compare';
import { getPath } from './path';
import type { NumberPath, Path, PathValue } from './types';

/** One aggregate in a `GROUP BY`: `count()`, `sum('price')` and friends, made by the `a` you are handed. */
export interface Aggregate<V> {
  /** Type-only. There is no such property at runtime. */
  readonly __result?: V;
  /** Set when a database can run this aggregate without reading the rows: `count()`, `sum(field)`, `avg(field)`. */
  readonly native?: { readonly op: 'count' } | { readonly op: 'sum' | 'avg'; readonly field: string };
  readonly init: () => unknown;
  readonly step: (state: any, row: any) => unknown;
  readonly done: (state: any) => V;
}

/**
 * The aggregates for rows of type `T`. Missing and `null` values are ignored,
 * as SQL ignores NULL. `sum` of nothing is `0`. `avg`, `min` and `max` of nothing are `undefined`.
 */
export interface Aggregates<T> {
  /** `COUNT(*)`: the rows in the group. */
  count(): Aggregate<number>;
  /** `COUNT(field)`: the rows where the field is present. */
  count<P extends Path<T>>(field: P): Aggregate<number>;
  sum<P extends NumberPath<T>>(field: P): Aggregate<number>;
  avg<P extends NumberPath<T>>(field: P): Aggregate<number | undefined>;
  min<P extends Path<T>>(field: P): Aggregate<PathValue<T, P> | undefined>;
  max<P extends Path<T>>(field: P): Aggregate<PathValue<T, P> | undefined>;
  /** Every row of the group, in the order they came. This is how you bucket rows by a key. */
  collect(): Aggregate<T[]>;
  /** The field of every row of the group, in the order they came. */
  collect<P extends Path<T>>(field: P): Aggregate<PathValue<T, P>[]>;
}

const present = (value: unknown): boolean => value !== undefined && value !== null;

function extreme(field: string, sign: 1 | -1): Aggregate<unknown> {
  return {
    init: () => ({ has: false, value: undefined as unknown }),
    step: (state: { has: boolean; value: unknown }, row) => {
      const value = getPath(row, field);
      if (!present(value)) return state;
      if (!state.has || compareValues(value, state.value) * sign > 0) return { has: true, value };
      return state;
    },
    done: (state: { has: boolean; value: unknown }) => (state.has ? state.value : undefined),
  };
}

export function createAggregates<T>(): Aggregates<T> {
  const aggregates = {
    count: (field?: string): Aggregate<number> => ({
      native: field === undefined ? { op: 'count' } : undefined,
      init: () => 0,
      step: (count: number, row) => (field === undefined || present(getPath(row, field)) ? count + 1 : count),
      done: count => count,
    }),
    sum: (field: string): Aggregate<number> => ({
      native: { op: 'sum', field },
      init: () => 0,
      step: (total: number, row) => {
        const value = getPath(row, field);
        return typeof value === 'number' ? total + value : total;
      },
      done: total => total,
    }),
    avg: (field: string): Aggregate<number | undefined> => ({
      native: { op: 'avg', field },
      init: () => ({ total: 0, n: 0 }),
      step: (state: { total: number; n: number }, row) => {
        const value = getPath(row, field);
        return typeof value === 'number' ? { total: state.total + value, n: state.n + 1 } : state;
      },
      done: (state: { total: number; n: number }) => (state.n > 0 ? state.total / state.n : undefined),
    }),
    min: (field: string) => extreme(field, -1),
    max: (field: string) => extreme(field, 1),
    collect: (field?: string): Aggregate<unknown[]> => ({
      init: () => [] as unknown[],
      step: (list: unknown[], row) => (list.push(field === undefined ? row : getPath(row, field)), list),
      done: list => list,
    }),
  };
  return aggregates as unknown as Aggregates<T>;
}

/**
 * `GROUP BY keys`, one output row per distinct key in the order first seen, each
 * holding the key values and the aggregates. With no keys it is one row over the
 * whole list, even an empty one, as `SELECT COUNT(*)` is.
 */
export function* aggregateRows(
  rows: Iterable<unknown>,
  keys: readonly string[],
  spec: Readonly<Record<string, Aggregate<unknown>>>,
): Generator<Record<string, unknown>, void, undefined> {
  const names = Object.keys(spec);
  const aggregates = names.map(name => spec[name] as Aggregate<unknown>);
  const groups = new Map<string, { keyValues: unknown[]; states: unknown[] }>();
  const open = (keyValues: unknown[]) => ({ keyValues, states: aggregates.map(aggregate => aggregate.init()) });

  for (const row of rows) {
    // With no keys there is one group, so there is nothing to build a key from.
    const keyValues = keys.length === 0 ? [] : keys.map(key => getPath(row, key));
    const id = keys.length === 0 ? '' : stableKey(keyValues);
    let group = groups.get(id);
    if (!group) groups.set(id, (group = open(keyValues)));
    for (let i = 0; i < aggregates.length; i++) group.states[i] = (aggregates[i] as Aggregate<unknown>).step(group.states[i], row);
  }
  if (keys.length === 0 && groups.size === 0) groups.set('', open([]));

  for (const group of groups.values()) {
    const out: Record<string, unknown> = {};
    keys.forEach((key, i) => (out[key] = group.keyValues[i]));
    names.forEach((name, i) => (out[name] = (aggregates[i] as Aggregate<unknown>).done(group.states[i])));
    yield out;
  }
}
