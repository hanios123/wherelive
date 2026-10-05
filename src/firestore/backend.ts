import type { Unsubscribe } from '../core/types';
import { testClause, type Clause } from '../core/plan';
import { canonicalKey } from '../listen/canonical';
import { planForBackend, type Capabilities } from '../listen/capabilities';
import { valuesEqual } from '../core/equality';
import { ListenerRegistry, type Sink } from '../listen/registry';
import { localWork, type QueryExplanation } from '../listen/explain';
import { describeFirestoreQuery, firestoreIndexAdvice } from './explain';
import { UnsupportedQueryError } from '../listen/errors';
import type { Backend, ListenRequest, NativeAggregate, NativeOrder, ReadRequest, ReadRow, ReadSource, Subscriber } from '../listen/types';

export type FirestoreData = { readonly [field: string]: unknown };

export interface FirestoreRow {
  readonly id: string;
  readonly data: FirestoreData;
  /**
   * The document's full path. A transport sets it for a collection group, where one id repeats under
   * different parents and the path is what tells the documents apart. Elsewhere the id is enough.
   */
  readonly path?: string;
}

/** The field name that means a document's own id, in a filter, an order or a cursor. The SDK adapter turns it into `documentId()`. */
export const DOCUMENT_ID = '__name__';

export interface FirestoreWhere {
  readonly field: string;
  readonly op: '==' | '!=' | '<' | '<=' | '>' | '>=' | 'array-contains' | 'array-contains-any' | 'in' | 'not-in';
  /** For `in`, `not-in` and `array-contains-any`, an array. */
  readonly value: unknown;
}

/** `(a AND b) OR (c)`: true when every filter of any one group is. Firestore's `or(and(…), …)`. */
export interface FirestoreAny {
  readonly any: readonly (readonly FirestoreWhere[])[];
}

export type FirestoreFilter = FirestoreWhere | FirestoreAny;

/** Where a page starts or ends: the values of the first `orderBy` fields. */
export interface FirestoreCursor {
  readonly values: readonly unknown[];
  readonly inclusive: boolean;
}

/**
 * What Firestore runs on the server. An order, a cursor and a limit are here only when the
 * server can decide the answer with them, so they never change which rows the full query keeps.
 */
export interface FirestoreQuery {
  readonly where: readonly FirestoreFilter[];
  readonly orderBy: readonly NativeOrder[];
  readonly start?: FirestoreCursor;
  readonly end?: FirestoreCursor;
  readonly limit?: number;
  /** `true` for a collection group: `path` is a collection id and the query covers every collection with that name. */
  readonly group?: boolean;
}

export interface FirestoreReadOptions {
  readonly source?: ReadSource;
}

/**
 * One document entering, changing in, or leaving the result of a live query. A document
 * that falls outside a `limit` window is `removed`, and one that moves into it is `added`.
 */
export type FirestoreChange =
  | { readonly type: 'added' | 'modified'; readonly id: string; readonly data: FirestoreData; readonly path?: string }
  | { readonly type: 'removed'; readonly id: string; readonly path?: string };

/**
 * The seam between the library and the Firestore SDK. `wherelive/firebase`
 * implements it on the real SDK. `wherelive/testing` implements it in memory.
 * Four functions are required. `getAggregate` and `onCollectionChanges` are optional:
 * without `getAggregate` the rows are read and aggregated here, and without
 * `onCollectionChanges` a live list is followed by comparing whole snapshots.
 */
