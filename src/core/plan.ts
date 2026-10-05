import { comparableOrder, compareValues, stableKey } from './compare';
import { valuesEqual } from './equality';
import { firstRows } from './first-rows';
import { getPath, pathReader } from './path';
import type { Comparison } from './types';

/**
 * A query is data first. Executors (the in-memory one below, the database ones
 * in `realtime/` and `firestore/`) read the same plan and decide which parts
 * they run themselves. Fields are names or dotted paths: `'city'`, `'customer.address.city'`.
 */
export type Clause<T = any> =
  | { readonly kind: 'compare'; readonly field: string; readonly op: Comparison; readonly value: unknown }
  | { readonly kind: 'includes'; readonly field: string; readonly value: unknown }
  | { readonly kind: 'in'; readonly field: string; readonly values: readonly unknown[] }
  | { readonly kind: 'notIn'; readonly field: string; readonly values: readonly unknown[] }
  | { readonly kind: 'includesAny'; readonly field: string; readonly values: readonly unknown[] }
  /** True when every clause of any one group is true: `(a AND b) OR (c) OR …`. */
  | { readonly kind: 'or'; readonly groups: readonly (readonly Clause<T>[])[] }
  | { readonly kind: 'predicate'; readonly test: (item: T) => boolean };

export type Selection<T = any, R = any> =
  | { readonly kind: 'attributes'; readonly attributes: readonly string[] }
  | { readonly kind: 'columns'; readonly columns: Readonly<Record<string, string | ((item: T) => unknown)>> }
  | { readonly kind: 'compute'; readonly compute: (item: T) => R };

/** One `ORDER BY` key. A field name sorts on the row, a function on whatever it returns. `locale` sorts text by language, not by code unit. */
export interface OrderKey<T = any> {
  readonly by: string | ((item: T) => unknown);
  readonly direction: 'asc' | 'desc';
  readonly locale?: string | true;
}

/** Where a page starts or ends: the values of the first keys of the `orderBy`, and whether the row that equals them is kept. */
interface CursorBound {
  readonly values: readonly unknown[];
  readonly inclusive: boolean;
}

/**
 * The order of operations is fixed, as in SQL, whatever order you call things in:
 * filter, order, cursor, select, distinct, offset, limit.
 */
export interface QueryPlan<T = any, R = any> {
  /** Every clause must match. */
  readonly clauses: readonly Clause<T>[];
  readonly selection?: Selection<T, R>;
  readonly orderBy?: readonly OrderKey<T>[];
  readonly distinct?: boolean;
  /** Keyset pagination: only rows after `start` and before `end` in the `orderBy` order. */
  readonly cursor?: { readonly start?: CursorBound; readonly end?: CursorBound };
  readonly offset?: number;
  readonly limit?: number;
  /** The last this many rows, kept in their order. Replaces `limit`. */
  readonly limitLast?: number;
}

export function describeClause(clause: Clause): string {
  switch (clause.kind) {
    case 'compare':
      return `${clause.field} ${clause.op} ${JSON.stringify(clause.value)}`;
    case 'includes':
      return `${clause.field} includes ${JSON.stringify(clause.value)}`;
    case 'in':
      return `${clause.field} in ${JSON.stringify(clause.values)}`;
    case 'notIn':
      return `${clause.field} not in ${JSON.stringify(clause.values)}`;
    case 'includesAny':
      return `${clause.field} includes any of ${JSON.stringify(clause.values)}`;
    case 'or':
      return clause.groups.map(group => `(${group.map(describeClause).join(' and ')})`).join(' or ');
    case 'predicate':
      return 'a where(item => boolean) check';
  }
}

/** A list of values split for fast membership: plain values in a `Set`, dates and objects compared by content. */
interface Members {
  readonly plain: Set<unknown>;
  readonly others: readonly unknown[];
}
const memberCache = new WeakMap<readonly unknown[], Members>();
function membersOf(values: readonly unknown[]): Members {
  let members = memberCache.get(values);
  if (!members) {
    const isObject = (value: unknown) => typeof value === 'object' && value !== null;
    members = { plain: new Set(values.filter(value => !isObject(value))), others: values.filter(isObject) };
    memberCache.set(values, members);
  }
  return members;
}
function isMember(values: readonly unknown[], value: unknown): boolean {
  const members = membersOf(values);
  return typeof value === 'object' && value !== null ? members.others.some(other => valuesEqual(other, value)) : members.plain.has(value);
}

