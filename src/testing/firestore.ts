import { comparableOrder, compareValues } from '../core/compare';
import { getPath } from '../core/path';
import { DOCUMENT_ID } from '../firestore/backend';
import type {
  FirestoreChange,
  FirestoreCursor,
  FirestoreData,
  FirestoreFilter,
  FirestoreQuery,
  FirestoreReadOptions,
  FirestoreRow,
  FirestoreTransport,
  FirestoreWhere,
} from '../firestore/backend';
import { valuesEqual } from '../core/equality';
import type { NativeAggregate } from '../listen/types';
import type { Unsubscribe } from '../core/types';

interface Listener {
  readonly path: string;
  readonly error: (error: unknown) => void;
  refresh(): void;
}

/** Copy plain data, keeping dates and Timestamp-like values intact: they are values, and JSON would turn them into text. */
function clone<V>(value: V): V {
  if (Array.isArray(value)) return value.map(clone) as V;
  if (value instanceof Date) return new Date(value.getTime()) as V;
  if (typeof value === 'object' && value !== null && Object.getPrototypeOf(value) === Object.prototype) {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, clone(inner)])) as V;
  }
  return value;
}

const permissionDenied = (): Error => Object.assign(new Error('Missing or insufficient permissions.'), { code: 'permission-denied' });

const isList = (op: FirestoreWhere['op']): boolean => op === 'in' || op === 'not-in' || op === 'array-contains-any';

/**
 * Firestore's own rules, so a test finds out what the real one would say: `!=`, `not-in`
 * and every comparison skip a document that lacks the field, and `in` never matches one.
 */
function matches(row: FirestoreRow, filter: FirestoreFilter): boolean {
  if ('any' in filter) return filter.any.some(group => group.every(inner => matches(row, inner)));
  const value = filter.field === DOCUMENT_ID ? row.id : getPath(row.data, filter.field);
  const present = value !== undefined;
  const right = filter.value;
  const order = comparableOrder(value, right);
  switch (filter.op) {
    case '==':
      return valuesEqual(value, right);
    case '!=':
      // A field set to null is not matched either: `null != 6` is not true in Firestore.
      return present && value !== null && !valuesEqual(value, right);
    case '<':
      return order !== undefined && order < 0;
    case '<=':
      return order !== undefined && order <= 0;
    case '>':
      return order !== undefined && order > 0;
    case '>=':
      return order !== undefined && order >= 0;
    case 'array-contains':
      return Array.isArray(value) && (value as unknown[]).some(element => valuesEqual(element, right));
    case 'array-contains-any':
      return Array.isArray(value) && (value as unknown[]).some(element => (right as unknown[]).some(candidate => valuesEqual(element, candidate)));
    case 'in':
      return present && (right as unknown[]).some(candidate => valuesEqual(value, candidate));
    case 'not-in':
      // With a null among the values nothing can be known to be outside the list, so nothing matches, as in SQL.
      return present && value !== null && !(right as unknown[]).includes(null) && !(right as unknown[]).some(candidate => valuesEqual(value, candidate));
  }
}

/** The fields a query compares with `<`, `<=`, `>`, `>=`, `!=` or `not-in`, anywhere in it, including inside an `or`. */
function inequalityFields(filters: readonly FirestoreFilter[]): Set<string> {
  const fields = new Set<string>();
  const walk = (filter: FirestoreFilter): void => {
    if ('any' in filter) filter.any.forEach(group => group.forEach(walk));
    else if (['<', '<=', '>', '>=', '!=', 'not-in'].includes(filter.op) && filter.field !== DOCUMENT_ID) fields.add(filter.field);
  };
  filters.forEach(walk);
  return fields;
}

/** Documents are named by their path, compared one segment at a time and by code unit, which is how Firestore orders names. */
function compareNames(a: FirestoreRow, b: FirestoreRow): number {
  const left = (a.path ?? a.id).split('/');
  const right = (b.path ?? b.id).split('/');
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    const one = left[index] as string;
    const other = right[index] as string;
    if (one !== other) return one < other ? -1 : 1;
  }
  return left.length - right.length;
}