export interface FirestoreTransport {
  /** The document now, and again on every snapshot. `undefined` when it does not exist. */
  onDocument(path: string, next: (data: FirestoreData | undefined) => void, error: (error: unknown) => void): Unsubscribe;
  /** The documents of a collection that satisfy the query, on every snapshot. */
  onCollection(
    path: string,
    query: FirestoreQuery,
    next: (rows: readonly FirestoreRow[]) => void,
    error: (error: unknown) => void,
  ): Unsubscribe;
  /**
   * The same live query, reported as changes. The first call lists every document in the result as `added`
   * (an empty list when there are none). Each call after it lists only what changed since the one before.
   * Use this when your source can tell you: a list of ten thousand documents then costs what changed, not
   * what is there. When it is present it is used instead of `onCollection`, which it does not replace for anyone else.
   */
  onCollectionChanges?(
    path: string,
    query: FirestoreQuery,
    next: (changes: readonly FirestoreChange[]) => void,
    error: (error: unknown) => void,
  ): Unsubscribe;
  /** The document once. `undefined` when it does not exist. */
  getDocument(path: string, options?: FirestoreReadOptions): Promise<FirestoreData | undefined>;
  /** The documents of a collection that satisfy the query, once. */
  getCollection(path: string, query: FirestoreQuery, options?: FirestoreReadOptions): Promise<readonly FirestoreRow[]>;
  /** A count, or a sum or average, computed by Firestore without reading the documents. `null` is an average of nothing. */
  getAggregate?(
    path: string,
    query: FirestoreQuery,
    aggregates: Readonly<Record<string, NativeAggregate>>,
    options?: FirestoreReadOptions,
  ): Promise<Record<string, number | null>>;
}

/** Firestore runs at most this many disjunctions in a query: the size of an `IN`, the alternatives of an `or`, multiplied together. */
const MAX_DISJUNCTIONS = 30;
/** A `not-in` takes at most this many values. */
const NOT_IN_LIMIT = 10;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

// ---- what Firestore can run ----------------------------------------------------

const onKey = (field: string, keyField: string | undefined): boolean => keyField !== undefined && (field === keyField || field.startsWith(`${keyField}.`));

/** A condition Firestore can run as one filter. A condition on the key is only a whole-key comparison, in or not-in. */
function runsAsFilter(clause: Clause, keyField: string | undefined): boolean {
  switch (clause.kind) {
    case 'compare':
    case 'in':
      return !onKey(clause.field, keyField) || clause.field === keyField;
    case 'notIn':
      return clause.values.length <= NOT_IN_LIMIT && (!onKey(clause.field, keyField) || clause.field === keyField);
    case 'includes':
    case 'includesAny':
      return !onKey(clause.field, keyField);
    default:
      return false;
  }
}

/** Inside an `or` a list cannot be split, so it must fit on its own. */
const listFits = (clause: Clause): boolean => (clause.kind === 'in' || clause.kind === 'includesAny' ? clause.values.length <= MAX_DISJUNCTIONS : true);

function capabilities(keyField: string | undefined): Capabilities {
  return {
    name: 'Firestore',
    isNative: clause =>
      clause.kind === 'or' ? clause.groups.every(group => group.every(inner => runsAsFilter(inner, keyField) && listFits(inner))) : runsAsFilter(clause, keyField),
    leftovers: 'local',
    hint: '',
  };
}

// ---- rewriting conditions that are always true or never true --------------------

/** `IN ()` matches nothing, `NOT IN ()` everything, and Firestore refuses both empty. Fold them away, through any `or`. */
function reduceClause(clause: Clause): Clause[] | 'never' {
  switch (clause.kind) {
    case 'in':
    case 'includesAny':
      return clause.values.length === 0 ? 'never' : [clause];
    case 'notIn':
      return clause.values.length === 0 ? [] : [clause];
    case 'or': {
      const kept: Clause[][] = [];
      for (const group of clause.groups) {
        const parts = group.map(reduceClause);
        if (parts.includes('never')) continue;
        const flat = parts.flat() as Clause[];
        if (flat.length === 0) return []; // a group that is always true makes the whole or true
        kept.push(flat);
      }
      if (kept.length === 0) return 'never';
      return kept.length === 1 ? (kept[0] as Clause[]) : [{ kind: 'or', groups: kept }];
    }
    default:
      return [clause];
  }
}

function simplify(clauses: readonly Clause[]): { clauses: Clause[]; never: boolean } {
  const out: Clause[] = [];
  for (const clause of clauses) {
    const reduced = reduceClause(clause);
    if (reduced === 'never') return { clauses: [], never: true };
    out.push(...reduced);
  }
  return { clauses: out, never: false };
}

// ---- to the transport's vocabulary ----------------------------------------------

