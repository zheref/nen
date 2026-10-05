// src/gates/round_counts.ts -- each reviewer's review rounds, counted against
// `nen/gates.json`'s `round_policy.minRounds` and `.maxRounds`
// (zheref/nen#240), for `nen pr ready --explain` and `--json`'s
// `meta.roundCounts`.
//
// WHY IT EXISTS. On zheref/KroApple#577 an agent requested Copilot eight times
// under a two-round ruling: every request re-opened CON-32(b)'s owed limb, the
// verdict read "owed at the current head", and the agent took that as its cue
// to request again. Nothing in the verdict could tell a round the policy owed
// from one the agent chose to ask for, because nothing counted rounds. This
// module counts them, so "owed because nobody ever posted" and "owed because a
// request was made" stand apart in what the maintainer reads.
//
// COUNTED AND REPORTED, NEVER A CONJUNCT. The counts are `meta` -- context,
// never evidence -- and change no row, no verdict and no exit code. The two
// numbers keep the meaning the consumer that wrote them gave them
// (zheref/hatsu#102), adopted by name under the maintainer's ruling of
// 2026-10-04 ("Retire 2, adopt 2"):
//
//   maxRounds  the REQUESTED rounds per reviewer on one pull request -- the
//              ceiling `nen pr request-reviews` refuses past. Counted from the
//              pull request's `review_requested` timeline events.
//   minRounds  the rounds a reviewer stands owed. A ROUND is a posted review,
//              or -- for a reviewer whose check IS its round -- the round the
//              gate's own rule finds (`reviewerRound`), counted as one.
//
// THE QUORUM RULE HOLDS HERE TOO (#361, maintainer ruling 2026-10-04). A MET
// `round_quorum` fulfils the rounds owed by its own `any_of` members, so a
// member short of minRounds reads `fulfilled-by-quorum`, not `owed` -- except a
// member whose round-check run at head is still IN FLIGHT, which is mid-review,
// not unavailable, and stays owed (`owed-in-flight`). One predicate,
// `quorumMembersInFlight`, decides both this reading and the row's
// (`quorumExcusedRounds`), so they cannot drift.
//
// REQUESTS ARE MATCHED BY THE WHOLE LOGIN (N10). A timeline login is matched
// against the reviewer's `login_pattern` ANCHORED (`requestLoginMatcher`), with
// an optional `[bot]` suffix, so an unanchored `copilot` counts a request for
// `Copilot` and never one for `copilot-swe-agent`.

import { quorumMembersInFlight, type QuorumResult, type ReviewerRoundFacts } from "./predicates.js";

/** One reviewer, against minRounds. `no-minimum` when the file states none. */
export type MinRoundsStatus = "met" | "owed" | "owed-in-flight" | "fulfilled-by-quorum" | "no-minimum";

/**
 * One reviewer, against maxRounds. `under`: another request is allowed;
 * `reached`: the next request would pass the ceiling; `over`: more requests
 * stand than the ceiling allows (made before it, or by another route);
 * `unknown`: the requests could not be counted; `no-ceiling`: none stated.
 */
export type MaxRoundsStatus = "under" | "reached" | "over" | "unknown" | "no-ceiling";

export interface ReviewerRoundCount {
  readonly reviewer: string;
  /** `review_requested` events naming the reviewer; `null` when they could not be read. */
  readonly requested: number | null;
  /** Reviews the reviewer posted, at any head. */
  readonly posted: number;
  /** The rounds counted against minRounds: `posted`, or 1 for a round its check holds. */
  readonly rounds: number;
  /** A review request naming the reviewer is pending now. */
  readonly pendingRequest: boolean;
  readonly min: MinRoundsStatus;
  readonly max: MaxRoundsStatus;
}

export interface RoundCounts {
  readonly minRounds: number | null;
  readonly maxRounds: number | null;
  /** Whether the timeline was read, so `requested` is a count rather than `null`. */
  readonly requestsRead: boolean;
  readonly reviewers: readonly ReviewerRoundCount[];
}

