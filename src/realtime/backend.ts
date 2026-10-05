import type { Unsubscribe } from '../core/types';
import { describeClause, type Clause } from '../core/plan';
import { canonicalKey } from '../listen/canonical';
import { ListenerRegistry, type Sink } from '../listen/registry';
import { localWork, type IndexAdvice, type QueryExplanation } from '../listen/explain';
import { UnsupportedQueryError } from '../listen/errors';
import type { Backend, ListenRequest, ReadRequest, ReadRow, Subscriber } from '../listen/types';
import { compareKeys } from './order';

export type RealtimeScalar = string | number | boolean | null;

/** One end of a range, on the value the children are ordered by. */
export interface RealtimeBound {
  readonly value: RealtimeScalar;
  readonly inclusive: boolean;
}

/**
 * What Realtime Database runs on the server: one order (by a child's value, or by key), an equality or a
 * range on that order, and a limit from the front or the back. `child` may be a dotted path to a nested child.
 * It is only ever asked for what returns the rows the full query needs, or a superset the full query trims.
 */
export interface RealtimeQuery {
  readonly order?: { readonly child: string } | { readonly key: true };
  readonly equalTo?: RealtimeScalar;
  readonly start?: RealtimeBound;
  readonly end?: RealtimeBound;
  readonly limit?: { readonly first: number } | { readonly last: number };
}

export interface ChildHandlers {
  added?(key: string, value: unknown): void;
  changed?(key: string, value: unknown): void;
  removed?(key: string): void;
}

/**
 * The seam between the library and the Firebase SDK. `wherelive/firebase`
 * implements it on the real SDK. `wherelive/testing` implements it in memory.
 * Values are plain JSON. A missing node is `undefined`, never `null`.
 */
export interface RealtimeTransport {
  /** The value at `path` now, and again whenever it changes. */
  onValue(path: string, next: (value: unknown) => void, error: (error: unknown) => void): Unsubscribe;
  /** The children of `path` that the query returns, or all of them. Only the handlers given are subscribed. */
  onChildren(
    path: string,
    query: RealtimeQuery | undefined,
    handlers: ChildHandlers,
    error: (error: unknown) => void,
  ): Unsubscribe;
  /** The value at `path` once. `undefined` when the node does not exist. */
  getValue(path: string): Promise<unknown>;
  /** The children of `path` once, each with its key, that the query returns, or all of them. */
  getChildren(path: string, query: RealtimeQuery | undefined): Promise<ReadRow[]>;
}

const HINT = 'Read it once with get() and the rest runs locally, or load the rows and use .from(rows).';

const isScalar = (value: unknown): value is string | number | boolean => ['string', 'number', 'boolean'].includes(typeof value);

function refuseWhatItHasNo(request: ListenRequest | ReadRequest): void {
  if (request.group) throw new UnsupportedQueryError('Realtime Database has no collection groups.');
}

/**
 * Decide what the server can run. Two rules keep the answer right.
 *
 * A filter may return MORE than the query keeps, because the full query runs again on what comes
 * back. Realtime Database orders numbers before strings, so a range on a number can return strings
 * too, and the local check drops them. That is fine for a read. A live list has no local check, so it
 * only takes an equality, which is exact.
 *
 * A limit may return NO MORE than the query would keep, because it cuts before the local check. So it
 * needs an exact filter (an equality, or none) and an order the server reproduces exactly: none, which is
 * key order, or one ascending child. A descending order with a limit could cut a tie group from the other
 * end, and an order by key sorts integer-like keys as numbers, so both stay local.
 */
