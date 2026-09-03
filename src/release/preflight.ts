// src/release/preflight.ts -- the release preflight table, ported from
// getsuga SKILL.md §2 ("Preconditions -- all of them, before a single
// write"): "Run every check and report the whole table, not the first
// failure. A release blocked by three things and reported one at a time is
// three round-trips."
//
// THE SIX PRECONDITIONS, each cited from getsuga §2:
//
//   RELEASE_HOLD              `gh variable get RELEASE_HOLD` -- honour it,
//                              stop and say who set it.
//   Open critical issues       any open issue at the repository's own
//                              critical-severity label -- stop; a release
//                              shipping past an open critical is the failure
//                              the severity exists to name.
//   CON-36 live chores          the THREE-PART test -- chore issue open AND
//                              integration/<chore> exists AND (an open PR
//                              targets it OR its -> main PR is open) -- hold
//                              unless none has partial scope on main.
//   changelog.d/ empty          at the CUT POINT.
//   CON-33(c) reconciled        every PR merged in <vPrev>..<cut-point> has a
//                              CHANGELOG entry or fragment.
//   Tag does not already exist  re-tagging is never the fix.
//
// EVERY CHECK RUNS, ALWAYS. This module never short-circuits on the first
// failed precondition -- the caller (../release/command.ts) gathers every
// input up front and hands all six here at once, and the report names every
// failure in one pass.
//
// THREE STATES, NOT TWO, FOR RELEASE_HOLD AND FOR EACH CALLER-SUPPLIED FACT
// (review finding). `gh variable get` failing (not installed, unauthenticated,
// no variable-read scope) is NOT the same as a repository that genuinely has
// no hold set, and omitting `--critical-issues`/`--live-chores-from` is NOT
// the same as asserting there are none of either -- so `HoldState` and
// `Supplied<T>` below make "checked and clear" and "never checked"
// distinguishable types rather than two situations that both produced an
// empty value.
//
// THE LIVE-CHORE THREE-PART TEST IS DATA IN, VERDICT OUT: whether a given
// chore has an open issue, an existing integration branch, and an open PR
// targeting either the branch or main is gathered by the caller (three
// separate git/gh facts per chore) and handed in already computed -- this
// module applies getsuga §2's AND across the three, per chore, and reports
// which chores are LIVE (hold) versus which have no partial scope on main
// (the G5 judgement getsuga §5 says is never this tool's call to make alone).

export interface LiveChoreCandidate {
  readonly name: string;
  readonly issueOpen: boolean;
  readonly integrationBranchExists: boolean;
  readonly openPrTargetsIntegrationOrMain: boolean;
}

export interface LiveChoreResult extends LiveChoreCandidate {
  /** The three-part AND: issue open AND branch exists AND an open PR targets it or main. */
  readonly live: boolean;
}

export function evaluateLiveChores(candidates: readonly LiveChoreCandidate[]): LiveChoreResult[] {
  return candidates.map((chore): LiveChoreResult => ({
    ...chore,
    live: chore.issueOpen && chore.integrationBranchExists && chore.openPrTargetsIntegrationOrMain,
  }));
}

/**
 * The RELEASE_HOLD row's FOUR states -- not two. `gh variable get` failing
 * open into "not set" (review finding, BLOCKER-adjacent: a `gh` that is not
 * installed, unauthenticated, or scoped without variable-read access must
 * never read the same as a repository that genuinely has no hold set) is
 * exactly what this type exists to make impossible to construct by accident.
 *
 * `clear` is the fourth state (zheref/nen#23): the variable EXISTS but its
 * value parses as an explicit "not held" (`false`/`0`/`no`, case-insensitive).
 * It is deliberately distinct from `unset` so the row can tell the operator
 * the variable is still sitting there -- deleting it outright is the tidier
 * repository state -- while still passing the check, matching the shell
 * `hold_active()` convention this row replaced.
 *
 * `held.recognizedTruthy` records WHY the hold read as active: `true` for the
 * shared boolean vocabulary (`true`/`1`/`yes`, case-insensitive), `false` for
 * any other non-empty value ("freeze until Monday"), which fails CLOSED --
 * see resolveHoldState in ./command.ts for why that deviates from the pure
 * shell convention -- so the row can explain the fail-closed reading instead
 * of leaving the operator to guess why a non-boolean string blocked the cut.
 */
export type HoldState =
  | { readonly kind: "unset" }
  | { readonly kind: "clear"; readonly value: string }
  | { readonly kind: "held"; readonly value: string; readonly recognizedTruthy: boolean }
  | { readonly kind: "unreadable"; readonly detail: string };

/**
 * A caller-supplied fact that was never given, versus one the caller
 * explicitly gave as empty. `null` means "the flag was omitted" -- distinct
 * from `[]`, which means "the flag was given and the answer is empty" (review
 * finding: omitting `--critical-issues`/`--live-chores-from` must not read the
 * same as asserting there are none).
 */
