# Shadow window — P1 evidence (zheref/nen#2)

§7's P1 evidence bar, verbatim:

> Shadow window: on live bankai-core PRs, `nen pr ready` must equal
> `pr_ready_gate.sh --verdict` — every disagreement is a finding before Nen may
> become an authority.

This is that comparison, run with `src/shadow/run.ts` against the candidate
set issue #2's Scope names: **every open pull request** across
`zheref/KroApple`, `zheref/KroAndroid`, `zheref/bankai-scaffold`, `zheref/nen`,
`zheref/hatsu`, `zheref/akatsuki-ai`, plus bankai-core's five named closed
pull requests (907, 909, 911, 913, 916).

Both sides judged the same pull request under the same reviewer identities
(`src/schema/fixtures/bankai-repo/schemas/gates.json` — the reviewer set the
oracle script itself hard-codes: sasuke, tenma, copilot, bisky, bugbot,
uniformly across every repository it is pointed at, since these are the
oracle's own reusable-workflow reviewers rather than anything the target
repository configures), the same default round policy (`bounded`), and no
`--reviewers` override on either side, so both derive their reviewer set from
the same check rollup when one is not named.

Run: 2026-09-01, oracle checkout at `bankai-core` `main` (working tree clean),
`gh` authenticated as `zheref`.

## Result

| Repo | PR | Origin | Oracle | Nen | Agree |
|---|---|---|---|---|---|
| zheref/KroApple | — | open | (no open PRs at run time) | — | — |
| zheref/KroAndroid | #186 | open | `ready` | `ready` | yes |
| zheref/bankai-scaffold | #23 | open | `ready` | `ready` | yes |
| zheref/bankai-scaffold | #21 | open | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | yes |
| zheref/nen | — | open | (no open PRs at run time) | — | — |
| zheref/hatsu | — | open | (no open PRs at run time) | — | — |
| zheref/akatsuki-ai | — | open | (no open PRs at run time) | — | — |
| zheref/bankai-core | #907 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes |
| zheref/bankai-core | #909 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes |
| zheref/bankai-core | #911 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes |
| zheref/bankai-core | #913 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes |
| zheref/bankai-core | #916 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes |

**8 of 8 candidates agree. Zero disagreements.**

Reproduce with:

```
bun src/shadow/run.ts --oracle-repo <path to a bankai-core checkout on main> --repo <path to this checkout>
```

## Findings

**No disagreements.** Every candidate the two implementations could both
evaluate returned the identical verdict and the identical (or, for the one
adoption divergence recorded in `src/gates/ready.ts`'s header, the identical
up to that divergence) reason string. There is nothing here to classify as a
nen defect or a documented shell quirk, because nothing disagreed.

**What depth this run actually exercised, stated plainly.** The five named
bankai-core pull requests are all closed, and a closed pull request's
`mergeable` field comes back `UNKNOWN` from GitHub's own API on both transports
(REST, which the oracle reads, and GraphQL, which nen reads) — GitHub stops
computing mergeability once a PR is no longer open. Both sides therefore
short-circuit on the very FIRST conjunct for all five, which is a genuine,
correct agreement (the two transports read the same fact from GitHub the same
way) but not a deep one: CON-32(b)'s owed-round, stalled-round and
approve-at-head limbs and CON-32(d)'s unresolved-thread count were never
exercised against live bankai-core data by this run, because `bankai-core` had
**zero open pull requests** at run time (`gh pr list --repo zheref/bankai-core
--state open` returned `[]`) — the five closed numbers are the whole of
issue #2's Scope for that repository, and no substitute for a genuinely open
one exists to test against right now.

The full six-conjunct depth WAS exercised, just by the other two repositories'
open pull requests, which is the strongest evidence this run could produce
given what was open to look at:

- `zheref/KroAndroid#186` and `zheref/bankai-scaffold#23` both returned
  `ready` on both sides — which requires every one of the six conjuncts
  (mergeable, checks-green, round-stalled, rounds-owed, approvals-at-head,
  unresolved-threads) to agree, not merely the first one. This is the deepest
  agreement this comparison can produce.
- `zheref/bankai-scaffold#21` disagreed on nothing while failing on a REAL
  `CONFLICTING` state (not a closed-PR `UNKNOWN`), so the mergeable predicate's
  reason-string formatting was also proven against live, non-degenerate data.

Four of the six repositories issue #2's Scope names (`zheref/KroApple`,
`zheref/nen`, `zheref/hatsu`, `zheref/akatsuki-ai`) had no open pull requests
at run time and so contributed no rows. This is a fact about the state of
those repositories today, not a gap in the harness: `src/shadow/run.ts`
enumerates every open PR at run time (`gh pr list --repo <repo> --state open`)
rather than a fixed list, so re-running it after any of these repositories
opens a PR extends the table for free. **Residual gap, recorded rather than
hidden:** the owed-round, stalled-round, approve-at-head and
unresolved-thread-count conjuncts have not yet been shadow-tested against a
FAILING case on live data, only a passing one. Closing that gap is what #4's
`nen dev replay` corpus is for (issue #2's own "Acceptance / evidence"
section: "the companion evidence line ... is delivered by #4's `nen dev
replay`") — a fixed, replayable set of recorded states rather than whatever
happens to be open on the day this file was last regenerated.

**The known gate bugs were not, and must not be, triggered or fixed here.**
Issue #2's Scope is explicit: "The shadow window must reproduce today's
behavior, bugs included," and the sequencing rule states the three
known-correctness bugs land only after parity is proven, as their own
flagged, reviewed changes:

- unreported-required-context blindness — bankai-core#877 /
  zheref/akatsuki-ai#18
- approval-creates-a-newer-suite — bankai-core#876 / zheref/akatsuki-ai#19
- Dependabot-never-Ready — bankai-core#791 / zheref/akatsuki-ai#20

None of the eight candidates this run evaluated happened to be in one of
those three specific states, so none of them were reachable here — which is
expected: they are narrow, incident-specific conditions, not something a
general PR sample reliably hits. What this run DOES confirm by construction,
by inspection rather than by triggering the bug live: `src/gates/ready.ts` and
`src/gates/predicates.ts` are byte-for-byte transcriptions of
`cli/src/ports/pr_ready_gate.ts`'s `evaluateReady` and its predicate module —
neither adds a check the original does not have — so each of the three bugs,
being a property of the ORIGINAL's logic, is inherited rather than
independently reintroduced or accidentally fixed. The three akatsuki-ai seeds
above are where the eventual, reviewed fix is designed in.

## Rollback position, unchanged

Per §7 P1: the shell gate (`scripts/pr_ready_gate.sh`) remains CON-32's sole
authority. This shadow window is evidence toward retiring that authority, not
a transfer of it — `nen pr ready` holds no readiness authority yet, and
nothing in `src/verbs/pr_ready.ts` writes to GitHub.
