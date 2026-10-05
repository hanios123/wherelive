# wherelive

SQL for your arrays and your Firestore and Realtime Database reads. Write a loop, or a read from the database, as `select … where … join … group by … order by … limit`.

```sql
SELECT city, COUNT(*) AS n, SUM(price) AS total
FROM orders JOIN customers ON orders.customerId = customers.id
WHERE customers.tier = 'gold' AND orders.status IN ('open', 'paid')
GROUP BY city ORDER BY total DESC LIMIT 5
```

```typescript
ListQuery.from(await db.orders.whereIn('status', ['open', 'paid']).get())            // Firestore runs the IN
  .innerJoin(await db.customers.withKey('id').where('tier', '==', 'gold').get(), 'customerId', 'id')
  .select({ city: row => row.right.contact.city, price: row => row.left.price })
  .groupBy('city')
  .aggregate(a => ({ n: a.count(), total: a.sum('price') }))
  .orderBy('total', 'desc')
  .limit(5)
  .toList();
```

The same description runs on an array you hold (`from`), reads a Firestore or Realtime Database list once (`get`), and follows it live (`listen`). The database does what it can, the rest finishes locally, and the answer is the same either way.

Built for frontend apps on the Firebase web SDK, and it runs unchanged in Node, so the same query code can be shared with Cloud Functions. The core has no Angular, React, Vue, Svelte, RxJS, browser global, Node API, or Firebase SDK import. It works under any framework or none, and stays safe to import while a page is server-rendered. Firebase sits behind an injectable transport, so everything is testable without a Firebase project.

## SQL to wherelive

| SQL | wherelive |
| --- | --- |
| `FROM t` | `ListQuery.from(rows)`, or a list in your schema: `db.orders` |
| `SELECT a, b` | `.select('a', 'b')` |
| `SELECT a AS x, f(b) AS y` | `.select({ x: 'a', y: row => f(row.b) })` |
| `SELECT DISTINCT` | `.distinct()` |
| `WHERE a = 1 AND b > 2` | `.where('a', '==', 1).where('b', '>', 2)` |
| `WHERE a.b.c = 1` | `.where('a.b.c', '==', 1)`: a dotted path reads nested fields |
| `WHERE a IN (…)` / `NOT IN (…)` | `.whereIn('a', […])` / `.whereNotIn('a', […])` |
| `WHERE tags CONTAINS 'x'` | `.whereIncludes('tags', 'x')` |
| `WHERE tags OVERLAP ('x', 'y')` | `.whereIncludesAny('tags', ['x', 'y'])` |
| `WHERE (a = 1 AND b > 2) OR c = 3` | `.whereAny(q => q.where('a', '==', 1).where('b', '>', 2), q => q.where('c', '==', 3))`, or `.where('a', '==', 1).orWhere('c', '==', 3)` |
| `AND (:x IS NULL OR a = :x)` | `.when(x, query => query.where('a', '==', x))` |
| `WHERE` with your own rule | `.where(row => rule(row))`. Runs locally |
| `ORDER BY a, b DESC` | `.orderBy('a').orderBy('b', 'desc')` |
| `LIMIT n OFFSET m` | `.offset(m).limit(n)` |
| the last n rows | `.orderBy('x').limitToLast(n)` |
| keyset paging (`WHERE (a, b) > (?, ?)`) | `.orderBy('a').orderBy('b').startAfter(a, b).limit(n)`, also `startAt`, `endAt`, `endBefore` |
| `GROUP BY k` with `COUNT SUM AVG MIN MAX` | `.groupBy('k').aggregate(a => ({ n: a.count(), total: a.sum('x') }))` |
| `array_agg` / bucket rows by a key | `a.collect()` or `a.collect('field')` inside `aggregate` |
| `HAVING` | `.where(…)` after `aggregate` |
| `JOIN` / `LEFT JOIN` | `.innerJoin(other, 'a', 'b')` / `.leftJoin(other, 'a', 'b')` |
| `RIGHT JOIN` / `FULL OUTER JOIN` | `.rightJoin(other, 'a', 'b')` / `.outerJoin(other, 'a', 'b')` |
| `UNION` / `UNION ALL` | `.union(other)` / `.unionAll(other)`. `.union(other, 'id')` when a key identifies a row |
| `a = 1 OR b = 2` on a database | read each side with `get()`, then `.union(other, '$key')` |
| `FROM (SELECT …)` subquery | chain it: `select`, `limit`, `join` … then `groupBy`. Each stage feeds the next |
| `x IN (SELECT y FROM …)` | `.whereIn('x', other.select('y').toList())` |
| `COUNT(*)`, `EXISTS`, `NOT EXISTS` | `.count()`, `.some()`, `.none()` |
| `SELECT COUNT(*)` without reading the rows | `await db.orders.where(…).count()`. Firestore counts on the server |
| a `for` inside a `for` | `.flatMap(row => list)`, or `ListQuery.combine({ a, b })` |

