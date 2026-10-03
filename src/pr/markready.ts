// src/pr/markready.ts -- `nen pr mark-ready`: the ONE draft-to-ready transition
// this binary performs on an existing pull request (zheref/nen#345).
//
// NOT `pr ready`, AND NAMED SO IT CANNOT BE READ AS IT. `nen pr ready` is the
// CON-32 readiness VERDICT: a read that never labels, merges or comments, and
// since NN-PR-#342 it fails its first row on a draft ("a draft is never
// Ready"). This verb is the way out of that row and nothing more: it CHANGES
// one fact -- `isDraft` -- through GitHub's `markPullRequestReadyForReview`
// mutation, and decides nothing about whether the pull request is fit to merge.
// A `ready` verdict does not trigger it and it does not consult one; the
// transition is the caller's explicit act, on the caller's own credential.
//
// WHAT IT NEVER DOES. It merges nothing, casts no review vote, applies no label,
// requests no reviewer and touches no permission. The credential is whatever
// `gh` is already authenticated as -- the verb neither widens it nor picks a
// different one -- and a refusal from GitHub is reported, never routed around.
//
// ONE READ, THEN THE WRITE, THEN ONE READ BACK. The first read certifies the
// number IS a pull request in --target (GraphQL's `pullRequest(number:)`
// resolves nothing for an issue or an absent number), that it is OPEN, that its
// head is the one the caller pinned, and whether it is a draft at all. The
// write is addressed by the node id THAT read produced -- never re-resolved from
// the number -- so the object mutated is the object certified. The read back is
// the only authority on success: GitHub has answered mutations with HTTP 200
// and an `errors` array before (see ./threads.ts's runGraphql), and an exit 0
// from `gh` is not proof the pull request left draft.
//
// THE HEAD PIN IS CHECKED BEFORE THE WRITE, NOT ENFORCED BY IT.
// `markPullRequestReadyForReview` takes no expected-head argument, so a push
// landing between the read and the write cannot be refused by GitHub. The read
// back therefore reports the head it saw too, and a head that moved is said out
// loud (`headMoved`) rather than silently folded into "done".

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import type { Target } from "../github/target.js";

export const MARK_READY_CONTRACT = "nen.pr.mark-ready/v0.1";

/**
 * The pull request is CLOSED or MERGED: nothing was sent. Three, the code
 * `pr threads` already gives "the object's state precludes the act" (an
 * already-resolved thread), rather than 1, which this verb keeps for "GitHub
 * refused, or the outcome could not be confirmed".
 */
export const EXIT_NOT_OPEN = 3;

/**
 * `--require-head` named a commit GitHub does not hold as the head. EIGHT,
 * deliberately the same code `pr ready` returns for the same fact
 * (../verbs/pr_ready.ts's EXIT_HEAD_MISMATCH), so a caller that pins a head
 * across both verbs branches on one number.
 */
export const EXIT_HEAD_MISMATCH = 8;

/** git's shortest default abbreviation to a full SHA-1 -- `pr ready`'s own rule. */
export const SHA_PREFIX = /^[0-9a-f]{7,40}$/i;

const READ_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){id number state isDraft headRefOid url}}}";

const MARK_READY_MUTATION =
  "mutation($id:ID!){markPullRequestReadyForReview(input:{pullRequestId:$id}){pullRequest{id isDraft}}}";

