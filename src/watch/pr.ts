// src/watch/pr.ts -- `nen watch until --pr <ref> --until <predicate>`: the
// native pull-request wake conditions (zheref/nen#264).
//
// WHY THIS IS NATIVE AND NOT A --command. The wait an orchestrating flow most
// often needs before Ready -- "CI has settled AND (a review round has posted at
// head OR the pull request is ready)" -- is a boolean composition of two
// independently-polled facts, and `--command` takes ONE command and ONE
// pattern. A caller that needed both fell back to a hand-rolled `for` + `sleep`
// loop over `gh pr checks` and `gh api .../reviews` (zheref/kro-pwa#97), which
// is the improvised substitute for a deterministic verb nen exists to retire.
//
// THE SAME READ `nen pr ready` MAKES. Every observation is one call of
// ../verbs/pr_ready.ts's `readReady` -- the transport, the identity resolution,
// the exclusions and the gate are all its -- and every predicate below is read
// off that ONE result: the verdict, and the evaluation's `settlement` facts
// (../gates/ready.ts), which come from the evaluation's own parse of the same
// snapshot. So `--until ready` wakes exactly when `nen pr ready` would answer
// `ready` for the same flags, and a watch and a readiness read asked of one
// snapshot can never disagree.
//
// WHAT AN OBSERVATION ERROR IS HERE. A read that could not see -- an
// `unevaluated` verdict (no token, GitHub unreachable), a rollup or a reviews
// array the predicate needs that could not be parsed (for `ready`, either one
// on a not-ready read), a `--require-head` that does not match
// GitHub's head -- is an ERROR, counted toward the three-error streak, never a
// "not yet": absence is never a pass, and a watch that cannot see is not
// watching. A USAGE refusal (a malformed ref, a missing identity source) is
// deterministic and would refuse on every poll, so it aborts the watch at
// exit 2 on the first observation instead of being polled three times.
//
// A WAKE IS NOT A GO. Only `ready` -- the gate's own verdict -- is a merge
// signal; the other three tell the caller to look again, and the caller asks
// `nen pr ready` before calling anything ready (F5 on zheref/nen#264).
//
// SCOPE, BY THE MAINTAINER'S RULING OF 2026-10-03. This file widens what a
// watch can wake ON; it does nothing about what happens after. The issue's
// second criterion -- that a later `nen stop` fire every notification rung --
// was dropped: rungs 2-3 stay the host's, and `nen stop` does not ring them.

import { VerbUsageError } from "../cli/command.js";
import type { RoundAtHead } from "../gates/predicates.js";
import type { ReadyRead } from "../verbs/pr_ready.js";
import type { WatchObservation } from "./until.js";

/** The closed set `--until` takes. */
export const PR_PREDICATES = ["checks-settled", "review-posted", "ready", "settled-and-reviewed"] as const;
export type PrPredicate = (typeof PR_PREDICATES)[number];

export function parsePrPredicate(text: string | undefined): PrPredicate {
  if (text === undefined || text === "") {
    throw new VerbUsageError(`--pr needs --until <${PR_PREDICATES.join("|")}>.`);
  }
  const found = PR_PREDICATES.find((name): boolean => name === text);
  if (found === undefined) {
    throw new VerbUsageError(`--until must be one of ${PR_PREDICATES.join(", ")} (got '${text}').`);
  }
  return found;
}

/**
 * Decide one observation from one `readReady` result. Pure: no read, no
 * clock. Throws VerbUsageError on a usage refusal (exit 2, see the header).
 */
export function observePr(read: ReadyRead, predicate: PrPredicate): WatchObservation {
  if (read.kind === "usage") throw new VerbUsageError(read.message);
  if (read.kind === "head-mismatch") {
    return { errored: true, conditionTrue: false, message: `observation failed: ${read.report.message}` };
  }
  const { report, settlement } = read;
  if (report.verdict === "unevaluated" || settlement === null) {
    return { errored: true, conditionTrue: false, message: `observation failed: ${report.gateLine}` };
  }

  const ready = report.verdict === "ready";
  const checks = settlement.checksSettled;
  const rounds = settlement.roundsAtHead;
  const reviewPosted = rounds !== null && rounds.length > 0;

  // Which unreadable fact this predicate actually needs. `ready` needs no fact beside the verdict when the verdict IS ready; on a
  // not-ready read with either fact unreadable it is as blind as the others
  // (N2 on zheref/nen#264), so it counts toward the streak.
  const blind: string | null =
    predicate === "ready"
      ? !ready && checks === null
        ? "the check rollup could not be read"
        : !ready && rounds === null
          ? "the reviewer rounds at head could not be read"
          : null
      : (predicate === "checks-settled" || predicate === "settled-and-reviewed") && checks === null
        ? "the check rollup could not be read"
        : predicate === "review-posted" && rounds === null
          ? "the reviewer rounds at head could not be read"
          : predicate === "settled-and-reviewed" && rounds === null && !ready
            ? "the reviewer rounds at head could not be read"
            : null;

  const facts = describeFacts(report.verdict, report.gateLine, report.judgedHead, checks, settlement.pendingChecks, rounds);
  if (blind !== null) {
    return { errored: true, conditionTrue: false, message: `observation failed: ${blind} -- ${facts}` };
  }

  const conditionTrue =
    predicate === "checks-settled"
      ? checks === true
      : predicate === "review-posted"
        ? reviewPosted
        : predicate === "ready"
          ? ready
          : checks === true && (reviewPosted || ready);
  return {
    errored: false,
    conditionTrue,
    message: `${predicate} is ${conditionTrue ? "true" : "not yet true"} -- ${facts}`,
  };
}

function describeFacts(
  verdict: string,
  gateLine: string,
  judgedHead: string | null,
  checks: boolean | null,
  pending: readonly string[],
  rounds: readonly RoundAtHead[] | null,
): string {
  const head = judgedHead === null ? "(unread)" : judgedHead.slice(0, 7);
  const checkText =
    checks === null
      ? "checks unreadable"
      : checks
        ? "checks settled"
        : pending.length === 0
          ? "no checks reported"
          : `${pending.length} check(s) pending (${pending.join(", ")})`;
  const reviewText =
    rounds === null
      ? "reviewer rounds unreadable"
      : rounds.length === 0
        ? "no configured reviewer's round at head"
        : `round at head by ${rounds.map((round): string => `${round.reviewer} (${round.via})`).join(", ")}`;
  const verdictText = verdict === "ready" ? "ready" : gateLine;
  return `head ${head}: ${checkText}; ${reviewText}; verdict ${verdictText}`;
}
