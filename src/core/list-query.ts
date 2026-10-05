import { aggregateRows, createAggregates, type Aggregate, type Aggregates } from './aggregate';
import { combinationsOf, lazyList, pairsOf } from './combinations';
import { stableKey } from './compare';
import { getPath } from './path';
import { QueryBuilder } from './query-builder';
import { runPlan, selectionFrom, type QueryPlan } from './plan';
import type { AttributeName, Holder, HolderKey, Path, PathValue, Selected, Simplify } from './types';

/** What `select({ alias: 'path' | (row) => value })` returns per row. */
type ColumnRow<T, S> = { [K in keyof S]: S[K] extends (item: any) => infer V ? V : S[K] extends string ? PathValue<T, S[K]> : never };

/** What an `aggregate` returns per row: each aggregate's result under the name you gave it. */
type AggregateRow<S> = { [N in keyof S]: S[N] extends Aggregate<infer V> ? V : never };

/**
 * A description of which rows to keep and what to read from them, in the order
 * SQL runs things: filter, order, select, distinct, offset, limit.
 *
 * `T` is the row the query filters. `R` is what comes out: the same row until
 * `select` changes it. A query never mutates. Every call returns a new one.
 *
 * A query built with `ListQuery.from(items)` holds its array and answers
 * `toList()`, `first()` and the rest. A query built with `ListQuery.fromType<T>()`
 * holds nothing and runs on an array you pass to `.from(items)`.
 */
export class ListQuery<T, R = T> extends QueryBuilder<T, R> {
  private constructor(
    private readonly source: Iterable<T> | undefined,
    plan: QueryPlan<T, R>,
  ) {
    super(plan);
  }

  /** Start from an array you already hold. */
  static from<T>(items: readonly T[]): ListQuery<T> {
    return new ListQuery<T>(items, { clauses: [] });
  }

  /** `Object.values`, then start. */
  static fromHolder<V>(holder: Holder<V>): ListQuery<V> {
    return ListQuery.from(Object.values(holder));
  }

  /** Start with no data. Describe the query, then run it with `.from(items)`. */
  static fromType<T>(): ListQuery<T> {
    return new ListQuery<T>(undefined, { clauses: [] });
  }

  /** Every combination of two arrays as a tuple, `left` outermost, like a nested `for`. */
  static pairs<A, B>(left: readonly A[], right: readonly B[]): ListQuery<[A, B]> {
    return new ListQuery<[A, B]>(
      lazyList(() => pairsOf(left, right)),
      { clauses: [] },
    );
  }

  /**
   * The same combinations, named, for any number of lists. The first list is the
   * outermost loop. An empty list makes no combinations, as an empty `for` would.
   */
  static combine<L extends Record<string, readonly unknown[]>>(lists: L): ListQuery<{ [K in keyof L]: L[K][number] }> {
    if (Object.keys(lists).length === 0) throw new Error('combine: give at least one list');
    return new ListQuery<{ [K in keyof L]: L[K][number] }>(
      lazyList(() => combinationsOf(lists) as Iterator<{ [K in keyof L]: L[K][number] }>),
      { clauses: [] },
    );
  }

  // ---- SELECT ------------------------------------------------------------

  /**
   * Keep named attributes. One name returns that value. Several return an object
   * with only those attributes. `contact.*` copies every field of `contact` and
   * leaves `contact` itself out. `*` is the whole row.
   */
  select<A extends AttributeName<T>[]>(...attributes: A): ListQuery<T, Selected<T, A[number]>>;
  /** A computed value per row. Local only: a database cannot listen to it. */
  select<V>(compute: (item: T) => V): ListQuery<T, V>;
  /**
   * `SELECT path AS alias`. Each value is a field or dotted path, or a function of the row.
   * A path that leads nowhere is `undefined`. Local only when listening.
   */
  select<S extends Record<string, Path<T> | ((item: T) => unknown)>>(columns: S): ListQuery<T, Simplify<ColumnRow<T, S>>>;
  select(...args: unknown[]): ListQuery<T, any> {
    return new ListQuery<T, any>(this.source, { ...(this.plan as QueryPlan<T, any>), selection: selectionFrom(args) });
  }

  // ---- GROUP BY -----------------------------------------------------------

  /**
   * `GROUP BY keys`, then name what you want per group with `aggregate`. This starts a new
   * query over the rows so far, like a SQL subquery: whatever `where`, `join`, `select`,
   * `orderBy` and `limit` came before has already run, and `keys` are fields of those rows.
   * `collect()` is how you bucket rows by a key. A `where` after `aggregate` filters the
   * groups, like `HAVING`, and `orderBy` and `limit` after it order and cut the groups.
   *
   * ```ts
   * ListQuery.from(orders).groupBy('region').aggregate(a => ({ n: a.count(), total: a.sum('price'), orders: a.collect() }))
   * ```
   */
  groupBy<K extends (keyof R & string)[]>(
    ...keys: K
  ): { aggregate<S extends Record<string, Aggregate<any>>>(build: (a: Aggregates<R>) => S): ListQuery<Simplify<Pick<R, K[number]> & AggregateRow<S>>> } {
    return { aggregate: build => this.aggregateBy(keys, build) as never };
  }