Whatever order you call things in, they run in SQL's order: filter, order, select, distinct, offset, limit. `groupBy`, `aggregate`, the joins, `union` and `flatMap` each start a new query over the rows so far.

Everything is typed on the chain. `where('customer.nam', …)`, `select('nam')` and `sum('name')` do not compile, and `select({ id: 'id', city: 'customer.address.city' })` returns `{ id: number; city: string }`. `test/types.test.ts` proves this with `@ts-expect-error`.

```
wherelive              what you use: ListQuery, schema, leaf, the two backends, the errors, and 28 names in all
wherelive/firebase     transports on the real Firebase SDK        needs `firebase`
wherelive/rxjs         observe(): a listen as an Observable       needs `rxjs`
wherelive/testing      in-memory transports for tests
wherelive/transport    only to write your own transport or backend: the shapes they speak, 28 names
```

Inside, `src/core` holds the query engine and `src/schema` the paths. A query over an array and a query over a database list share one base class, `QueryBuilder`, so `where`, `orderBy`, `limit`, the cursors and every other builder method are written once and mean the same on both. `test/structure.test.ts` pins that, and `test/package.test.ts` builds the package as published and pins the exact public names.

`test/boundary.test.ts` fails if anything outside `firebase/`, `rxjs/` and `testing/` imports a framework or the SDK, or touches `window`, `document`, `localStorage`, `process`, and so on.

## 1. Query an array

```typescript
import { ListQuery } from 'wherelive';

ListQuery.from(orders)
  .where('status', '==', 'open')
  .where('customer.address.city', '==', 'Lyon')
  .orderBy('placedAt', 'desc')
  .limit(10)
  .select('id', 'total')
  .toList();
```

Nothing runs until a terminal call. Filtering is one pass, however many `where` calls: each item is tested clause by clause, stopping at the first miss. Without `orderBy` the whole run is lazy, so `first()`, `some()` and `limit` stop reading as soon as they can. `orderBy` has to see every match before it sorts, and it is stable.

| Method | Result |
| --- | --- |
| `ListQuery.from(items)` / `fromHolder(holder)` | Start from an array, or from `Object.values(holder)` |
| `ListQuery.fromType<T>()` | Start with no data. Describe once, then `.from(items)` on any array |
| `where(field, op, value)` | `op` is `==` `!=` `>` `>=` `<` `<=`. `field` is a key of `T` or a dotted path, four levels deep at most. `value` has the field's type |
| `where(row => boolean)` | Your own rule. Runs locally only |
| `whereIn(field, values)` / `whereNotIn(field, values)` | `IN` and `NOT IN`. An empty `IN` matches nothing |
| `whereIncludes(field, value)` | The field is an array and contains `value` |
| `when(value, addClause)` | Add the clause only when `value` is present: not `undefined`, `null` or `''`. `0` and `false` are values |
| `select('name', 'age', 'contact.*')` | One name returns that value. Several return an object. `contact.*` copies every field of `contact` and drops `contact`. `*` is the whole row. A missing attribute throws |
| `select({ alias: 'path' \| row => value })` | `SELECT … AS`. A path that leads nowhere is `undefined`, like a SQL NULL |
| `select(row => value)` | A computed value |
| `distinct()` | Drops rows equal to an earlier one, after `select`. Objects are compared by content |
| `orderBy(field, 'asc' \| 'desc', { locale })` | Call again for the next key. Sorts before `select`, so you can order by a field you do not select. Missing and `null` first, then booleans, numbers, dates, strings. Text compares by code unit, as a database does. `{ locale: true }` sorts by language (`localeCompare`). `orderBy(row => value)` orders by anything |
| `limit(n)` / `offset(n)` | Whole numbers. `offset` runs before `limit` whatever order you call them in |
| `toList()` `first()` `some()` `none()` `count()` | `first`, `some` and `none` stop at the first match |
| `toSet()` | A `Set` of the matches. Duplicates collapse to their first occurrence |
| `toHolder(key)` | `{ [item[key]]: item }`. The last item wins on a shared key |
| `for (const row of query)` / `[...query]` | Iterate the matches. Each pass runs the query again |
| `.from(items)` | Run the description on `items` and return the rows |

## 2. Loops become queries

Two shapes of nested loop, and one call for each.

**The inner list hangs off the outer item.** `flatMap` runs an inner query for each row the outer query keeps.

