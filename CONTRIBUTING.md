# Contributing to wherelive

Thanks for helping. Bug reports, questions, docs fixes and new ideas are all welcome, not only code.

By taking part you agree to follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## Ways to help

- **Try it and tell us what broke.** The most useful report is a small query, the rows you expected, and the rows you got.
- **Improve the docs.** If something in the README made you stop and re-read, fix the wording.
- **Pick up an issue.** Issues labelled [`good first issue`](https://github.com/hanios123/wherelive/labels/good%20first%20issue) are small and self-contained. Comment on one before you start so two people do not do the same work.
- **Write a transport.** An Admin SDK transport is the most asked-for gap (see "Not built yet" in the README).

## Ask before a big change

For anything larger than a bug fix, open an issue first and describe the problem, not just the solution. A new builder method has to mean the same thing on an array, on Firestore and on Realtime Database, so it is worth agreeing the behaviour before the code.

## Set up

You need Node 22 or newer and [pnpm](https://pnpm.io).

```bash
git clone https://github.com/hanios123/wherelive.git
cd wherelive
pnpm install
pnpm run check   # typecheck, lint, tests, build
```

`pnpm install` also installs a git hook that runs `eslint --fix` on staged files before each commit.

The emulator tests run the real Firebase SDK against the Firestore and Realtime Database emulators. They need Java 11 or newer and the Firebase CLI, and they are optional locally. CI does not run them yet.

```bash
pnpm test:emulator
```

## Where things live

| Folder | What it holds |
| --- | --- |
| `src/core` | The query engine. No framework, browser, Node or Firebase imports |
| `src/schema` | Paths, `leaf`, `schema`, `pathOf` |
| `src/firestore`, `src/realtime` | The two backends: what goes to the server, what runs locally |
| `src/listen` | Live listening, connection sharing, errors |
| `src/firebase`, `src/rxjs`, `src/testing` | Optional entry points. Only these may import `firebase` or `rxjs` |
| `test/` | Unit tests. `boundary`, `structure` and `package` tests guard the rules above |
| `test-emulator/` | Tests against the real SDK on the emulators |
| `bench/` | Benchmarks. See [bench/README.md](bench/README.md) |

## Making a change

1. Fork the repo and branch from `main`.
2. Add or change a test first when you can. A bug fix should come with a test that fails without it.
3. Run `pnpm run check`. It must pass.
4. Update the README if behaviour a user can see changed, and add a line under **Unreleased** in [CHANGELOG.md](CHANGELOG.md).
5. Open a pull request and fill in the template.

Keep a pull request to one change. A small one is reviewed faster.

### Rules the tests enforce

- The core must give the same answer on an array and on a database. If Firestore differs on purpose, `test/read.test.ts` documents it.
- Nothing outside `firebase/`, `rxjs/` and `testing/` may import a framework or the SDK, or touch `window`, `document`, `process` and similar globals.
- The public API is pinned by `test/package.test.ts`. Adding or removing an export means updating that test on purpose.
- Types are part of the feature. A new builder method needs a case in `test/types.test.ts`, including what must **not** compile.

### Commit messages

Short, imperative, one line of summary: `Fix limitToLast with a cursor`. Add a body when the why is not obvious.

## Reporting a bug

Use the bug report form. Include the wherelive and `firebase` versions, which backend (array, Firestore, Realtime Database, emulator), and the smallest query that shows the problem. Reproducing it with `MemoryFirestoreTransport` from `wherelive/testing` needs no Firebase project and is the easiest to fix.

For a security problem, do not open an issue. See [SECURITY.md](SECURITY.md).

## Releases

Maintainers cut releases. Versions follow [semver](https://semver.org). While the major version is 0, a minor release may change the API, and the changelog says so.

## License

By contributing you agree that your work is released under the [MIT License](LICENSE).
