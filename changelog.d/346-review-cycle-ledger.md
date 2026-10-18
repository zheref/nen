### Added

- `nen review ledger init|ensure|decide|record|show|recover-first` maintains local review-cycle budgets from the target's own `review.scopes`, including minimum repeated-persona budgets, exact branch/PR keys, persistent loss traces and confirmed first-cycle recovery. Legacy history requires explicit `migrate --confirmed-no-legacy-writers`: a byte-exact backup preserves metadata and counts, missing reviewer rows require restoration, and the Nen-only mutex never breaks interrupted ownership by age. Refs #346.
