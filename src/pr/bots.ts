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
//
// AND AN ABSENT BOT IS A REFUSAL, NOT A SUCCESS WITH AN EMPTY LIST
// (zheref/nen#277). Reading the response was only half of the rule above:
// until #277 a response that listed NONE of the requested bots still came
// back `ok: true`, rendered as "pending review requests now include bot(s):
// (none reported back)" -- on zheref/hatsu#123, #128 and #130 (2026-09-29)
// exactly that answer came back for Copilot's node id, GitHub recorded no
// `ReviewRequestedEvent`, and no review ever arrived, while a caller reading
// exit 0 waited on a round that was never coming. So every requested id is now
// looked for in the response BY ID, and one that is not there fails the call
// with its own exit code (`EXIT_BOT_REQUEST_UNRECORDED`, below), naming the
// bot. "GitHub accepted the call" and "GitHub recorded the request" are two
// facts, and only the second one means a review is coming.
//
// WHY NOT ALSO READ THE TIMELINE FOR THE `ReviewRequestedEvent` (#277's
// optional ask). It would be one more `gh api graphql` call through the same
// seam, so it is testable -- but it is not small in what it would have to
// decide. The mutation's response is the same transaction's own answer; a
// timeline read is a second, later read of a connection GitHub fills
// asynchronously, so an event missing from it can be lag rather than
// refusal, and an event present in it can be an EARLIER request's (a bot
// requested at 03:00Z and again at 12:32Z leaves one event per request) --
// telling this call's event from an older one needs a clock window, which is
// a heuristic, and a heuristic is exactly what this verdict must not rest on.
// The response-by-id check decides; the timeline is left out on purpose.

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
  /**
   * The base commit GitHub reports for the pull request (`baseRefOid`), "" when
   * it answered none -- where `nen pr request-reviews` reads
   * `round_policy.maxRounds` (zheref/nen#240), so a pull request cannot raise
   * its own ceiling.
   */
  readonly baseRefOid: string;
  /**
   * The repository's default branch and its tip, `null` when GitHub answered
   * none -- the second commit `round_policy.maxRounds` is read at, the lower
   * of the two applied (Feitan F1).
   */
  readonly defaultBranch: { readonly name: string; readonly oid: string } | null;
}

const PR_AND_KNOWN_BOTS_QUERY =
  "query($owner:String!,$name:String!,$pr:Int!){repository(owner:$owner,name:$name){defaultBranchRef{name target{oid}} pullRequest(number:$pr){id baseRefOid " +
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
    data?: {
      repository?: {
        defaultBranchRef?: { name?: unknown; target?: { oid?: unknown } | null } | null;
        pullRequest?: { id?: unknown; baseRefOid?: unknown; reviewRequests?: unknown; timelineItems?: unknown };
      };
    };
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
  return {
    pullRequestId: pr.id,
    bots: [...byId.values()],
    baseRefOid: typeof pr.baseRefOid === "string" ? pr.baseRefOid : "",
    defaultBranch: defaultBranchOf(parsed.data?.repository?.defaultBranchRef),
  };
}

