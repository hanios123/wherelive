# Benchmarks

```bash
pnpm bench            # query, project and live groups against the built package
pnpm bench -- --quick # 1,000 and 10,000 rows only
pnpm bench:sdk        # a live list on the real Firebase SDK, offline
```

`pnpm bench` builds first and runs `dist/`, which is what your users import. Each group runs in its own process.

## Reading the output

Every query case runs the same work as a hand-written native loop (`array.filter`, `[...array].sort(compare)`, a `Map` for grouping) and checks that both give the same answer before timing either. The columns:

| Column | Meaning |
| --- | --- |
| `wherelive`, `native` | Median time of the call, whole call included (building the query and running it) |
| `x slower` | wherelive divided by native. It shrinks as `n` grows because the native loop slows down when the data stops fitting in cache, so compare `ns/row` across runs, not this |
| `ns/row` | wherelive time divided by rows. Flat across sizes means linear. A sort should grow slowly, like `n log n` |
| `noise` | Slowest tenth of samples divided by the median. Near 1.0 is steady. Above about 1.5, run it again |

A few baselines are not doing the same amount of work, and say so in the case name: `where + limit(10)` stops early while the native `filter().slice()` does not, and `unionAll` against `concat` is a memory copy.

## Groups

| Group | Covers |
| --- | --- |
| `query` | `where` in each form, `first()` and `some()` early exit, `orderBy` (number, string, date, locale, nested), `orderBy` with `limit`, `offset`, cursors and `limitToLast`, and the cost of running a tiny query |
| `project` | `select`, `distinct`, `groupBy` and `aggregate`, joins, `union`, `flatMap`, `pairs`, `combine`, holders |
| `live` | A live Firestore list over a stub transport that does nothing, so the numbers are the library's own: first snapshot, one change in `n` rows, many callers on one connection, `listen` and `stop`, a caller joining late, memory per row, a Realtime Database list, and `get()` through the schema |
| `diagnose` | Experiments that change one thing at a time: a string path against a function, `count()` with and without `select`, `orderBy` with and without `limit` |
| `sdk` (`pnpm bench:sdk`) | The Firebase SDK in memory with the network off: what one changed document costs when the SDK is asked for changes only, for every document, and through this library following whole snapshots and following changes (the shipped adapter). The last column should stay flat as the list grows |

## Getting steady numbers

Plug the machine in, close other work, and run twice. `BENCH_RESULTS=results.jsonl pnpm bench` writes each result as a line of JSON, so two runs can be compared with a script. The data is generated from a fixed seed, so runs measure the same rows.
