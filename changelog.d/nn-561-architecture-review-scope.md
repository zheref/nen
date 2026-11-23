### Added

- This repository's `nen/workflow.json` now declares an `architecture` review scope (Chrollo, `deep` tier, one pass), so the mandatory content-raised totality pass has a declared reviewer and a finite budget instead of being reported as a configuration gap. Code and security keep their budgets; an exhausted architecture budget reads `skipped-exhausted` in `nen review ledger`, never a review that did not run.
- `nen review ledger decide` and `record` now answer a scope name given as a persona (`--applicable architecture`) with the persona to name instead (`chrollo`).