export function testClause<T>(clause: Clause<T>, item: T): boolean {
  switch (clause.kind) {
    case 'predicate':
      return clause.test(item);
    case 'includes': {
      const list = getPath(item, clause.field);
      return Array.isArray(list) && list.some(element => valuesEqual(element, clause.value));
    }
    case 'includesAny': {
      const list = getPath(item, clause.field);
      return Array.isArray(list) && list.some(element => isMember(clause.values, element));
    }
    case 'or':
      return clause.groups.some(group => group.every(inner => testClause(inner, item)));
    case 'in':
      return isMember(clause.values, getPath(item, clause.field));
    case 'notIn':
      return !isMember(clause.values, getPath(item, clause.field));
    case 'compare': {
      const left = getPath(item, clause.field);
      const right = clause.value;
      if (clause.op === '==') return valuesEqual(left, right);
      if (clause.op === '!=') return !valuesEqual(left, right);
      // A range compares two values of one kind, as a database does. A date and a Timestamp compare by time.
      const order = comparableOrder(left, right);
      if (order === undefined) return false;
      switch (clause.op) {
        case '>':
          return order > 0;
        case '>=':
          return order >= 0;
        case '<':
          return order < 0;
        case '<=':
          return order <= 0;
      }
    }
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

function readAttribute(item: unknown, name: string): unknown {
  if (!isRecord(item) || !(name in item)) {
    throw new Error(`select: attribute "${name}" is missing`);
  }
  return item[name];
}

function readNested(item: unknown, name: string): Record<string, unknown> {
  const nested = readAttribute(item, name);
  if (!isRecord(nested)) {
    throw new Error(`select: "${name}.*" needs "${name}" to be an object`);
  }
  return nested;
}

/** Deduplicate a `select` list and reject the combinations that mean nothing. */
export function normalizeAttributes(attributes: readonly string[]): string[] {
  const names = [...new Set(attributes)];
  if (names.length === 0) throw new Error('select: give at least one attribute');
  if (names.some(name => typeof name !== 'string' || name === '')) throw new Error('select: attribute names are non-empty strings');
  if (names.includes('*') && names.length > 1) {
    throw new Error('select: "*" is the whole row and cannot be combined with other attributes');
  }
  return names;
}

/** What `select(...)` was given: attribute names, a function, or an object of aliases. */
export function selectionFrom(args: readonly unknown[]): Selection {
  const first = args[0];
  if (typeof first === 'function') return { kind: 'compute', compute: first as (item: any) => unknown };
  if (typeof first === 'object' && first !== null) return { kind: 'columns', columns: first as Record<string, string> };
  return { kind: 'attributes', attributes: normalizeAttributes(args as string[]) };
}

/** Turn a list of attribute names into the function that projects one row. */
function compileAttributes(attributes: readonly string[]): (item: any) => any {
  const names = normalizeAttributes(attributes);
  if (names[0] === '*') return item => item;
  const only = names[0] as string;
  if (names.length === 1 && !only.endsWith('.*')) return item => readAttribute(item, only);
  return item => {
    const row: Record<string, unknown> = {};
    for (const name of names) {
      if (name.endsWith('.*')) Object.assign(row, readNested(item, name.slice(0, -2)));
      else row[name] = readAttribute(item, name);
    }
    return row;
  };
}

/** `SELECT path AS alias`. A path that leads nowhere is `undefined`, like a SQL NULL, not an error. */
function compileColumns<T>(columns: Readonly<Record<string, string | ((item: T) => unknown)>>): (item: T) => unknown {
  const entries = Object.entries(columns).map(([alias, source]) => [alias, typeof source === 'function' ? source : pathReader(source)] as const);
  if (entries.length === 0) throw new Error('select: give at least one column');
  return item => {
    const row: Record<string, unknown> = {};
    for (const [alias, read] of entries) row[alias] = read(item);
    return row;
  };
}

function compileSelection<T, R>(selection: Selection<T, R> | undefined): (item: T) => R {
  if (!selection) return item => item as unknown as R;
  switch (selection.kind) {
    case 'compute':
      return selection.compute;
    case 'columns':
      return compileColumns(selection.columns) as (item: T) => R;
    case 'attributes':
      return compileAttributes(selection.attributes);
  }
}

function compileOrder<T>(keys: readonly OrderKey<T>[]) {
  return keys.map(key => ({
    read: typeof key.by === 'function' ? key.by : (pathReader(key.by) as (item: T) => unknown),
    sign: key.direction === 'desc' ? -1 : 1,
    collator: key.locale ? new Intl.Collator(key.locale === true ? undefined : key.locale) : undefined,
  }));
}

function comparator<T>(keys: readonly OrderKey<T>[]): (a: T, b: T) => number {
  const compiled = compileOrder(keys);
  return (a, b) => {
    for (const key of compiled) {
      const result = compareValues(key.read(a), key.read(b), key.collator);
      if (result !== 0) return result * key.sign;
    }
    return 0;
  };
}

/** A cursor names positions in the order, so it needs the `orderBy` keys its values line up with. */
export function assertCursor(plan: QueryPlan): void {
  const { cursor, orderBy } = plan;
  for (const [name, bound] of [['start', cursor?.start], ['end', cursor?.end]] as const) {
    if (!bound) continue;
    if (!orderBy || orderBy.length === 0) throw new Error(`${name === 'start' ? 'startAt/startAfter' : 'endAt/endBefore'} needs an orderBy: its values are positions in that order.`);
    if (bound.values.length === 0 || bound.values.length > orderBy.length) {
      throw new Error(`${name === 'start' ? 'startAt/startAfter' : 'endAt/endBefore'} gave ${bound.values.length} value(s) for ${orderBy.length} orderBy key(s): give one per key, at most.`);
    }
  }
}

/** The rows within the cursor: a comparison of the first keys of the order against the cursor values, in that order. */
function withinCursor<T>(orderBy: readonly OrderKey<T>[], cursor: NonNullable<QueryPlan['cursor']>): (item: T) => boolean {
  const compiled = compileOrder(orderBy);
  const position = (item: T, values: readonly unknown[]): number => {
    for (let index = 0; index < values.length; index++) {
      const key = compiled[index]!;
      const result = compareValues(key.read(item), values[index], key.collator);
      if (result !== 0) return result * key.sign;
    }
    return 0;
  };
  return item => {
    if (cursor.start) {
      const at = position(item, cursor.start.values);
      if (cursor.start.inclusive ? at < 0 : at <= 0) return false;
    }
    if (cursor.end) {
      const at = position(item, cursor.end.values);
      if (cursor.end.inclusive ? at > 0 : at >= 0) return false;
    }
    return true;
  };
}

/**
 * The rows are picked, not sorted, when the query reads only a small share of them, such as
 * `orderBy(...).limit(20)` over thousands. Measured on 10,000 rows, picking wins up to a share of
 * about 15% and loses beyond it, so this picks at an eighth or less.
 */
const PICK_WHEN_SHARE_BELOW = 8;

/** The rows in order. Only `needed` of them will be read, so when that is a small share, pick them and leave the rest unsorted. */
function inOrder<T>(rows: T[], compare: (a: T, b: T) => number, needed: number | undefined, fromEnd: boolean): T[] {
  return needed !== undefined && needed * PICK_WHEN_SHARE_BELOW <= rows.length ? firstRows(rows, compare, needed, fromEnd) : rows.sort(compare);
}

/**
 * Run a plan over `items`. Filtering is one pass: every clause is tested on an
 * item before the next item is read, so three `where` calls walk the list once.
 * Without `orderBy` the whole run is lazy, and `first()`, `some()` and `limit`
 * stop reading as soon as they can. `orderBy` has to read every match before it
 * can order them, and the order is stable. With a `limit` it picks the rows it
 * needs instead of sorting all of them, and the result is the same.
 */
export function* runPlan<T, R>(plan: QueryPlan<T, R>, items: Iterable<T>): Generator<R, void, undefined> {
  const { clauses, orderBy, cursor, distinct, offset = 0, limitLast } = plan;
  const limit = limitLast !== undefined ? Infinity : (plan.limit ?? Infinity);
  if (limit === 0 || limitLast === 0) return;
  assertCursor(plan);
  const project = compileSelection(plan.selection);

  // A cursor keeps or drops each row on its own, so it can run before the sort and leave less to sort.
  const inCursor = cursor && orderBy ? withinCursor(orderBy, cursor) : undefined;
  const matching = (function* () {
    outer: for (const item of items) {
      for (const clause of clauses) {
        if (!testClause(clause, item)) continue outer;
      }
      if (inCursor && !inCursor(item)) continue;
      yield item;
    }
  })();
  let ordered: Iterable<T> = matching;
  if (orderBy && orderBy.length > 0) {
    // How many rows the rest of the run can read. `distinct` reads as many as it takes to find enough new ones.
    const needed = distinct ? undefined : limitLast !== undefined ? (offset === 0 ? limitLast : undefined) : limit === Infinity ? undefined : offset + limit;
    ordered = inOrder(Array.from(matching), comparator(orderBy), needed, limitLast !== undefined);
  }

  const seen = distinct ? new Set<string>() : undefined;
  const kept: R[] | undefined = limitLast !== undefined ? [] : undefined;
  let skipped = 0;
  let taken = 0;
  for (const item of ordered) {
    const row = project(item);
    if (seen) {
      const key = stableKey(row);
      if (seen.has(key)) continue;
      seen.add(key);
    }
    if (skipped < offset) {
      skipped++;
      continue;
    }
    if (kept) {
      kept.push(row);
      continue;
    }
    yield row;
    if (++taken >= limit) return;
  }
  if (kept && limitLast !== undefined) yield* kept.slice(Math.max(0, kept.length - limitLast));
}