/** The certifying read -- run before the write and again as the read back. */
export function readDraftStateArgv(target: Target, prNumber: number): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${READ_QUERY}`,
    // `-f` for the String! variables, `-F` for the one Int! -- ./threads.ts's
    // listPageArgv records why (Feitan F6).
    "-f",
    `owner=${target.owner}`,
    "-f",
    `name=${target.repo}`,
    "-F",
    `number=${prNumber}`,
  ];
}

/**
 * The write, built once and used by BOTH the dry run and the real call, so the
 * argv a dry run prints is the argv that would run.
 */
export function markReadyArgv(pullRequestId: string): readonly string[] {
  return ["api", "--method", "POST", "graphql", "-f", `query=${MARK_READY_MUTATION}`, "-f", `id=${pullRequestId}`];
}

export type PullRequestState = "OPEN" | "CLOSED" | "MERGED";

export interface DraftState {
  /** The GraphQL node id the mutation is addressed by. */
  readonly id: string;
  readonly number: number;
  readonly state: PullRequestState;
  readonly isDraft: boolean;
  readonly headRefOid: string;
  readonly url: string;
}

// GraphQL's own words for "no such pull request" and "no such repository".
// gh prints the first on stderr at exit 1, and GitHub may also answer it as
// HTTP 200 with an `errors` array; both shapes are read.
const NOT_A_PULL_REQUEST = /Could not resolve to a PullRequest/i;
const NOT_A_REPOSITORY = /Could not resolve to a Repository/i;

function graphqlErrors(parsed: unknown): string | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const errors = (parsed as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  return errors.map((entry): string => String((entry as { message?: unknown }).message ?? JSON.stringify(entry))).join("; ");
}

function refuseUnresolved(target: Target, prNumber: number, message: string): never {
  if (NOT_A_REPOSITORY.test(message)) {
    throw new VerbUsageError(
      `--target ${target.slug} does not resolve as a repository this credential can read -- nothing was changed. (${message})`,
    );
  }
  throw new VerbUsageError(
    `#${prNumber} does not read as a pull request in ${target.slug} -- 'nen pr mark-ready' moves a PULL REQUEST out of draft only, and it is certified before any write, so nothing was changed. (${message})`,
  );
}

/**
 * Read the pull request's draft state. Throws a VerbUsageError (exit 2) when
 * the number or the repository does not resolve, and a plain Error (exit 1)
 * when the read itself failed or answered something unreadable -- an
 * unreadable answer is never treated as "not a draft".
 */