function planRealtime(request: ListenRequest | ReadRequest, action: 'listen' | 'read'): { query: RealtimeQuery | undefined; local: Clause[] } {
  const keyField = request.keyField;
  const onKey = (field: string) => keyField !== undefined && (field === keyField || field.startsWith(`${keyField}.`));
  const order = request.orderBy ?? [];
  const only = order.length === 1 && typeof order[0]!.by === 'string' && !order[0]!.locale && !onKey(order[0]!.by as string) ? order[0]! : undefined;

  type Candidate = { clause: Clause; field: string; op: '==' | '>=' | '>' | '<=' | '<'; value: string | number | boolean };
  const candidates: Candidate[] = [];
  for (const clause of request.clauses) {
    if (clause.kind !== 'compare' || !['==', '>=', '>', '<=', '<'].includes(clause.op) || !isScalar(clause.value)) continue;
    // A condition on the key can only be an equality: keys sort differently from text, so a range would not be exact.
    if (onKey(clause.field) && !(clause.field === keyField && clause.op === '==')) continue;
    candidates.push({ clause, field: clause.field, op: clause.op as Candidate['op'], value: clause.value });
  }

  const equality = candidates.find(candidate => candidate.op === '==');
  const field = equality?.field ?? candidates.find(candidate => only && candidate.field === only.by && candidate.op !== '==')?.field ?? candidates.find(candidate => action === 'read' && candidate.op !== '==')?.field;
  const onField = candidates.filter(candidate => candidate.field === field);
  const absorbed = new Set<Clause>();
  let equalTo: RealtimeScalar | undefined;
  let start: RealtimeBound | undefined;
  let end: RealtimeBound | undefined;
  if (field !== undefined) {
    const exact = onField.find(candidate => candidate.op === '==');
    if (exact) {
      equalTo = exact.value;
      absorbed.add(exact.clause);
    } else if (action === 'read') {
      const low = onField.find(candidate => candidate.op === '>=' || candidate.op === '>');
      const high = onField.find(candidate => candidate.op === '<=' || candidate.op === '<');
      if (low) {
        start = { value: low.value, inclusive: low.op === '>=' };
        absorbed.add(low.clause);
      }
      if (high) {
        end = { value: high.value, inclusive: high.op === '<=' };
        absorbed.add(high.clause);
      }
    }
  }
  const local = request.clauses.filter(clause => !absorbed.has(clause));

  const distinct = 'distinct' in request && request.distinct;
  const offset = ('offset' in request ? request.offset : undefined) ?? 0;
  const hasCursor = Boolean(request.cursor?.start || request.cursor?.end);
  const exactFilter = field === undefined || equalTo !== undefined;
  const orderExact = order.length === 0 || (only !== undefined && only.direction === 'asc' && (field === undefined || only.by === field));
  const canLimit = exactFilter && local.length === 0 && !distinct && !hasCursor && orderExact;

  let limit: RealtimeQuery['limit'];
  if (canLimit && request.limit !== undefined && request.limitLast === undefined) limit = { first: offset + request.limit };
  else if (canLimit && request.limitLast !== undefined && offset === 0) limit = { last: request.limitLast };

  // A clause that cannot run is the better thing to report, and the caller does.
  if (action === 'listen' && (request.limit !== undefined || request.limitLast !== undefined) && !limit && local.length === 0) {
    throw new UnsupportedQueryError(
      'Realtime Database can limit a live list only when one ascending child order (or key order) and at most one equality decide the answer. Read it once with get(), which orders and limits locally.',
    );
  }

  let ordering: RealtimeQuery['order'];
  if (field !== undefined) ordering = field === keyField ? { key: true } : { child: field };
  else if (limit && only) ordering = { child: only.by as string };

  const query: RealtimeQuery = { order: ordering, equalTo, start, end, limit };
  const useful = ordering || equalTo !== undefined || start || end || limit;
  return { query: useful ? query : undefined, local };
}

/** What a live list needs: nothing Realtime Database cannot do, and no condition left to run here. Refuses before anything connects. */
function planLive(request: ListenRequest): { query: RealtimeQuery | undefined; local: Clause[] } {
  refuseWhatItHasNo(request);
  if (request.cursor) {
    throw new UnsupportedQueryError('Realtime Database cannot page a live list with a cursor, because the listener is per child. Read it once with get(), which pages locally.');
  }
  const plan = planRealtime(request, 'listen');
  if (plan.local[0]) throw new UnsupportedQueryError(`Realtime Database cannot run "${describeClause(plan.local[0])}". A live list filters on one equality on a child. ${HINT}`);
  return plan;
}

/** What a query sent to Realtime Database says, in words. */
function describeRealtimeQuery(path: string, query: RealtimeQuery | undefined): string[] {
  const lines = [`the list "${path}"`];
  if (query?.order) lines.push('key' in query.order ? 'order by key' : `order by the child "${query.order.child}"`);
  if (query?.equalTo !== undefined) lines.push(`equal to ${JSON.stringify(query.equalTo)}`);
  if (query?.start) lines.push(`start ${query.start.inclusive ? 'at' : 'after'} ${JSON.stringify(query.start.value)}`);
  if (query?.end) lines.push(`end ${query.end.inclusive ? 'at' : 'before'} ${JSON.stringify(query.end.value)}`);
  if (query?.limit) lines.push('first' in query.limit ? `the first ${query.limit.first}` : `the last ${query.limit.last}`);
  return lines;
}

const join = (...segments: string[]): string => segments.join('/');