  /** The aggregates over every row so far, as one row: `SELECT COUNT(*), SUM(price)`. An empty list still gives one row. */
  aggregate<S extends Record<string, Aggregate<any>>>(build: (a: Aggregates<R>) => S): ListQuery<Simplify<AggregateRow<S>>> {
    return this.aggregateBy([], build) as never;
  }

  // ---- FROM ... JOIN ------------------------------------------------------

  /**
   * `INNER JOIN`: one `{ left, right }` row for every pair whose keys are equal. Several
   * matches make several rows. A missing or `null` key matches nothing, and keys are compared
   * strictly. The right list is indexed by its key once per run, so this is not a loop inside a
   * loop. `other` can be an array or another query.
   *
   * Every join returns its rows in the same order: for each left row in turn, its matches in the
   * order of the right list. `rightJoin` and `outerJoin` then add the right rows nothing matched,
   * at the end, in their own order.
   */
  innerJoin<U, LK extends Path<R>, RK extends Path<U>>(other: Iterable<U>, leftKey: LK, rightKey: RK): ListQuery<{ left: R; right: U }> {
    return this.join(other, leftKey, rightKey, false, false) as ListQuery<{ left: R; right: U }>;
  }

  /** `LEFT JOIN`: every row of this query, with `right` absent when nothing matches. */
  leftJoin<U, LK extends Path<R>, RK extends Path<U>>(other: Iterable<U>, leftKey: LK, rightKey: RK): ListQuery<{ left: R; right: U | undefined }> {
    return this.join(other, leftKey, rightKey, true, false) as ListQuery<{ left: R; right: U | undefined }>;
  }

  /** `RIGHT JOIN`: every row of `other`, with `left` absent when nothing matches. A right row with no key is kept too. */
  rightJoin<U, LK extends Path<R>, RK extends Path<U>>(other: Iterable<U>, leftKey: LK, rightKey: RK): ListQuery<{ left: R | undefined; right: U }> {
    return this.join(other, leftKey, rightKey, false, true) as ListQuery<{ left: R | undefined; right: U }>;
  }

  /** `FULL OUTER JOIN`: every row from both sides. The side with no match is absent. */
  outerJoin<U, LK extends Path<R>, RK extends Path<U>>(other: Iterable<U>, leftKey: LK, rightKey: RK): ListQuery<{ left: R | undefined; right: U | undefined }> {
    return this.join(other, leftKey, rightKey, true, true);
  }

  // ---- UNION --------------------------------------------------------------

  /**
   * `UNION`: this query's rows, then `other`'s, with duplicates dropped, the first one kept.
   * Duplicates are found across both lists and within each. Rows are equal when their content
   * is equal, objects whatever the order of their keys. Pass `key` to say what identifies a row
   * instead: two rows with the same `key` value are duplicates, and a missing value counts as one
   * value, as SQL treats NULL in a `UNION`. `other` can be an array or another query.
   *
   * The result is one query over the combined rows, so `orderBy`, `offset` and `limit` after it
   * work on the whole list, not on each side. It is also how you write an `OR` across fields on a
   * database that cannot: read each side with `get()` and union them.
   */
  union(other: Iterable<R>, key?: Path<R>): ListQuery<R> {
    return this.appended(other, { key });
  }

  /** `UNION ALL`: this query's rows, then `other`'s, every one kept. */
  unionAll(other: Iterable<R>): ListQuery<R> {
    return this.appended(other, undefined);
  }

  /**
   * For each row this query keeps, run an inner query (or read any list) and
   * flatten what it returns into one query. This replaces a `for` inside a `for`:
   * the outer query picks the parents, the inner one picks each parent's children.
   *
   * Nothing runs until a terminal call. `first()` and `some()` stop at the first
   * match across both levels. Nest it for a third loop. The callback receives the
   * row as `select` shaped it. Needs data, so it is not available on `fromType`.
   */
  flatMap<V>(inner: (row: R) => Iterable<V>): ListQuery<V> {
    const outer = this.plan;
    const source = this.items();
    return new ListQuery<V>(
      lazyList(function* () {
        for (const row of runPlan(outer, source)) yield* inner(row);
      }),
      { clauses: [] },
    );
  }

  // ---- run ---------------------------------------------------------------

  /** The matching items. */
  toList(): R[] {
    return Array.from(runPlan(this.plan, this.items()));
  }

