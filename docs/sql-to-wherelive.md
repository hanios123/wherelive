# SQL to wherelive

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
