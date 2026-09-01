// src/pr/blocker.ts -- the first blocking condition, in the drive skill's own
// fixed order, and nothing past it.
//
// THE ORDER IS THE WHOLE POINT (the drive skill, §3): conflict -> red required
// check -> owed reviewer round -> unaddressed thread -> missing body
// requirement. Fixing the fourth thing while the branch is conflicted wastes a
// cycle, because the conflict re-invalidates the checks anyway -- so this
// module returns the FIRST one that applies and stops, never a list.
//
// THE READINESS PREDICATES THEMSELVES ARE NOT REDERIVED HERE. ../gates/predicates.ts
// is the ported, tested CON-32 engine (BC-IS-#736/#733 Phase 1) and this module
// is its first real caller: it composes checksAllGreen, pendingRounds and
// defaultReviewers over one fetched PrSnapshot rather than re-deciding what
// "green" or "owed" means.
//
// A SIMPLIFICATION, NAMED RATHER THAN HIDDEN: CON-33(a)'s changelog.d/ fragment
// requirement is diff-shaped -- whether one is required depends on what the PR
// touches, which this verb does not fetch (a diff is a fourth gh call this
// module does not make). The body check here covers only CON-17's `## How to
// verify` heading; a caller that needs the changelog obligation enforced too
// must still read the diff by eye. See src/pr/verb.ts's usage text.

import {
  checksAllGreen,
  defaultReviewers,
  latestChecks,
  pendingRounds,
  type RoundPolicy,
} from "../gates/predicates.js";
import { rollupEntryLabel, rollupEntryStatus } from "../github/types.js";
import type { GateIdentities } from "../schema/gates.js";
import type { PrSnapshot } from "./fetch.js";

export type BlockerKind =
  | "conflict"
  | "red-check"
  | "owed-round"
  | "unresolved-thread"
  | "missing-body-requirement"
  | "none";

export interface Blocker {
  readonly kind: BlockerKind;
  readonly detail: string;
}

export interface NextBlockerOptions {
  /** Overrides the check-enrolment-derived reviewer set. */
  readonly reviewers?: readonly string[] | undefined;
  readonly policy?: RoundPolicy | undefined;
  readonly deliveryPr?: boolean | undefined;
}

const HOW_TO_VERIFY = /^##\s*How to verify\b/im;

export function nextBlocker(
  identities: GateIdentities,
  snapshot: PrSnapshot,
  options: NextBlockerOptions = {},
): Blocker {
  if (snapshot.pr.mergeable === "CONFLICTING" || snapshot.mergeStateStatus === "DIRTY") {
    return {
      kind: "conflict",
      detail: `mergeable=${snapshot.pr.mergeable} mergeStateStatus=${snapshot.mergeStateStatus} -- cascade main in before anything else; a conflicted PR gets no checks at all, which reads as clean rather than broken`,
    };
  }

  if (!checksAllGreen(snapshot.checks)) {
    const latest = latestChecks(snapshot.checks);
    const summary = latest
      .map((entry): string => `${rollupEntryLabel(entry) ?? "(unnamed)"}=${rollupEntryStatus(entry) ?? "pending"}`)
      .join(", ");
    return {
      kind: "red-check",
      detail: latest.length === 0 ? "no checks have reported yet" : `not every latest check is green: ${summary}`,
    };
  }

  // Belt and braces alongside src/pr/verb.ts's own guard: an explicitly
  // empty reviewer list is treated the same as an omitted one, never as "no
  // reviewers are owed a round" -- an empty array here would silently retire
  // the owed-reviewer-round conjunct entirely.
  const reviewers =
    options.reviewers === undefined || options.reviewers.length === 0
      ? defaultReviewers(identities, snapshot.checks)
      : options.reviewers;
  const owed = pendingRounds(
    identities,
    { reviewRequests: snapshot.reviewRequests, checks: snapshot.checks, reviews: snapshot.reviews },
    snapshot.pr.headSha,
    reviewers,
    options.policy ?? "bounded",
    options.deliveryPr ?? false,
  );
  if (owed.length > 0) {
    return {
      kind: "owed-round",
      detail: owed.map((round): string => `${round.reviewer} (${round.reason})`).join(", "),
    };
  }

  // snapshot.reviewThreads is now a full, paginated read (../pr/fetch.ts's
  // fetchAllReviewThreads, zheref/nen#14's fact-check) -- a caveat about a
  // partial page used to belong here and no longer does, because a fetch
  // that could not confirm it read every thread throws before nextBlocker()
  // is ever called, rather than reaching this branch with an incomplete list.
  const unresolved = snapshot.reviewThreads.filter((thread): boolean => !thread.isResolved);
  if (unresolved.length > 0) {
    return {
      kind: "unresolved-thread",
      detail: `${unresolved.length} unresolved thread(s)`,
    };
  }

  if (!HOW_TO_VERIFY.test(snapshot.body)) {
    return {
      kind: "missing-body-requirement",
      detail: "no '## How to verify' section in the body (CON-17)",
    };
  }

  return { kind: "none", detail: "no blocker found by this check -- the confirmation pass is still human" };
}
