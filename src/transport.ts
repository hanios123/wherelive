/**
 * For writing your own transport or backend: the shapes a database adapter speaks, and the request a
 * backend is asked to run. You do not need any of this to use the library. `wherelive/firebase` is
 * a finished transport on the Firebase SDK, and `wherelive/testing` is one in memory.
 *
 * ```ts
 * import type { FirestoreTransport } from 'wherelive/transport';
 * ```
 */
export { DOCUMENT_ID } from './firestore/backend';
export type {
  FirestoreAny,
  FirestoreChange,
  FirestoreCursor,
  FirestoreData,
  FirestoreFilter,
  FirestoreQuery,
  FirestoreReadOptions,
  FirestoreRow,
  FirestoreTransport,
  FirestoreWhere,
} from './firestore/backend';
export type { ChildHandlers, RealtimeBound, RealtimeQuery, RealtimeScalar, RealtimeTransport } from './realtime/backend';
export type { Backend, ChangeEvent, ListenRequest, NativeAggregate, NativeOrder, ReadRequest, ReadRow, ReadSource, Subscriber } from './listen/types';
export type { Clause, OrderKey, QueryPlan, Selection } from './core/plan';