function toWhere(clause: Clause, keyField: string | undefined): FirestoreWhere {
  const field = (name: string) => (name === keyField ? DOCUMENT_ID : name);
  switch (clause.kind) {
    case 'compare':
      return { field: field(clause.field), op: clause.op, value: clause.value };
    case 'includes':
      return { field: clause.field, op: 'array-contains', value: clause.value };
    case 'includesAny':
      return { field: clause.field, op: 'array-contains-any', value: clause.values };
    case 'in':
      return { field: field(clause.field), op: 'in', value: clause.values };
    case 'notIn':
      return { field: field(clause.field), op: 'not-in', value: clause.values };
    default:
      throw new Error('That cannot be sent to Firestore as one filter.');
  }
}

function toFilter(clause: Clause, keyField: string | undefined): FirestoreFilter {
  return clause.kind === 'or' ? { any: clause.groups.map(group => group.map(inner => toWhere(inner, keyField))) } : toWhere(clause, keyField);
}

const isList = (filter: FirestoreFilter): filter is FirestoreWhere => 'op' in filter && (filter.op === 'in' || filter.op === 'array-contains-any');
const listLength = (filter: FirestoreWhere): number => (filter.value as unknown[]).length;

function disjunctionsOf(filter: FirestoreFilter): number {
  if ('any' in filter) return filter.any.reduce((sum, group) => sum + group.reduce((product, where) => product * disjunctionsOf(where), 1), 0);
  return isList(filter) ? listLength(filter) : 1;
}

/**
 * Make what is sent fit Firestore's limit of 30 disjunctions. One long `IN` is split into groups sized
 * to leave room for the rest. If it still cannot fit, an `or` is given to the local side instead.
 */
function fit(
  native: readonly Clause[],
  local: readonly Clause[],
  keyField: string | undefined,
  action: 'listen' | 'read',
): { native: Clause[]; local: Clause[]; chunk?: { index: number; size: number } } {
  const nat = [...native];
  const loc = [...local];
  for (;;) {
    const filters = nat.map(clause => toFilter(clause, keyField));
    const sizes = filters.map(disjunctionsOf);
    const total = sizes.reduce((product, size) => product * size, 1);
    if (total <= MAX_DISJUNCTIONS) return { native: nat, local: loc };

    let split = -1;
    let longest = 0;
    filters.forEach((filter, index) => {
      if (isList(filter) && listLength(filter) > longest) {
        longest = listLength(filter);
        split = index;
      }
    });
    if (split >= 0) {
      const others = total / longest;
      if (others <= MAX_DISJUNCTIONS) {
        const size = Math.max(1, Math.floor(MAX_DISJUNCTIONS / others));
        if (action === 'listen') {
          throw new UnsupportedQueryError(
            `Firestore cannot listen to a list of more than ${size} values in an IN or includes-any here. Read it once with get(), which splits it, or narrow the list.`,
          );
        }
        return { native: nat, local: loc, chunk: { index: split, size } };
      }
    }
    let heaviest = -1;
    let most = 0;
    nat.forEach((clause, index) => {
      if (clause.kind === 'or' && (sizes[index] as number) > most) {
        most = sizes[index] as number;
        heaviest = index;
      }
    });
    if (heaviest < 0) {
      throw new UnsupportedQueryError(
        `Firestore runs at most ${MAX_DISJUNCTIONS} disjunctions in a query, and this one multiplies to ${total}. Split one IN, or read the parts separately and union them.`,
      );
    }
    loc.push(nat[heaviest] as Clause);
    nat.splice(heaviest, 1);
  }
}

// ---- deciding what the server may order, cut and page ---------------------------

type Shaped = Pick<FirestoreQuery, 'orderBy' | 'start' | 'end' | 'limit'>;

/** The fields a set of conditions compares with `<`, `<=`, `>`, `>=`, `!=` or `not-in`, through any `or`. */
function inequalityFieldsOf(clauses: readonly Clause[]): Set<string> {
  const fields = new Set<string>();
  const walk = (clause: Clause): void => {
    if (clause.kind === 'or') clause.groups.forEach(group => group.forEach(walk));
    else if (clause.kind === 'notIn' || (clause.kind === 'compare' && clause.op !== '==')) fields.add(clause.field);
  };
  clauses.forEach(walk);
  return fields;
}