/** One listener per selected attribute. `contact.*` listens to each child of `contact`. */
function openAttributes(
  transport: RealtimeTransport,
  base: string,
  attributes: readonly string[],
  emit: (attribute: string, value: unknown) => void,
  fail: (error: unknown) => void,
): Unsubscribe {
  const stops: Unsubscribe[] = [];
  const stopAll = () => {
    for (const stop of stops.splice(0)) stop();
  };
  try {
    for (const attribute of new Set(attributes)) {
      if (attribute === '*') {
        stops.push(transport.onValue(base, value => emit('*', value), fail));
      } else if (attribute.endsWith('.*')) {
        const parent = attribute.slice(0, -2);
        const set = (key: string, value: unknown) => emit(`${parent}.${key}`, value);
        stops.push(
          transport.onChildren(join(base, parent), undefined, { added: set, changed: set, removed: key => set(key, undefined) }, fail),
        );
      } else {
        stops.push(transport.onValue(join(base, attribute), value => emit(attribute, value), fail));
      }
    }
  } catch (error) {
    stopAll();
    throw error;
  }
  return stopAll;
}

function openRealtime(transport: RealtimeTransport, request: ListenRequest, query: RealtimeQuery | undefined, sink: Sink): Unsubscribe {
  if (!request.collection) {
    return openAttributes(transport, request.path, request.attributes, (attribute, value) => sink.emit({ attribute, value }), sink.fail);
  }

  // A list: the query tracks which children exist. Each child then gets its own attribute listeners.
  const children = new Map<string, Unsubscribe>();
  const stopMembership = transport.onChildren(
    request.path,
    query,
    {
      added: key => {
        if (children.has(key)) return;
        children.set(
          key,
          openAttributes(transport, join(request.path, key), request.attributes, (attribute, value) => sink.emit({ key, attribute, value }), sink.fail),
        );
      },
      removed: key => {
        children.get(key)?.();
        children.delete(key);
        sink.emit({ key, attribute: '*', value: undefined, removed: true });
      },
    },
    sink.fail,
  );
  return () => {
    stopMembership();
    for (const stop of children.values()) stop();
    children.clear();
  };
}

/**
 * Realtime Database backend. `select` decides what is listened to, so the
 * callback runs when a selected attribute changes and not when a sibling does.
 * Callers with the same path, selection, query and limit share one set of listeners.
 */
export function realtimeBackend(transport: RealtimeTransport): Backend {
  const registry = new ListenerRegistry();
  return {
    kind: 'realtime',
    listen(request: ListenRequest, subscriber: Subscriber): Unsubscribe {
      const { query } = planLive(request);
      return registry.subscribe(canonicalKey('realtime', request), request.path, sink => openRealtime(transport, request, query, sink), subscriber);
    },
    /** What this query sends to Realtime Database, what is left to do here, whether it can be live, and which child to index. */
    explain(read: ReadRequest, live: ListenRequest | string): QueryExplanation {
      refuseWhatItHasNo(read);
      const { query, local } = planRealtime(read, 'read');
      let followable: QueryExplanation['live'];
      if (typeof live === 'string') followable = { ok: false, reason: live };
      else {
        try {
          planLive(live);
          followable = { ok: true };
        } catch (error) {
          if (!(error instanceof UnsupportedQueryError)) throw error;
          followable = { ok: false, reason: error.message };
        }
      }
      const indexes: IndexAdvice[] = [];
      if (query?.order && 'child' in query.order) {
        indexes.push({
          kind: 'child',
          need: 'recommended',
          path: read.path,
          child: query.order.child.replace(/\./g, '/'),
          because:
            'A query on a child is faster with an ".indexOn" for that child in the security rules. The documentation says indexes are not needed in development unless you use the REST API, and that performance degrades as the data grows. The emulator refuses an ordered one-time read without it.',
        });
      }
      return {
        backend: 'realtime',
        server: describeRealtimeQuery(read.path, query),
        local: localWork(read, { order: Boolean(query?.limit), limit: Boolean(query?.limit) }, local),
        live: followable,
        indexes,
        sent: query,
      };
    },
    /**
     * A node is one read. A list is one read of the children the server can pick out: an equality or a
     * range on one child, and, when it cannot change the answer, an ascending order with a limit. The rest finishes locally.
     */
    async get(request: ReadRequest): Promise<unknown> {
      refuseWhatItHasNo(request);
      if (!request.collection) return transport.getValue(request.path);
      const { query } = planRealtime(request, 'read');
      const rows = await transport.getChildren(request.path, query);
      // With no orderBy the rows keep the database's key order, whatever order the query returned them in.
      return request.orderBy.length === 0 ? [...rows].sort((a, b) => compareKeys(a.key, b.key)) : rows;
    },
  };
}
