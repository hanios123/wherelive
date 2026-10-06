# Read Firestore and Realtime Database

Describe your paths once (see [Describe the paths once](schema.md)), then read a list with the same vocabulary. `get()` returns the rows, and a denied read is named after the identifier you pass.

```typescript
const rows = await db.orders
  .withKey('$key')                          // stamp each document id on the row, as `$key`
  .where('status', '==', 'open')
  .whereIn('region', regions)
  .orderBy('total', 'desc')
  .limit(20)
  .select({ id: '$key', total: 'total' })
  .get('loadOpenOrders');

const order = await db.orders('o1').get();               // one document, or undefined
const server = await db.orders('o1').get({ source: 'server' }); // skip Firestore's cache
const open = await db.orders.where('status', '==', 'open').count(); // counted on the server, no documents read
```

The database returns at least the rows the query needs. Then the whole query runs on them here, so the answer is the same as `from(rows)`. What it can do on the server it does, so you download less. On a list from your schema `get`, `count` and `aggregate` return promises, and group-by, joins and unions are done on the rows you get back: `ListQuery.from(await db.orders.where(…).get()).groupBy(…)`.

### What Firebase can query, and what wherelive does with it

Firestore, with the SDK feature on the left:

| Firestore | wherelive | On the server | Live |
| --- | --- | --- | --- |
| `where` with `==` `!=` `<` `<=` `>` `>=` | `where(field, op, value)` | yes | yes |
| nested fields (`'a.b'`) | a dotted path, anywhere a field goes | yes | yes |
| `array-contains` | `whereIncludes` | yes | yes |
| `array-contains-any` | `whereIncludesAny` | yes, over 30 values split into groups | up to 30 values |
| `in` / `not-in` | `whereIn` / `whereNotIn` | `in` of any size, split to fit; `not-in` up to 10 values, more runs here | yes, `in` up to 30 |
| `or(and(…), …)` and `and(…)` | `whereAny`, `orWhere`, several `where` | yes, within Firestore's 30 disjunctions. A bigger or is finished here | yes |
| `documentId()` | `withKey('$key')`, then `where('$key', …)`, `whereIn('$key', ids)`, `orderBy('$key')` | yes | yes |
| `orderBy` | `orderBy` | with a limit or a cursor, when the order is by fields; otherwise it sorts here | with a limit |
| `limit` | `limit` | yes, when nothing would change the answer (see below) | yes |
| `limitToLast` | `limitToLast` | yes, as the reversed order; here with an offset, a cursor or a local rule | yes, without a cursor |
| `startAt` `startAfter` `endAt` `endBefore` | the same names, with the values of your `orderBy` keys | yes, when the order is by fields | yes |
| `collectionGroup` | `collectionGroup<T>()` in the schema | yes | yes |
| `getCountFromServer` / `getAggregateFromServer` (count, sum, average) | `count()`, `aggregate(a => ({ … }))` | yes, when every filter is on the server and there is no select, limit, cursor or distinct | |
| `getDocFromServer` / `getDocsFromCache` and the rest | `get({ source: 'server' \| 'cache' })` | yes | |
| `onSnapshot` | `listen` | | yes |
| offset (the web SDK has none) | `offset(n)` | as a limit of offset + limit, and the first rows are skipped here | |
| min, max, `collect`, `count('field')` | inside `aggregate` | no, the rows are read and aggregated here | |

Not covered: field projection (the web SDK has none, so `select` always runs here), `startAfter(documentSnapshot)` (give the field values instead), fields whose names need `FieldPath`, and writes, batches and transactions.

Realtime Database:

| Realtime Database | wherelive | On the server | Live |
| --- | --- | --- | --- |
| `orderByChild` + `equalTo` | `where(child, '==', value)`, a nested child too | yes | yes |
| `orderByKey` + `equalTo` | `where('$key', '==', id)` after `withKey('$key')` | yes | yes |
| `startAt` `startAfter` `endAt` `endBefore` | `where(child, '>=' \| '>' \| '<=' \| '<', value)` | yes, and the rows that come back are trimmed here (see below) | no |
| `orderByChild` + `limitToFirst` | `orderBy(child).limit(n)`, and `offset` | yes, ascending | yes |
| `limitToLast` | `orderBy(child).limitToLast(n)`, or alone | yes, ascending | yes |
| a limit with no order | `limit(n)`, `limitToLast(n)` | yes, in key order | yes |
| `orderByKey` range, `orderByValue`, priority | | no. Keys and values order differently from JavaScript, so this runs here | |
| descending order with a limit | `orderBy(child, 'desc').limit(n)` | no. It could cut a group of equal values from the other end, so it runs here | no |

