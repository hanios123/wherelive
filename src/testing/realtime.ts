import { getPath } from '../core/path';
import type { ChildHandlers, RealtimeBound, RealtimeQuery, RealtimeTransport } from '../realtime/backend';
import { compareKeys, compareValues } from '../realtime/order';
import { valuesEqual } from '../core/equality';
import type { ReadRow } from '../listen/types';
import type { Unsubscribe } from '../core/types';

interface Listener {
  readonly path: string;
  readonly error: (error: unknown) => void;
  refresh(): void;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const clone = <V>(value: V): V => (value === undefined ? value : (JSON.parse(JSON.stringify(value)) as V));
const segments = (path: string): string[] => path.split('/').filter(Boolean);

/** Remove `undefined`/`null` and empty objects and arrays, the way Realtime Database does. */
function prune(value: unknown): unknown {
  // An array is stored as children numbered 0, 1, 2…, so an empty one is no node at all, and a hole in one reads back as null.
  if (Array.isArray(value)) {
    const kept = value.map(prune);
    return kept.every(element => element === undefined) ? undefined : kept.map(element => element ?? null);
  }
  if (!isObject(value)) return value === null ? undefined : value;
  const kept: Record<string, unknown> = {};
  for (const [key, child] of Object.entries(value)) {
    const pruned = prune(child);
    if (pruned !== undefined) kept[key] = pruned;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

const permissionDenied = (path: string): Error =>
  Object.assign(new Error(`permission_denied at /${segments(path).join('/')}: Client doesn't have permission to access the desired data.`), {
    code: 'PERMISSION_DENIED',
  });

/**
 * An in-memory Realtime Database for tests. It behaves like the real one where
 * the library depends on it: a listener fires with the current value on attach
 * and again only when what it watches changes; `null` removes; a denied path
 * fails the listener or the read.
 */
export class MemoryRealtimeTransport implements RealtimeTransport {
  private root: unknown;
  private readonly listeners = new Set<Listener>();
  private readonly denied: string[] = [];

  /** Every one-time read made through the transport, in order, so a test can see what was asked of the database. */
  readonly readLog: Array<{ path: string; query?: RealtimeQuery }> = [];

  constructor(initial?: unknown) {
    this.root = prune(clone(initial));
  }

  /** Open listeners. A shared connection keeps this number flat. */
  get listenerCount(): number {
    return this.listeners.size;
  }

  /** The value at `path` right now, synchronously. For assertions. */
  get(path: string): unknown {
    let node = this.root;
    for (const segment of segments(path)) {
      // An array is children numbered 0, 1, 2…, so `list/1` is its second element.
      if (Array.isArray(node)) node = /^\d+$/.test(segment) ? node[Number(segment)] : undefined;
      else if (isObject(node)) node = node[segment];
      else return undefined;
    }
    return clone(node);
  }

  /** Write a value. `undefined` or `null` deletes. */
  set(path: string, value: unknown): void {
    const parts = segments(path);
    const next = clone(this.root);
    if (parts.length === 0) {
      this.root = prune(clone(value));
    } else {
      const root: Record<string, unknown> = isObject(next) ? next : {};
      let node = root;
      for (const segment of parts.slice(0, -1)) {
        const child = node[segment];
        node = node[segment] = isObject(child) ? child : {};
      }
      node[parts[parts.length - 1] as string] = clone(value);
      this.root = prune(root);
    }
    // The deepest listeners hear first, as in Realtime Database: delete a row and each attribute listener says
    // `undefined` before the list says the row is gone.
    const deepestFirst = [...this.listeners].sort((a, b) => segments(b.path).length - segments(a.path).length);
    for (const listener of deepestFirst) if (this.listeners.has(listener)) listener.refresh();
  }

  /** Deny reads at `path` and below. Open listeners on it fail now. New listeners and reads fail. */
  deny(path: string): void {
    this.denied.push(path);
    for (const listener of [...this.listeners]) this.checkAccess(listener);
  }

  onValue(path: string, next: (value: unknown) => void, error: (error: unknown) => void): Unsubscribe {
    let last: unknown;
    let sent = false;
    return this.attach({
      path,
      error,
      refresh: () => {
        const value = this.get(path);
        if (sent && valuesEqual(last, value)) return;
        sent = true;
        last = value;
        next(clone(value));
      },
    });
  }

  onChildren(path: string, query: RealtimeQuery | undefined, handlers: ChildHandlers, error: (error: unknown) => void): Unsubscribe {
    let known = new Map<string, unknown>();
    return this.attach({
      path,
      error,
      refresh: () => {
        const current = this.children(path, query);
        const before = known;
        known = current;
        for (const [key, value] of current) {
          if (!before.has(key)) handlers.added?.(key, clone(value));
          else if (!valuesEqual(before.get(key), value)) handlers.changed?.(key, clone(value));
        }
        for (const key of before.keys()) if (!current.has(key)) handlers.removed?.(key);
      },
    });
  }

  async getValue(path: string): Promise<unknown> {
    this.readLog.push({ path });
    if (this.isDenied(path)) throw permissionDenied(path);
    return this.get(path);
  }

  async getChildren(path: string, query: RealtimeQuery | undefined): Promise<ReadRow[]> {
    this.readLog.push(query ? { path, query } : { path });
    if (this.isDenied(path)) throw permissionDenied(path);
    return [...this.children(path, query)].map(([key, value]) => ({ key, value: clone(value) }));
  }

  /**
   * The children of `path` a Realtime Database query returns, in the order it returns them: by the
   * ordering value then key, or by key. A child that lacks the ordering child counts as null, which sorts
   * first and is included, and an equality or range compares by Realtime Database's own kind order.
   */
  private children(path: string, query: RealtimeQuery | undefined): Map<string, unknown> {
    const parent = this.get(path);
    const found = new Map<string, unknown>();
    if (!isObject(parent)) return found;
    const order = query?.order;
    const orderValue = (key: string, value: unknown): unknown => (order ? ('key' in order ? key : (getPath(value, order.child) ?? null)) : undefined);
    const compare = (a: unknown, b: unknown): number => (order && 'key' in order ? compareKeys(a as string, b as string) : compareValues(a, b));

    let rows = Object.entries(parent).map(([key, value]) => ({ key, value, by: orderValue(key, value) }));
    if (query?.equalTo !== undefined) rows = rows.filter(row => compare(row.by, query.equalTo) === 0);
    const within = (bound: RealtimeBound | undefined, side: 'start' | 'end') => (row: { by: unknown }) => {
      if (!bound) return true;
      const at = compare(row.by, bound.value);
      return side === 'start' ? (bound.inclusive ? at >= 0 : at > 0) : bound.inclusive ? at <= 0 : at < 0;
    };
    rows = rows.filter(within(query?.start, 'start')).filter(within(query?.end, 'end'));
    rows.sort((a, b) => (order ? compare(a.by, b.by) || compareKeys(a.key, b.key) : compareKeys(a.key, b.key)));
    if (query?.limit) rows = 'first' in query.limit ? rows.slice(0, query.limit.first) : rows.slice(Math.max(0, rows.length - query.limit.last));
    for (const row of rows) found.set(row.key, row.value);
    return found;
  }

  private attach(listener: Listener): Unsubscribe {
    this.listeners.add(listener);
    if (!this.checkAccess(listener)) listener.refresh();
    return () => {
      this.listeners.delete(listener);
    };
  }

  private isDenied(path: string): boolean {
    const wanted = segments(path).join('/');
    return this.denied.some(denied => {
      const prefix = segments(denied).join('/');
      return wanted === prefix || wanted.startsWith(`${prefix}/`);
    });
  }

  private checkAccess(listener: Listener): boolean {
    if (!this.isDenied(listener.path)) return false;
    this.listeners.delete(listener);
    listener.error(permissionDenied(listener.path));
    return true;
  }
}
