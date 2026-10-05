import {
  endAt,
  endBefore,
  equalTo,
  get,
  limitToFirst,
  limitToLast,
  onChildAdded,
  onChildChanged,
  onChildRemoved,
  onValue,
  orderByChild,
  orderByKey,
  query,
  ref,
  startAfter,
  startAt,
  type Database,
  type QueryConstraint,
} from 'firebase/database';
import type { RealtimeQuery, RealtimeTransport } from '../realtime/backend';

/** A dotted path to a nested child is a slash path to Realtime Database. */
const childPath = (child: string): string => child.replace(/\./g, '/');

/**
 * Realtime Database transport on the modular Firebase SDK. The application
 * initializes Firebase and passes the `Database`; this file never does.
 *
 * ```ts
 * const db = schema({ ... }, realtimeBackend(firebaseRealtimeTransport(getDatabase())));
 * ```
 */
export function firebaseRealtimeTransport(database: Database): RealtimeTransport {
  const source = (path: string, spec: RealtimeQuery | undefined) => {
    const base = ref(database, path);
    if (!spec) return base;
    const constraints: QueryConstraint[] = [];
    if (spec.order) constraints.push('key' in spec.order ? orderByKey() : orderByChild(childPath(spec.order.child)));
    if (spec.equalTo !== undefined) constraints.push(equalTo(spec.equalTo));
    if (spec.start) constraints.push((spec.start.inclusive ? startAt : startAfter)(spec.start.value));
    if (spec.end) constraints.push((spec.end.inclusive ? endAt : endBefore)(spec.end.value));
    if (spec.limit) constraints.push('first' in spec.limit ? limitToFirst(spec.limit.first) : limitToLast(spec.limit.last));
    return constraints.length === 0 ? base : query(base, ...constraints);
  };
  return {
    onValue(path, next, error) {
      return onValue(ref(database, path), snapshot => next(snapshot.val() ?? undefined), error);
    },
    onChildren(path, spec, handlers, error) {
      const target = source(path, spec);
      const stops: Array<() => void> = [];
      const stopAll = () => {
        for (const stop of stops.splice(0)) stop();
      };
      try {
        const { added, changed, removed } = handlers;
        if (added) stops.push(onChildAdded(target, snapshot => added(snapshot.key as string, snapshot.val() ?? undefined), error));
        if (changed) stops.push(onChildChanged(target, snapshot => changed(snapshot.key as string, snapshot.val() ?? undefined), error));
        if (removed) stops.push(onChildRemoved(target, snapshot => removed(snapshot.key as string), error));
      } catch (thrown) {
        stopAll();
        throw thrown;
      }
      return stopAll;
    },
    async getValue(path) {
      const snapshot = await get(ref(database, path));
      return snapshot.val() ?? undefined;
    },
    async getChildren(path, spec) {
      const snapshot = await get(source(path, spec));
      const rows: Array<{ key: string; value: unknown }> = [];
      snapshot.forEach(child => {
        rows.push({ key: child.key as string, value: child.val() ?? undefined });
      }); // the callback returns nothing, so it never stops the walk early
      return rows;
    },
  };
}
