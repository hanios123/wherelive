import {
  and,
  average,
  collection,
  collectionGroup,
  count,
  doc,
  documentId,
  endAt,
  endBefore,
  getAggregateFromServer,
  getDoc,
  getDocFromCache,
  getDocFromServer,
  getDocs,
  getDocsFromCache,
  getDocsFromServer,
  limit,
  onSnapshot,
  or,
  orderBy,
  query,
  startAfter,
  startAt,
  sum,
  where,
  type Firestore,
  type QueryFilterConstraint,
  type QueryNonFilterConstraint,
} from 'firebase/firestore';
import { DOCUMENT_ID } from '../firestore/backend';
import type { FirestoreChange, FirestoreFilter, FirestoreQuery, FirestoreReadOptions, FirestoreTransport, FirestoreWhere } from '../firestore/backend';

/**
 * Firestore transport on the modular Firebase SDK. The application initializes
 * Firebase and passes the `Firestore`; this file never does.
 *
 * ```ts
 * const db = schema({ ... }, firestoreBackend(firebaseFirestoreTransport(getFirestore())));
 * ```
 *
 * To keep your own read path (migrations, cache, key stamping), implement
 * `FirestoreTransport` on top of it instead: it is four small functions.
 */
export function firebaseFirestoreTransport(firestore: Firestore): FirestoreTransport {
  const fieldOf = (field: string) => (field === DOCUMENT_ID ? documentId() : field);
  const one = (filter: FirestoreWhere): QueryFilterConstraint => where(fieldOf(filter.field), filter.op, filter.value);
  const filterOf = (filter: FirestoreFilter): QueryFilterConstraint =>
    'any' in filter ? or(...filter.any.map(group => (group.length === 1 ? one(group[0] as FirestoreWhere) : and(...group.map(one))))) : one(filter);

  const build = (path: string, spec: FirestoreQuery) => {
    const constraints: QueryNonFilterConstraint[] = [
      ...spec.orderBy.map(order => orderBy(fieldOf(order.field), order.direction)),
      ...(spec.start ? [(spec.start.inclusive ? startAt : startAfter)(...spec.start.values)] : []),
      ...(spec.end ? [(spec.end.inclusive ? endAt : endBefore)(...spec.end.values)] : []),
      ...(spec.limit === undefined ? [] : [limit(spec.limit)]),
    ];
    const source = spec.group ? collectionGroup(firestore, path) : collection(firestore, path);
    // Several filters are AND-ed by wrapping them in one composite, which is how the SDK mixes filters with `or`.
    return spec.where.length === 0 ? query(source, ...constraints) : query(source, and(...spec.where.map(filterOf)), ...constraints);
  };
  const rowsOf = (snapshot: { docs: Array<{ id: string; data(): Record<string, unknown> }> }) =>
    snapshot.docs.map(document => ({ id: document.id, data: document.data() }));
  const readDoc = (options?: FirestoreReadOptions) => (options?.source === 'server' ? getDocFromServer : options?.source === 'cache' ? getDocFromCache : getDoc);
  const readDocs = (options?: FirestoreReadOptions) => (options?.source === 'server' ? getDocsFromServer : options?.source === 'cache' ? getDocsFromCache : getDocs);

  return {
    onDocument(path, next, error) {
      return onSnapshot(doc(firestore, path), snapshot => next(snapshot.exists() ? snapshot.data() : undefined), error);
    },
    onCollection(path, spec, next, error) {
      // Decoding a document is most of what a snapshot costs, and nearly all of a snapshot is unchanged.
      // Keep what was decoded and decode only the documents the SDK reports as added or modified.
      // Across a collection group an id repeats under different parents, so the path is the key there.
      const decoded = new Map<string, Record<string, unknown>>();
      const keyOf = (document: { id: string; ref: { path: string } }) => (spec.group ? document.ref.path : document.id);
      return onSnapshot(
        build(path, spec),
        snapshot => {
          for (const change of snapshot.docChanges()) {
            if (change.type === 'removed') decoded.delete(keyOf(change.doc));
            else decoded.set(keyOf(change.doc), change.doc.data());
          }
          next(
            snapshot.docs.map(document => {
              const key = keyOf(document);
              let data = decoded.get(key);
              if (data === undefined) decoded.set(key, (data = document.data()));
              return spec.group ? { id: document.id, data, path: document.ref.path } : { id: document.id, data };
            }),
          );
        },
        error,
      );
    },
    // The SDK already knows what changed. Reading only that keeps a snapshot's cost in step with the change and
    // not with the size of the result: `snapshot.docs` alone builds an object for every document in it.
    onCollectionChanges(path, spec, next, error) {
      return onSnapshot(
        build(path, spec),
        snapshot =>
          next(
            snapshot.docChanges().map((change): FirestoreChange => {
              const at = spec.group ? { path: change.doc.ref.path } : {};
              return change.type === 'removed' ? { type: 'removed', id: change.doc.id, ...at } : { type: change.type, id: change.doc.id, ...at, data: change.doc.data() };
            }),
          ),
        error,
      );
    },
    async getDocument(path, options) {
      const snapshot = await readDoc(options)(doc(firestore, path));
      return snapshot.exists() ? snapshot.data() : undefined;
    },
    async getCollection(path, spec, options) {
      return rowsOf(await readDocs(options)(build(path, spec)));
    },
    async getAggregate(path, spec, aggregates) {
      const wanted = Object.fromEntries(
        Object.entries(aggregates).map(([name, aggregate]) => [
          name,
          aggregate.op === 'count' ? count() : aggregate.op === 'sum' ? sum(aggregate.field) : average(aggregate.field),
        ]),
      );
      const snapshot = await getAggregateFromServer(build(path, spec), wanted);
      return snapshot.data() as Record<string, number | null>;
    },
  };
}
