import { createAggregates, type Aggregate, type Aggregates } from '../core/aggregate';
import { ListQuery } from '../core/list-query';
import { QueryBuilder } from '../core/query-builder';
import { assertCursor, normalizeAttributes, runPlan, selectionFrom } from '../core/plan';
import type { QueryPlan } from '../core/plan';
import type { AttributeName, Path, PathValue, RowChange, Selected, Simplify, Unsubscribe } from '../core/types';
import { UnsupportedQueryError } from '../listen/errors';
import type { QueryExplanation } from '../listen/explain';
import type { ListenRequest, NativeAggregate, ReadRequest, ReadRow } from '../listen/types';
import { listenable, makeListen, readAggregate, readOnce, readOptions, type Context, type ReadOptions } from './context';

/** What `select({ alias: 'path' | (row) => value })` returns per row. */
type ColumnRow<T, S> = { [K in keyof S]: S[K] extends (item: any) => infer V ? V : S[K] extends string ? PathValue<T, S[K]> : never };

/** What an `aggregate` returns: each aggregate's result under the name you gave it. */
type AggregateRow<S> = { [N in keyof S]: S[N] extends Aggregate<infer V> ? V : never };

/** `listen` and `subscribe` are callable only while the select is attribute names: a computed one has no attribute to report. */
type Live<A extends string, Self> = [A] extends [never] ? never : Self;

/**
 * A keyed list of rows (`users: (id: string) => leaf<User>()`) as a SQL-shaped query.
 *
 * Everything that says which rows to keep and in what order (`where`, `whereIn`, `whereAny`,
 * `orderBy`, `limit`, the cursors…) is inherited from `QueryBuilder`, so it is the same code and the
 * same types as on an array. This class adds what only a database list has: `get` reads it once,
 * `count` and `aggregate` count it, and `listen` follows it live.
 *
 * Whatever the database can run (filters, `IN`, `OR`, document ids, and an order, cursor and limit
 * when they cannot change the answer) it runs; the rest finishes locally on the rows that come back,
 * so the answer is the same as `from(rows)`.
 *
 * `T` is the row, `R` is what `get` and `from` return, and `A` is the selected attribute names that
 * `listen` reports.
 */
export class CollectionQuery<T, R = T, A extends string = '*'> extends QueryBuilder<T, R> {
  constructor(
    private readonly context: Context,
    private readonly path: string,
    plan: QueryPlan<T, R>,
    private readonly keyField?: string,
    private readonly group = false,
  ) {
    super(plan);
  }

  protected _rebuild(plan: QueryPlan<T, R>): this {
    return new CollectionQuery<T, R, A>(this.context, this.path, plan, this.keyField, this.group) as this;
  }

  // ---- SELECT ------------------------------------------------------------

  /** Attribute names. These are what `listen` reports, and the only select it accepts. */
  select<N extends AttributeName<T>[]>(...attributes: N): CollectionQuery<T, Selected<T, N[number]>, N[number]>;
  /** A computed value per row. For `get` and `from`; a live list cannot report it. */
  select<V>(compute: (item: T) => V): CollectionQuery<T, V, never>;
  /** `SELECT path AS alias`. For `get` and `from`; a live list cannot report it. */
  select<S extends Record<string, Path<T> | ((item: T) => unknown)>>(columns: S): CollectionQuery<T, Simplify<ColumnRow<T, S>>, never>;
  select(...args: unknown[]): CollectionQuery<T, any, any> {
    return new CollectionQuery<T, any, any>(this.context, this.path, { ...(this.plan as QueryPlan<T, any>), selection: selectionFrom(args) }, this.keyField, this.group);
  }

  /**
   * Stamp each row's key in the list onto the row, as `name`, on `get`. Call it first, so the name is
   * part of the row type. Conditions on it are conditions on the key itself: `where('$key', '==', id)`,
   * `whereIn('$key', ids)` and `orderBy('$key')` run as Firestore's `documentId()` queries.
   */
  withKey<K extends string>(name: K): CollectionQuery<T & Record<K, string>, T & Record<K, string>, A> {
    if (this.plan.selection) throw new Error('withKey: call it before select, so the key is part of the row.');
    return new CollectionQuery<any, any, A>(this.context, this.path, this.plan, name, this.group);
  }

  // ---- run ---------------------------------------------------------------

  /**
   * Read the rows once. The database runs what it can and returns at least the rows the query
   * needs; the whole query then runs on them here. Pass an identifier to name a denied read, or
   * `{ identifier, source: 'server' | 'cache' }` to choose where Firestore reads from.
   */
  async get(options?: string | ReadOptions): Promise<R[]> {
    const { identifier, source } = readOptions(options);
    assertCursor(this.plan);
    const rows = (await readOnce(this.context, this._request(source), identifier)) as ReadRow[];
    const items = rows.map(({ key, value }) => (this.keyField ? { ...(value as object), [this.keyField]: key } : value));
    return Array.from(runPlan(this.plan, items as T[]));
  }

