# Testing your own code

```typescript
import { MemoryFirestoreTransport } from 'wherelive/testing';

const transport = new MemoryFirestoreTransport();
transport.set('orders/o1', { status: 'open', total: 30 });
const db = schema(definition, firestoreBackend(transport));

await db.orders.where('status', '==', 'open').get();
db.orders.select('status').listen(console.log);
transport.set('orders/o1', { status: 'paid', total: 30 });
transport.deny('orders');   // the next read or listener, and any open one, fails with a permission error
transport.queryLog;         // every query that reached the database, to prove what was pushed down
transport.listenerCount;    // open listeners, to prove sharing and teardown
```

`MemoryRealtimeTransport` does the same for Realtime Database, with a `readLog` of every query it was asked, and it orders and bounds children the way Realtime Database does. The Firestore one follows Firestore's own rules, so a test finds out what the real one would say: `in` takes at most 30 values and `not-in` 10, a query has at most 30 disjunctions, an empty `in` is an error, a cursor needs an order, a document that lacks a field you order by is left out, and it sends a snapshot when only an unselected field changed. It also keeps `queryLog`, `documentLog` and `aggregateLog`, so a test can prove what was pushed to the server.
