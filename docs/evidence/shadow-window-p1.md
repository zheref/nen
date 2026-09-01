# Shadow window — P1 evidence (zheref/nen#2)

The P1 evidence bar zheref/nen#5 requires, verbatim:

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
   `(bankai-core#671)` citation `nen`'s own taxonomy-purity rule (no hard-coded
   system names in shipped code) forbids it from emitting) and
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

**Correction (zheref/nen#14's fact-check, honesty finding).** The original
text here read "This is `--out`'s file, unedited:" — false, and corrected in
place rather than left to mislead a reader who diffs this file against a
fresh `--out` run: `renderReport()` (`src/shadow/run.ts`) emits the Oracle and
Nen cells as PLAIN text, with no backticks; every Oracle/Nen cell in the table
below has since been wrapped in backticks. That is the ONE edit made to this
file's cells — for markdown rendering (so a cell's own `` ` `` or a long
`CON-32a`-style reason string does not get eaten by the table's pipe syntax)
— and nothing else in any cell was reworded, reordered, or trimmed. Stated
here once, plainly, rather than under the weaker "unedited" claim: the DATA
in every cell is `--out`'s own, verbatim; the MARKUP around the Oracle/Nen
cells is not.

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
its output, cells backtick-wrapped for markdown and otherwise unedited (see
the correction directly above the table).

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
the P1 evidence bar is written about (the review's MINOR finding, corrected
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

## Update: a real disagreement, found, fixed, and re-verified (zheref/nen#14's fact-check)

An independent fact-check of PR #14 ran the same harness fresh against 11
live candidates and found ONE genuine disagreement, on
`zheref/akatsuki-ai#33`:

- **Oracle** (`scripts/pr_ready_gate.sh --verdict`): `not-ready: NO checks
  reported at head (CON-32a)` — an EMPTY, READABLE rollup.
- **Nen** (`nen pr ready 33 --gh-repo zheref/akatsuki-ai`): `unevaluated: the
  check rollup came back empty or unreadable` — conflating that with the
  UNREADABLE case.

**Root cause.** `../github/graphql.ts`'s `headCommitCheckRollupPage()`
(named `headCommitRollupContexts()` at the time this section was written;
renamed since -- see zheref/nen#14's dangling-identifier fix)
collapsed two different facts into the same `undefined`: a head commit this
process could not resolve at all (genuinely unreadable), and a head commit
that resolved fine but whose OWN `commit.statusCheckRollup` field is the
literal GraphQL value `null` — GitHub's documented answer for "no runs have
ever attached to this commit," which is a fact ABOUT the commit, not a gap in
reading it. `../github/pr_state.ts`'s fetch-time guard then refused both
alike, so a genuinely empty-but-readable rollup was reported `unevaluated`
instead of reaching `evaluateReady`'s own `.checks // []` branch. This
module's own header carried an unverified claim that caused it: it asserted
"`gh pr view --json statusCheckRollup --jq '.statusCheckRollup'` prints
`null` for a PR whose rollup GitHub answered as null." Checked live against
`zheref/akatsuki-ai#33` (`gh api graphql` on that PR's head commit answers
`commit: { statusCheckRollup: null }`), that claim is FALSE: `gh pr view
--json statusCheckRollup` on the SAME PR prints `[]`, not `null` — gh's own
flattening already reduces this exact shape to a readable empty array before
the shell's `jq -e` guard ever runs, so `fetch_pr_state` succeeds and
`evaluate_ready` reaches the genuinely-empty branch. **This is nen's own
comment being wrong, not the shell** — the fix reproduces the shell's real,
verified behavior; nothing about the shell's own logic changed or needed to.

**Fix.** `headCommitCheckRollupPage()` now distinguishes the two cases: a head
commit it cannot resolve at all (the `commits` connection is not an array, or
the head node carries no `commit` object) still yields `undefined`
(unreadable); a resolved head commit whose own `commit.statusCheckRollup` is
the literal value `null` now yields `[]` (empty, readable), matching gh's own
reduction. `../github/pr_state.ts`'s fetch-time guard is unchanged in logic —
it still refuses on `undefined`/`null` — but what reaches it is now correct.
Both known gate bugs' sequencing is untouched: nothing about required
contexts, `mergeStateStatus`, or the dependabot carve-out (bankai-core#877/
#876/#791, zheref/akatsuki-ai#18/#19/#20) was touched by this fix, and none of
those three conditions were triggered live by this fix or its verification,
consistent with the "reproduce today's behavior, bugs included" rule this
file already states above.

A test now pins the distinction directly (`src/github/graphql.test.ts`,
`src/verbs/pr_ready.test.ts`): a present-but-null commit-level rollup on an
otherwise-resolvable head commit parses to `[]` and reaches the shell's own
byte-identical not-ready reason; a head commit that cannot be resolved at all
stays `unevaluated`. Reverting the fix and re-running the suite makes both new
tests fail with exactly the disagreement above (`unevaluated` where
`not-ready` was expected) — the mutation-proof that they bite.

**Fresh re-run, same harness, after the fix:**

```
bun src/shadow/run.ts --oracle-repo <bankai-core checkout on main> --repo <this checkout>
```

- **Run:** 2026-09-01, oracle checkout at `bankai-core` `main`
  (`2269fe723e355dc69bf535ab40f22556e4fe4081`, working tree clean), `gh`
  authenticated as `zheref`.
- **Candidates:** 12 this time (one more than the fact-check's 11 — an
  additional pull request, `zheref/bankai-core#919`, opened between the two
  runs; `src/shadow/run.ts` enumerates live at run time, by design, rather
  than against a fixed count).
- **Result:** `shadow window: 12/12 agree, 0 ready-ness disagreement(s), 0
  reason-text disagreement(s).`

| Repo | PR | Origin | Oracle | Nen | Ready agree | Reason agree |
|---|---|---|---|---|---|---|
| zheref/KroAndroid | #186 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #23 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #21 | open | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/nen | #14 | open | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | yes | yes |
| zheref/akatsuki-ai | #33 | open | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach (bankai-core#671). Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach. Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | yes | yes |
| zheref/bankai-core | #923 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #919 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #907 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #909 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #911 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #913 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #916 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |

Note the row this update exists for: `zheref/akatsuki-ai#33` now agrees on
BOTH dimensions — the exact PR the fact-check's disagreement was found on,
now closing clean. This is also the FIRST time this comparison has exercised
a live, genuinely-empty (not closed-PR-degenerate) checks rollup, which the
"depth exercised" discussion above (before this update) named as untested;
that gap is now closed too, incidentally, by the same PR that exposed the
bug.

**No new disagreement of either kind was introduced by the fix**: all 12
rows agree, including the four rows this run added or changed relative to
the 8-candidate run recorded above (`zheref/nen#14`, `zheref/akatsuki-ai#33`,
`zheref/bankai-core#923`, `zheref/bankai-core#919` — none of which existed as
open PRs at the time of that earlier run).

## Update 2: fresh 16-candidate re-run, committed as evidence (zheref/nen#14's finishing pass)

The 12/12 table above (the "Update" section, immediately before this one) is
committed, but it was never re-run after being written — the strongest
parity claim available to a reader of this file was already a few hours
stale by the time an independent fact-check of PR #14 asked for the current
state. This section closes that gap: a fresh, independent run of the exact
same harness, committed in full rather than left to go stale again.

```
bun src/shadow/run.ts --oracle-repo <bankai-core checkout on main> --repo <this checkout>
```

- **Run:** 2026-09-01T18:50Z (UTC).
- **Oracle checkout:** `zheref/bankai-core` @ `main`,
  `2269fe723e355dc69bf535ab40f22556e4fe4081` — the identical commit every
  prior run in this file used; working tree clean, confirmed immediately
  before this run.
- **`gh`:** authenticated as `zheref`.
- **Candidates: 16** — one more than the 15 an independent fact-check had
  found, and four more than the 12/12 run above (`zheref/KroApple#504`,
  `zheref/bankai-core#930`, `zheref/bankai-core#927`, `zheref/bankai-core#925`
  are new opens; `src/shadow/run.ts` enumerates every `openPrRepos` target
  live via `gh pr list --repo <repo> --state open` at run time rather than
  against a fixed list or count, so the candidate set drifting between runs
  is expected, not an error — this section reports the number actually
  observed rather than forcing an earlier run's count).
- **Result:** `shadow window: 16/16 agree, 0 ready-ness disagreement(s), 0
  reason-text disagreement(s).` Both dimensions the harness checks — verdict
  (ready/not-ready/unevaluated) and full reason text — agree on every row:
  **16/16 on ready-ness, 16/16 on reason text.**

| Repo | PR | Origin | Oracle | Nen | Ready agree | Reason agree |
|---|---|---|---|---|---|---|
| zheref/KroApple | #504 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/KroAndroid | #186 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #23 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #21 | open | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/nen | #14 | open | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | yes | yes |
| zheref/akatsuki-ai | #33 | open | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach (bankai-core#671). Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach. Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | yes | yes |
| zheref/bankai-core | #930 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #927 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #925 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #923 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #919 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #907 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #909 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #911 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #913 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #916 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |

**Correction (zheref/nen#14's fact-check, honesty finding).** This paragraph
used to read: "This is `--out`'s file, unedited, pasted in verbatim (the same
non-truncating `renderReport` the 8/8 and 12/12 tables above already use)."
False, for the identical reason the 8/8 table's own correction above states
it: `renderReport()` emits the Oracle and Nen cells as plain, un-backticked
text, and every Oracle/Nen cell in the table above has been wrapped in
backticks for markdown rendering. That is the only edit — no cell's DATA was
reworded, reordered, or trimmed — and it is stated plainly here rather than
under the stronger, false "unedited" claim.

**The one pre-declared adoption divergence, named and normalized.** Row
`zheref/akatsuki-ai#33` shows it directly: the oracle's cell carries the
citation `(bankai-core#671)` at the end of its empty-rollup sentence; nen's
cell does not. This is `../gates/ready.ts`'s header, ADOPTION DIVERGENCE (3)
— nen's own `src/taxonomy-purity.test.ts` forbids any shipped `.ts` file from
naming a system it serves as a code literal, and that citation names one, so
`src/gates/ready.ts` cannot emit it. `reasonAgrees()` (`src/shadow/run.ts`)
normalizes this ONE named substring away before comparing — reading
`targets.json`'s `knownReasonDivergence` field (`" (bankai-core#671)"`)
rather than hard-coding it — and only after that one, declared, byte-level
strip does the rest of the two reason strings compare verbatim. The table
above prints both cells' RAW, un-normalized text (the oracle's with the
citation, nen's without), by design: the divergence is meant to be visible in
the record, not hidden by pre-stripping it before the table is written.

**Correction (zheref/nen#14's fact-check, honesty finding): the "all 15"
count above was wrong.** The sentence used to read "Every other row's reason
text (all 15 of them) matches with zero normalization applied." `reasonAgrees()`
(`src/shadow/run.ts`) SHORT-CIRCUITS to `true` — agreement with NOTHING
compared — whenever either side's verdict is a bare `ready`, because a
passing verdict carries no reason text to diverge on (its own doc comment
says so). Four of the sixteen rows are exactly that: `zheref/KroAndroid#186`,
`zheref/bankai-scaffold#23`, `zheref/bankai-core#923`, and
`zheref/bankai-core#919` are all `ready`/`ready`, with no text on either side
to compare. Of the sixteen rows, one (`zheref/akatsuki-ai#33`) is the
declared, normalized divergence discussed just above; four are the
`ready`/`ready` rows with no text at all; the remaining **eleven** rows are
where reason text was actually compared, verbatim, with zero normalization —
and all eleven matched. "All 15" overstated the true figure by 4.

**Reproducing this evidence: a caveat an independent reader will hit.** The
bare form of the command this table's `akatsuki-ai#33` row exercises —

```
nen pr ready 33 --gh-repo zheref/akatsuki-ai
```

— exits 2 with `no reviewer identities` when run from a checkout that has no
`schemas/gates.json` of its own (this repository's own root does not ship
one; `src/schema/fixtures/bankai-repo/schemas/gates.json` does, which is why
this harness's `runNen()` passes `--gates <that path>` explicitly rather than
relying on the bare form). This is **deliberate design, not a parity
defect**: `src/gates/ready.ts`'s reviewer-identity resolution never falls
back to a built-in reviewer set — a binary that guessed the reviewers would
be judging the target repository against another one's vocabulary and could
report a false `ready`. The full refusal text, reproduced verbatim from a
live run against this exact PR:

```
nen: no reviewer identities. This gate never falls back to a built-in
reviewer set: a binary that guessed the reviewers would judge this
repository against another one's and report success. Give it one of:
--gates <path>, a 'schemas/gates.json' in the target repository (looked for
at '<this checkout>\schemas\gates.json'), or --reviewers a,b,c.
```

An independent reader reproducing this table needs one of those three: point
`--gates` at a reviewer-identity file (the shadow harness's own
`identityFixture`, `src/schema/fixtures/bankai-repo/schemas/gates.json`,
works), place a `schemas/gates.json` at the target repository's root, or pass
`--reviewers a,b,c` directly.

**Net effect on this record.** 16/16 on both dimensions, zero disagreements,
against the same oracle commit every prior run in this file cites, committed
here rather than left as an unrepeatable claim in a PR body. This does not
supersede the 8/8 or 12/12 tables above — both stay, unedited, as the record
of what each run actually found at the time it was run.

## Update 3: a second real disagreement — the false-green pagination defect (zheref/nen#14's fact-check)

An independent verification pass, run against PR #14 after the 16/16 table
above was already committed, drove `nen pr ready` and
`scripts/pr_ready_gate.sh --verdict` against `zheref/bankai-core#927`
directly — the same per-PR comparison this whole file automates — and found a
genuine, deterministic disagreement:

- **Oracle** (`scripts/pr_ready_gate.sh --verdict 927`): `not-ready: required
  checks reported but are not all green (CON-32a)`.
- **Nen** (pre-fix, `nen pr ready 927 --gh-repo zheref/bankai-core`): the
  `checks-green` conjunct itself read **`ready`** — the false green this
  section exists to close.

Deterministic across three runs of each side.

**Root cause.** `../github/graphql.ts`'s `PULL_REQUEST_QUERY` asked for the
head commit's status-check contexts with `contexts(first:100)` and never
paginated — no cursor, no `pageInfo`, no walk. When observed on 2026-08-31,
`zheref/bankai-core#927`'s rollup had `totalCount` 114 with `hasNextPage:
true`, and the ONE failing entry (`sasuke / audit`) sat at position 101+,
past the cap. (The same PR's rollup is a live figure, not a fixed one:
re-observed on 2026-09-01 it had grown to `totalCount` 139, with the failing
entry now at position 131.) `../github/pr_state.ts` fed that truncated,
all-green-so-far page straight to `parseCheckRollup()`, and `checksAllGreen()`
has no way to know a context it was never shown exists — a fabricated PARTIAL
array of all-green entries reads as fully green. The oracle has no
counterpart blind spot because `gh pr view --json statusCheckRollup`
paginates this same connection INSIDE gh's own client, invisibly to the shell
script that reads its output.

**Why this is the SAME class of defect the "Update" section above fixed, not
a coincidence.** That fix corrected which EMPTY rollups count as readable.
This one corrects which FULL rollups count as complete. Both are the general
rule this file's own "Findings" section states without yet having a second
example to point at: a cap that silently truncates a set a VERDICT depends on
produces a false verdict, full stop — whether the cap collapses two facts
into one (`Update`'s bug) or drops data past page one (this bug).

**Fix.** `../github/graphql.ts` now selects `pageInfo { hasNextPage endCursor
}` alongside `contexts(first:100)`, and adds `CHECK_ROLLUP_PAGE_QUERY`, a
second, cursor-driven query for every page after the first — mirroring
`REVIEW_THREADS_QUERY`'s own shape, the pattern this codebase already used to
paginate review threads correctly. `../github/pr_state.ts`'s new
`fullCheckRollup()` walks it exactly as `unresolvedThreadCount()` walks
review threads, with ONE deliberate difference: `unresolvedThreadCount()` can
safely fail TOWARD not-ready (a fabricated count of 1) because CON-32(d)'s
predicate is a simple non-zero test with no way to read a fabricated 1 as
green. `checksAllGreen()` has no such backstop, so `fullCheckRollup()` never
returns a partial set as though it were the whole rollup: a thrown fetch, a
page whose `nodes` will not parse as an array, a `hasNextPage:true` page with
an unusable cursor, or hitting the pagination cap all fail CLOSED —
`fetchPrState()` returns `ok:false`, which surfaces as `unevaluated`, never a
partial `ready`.

**Tests, pinned and mutation-proved.** `src/github/pr_state.test.ts` and
`src/verbs/pr_ready.test.ts` each add a stubbed rollup spanning two pages with
the failing entry on the SECOND page (asserting `not-ready`, matching the
oracle's own reason text byte-for-byte), plus a page-two FETCH FAILURE
(asserting `unevaluated`, never a partial `ready`). Reverting the pagination
walk (disabling the multi-page branch, and separately, making the
mid-pagination catch swallow the error and return the partial set) makes
exactly these new tests fail red with the disagreement described above;
restoring the fix turns them green again with no other test affected.

**Live re-verification against #927, before and after, both shown.**

Pre-fix (`git stash` of the fix, same working tree, same live PR):

```
$ nen pr ready 927 --gh-repo zheref/bankai-core --gates <bankai-repo fixture>
zheref/bankai-core#927: not-ready: not every approving reviewer's latest round is an APPROVE (CON-32b): sasuke (no APPROVE at the current head)
```

The overall verdict is `not-ready` here too — but for the WRONG reason: the
`checks-green` conjunct (`--json`'s `conjuncts[1]`) reads `"status": "ready"`,
the false green, and evaluation only reaches `not-ready` because an unrelated
later conjunct (`approvals-at-head`) also happens to fail on this PR's
CURRENT state. On a PR identical in every respect except that its approvals
were current, pre-fix nen would have answered a bare `ready` while the oracle
answered `not-ready: required checks reported but are not all green
(CON-32a)` — the false green in its full, undiluted form.

Post-fix, same PR, same head:

```
$ nen pr ready 927 --gh-repo zheref/bankai-core --gates <bankai-repo fixture>
zheref/bankai-core#927: not-ready: required checks reported but are not all green (CON-32a)
```

Byte-identical to the oracle's own reason text, and the `checks-green`
conjunct now reads `"status": "failed"` with that exact reason. Both this
line and the oracle's `--verdict` output above were run three times each;
both were deterministic.

**Why `#927` does not appear as a disagreement in the 16/16 table above, and
what that means for reproducibility.** `zheref/bankai-core#927` IS one of the
16/16 table's rows (`Update 2`) — and it shows AGREEMENT there. That is not a
contradiction: `src/shadow/run.ts` enumerates OPEN pull requests live, at run
time, and this PR's own check rollup grew between that run (2026-09-01T18:50Z)
and the fact-check that found this bug — the CI matrix an actively-developed
PR accumulates is not fixed, and the 100-context cap this section fixes was
almost certainly not yet crossed at 18:50Z. By the time of THIS section's
re-run (below), `#927` had been CLOSED — `gh pr view 927 --repo
zheref/bankai-core --json state` now answers `"CLOSED"` — and so it does not
appear in the fresh candidate set at all. **An independent reader re-running
this file's harness today will get neither #927's row nor this exact N/N —
the live candidate set is a moving target by design (`gh pr list --state
open` at run time), and no run of this harness can promise another run the
same denominator.** The reproducible claim this file can actually stand
behind is PER-PR: run `nen pr ready <N> --gh-repo <repo> --gates <path>`
beside `REPO=<repo> scripts/pr_ready_gate.sh --verdict <N>` against any PR
BOTH sides can currently read, and the two verdicts and reason strings will
match — not "the next full sweep will find exactly N/N candidates," which
this file's own headline numbers (8/8, 12/12, 15/15, 16/16) have never been
able to promise across runs and should not be read as promising now.

**Fresh full-sweep re-run, after the fix — the pagination defect confirmed
closed, and the drift above observed directly:**

```
bun src/shadow/run.ts --oracle-repo <bankai-core checkout on main> --repo <this checkout>
```

- **Run:** 2026-09-01, oracle checkout at `bankai-core` `main`
  (`2269fe723e355dc69bf535ab40f22556e4fe4081`, working tree clean), `gh`
  authenticated as `zheref`.
- **Candidates: 15** — one FEWER than the 16/16 run above, not more: `#927`
  closed (discussed above) and `#930` merged between runs (`gh pr view 930
  --repo zheref/bankai-core --json state` now answers `"MERGED"`); `#932`
  opened as a new candidate. This is the drift the paragraph above names,
  observed in the same file rather than merely asserted.
- **Result:** `shadow window: 15/15 agree, 0 ready-ness disagreement(s), 0
  reason-text disagreement(s).`

| Repo | PR | Origin | Oracle | Nen | Ready agree | Reason agree |
|---|---|---|---|---|---|---|
| zheref/KroApple | #504 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/KroAndroid | #186 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #23 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #21 | open | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/nen | #14 | open | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | yes | yes |
| zheref/akatsuki-ai | #33 | open | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach (bankai-core#671). Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach. Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | yes | yes |
| zheref/bankai-core | #932 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #925 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #923 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #919 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #907 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #909 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #911 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #913 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #916 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |

Cells backtick-wrapped for markdown, exactly as the corrections above this
section describe; no cell's data was otherwise edited. Notably ABSENT: any
row showing a `checks-green`-truncation disagreement — because the fix closes
it.

**CORRECTION (zheref/nen#14's second fact-check, 2026-09-01) -- the sentence
that used to stand here overclaimed.** It named `#932`/`#925`/`#504` as
"each with its own multi-context rollup" proving the paginated path still
works on more than the one PR the bug was found on. Measured directly
(`gh api graphql`, the same `contexts(first:100)` shape this file's own
queries use), at the moment this correction was written: `zheref/KroApple
#504` had 42 contexts -- a SINGLE page, exercising no pagination at all --
and `zheref/bankai-core#932` had 73 -- also a single page. Neither is
evidence the multi-page WALK works; both are only evidence the ordinary
single-page path still works, which was never in question. Only `#925`
genuinely spans pages.

The stronger evidence this correction replaces it with, each figure verified
live and dated the same day:

- `zheref/bankai-core#925` -- 138 contexts, spans two pages
  (`hasNextPage:true` after the first, `totalCount:138`). This is the PR the
  disagreement above was found and re-verified on; its rollup reads
  `FAILURE` overall, which is the gate correctly staying strict on a real
  failing multi-page rollup, not new evidence on its own.
- `zheref/bankai-core#923` -- 118 contexts, spans two pages, page two
  confirmed ALL-GREEN (`SUCCESS`/`SKIPPED` only, no `FAILURE`) by direct
  query -- still `ready`.
- `zheref/KroAndroid#186` -- 134 contexts, spans two pages, page two
  likewise confirmed ALL-GREEN by direct query -- still `ready`.

`#923` and `#186` are the NO-FALSE-RED evidence this section actually needed
and did not have before: two PRs whose rollups genuinely exceed 100 contexts
and are genuinely all green stay `ready` after pagination, so the walk is not
merely catching real failures (`#925`, `#927`) -- it is also not making the
gate over-strict on rollups that were never broken. `#925` is the paginated
path proving it still reaches the oracle's real `not-ready` text on a
multi-page rollup; `#923` and `#186` are the paginated path proving it does
NOT invent a false `not-ready` on one. Both directions now have live,
verified, dated evidence, each carrying `hasNextPage:true` after 100
contexts -- confirmed by the same `gh api graphql` query this file's own
harness runs, not merely a `totalCount` read.

**This is exactly what the shadow window is for, and the record is stronger
for showing it worked.** The window did not miss this defect through some gap
in its method: this is the SECOND time the same per-PR comparison this file
automates has found a real disagreement on this exact query path (the
`Update` section above, on the same `statusCheckRollup` read — which EMPTY
rollups count as readable). This instance survived one full sweep (`Update
2`'s 16/16, `zheref/bankai-core#927` included and AGREEING there) only
because the live PR it lived on had not yet crossed the 100-context threshold
at that run's moment in time, and was caught the moment a fresh, targeted
comparison was run against that same PR again after its rollup grew. A tool
whose whole method is "compare against the oracle, live, repeatedly" is
expected to catch a bug that a live system only grows into, not to catch it
once and be done — that this file records the catch, the root cause, the
fix, and the re-verification in one place is the window doing its job, not
evidence against it.

## Update 4: the SECOND fact-check on the pagination fix — fail-open on an unreadable cursor closed, `reviewRequests` paginated, a dangling identifier fixed (2026-09-01)

An independent verification pass on `Update 3`'s own fix found that the
pagination walk it added was itself not exhaustive: `fullCheckRollup()`'s
loop condition was `hasNextPage === true`, which is true for exactly one
value. Every OTHER value that reached it — including `undefined` (a page
whose `contexts.nodes` parsed fine while its own `pageInfo.hasNextPage` did
not) and any other non-boolean GitHub might one day answer — fell through
the SAME test that a genuine `false` does, and silently ENDED THE WALK,
returning `ok:true` with whatever had been collected so far. That is the
identical false-green shape `Update 3` closed, one call earlier: a truncated
rollup presented as the whole one. Proven live, against the PRE-FIX code —
a historical observation, not a result an independent reader can re-derive
by running this probe at this HEAD, because the fix documented below is what
changed the answer: an independent probe against the then-exported
`fullCheckRollup()`, stubbed with `hasNextPage: undefined`, returned
`{"ok":true,"count":200}` where a well-formed `hasNextPage: false` control
returned the complete set. The identical probe run against this function
AFTER the fix below no longer returns that result — it returns `ok:false`
(unreadable-cursor) instead. `../github/graphql.ts`'s own comment on
`PullRequestSnapshot.checkRollupPageInfo` already stated the invariant this
enforces — "an unreadable `hasNextPage` must not become `false` and end the
walk early" — the code simply did not honor it yet: both the walk
(`pr_state.ts`'s loop) and the entry guard in `fetchPrState()` tested
`=== true`, the same gap in two places.

**Fix.** `false`, and ONLY the literal boolean `false`, now ends the walk —
in `fullCheckRollup()`'s loop, on every page, not only the first, and in
`fetchPrState()`'s two entry guards (`checkRollupPageInfo`, and
`reviewRequestsPageInfo` below), which now read `!== false` rather than
`=== true` and hand every other value to the walking function to fail
CLOSED there instead of reading it as "done" one call earlier. Pinned with
tests for both named shapes (`undefined`, and the non-boolean string
`"true"`), at both the walk level and the `fetchPrState()` entry-guard level,
for both the check-rollup connection and the review-requests connection
below. Mutation-proven: reverting the loop condition and the entry guards to
their old `=== true` form reproduces exactly this shape of failure — the new
tests fail red (`expected true to be false`) and no other test is affected;
restoring the fix turns them green again.

**`reviewRequests(first:100)` — the last unpaginated verdict input — is now
paginated too, closing `Update 3`'s own deferred item.** `Update 3` audited
this connection and left it unfixed, reasoning that "GitHub's platform-level
UI limits how many reviewers can be requested on a single PR, well under
100." That reasoning was itself asserted with no citation and no test — a
documentation search at this fact-check's time turned up no authoritative,
numbered source to pin it to — which is exactly the shape of claim the
`contexts` bug was found by not trusting. `reviewRequests` feeds
`pendingRounds()`'s limb (i) via `fetchPrState()`'s `requests` array, so a
dropped 101st+ requested reviewer is the identical false-green shape. Rather
than re-argue the safety case, `../github/graphql.ts` now selects
`pageInfo { hasNextPage endCursor }` on `reviewRequests` too and adds
`REVIEW_REQUESTS_PAGE_QUERY`; `../github/pr_state.ts`'s new
`fullReviewRequests()` walks it with the identical fail-closed discipline as
`fullCheckRollup()`, structurally the same function against a different
connection, including the same `false`-only walk-ending fix above. Pinned
with the same shape of tests as `fullCheckRollup()`'s own suite (cursor
walk, both unreadable-`hasNextPage` shapes, thrown fetch, unusable cursor,
unparseable `nodes`, page cap, page-one-alone short-circuit), plus the
`fetchPrState()` wiring and entry-guard tests, all mutation-proven the same
way. This closes the reasoning gap `Update 3`'s own audit table left open —
see that section's PAGINATION AUDIT bullet list, now updated in
`../github/graphql.ts` itself to record the correction.

**A re-audit's scope, stated precisely (corrected by zheref/nen#14's fifth
fact-check below — see "Update 5").** This update's re-audit found no other
capped collection feeding a verdict beyond the three `Update 3` already
enumerated (`labels(first:100)`, safe by construction — `isDeliveryPr()` only
ever reads it in an OR-disjunction, so truncation can only make the gate MORE
conservative; `reviewThreads` — already paginated; `reviews`/`timeline` —
already `octokit.paginate`d in full): `contexts` and `reviewRequests` were the
only two `first:N` GraphQL connections **the `nen pr ready` / `fetchPrState()`
path (`../github/graphql.ts`, `../github/pr_state.ts`) reads that a verdict
depends on**, and both are now paginated to completion with matching
fail-closed discipline. **That scope statement, as written at the time, did
NOT say "the `nen pr ready` path" — it read as repo-wide** ("no other capped
collection feeding a verdict"), and it was false at that wider scope: a
SECOND, independent CON-32-predicate composer exists at `../pr/fetch.ts` /
`../pr/blocker.ts` (the `nen pr next-blocker` verb, a different transport —
raw `gh api graphql` rather than octokit — reading a different `reviewThreads`
query than the one audited here), and its own `reviewThreads(first:100)` was
unpaginated at the time this section was written. See "Update 5" for the fix
and the corrected, actually repo-wide audit.

**A dangling identifier, fixed.** `Update 3`'s pagination fix renamed
`../github/graphql.ts`'s `headCommitRollupContexts()` to
`headCommitCheckRollupPage()` (the walk now needed `hasNextPage`/`endCursor`
threaded through, not just `nodes`, so the old name no longer described what
it returned). `../github/pr_state.ts`'s own header comment (line 61) still
cross-referenced the old name after the rename; this file's own "Update"
section (above) did too, in two places. All three fixed to the current name;
a repo-wide grep for the old name after the fix returns nothing under
`src/`.

**Re-run, fresh, after all of the above** — same oracle commit every prior
run in this file cites:

```
bun src/shadow/run.ts --oracle-repo <bankai-core checkout on main> --repo <this checkout>
```

- **Run:** 2026-09-01, oracle checkout at `bankai-core` `main`
  (`2269fe723e355dc69bf535ab40f22556e4fe4081`, working tree clean, the SAME
  commit `Update 3`'s own re-run used), `gh` authenticated as `zheref`.
- **Candidates: 17** — two MORE than `Update 3`'s 15/15, not fewer: two new
  `zheref/KroApple` pull requests (`#506`, `#507`) opened between runs, and
  `zheref/bankai-core#932` — `not-ready` in `Update 3`'s table — now reads
  `ready` on both sides, its rollup having gone green in the interval. This
  is the same candidate-set drift `Update 3` already named as expected by
  design (`gh pr list --state open` enumerated live, at run time), observed
  again here rather than merely asserted: no run of this harness has ever
  been able to promise the next run the same denominator, and this run does
  not either.
- **Result:** `shadow window: 17/17 agree, 0 ready-ness disagreement(s), 0
  reason-text disagreement(s).`

| Repo | PR | Origin | Oracle | Nen | Ready agree | Reason agree |
|---|---|---|---|---|---|---|
| zheref/KroApple | #507 | open | `ready` | `ready` | yes | yes |
| zheref/KroApple | #506 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/KroApple | #504 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/KroAndroid | #186 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #23 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-scaffold | #21 | open | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/nen | #14 | open | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | `not-ready: a configured reviewer's round is still owed at the current head (CON-32b): sasuke (no round at head);tenma (no round at head)` | yes | yes |
| zheref/akatsuki-ai | #33 | open | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach (bankai-core#671). Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | `not-ready: NO checks reported at head (CON-32a) — an EMPTY rollup, not a red one. Either CI has not started yet, or its run concluded startup_failure and no check will ever attach. Tell them apart with: gh run list --branch <head-branch> --limit 5 --json conclusion,path,headSha` | yes | yes |
| zheref/bankai-core | #932 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #925 | open | `not-ready: required checks reported but are not all green (CON-32a)` | `not-ready: required checks reported but are not all green (CON-32a)` | yes | yes |
| zheref/bankai-core | #923 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #919 | open | `ready` | `ready` | yes | yes |
| zheref/bankai-core | #907 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #909 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #911 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #913 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |
| zheref/bankai-core | #916 | closed (seeded, issue #2's Scope) | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | `not-ready: mergeable=UNKNOWN (expected MERGEABLE — CON-42/1's added predicate)` | yes | yes |

Cells backtick-wrapped for markdown, as every table in this file now states
plainly is done. `#925` (138 contexts, spans two pages, `not-ready`) and
`#923` (118 contexts, spans two pages, all green, `ready`) both agree here
too — the SAME two PRs the correction in `Update 3` above verifies directly
by contexts count and page count, agreeing again under the fresh sweep.

## Update 5: a fifth independent fact-check — the SAME false-green defect class in a second, separate verdict composer, plus three documentation-accuracy corrections this section's own text left undone in two prior updates (2026-09-01)

Eight items, all addressed.

**1. `../pr/blocker.ts` (the `nen pr next-blocker` verb, the drive skill's own
readiness composer) turned out to be a SECOND, independent place the
`contexts`/`reviewRequests` defect class lived, missed by every prior audit in
this file because every prior audit scoped itself to `../github/graphql.ts`'s
`PULL_REQUEST_QUERY` — the `nen pr ready` / `fetchPrState()` path — without
ever stating that scoping explicitly.** `../pr/blocker.ts` composes the same
`checksAllGreen`/`pendingRounds`/`defaultReviewers` CON-32 predicates
(`../gates/predicates.ts`) as `../gates/ready.ts` does, but over an entirely
different fetch: `../pr/fetch.ts`'s own `reviewThreads(first:100)` GraphQL
query, read via raw `gh api graphql` rather than octokit, with its own
`threadsTruncated` flag rather than a walked cursor. That flag was surfaced
only in the `unresolved-thread` branch's `detail` STRING, and only when page
one already had an unresolved thread — a PR whose first 100 threads are all
resolved but whose 101st+ thread is not fell straight through `nextBlocker()`
to the NEXT conjunct as though zero unresolved threads were a confirmed fact,
invisible in `--json` (whose `Blocker` shape carries no truncation field at
all). The exact same false-green shape `Update 3` and `Update 4` closed in
`../github/graphql.ts`'s `contexts` and `reviewRequests` connections, living
one file tree over, missed because "re-audited for any other capped
collection feeding a verdict: none found" in `Update 4` above was true only
of the path that update actually walked, and did not say so.

**2. Fixed the same way, in the sibling module.** `../pr/fetch.ts`'s
`REVIEW_THREADS_QUERY` now selects `endCursor` alongside `hasNextPage`, and a
new `REVIEW_THREADS_PAGE_QUERY` + `fetchAllReviewThreads()` walk every page to
completion — ONLY the literal boolean `false` for `hasNextPage` ends the walk,
mirroring `../github/pr_state.ts`'s `fullCheckRollup()`/`fullReviewRequests()`
discipline exactly. Every failure path — an unreadable `hasNextPage`, a
`nodes` that will not parse (via `../github/parse.ts`'s `parseReviewThreads`,
never read by hand), a page with no usable cursor, hitting the
50-page cap (`MAX_REVIEW_THREAD_PAGES`, matching `src/verbs/pr_ready.ts`'s own
`MAX_THREAD_PAGES` default) — throws `FetchError`, this module's own
pre-existing fail-closed contract (every other failure in `fetchPullRequest()`
already threw the same way; this fix brings review-thread pagination in line
with it rather than inventing a new failure shape). The now-meaningless
`threadsTruncated` field (pagination now either completes or throws, so it
would always read `false`) is removed from `PrSnapshot`, `../pr/blocker.ts`'s
`detail` string, and `../pr/command.ts`'s human-readable `nen pr fetch`
output, rather than left as a field that could no longer honestly carry
information.

**3. Tests, pinned and mutation-proved.** `../pr/fetch.test.ts` adds: a
page-one-clean/page-two-unresolved case (the exact false-green shape,
asserting both threads are returned); an unreadable-`hasNextPage`
(`undefined`) fail-closed case; a `hasNextPage:true`-with-no-cursor
fail-closed case; and a page-cap case (`maxReviewThreadPages` is now an
optional, test-injectable parameter on `fetchPullRequest()`, mirroring
`../github/pr_state.ts`'s own testable `maxRollupPages`). Mutation-proved
directly: reverting `fetchAllReviewThreads()`'s walk-ending test from
`page.hasNextPage === false` to `page.hasNextPage !== true` (the shape of the
`Update 4` bug, transplanted here) makes the unreadable-`hasNextPage` test
fail red (`expected function to throw an error, but it didn't`); restoring the
fix turns it green again with no other test affected. Net +3 tests (1305 →
1308): the old, now-inapplicable "flags a full review-thread page as
truncated" test is replaced by the four above.

**4. `../pr/fetch.ts`'s remaining unpaginated read, audited and left as a
named, deliberate gap rather than silently ignored.** `reviewsArgv()`'s REST
call (`per_page=100`, no `--paginate`) feeds `snapshot.reviews` into the same
`pendingRounds()` predicate `nextBlocker()` calls — a review round history
over 100 entries on one PR could in principle be truncated the identical way.
This is NOT fixed in this pass: the function's own existing comment already
documents the choice ("a review ROUND count over 100 on one PR is itself the
finding... `--paginate` output is line-delimited JSON pages rather than one
array, which this module's single-parse shape does not want to grow a second
code path for yet"), and unlike `contexts`/`reviewRequests`/`reviewThreads`,
hitting this cap is at least locally OBSERVABLE (`reviews.length === 100`)
rather than silently indistinguishable from "no more reviews." Recorded here
as a genuine residual gap, not swept under the "audited, safe" language the
`labels(first:100)` case earns structurally — this one is not safe by
construction, only unlikely and locally detectable, which is a materially
weaker claim.

**5. The complete, repo-wide audit, stated as such rather than scoped
silently.** Grepped for `first:100`, `first:`, `per_page=100`, `per_page:
100`, and `.paginate(` across all of `src/**/*.ts` (excluding tests). Every
site found: `../github/client.ts`'s `reviews`/`timeline` — already
`octokit.paginate`d in full; `../github/graphql.ts`'s `labels`,
`reviewRequests`, `contexts`, `reviewThreads` — all now paginated to
completion or (`labels`) safe by construction, per `Update 3`/`Update 4`
above; `../pr/fetch.ts`'s `reviewThreads` — fixed by this update (item 2);
`../pr/fetch.ts`'s `reviews` — audited, left as a named gap (item 4, above);
`../wake/command.ts`'s PR list, comments, and workflow-run reads
(`per_page=100`/`per_page=50`) — explicitly disclosed in that module's own
header as "under-scanned rather than mis-scanned" by design, and not a
readiness verdict at all (`nen wake` fires redrives and posts stall comments;
it never answers ready/not-ready), so out of scope for a "feeds a verdict"
audit on its own terms. **The corrected, true scope**: two independent
CON-32-predicate composers exist in this codebase — `../gates/ready.ts` (via
`../github/pr_state.ts`'s `fetchPrState()`) and `../pr/blocker.ts` (via
`../pr/fetch.ts`'s `fetchPullRequest()`) — and every capped collection either
composer reads that a verdict depends on is now either paginated to
completion with fail-closed discipline, safe by construction, or a named,
documented residual gap. No claim above generalizes past what this grep
actually found.

**6. `Update 3`'s own "Root cause" paragraph was still present-tense and
undated, even though `../github/pr_state.ts`, `../github/graphql.ts` and
`../verbs/pr_ready.test.ts` had already been corrected to the dated pair of
readings.** It read "`zheref/bankai-core#927`'s rollup HAS totalCount 114...
sits at position 101+" with no date and no mention of the 2026-09-01
re-observation (totalCount 139, position 131) those three other sites already
carried. Fixed in place above: the paragraph now states both dated readings,
matching the code comments word for word in substance.

**7. `../github/pr_state.ts`:279 and `../github/graphql.ts`:178 both point
readers at "`Update 3`'s section for both readings, dated" — a cross-reference
that did not resolve until item 6 above was fixed, because `Update 3` carried
only the first, undated reading.** Both citations are now accurate: `Update
3`'s "Root cause" paragraph carries both the 2026-08-31 and 2026-09-01
readings, dated. `../github/pr_state.test.ts`:126-128 carried the identical
present-tense, undated text as a THIRD site none of the previous two
enumeration passes caught (each enumerated from memory rather than grepping,
which is exactly how a site gets missed twice); fixed the same way. A repo-wide
grep for `114`, `101+`, `139`, and `\b101\b` across every `.ts` and `.md` file
was run to check for any other site (this file's own text above, and this
correction's, necessarily also match the grep by quoting these same figures —
a self-reference the grep does not distinguish from a live one, so each hit
was read by eye rather than trusted by count): every match resolves to one of
three categories, and none is a fourth, undated, present-tense live figure —
(a) the now-dated code comments (`../github/pr_state.ts` ×2, `../github/
graphql.ts`, `../verbs/pr_ready.test.ts`, `../github/pr_state.test.ts`), each
saying "when observed on" or "re-observed on"; (b) this file's own `Update 3`
paragraph (now dated, item 6 above) and this item's own prose, both of which
quote the figures BY NAME to describe the correction, which is what a
correction that quotes the wrong wording it replaces necessarily does; (c) two
GENERIC pattern descriptions naming no specific PR at all (`../github/
client.ts`'s and `../github/pr_state.ts`'s own "a single `first(100)` query
silently drops threads 101+" header prose, describing the shape of the bug
class, not `#927`'s own figure).

**8. The `{"ok":true,"count":200}` probe result, reworded as the historical
observation it is.** `../github/pr_state.ts`'s own comment, this file's
`Update 4` section above, and this PR's body all stated "Proven live: an
independent probe... returned `{"ok":true,"count":200}`" without saying that
result describes the PRE-FIX code — worded so plainly that a reader could try
to reproduce it by running the same probe against `fullCheckRollup()` at this
HEAD and get a different answer (`ok:false`, unreadable-cursor) with no
explanation why. Both this file's `Update 4` section and `../github/
pr_state.ts`'s own comment now say explicitly that the quoted result is
pre-fix, historical, and not re-derivable after the fix documented in the same
paragraph.

Local gate re-run clean after all of the above: `bun run typecheck && bun run
lint && bun run test` — 116 test files, **1308 tests** (up from 1305 — net
+3, item 3 above), all green. No test deleted or weakened.

## Rollback position, unchanged

Per zheref/nen#2's own rollback position: the shell gate (`scripts/pr_ready_gate.sh`) remains CON-32's sole
authority. This shadow window is evidence toward retiring that authority, not
a transfer of it — `nen pr ready` holds no readiness authority yet, and
nothing in `src/verbs/pr_ready.ts` writes to GitHub.
