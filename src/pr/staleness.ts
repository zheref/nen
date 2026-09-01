// src/pr/staleness.ts -- the staleness arithmetic behind `nen pr staleness`.
//
// PORTED FROM the shared rule cited across five skills: a pull request is
// STALE when it has accumulated >=2 VERIFIED no-commit wakes -- a wake fired,
// and ../wake/detect.ts's own verification confirmed no commit followed it --
// AND has been idle >=60 minutes. Staleness is what permits the one merge a
// non-human actor is allowed to make under this repository's rules: an
// otherwise-stuck PR that is Ready (CON-32) and has proven, twice, that
// waking its author produces no further work.
//
// PURE ARITHMETIC OVER FETCHED EVENTS, deliberately. Nothing here fetches a
// wake history or a PR's readiness -- both are the caller's, over
// ../wake/command.ts and (once it lands, sibling issue #2) `nen pr ready`.
// This module answers exactly one question given the two facts every skill
// citing it needs answered: is this PR stale, and -- ready plus stale -- is
// this the one case that may merge without a human.

export interface VerifiedWake {
  /** ISO-8601, when this wake was verified. */
  readonly at: string;
  /** True iff the verification confirmed NO commit followed the wake. */
  readonly noCommit: boolean;
}

export interface StalenessInput {
  readonly wakes: readonly VerifiedWake[];
  /** ISO-8601 of the pull request's last activity (a commit, a comment, a push). */
  readonly lastActivityAt: string;
  /** ISO-8601, the instant this check reasons about. Never the live clock. */
  readonly now: string;
  /** True iff the pull request is independently known to be CON-32 Ready. */
  readonly ready: boolean;
  readonly minVerifiedWakes?: number;
  readonly idleMinutes?: number;
}

export interface StalenessResult {
  readonly verifiedNoCommitWakes: number;
  readonly idleMinutes: number;
  readonly stale: boolean;
  /** True only when stale AND ready -- the one case a merge is permitted. */
  readonly mergePermitted: boolean;
  readonly reasons: readonly string[];
}

const DEFAULT_MIN_VERIFIED_WAKES = 2;
const DEFAULT_IDLE_MINUTES = 60;

export function computeStaleness(input: StalenessInput): StalenessResult {
  const minWakes = input.minVerifiedWakes ?? DEFAULT_MIN_VERIFIED_WAKES;
  const idleThreshold = input.idleMinutes ?? DEFAULT_IDLE_MINUTES;

  const verifiedNoCommitWakes = input.wakes.filter((wake): boolean => wake.noCommit).length;
  const idleMs = Date.parse(input.now) - Date.parse(input.lastActivityAt);
  const idleMinutes = Math.max(0, Math.floor(idleMs / 60_000));

  const wakesReasonMet = verifiedNoCommitWakes >= minWakes;
  const idleReasonMet = idleMinutes >= idleThreshold;
  const stale = wakesReasonMet && idleReasonMet;

  const reasons: string[] = [
    `${verifiedNoCommitWakes}/${minWakes} verified no-commit wake(s)${wakesReasonMet ? " (met)" : ""}`,
    `${idleMinutes}/${idleThreshold} idle minute(s)${idleReasonMet ? " (met)" : ""}`,
  ];
  if (stale && !input.ready) {
    reasons.push("stale, but NOT Ready -- no merge is permitted; a stale, not-ready PR is still owned by its author");
  }

  return {
    verifiedNoCommitWakes,
    idleMinutes,
    stale,
    mergePermitted: stale && input.ready,
    reasons,
  };
}
