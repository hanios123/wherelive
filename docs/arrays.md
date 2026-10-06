# Query arrays

Everything here runs on rows you already hold, in the browser or in Node, with no Firebase.

## Query an array

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

## Loops become queries

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

## Group, aggregate and join

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
