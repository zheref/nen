### Fixed

- Retry Windows `EPERM` conflicts while atomically replacing a ledger, retaining the complete temporary document and the caller's writer lock. Recovery uses a 500ms monotonic deadline, waits at most 25ms per retry, and stops after at most 21 attempts; persistent failures name the ledger and retain the original filesystem error. The prior ledger is never removed before replacement, and a temporary-file cleanup failure cannot hide the write failure ([#566](https://github.com/zheref/nen/issues/566)).
