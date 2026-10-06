# Speed

```bash
pnpm bench        # queries, projection and grouping, live lists, against the built package
pnpm bench:sdk    # a live list on the real Firebase SDK, offline
```

Each case is timed next to the same work written by hand (`array.filter`, a sort, a `Map`), after checking that both give the same answer. [bench/README.md](../bench/README.md) explains how to read the output. Rough costs on a laptop, per row: a `where` about 0.1 µs, a full `orderBy` 1 to 2 µs, `select` about 0.3 µs, `groupBy` and joins 0.5 to 1 µs. An `orderBy` with a `limit` picks the rows it needs and does not sort the rest. Cost grows in line with the number of rows (a full sort grows slightly faster than the rows do), with no cliff up to 100,000 rows.
