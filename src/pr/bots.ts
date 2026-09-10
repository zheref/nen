// src/pr/bots.ts -- resolving a Bot reviewer (Copilot and its kin) and
// requesting review from one, for `nen pr request-reviews --add-bots`
// (zheref/nen#160).
//
// WHY A BOT CANNOT TRAVEL THE `--add-reviewers` PATH THIS FAMILY ALREADY HAD.
// ../pr/reviewers.ts's `requestReviews()` is `gh pr edit --add-reviewer`,
// which resolves a login through GitHub's `requestReviewsByLogin` mutation --
// and that mutation only resolves USERS and TEAMS. GitHub's Copilot reviewer
// is recorded as a `Bot` (`login: copilot-pull-request-reviewer`, node id
// `BOT_kgDOCnlnWA`, verified live against zheref/nen#158 and #164 the day
// this landed), so the same call this family already made for a human
// reviewer answers `GraphQL: Could not resolve user with login 'copilot'.
// (requestReviewsByLogin)` for a bot one, every time. The mutation that DOES
// land it is `requestReviews(input:{pullRequestId, botIds:[...], union:true})`
// -- a different GraphQL field, on a different input type, that
// `requestReviewsByLogin` never reaches internally. This module is that
// second path; ../pr/reviewers.ts's is unchanged and still owns the
// user/team route.
//
// RESOLVING A LOGIN TO A BOT IS NOT A LOOKUP GITHUB OFFERS DIRECTLY.
// `search(type: USER)` never returns a Bot node, and `repository.collaborators`
// -- the read this module uses for the USER half of resolution, below -- never
// does either: a bot is not a "collaborator" in GitHub's own sense of the
// word, no matter how many times it has reviewed. The one reliable read is
// the PULL REQUEST'S OWN HISTORY: a bot that already reviewed appears as the
// author of a `PullRequestReview` timeline item, and a bot with a review
// still OWED appears in `reviewRequests`. Between the two, a bot that has
// ever touched THIS pull request resolves; one that has not must be named by
// its node id directly, with `--add-bots` -- which is exactly what this
// verb's usage text says when resolution comes up empty (see
// unresolvedLoginError below).
//
// A REFUSAL IS A REFUSAL, NEVER A GUESS: a login this module cannot place as
// either a known bot OR a collaborator is refused (exit 2, VerbUsageError) --
// see ../pr/command.ts's doRequestReviews -- rather than handed to
// `requestReviewsByLogin` on the chance it resolves. That call's own error
// already exists and is not friendlier for being deferred to.
//
// `first:100` ON reviewRequests/timelineItems IS NOT PAGINATED, unlike
// ../pr/fetch.ts's identical-looking connections. Those exist to answer a
// READINESS VERDICT, where a truncated page is a false GREEN (zheref/nen#14).
// This read only widens or narrows which bots resolve BY NAME on one PR at
// one moment -- a truncated page here costs a caller an occasional "name it
// with --add-bots instead" refusal, never a wrong mutation -- so the
// pagination discipline that class of read needs is not repeated here.
//
// THE MUTATION'S SUCCESS MESSAGE IS BUILT FROM ITS OWN RESPONSE, NOT FROM THE
// REQUEST. Verified live the day this landed: the identical `requestReviews`
// call, same botId, same pull request, answered `NOT_FOUND` under one
// session's token and succeeded under another's -- a permission-scoped
// difference in which nodes a token can resolve, not a flake. `gh api
// graphql` already turns a GraphQL `errors` entry into a non-zero exit (this
// module's own failure branch relays that stderr verbatim, unchanged from
// ../pr/reviewers.ts's convention) -- but an exit-0 call that silently
// dropped one botId union'd in would still let this module CLAIM a bot was
// requested that never actually was. So the mutation asks GitHub to hand back
// the pull request's OWN reviewRequests afterwards, and the human/`--json`
// message is built by reading who is actually pending review there -- never
// by echoing the ids this module sent.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";

// --- resolving what this pull request already knows about ------------------

export interface KnownBot {
  readonly login: string;
  readonly id: string;
}

export interface PrAndKnownBots {
  /** The pull request's own GraphQL node id -- `requestReviews`'s `pullRequestId`. */
  readonly pullRequestId: string;
  /**
   * Every Bot this pull request has ALREADY SEEN, from either direction: one
   * still owed a review (`reviewRequests`) or one that already posted a
   * review (a `PullRequestReview` timeline item). Duplicates (a bot that was
   * requested, reviewed, and was re-requested) are folded by id.
   */
  readonly bots: readonly KnownBot[];
}

