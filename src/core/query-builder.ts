import { runPlan, type Clause, type QueryPlan } from './plan';
import type { ArrayElement, ArrayPath, Comparison, Path, PathValue } from './types';

/** `when` treats `undefined`, `null` and `''` as "not present". `0` and `false` are values. */
const isPresent = (value: unknown): boolean => value !== undefined && value !== null && value !== '';

const nonNegativeInteger = (name: string, value: number): number => {
  if (!Number.isInteger(value) || value < 0) throw new Error(`${name}: give a whole number, zero or more`);
  return value;
};

/**
 * Everything you can say about which rows to keep and in what order, written once. A query over an
 * array (`ListQuery`) and a query over a database list (`CollectionQuery`) both extend it, so a new
 * builder method is added here and both have it. Every call returns a new query of the same kind.
 *
 * `T` is the row the query filters. `R` is what comes out: the same row until `select` changes it.
 * Members whose names start with `_` are internal, and are not part of what a schema handle forwards.
 */
export abstract class QueryBuilder<T, R = T> {
  constructor(readonly plan: QueryPlan<T, R>) {}

  /** A query of the same kind as this one, with this plan. */
  protected abstract _rebuild(plan: QueryPlan<T, R>): this;

  protected _with(clause: Clause<T>): this {
    return this._rebuild({ ...this.plan, clauses: [...this.plan.clauses, clause] });
  }

  protected _derive(patch: Partial<QueryPlan<T, R>>): this {
    return this._rebuild({ ...this.plan, ...patch });
  }

  // ---- WHERE -------------------------------------------------------------

  /** Keep rows where the field matches. The field is a key of `T` or a dotted path: `'customer.address.city'`. */
  where<P extends Path<T>>(field: P, op: Comparison, value: PathValue<T, P>): this;
  /** Keep rows the check accepts. Runs locally. A database cannot run it for you. */
  where(test: (item: T) => boolean): this;
  where(fieldOrTest: string | ((item: T) => boolean), op?: Comparison, value?: unknown): this {
    if (typeof fieldOrTest === 'function') return this._with({ kind: 'predicate', test: fieldOrTest });
    return this._with({ kind: 'compare', field: fieldOrTest, op: op as Comparison, value });
  }

  /** `field IN (values)`. An empty list matches nothing. */
  whereIn<P extends Path<T>>(field: P, values: readonly PathValue<T, P>[]): this {
    return this._with({ kind: 'in', field, values: [...values] });
  }

  /** `field NOT IN (values)`. */
  whereNotIn<P extends Path<T>>(field: P, values: readonly PathValue<T, P>[]): this {
    return this._with({ kind: 'notIn', field, values: [...values] });
  }

  /** The field is an array and it contains `value`. */
  whereIncludes<P extends ArrayPath<T>>(field: P, value: ArrayElement<PathValue<T, P>>): this {
    return this._with({ kind: 'includes', field, value });
  }

  /** The field is an array and it contains at least one of `values`. An empty list matches nothing. */
  whereIncludesAny<P extends ArrayPath<T>>(field: P, values: readonly ArrayElement<PathValue<T, P>>[]): this {
    return this._with({ kind: 'includesAny', field, values: [...values] });
  }

  /**
   * `WHERE (a AND b) OR (c) OR …`. Each alternative builds its conditions on a query it is handed,
   * and a row passes when it satisfies every condition of at least one alternative. Only `where`
   * style calls belong inside: not `select`, `orderBy` or `limit`.
   *
   * ```ts
   * query.whereAny(q => q.where('tier', '==', 'gold'), q => q.where('total', '>=', 500).where('region', '==', 'eu'))
   * ```
   */
  whereAny(...alternatives: Array<(query: Conditions<T>) => Conditions<T>>): this {
    if (alternatives.length === 0) throw new Error('whereAny: give at least one alternative');
    const groups = alternatives.map(build => {
      const { clauses, selection, orderBy, distinct, offset, limit, cursor, limitLast } = build(new Conditions<T>({ clauses: [] })).plan;
      if (selection || orderBy?.length || distinct || offset !== undefined || limit !== undefined || cursor || limitLast !== undefined) {
        throw new Error('whereAny: an alternative is conditions only. Put select, orderBy, limit and the rest on the query itself.');
      }
      if (clauses.length === 0) throw new Error('whereAny: an alternative needs at least one condition');
      return clauses;
    });
    return groups.length === 1 ? this._derive({ clauses: [...this.plan.clauses, ...(groups[0] as Clause<T>[])] }) : this._with({ kind: 'or', groups });
  }

