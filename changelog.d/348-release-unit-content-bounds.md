### Added

- **release, pr** — `release.unitPaths` accepts `{ "path": "<exact text file>", "lines": ["<whole-line regex>"] }` entries. `release unit-check` and `pr merge --release-unit` check every removed and added line against complete merge-base/head blobs, failing closed on unreadable text or a diff beyond the stated work bounds. Existing JSON-key bounds keep their report shape; `linedPaths` and `lineScopedViolations` are additive fields.
- **schema** — `schema check` reports `nen/workflow.json#release`, including exact, prefix/glob, key-bound and line-bound counts.

### Fixed

- **release** — an `=path` string claims one exact path, so `=README.md` cannot admit `README.md/**`. Nen's own release unit now bounds `src/version.ts`, `README.md` and `docs/USAGE.md` to version/floor literals and fixed install/example lines with numeric pins, and names `=CHANGELOG.md` exactly. Bootstrap destinations and other text changes require the maintainer's merge. Closes [#348](https://github.com/zheref/nen/issues/348).

### Breaking / consumer notes

- `=` is an explicit exact-path marker in the shared path grammar (`release.unitPaths`, `review.scopes` and report tiers). Bare strings retain their prefix/glob meaning; a literal path beginning `=` can be named with another leading `=`. Content-entry paths now also refuse globs, empty or dot segments, backslashes and control characters. A line-bound file must be readable as UTF-8 without NUL at the same path at both commits; additions, deletions and renames that cannot satisfy that check are refused. No release version is bumped by this feature change.
