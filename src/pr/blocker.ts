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
  roundQuorum,
  type RoundPolicy,
} from "../gates/predicates.js";
import { describeQuorum } from "../gates/ready.js";
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
  // ONE input set for both CON-32(b) questions, so they are asked of the
  // same evidence. It carries NO `earlierChecks`, deliberately: the snapshot
  // this module is handed (./fetch.ts, a `gh pr view` read) holds the head's
  // rollup and nothing earlier, and reading history here would be a second,
  // gh-side copy of ../github/pr_state.ts's bounded earlier-head walk. So this
  // module reads the HEAD ONLY -- under `bounded` it can call a round OWED
  // that `nen pr ready` counts through a run on an earlier commit, i.e. it is
  // STRICTER than `pr ready` there, never looser, which is the safe side for a
  // "what blocks this next" answer -- and the quorum clause below says so
  // wherever that can be the difference.
  const roundInputs = {
    reviewRequests: snapshot.reviewRequests,
    checks: snapshot.checks,
    reviews: snapshot.reviews,
  };
  const policy = options.policy ?? "bounded";
  const deliveryPr = options.deliveryPr ?? false;
  const owed = pendingRounds(
    identities,
    roundInputs,
    snapshot.pr.headSha,
    reviewers,
    policy,
    deliveryPr,
  );
  // `round_quorum` (maintainer ruling 2026-09-29; Nobunaga's review of E7,
  // finding H2): the file's floor on how many of a group HAVE a round. Asked
  // AFTER pendingRounds and of the same inputs, and it only ever ADDS: before
  // it was asked here, this repository's own gates.json (copilot exempt,
  // bugbot enrolled only by its check) let an unreviewed pull request answer
  // `none` while `nen pr ready` refused it on the quorum. `null` when the file
  // declares none, and then nothing below changes.
  const quorum = roundQuorum(identities, roundInputs, snapshot.pr.headSha, policy, deliveryPr);
  // HEAD ONLY, AND SAID SO (Nobunaga's delta review of E7, finding F2). Under
  // `bounded`, `nen pr ready` also counts a round-check member's SUCCESS run
  // on an EARLIER commit of this pull request -- Cursor Bugbot runs once per
  // pull request, so that is the common shape (zheref/nen#279: ready through
  // 2851d2e, while this verb said "no 'Cursor Bugbot' check"). This verb's
  // snapshot carries the head only: its caller (./command.ts) hands
  // ./fetch.ts no identities and no policy, so the fetch cannot know which
  // patterns to seek, and reading every earlier commit's runs on every call
  // would cost up to 21 `gh` calls where the head usually settles it. So
  // where the two verbs CAN differ -- the quorum is unmet and a round-check
  // member has no SUCCESS and nothing in flight at head -- the clause says
  // that this answer is the head's, and where to get the fuller one. It
  // changes no verdict: this verb stays STRICTER than `pr ready`, never
  // looser.
  const headOnly =
    quorum !== null &&
    !quorum.met &&
    policy === "bounded" &&
    quorum.members.some(
      (member): boolean =>
        member.round === null &&
        member.roundCheck !== null &&
        (member.roundCheck.state === "absent" ||
          member.roundCheck.state === "skipped" ||
          member.roundCheck.state === "unsuccessful"),
    );
  const quorumClause =
    quorum !== null && !quorum.met
      ? describeQuorum(quorum) +
        (headOnly ? " (head only — `nen pr ready` also reads earlier commits of this PR)" : "")
      : null;
  if (owed.length > 0) {
    const detail = owed.map((round): string => `${round.reviewer} (${round.reason})`).join(", ");
    return {
      kind: "owed-round",
      detail: quorumClause === null ? detail : `${detail} — and ${quorumClause}`,
    };
  }
  if (quorumClause !== null) {
    return { kind: "owed-round", detail: quorumClause };
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
