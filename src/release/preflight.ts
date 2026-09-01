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

export interface PreflightInputs {
  /** The RELEASE_HOLD variable's value, or null when unset/empty. */
  readonly holdValue: string | null;
  readonly openCriticalIssueNumbers: readonly number[];
  readonly liveChores: readonly LiveChoreCandidate[];
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
  const liveChores = evaluateLiveChores(inputs.liveChores);
  const liveNames = liveChores.filter((chore): boolean => chore.live).map((chore): string => chore.name);

  const checks: PreflightCheck[] = [
    {
      name: "RELEASE_HOLD",
      ok: inputs.holdValue === null || inputs.holdValue.trim() === "",
      detail:
        inputs.holdValue === null || inputs.holdValue.trim() === ""
          ? "not set"
          : `HELD: RELEASE_HOLD = '${inputs.holdValue}'`,
    },
    {
      name: "open critical issues",
      ok: inputs.openCriticalIssueNumbers.length === 0,
      detail:
        inputs.openCriticalIssueNumbers.length === 0
          ? "none open"
          : `${inputs.openCriticalIssueNumbers.length} open: ${inputs.openCriticalIssueNumbers.map((n): string => `#${n}`).join(", ")}`,
    },
    {
      name: "CON-36 live chores",
      ok: liveNames.length === 0,
      detail:
        liveNames.length === 0
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
