### Added

- **schema** — `schema check --ledger` appends an optional `.nen/last-stop.json` row using the same strict v0.1/v0.2 validator as `stop show`. An absent or consumed marker is OK; malformed JSON, an invalid marker or a read failure other than absence is a required failure. Ordinary schema checks keep their existing rows and never read the marker. Validation lives in a shared module with no command or host dependency.

### Fixed

- **decisions** — `mergeDecisions` protects a canon human gate's declared gate ID as well as its class. A consumer cannot change G4 to G2, G2 to G4 or any other identity; no ordering of gates is inferred. Same-gate metadata overrides and nonhuman/additive behavior remain supported.

### Breaking / consumer notes

- Human-gate overrides that formerly retained the class but changed the gate ID now fail at the override's `.gate` pointer. This enforces #216's original canon protection. No version or compatibility-floor literal changes in this delivery.
- Partial completion of [#216](https://github.com/zheref/nen/issues/216): most original requirements shipped in PR #217/v0.11.0. The original unknown-repository exit-1 wording conflicts with the published exit-0/null-fields/notes classification contract; this effort preserves the published behavior and leaves that discrepancy for reconciliation. It does not claim a reproduced marker writer defect: a host Stop hook can consume a successful write before later inspection.
