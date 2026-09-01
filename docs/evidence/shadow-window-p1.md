# Shadow window — P1 evidence (zheref/nen#2)

§7's P1 evidence bar, verbatim:

> Shadow window: on live bankai-core PRs, `nen pr ready` must equal
> `pr_ready_gate.sh --verdict` — every disagreement is a finding before Nen may
> become an authority.

This is that comparison, run with `src/shadow/run.ts` against the candidate
set issue #2's Scope names: **every open pull request** across
`zheref/KroApple`, `zheref/KroAndroid`, `zheref/bankai-scaffold`, `zheref/nen`,
`zheref/hatsu`, `zheref/akatsuki-ai`, and `zheref/bankai-core` (the seventh
repository, added to `src/shadow/targets.json`'s `openPrRepos` by the review
correction below), plus bankai-core's five named closed pull requests (907,
909, 911, 913, 916).

Both sides judged the same pull request under the same reviewer identities
(`src/schema/fixtures/bankai-repo/schemas/gates.json` — the reviewer set the
oracle script itself hard-codes: sasuke, tenma, copilot, bisky, bugbot,
uniformly across every repository it is pointed at, since these are the
oracle's own reusable-workflow reviewers rather than anything the target
repository configures), the same default round policy (`bounded`), and no
`--reviewers` override on either side, so both derive their reviewer set from
the same check rollup when one is not named.

**Corrected after an independent adversarial review (zheref/nen#2's review
record).** The review found the comparison weaker than it claimed to be, in
two ways, both fixed in `src/shadow/run.ts` before this run:

1. **Agreement was decided on READY-NESS alone.** Two implementations that
   failed on different conjuncts, or emitted different reason text, were
   recorded as "agree" — a strictly weaker instrument than the epigraph above
   asks for, and the opposite of proof for the port's own claim that its
   reason strings are byte-for-byte transcriptions. `agrees()` is now two
   functions, `readyAgrees()` and `reasonAgrees()`, and a row is clean only
   when both hold. `reasonAgrees()` normalizes away the ONE declared adoption
   divergence (`../gates/ready.ts`'s ADOPTION DIVERGENCE (3), the
   `(bankai-core#671)` citation `nen`'s own §3 forbids it from emitting) and
   compares the rest of the text verbatim.
2. **The rendered table truncated any cell over 80 characters**, which is
   exactly the reason text the new comparison needs to see, and which is why
   the PREVIOUS version of this document — hand-transcribed rather than
   generated — carried full untruncated strings its own harness could not
   have produced, plus five rows (for repositories with no open pull request
   at run time) `buildCandidates`/`renderReport` cannot emit at all.
   `renderReport` no longer truncates, and the table below is the harness's
   own `--out` file, pasted in without hand-editing.

A third, MINOR correction: `--limit` with a non-numeric value used to parse to
`NaN`; `limit === null` is `false` for `NaN`, so `candidates.slice(0, NaN)`
silently ran zero candidates and would have reported "0/0 agree" as a clean
pass. `--limit` now refuses a non-integer or negative value outright. Not
exercised by this run (`--limit` was not passed), stated for the record.

Run: 2026-09-01, oracle checkout at `bankai-core` `main`
(`2269fe723e355dc69bf535ab40f22556e4fe4081`, working tree clean), `gh`
authenticated as `zheref`.

## Result

This is `--out`'s file, unedited:

| Repo | PR | Origin | Oracle | Nen | Ready agree | Reason agree |
|---|---|---|---|---|---|---|
| zheref/KroAndroid | #186 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #23 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #21 | open | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #907 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #909 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #911 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #913 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #916 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |

**8 of 8 candidates agree: 8/8 on ready-ness, 8/8 on reason text.** Zero
disagreements of either kind. No row is fabricated and none is missing: the
harness enumerated seven `openPrRepos` and every one of `zheref/KroApple`,
`zheref/nen`, `zheref/hatsu`, `zheref/akatsuki-ai` and — newly, this run —
`zheref/bankai-core` had **zero open pull requests** (`gh pr list --repo
<repo> --state open` returned `[]` for all five, confirmed independently
outside the harness immediately before this run), so `buildCandidates`
correctly contributed no row for any of them. That is a fact about the state
of those repositories today, not a gap in the harness, and unlike the
previous version of this document, this one does not print rows the harness
cannot produce for repositories that happen to be quiet.

Reproduce with:

```
bun src/shadow/run.ts --oracle-repo <path to a bankai-core checkout on main> --repo <path to this checkout>
```

## Findings

**No disagreements, on EITHER dimension the harness now checks.** Every
candidate the two implementations could both evaluate returned the identical
verdict AND the identical reason text (after the one declared, named
exemption for the `(bankai-core#671)` citation `reasonAgrees()` normalizes
away — see the correction above). This is no longer a claim resting on a
hand-transcribed table: the comparison is automated, and the table above is
its unedited output.

**What depth this run actually exercised, stated plainly.** The five named
bankai-core pull requests are all closed, and a closed pull request's
`mergeable` field comes back `UNKNOWN` from GitHub's own API on both transports
(REST, which the oracle reads, and GraphQL, which nen reads) — GitHub stops
computing mergeability once a PR is no longer open. Both sides therefore
short-circuit on the very FIRST conjunct for all five, which is a genuine,
correct agreement (the two transports read the same fact from GitHub the same
way, and now provably the same REASON TEXT too) but not a deep one:
CON-32(b)'s owed-round, stalled-round and approve-at-head limbs and
CON-32(d)'s unresolved-thread count were never exercised against live
bankai-core data by this run, because `bankai-core` had **zero open pull
requests** at run time — the five closed numbers are the whole of issue #2's
Scope for that repository, and no substitute for a genuinely open one exists
to test against right now, even with `bankai-core` now enumerated for open
PRs on every run (the review correction above).

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

Six of the seven repositories `openPrRepos` now names (`zheref/KroApple`,
`zheref/nen`, `zheref/hatsu`, `zheref/akatsuki-ai`, `zheref/bankai-core`, and
— for this run only — `zheref/bankai-scaffold`, which happened to have open
PRs) either had no open pull requests at run time or contributed the rows
already discussed above. This is a fact about the state of those repositories
today, not a gap in the harness: `src/shadow/run.ts` enumerates every open PR
at run time (`gh pr list --repo <repo> --state open`) rather than a fixed
list, so re-running it after any of these repositories opens a PR extends the
table for free — including `zheref/bankai-core` itself now, which the
PREVIOUS version of `openPrRepos` omitted despite it being the one repository
§7's evidence bar is written about (the review's MINOR finding, corrected
above). **Residual gap, recorded rather than hidden:** the owed-round,
stalled-round, approve-at-head and unresolved-thread-count conjuncts have not
yet been shadow-tested against a FAILING case on live data, only a passing
one. Closing that gap is what #4's `nen dev replay` corpus is for (issue #2's
own "Acceptance / evidence" section: "the companion evidence line ... is
delivered by #4's `nen dev replay`") — a fixed, replayable set of recorded
states rather than whatever happens to be open on the day this file was last
regenerated.

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