/**
 * A reviewer's `login_pattern` as a WHOLE-login test for a requested login:
 * `^(?:pattern)(\[bot\])?$`, the pattern's own flags kept (minus `g`/`y`, so
 * no state carries between calls). Already-anchored patterns read the same.
 */
export function requestLoginMatcher(pattern: RegExp): (login: string) => boolean {
  const anchored = new RegExp(`^(?:${pattern.source})(?:\\[bot\\])?$`, pattern.flags.replace(/[gy]/g, ""));
  return (login: string): boolean => anchored.test(login);
}

/**
 * Count each reviewer's rounds. `requestedLogins` is every `review_requested`
 * event's requested login, in timeline order, or `null` when the timeline
 * could not be read -- in which case no ceiling is judged (`unknown`), never
 * read as "none requested".
 */
export function countRounds(
  facts: readonly ReviewerRoundFacts[],
  requestedLogins: readonly string[] | null,
  minRounds: number | null,
  maxRounds: number | null,
  quorum: QuorumResult | undefined,
): RoundCounts {
  const inFlight = quorumMembersInFlight(quorum);
  const members = new Set(quorum?.anyOf ?? []);
  const reviewers = facts.map((fact): ReviewerRoundCount => {
    const matches = requestLoginMatcher(fact.loginPattern);
    const requested = requestedLogins === null ? null : requestedLogins.filter(matches).length;
    const rounds = Math.max(fact.posted, fact.round === null ? 0 : 1);
    let min: MinRoundsStatus;
    if (minRounds === null) min = "no-minimum";
    else if (rounds >= minRounds) min = "met";
    else if (members.has(fact.reviewer) && inFlight.has(fact.reviewer)) min = "owed-in-flight";
    else if (members.has(fact.reviewer) && quorum?.met === true) min = "fulfilled-by-quorum";
    else min = "owed";
    let max: MaxRoundsStatus;
    if (maxRounds === null) max = "no-ceiling";
    else if (requested === null) max = "unknown";
    else if (requested > maxRounds) max = "over";
    else if (requested === maxRounds) max = "reached";
    else max = "under";
    return { reviewer: fact.reviewer, requested, posted: fact.posted, rounds, pendingRequest: fact.pendingRequest, min, max };
  });
  return { minRounds, maxRounds, requestsRead: requestedLogins !== null, reviewers };
}

const MIN_TEXT: Readonly<Record<MinRoundsStatus, string>> = {
  met: "met",
  owed: "owed",
  "owed-in-flight": "owed (its round check is in flight at head, so the met quorum does not cover it)",
  "fulfilled-by-quorum": "fulfilled by the met round quorum",
  "no-minimum": "no minimum stated",
};

const MAX_TEXT: Readonly<Record<MaxRoundsStatus, string>> = {
  under: "another request allowed",
  reached: "ceiling reached: no further request",
  over: "past the ceiling",
  unknown: "requests could not be counted",
  "no-ceiling": "no ceiling stated",
};

/** The `--explain` lines: a heading, then one line per reviewer. */
export function renderRoundCounts(counts: RoundCounts): string[] {
  const stated = (value: number | null): string => (value === null ? "unstated" : String(value));
  const lines = [
    `  review rounds (round_policy minRounds ${stated(counts.minRounds)}, maxRounds ${stated(
      counts.maxRounds,
    )}; counted, never a conjunct, zheref/nen#240):`,
  ];
  if (counts.reviewers.length === 0) lines.push("    (no configured reviewer)");
  for (const entry of counts.reviewers) {
    const requested = entry.requested === null ? "?" : String(entry.requested);
    const ofMax = counts.maxRounds === null ? "" : ` of max ${counts.maxRounds}`;
    const ofMin = counts.minRounds === null ? "" : ` of min ${counts.minRounds}`;
    const posted = entry.rounds === entry.posted ? "" : ` (posted ${entry.posted}; its check holds its round)`;
    const pending = entry.pendingRequest ? " · a request is pending" : "";
    lines.push(
      `    ${entry.reviewer}: requested ${requested}${ofMax} (${MAX_TEXT[entry.max]}) · rounds ${entry.rounds}${posted}${ofMin} (${MIN_TEXT[entry.min]})${pending}`,
    );
  }
  return lines;
}