const PR_AND_KNOWN_BOTS_QUERY =
  "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){pullRequest(number:$pr){id " +
  "reviewRequests(first:100){nodes{requestedReviewer{__typename ... on Bot{login id}}}} " +
  "timelineItems(first:100,itemTypes:[PULL_REQUEST_REVIEW]){nodes{... on PullRequestReview{author{__typename ... on Bot{login id}}}}}}}}";

// `--method POST`, EXPLICIT, matching ../pr/fetch.ts's own rule
// (zheref/nen#19): GitHub's GraphQL transport takes POST for every operation,
// reads included, and no argv this repository builds is allowed to leave the
// method to `gh`'s "a -F parameter was given" inference -- see that module's
// header for the incident this convention exists to never repeat.
export function prAndKnownBotsArgv(target: Target, prNumber: number): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${PR_AND_KNOWN_BOTS_QUERY}`,
    "-F",
    `owner=${target.owner}`,
    "-F",
    `name=${target.repo}`,
    "-F",
    `pr=${prNumber}`,
  ];
}

export class BotResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BotResolutionError";
  }
}

// THROWN, NOT RETURNED -- unlike requestBotReviews() below. A read this
// module does to DECIDE routing (is this login a known bot, a collaborator)
// that `gh` itself could not complete is a tool failure, the same class
// ../pr/fetch.ts's runOrThrow() throws FetchError for, not a business
// refusal a caller's script should branch on via `ok: false`. Only the
// resolution ITSELF answering "neither" is a refusal (../pr/command.ts
// raises that one as a VerbUsageError, exit 2); `gh` failing to answer at
// all is exit 1, same as every other unexpected tool failure in this family.
function runOrThrow(seams: Seams, args: readonly string[], what: string): string {
  const result = seams.run(GH, [...args]);
  if (result.code !== 0) {
    throw new BotResolutionError(`could not read ${what}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
  return result.stdout;
}

interface RawBotNode {
  readonly __typename?: unknown;
  readonly login?: unknown;
  readonly id?: unknown;
}

function readBot(raw: unknown): KnownBot | null {
  if (typeof raw !== "object" || raw === null) return null;
  const node = raw as RawBotNode;
  if (node.__typename !== "Bot") return null;
  if (typeof node.login !== "string" || typeof node.id !== "string") return null;
  return { login: node.login, id: node.id };
}

/**
 * Parses `PR_AND_KNOWN_BOTS_QUERY`'s response. Throws `BotResolutionError`
 * only when the pull request node ITSELF could not be read -- without a
 * `pullRequestId` there is nothing this module's mutation could ever address.
 * A bot node that does not parse (an unexpected shape, a `requestedReviewer`
 * that is a User or a Team) is skipped rather than failing the whole read:
 * this is a best-effort NAME-TO-ID lookup, not a readiness gate, and the
 * module header explains why it is not held to that gate's pagination
 * discipline either.
 */
export function parsePrAndKnownBots(raw: string, what: string): PrAndKnownBots {
  let parsed: {
    data?: { repository?: { pullRequest?: { id?: unknown; reviewRequests?: unknown; timelineItems?: unknown } } };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new BotResolutionError(`${what}: gh api graphql did not return JSON (${String(error)})`);
  }
  const pr = parsed.data?.repository?.pullRequest;
  if (typeof pr?.id !== "string" || pr.id === "") {
    throw new BotResolutionError(`${what}: could not read the pull request's own node id from the GraphQL response`);
  }
  const reviewRequestNodes = (pr.reviewRequests as { nodes?: unknown } | undefined)?.nodes;
  const timelineNodes = (pr.timelineItems as { nodes?: unknown } | undefined)?.nodes;
  const byId = new Map<string, KnownBot>();
  const collect = (nodes: unknown, unwrap: (node: unknown) => unknown): void => {
    if (!Array.isArray(nodes)) return;
    for (const node of nodes) {
      const bot = readBot(unwrap(node));
      if (bot !== null) byId.set(bot.id, bot);
    }
  };
  collect(reviewRequestNodes, (node): unknown =>
    typeof node === "object" && node !== null ? (node as Record<string, unknown>)["requestedReviewer"] : null,
  );
  collect(timelineNodes, (node): unknown =>
    typeof node === "object" && node !== null ? (node as Record<string, unknown>)["author"] : null,
  );
  return { pullRequestId: pr.id, bots: [...byId.values()] };
}

/** `prAndKnownBotsArgv` run through `seams` and parsed. Throws on a `gh` failure. */
export function fetchPrAndKnownBots(seams: Seams, target: Target, prNumber: number): PrAndKnownBots {
  const what = `${target.slug}#${prNumber}`;
  return parsePrAndKnownBots(runOrThrow(seams, prAndKnownBotsArgv(target, prNumber), what), what);
}