export type Supplied<T> = readonly T[] | null;

export interface PreflightInputs {
  readonly hold: HoldState;
  readonly openCriticalIssueNumbers: Supplied<number>;
  readonly liveChores: Supplied<LiveChoreCandidate>;
  readonly fragmentFilesAtCutPoint: readonly string[];
  readonly missingChangelogPrs: readonly number[];
  readonly tagAlreadyExists: boolean;
  readonly tag: string;
}

export interface PreflightCheck {
  readonly name: string;
  readonly ok: boolean;
  readonly detail: string;
}

export interface PreflightReport {
  readonly checks: readonly PreflightCheck[];
  readonly liveChores: readonly LiveChoreResult[];
  readonly ok: boolean;
}

export function runPreflight(inputs: PreflightInputs): PreflightReport {
  const liveChores = inputs.liveChores === null ? [] : evaluateLiveChores(inputs.liveChores);
  const liveNames = liveChores.filter((chore): boolean => chore.live).map((chore): string => chore.name);

  const checks: PreflightCheck[] = [
    {
      name: "RELEASE_HOLD",
      ok: inputs.hold.kind === "unset" || inputs.hold.kind === "clear",
      detail:
        inputs.hold.kind === "unset"
          ? "not set"
          : inputs.hold.kind === "clear"
            // Passing, but NOT silent about the leftover variable
            // (zheref/nen#23): an explicit falsy value releases the hold, and
            // the operator still deserves to see that the variable itself is
            // lingering -- deleting it is the state every other tool reads
            // unambiguously.
            ? `not held: RELEASE_HOLD = '${inputs.hold.value}' reads as falsy (deleting the variable outright is tidier)`
            : inputs.hold.kind === "held"
              ? inputs.hold.recognizedTruthy
                ? `HELD: RELEASE_HOLD = '${inputs.hold.value}'`
                // The raw value is printed so the operator sees exactly WHY a
                // non-boolean string blocked the cut, and what releases it --
                // without this, "freeze until Monday" reading as HELD looks
                // like a parser bug rather than the fail-closed choice it is.
                : `HELD: RELEASE_HOLD = '${inputs.hold.value}' -- not a recognized boolean, so it fails closed as an active hold (set it to 'false' or delete the variable to release)`
              // A `gh` that could not be reached, is unauthenticated, or lacks
              // variable-read scope is NOT the same as a repository that
              // genuinely has no hold -- collapsing them (review finding) made
              // the single most safety-critical row of this table assert
              // "not set" for a check that never actually ran.
              : `could not be read: ${inputs.hold.detail}`,
    },
    {
      name: "open critical issues",
      ok: inputs.openCriticalIssueNumbers !== null && inputs.openCriticalIssueNumbers.length === 0,
      detail:
        inputs.openCriticalIssueNumbers === null
          ? "not supplied -- not checked (pass --critical-issues, or --critical-issues '' to assert none)"
          : inputs.openCriticalIssueNumbers.length === 0
            ? "none open"
            : `${inputs.openCriticalIssueNumbers.length} open: ${inputs.openCriticalIssueNumbers.map((n): string => `#${n}`).join(", ")}`,
    },
    {
      name: "CON-36 live chores",
      ok: inputs.liveChores !== null && liveNames.length === 0,
      detail:
        inputs.liveChores === null
          ? "not supplied -- not checked (pass --live-chores-from, or a file containing '[]' to assert none)"
          : liveNames.length === 0
            ? "none live (issue open AND branch exists AND an open PR targets it or main)"
            : `LIVE: ${liveNames.join(", ")} -- whether this blocks the cut is a G5 judgement, not decided here`,
    },
    {
      name: "changelog.d/ empty at cut point",
      ok: inputs.fragmentFilesAtCutPoint.length === 0,
      detail:
        inputs.fragmentFilesAtCutPoint.length === 0
          ? "empty"
          : `${inputs.fragmentFilesAtCutPoint.length} fragment(s) uncollated: ${inputs.fragmentFilesAtCutPoint.join(", ")}`,
    },
    {
      name: "CON-33(c) reconciled",
      ok: inputs.missingChangelogPrs.length === 0,
      detail:
        inputs.missingChangelogPrs.length === 0
          ? "every merged PR has a CHANGELOG entry or fragment"
          : `missing: ${inputs.missingChangelogPrs.map((n): string => `#${n}`).join(", ")}`,
    },
    {
      name: "tag does not already exist",
      ok: !inputs.tagAlreadyExists,
      detail: inputs.tagAlreadyExists ? `'${inputs.tag}' already exists -- re-tagging is never the fix` : "clear",
    },
  ];

  return { checks, liveChores, ok: checks.every((check): boolean => check.ok) };
}