/** How many disjunctions Firestore counts: the alternatives of an `or`, and the values of an `in`, multiplied together. */
function disjunctions(filter: FirestoreFilter): number {
  if ('any' in filter) return filter.any.reduce((sum, group) => sum + group.reduce((product, inner) => product * disjunctions(inner), 1), 0);
  return filter.op === 'in' || filter.op === 'array-contains-any' ? (filter.value as unknown[]).length : 1;
}

/** Refuse what Firestore refuses, so a backend that sends it is caught. */
function validate(query: FirestoreQuery): void {
  const walk = (filter: FirestoreFilter): void => {
    if ('any' in filter) {
      filter.any.forEach(group => group.forEach(walk));
      return;
    }
    if (!isList(filter.op)) return;
    const values = filter.value;
    if (!Array.isArray(values) || values.length === 0) throw new Error(`Invalid Query. A non-empty array is required for '${filter.op}' filters.`);
    const max = filter.op === 'not-in' ? 10 : 30;
    if (values.length > max) throw new Error(`Invalid Query. '${filter.op}' filters support a maximum of ${max} elements in the value array.`);
  };
  query.where.forEach(walk);
  const total = query.where.reduce((product, filter) => product * disjunctions(filter), 1);
  if (total > 30) throw new Error(`Invalid Query. A query supports at most 30 disjunctions, and this one has ${total}.`);
  // The name of a document is always the last thing a query sorts by, so nothing may follow it: not another field
  // of the order, and not a field compared with a range, `!=` or `not-in`, which would be sorted after it.
  const nameAt = query.orderBy.findIndex(order => order.field === DOCUMENT_ID);
  if (nameAt >= 0) {
    const ordered = new Set(query.orderBy.map(order => order.field));
    const followed = nameAt < query.orderBy.length - 1 || [...inequalityFields(query.where)].some(field => !ordered.has(field));
    if (followed) throw new Error('Invalid Query. order by clause cannot contain more fields after the key');
  }
  // Nor can it scan the names backwards on their own. A condition that an index on another field answers lets it.
  const [only] = query.orderBy;
  const narrowed = query.where.some(filter => 'any' in filter || (filter.field !== DOCUMENT_ID && ['==', 'in', 'array-contains', 'array-contains-any'].includes(filter.op)));
  if (query.orderBy.length === 1 && only?.field === DOCUMENT_ID && only.direction === 'desc' && !narrowed) {
    throw new Error('Firestore does not support descending key scans');
  }
  for (const cursor of [query.start, query.end]) {
    if (cursor && (query.orderBy.length === 0 || cursor.values.length > query.orderBy.length)) {
      throw new Error('Invalid Query. A cursor needs an orderBy, and no more values than it has keys.');
    }
  }
}

/**
 * An in-memory Firestore for tests. Like the real one it delivers a snapshot
 * whenever the watched document, or a document in the watched result, changes,
 * including when only a field you did not select changed. It follows Firestore's
 * query rules: a document that lacks a field you order by is left out, `in` takes
 * at most 30 values and `not-in` 10, a query has at most 30 disjunctions, and a
 * cursor needs an order.
 */
export class MemoryFirestoreTransport implements FirestoreTransport {
  private readonly documents = new Map<string, FirestoreData>();
  private readonly listeners = new Set<Listener>();
  private readonly denied: string[] = [];

  /** Every collection query made through the transport, live or one-time, in order. */
  readonly queryLog: Array<{ path: string; query: FirestoreQuery; options?: FirestoreReadOptions }> = [];
  /** Every single-document read, in order, with the source it asked for. */
  readonly documentLog: Array<{ path: string; options?: FirestoreReadOptions }> = [];
  /** Every aggregate query made, in order. */
  readonly aggregateLog: Array<{ path: string; query: FirestoreQuery; aggregates: Readonly<Record<string, NativeAggregate>> }> = [];