// --- resolving a login as a collaborator (the User half) --------------------

const COLLABORATOR_QUERY =
  "query($owner:String!,$name:String!,$login:String!){repository(owner:$owner,name:$name){collaborators(login:$login,first:1){nodes{login id}}}}";

/**
 * `collaborators(login:...)` is an EXACT filter, not a search -- verified
 * live the day this landed (a real collaborator's own login answers one
 * node; a bot's login, which is never a collaborator, answers none). It is
 * the reliable USER half of this module's resolution; the Bot half is
 * `parsePrAndKnownBots` above.
 */
export function collaboratorArgv(target: Target, login: string): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${COLLABORATOR_QUERY}`,
    "-F",
    `owner=${target.owner}`,
    "-F",
    `name=${target.repo}`,
    "-F",
    `login=${login}`,
  ];
}

/** `true` when `login` reads back as a collaborator of `target`. */
export function parseIsCollaborator(raw: string, what: string): boolean {
  let parsed: { data?: { repository?: { collaborators?: { nodes?: unknown } } } };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new BotResolutionError(`${what}: gh api graphql did not return JSON (${String(error)})`);
  }
  const nodes = parsed.data?.repository?.collaborators?.nodes;
  return Array.isArray(nodes) && nodes.length > 0;
}

/** `collaboratorArgv` run through `seams` and parsed. Throws on a `gh` failure. */
export function isCollaborator(seams: Seams, target: Target, login: string): boolean {
  const what = `${target.slug} collaborator '${login}'`;
  return parseIsCollaborator(runOrThrow(seams, collaboratorArgv(target, login), what), what);
}

// --- the mutation itself -----------------------------------------------------

// `... on Bot{login id}`, BOTH FIELDS -- not `login` alone -- so the response
// reads through the SAME `readBot()` the two queries above use, rather than a
// second reader that only checks `login`. `id` is otherwise unused here, but
// a reader that silently accepted a Bot fragment missing it would be a second,
// looser definition of "this is a bot" living beside the first.
const REQUEST_BOT_REVIEWS_MUTATION =
  "mutation($prId:ID!,$botIds:[ID!]!){requestReviews(input:{pullRequestId:$prId,botIds:$botIds,union:true}){pullRequest{" +
  "reviewRequests(first:100){nodes{requestedReviewer{__typename ... on Bot{login id}}}}}}}";

export function requestBotReviewsArgv(pullRequestId: string, botIds: readonly string[]): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${REQUEST_BOT_REVIEWS_MUTATION}`,
    "-F",
    `prId=${pullRequestId}`,
    ...botIds.flatMap((id): readonly string[] => ["-F", `botIds[]=${id}`]),
  ];
}

export interface RequestBotReviewsResult {
  readonly ok: boolean;
  readonly message: string;
  /** The bot logins `gh`'s OWN response says are now pending review -- see the module header. */
  readonly pendingBotLogins: readonly string[];
}

/**
 * `requestReviews(input:{..., botIds, union:true})`, read back through its
 * own response rather than assumed. See the module header for why: the
 * identical call has been observed answering `NOT_FOUND` for a botId under
 * one token and succeeding under another, so an exit-0 result is trusted
 * only as far as the mutation's own `reviewRequests` says it went.
 */
export function requestBotReviews(
  seams: Seams,
  target: Target,
  prNumber: number,
  pullRequestId: string,
  botIds: readonly string[],
): RequestBotReviewsResult {
  const result = seams.run(GH, [...requestBotReviewsArgv(pullRequestId, botIds)]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not request bot review(s) on ${target.slug}#${prNumber}: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
      pendingBotLogins: [],
    };
  }
  let parsed: {
    data?: {
      requestReviews?: { pullRequest?: { reviewRequests?: { nodes?: unknown } } } | null;
    };
  };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch (error) {
    return {
      ok: false,
      message: `${target.slug}#${prNumber}: gh api graphql exited 0 but did not return JSON (${String(error)})`,
      pendingBotLogins: [],
    };
  }
  const nodes = parsed.data?.requestReviews?.pullRequest?.reviewRequests?.nodes;
  const pendingBotLogins = Array.isArray(nodes)
    ? nodes
        .map((node): string | null => {
          const bot = readBot(
            typeof node === "object" && node !== null ? (node as Record<string, unknown>)["requestedReviewer"] : null,
          );
          return bot?.login ?? null;
        })
        .filter((login): login is string => login !== null)
    : [];
  return {
    ok: true,
    message: `${target.slug}#${prNumber}'s pending review requests now include bot(s): ${
      pendingBotLogins.length > 0 ? pendingBotLogins.join(", ") : "(none reported back)"
    }`,
    pendingBotLogins,
  };
}
