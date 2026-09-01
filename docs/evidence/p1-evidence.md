# P1 evidence record (v0.1)

This page consolidates the two pieces of evidence zheref/nen's v0.1 exit
requires, both re-run and re-checked on the date below rather than
carried forward from an earlier claim. It supersedes nothing — the
shadow-window findings log this repeats lives in full, with its own
methodology and corrections, at
[`docs/evidence/shadow-window-p1.md`](./shadow-window-p1.md); this page adds
a fresh run of that comparison plus the corpus-slice replay evidence, in one
place, dated and reproducible.

> **Bar this repository's release issue sets, verbatim:** "Shadow window: on
> live bankai-core PRs, `nen pr ready` must equal `pr_ready_gate.sh
> --verdict` — every disagreement is a finding before Nen may become an
> authority. Local corpus slice replays green as regression tests."

Nen version at this run: `0.1.0-dev.1` (`nen --version`).

## 1. Shadow-window verdict equality

Re-run today against the same oracle checkout and the same candidate set
`docs/evidence/shadow-window-p1.md` used, to confirm the result still holds
rather than re-printing that file's own run:

```
bun src/shadow/run.ts --oracle-repo <bankai-core checkout on main> --repo <this checkout>
```

- **Run:** 2026-09-01T17:28Z (UTC)
- **Oracle checkout:** `zheref/bankai-core` @ `main`,
  `2269fe723e355dc69bf535ab40f22556e4fe4081` — the identical commit
  `shadow-window-p1.md`'s own run used; working tree clean.
- **`gh`:** authenticated as `zheref`.
- **Result:** `shadow window: 8/8 agree, 0 ready-ness disagreement(s), 0 reason-text disagreement(s).`

The per-candidate table is identical to the one already recorded in
`shadow-window-p1.md` — same 8 candidates (`zheref/KroAndroid#186`,
`zheref/bankai-scaffold#23`, `zheref/bankai-scaffold#21`, and bankai-core's
five named closed pull requests 907/909/911/913/916), same verdicts, same
reason text, `yes`/`yes` on every row for both ready-ness and reason-text
agreement. Re-running it now rather than re-quoting the table
`shadow-window-p1.md` already recorded is the point: this confirms the
equality still holds a few hours later the same day (about nine hours after
that file's own run), not only at the earlier moment it was written. See
that file for the full methodology,
the two corrections an independent review made to the comparison before this
result was trustworthy, the depth analysis of what each candidate actually
exercised, and the residual gap this repeat run inherits unchanged — none of
that changes on a re-run, so it is not repeated here.

**Not re-run: a fresh sweep for a live disagreement.** This confirms the
same 8 candidates still agree; it does not search for new open pull requests
that might disagree, beyond what `src/shadow/run.ts` itself enumerates live
from `gh pr list --repo <repo> --state open` at run time. Re-running the
command above after any of the seven watched repositories opens a new pull
request extends the comparison for free — nothing here needs to change to
pick that up.

**UPDATE, after this run:** a fresh sweep of exactly that kind (an
independent fact-check of this PR, enumerating live rather than reusing this
page's 8) found a genuine disagreement this 8-candidate run did not have open
pull requests to surface — a genuinely empty (not closed-PR-degenerate)
checks rollup, on `zheref/akatsuki-ai#33`. Root cause, fix, and a re-run
showing 12/12 agree (including that exact PR) are recorded in
`shadow-window-p1.md`'s own "Update: a real disagreement, found, fixed, and
re-verified" section, dated the same day as this page — not duplicated here,
per this page's own "referenced rather than duplicated" rule above.

## 2. Corpus-slice replay

Re-run immediately before writing this record:

```
$ nen dev replay
replayed 10 fixture(s): 10 passed, 0 failed
```

- **Run:** 2026-09-01T17:36Z (UTC)
- **Exit code:** 0
- **Fixture source:** `tests/fixtures/dualrun-slice/` — the local-relevant
  slice of `zheref/bankai-core`'s `tests/fixtures/dualrun/` corpus at tag
  `v0.11.3` (`23d53c84a1e5d2f75ceb266f51c387c51ef128cb`), imported per
  `tests/fixtures/dualrun-slice/MANIFEST.json`.
- **Coverage:** 10 of the `dedupe_handbook_questions.sh` category's 20
  fixtures are included (the other 10 pin shell-specific mechanics —
  raw-TSV field splitting, subprocess stdout/stderr interleaving, close/comment
  control flow — that `nen`'s pure `findCanonical`/`normalizeTitle` decision
  logic has no equivalent code path for; see the manifest for the
  fixture-by-fixture reason). No other script category from the source
  corpus (~45 others: `pr_ready_gate.sh`, `sync-labels.sh`,
  `colors_schema_check.sh`, the changelog scripts, the CI/runner-probe
  scripts, the worktree-session guards, ...) has been surveyed for import
  yet — a named gap, not a claim of completeness.
- **Result:** every included fixture's recorded verdict agrees with `nen`'s
  own `findCanonical` over the same recorded candidate list. Zero
  disagreements, zero fixtures skipped, exit 0.

`--json` gives the same result machine-readably:

```
$ nen dev replay --json
{
  "total": 10,
  "passed": [
    "a-newer-twin-is-never-canonical",
    "a-newest-first-listing-still-picks-the-lowest",
    "a-punctuation-only-title-is-always-canonical",
    "canonical-no-older-open-duplicate",
    "distinct-gaps-never-cross-match",
    "empty-open-set-is-canonical",
    "lowest-of-several-older-matches-wins",
    "non-ascii-uppercase-survives-the-lowercaser",
    "older-exact-title-closes-the-new-issue",
    "punctuation-and-case-collapse-to-one-canonical"
  ],
  "failed": [],
  "error": null
}
```

## What this record does and does not claim

- **Reproducible today, both halves.** Every number above came from a
  command run while writing this page (timestamps included), not carried
  forward from an earlier PR's claim.
- **The shadow window's depth is bounded by what was open to look at.** As
  `shadow-window-p1.md` already states and this run does not change: the
  five closed bankai-core candidates only exercise the readiness gate's
  first conjunct (a closed PR's `mergeable` field is always `UNKNOWN`); the
  full six-conjunct depth is proven only by the two open candidates outside
  bankai-core. Closing that gap for bankai-core specifically needs a genuine
  open pull request there at run time, which this run did not have either.
- **The replay's coverage is one script category, partially.** 10 of 20
  fixtures in the one category imported so far; the other ~45 categories in
  the source corpus are unsurveyed. This is stated as a gap in
  `MANIFEST.json` itself and repeated here rather than smoothed over.
- **The three known gate-correctness bugs are inherited, not tested here.**
  Per the sequencing rule both pieces of evidence above were gathered under:
  parity is proven with today's behavior, bugs included, and the three named
  bugs land as their own later, flagged, reviewed changes — not as part of
  this evidence.
