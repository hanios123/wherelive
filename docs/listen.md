# Listen live

`listen(next, identifier?, onError?)` returns `stop()`. `subscribe(next, error?)` is the same thing with the framework-neutral `Subscription<T>` shape.

| You listen to | The callback receives |
| --- | --- |
| A leaf, or `select('*')` on it | The value (`undefined` when the node does not exist) |
| `select('name', 'age', 'contact.*')` on a node | `{ attribute, value }`, where `attribute` is `name`, `age`, or `contact.email` |
| A keyed list, with or without `where` and `select` | `{ key, attribute, value }`, and `{ key, attribute: '*', removed: true }` once when a row leaves the result |

In a `collectionGroup` the `key` is the document's full path (`orders/o1/lines/a`), not its id, because one id repeats under different parents and the two rows must stay two rows. `withKey` and `get()` still give the id.

How `select` decides what to listen to:

| Store | What `select` does |
| --- | --- |
| Realtime Database | One listener per attribute. `select('name')` listens to that child. `select('contact.*')` listens to each child under `contact`. A filtered list uses one equality, or a limit, to track which children exist, then listens to the selected attributes under each child |
| Firestore | The server still sends a snapshot when another field changes. The selected attributes are compared with the previous snapshot, and the event is dropped when they are unchanged |

A live list reports changes per row, so some of the SQL does not apply, and it is refused with an `UnsupportedQueryError` before anything connects:

- `select` takes attribute names only. A computed or aliased `select` works with `get` and `from`, and `listen` is a compile error after one.
- A live list can follow an order with a `limit` or `limitToLast` ("the latest 20"), or a cursor, sent to the server, as long as every filter runs there. Rows enter and leave the cut as the data changes. Realtime Database follows a limit only when one ascending child order (or key order) and at most one equality decide the answer, and takes no cursor. An `orderBy` without a limit or a cursor is ignored, since order means nothing to per-row changes.
- `offset` and `distinct` have no live meaning. A Firestore `in` or `array-contains-any` of more than 30 values cannot be listened to. An empty `whereIn` has nothing to hear, so nothing connects. Realtime Database follows only an equality, so a range, `whereIn` or `or` is refused there.

### One connection, and it stops

Callers with the same store, path, `where` clauses, `select`, order and limit (in any order) share one connection. The last `stop()` detaches it. Each caller has its own `stop`, its own identifier and its own error handler.

A caller that joins an open connection is replayed the current state on a microtask, so `stop` exists before its callback first runs. Whatever arrived before that replay is folded into it, so it never sees an older value after a newer one. A `where(row => boolean)` check can only be shared by the very same function instance, since a function has no content to compare.

### Errors

A denied listen or read stays named after the caller, even on a shared connection:

```
PERMISSION_DENIED: Permission denied (listen --- connectToStoreProductIds): <server message> --- summaries/store/store1/productIds
PERMISSION_DENIED: Permission denied (get --- loadOpenOrders): <server message> --- orders
```

It is a `ListenError` with `code`, `identifier`, `path` and `cause`. Other errors reach `onError`, or reject `get`, untouched. Without `onError` a listen error goes to `console.error`. A callback that throws is sent to its own caller's `onError` and does not affect the other callers or the connection. After an error the connection is dropped, so the next `listen` starts clean.

## In a component

`listen` returns `stop`, so it maps onto any framework's mount and teardown without an adapter. Start when the component appears, stop when it goes away. Two components on the same query still share one connection.

For RxJS and Angular, `wherelive/rxjs` turns any `listen` into an Observable:

```typescript
import { observe } from 'wherelive/rxjs';

const productIds$ = observe(db.summaries.store(storeId).productIds, 'connectToStoreProductIds');
const productIds = toSignal(productIds$); // Angular
```

Nothing connects until someone subscribes. Unsubscribing, `take`, `takeUntilDestroyed` or an error stops the listen, and subscribers share one connection, so `shareReplay` is not needed for that. A denied listen arrives as an ordinary Observable error that names the caller. `rxjs` is an optional peer dependency (7 or later), and the main entry never imports it.

```typescript
// React. Vue's onMounted/onUnmounted, Angular's ngOnInit/ngOnDestroy and Svelte's onMount return value work the same way.
useEffect(
  () => db.summaries.store(storeId).productIds.listen(ids => setIds(new Set(ids)), 'connectToStoreProductIds'),
  [storeId],
);
```

## In Node and Cloud Functions

`ListQuery` and everything under `from` run in Node as they are, so a `shared/` folder used by both the app and Cloud Functions can use the same queries. `test/` runs the whole suite in Node, and `test/boundary.test.ts` keeps browser and Node globals out of the engine.

`get` and `listen` need a backend. The `wherelive/firebase` transports use the Firebase **web** SDK. For the Admin SDK, write a transport (four functions each, see [Read Firestore and Realtime Database](firebase.md#why-the-answer-is-the-same-either-way)). There is no Admin SDK transport in this package yet.
