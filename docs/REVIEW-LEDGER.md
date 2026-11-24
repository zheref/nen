# Review-cycle ledger

```text
nen review ledger init|ensure|decide|record|show|recover-first --branch <name> [--pr <n>] [--repo <path>] [--json]
nen review ledger record --branch <name> --persona <id> --outcome delta --from-head <sha> --to-head <sha> [--pr <n>] [--repo <path>] [--json]
```

This is the TypeScript owner of Hatsu's review-cycle ledger ([#346](https://github.com/zheref/nen/issues/346)).
The document remains `hatsu.hanten.cycle/v0.1` at
`.nen/hanten/<branch-with-slashes-replaced-by-dashes>[-pr<N>].cycle.json`.
An effort is a branch plus its PR number; each PR gets a separate budget.
`--pr #12` and `--pr 12` select the same key. Existing unknown fields,
historical reviewer rows, invocation timestamps and used counts survive writes.

The roster and maxima come from the target's `nen/workflow.json`
`review.scopes.*.persona` and `.budget`. Persona matching is case-insensitive;
duplicate scopes share their smallest budget and the source names every scope.
A missing or malformed policy refuses at exit 2. Nen has no built-in persona
roster or fallback budgets. Declare the complete roster before migrating.

- `init` opens a new key and refuses to replace one that exists.
- `ensure` returns `opened` or `present` without changing an existing ledger.
  `--base` overrides the trunk read from `branch.base`, then `origin/HEAD`, then
  `main`. The trunk, `HEAD`, an empty branch and `refs/*` refuse at exit 3.
  The requested PR ledger takes precedence over a branch-only ledger.
- `decide --applicable <csv>` returns `reviewers[]`, `raise[]` and
  `skippedExhausted[]`. Each reviewer carries `used`, `max`, `remaining`,
  `deltas`, `skips`, `lastDeltaHead` and `action` (`raise`, `skip-exhausted`
  or `not-applicable`). `used` counts ordinary rounds only; `skips` counts
  `skipped-exhausted` rows and `deltas` counts `delta` rows, so the three are
  read without parsing `invocations[]`. A delta never restores a `raise`.
- `record --persona <id> --outcome ran|skipped-exhausted` appends a timestamped
  invocation. `ran` spends one pass and refuses past the maximum; a skip is
  valid only when exhausted. Changing the declared maximum never resets used.
- `record --persona <id> --outcome delta --from-head <sha> --to-head <sha>`
  appends hanten's bounded delta pass ([#662](https://github.com/zheref/nen/issues/662)):
  `{ at, outcome: "delta", fromHead, toHead }`. It spends nothing — `used` and
  `max` are unchanged — and is the truthful row for a completed re-read of a
  spent reviewer's own earlier review on a new head. Each is refused at exit 2
  before anything is written, the message naming the bad input: a missing
  head, a head given with `ran` or `skipped-exhausted`, a head that is not a
  full 40-digit lowercase hexadecimal commit id, equal heads, a reviewer with
  no `ran` row in this cycle, a reviewer that still has budget (raise an
  ordinary round instead), the same `fromHead`/`toHead` pair recorded again,
  and, among the deltas since the reviewer's last `ran` row, a `fromHead`
  other than the last delta's `toHead` when one exists, or a `toHead` those
  deltas already reviewed. A later `ran` row resets that chain, so the next
  delta may start from any head; the duplicate check reads the whole cycle.
  `lastDeltaHead` is the `toHead` of the last delta since the last `ran` row,
  `null` when there is none; `deltas` counts every delta in the cycle.
- `show` returns the document with its absolute `path`. `show` and `decide`
  read without saving; missing reads leave no lock trace.
- `recover-first --confirmed-first-cycle` explicitly audits a first-cycle
  recovery as `openedAs: confirmed-first-cycle-recovery`. Pass this flag only
  after the maintainer confirms no review ran under the key. Prior reviews
  require restoring their original counts; no operation overwrites a ledger.

`ensure` returns exit 4 and `ensure: lost` when a missing ledger has any earlier
trace: `<git-common-dir>/hatsu/hanten/<key>.opened`, an exact `-pr<digits>`
marker or ledger, another worktree's ledger/lock, or a stale local lock. The
durable marker outlives `git clean` and removal of a worktree. A longer sibling
branch such as `topic-pr2-notes` is not a PR key. Lock age is captured before
waiting, so concurrent ensures cannot erase a lost-ledger signal.

Nen serializes updates with its shared exclusive-create mutex at
`<ledger>.lock` (`.cycle.json.lock`) and writes JSON atomically. The legacy
`.cycle.lock` file remains a persistent trace, including its old mtime.
Stop the legacy script's writers before switching to this verb: its OS locks
and Nen's mutex are different. Nen waits on active mutex holders and checks
again before opening. A stale mutex is recovered by identity, with a warning;
its prior age still counts as a lost trace. Lock timeout or an I/O failure is
exit 1. Durable-marker write failures are warned, never described as durable.

Migration deliberately requires evidence for new reviewers: a missing row can
start at zero only if `personasAtOpen` proves the persona was absent and
`lateHydrated` does not already name it. The next `record` persists that audit.
An unstamped old ledger with a missing reviewer is ambiguous and refuses at
exit 2. The legacy script's named-persona exception is not embedded in Nen;
restore that history explicitly. Malformed rows and inconsistent counts always
refuse. Complete unstamped ledgers load without loss.

A `delta` row is read only in the shape `record` writes — both heads full,
lowercase and different — and `used` must still equal the number of `ran`
rows; a malformed stored delta is inconsistent history and refuses at exit 2,
never repaired. Legacy ledgers holding only `ran` and `skipped-exhausted`
rows read exactly as before. The contract stays `hatsu.hanten.cycle/v0.1`
so that a ledger without deltas stays readable everywhere; **a nen older than
this change refuses a ledger that holds a `delta` row as inconsistent
history**, so a caller records deltas only once its pinned nen has the
outcome.

Exit 0 means the requested operation succeeded; exit 2 covers bad arguments,
second init, missing/corrupt history, invalid policy and misuse of a budget.
Ensure's exit 3/4 documents carry `reason`, and lost documents carry `traces[]`.
Init/recovery return `path`, `branch`, `pr`, `contract`, `openedAs` and
`budgets`; record returns `path`, `persona`, `outcome`, `used`, `max`,
`deltas`, `skips` and `lastDeltaHead`, plus `fromHead` and `toHead` for a
delta.
Human output is concise; `--json` carries these full documents.