```typescript
// was: for each open order, for each of its lines, add a label
const labels = new Set<string>();
for (const order of orders) {
  if (order.status !== 'open') continue;
  const lines = linesByRegion[order.region]?.[order.id];
  if (!lines) continue;
  for (const line of lines) {
    if (line.orderId !== order.id) continue;
    labels.add(`${line.sku}_${order.region}`);
  }
}

// can be:
const labels = ListQuery.from(orders)
  .where('status', '==', 'open')
  .flatMap(order =>
    ListQuery.from(linesByRegion[order.region]?.[order.id] ?? [])
      .where('orderId', '==', order.id)
      .select(line => `${line.sku}_${order.region}`),
  )
  .toSet();
```

The library removes the two loops, the `continue`s and the hand-built `Set`. The label rule stays in your `select`. The result is a query over the inner rows, so you can keep filtering it. Nest `flatMap` for a third loop. The callback can return a plain array as well as a query. It is synchronous, so a loop with `await` inside stays a loop.

**Two independent lists.** `combine` names each list, so the callback reads `combination.region` and not `([region, channel])`. `pairs` is the two-list version that returns a tuple.

```typescript
ListQuery.combine({ region: regions, channel: channels }).toList(); // [{ region, channel }, …]
ListQuery.pairs(regions, channels).toList(); // [[region, channel], …]

// "is there a combination that no rule covers?", the double loop with an early return:
ListQuery.combine({ region: regions, channel: channels })
  .where(combination => ListQuery.from(rules).where(rule => covers(rule, combination)).none())
  .some();
```

A loop of five lists is the same call with five keys. An empty list makes no combinations, as an empty `for` would. Everything runs lazily across both levels: `first()` and `some()` stop at the first match, and `combine` never builds the full product up front. Each inner list is walked once per parent.

## 3. Group, aggregate and join

```typescript
// was: buckets and running totals by hand
const totals = new Map<string, { n: number; total: number }>();
for (const order of orders) {
  const entry = totals.get(order.region) ?? { n: 0, total: 0 };
  entry.n++;
  entry.total += order.price;
  totals.set(order.region, entry);
}

// can be:
ListQuery.from(orders)
  .groupBy('region')
  .aggregate(a => ({ n: a.count(), total: a.sum('price'), orders: a.collect() }))
  .toList(); // [{ region, n, total, orders }, …] in the order each region first appeared
```

`aggregate(a => …)` hands you `count`, `sum`, `avg`, `min`, `max` and `collect`. Fields are checked against the row, so `sum('region')` does not compile. Missing and `null` values are ignored, as SQL ignores NULL. `sum` of nothing is `0`, and `avg`, `min` and `max` of nothing are `undefined`. Without `groupBy`, `aggregate` is one row over the whole list, even an empty one, like `SELECT COUNT(*)`. Group keys can be a plain field of the rows so far.

Because each stage starts a new query, the SQL you already know maps straight on: a `where` after `aggregate` is `HAVING`, and `orderBy` and `limit` after it order and cut the groups.

```typescript
ListQuery.from(orders).groupBy('customerId').aggregate(a => ({ total: a.sum('price') })).where('total', '>', 100).orderBy('total', 'desc').limit(3);
```

**Joins.** `other` can be an array or another query, and both keys can be a dotted path. Every join makes one `{ left, right }` row per matching pair, and several matches make several rows. A missing or `null` key matches nothing, and keys are compared strictly (`1` is not `'1'`). The other list is indexed once per run, so it is not a loop inside a loop.

| Call | Rows kept | Absent side |
| --- | --- | --- |
| `innerJoin(other, leftKey, rightKey)` | only pairs whose keys match | none |
| `leftJoin(...)` | every left row | `right` when nothing matches |
| `rightJoin(...)` | every row of `other`, even one with no key | `left` when nothing matches |
| `outerJoin(...)` | every row from both sides | whichever side has no match |

All four return rows in the same order: each left row in turn with its matches in the order of `other`, and then, for `rightJoin` and `outerJoin`, the rows of `other` that nothing matched, in their own order. `test/sets.test.ts` checks every join against the nested loops that define it.

```typescript
ListQuery.from(orders)
  .innerJoin(customers, 'customerId', 'id')
  .where(row => row.right.tier === 'gold')
  .orderBy(row => row.left.price, 'desc')
  .select({ order: row => row.left.id, who: row => row.right.name })
  .limit(10);

// LEFT JOIN … COUNT(o.id): orders per customer, including customers with none
ListQuery.from(orders)
  .rightJoin(customers, 'customerId', 'id')
  .select({ customer: row => row.right.name, order: row => row.left?.id })
  .groupBy('customer')
  .aggregate(a => ({ orders: a.count('order') }));   // count('field') skips the absent ones, so Zed gets 0

// data problems in both directions at once
ListQuery.from(orders).outerJoin(customers, 'customerId', 'id').where(row => !row.left || !row.right);
```