  /** `SELECT COUNT(*)`. Firestore counts on the server without reading the documents whenever every filter runs there. */
  async count(options?: string | ReadOptions): Promise<number> {
    return (await this.aggregate(a => ({ n: a.count() }), options)).n;
  }

  /**
   * `SELECT COUNT(*), SUM(x), AVG(y)`. Counts, sums and averages run on Firestore, without reading the
   * documents, whenever every filter runs there and there is no select, limit, cursor or distinct. Anything
   * else, including `min`, `max`, `collect` and `count('field')`, reads the rows and aggregates them here.
   */
  async aggregate<S extends Record<string, Aggregate<any>>>(
    build: (a: Aggregates<R>) => S,
    options?: string | ReadOptions,
  ): Promise<Simplify<AggregateRow<S>>> {
    const { identifier, source } = readOptions(options);
    const spec = build(createAggregates<R>());
    const natives: Record<string, NativeAggregate> = {};
    for (const [name, aggregate] of Object.entries(spec)) if (aggregate.native) natives[name] = aggregate.native;

    if (!this.plan.selection && Object.keys(natives).length === Object.keys(spec).length) {
      const done = await readAggregate(this.context, this._request(source), natives, identifier);
      if (done) return done as never;
    }
    const rows = await this.get(options);
    return ListQuery.from(rows).aggregate(() => spec).first() as never;
  }

  /**
   * Listen to the rows. The callback receives `{ key, attribute, value }` when a
   * selected attribute of a row changes, and `{ key, removed: true }` when a row
   * leaves the result. Not callable after a computed or aliased `select`.
   */
  listen(
    this: Live<A, this>,
    next: (change: RowChange<T, A>) => void,
    identifier?: string,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return (this as CollectionQuery<T, R, A>)._listener().listen(next as never, identifier, onError);
  }

  subscribe(this: Live<A, this>, next: (change: RowChange<T, A>) => void, error?: (error: unknown) => void): Unsubscribe {
    return (this as CollectionQuery<T, R, A>)._listener().subscribe(next as never, error);
  }

  /**
   * Say what this query would do against the database, without asking it anything: what the database runs, what is
   * finished here on the rows it returns, whether the same query can be followed live, and which indexes Firebase
   * needs to run it well. The index advice follows Firebase's documentation, and says which rule it applies.
   */
  explain(): QueryExplanation {
    const backend = this.context.backend;
    if (!backend) throw new Error('This schema has no backend, so there is nothing to explain. Pass one: schema(definition, firestoreBackend(transport)).');
    if (!backend.explain) throw new Error(`The ${backend.kind} backend cannot explain a query.`);
    let live: ListenRequest | string;
    try {
      live = this._listenRequest();
    } catch (error) {
      if (!(error instanceof UnsupportedQueryError)) throw error;
      live = error.message;
    }
    return backend.explain(this._request(undefined), live);
  }

  private _request(source: ReadOptions['source']): ReadRequest {
    const plan = this.plan;
    return {
      path: this.path,
      collection: true,
      group: this.group,
      keyField: this.keyField,
      clauses: plan.clauses,
      orderBy: plan.orderBy ?? [],
      cursor: plan.cursor,
      offset: plan.offset,
      limit: plan.limit,
      limitLast: plan.limitLast,
      distinct: plan.distinct ?? false,
      source,
    };
  }

  /** The request for following this query live. Refuses, before anything connects, what a live list cannot do. */
  private _listenRequest(): ListenRequest {
    const plan = this.plan;
    assertCursor(plan);
    const { selection } = plan;
    if (selection && selection.kind !== 'attributes') {
      throw new UnsupportedQueryError('A live list reports attribute changes, so select takes attribute names. A computed or aliased select works with get() and from().');
    }
    if (plan.offset !== undefined || plan.distinct) {
      throw new UnsupportedQueryError('A live list reports changes per row, so it has no offset or distinct. Use get(), or apply them to the rows.');
    }
    const attributes = selection ? normalizeAttributes(selection.attributes) : ['*'];
    const limited = plan.limit !== undefined || plan.limitLast !== undefined || Boolean(plan.cursor);
    return {
      path: this.path,
      collection: true,
      group: this.group,
      keyField: this.keyField,
      clauses: plan.clauses,
      attributes,
      // An order only decides who makes the cut or where a page starts, so it means nothing without one of those.
      orderBy: limited ? (plan.orderBy ?? []) : [],
      cursor: plan.cursor,
      limit: plan.limit,
      limitLast: plan.limitLast,
    };
  }

  private _listener() {
    return listenable(makeListen<RowChange<T, A>>(this.context, this._listenRequest(), false));
  }
}
