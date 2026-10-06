# Describe the paths once

A type alone cannot build a path. The schema value can. A function is an id segment, an object is the next segment, `leaf<T>()` is where the path ends. The property name is the path segment, so the schema and the writer use the same name.

```typescript
import { leaf, schema, firestoreBackend } from 'wherelive';
import { firebaseFirestoreTransport } from 'wherelive/firebase';
import { getFirestore } from 'firebase/firestore';

const db = schema(
  {
    orders: (id: string) => leaf<Order>(),        // a function that returns a leaf is a keyed list
    customers: (id: string) => leaf<Customer>(),
  },
  firestoreBackend(firebaseFirestoreTransport(getFirestore())),
);
```

For Realtime Database use `realtimeBackend(firebaseRealtimeTransport(getDatabase()))` with the same schema shape. A path segment is `orders/<id>`, or `summaries/store/<storeId>/productIds` for nested segments. Firebase is initialized by your application and passed in. The library never initializes it. Without a backend, `from` works and `get` and `listen` throw a message that says so, which is what a unit test, a Cloud Function, or a component that only filters rows it already loaded wants.

```typescript
const db = schema({
  summaries: {
    store: (storeId: string) => ({
      productIds: leaf<string[]>(),
      byId: leaf<Holder<Product>>(),
    }),
  },
}, realtimeBackend(transport));

db.summaries.store(storeId).productIds.listen(ids => setIds(new Set(ids)), 'connectToStoreProductIds');
await db.summaries.store(storeId).productIds.get();
db.summaries.store(storeId).productId.listen(() => {}); // compile error
```

### The same path for the reader and the writer

`pathOf(handle)` returns the path a handle reads at, so whatever writes to the database can use the same definition instead of a second hand-written string.

```typescript
import { pathOf } from 'wherelive';

await set(ref(rtdb, pathOf(db.summaries.store(storeId).productIds)), ids); // 'summaries/store/<storeId>/productIds'
```

It works on a leaf, a segment, an id segment and a list, and it returns the exact path used, after id cleaning.

### Clean ids once

Pass options instead of a bare backend to run every id through a cleaner before it becomes a path segment. Property names are not touched, and the schema function still receives the id you passed.

```typescript
const db = schema(definition, {
  backend: realtimeBackend(transport),
  sanitizeId: id => id.replace(/[.#$[\]/]/g, '_'), // Realtime Database keys cannot contain . # $ [ ] /
});
```

The result must be non-empty and contain no `/`, or the call throws.

### Decode the value

A leaf can clean up its value before your callback sees it, on `listen` and on `get`. `except` drops keys at the root of an object value, on a copy. `decode` turns the value into anything else and can be chained. Both hand you the decoded type.

```typescript
const db = schema({
  stores: (storeId: string) => ({
    // drop the audit fields, then stamp each row with its key and revive its date
    items: leaf<Record<string, Item>>()
      .except('createdBy', 'updatedBy')
      .decode(items => items && Object.fromEntries(Object.entries(items).map(([key, item]) => [key, { ...item, $key: key, updatedAt: new Date(item.updatedAt) }]))),
  }),
});

db.stores(storeId).items.listen(items => render(items)); // items is the decoded value
```

`decode` receives `undefined` when the node does not exist. A decoded leaf is used whole, so it has no `select`, and a function that returns one cannot be used as a list. Decoding runs once per caller on the value the shared connection delivered, so callers with different decoders still share one connection. Do not mutate the raw value inside `decode`: it is shared. A decoder that throws reaches only that caller's `onError`.