**Union.** `union(other)` is this query's rows followed by `other`'s with duplicates dropped, keeping the first. It finds duplicates across both lists and within each, as SQL's `UNION` does. Rows are equal when their content is equal, objects whatever the order of their keys. Pass a key to say what identifies a row instead: `union(other, 'id')`. Rows with the same key value are duplicates, and a missing value counts as one value, as NULL does in SQL. `unionAll(other)` keeps every row.

```typescript
ListQuery.from(recentIds).union(archivedIds).toList();                     // like [...new Set([...a, ...b])]
ListQuery.from(customers).union(otherCustomers, 'id').orderBy('name').offset(20).limit(10).toList();
```

The result is one query over the combined rows, so `orderBy`, `offset` and `limit` after it work on the whole list and not on each side. It is lazy: `first()` does not read the other side. Union is also how you write an `OR` across fields on a database that has none here: read each side and union them by key.

```typescript
const gold = await db.orders.withKey('$key').where('tier', '==', 'gold').get();
const big = await db.orders.withKey('$key').where('total', '>=', 500).get();
ListQuery.from(gold).union(big, '$key').orderBy('$key').toList();          // tier = 'gold' OR total >= 500
```

## 4. Read Firestore and Realtime Database once

Describe your paths once (see [section 5](#5-describe-the-paths-once)), then read a list with the same vocabulary. `get()` returns the rows, and a denied read is named after the identifier you pass.

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

### What a query does, and which indexes it needs

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

## 5. Describe the paths once

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

## 6. Listen live

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

`get` and `listen` need a backend. The `wherelive/firebase` transports use the Firebase **web** SDK. For the Admin SDK, write a transport (four functions each, see section 4). There is no Admin SDK transport in this package yet.

## Testing your own code

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

## Not built yet

These wait until a caller needs them: `whereEqualUnless`, `whereEqualOrEmpty`, `intersect` and `except`, `some(callback)` (use `.where(fn).some()`), a Firestore query built from a `DocumentSnapshot`, a `QueryState` snapshot, and the React/Vue/Angular/Svelte adapters.

## Develop

```bash
pnpm install
pnpm run check   # typecheck, lint, tests, build
```

`pnpm install` also installs the git hooks (husky). Before each commit, `lint-staged` runs `eslint --fix` on the staged files. That deletes unused imports, and any other lint error blocks the commit. `pnpm run lint` checks the whole project, and `pnpm run lint:fix` applies the safe fixes.

The SDK transports are tested against mocked SDK calls and typechecked against the real Firebase types. They are also run against the real Firebase SDK on the Firestore and Realtime Database emulators:

```bash
pnpm test:emulator   # needs Java 11 or newer and the Firebase CLI (npm install -g firebase-tools)
```

That starts both emulators for a `demo-` project (nothing can reach a real one, and no login is needed), runs `test-emulator/`, and stops them. It is not part of `pnpm run check`, so a machine without Java still passes it. The tests check four things:

- **Reads.** Each query in a long list runs on the emulator and on the memory transport, and the two must give the same rows in the same order, or both must refuse.
- **Live lists.** Rows, changes, removals, limit windows, collection groups, shared connections and permission errors, through the real SDK, following the SDK's change feed and following whole snapshots.
- **Live events.** The same writes run on the emulator and on the memory transport, and the events each sends must match.
- **Permissions.** A denied read is named after its caller.

These gaps in the memory transports were found this way and closed: a comparison, `!=` or `not-in` orders a read by the field it compares; ties break by document name in the direction of the last `orderBy`, and names sort by byte, not by language; `!=` and `not-in` skip a field that is `null`; a count asked beside a sum covers only the documents that have the summed field; Realtime Database keeps no empty array and can be read into by position; and deleting a row says `undefined` for each selected attribute before it says the row is gone.

**What the emulator does not check.** Firebase's emulator documentation says it does not track composite indexes and runs any valid query, and advises testing on a real instance to learn which indexes you need. So a query that passes here can still need an index in production, and the emulator is not proof that it will run there. The memory transports cannot know about indexes either.

One thing the emulator taught about the library itself: Firestore aggregates only the documents that have every field a query aggregates, so `aggregate` now asks for a count and for each field's sums apart, and the answer is the one the rows give.

### Speed

```bash
pnpm bench        # queries, projection and grouping, live lists, against the built package
pnpm bench:sdk    # a live list on the real Firebase SDK, offline
```

Each case is timed next to the same work written by hand (`array.filter`, a sort, a `Map`), after checking that both give the same answer. [bench/README.md](bench/README.md) explains how to read the output. Rough costs on a laptop, per row: a `where` about 0.1 µs, a full `orderBy` 1 to 2 µs, `select` about 0.3 µs, `groupBy` and joins 0.5 to 1 µs. An `orderBy` with a `limit` picks the rows it needs and does not sort the rest. Cost grows in line with the number of rows (a full sort grows slightly faster than the rows do), with no cliff up to 100,000 rows.