Realtime Database takes one order and one range at a time, so one child is filtered on the server and the other conditions run here. Every other feature of the first table (`in`, `or`, cursors, `distinct`, `select`) runs here on the rows it returns.

For what a query sends to the server and which indexes it needs, see [explain() and indexes](explain.md).

### Why the answer is the same either way

Two rules keep a database and an array in agreement.

- **A filter may return more than the query keeps, never less.** The whole query runs again on what comes back. Realtime Database orders numbers before strings, so a range on a number also returns strings, and the local check drops them.
- **A limit may return no more than the query would keep.** It cuts before any local check, so it is sent only when every filter runs on the server and the order is one the server reproduces exactly: no order, or one ascending field. Firestore also holds it back with `distinct`. A cursor is only a test on the order values, so it is sent even beside a local rule.

Firestore's 30-disjunction limit counts the values of every `in`, the alternatives of every `or`, multiplied together. An `in` beside an `or` is split into groups that leave room for it, and an `or` that still cannot fit is finished here.

`offset` costs reads, because Firestore has none: `offset(100).limit(10)` reads 110 documents. Prefer a cursor. `withKey` must come before `select`.

**Where Firestore differs from an array, on purpose.** These are Firestore's rules, and `test/read.test.ts` writes them down:

- `!=` and `whereNotIn` skip a document that lacks the field, and one whose field is `null`. On an array they keep both.
- An `orderBy` with a `limit` or a cursor leaves out a document that lacks the field. On an array it sorts first. An `orderBy` on its own is done here, so nothing is left out.
- A Realtime Database order by key is done here, because it sorts `'10'` after `'9'` and JavaScript does not. A read with no `orderBy` keeps the database's key order.
- **The key is always the last thing Firestore sorts by.** An order by `$key` followed by another field, or beside a range, `!=` or `whereNotIn` on another field, cannot be sent, so the filter is sent and the order and limit run here. A live list with a limit that would need it is refused before it connects.
- **Firestore will not scan the keys backwards on their own.** `orderBy('$key', 'desc')` with a limit or a cursor is refused by the emulator ("does not support descending key scans") unless an equality, `in`, `array-contains` or `or` of equalities on another field narrows it. Where the keys are given (`where('$key', '==', …)`, `whereIn('$key', …)`) the read is small and the order runs here. Otherwise the refusal reaches you with advice: order by the key ascending, add an equality filter, or read without a limit and let the order run here. Firestore's index documentation says that sorting by the key in the non-default direction needs an index created for that direction, so in production this query is one to set an index up for. It does not say whether the bare form works without one.
- **Realtime Database needs an index to order or filter a read by a child.** Add `".indexOn": ["child"]` for it in the rules; the emulator refuses an ordered `get()` without one ("Index not defined").

**Dates and Timestamps** compare by time, whichever kind each side is. A range on a Firestore `Timestamp` field with a `Date` value works, and `==`, `in` and `array-contains` find the same instant.

**Your own read path.** The transports are the seam. To keep migrations, caching or key stamping that already exist, implement `FirestoreTransport` (a type from `wherelive/transport`) on top of your own data-access service instead of using `wherelive/firebase`. It is four functions: `onDocument`, `onCollection`, `getDocument`, `getCollection`. Two more are optional. Without `getAggregate`, `count()` reads the rows and counts them here. Without `onCollectionChanges`, a live list is followed by comparing each whole snapshot with the last, which costs time in step with the size of the list. With it, your transport reports only the documents that were added, modified or removed (`wherelive/firebase` does, from the SDK's `docChanges()`), and a change costs the same in a list of ten or of ten thousand. `RealtimeTransport` is `onValue`, `onChildren`, `getValue`, `getChildren`.