  /**
   * `OR` with the clause before it: `where(a).orWhere(b)` is `a OR b`, and a `where` after it is
   * `AND`-ed with the whole group. Call it again to add another alternative. For alternatives that
   * are several conditions each, use `whereAny`.
   */
  orWhere<P extends Path<T>>(field: P, op: Comparison, value: PathValue<T, P>): this;
  orWhere(test: (item: T) => boolean): this;
  orWhere(fieldOrTest: string | ((item: T) => boolean), op?: Comparison, value?: unknown): this {
    const clauses = this.plan.clauses;
    const previous = clauses[clauses.length - 1];
    if (!previous) throw new Error('orWhere: there is no earlier where to be an alternative to. Start an OR with whereAny(…).');
    const added: Clause<T> =
      typeof fieldOrTest === 'function' ? { kind: 'predicate', test: fieldOrTest } : { kind: 'compare', field: fieldOrTest, op: op as Comparison, value };
    const groups: Clause<T>[][] = previous.kind === 'or' ? [...previous.groups.map(group => [...group]), [added]] : [[previous], [added]];
    return this._derive({ clauses: [...clauses.slice(0, -1), { kind: 'or', groups }] });
  }

  /** Add the clause only when `value` is present. This is the `!brand || match` case. */
  when<V>(value: V, addClause: (query: this, value: NonNullable<V>) => this): this {
    return isPresent(value) ? addClause(this, value as NonNullable<V>) : this;
  }

  /** `SELECT DISTINCT`. Drops rows equal to an earlier row, after `select`. Objects are compared by content. */
  distinct(): this {
    return this._derive({ distinct: true });
  }

  // ---- ORDER BY, LIMIT, OFFSET, CURSORS ------------------------------------

  /**
   * `ORDER BY`. Call it again for the next key: `orderBy('tier').orderBy('age', 'desc')` is
   * `ORDER BY tier, age DESC`. It sorts the row before `select`, so you can order by a field you
   * do not select. Missing and `null` sort first, then booleans, numbers, dates, strings.
   * Text compares by code unit, as a database does. Pass `{ locale: true }` to sort by language
   * (`localeCompare`), which a database cannot do for you.
   */
  orderBy<P extends Path<T>>(field: P, direction?: 'asc' | 'desc', options?: { locale?: string | true }): this;
  /** Order by whatever the function returns. Local only. */
  orderBy(by: (item: T) => unknown, direction?: 'asc' | 'desc', options?: { locale?: string | true }): this;
  orderBy(by: string | ((item: T) => unknown), direction: 'asc' | 'desc' = 'asc', options?: { locale?: string | true }): this {
    return this._derive({ orderBy: [...(this.plan.orderBy ?? []), { by, direction, locale: options?.locale }] });
  }

  /** `LIMIT`: keep this many rows, after `offset`. Stops reading as soon as it has them, unless `orderBy` has to see every row. */
  limit(count: number): this {
    return this._derive({ limit: nonNegativeInteger('limit', count), limitLast: undefined });
  }

  /**
   * The last `count` rows of the ordered result, still in their order: "the latest 20" without
   * reversing the sort yourself. It replaces `limit`, and it needs every row, so it never stops early.
   */
  limitToLast(count: number): this {
    return this._derive({ limitLast: nonNegativeInteger('limitToLast', count), limit: undefined });
  }

  /** `OFFSET`: skip this many rows first. Runs after filter, order, select and distinct. Firestore has none, so prefer a cursor. */
  offset(count: number): this {
    return this._derive({ offset: nonNegativeInteger('offset', count) });
  }

  /**
   * Keyset pagination, instead of `offset`. Each of these takes the values of the first keys of your
   * `orderBy`, in that order, one per key at most: the position to start or stop at. Rows tied with the
   * position are kept by `startAt` and `endAt`, and dropped by `startAfter` and `endBefore`. The page
   * after the one you have is `orderBy('date').orderBy('id').startAfter(last.date, last.id).limit(20)`.
   * Positions are compared as `orderBy` compares, so a locale order compares by language.
   */
  startAt(...values: unknown[]): this {
    return this._derive({ cursor: { ...this.plan.cursor, start: { values, inclusive: true } } });
  }

  startAfter(...values: unknown[]): this {
    return this._derive({ cursor: { ...this.plan.cursor, start: { values, inclusive: false } } });
  }

  endAt(...values: unknown[]): this {
    return this._derive({ cursor: { ...this.plan.cursor, end: { values, inclusive: true } } });
  }

  endBefore(...values: unknown[]): this {
    return this._derive({ cursor: { ...this.plan.cursor, end: { values, inclusive: false } } });
  }

  /** Run the query on rows you already hold, in one pass. */
  from(items: readonly T[]): R[] {
    return Array.from(runPlan(this.plan, items));
  }
}

/** What an alternative in `whereAny` is handed: the conditions half of a query, nothing to run. */
export class Conditions<T> extends QueryBuilder<T, T> {
  protected _rebuild(plan: QueryPlan<T, T>): this {
    return new Conditions<T>(plan) as this;
  }
}