  /** Open listeners. A shared connection keeps this number flat. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  get(path: string): FirestoreData | undefined {
    return clone(this.documents.get(path));
  }

  set(path: string, data: FirestoreData): void {
    this.documents.set(path, clone(data));
    this.notify();
  }

  delete(path: string): void {
    this.documents.delete(path);
    this.notify();
  }

  /** Deny reads at `path` and below. */
  deny(path: string): void {
    this.denied.push(path);
    for (const listener of [...this.listeners]) this.checkAccess(listener);
  }

  onDocument(path: string, next: (data: FirestoreData | undefined) => void, error: (error: unknown) => void): Unsubscribe {
    let last: FirestoreData | undefined;
    let sent = false;
    return this.attach({
      path,
      error,
      refresh: () => {
        const data = this.get(path);
        if (sent && valuesEqual(last, data)) return;
        sent = true;
        last = data;
        next(clone(data));
      },
    });
  }

  onCollection(
    path: string,
    query: FirestoreQuery,
    next: (rows: readonly FirestoreRow[]) => void,
    error: (error: unknown) => void,
  ): Unsubscribe {
    this.queryLog.push({ path, query });
    let last: FirestoreRow[] | undefined;
    return this.attach({
      path,
      error,
      refresh: () => {
        const rows = this.run(path, query);
        if (last && valuesEqual(last, rows)) return;
        last = rows;
        next(clone(rows));
      },
    });
  }

  /**
   * The same live query as `onCollection`, reported the way the Firebase SDK's `docChanges()` does: every
   * document `added` first, then only what was added, modified or removed. Like the SDK, it says nothing
   * when an update leaves the result as it was.
   */
  onCollectionChanges(
    path: string,
    query: FirestoreQuery,
    next: (changes: readonly FirestoreChange[]) => void,
    error: (error: unknown) => void,
  ): Unsubscribe {
    this.queryLog.push({ path, query });
    let last: Map<string, FirestoreRow> | undefined;
    const where = (row: FirestoreRow) => (row.path === undefined ? {} : { path: row.path });
    return this.attach({
      path,
      error,
      refresh: () => {
        const now = new Map(this.run(path, query).map(row => [row.path ?? row.id, row]));
        const changes: FirestoreChange[] = [];
        if (last) for (const [key, row] of last) if (!now.has(key)) changes.push({ type: 'removed', id: row.id, ...where(row) });
        for (const [key, row] of now) {
          const before = last?.get(key);
          if (!before) changes.push({ type: 'added', id: row.id, ...where(row), data: clone(row.data) });
          else if (!valuesEqual(before.data, row.data)) changes.push({ type: 'modified', id: row.id, ...where(row), data: clone(row.data) });
        }
        const first = last === undefined;
        last = now;
        if (first || changes.length > 0) next(changes);
      },
    });
  }

  async getDocument(path: string, options?: FirestoreReadOptions): Promise<FirestoreData | undefined> {
    this.documentLog.push({ path, options });
    if (this.isDenied(path)) throw permissionDenied();
    return this.get(path);
  }

  async getCollection(path: string, query: FirestoreQuery, options?: FirestoreReadOptions): Promise<readonly FirestoreRow[]> {
    this.queryLog.push({ path, query, options });
    if (this.isDenied(path)) throw permissionDenied();
    return this.run(path, query);
  }

  async getAggregate(
    path: string,
    query: FirestoreQuery,
    aggregates: Readonly<Record<string, NativeAggregate>>,
  ): Promise<Record<string, number | null>> {
    this.aggregateLog.push({ path, query, aggregates });
    if (this.isDenied(path)) throw permissionDenied();
    // Like Firestore, aggregate only the documents that have every field a sum or an average is over. That includes the
    // count beside them: asked together, a count covers fewer documents than the query matches.
    const fields = Object.values(aggregates).flatMap(aggregate => (aggregate.op === 'count' ? [] : [aggregate.field]));
    const rows = this.run(path, query).filter(row => fields.every(field => getPath(row.data, field) !== undefined));
    const result: Record<string, number | null> = {};
    for (const [name, aggregate] of Object.entries(aggregates)) {
      if (aggregate.op === 'count') {
        result[name] = rows.length;
        continue;
      }
      const numbers = rows.map(row => getPath(row.data, aggregate.field)).filter((value): value is number => typeof value === 'number');
      const total = numbers.reduce((sum, value) => sum + value, 0);
      result[name] = aggregate.op === 'sum' ? total : numbers.length > 0 ? total / numbers.length : null;
    }
    return result;
  }