/**
 * Firestore puts the document name last in every order. An order that has the name before another field cannot be
 * sent, and neither can one by the name beside a range on another field, which would sort by that field after it.
 * Those are finished here instead.
 */
function nameIsNotLast(order: readonly { readonly by: unknown }[], native: readonly Clause[], keyField: string | undefined): boolean {
  if (keyField === undefined) return false;
  const at = order.findIndex(key => key.by === keyField);
  if (at < 0) return false;
  if (at < order.length - 1) return true;
  const ordered = new Set(order.map(key => key.by));
  return [...inequalityFieldsOf(native)].some(field => field !== keyField && !ordered.has(field));
}

const flip = (direction: 'asc' | 'desc'): 'asc' | 'desc' => (direction === 'asc' ? 'desc' : 'asc');

/**
 * An order, a cursor and a limit go to the server only when they cannot change the answer.
 * A cursor is a test on the order values, so it is safe beside local checks. A limit cuts before
 * any local check runs, so it needs every filter to run on the server, and no distinct. The last
 * rows are the first rows of the reversed order. An order alone is not sent: it would only drop
 * documents that lack the field, and the rows are ordered here anyway.
 */
/**
 * The emulator will not scan keys backwards on their own. When the keys are given (`==` or `in` on the key) the
 * read is small, so a descending order by the key is finished here and not sent. An order that another field
 * narrows is sent: Firestore scans that index backwards without trouble.
 */
function descendingOverGivenKeys(order: readonly { readonly by: unknown; readonly direction: string }[], native: readonly Clause[], keyField: string | undefined): boolean {
  const [only] = order;
  if (keyField === undefined || order.length !== 1 || only?.by !== keyField || only.direction !== 'desc') return false;
  const givesKeys = native.some(clause => (clause.kind === 'in' || (clause.kind === 'compare' && clause.op === '==')) && clause.field === keyField);
  const narrowed = native.some(
    clause => clause.kind === 'or' || (clause.kind !== 'predicate' && clause.field !== keyField && (clause.kind === 'in' || clause.kind === 'includes' || clause.kind === 'includesAny' || (clause.kind === 'compare' && clause.op === '=='))),
  );
  return givesKeys && !narrowed;
}

function shape(request: ListenRequest | ReadRequest, native: readonly Clause[], local: readonly Clause[], action: 'listen' | 'read'): Shaped {
  const order = request.orderBy ?? [];
  const orderIsNative = order.length > 0 && order.every(key => typeof key.by === 'string' && !key.locale) && !nameIsNotLast(order, native, request.keyField) && !descendingOverGivenKeys(order, native, request.keyField);
  const cursor = request.cursor;
  const hasCursor = Boolean(cursor?.start || cursor?.end);
  const offset = ('offset' in request ? request.offset : undefined) ?? 0;
  const distinct = 'distinct' in request && request.distinct;
  const everyFilterOnServer = local.length === 0;
  const field = (key: (typeof order)[number]) => (key.by === request.keyField ? DOCUMENT_ID : (key.by as string));

  if (action === 'listen') {
    if ((hasCursor || request.limitLast !== undefined) && !orderIsNative) {
      throw new UnsupportedQueryError(
        nameIsNotLast(order, native, request.keyField)
          ? 'Firestore puts the key last in an order, so a live cursor or limitToLast cannot order by the key together with another sort field or a range on another field. Use get().'
          : 'A live list with a cursor or limitToLast needs an orderBy by fields. Use get() to page by language or by a function.',
      );
    }
    if ((request.limit !== undefined || request.limitLast !== undefined) && !everyFilterOnServer) {
      throw new UnsupportedQueryError(
        'A limit needs every filter to run on Firestore: a limit applied before a local check changes which rows make the cut. Use a field filter, or read once with get().',
      );
    }
    if (request.limitLast !== undefined && hasCursor) {
      throw new UnsupportedQueryError('A live list cannot combine limitToLast with a cursor. Use get().');
    }
    if (request.limit !== undefined && order.length > 0 && !orderIsNative) {
      throw new UnsupportedQueryError(
        nameIsNotLast(order, native, request.keyField)
          ? 'Firestore puts the key last in an order, so a live list cannot be limited by the key together with another sort field or a range on another field. Use get().'
          : "A live list with a limit can only be ordered by fields, in the database's own order. Use get() to order by language or by a function.",
      );
    }
  }

  const pushLimit =
    request.limit !== undefined && request.limitLast === undefined && everyFilterOnServer && !distinct && (order.length === 0 || orderIsNative);
  const pushLast = request.limitLast !== undefined && everyFilterOnServer && !distinct && offset === 0 && !hasCursor && orderIsNative;
  const pushCursor = hasCursor && orderIsNative;
  const pushOrder = orderIsNative && (pushLimit || pushLast || pushCursor);

  return {
    orderBy: pushOrder ? order.map(key => ({ field: field(key), direction: pushLast ? flip(key.direction) : key.direction })) : [],
    start: pushCursor ? cursor?.start : undefined,
    end: pushCursor ? cursor?.end : undefined,
    limit: pushLimit ? offset + (request.limit as number) : pushLast ? request.limitLast : undefined,
  };
}

