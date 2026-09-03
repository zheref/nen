// src/issue/chain.ts -- where an issue sits on its delivery chain, and which
// object ends the run.
//
// FIVE PLACES, EACH WITH A DIFFERENT FIRST MOVE. The build skill's own table:
// a raw brief, an epic awaiting its mode label, an approved epic, a routable
// child or standalone task, and something already building. The classification
// is worth a verb because getting it wrong is expensive in a specific way -- a
// run that reads an unapproved epic as routable releases work the maintainer
// never approved, and a run that reads a building issue as routable releases it
// twice.
//
// DECIDED FROM LABELS AND STATE, NEVER FROM THE TITLE. That is the skill's own
// instruction, and it is also the only reading a machine can make honestly: a
// title is prose, and prose is what the LLM half of this system reads.
//
// THE LABEL NAMES ARE ARGUMENTS. §3's names-are-data rule bites hardest exactly
// here, because the natural implementation is a switch over four literal label
// strings. Instead the caller supplies a ROLE MAP -- `idea=<label>,
// building=<label>, …` -- and the roles are structural English words that
// describe a position on a chain rather than any system's vocabulary. A role
// left unmapped is reported as unmapped rather than guessed: "I cannot tell
// whether this is an idea, because nothing told me what an idea is labelled" is
// a usable answer, and a guess is not.
//
// ORDER OF TESTS IS LOAD-BEARING. Closed first (the run ends, whatever else is
// true), then building (the release already happened, so nothing upstream
// matters), then the epic states, then the default. Testing "epic" before
// "building" would send an already-building epic child back through wave
// advancement.