function defaultBranchOf(raw: { name?: unknown; target?: { oid?: unknown } | null } | null | undefined): {
  readonly name: string;
  readonly oid: string;
} | null {
  const name = raw?.name;
  const oid = raw?.target?.oid;
  return typeof name === "string" && name !== "" && typeof oid === "string" && oid !== "" ? { name, oid } : null;
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
// second reader that only checks `login`. `id` is also how the response is
// matched back to the `botIds` this call sent (zheref/nen#277) -- a requested
// id that no pending Bot node carries is reported as not recorded -- and a
// reader that silently accepted a Bot fragment missing it would be a second,
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

/**
 * `nen pr request-reviews`' exit code when GitHub ACCEPTED a bot review
 * request (the mutation exited 0 and answered JSON) but its own response does
 * not record every bot that was asked for (zheref/nen#277).
 *
 * WHY A CODE OF ITS OWN, NOT `1`. The verb's table was `0` requested, `1` a
 * route's `gh` call failed (or nothing was named), `2` usage. A failed call is
 * loud -- GitHub said no, with a reason on stderr -- and a caller may fix a
 * token and retry it. This is the silent case: the call succeeded and the
 * request simply did not land, so the one thing a caller (hatsu:sharingan)
 * must do differently is stop expecting a review round from that bot rather
 * than wait on one. Folding it into `1` would make that caller parse the
 * message to tell the two apart. ("Should not be expected", never "will not
 * arrive": the response is read off a `first:100` page -- see
 * `requestBotReviews` -- so a bot that DID land past it is reported here
 * too, and the wording claims no more than the page proves.)
 *
 * WHY `9`. The same family's precedent: `pr ready`'s `8` (head-mismatch) was
 * chosen because it collides with nothing else this CLI or its bootstrap
 * returns -- `1`/`2` are every verb's, `3`-`6` are taken by `shu`, `wc`, `pr
 * threads` and `pr merge`, `3`-`7` by the bootstrap script and its wrapper,
 * `8` by `pr ready`. A caller that drives several `pr` verbs from one
 * loop can then branch on the number alone, without first asking which verb
 * returned it. `9` is the next code with that property.
 */
export const EXIT_BOT_REQUEST_UNRECORDED = 9;

/** A requested bot the mutation's own response did not record (zheref/nen#277). */
export interface UnrecordedBot {
  /** The node id that was sent in `botIds`. */
  readonly id: string;
  /**
   * The bot's login when this pull request already knows it (its own
   * `reviewRequests` or `timelineItems` -- `parsePrAndKnownBots`), `null` for a
   * bot named only by node id that this pull request has never seen. Never
   * guessed from the id.
   */
  readonly login: string | null;
}

export interface RequestBotReviewsResult {
  readonly ok: boolean;
  readonly message: string;
  /** The bot logins `gh`'s OWN response says are now pending review -- see the module header. */
  readonly pendingBotLogins: readonly string[];
  /**
   * Every requested bot the mutation's own response does NOT list as pending
   * (zheref/nen#277). Non-empty exactly when the call was accepted but did not
   * land for at least one bot -- `ok` is then `false`. EMPTY when the call
   * itself failed or its response could not be read: those are `ok: false`
   * for their own reason, and nothing was read that could say which bot
   * landed and which did not.
   */
  readonly unrecordedBots: readonly UnrecordedBot[];
}

/** `login (id)` when the login is known, the bare id otherwise -- the name a human reads first. */
function describeBot(bot: UnrecordedBot): string {
  return bot.login === null ? bot.id : `${bot.login} (${bot.id})`;
}

/**
 * `requestReviews(input:{..., botIds, union:true})`, read back through its
 * own response rather than assumed. See the module header for why: the
 * identical call has been observed answering `NOT_FOUND` for a botId under
 * one token and succeeding under another, so an exit-0 result is trusted
 * only as far as the mutation's own `reviewRequests` says it went -- and
 * (zheref/nen#277) a requested id that response does not carry is reported
 * as NOT recorded, `ok: false`, never as a success with an empty list.
 *
 * `knownBots` is only for NAMING an unrecorded bot (its login, when this pull
 * request has already seen it); it never decides whether one was recorded --
 * that is the response's id alone.
 *
 * `first:100` on the response's `reviewRequests` (see the module header): a
 * pull request with more than 100 pending review requests could push a bot
 * that DID land off the page, and it would be reported as unrecorded. That
 * failure direction is a false refusal, never a false success, which is the
 * direction this verdict is allowed to err in.
 */
export function requestBotReviews(
  seams: Seams,
  target: Target,
  prNumber: number,
  pullRequestId: string,
  botIds: readonly string[],
  knownBots: readonly KnownBot[] = [],
): RequestBotReviewsResult {
  const result = seams.run(GH, [...requestBotReviewsArgv(pullRequestId, botIds)]);
  if (result.code !== 0) {
    return {
      ok: false,
      message: `could not request bot review(s) on ${target.slug}#${prNumber}: ${
        outputLines(result.stderr).join(" ") || `exit ${result.code}`
      }`,
      pendingBotLogins: [],
      unrecordedBots: [],
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
      unrecordedBots: [],
    };
  }
  const nodes = parsed.data?.requestReviews?.pullRequest?.reviewRequests?.nodes;
  // NO LIST AT ALL IS "COULD NOT READ", NOT "READ, AND THE BOT IS ABSENT".
  // A response with no `reviewRequests.nodes` array (a null `requestReviews`,
  // a missing pull request) says nothing about which bot landed, so it is the
  // same class of failure as the not-JSON branch above -- exit 1 -- rather
  // than EXIT_BOT_REQUEST_UNRECORDED, whose meaning is that GitHub's own
  // answer was read and positively lacks the bot.
  if (!Array.isArray(nodes)) {
    return {
      ok: false,
      message: `${target.slug}#${prNumber}: gh api graphql exited 0 but its response carries no reviewRequests list, so whether the bot review request landed cannot be read from it`,
      pendingBotLogins: [],
      unrecordedBots: [],
    };
  }
  const pending = nodes
    .map((node): KnownBot | null =>
      readBot(typeof node === "object" && node !== null ? (node as Record<string, unknown>)["requestedReviewer"] : null),
    )
    .filter((bot): bot is KnownBot => bot !== null);
  const pendingBotLogins = pending.map((bot): string => bot.login);
  const pendingIds = new Set(pending.map((bot): string => bot.id));
  // BY ID, THE ONE THING BOTH SIDES CARRY. A login is not sent (a bot named by
  // --add-bots has none this module knows) and is not unique across renames;
  // the node id is what the mutation was given and what the response echoes.
  const unrecordedBots = [...new Set(botIds)]
    .filter((id): boolean => !pendingIds.has(id))
    .map((id): UnrecordedBot => ({ id, login: knownBots.find((bot): boolean => bot.id === id)?.login ?? null }));
  if (unrecordedBots.length > 0) {
    const plural = unrecordedBots.length > 1;
    return {
      ok: false,
      message: `${target.slug}#${prNumber}: GitHub accepted the bot review request but did not record it for ${unrecordedBots
        .map(describeBot)
        .join(", ")} -- the mutation's own response lists no pending review request from ${
        plural ? "those bots" : "that bot"
      }, so no review round should be expected from ${plural ? "them" : "it"}. Pending bot review requests it does list: ${
        pendingBotLogins.length > 0 ? pendingBotLogins.join(", ") : "(none)"
      }.`,
      pendingBotLogins,
      unrecordedBots,
    };
  }
  return {
    ok: true,
    message: `${target.slug}#${prNumber}'s pending review requests now include bot(s): ${
      pendingBotLogins.length > 0 ? pendingBotLogins.join(", ") : "(none reported back)"
    }`,
    pendingBotLogins,
    unrecordedBots: [],
  };
}