export function readDraftState(seams: Seams, target: Target, prNumber: number): DraftState {
  const result = seams.run(GH, [...readDraftStateArgv(target, prNumber)]);
  if (result.spawnFailed) {
    throw new Error(`could not run gh to read ${target.slug}#${prNumber}: ${result.stderr}`);
  }
  const stderr = outputLines(result.stderr).join(" ");
  if (result.code !== 0) {
    if (NOT_A_PULL_REQUEST.test(stderr) || NOT_A_REPOSITORY.test(stderr)) refuseUnresolved(target, prNumber, stderr);
    throw new Error(`could not read ${target.slug}#${prNumber}: ${stderr || `exit ${result.code}`}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(`reading ${target.slug}#${prNumber}: gh api graphql did not return JSON (${String(error)})`);
  }
  const errors = graphqlErrors(parsed);
  if (errors !== null) {
    if (NOT_A_PULL_REQUEST.test(errors) || NOT_A_REPOSITORY.test(errors)) refuseUnresolved(target, prNumber, errors);
    throw new Error(`reading ${target.slug}#${prNumber}: ${errors}`);
  }
  const data = (parsed as { data?: { repository?: { pullRequest?: unknown } | null } }).data;
  if (data?.repository === null || data?.repository === undefined) {
    refuseUnresolved(target, prNumber, "Could not resolve to a Repository");
  }
  const pr = data.repository.pullRequest;
  if (pr === null || pr === undefined) {
    refuseUnresolved(target, prNumber, "Could not resolve to a PullRequest");
  }
  const record = pr as Record<string, unknown>;
  const { id, number, state, isDraft, headRefOid, url } = record;
  if (
    typeof id !== "string" ||
    id === "" ||
    typeof number !== "number" ||
    (state !== "OPEN" && state !== "CLOSED" && state !== "MERGED") ||
    typeof isDraft !== "boolean" ||
    typeof headRefOid !== "string" ||
    typeof url !== "string"
  ) {
    throw new Error(
      `reading ${target.slug}#${prNumber}: GitHub's answer is missing or mistypes one of id, number, state, isDraft, headRefOid, url -- an unreadable state is never read as "not a draft".`,
    );
  }
  if (number !== prNumber) {
    throw new Error(`reading ${target.slug}#${prNumber}: GitHub answered for #${number}, not the pull request asked about.`);
  }
  return { id, number, state, isDraft, headRefOid, url };
}

/** The mutation's outcome as `gh` reported it -- never itself proof of success. */
export interface MarkReadyCall {
  readonly ok: boolean;
  readonly message: string;
}

/** Send the mutation. Returns `ok: false` with GitHub's words on any refusal. */
export function sendMarkReady(seams: Seams, target: Target, prNumber: number, pullRequestId: string): MarkReadyCall {
  const result = seams.run(GH, [...markReadyArgv(pullRequestId)]);
  if (result.spawnFailed) {
    return { ok: false, message: `could not run gh to mark ${target.slug}#${prNumber} ready: ${result.stderr}` };
  }
  const stderr = outputLines(result.stderr).join(" ");
  if (result.code !== 0) {
    return { ok: false, message: `GitHub refused to mark ${target.slug}#${prNumber} ready for review: ${stderr || `exit ${result.code}`}` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch (error) {
    return { ok: false, message: `marking ${target.slug}#${prNumber} ready: gh api graphql did not return JSON (${String(error)})` };
  }
  // A 200 CARRYING `errors` IS A REFUSAL -- ./threads.ts's runGraphql says why.
  const errors = graphqlErrors(parsed);
  if (errors !== null) {
    return { ok: false, message: `GitHub refused to mark ${target.slug}#${prNumber} ready for review: ${errors}` };
  }
  return { ok: true, message: `markPullRequestReadyForReview accepted for ${target.slug}#${prNumber}` };
}

export type MarkReadyStatus =
  | "marked-ready"
  | "already-ready"
  | "dry-run"
  | "not-open"
  | "head-mismatch"
  | "refused"
  | "unconfirmed";

export interface MarkReadyReport {
  readonly contract: typeof MARK_READY_CONTRACT;
  readonly status: MarkReadyStatus;
  /** True only on `marked-ready` and `already-ready`: the pull request is, read from GitHub, not a draft. */
  readonly ok: boolean;
  readonly target: string;
  readonly number: number;
  readonly url: string;
  readonly stateBefore: PullRequestState;
  readonly wasDraft: boolean;
  /** The draft state GitHub last answered -- the read back's when one ran, null when it could not be read. */
  readonly isDraft: boolean | null;
  readonly requiredHead: string | null;
  readonly headBefore: string;
  /** The head the read back saw; null when no read back ran or it failed. */
  readonly headAfter: string | null;
  /** True when a read back ran and saw a head other than `headBefore`. */
  readonly headMoved: boolean;
  /** Whether the mutation was sent at all. */
  readonly sent: boolean;
  readonly dryRun: boolean;
  /** The mutation's gh argv -- what ran, or what would have; null when nothing would ever be sent. */
  readonly mutationArgv: readonly string[] | null;
  readonly message: string;
}

export interface MarkReadyInput {
  readonly target: Target;
  readonly number: number;
  readonly requiredHead: string | null;
  readonly dryRun: boolean;
}

/** The exit code each status carries -- the verb's published contract. */
export function exitCodeFor(status: MarkReadyStatus): number {
  switch (status) {
    case "marked-ready":
    case "already-ready":
    case "dry-run":
      return 0;
    case "not-open":
      return EXIT_NOT_OPEN;
    case "head-mismatch":
      return EXIT_HEAD_MISMATCH;
    case "refused":
    case "unconfirmed":
      return 1;
  }
}

/**
 * The whole verb, behind the seam: certify, refuse what must be refused BEFORE
 * any write, send (unless dry), read back. Usage-class failures (an unresolved
 * number or repository) and a failed FIRST read throw; everything decided
 * after that read is a report, so `--json` always has a document to print.
 */
export function markReady(seams: Seams, input: MarkReadyInput): MarkReadyReport {
  const { target, number, requiredHead, dryRun } = input;
  const before = readDraftState(seams, target, number);
  const base = {
    contract: MARK_READY_CONTRACT,
    target: target.slug,
    number,
    url: before.url,
    stateBefore: before.state,
    wasDraft: before.isDraft,
    requiredHead,
    headBefore: before.headRefOid,
    dryRun,
  } as const;
  const nothingSent = { headAfter: null, headMoved: false, sent: false } as const;

  if (before.state !== "OPEN") {
    return {
      ...base,
      ...nothingSent,
      status: "not-open",
      ok: false,
      isDraft: before.isDraft,
      mutationArgv: null,
      message: `${target.slug}#${number} is ${before.state}, not OPEN -- a closed or merged pull request is never moved out of draft; nothing was sent.`,
    };
  }

  // An EMPTY head matches nothing: "could not confirm" is not "confirmed".
  if (
    requiredHead !== null &&
    (before.headRefOid === "" || !before.headRefOid.toLowerCase().startsWith(requiredHead.toLowerCase()))
  ) {
    return {
      ...base,
      ...nothingSent,
      status: "head-mismatch",
      ok: false,
      isDraft: before.isDraft,
      mutationArgv: null,
      message: `--require-head ${requiredHead} does not match GitHub's head for ${target.slug}#${number}, which is ${
        before.headRefOid === "" ? "(unread)" : before.headRefOid
      }; nothing was sent. If a push is in flight, ask again once it registers.`,
    };
  }

  if (!before.isDraft) {
    return {
      ...base,
      ...nothingSent,
      status: "already-ready",
      ok: true,
      isDraft: false,
      mutationArgv: null,
      message: `${target.slug}#${number} is already ready for review (not a draft); nothing was sent.`,
    };
  }

  const argv = ["gh", ...markReadyArgv(before.id)];
  if (dryRun) {
    return {
      ...base,
      ...nothingSent,
      status: "dry-run",
      ok: true,
      isDraft: true,
      mutationArgv: argv,
      message: `would mark ${target.slug}#${number} ready for review (it is a draft at ${before.headRefOid}); nothing was sent.`,
    };
  }

  const call = sendMarkReady(seams, target, number, before.id);
  if (!call.ok) {
    return {
      ...base,
      ...nothingSent,
      sent: true,
      status: "refused",
      ok: false,
      isDraft: true,
      mutationArgv: argv,
      message: `${call.message} -- the pull request is not reported ready.`,
    };
  }

  let after: DraftState;
  try {
    after = readDraftState(seams, target, number);
  } catch (error) {
    return {
      ...base,
      headAfter: null,
      headMoved: false,
      sent: true,
      status: "unconfirmed",
      ok: false,
      isDraft: null,
      mutationArgv: argv,
      message: `the mutation was accepted, but the read back of ${target.slug}#${number} failed, so the transition is NOT confirmed: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
  const headMoved = after.headRefOid !== before.headRefOid;
  const readBack = { headAfter: after.headRefOid, headMoved, sent: true, mutationArgv: argv } as const;
  if (after.id !== before.id || after.isDraft) {
    return {
      ...base,
      ...readBack,
      status: "unconfirmed",
      ok: false,
      isDraft: after.isDraft,
      message:
        after.id !== before.id
          ? `the read back of ${target.slug}#${number} answered a different object (${after.id}, not ${before.id}); the transition is NOT confirmed.`
          : `the mutation was accepted, but GitHub still reads ${target.slug}#${number} as a draft; the transition is NOT confirmed.`,
    };
  }
  return {
    ...base,
    ...readBack,
    status: "marked-ready",
    ok: true,
    isDraft: false,
    message: `${target.slug}#${number} is ready for review (read back: not a draft)${
      headMoved ? ` -- NOTE: its head moved from ${before.headRefOid} to ${after.headRefOid} during the transition` : ""
    }.`,
  };
}