import type { Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { readIssue, type IssueSummary } from "./subissue.js";

export type ChainRole =
  | "idea"
  | "researched"
  | "approved-team"
  | "approved-direct"
  | "building"
  | "in-review"
  | "epic"
  | "chore";

export const CHAIN_ROLES: readonly ChainRole[] = [
  "idea",
  "researched",
  "approved-team",
  "approved-direct",
  "building",
  "in-review",
  "epic",
  "chore",
];

export type RoleMap = ReadonlyMap<ChainRole, readonly string[]>;

export interface RoleMapParseResult {
  readonly map: RoleMap;
  /**
   * Every entry that could not be parsed: no '=', an unknown role name, or
   * an empty label. `--chain-labels buildng=stage/building` (a typo) used to
   * be silently dropped, indistinguishable from the flag never being passed
   * at all -- this list is what makes it loud instead.
   */
  readonly errors: readonly string[];
}

// `role=label` pairs. A role may be given more than once -- two mode labels for
// one role is a legitimate taxonomy -- so the values accumulate rather than
// overwrite. TOTAL: every entry that does not parse is reported in `errors`
// rather than silently dropped -- see RoleMapParseResult.
export function parseRoleMap(entries: readonly string[]): RoleMapParseResult {
  const map = new Map<ChainRole, string[]>();
  const errors: string[] = [];
  for (const entry of entries) {
    const index = entry.indexOf("=");
    if (index === -1) {
      errors.push(`'${entry}' has no '=' -- expected 'role=label'.`);
      continue;
    }
    const roleRaw = entry.slice(0, index).trim();
    const label = entry.slice(index + 1).trim();
    if (!CHAIN_ROLES.includes(roleRaw as ChainRole)) {
      errors.push(`'${entry}' names an unknown role '${roleRaw}' -- expected one of ${CHAIN_ROLES.join(", ")}.`);
      continue;
    }
    if (label === "") {
      errors.push(`'${entry}' has an empty label.`);
      continue;
    }
    const role = roleRaw as ChainRole;
    const existing = map.get(role);
    if (existing === undefined) map.set(role, [label]);
    else existing.push(label);
  }
  return { map, errors };
}

// --- the object-class guard --------------------------------------------------
//
// A PULL REQUEST IS NOT ON THE CHAIN. GitHub numbers issues and PRs in one
// sequence and serves both from `issues/{n}`, so `--issue 925` can name a PR
// and every classification below would still run: the labels read cleanly, the
// state reads cleanly, and the verb answers something plausible ('#925:
// routable', exit 0 -- issue #25's live transcript) for an object class it was
// never meant to classify. That is the expensive failure again, in a new
// shape: a caller (hatsu:build) routes work off the answer, and a silently
// wrong classification releases a PR into an issue's choreography.
//
// So the guard runs at the FETCH, before any classification, in BOTH verbs --
// the readings are refused wholesale, not answered wrongly. The signal is the
// payload's non-null `pull_request` (readIssue carries it as
// `isPullRequest`); there is no other pre-check, because `gh issue view
// --json pull_request` does not exist -- it errors on every object.

/**
 * Thrown when `--issue <n>` turns out to name a pull request. A distinct class
 * so the CLI layer can keep its stable `--json` refusal shape (`refused:
 * true`) instead of letting the message fall through as a bare failure.
 */
export class NotAnIssueError extends Error {
  constructor(number: number) {
    super(
      `#${number} names a pull request, not an issue; a delivery-chain position is defined only for issues. ` +
        `For the pull request's own state, ask the 'nen pr' family instead (e.g. 'nen pr ready', 'nen pr next-blocker').`,
    );
    this.name = "NotAnIssueError";
  }
}

function requireIssue(summary: IssueSummary): IssueSummary {
  if (summary.isPullRequest) throw new NotAnIssueError(summary.number);
  return summary;
}

function carries(issue: IssueSummary, map: RoleMap, role: ChainRole): string | null {
  for (const label of map.get(role) ?? []) {
    if (issue.labels.includes(label)) return label;
  }
  return null;
}

export type ChainPositionName =
  | "closed"
  | "building"
  | "idea"
  | "epic-awaiting-approval"
  | "epic-approved"
  | "routable"
  | "undecidable";

export interface ChainPositionResult {
  readonly issue: number;
  readonly position: ChainPositionName;
  readonly evidence: readonly string[];
  /** Roles the caller never mapped, which is why some readings were unavailable. */
  readonly unmappedRoles: readonly ChainRole[];
}

export function classifyChainPosition(issue: IssueSummary, map: RoleMap): ChainPositionResult {
  const evidence: string[] = [];
  const unmapped = CHAIN_ROLES.filter((role): boolean => (map.get(role) ?? []).length === 0);

  if (issue.state.toLowerCase() !== "open") {
    evidence.push(`state is '${issue.state}' -- a closed issue ends the run; re-opening is a human's call`);
    return { issue: issue.number, position: "closed", evidence, unmappedRoles: unmapped };
  }

  const building = carries(issue, map, "building") ?? carries(issue, map, "in-review");
  if (building !== null) {
    evidence.push(`carries '${building}' -- the release already happened, so the next move is the PR-shaped one`);
    return { issue: issue.number, position: "building", evidence, unmappedRoles: unmapped };
  }

  const idea = carries(issue, map, "idea");
  if (idea !== null) {
    evidence.push(`carries '${idea}' -- a raw brief, which is decomposed before anything is routed`);
    return { issue: issue.number, position: "idea", evidence, unmappedRoles: unmapped };
  }

  const epic = carries(issue, map, "epic");
  if (epic !== null) {
    const approved = carries(issue, map, "approved-team") ?? carries(issue, map, "approved-direct");
    if (approved !== null) {
      evidence.push(`carries '${epic}' and the mode label '${approved}' -- children advance wave by wave`);
      return { issue: issue.number, position: "epic-approved", evidence, unmappedRoles: unmapped };
    }
    const researched = carries(issue, map, "researched");
    evidence.push(
      `carries '${epic}'${researched === null ? "" : ` and '${researched}'`} but no mode label -- the mode label is a human gate and is never applied by a run`,
    );
    return { issue: issue.number, position: "epic-awaiting-approval", evidence, unmappedRoles: unmapped };
  }

  // Every OTHER position above returns as soon as a role it depends on is
  // FOUND on the issue -- but falling through to here proves nothing on its
  // own when the role that would have caught this issue earlier was never
  // mapped at all. "carries no epic label" and "epic was never mapped, so
  // this issue's epic label (if any) was never checked" read identically to
  // `carries()`, and only one of them is actually "routable". A role left
  // unmapped is reported as unmapped, never guessed past -- the module's own
  // header rule, applied to the LAST branch as much as the first three.
  const criticalForRoutable: readonly ChainRole[] = ["building", "in-review", "idea", "epic"];
  const unmappedCritical = criticalForRoutable.filter((role): boolean => (map.get(role) ?? []).length === 0);
  if (unmappedCritical.length > 0) {
    evidence.push(
      `role(s) ${unmappedCritical.join(", ")} were never mapped, so 'routable' cannot be told apart from 'building'/'in-review'/'idea'/'epic' for this issue -- a run that reads a building issue as routable releases it twice. Supply --chain-labels for each; guessing which label means 'building' is exactly what this check exists to refuse.`,
    );
    return { issue: issue.number, position: "undecidable", evidence, unmappedRoles: unmapped };
  }

  evidence.push("carries no idea, epic or release label -- a routable child or standalone task");
  return { issue: issue.number, position: "routable", evidence, unmappedRoles: unmapped };
}

// Takes an already-parsed RoleMap, not raw --chain-labels entries -- parsing
// is a CLI-boundary concern (parseRoleMap's `errors` need a place to be
// reported and exited on, which is ../issue/verb.ts, not this wrapper).
export function chainPosition(seams: Seams, target: Target, issue: number, map: RoleMap): ChainPositionResult {
  return classifyChainPosition(requireIssue(readIssue(seams, target, issue)), map);
}

// --- terminus ----------------------------------------------------------------

export type TerminusKind =
  | "integration-delivery-pr"
  | "each-child-pr"
  | "own-pr"
  | "run-already-ended"
  | "undecidable";

export interface TerminusResult {
  readonly issue: number;
  readonly kind: TerminusKind;
  readonly evidence: readonly string[];
  /**
   * The head-branch shape the terminus PR must have, when the terminus is a
   * delivery PR off an integration branch. `null` when the terminus is an
   * ordinary PR whose head is whatever the author cut.
   */
  readonly expectedHeadPrefix: string | null;
  /** The base the terminus PR must target. */
  readonly expectedBase: string | null;
}

// WHICH OBJECT ENDS THE RUN.
//
// The rule that costs runs when it is missed: "a sub-PR merged onto a chore or
// integration branch is not the gate and never ends the run". A team-mode epic
// has ONE terminus -- the integration branch's delivery PR -- and a run that
// stops when the first child merges reports success with the delivery unmade.
export function classifyTerminus(
  issue: IssueSummary,
  map: RoleMap,
  integrationPrefix: string | null,
  trunk: string,
): TerminusResult {
  const evidence: string[] = [];
  if (issue.state.toLowerCase() !== "open") {
    evidence.push(`#${issue.number} is '${issue.state}' -- whatever closed it is the answer, not a PR still to come`);
    return {
      issue: issue.number,
      kind: "run-already-ended",
      evidence,
      expectedHeadPrefix: null,
      expectedBase: null,
    };
  }

  const chore = carries(issue, map, "chore");
  const epic = carries(issue, map, "epic");
  const team = carries(issue, map, "approved-team");
  const direct = carries(issue, map, "approved-direct");

  if (chore !== null || (epic !== null && team !== null)) {
    if (integrationPrefix === null) {
      evidence.push(
        `#${issue.number} delivers on an integration branch, but --integration-prefix was not given, so the branch shape cannot be named. It is not guessed: a wrong prefix would call an ordinary PR the terminus.`,
      );
      return {
        issue: issue.number,
        kind: "undecidable",
        evidence,
        expectedHeadPrefix: null,
        expectedBase: null,
      };
    }
    evidence.push(
      `carries '${chore ?? epic ?? ""}'${team === null ? "" : ` with the mode label '${team}'`} -- the terminus is the single '${integrationPrefix}* -> ${trunk}' delivery PR. A sub-PR merged onto that branch is not the gate.`,
    );
    return {
      issue: issue.number,
      kind: "integration-delivery-pr",
      evidence,
      expectedHeadPrefix: integrationPrefix,
      expectedBase: trunk,
    };
  }

  if (epic !== null && direct !== null) {
    evidence.push(
      `carries '${epic}' with the mode label '${direct}' -- there is no integration branch, so each child's own PR is a terminus and the epic ends when the last one does`,
    );
    return {
      issue: issue.number,
      kind: "each-child-pr",
      evidence,
      expectedHeadPrefix: null,
      expectedBase: trunk,
    };
  }

  if (epic !== null) {
    evidence.push(
      `carries '${epic}' but no mode label, so which shape its delivery takes is not decided yet -- that decision is a human gate`,
    );
    return {
      issue: issue.number,
      kind: "undecidable",
      evidence,
      expectedHeadPrefix: null,
      expectedBase: null,
    };
  }

  evidence.push(`no epic or chore label -- the terminus is this issue's own PR into '${trunk}'`);
  return {
    issue: issue.number,
    kind: "own-pr",
    evidence,
    expectedHeadPrefix: null,
    expectedBase: trunk,
  };
}

// Takes an already-parsed RoleMap -- see chainPosition's comment above.
export function terminus(
  seams: Seams,
  target: Target,
  issue: number,
  map: RoleMap,
  integrationPrefix: string | null = null,
  trunk = "main",
): TerminusResult {
  return classifyTerminus(requireIssue(readIssue(seams, target, issue)), map, integrationPrefix, trunk);
}
