# wherelive

[![npm version](https://img.shields.io/npm/v/wherelive.svg)](https://www.npmjs.com/package/wherelive)
[![CI](https://github.com/hanios123/wherelive/actions/workflows/ci.yml/badge.svg)](https://github.com/hanios123/wherelive/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/wherelive.svg)](LICENSE)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)

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

## Install

```bash
pnpm add wherelive      # or: npm install wherelive
```

Current release: **0.1.0** on [npm](https://www.npmjs.com/package/wherelive). `firebase` (10 or later) and `rxjs` (7 or later) are optional peer dependencies. Install `firebase` to use `get` and `listen` through `wherelive/firebase`, and `rxjs` only for `wherelive/rxjs`. Plain `ListQuery` over arrays needs neither.

## Three examples

**1. Query an array.** No Firebase needed.

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

Everything is typed on the chain. `where('customer.nam', …)`, `select('nam')` and `sum('name')` do not compile.

**2. Read Firestore or Realtime Database.** Describe your paths once, then use the same vocabulary. What the database can do it does, and the rest finishes locally.

```typescript
import { leaf, schema, firestoreBackend } from 'wherelive';
import { firebaseFirestoreTransport } from 'wherelive/firebase';
import { getFirestore } from 'firebase/firestore';

const db = schema(
  { orders: (id: string) => leaf<Order>() },
  firestoreBackend(firebaseFirestoreTransport(getFirestore())),
);

const rows = await db.orders
  .withKey('$key')
  .where('status', '==', 'open')
  .orderBy('total', 'desc')
  .limit(20)
  .select({ id: '$key', total: 'total' })
  .get('loadOpenOrders');
```

**3. Listen live, to only what you selected.** `listen` returns `stop`, so it fits any framework's mount and teardown. Callers with the same query share one connection.

```typescript
const stop = db.orders
  .where('status', '==', 'open')
  .select('status', 'total')
  .listen(change => render(change), 'watchOpenOrders'); // { key, attribute, value }

// later: stop();
```

## Documentation

| Guide | What is in it |
| --- | --- |
| [SQL to wherelive](docs/sql-to-wherelive.md) | Every SQL clause next to its wherelive call |
| [Query arrays](docs/arrays.md) | `ListQuery`, loops as queries, group, aggregate, join, union |
| [Describe the paths once](docs/schema.md) | The schema, `pathOf`, id cleaning, decoding values |
| [Read Firestore and Realtime Database](docs/firebase.md) | What runs on the server, what runs here, and why the answer is the same |
| [explain() and indexes](docs/explain.md) | What a query sends, and the indexes Firebase needs |
| [Listen live](docs/listen.md) | `listen`, shared connections, errors, RxJS, components, Node |
| [Testing your own code](docs/testing.md) | In-memory transports for tests |
| [Speed](docs/performance.md) | Benchmarks against hand-written loops |
| [Developing wherelive](docs/development.md) | Tooling and the emulator tests |

## Entry points

```
wherelive              what you use: ListQuery, schema, leaf, the two backends, the errors, and 28 names in all
wherelive/firebase     transports on the real Firebase SDK        needs `firebase`
wherelive/rxjs         observe(): a listen as an Observable       needs `rxjs`
wherelive/testing      in-memory transports for tests
wherelive/transport    only to write your own transport or backend: the shapes they speak, 28 names
```

## Not built yet

These wait until a caller needs them: `whereEqualUnless`, `whereEqualOrEmpty`, `intersect` and `except`, `some(callback)` (use `.where(fn).some()`), a Firestore query built from a `DocumentSnapshot`, a `QueryState` snapshot, and the React/Vue/Angular/Svelte adapters.

## Contributing

Issues, questions and pull requests are welcome. Read [CONTRIBUTING.md](CONTRIBUTING.md) to set up and see what is most wanted (an Admin SDK transport is the biggest gap). Ask a question or share how you use it in [Discussions](https://github.com/hanios123/wherelive/discussions). Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md). For a security problem, see [SECURITY.md](SECURITY.md). Changes are listed in [CHANGELOG.md](CHANGELOG.md).

If wherelive saves your team time, starring the repo helps others find it.

## License

[MIT](LICENSE)
