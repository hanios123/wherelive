# What a query does, and which indexes it needs

`explain()` says what a list query would do against the database without asking it anything: what goes to the server, what is finished here, whether the same query can be live, and which indexes Firebase needs.

```typescript
const query = db.orders.where('status', '==', 'open').where('total', '>=', 50).orderBy('createdAt', 'desc').limit(20);
const plan = query.explain();

plan.server;  // ['the collection "orders"', 'status == "open"', 'total >= 50', 'order by createdAt descending', 'limit 20']
plan.local;   // []
plan.live;    // { ok: true }
plan.indexes; // [{ kind: 'composite', need: 'required', index: { collectionGroup: 'orders', queryScope: 'COLLECTION', fields: [...] }, because: '...' }]
```

The advice is worked out from the query that is **actually sent**, so an order with no limit or cursor (which is sorted here) needs no index, and a check that stops a limit from being sent takes the order with it. Firestore's rules, as its documentation gives them:

- The automatic single-field indexes serve equality on any number of fields, `in`, a range on one field, and an order on one field. These need nothing.
- A compound query with a range, or one sorted by a different field, needs a **composite index**. Its fields go equality first, then sort, then range. An `array-contains` beside other conditions is advised one (`need: 'recommended'`).
- The key is always last in an index. Sorting by it in the other direction than the field before it needs that index created.
- A collection group query that filters or orders needs an index with **collection group scope**.
- Range or inequality filters beside only an equality on the key are not supported, and at most 10 range fields are allowed.

Each piece of advice carries a `because` that names the rule. Two things are not claimed: an `or` (the documentation read does not say how its alternatives are indexed) and a bare descending order by the key (it says the other direction needs an index, not whether the bare form works without one). Those come back as `kind: 'unknown'`. The advice comes from the documentation and has not been checked against a live project, and the emulator cannot check it (it does not track indexes), so when Firestore reports a missing index, its error message and link are the last word.

`firestoreIndexes(plans)` gathers the required composite indexes of several queries into the `firestore.indexes.json` shape (`{ indexes: [...] }`, each once), for the Firebase CLI to deploy. The file it writes passes the CLI's own validator. Pass `{ recommended: true }` to include the advised ones. Collection group scope for a single field is not written there, because in that file it replaces the field's other indexes; it is reported as `kind: 'collection-group'` to make in the console.

For Realtime Database the advice is an `.indexOn` for the child a query orders or filters on, at the path of the list in the security rules (a nested child is written with slashes). Its documentation says indexes are not needed in development unless you use the REST API, and that performance degrades as the data grows, so this is `recommended`. The emulator refuses an ordered one-time read without it.
