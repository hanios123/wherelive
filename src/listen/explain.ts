import { describeClause, type Clause, type OrderKey } from '../core/plan';
import type { ReadRequest } from './types';

/** A Firestore index, in the shape `firestore.indexes.json` takes. */
export interface FirestoreIndex {
  readonly collectionGroup: string;
  readonly queryScope: 'COLLECTION' | 'COLLECTION_GROUP';
  readonly fields: ReadonlyArray<
    { readonly fieldPath: string; readonly order: 'ASCENDING' | 'DESCENDING' } | { readonly fieldPath: string; readonly arrayConfig: 'CONTAINS' }
  >;
}

/**
 * What a database needs set up so the server part of a query runs well. These follow Firebase's own
 * documentation. `because` says which rule applies, so a wrong guess is easy to spot. When a needed index is
 * missing, Firestore's error carries a link that creates it, and that link is the last word.
 */
export type IndexAdvice =
  /** A Firestore composite index. `required` when the documentation says the query needs one, `recommended` when it only advises one. */
  | { readonly kind: 'composite'; readonly need: 'required' | 'recommended'; readonly index: FirestoreIndex; readonly because: string }
  /** A collection group query on these fields needs an index with collection group scope. */
  | { readonly kind: 'collection-group'; readonly fields: readonly string[]; readonly because: string }
  /** A Realtime Database `.indexOn` for a child, at the path of the list, in the security rules. */
  | { readonly kind: 'child'; readonly need: 'recommended'; readonly path: string; readonly child: string; readonly because: string }
  /** Firebase does not support this query. */
  | { readonly kind: 'unsupported'; readonly because: string }
  /** The documentation read for this does not say, so nothing is claimed. */
  | { readonly kind: 'unknown'; readonly because: string };

/** What `query.explain()` says about a query: where each part runs, whether it can be live, and what to set up. */
export interface QueryExplanation {
  readonly backend: string;
  /** What the database runs, in words. */
  readonly server: readonly string[];
  /** What is finished here on the rows it returns. */
  readonly local: readonly string[];
  /** Whether the same query can be followed live, and if not, why. */
  readonly live: { readonly ok: true } | { readonly ok: false; readonly reason: string };
  readonly indexes: readonly IndexAdvice[];
  /** The request exactly as it is sent to the database. */
  readonly sent: unknown;
}

export const show = (value: unknown): string => JSON.stringify(value) ?? 'undefined';

export function describeOrder(keys: readonly OrderKey[]): string {
  return keys.map(key => `${typeof key.by === 'string' ? key.by : 'a function'} ${key.direction === 'desc' ? 'descending' : 'ascending'}${key.locale ? ' by language' : ''}`).join(', then ');
}

/**
 * What is left to do here after the database has answered: the conditions it could not run, and an order, a limit, an
 * offset or a distinct that were not sent because sending them would change the answer.
 */
export function localWork(request: ReadRequest, sent: { order: boolean; limit: boolean }, leftover: readonly Clause[]): string[] {
  const work = leftover.map(clause => `${describeClause(clause)}`);
  if (request.orderBy.length > 0 && !sent.order) work.push(`order by ${describeOrder(request.orderBy)}`);
  if (request.limitLast !== undefined && !sent.limit) work.push(`keep the last ${request.limitLast} rows`);
  if (request.limit !== undefined && !sent.limit) work.push(`limit ${request.limit}`);
  if (request.cursor && !sent.order) work.push('the start and end of the page');
  if (request.offset) work.push(`skip the first ${request.offset} rows`);
  if (request.distinct) work.push('distinct');
  return work;
}