  private run(path: string, query: FirestoreQuery): FirestoreRow[] {
    validate(query);
    let rows: FirestoreRow[] = [];
    for (const [documentPath, data] of this.documents) {
      const parts = documentPath.split('/');
      // A collection group is every collection with this name, wherever it is. Otherwise, the direct children of the path.
      const id = query.group
        ? parts.length % 2 === 0 && parts[parts.length - 2] === path
          ? (parts[parts.length - 1] as string)
          : undefined
        : documentPath.startsWith(`${path}/`) && !documentPath.slice(path.length + 1).includes('/')
          ? documentPath.slice(path.length + 1)
          : undefined;
      if (id === undefined) continue;
      // In a collection group the id alone does not name a document, so each row also says where it is.
      const row: FirestoreRow = query.group ? { id, data: clone(data), path: documentPath } : { id, data: clone(data) };
      if (query.where.every(filter => matches(row, filter))) rows.push(row);
    }

    const valueOf = (row: FirestoreRow, field: string) => (field === DOCUMENT_ID ? row.id : getPath(row.data, field));
    // Firestore orders by the fields you ask for, then by the fields a query compares with an inequality (in field
    // order), and finally by document name, in the direction of the last of them. A document that lacks any of
    // those fields is left out, which is why an `or` with one range drops the documents that lack its field.
    const implicit = [...inequalityFields(query.where)]
      .filter(field => !query.orderBy.some(order => order.field === field))
      .sort()
      .map(field => ({ field, direction: 'asc' as const }));
    const order = [...query.orderBy, ...implicit];
    if (order.length > 0) rows = rows.filter(row => order.every(key => key.field === DOCUMENT_ID || valueOf(row, key.field) !== undefined));
    const nameSign = order.length > 0 && order[order.length - 1]?.direction === 'desc' ? -1 : 1;
    rows.sort((a, b) => {
      for (const key of order) {
        const result = compareValues(valueOf(a, key.field), valueOf(b, key.field));
        if (result !== 0) return key.direction === 'desc' ? -result : result;
      }
      return compareNames(a, b) * nameSign;
    });

    const position = (row: FirestoreRow, cursor: FirestoreCursor): number => {
      for (let index = 0; index < cursor.values.length; index++) {
        const order = query.orderBy[index] as (typeof query.orderBy)[number];
        const result = compareValues(valueOf(row, order.field), cursor.values[index]);
        if (result !== 0) return order.direction === 'desc' ? -result : result;
      }
      return 0;
    };
    if (query.start) {
      const start = query.start;
      rows = rows.filter(row => (start.inclusive ? position(row, start) >= 0 : position(row, start) > 0));
    }
    if (query.end) {
      const end = query.end;
      rows = rows.filter(row => (end.inclusive ? position(row, end) <= 0 : position(row, end) < 0));
    }
    return query.limit === undefined ? rows : rows.slice(0, query.limit);
  }

  private notify(): void {
    for (const listener of [...this.listeners]) if (this.listeners.has(listener)) listener.refresh();
  }

  private attach(listener: Listener): Unsubscribe {
    this.listeners.add(listener);
    if (!this.checkAccess(listener)) listener.refresh();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private isDenied(path: string): boolean {
    return this.denied.some(denied => path === denied || path.startsWith(`${denied}/`));
  }

  private checkAccess(listener: Listener): boolean {
    if (!this.isDenied(listener.path)) return false;
    this.listeners.delete(listener);
    listener.error(permissionDenied());
    return true;
  }
}