function build(request: ListenRequest | ReadRequest, native: readonly Clause[], shaped: Shaped): FirestoreQuery {
  return { where: native.map(clause => toFilter(clause, request.keyField)), ...shaped, ...(request.group ? { group: true } : {}) };
}

/** The pieces every read and listen starts from. */
function prepare(request: ListenRequest | ReadRequest, action: 'listen' | 'read') {
  const { clauses, never } = simplify(request.clauses);
  if (never) return { never: true as const };
  const split = planForBackend(clauses, capabilities(request.keyField), { allowLocal: true });
  const fitted = fit(split.native, split.local, request.keyField, action);
  return { never: false as const, ...fitted };
}

// ---- following a live list ------------------------------------------------------

/** The selected attributes of one document, flattened the way the change events name them. */
function project(data: FirestoreData | undefined, attributes: readonly string[]): Map<string, unknown> {
  const projected = new Map<string, unknown>();
  for (const attribute of attributes) {
    if (attribute === '*') {
      projected.set('*', data);
    } else if (attribute.endsWith('.*')) {
      const parent = attribute.slice(0, -2);
      const nested = data?.[parent];
      if (isRecord(nested)) for (const [key, value] of Object.entries(nested)) projected.set(`${parent}.${key}`, value);
    } else {
      projected.set(attribute, data?.[attribute]);
    }
  }
  return projected;
}

/**
 * Compare with the previous projection. The first projection is sent whole.
 * After that only attributes that differ are sent, and an event whose selected
 * attributes did not change sends nothing.
 */
function diff(previous: Map<string, unknown> | undefined, next: Map<string, unknown>, emit: (attribute: string, value: unknown) => void): void {
  for (const [attribute, value] of next) {
    if (!previous || !previous.has(attribute) || !valuesEqual(previous.get(attribute), value)) emit(attribute, value);
  }
  if (previous) for (const attribute of previous.keys()) if (!next.has(attribute)) emit(attribute, undefined);
}

