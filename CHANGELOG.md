# Changelog

All notable changes are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project follows [semantic versioning](https://semver.org). While the major version is 0, a minor release may change the API.

## [Unreleased]

### Added

- Community files: contributing guide, code of conduct, security policy, issue and pull request templates, and CI.

## [0.1.0]

First public release.

- `ListQuery`: typed `where`, `select`, `orderBy`, `limit`, `offset`, cursors, `groupBy` and `aggregate`, joins, `union`, `flatMap` and `combine` over arrays.
- A schema of typed paths, with `get`, `count`, `aggregate` and `listen` on Firestore and Realtime Database.
- `explain()` and `firestoreIndexes()` for the work a query sends to the server and the indexes it needs.
- `wherelive/rxjs` (`observe`), `wherelive/firebase` and `wherelive/testing` (in-memory transports).

[Unreleased]: https://github.com/hanios123/wherelive/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/hanios123/wherelive/releases/tag/v0.1.0
