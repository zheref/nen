### Added

- **release, pr** — `release.unitPaths` accepts `{ "path": "<exact text file>", "lines": ["<whole-line regex>"] }` entries. `release unit-check` and `pr merge --release-unit` check every removed and added line against complete merge-base/head blobs, failing closed on unreadable text or a diff beyond the stated work bounds. Existing JSON-key bounds keep their report shape; `linedPaths` and `lineScopedViolations` are additive fields.
- **schema** — `schema check` reports `nen/workflow.json#release`, including exact, prefix/glob, key-bound and line-bound counts.

### Fixed

- **release** — an `=path` string claims one exact path, so `=README.md` cannot admit `README.md/**`. Nen's own release unit bounds changed lines in `src/version.ts`, `README.md` and `docs/USAGE.md` to version/floor and declared install/example forms, and names `=CHANGELOG.md` exactly. Both removed and added lines are checked independently; allowed lines may be deleted, moved or replaced by another allowed form, including optional fixed command fragments. The bound does not preserve presence, position, pairing or consistent versions. Closes [#348](https://github.com/zheref/nen/issues/348).
- **release** — line bounds use a release-only bounded state matcher, preserving legacy identity-regex consumers. Unsupported syntax fails schema loading by pointer. Matching never backtracks through PR text; source, nesting, state, class and pattern-count limits bound compilation, and changed-line length plus per-line/per-file operation budgets fail closed with a distinct exhaustion reason. The limits and supported expression subset are documented in USAGE.
- **schema, report** — exact markers in review scopes and report tiers are validated at their read seams, so an empty `=` or malformed repo-relative exact path cannot silently claim nothing. Bare prefixes and globs retain their existing meaning.

### Breaking / consumer notes

- `=` is an explicit exact-path marker in the shared path grammar (`release.unitPaths`, `review.scopes` and report tiers). Bare strings retain their prefix/glob meaning; a literal path beginning `=` can be named with another leading `=`. Content-entry paths now also refuse globs, empty or dot segments, backslashes and control characters. A line-bound file must be readable as UTF-8 without NUL at the same path at both commits; additions, deletions and renames that cannot satisfy that check are refused. No release version is bumped by this feature change.