  /** The matching items as a `Set`. Duplicates collapse to their first occurrence. */
  toSet(): Set<R> {
    return new Set(runPlan(this.plan, this.items()));
  }

  /** Iterate the matches, so `for (const row of query)` and `[...query]` work. Each pass runs the query again. */
  [Symbol.iterator](): Iterator<R> {
    return runPlan(this.plan, this.items());
  }

  /** `{ [item[key]]: item }`. The reverse of `fromHolder`. When two items share a key the last one wins. */
  toHolder<K extends HolderKey<R>>(key: K): Holder<R> {
    const holder: Holder<R> = {};
    for (const item of runPlan(this.plan, this.items())) {
      const id = (item as Record<K, unknown>)[key];
      if (typeof id !== 'string' && typeof id !== 'number') {
        throw new Error(`toHolder: "${key}" must be a string or a number, got ${id === null ? 'null' : typeof id}`);
      }
      holder[id] = item;
    }
    return holder;
  }

  /** The first match, or `undefined`. Stops reading at the first match. */
  first(): R | undefined {
    // Asking for one row lets an ordered query pick it instead of sorting them all.
    const plan = this.plan.limitLast === undefined ? { ...this.plan, limit: Math.min(this.plan.limit ?? 1, 1) } : this.plan;
    for (const item of runPlan(plan, this.items())) return item;
    return undefined;
  }

  /** Whether any item matches. */
  some(): boolean {
    return !runPlan(this.plan, this.items()).next().done;
  }

  /** No row matched. This replaces `!query.some()`. */
  none(): boolean {
    return !this.some();
  }

  /** How many match. */
  count(): number {
    // Counting needs the rows, not what `select` makes of them. Only `distinct` compares the selected values.
    const plan = this.plan.distinct ? this.plan : { ...this.plan, selection: undefined };
    let count = 0;
    for (const _ of runPlan(plan, this.items())) count++;
    return count;
  }

  // ---- internals ---------------------------------------------------------

  protected _rebuild(plan: QueryPlan<T, R>): this {
    return new ListQuery<T, R>(this.source, plan) as this;
  }

  private aggregateBy(keys: readonly string[], build: (a: Aggregates<R>) => Record<string, Aggregate<unknown>>): ListQuery<Record<string, unknown>> {
    const plan = this.plan;
    const source = this.items();
    const spec = build(createAggregates<R>());
    return new ListQuery<Record<string, unknown>>(
      lazyList(() => aggregateRows(runPlan(plan, source), keys, spec)),
      { clauses: [] },
    );
  }

  private join<U>(
    other: Iterable<U>,
    leftKey: string,
    rightKey: string,
    keepLeft: boolean,
    keepRight: boolean,
  ): ListQuery<{ left: R | undefined; right: U | undefined }> {
    const plan = this.plan;
    const source = this.items();
    return new ListQuery<{ left: R | undefined; right: U | undefined }>(
      lazyList(function* () {
        const rights = Array.from(other);
        const index = new Map<unknown, number[]>();
        rights.forEach((right, position) => {
          const key = getPath(right, rightKey);
          if (key === undefined || key === null) return;
          const bucket = index.get(key);
          if (bucket) bucket.push(position);
          else index.set(key, [position]);
        });
        const matched = keepRight ? new Array<boolean>(rights.length).fill(false) : undefined;

        for (const left of runPlan(plan, source)) {
          const key = getPath(left, leftKey);
          const positions = key === undefined || key === null ? undefined : index.get(key);
          if (positions) {
            for (const position of positions) {
              if (matched) matched[position] = true;
              yield { left, right: rights[position] };
            }
          } else if (keepLeft) {
            yield { left, right: undefined };
          }
        }
        if (matched) {
          for (let position = 0; position < rights.length; position++) {
            if (!matched[position]) yield { left: undefined, right: rights[position] };
          }
        }
      }),
      { clauses: [] },
    );
  }

  private appended(other: Iterable<R>, dedupe: { key: string | undefined } | undefined): ListQuery<R> {
    const plan = this.plan;
    const source = this.items();
    return new ListQuery<R>(
      lazyList(function* () {
        const seen = dedupe ? new Set<string>() : undefined;
        const fresh = (row: R): boolean => {
          if (!seen || !dedupe) return true;
          const id = stableKey(dedupe.key === undefined ? row : getPath(row, dedupe.key));
          if (seen.has(id)) return false;
          seen.add(id);
          return true;
        };
        for (const row of runPlan(plan, source)) if (fresh(row)) yield row;
        for (const row of other) if (fresh(row)) yield row;
      }),
      { clauses: [] },
    );
  }

  private items(): Iterable<T> {
    if (!this.source) {
      throw new Error('This query has no data. Build it with ListQuery.from(items), or run it with .from(items).');
    }
    return this.source;
  }
}