function openFirestore(
  transport: FirestoreTransport,
  request: ListenRequest,
  query: FirestoreQuery,
  local: readonly Clause[],
  sink: Sink,
): Unsubscribe {
  const guarded = <A extends unknown[]>(handler: (...args: A) => void) => (...args: A) => {
    try {
      handler(...args);
    } catch (error) {
      sink.fail(error);
    }
  };

  if (!request.collection) {
    let previous: Map<string, unknown> | undefined;
    return transport.onDocument(
      request.path,
      guarded(data => {
        const next = project(data, request.attributes);
        diff(previous, next, (attribute, value) => sink.emit({ attribute, value }));
        previous = next;
      }),
      sink.fail,
    );
  }

  const rows = new Map<string, Map<string, unknown>>();
  const keyField = request.keyField;
  // A row is known by its key. In a collection group one id repeats under different parents, so the key is the
  // full path there when the transport gives it. A transport that does not keeps the id, as it always did.
  const keyOf = (id: string, path: string | undefined): string => (request.group && path !== undefined ? path : id);

  // Clauses Firestore cannot run are applied here, so a row can enter or leave the result on any update.
  // The row is copied to add its key only when one of those clauses can read it.
  const passesLocal = (id: string, data: FirestoreData): boolean => {
    if (local.length === 0) return true;
    const seen = keyField ? { ...data, [keyField]: id } : data;
    return local.every(clause => testClause(clause, seen));
  };
  const drop = (key: string): void => {
    if (!rows.delete(key)) return;
    sink.emit({ key, attribute: '*', value: undefined, removed: true });
  };
  const show = (key: string, data: FirestoreData): void => {
    const next = project(data, request.attributes);
    diff(rows.get(key), next, (attribute, value) => sink.emit({ key, attribute, value }));
    rows.set(key, next);
  };

  if (transport.onCollectionChanges) {
    return transport.onCollectionChanges(
      request.path,
      query,
      guarded(changes => {
        for (const change of changes) {
          const key = keyOf(change.id, change.path);
          if (change.type === 'removed' || !passesLocal(change.id, change.data)) drop(key);
          else show(key, change.data);
        }
      }),
      sink.fail,
    );
  }

  return transport.onCollection(
    request.path,
    query,
    guarded(snapshot => {
      const current = new Map<string, FirestoreData>();
      for (const row of snapshot) {
        if (!passesLocal(row.id, row.data)) continue;
        const key = keyOf(row.id, row.path);
        if (request.group && current.has(key)) {
          throw new Error(`A collection group has more than one row with the id "${row.id}", and the transport gave no path to tell them apart. Set "path" on each row.`);
        }
        current.set(key, row.data);
      }

      for (const key of [...rows.keys()]) if (!current.has(key)) drop(key);
      for (const [key, data] of current) show(key, data);
    }),
    sink.fail,
  );
}

// ---- reading once ---------------------------------------------------------------

/** One query per group of values, run together, merged without duplicates. The full plan re-orders and re-limits the union. */
async function readInChunks(
  transport: FirestoreTransport,
  path: string,
  query: FirestoreQuery,
  chunk: { index: number; size: number },
  options: FirestoreReadOptions,
): Promise<FirestoreRow[]> {
  const list = query.where[chunk.index] as FirestoreWhere;
  const values = list.value as unknown[];
  const groups: unknown[][] = [];
  for (let start = 0; start < values.length; start += chunk.size) groups.push(values.slice(start, start + chunk.size));
  const results = await Promise.all(
    groups.map(group => transport.getCollection(path, { ...query, where: query.where.map((filter, i) => (i === chunk.index ? { ...list, value: group } : filter)) }, options)),
  );
  const seen = new Set<string>();
  const merged: FirestoreRow[] = [];
  for (const result of results) {
    for (const row of result) {
      if (seen.has(row.id)) continue;
      seen.add(row.id);
      merged.push(row);
    }
  }
  return merged;
}

/** Whether the same query could be followed live, decided the way `listen` decides it, without connecting. */
function canFollow(live: ListenRequest | string): QueryExplanation['live'] {
  if (typeof live === 'string') return { ok: false, reason: live };
  try {
    const prepared = prepare(live, 'listen');
    if (!prepared.never) shape(live, prepared.native, prepared.local, 'listen');
    return { ok: true };
  } catch (error) {
    if (error instanceof UnsupportedQueryError) return { ok: false, reason: error.message };
    throw error;
  }
}

/**
 * Firestore backend. The server still delivers a snapshot when another field
 * changes. This compares the selected attributes with the previous snapshot and
 * drops the event when they are unchanged, which is what a Realtime Database
 * child listener does natively.
 */
