import type { Unsubscribe } from '../core/types';
import type { Clause, OrderKey, QueryPlan } from '../core/plan';
import type { QueryExplanation } from './explain';

/**
 * What every backend emits. `attribute` is a selected name, `contact.email`
 * for a `contact.*` selection, or `*` for the whole node or row. `key` is the row
 * in a keyed list. `removed` marks a row that left the result.
 */
export interface ChangeEvent {
  readonly attribute: string;
  readonly value: unknown;
  readonly key?: string;
  readonly removed?: boolean;
}

/** A field a list is ordered by, for a database that can order it. */
export interface NativeOrder {
  readonly field: string;
  readonly direction: 'asc' | 'desc';
}

/** Where a one-time read may come from: Firestore's own cache or server, or whichever it would pick. */
export type ReadSource = 'default' | 'server' | 'cache';

/** What a live list and a one-time read of it both say. */
interface ListShape {
  /** Segments joined with `/`, no leading slash. For a collection group, the collection id. */
  readonly path: string;
  /** `true` when `path` is a keyed list and each child is a row. */
  readonly collection: boolean;
  /** `true` for a collection group: every collection called `path`, wherever it is. */
  readonly group?: boolean;
  readonly clauses: readonly Clause[];
  /** The name a row's key goes by in `clauses` and `orderBy`. A condition on it is a condition on the key. */
  readonly keyField?: string;
  readonly orderBy?: readonly OrderKey[];
  readonly cursor?: QueryPlan['cursor'];
  readonly limit?: number;
  /** The last this many rows, in order. Replaces `limit`. */
  readonly limitLast?: number;
}

/** What the schema layer asks a backend to listen to. */
export interface ListenRequest extends ListShape {
  /** Selected names. `['*']` is the whole node or row. */
  readonly attributes: readonly string[];
}

/**
 * What the schema layer asks a backend to read once. The backend returns every
 * row the plan needs, and may return more: the schema layer then runs the whole
 * plan locally on what came back, so a backend only has to push down what it can.
 */
export interface ReadRequest extends ListShape {
  readonly orderBy: readonly OrderKey[];
  readonly offset?: number;
  readonly distinct: boolean;
  readonly source?: ReadSource;
}

/** One aggregate a database can run for you: a count, or the sum or average of a numeric field. */
export type NativeAggregate = { readonly op: 'count' } | { readonly op: 'sum' | 'avg'; readonly field: string };

/** One row of a list read once: its key in the list and its value. */
export interface ReadRow {
  readonly key: string;
  readonly value: unknown;
}

/** One caller of `listen`. The identifier stays with the caller even when the connection is shared. */
export interface Subscriber {
  readonly identifier?: string;
  next(change: ChangeEvent): void;
  error(error: unknown): void;
}

export interface Backend {
  /** `'realtime'`, `'firestore'`, or whatever a custom backend calls itself. */
  readonly kind: string;
  listen(request: ListenRequest, subscriber: Subscriber): Unsubscribe;
  /** Read once. A node resolves to its value (`undefined` if it does not exist), a list to its rows. */
  get(request: ReadRequest): Promise<unknown>;
  /**
   * Run aggregates on the database without reading the rows, when it can. Resolves to `undefined` when it
   * cannot for this query, and the caller reads the rows and aggregates them itself.
   */
  aggregate?(request: ReadRequest, aggregates: Readonly<Record<string, NativeAggregate>>): Promise<Record<string, number | undefined> | undefined>;
  /**
   * Say what a query would send to the database, what is left to do here, and what to set up for it, without asking
   * the database anything. `live` is the request for following the same query, or the reason it cannot be followed.
   */
  explain?(read: ReadRequest, live: ListenRequest | string): QueryExplanation;
}
