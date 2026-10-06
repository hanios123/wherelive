# Developing wherelive

See [CONTRIBUTING.md](../CONTRIBUTING.md) for the contribution process. This page covers the tooling and the emulator tests.

Inside, `src/core` holds the query engine and `src/schema` the paths. A query over an array and a query over a database list share one base class, `QueryBuilder`, so `where`, `orderBy`, `limit`, the cursors and every other builder method are written once and mean the same on both. `test/structure.test.ts` pins that, and `test/package.test.ts` builds the package as published and pins the exact public names.

`test/boundary.test.ts` fails if anything outside `firebase/`, `rxjs/` and `testing/` imports a framework or the SDK, or touches `window`, `document`, `localStorage`, `process`, and so on.

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