export function firestoreBackend(transport: FirestoreTransport): Backend {
  const registry = new ListenerRegistry();
  return {
    kind: 'firestore',
    listen(request: ListenRequest, subscriber: Subscriber): Unsubscribe {
      // Refuse an unusable query now, before any connection opens.
      const prepared = prepare(request, 'listen');
      if (prepared.never) return () => {}; // nothing can match, so there is nothing to hear
      const query = build(request, prepared.native, shape(request, prepared.native, prepared.local, 'listen'));
      return registry.subscribe(canonicalKey('firestore', request), request.path, sink => openFirestore(transport, request, query, prepared.local, sink), subscriber);
    },
    /**
     * A document is one read. A list is read with everything Firestore can run on the server: filters
     * including `or`, an IN of any size split to fit, document-id conditions, and, only when it cannot
     * change the answer, the order, a cursor and a limit. The rest finishes locally on the rows that come back.
     */
    async get(request: ReadRequest): Promise<unknown> {
      const options: FirestoreReadOptions = { source: request.source };
      if (!request.collection) return transport.getDocument(request.path, options);
      const prepared = prepare(request, 'read');
      if (prepared.never) return [];
      const query = build(request, prepared.native, shape(request, prepared.native, prepared.local, 'read'));
      const rows = prepared.chunk ? await readInChunks(transport, request.path, query, prepared.chunk, options) : await transport.getCollection(request.path, query, options);
      return rows.map((row): ReadRow => ({ key: row.id, value: row.data }));
    },
    /** What this query sends to Firestore, what is left to do here, whether it can be live, and which indexes it needs. */
    explain(read: ReadRequest, live: ListenRequest | string): QueryExplanation {
      const prepared = prepare(read, 'read');
      if (prepared.never) {
        return { backend: 'firestore', server: ['nothing is sent: no row can match'], local: [], live: canFollow(live), indexes: [], sent: undefined };
      }
      const shaped = shape(read, prepared.native, prepared.local, 'read');
      const query = build(read, prepared.native, shaped);
      return {
        backend: 'firestore',
        server: describeFirestoreQuery(read.path, query, prepared.chunk),
        local: localWork(read, { order: shaped.orderBy.length > 0, limit: shaped.limit !== undefined }, prepared.local),
        live: canFollow(live),
        indexes: firestoreIndexAdvice(read.path, query),
        sent: query,
      };
    },
    /** Counts, sums and averages that Firestore computes without reading the documents, when this query allows it. */
    async aggregate(request: ReadRequest, aggregates: Readonly<Record<string, NativeAggregate>>): Promise<Record<string, number | undefined> | undefined> {
      if (!transport.getAggregate || !request.collection || request.source === 'cache') return undefined; // Firestore aggregates always come from the server
      if (request.limit !== undefined || request.limitLast !== undefined || request.cursor || request.distinct || request.offset) return undefined;
      if (Object.values(aggregates).some(aggregate => aggregate.op !== 'count' && onKey(aggregate.field, request.keyField))) return undefined;
      const prepared = prepare(request, 'read');
      const empty = () => Object.fromEntries(Object.entries(aggregates).map(([name, aggregate]) => [name, aggregate.op === 'avg' ? undefined : 0]));
      if (prepared.never) return empty();
      if (prepared.local.length > 0 || prepared.chunk) return undefined;
      const query = build(request, prepared.native, { orderBy: [] });
      // Firestore aggregates only the documents that have every field a query aggregates on, so a count beside a sum,
      // or sums of two fields, would each be computed over fewer documents than the rows hold. Ask for each group on
      // its own: a count, and the sums and averages of one field. The answer is then the one the rows give.
      const groups = new Map<string, Record<string, NativeAggregate>>();
      for (const [name, aggregate] of Object.entries(aggregates)) {
        const key = aggregate.op === 'count' ? '' : `field:${aggregate.field}`;
        groups.set(key, { ...groups.get(key), [name]: aggregate });
      }
      const getAggregate = transport.getAggregate.bind(transport);
      const parts = await Promise.all([...groups.values()].map(group => getAggregate(request.path, query, group, { source: request.source })));
      return Object.fromEntries(parts.flatMap(part => Object.entries(part)).map(([name, value]) => [name, value === null ? undefined : value]));
    },
  };
}
