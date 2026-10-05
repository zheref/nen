// src/pr/round_ceiling.ts -- `round_policy.maxRounds` as `nen pr
// request-reviews` enforces it (zheref/nen#240).
//
// THE INCIDENT. zheref/KroApple#577 carries eight `ReviewRequestedEvent`s for
// Copilot in eleven hours, every one made on the maintainer's token by a local
// agent, under a ruling of two rounds. Each request re-opened CON-32(b)'s owed
// limb, so the verdict kept reading "owed at the current head" and the agent
// kept reading that as its cue. The ceiling is the number a repository
// declares, and this verb refuses the request past it: exit 2, naming the
// reviewer, the count and the ceiling, and nothing is requested.
//
// WHAT IS COUNTED. Every `review_requested` event on the pull request's
// timeline naming the bot -- by node id, or by login where the event carries
// no id -- whoever made it and by whatever route (this verb, a raw GraphQL
// `requestReviews`, the web UI). A request this verb refuses is never made, so
// it is never counted. The timeline read is paginated to completion
// (`--paginate --slurp`): a truncated count would be an UNDERcount, which is
// the direction that lets a request through, so it is never risked.
//
// WHY THIS IS NOT THE TIMELINE READ ./bots.ts DECLINES. That module refuses to
// decide whether THIS call's request landed from the timeline, because telling
// this request's event from an earlier one's needs a clock window. Counting
// needs no window: every event is a round asked for, and the count is the sum.
//
// WHERE THE CEILING COMES FROM: `nen/gates.json` at TWO commits -- the pull
// request's BASE and the tip of the repository's DEFAULT BRANCH -- and the
// LOWER `maxRounds` of the two applies (Feitan F1). Never the local checkout:
// `--target` may name another repository than the one the caller stands in.
// The base alone would let a pull request based on a branch it controls carry
// its own ceiling; the default branch alone would let a stale base outrank a
// lowered ruling. "Absent at the base, declared on the default branch" is
// declared. Neither stating `maxRounds` is no ceiling, and the verb behaves as
// it always did.
//
// ABSENT MEANS ONE THING (Feitan F8 / N2). Each commit is first read itself
// (`repos/<slug>/git/commits/<sha>`, no diff); only when it reads does a 404 on the FILE
// mean "no nen/gates.json here". A 404 reading the commit (a repository the
// token cannot see), "No commit found for the ref", or any other failure is
// `failed`, and a failed read REFUSES the bot request (exit 1): a ceiling that
// may be declared and could not be checked is never read as "no ceiling".
//
// A GUARDRAIL, NOT A LOCK (F5). The ceiling binds this verb. `gh pr edit`, a
// raw GraphQL `requestReviews` and the web UI request reviews without asking
// it, and the count is read before the request is made, so two concurrent
// calls can each see room for one more. Every request still COUNTS, whoever
// made it, so the next call through this verb sees them.
//
// BOTS ONLY. The ceiling caps the automated review rounds an agent requests
// (zheref/hatsu#102); a User or Team reviewer requested through `gh pr edit
// --add-reviewer` is a person asked once, and is not counted or capped.

import { GH, outputLines, redactRemoteCredentials, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { BASE_GATES_PATH, decodeContentsPayload } from "../gates/base_exclusions.js";
import { parseGatesText, parseRoundCaps } from "../schema/gates.js";
import { SchemaError } from "../schema/errors.js";

/** One `review_requested` timeline event's requested reviewer. */
export interface RequestEvent {
  readonly login: string | null;
  readonly nodeId: string | null;
  /** The reviewer's account type (`Bot`, `User`), `null` when the event says none. */
  readonly type: string | null;
}

export class RoundCeilingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RoundCeilingError";
  }
}

/**
 * The REST issue timeline, every page, as one JSON array of pages. `--method
 * GET` stated, never inferred (zheref/nen#19): `-F` would otherwise turn the
 * read into a POST.
 */
export function requestTimelineArgv(target: Target, prNumber: number): readonly string[] {
  return [
    "api",
    "--method",
    "GET",
    "--paginate",
    "--slurp",
    `repos/${target.slug}/issues/${prNumber}/timeline`,
    "-F",
    "per_page=100",
  ];
}

function field(record: unknown, key: string): unknown {
  return typeof record === "object" && record !== null ? (record as Record<string, unknown>)[key] : undefined;
}

/** Parse `requestTimelineArgv`'s output. Throws `RoundCeilingError` on anything that is not an array of page arrays. */
export function parseRequestEvents(stdout: string, what: string): RequestEvent[] {
  let pages: unknown;
  try {
    pages = JSON.parse(stdout) as unknown;
  } catch (error) {
    throw new RoundCeilingError(`${what}'s timeline did not read as JSON (${String(error)})`);
  }
  if (!Array.isArray(pages) || !pages.every((page): boolean => Array.isArray(page))) {
    throw new RoundCeilingError(`${what}'s timeline did not read as a list of pages`);
  }
  const events: RequestEvent[] = [];
  for (const event of (pages as unknown[][]).flat()) {
    if (field(event, "event") !== "review_requested") continue;
    const reviewer = field(event, "requested_reviewer");
    if (reviewer === undefined || reviewer === null) continue; // a team request names no bot
    const login = field(reviewer, "login");
    const nodeId = field(reviewer, "node_id");
    const type = field(reviewer, "type");
    events.push({
      login: typeof login === "string" && login !== "" ? login : null,
      nodeId: typeof nodeId === "string" && nodeId !== "" ? nodeId : null,
      type: typeof type === "string" && type !== "" ? type : null,
    });
  }
  return events;
}

/** Read every `review_requested` event. Throws `RoundCeilingError` when `gh` fails or answers something unreadable. */
export function readRequestEvents(seams: Seams, target: Target, prNumber: number): RequestEvent[] {
  const what = `${target.slug}#${prNumber}`;
  const result = seams.run(GH, [...requestTimelineArgv(target, prNumber)]);
  if (result.code !== 0) {
    throw new RoundCeilingError(
      `could not read ${what}'s timeline: ${redactRemoteCredentials(outputLines(result.stderr).join(" ")) || `exit ${result.code}`}`,
    );
  }
  return parseRequestEvents(result.stdout, what);
}

/**
 * How many of `events` request this bot. COUNTED BY NODE ID: every event
 * carrying the bot's id. An id GitHub answers under a DIFFERENT canonical id (a
 * legacy id) is refused before this runs (`canonicalBotLogins`), so the id
 * counted is the one the timeline carries.
 *
 * The login limb is a FALLBACK ONLY, and for real bots it is usually inert
 * (R2): the REST timeline names Copilot `Copilot` while GraphQL names the same
 * bot `copilot-pull-request-reviewer`, so the canonical login rarely matches
 * an event the id did not already count. It still counts a non-User event
 * naming the canonical login under another id (N5), so such an event is never
 * read as zero requests.
 */
export function requestsOf(events: readonly RequestEvent[], id: string, login: string | null): number {
  const wanted = login?.toLowerCase() ?? null;
  return events.filter(
    (event): boolean =>
      event.nodeId === id || (wanted !== null && event.type !== "User" && event.login?.toLowerCase() === wanted),
  ).length;
}

// ── canonical bot logins (N5) ────────────────────────────────────────────────

const BOT_NODES_QUERY = "query($ids:[ID!]!){nodes(ids:$ids){__typename ... on Bot{id login}}}";

/** One `nodes(ids:)` read for the `--add-bots` ids whose login nothing else gave. */
export function botNodesArgv(ids: readonly string[]): readonly string[] {
  const argv = ["api", "--method", "POST", "graphql", "-f", `query=${BOT_NODES_QUERY}`];
  for (const id of ids) argv.push("-f", `ids[]=${id}`);
  return argv;
}

/**
 * Each id's canonical Bot login. Throws `RoundCeilingError` when the read
 * fails, or an id is not a Bot -- a bot whose requests cannot be counted is
 * refused, never counted as zero.
 */
export function canonicalBotLogins(seams: Seams, ids: readonly string[]): ReadonlyMap<string, string> {
  const logins = new Map<string, string>();
  if (ids.length === 0) return logins;
  const result = seams.run(GH, [...botNodesArgv(ids)]);
  if (result.code !== 0) {
    throw new RoundCeilingError(
      `could not resolve ${ids.join(", ")} to a bot: ${redactRemoteCredentials(outputLines(result.stderr).join(" ")) || `exit ${result.code}`}`,
    );
  }
  let nodes: unknown;
  try {
    nodes = field(field(JSON.parse(result.stdout) as unknown, "data"), "nodes");
  } catch (error) {
    throw new RoundCeilingError(`the bot lookup for ${ids.join(", ")} did not read as JSON (${String(error)})`);
  }
  ids.forEach((id, index): void => {
    const node = Array.isArray(nodes) ? (nodes[index] as unknown) : undefined;
    const login = field(node, "login");
    const canonicalId = field(node, "id");
    if (field(node, "__typename") !== "Bot" || typeof login !== "string" || login === "") {
      throw new RoundCeilingError(
        `${id} does not resolve to a Bot, so the review rounds already requested of it cannot be counted`,
      );
    }
    // R2: a LEGACY id -- GitHub answers it, but under another canonical id.
    // The timeline carries the canonical one, so counting under the id given
    // would read zero requests. Refused, naming the id to use instead.
    if (canonicalId !== id) {
      throw new RoundCeilingError(
        `${id} resolves to the Bot ${login} under the canonical id ${typeof canonicalId === "string" ? canonicalId : "(none)"}, and the timeline counts requests by that id -- name it with --add-bots ${typeof canonicalId === "string" ? canonicalId : "<its canonical id>"} instead`,
      );
    }
    logins.set(id, login);
  });
  return logins;
}

// ── the ceiling's two sources (Feitan F1, F8 / N2) ───────────────────────────

/**
 * `repos/<slug>/git/commits/<sha>`: the commit OBJECT itself, read before its
 * file -- the git-data endpoint, which returns no diff (R3), unlike
 * `repos/<slug>/commits/<sha>`.
 */
export function commitArgv(target: Target, ref: string): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/git/commits/${ref}`];
}

/** `nen/gates.json` at one commit. */
export function gatesAtArgv(target: Target, sha: string): readonly string[] {
  const path = BASE_GATES_PATH.split("/").map((segment): string => encodeURIComponent(segment)).join("/");
  return ["api", "--method", "GET", `repos/${target.slug}/contents/${path}?ref=${sha}`];
}

export type GatesAtRef =
  | { readonly kind: "absent" }
  | { readonly kind: "read"; readonly text: string }
  | { readonly kind: "failed"; readonly message: string };

function stderrOf(result: { readonly stderr: string; readonly code: number }): string {
  return redactRemoteCredentials(outputLines(result.stderr).join(" ")) || `exit ${result.code}`;
}

/**
 * `nen/gates.json` at `sha`, where only a FILE-level 404 at a commit that
 * itself reads is `absent` (N2): the commit is read first, and "No commit
 * found for the ref" on the file read is `failed` too.
 */
export function readGatesAt(seams: Seams, target: Target, sha: string): GatesAtRef {
  if (sha === "") return { kind: "failed", message: "GitHub answered no commit to read nen/gates.json at" };
  const commit = seams.run(GH, [...commitArgv(target, sha)]);
  if (commit.code !== 0) {
    return { kind: "failed", message: `the commit ${target.slug}@${sha} could not be read (${stderrOf(commit)})` };
  }
  const file = seams.run(GH, [...gatesAtArgv(target, sha)]);
  if (file.code !== 0) {
    const stderr = stderrOf(file);
    if (/HTTP 404|Not Found/i.test(stderr) && !/No commit found/i.test(stderr)) return { kind: "absent" };
    return { kind: "failed", message: `${target.slug}@${sha}:${BASE_GATES_PATH} could not be read (${stderr})` };
  }
  try {
    return { kind: "read", text: decodeContentsPayload(JSON.parse(file.stdout) as unknown, BASE_GATES_PATH, sha) };
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) };
  }
}

export type CeilingRead =
  | { readonly kind: "none" }
  | { readonly kind: "declared"; readonly maxRounds: number; readonly source: string }
  | { readonly kind: "failed"; readonly message: string };

/** One commit the ceiling is read at: the base, or the default branch's tip. */
export interface CeilingRef {
  readonly label: string;
  readonly sha: string;
}

/**
 * `round_policy.maxRounds` at every ref (deduplicated by sha), the LOWER
 * declared value applied (Feitan F1). `source` names every ref read, with
 * what each states. Any read that fails, or a file that does not validate,
 * is `failed`.
 */
export function resolveCeiling(seams: Seams, target: Target, refs: readonly CeilingRef[]): CeilingRead {
  const unique = refs.filter((ref, index): boolean => refs.findIndex((other): boolean => other.sha === ref.sha) === index);
  const stated: { readonly ref: CeilingRef; readonly where: string; readonly maxRounds: number | null }[] = [];
  for (const ref of unique) {
    const where = `${target.slug}@${ref.sha === "" ? "(unknown)" : ref.sha}:${BASE_GATES_PATH}`;
    const read = readGatesAt(seams, target, ref.sha);
    if (read.kind === "failed") {
      return { kind: "failed", message: `could not read round_policy.maxRounds at the ${ref.label} (${read.message})` };
    }
    if (read.kind === "absent") {
      stated.push({ ref, where, maxRounds: null });
      continue;
    }
    try {
      stated.push({ ref, where, maxRounds: parseRoundCaps(where, parseGatesText(where, read.text)).maxRounds });
    } catch (error) {
      if (error instanceof SchemaError) return { kind: "failed", message: error.message };
      throw error;
    }
  }
  const declared = stated.filter((entry): boolean => entry.maxRounds !== null);
  if (declared.length === 0) return { kind: "none" };
  const maxRounds = Math.min(...declared.map((entry): number => entry.maxRounds ?? Number.POSITIVE_INFINITY));
  const source =
    stated.length === 1
      ? (stated[0]?.where ?? "")
      : stated
          .map(
            (entry): string =>
              `${entry.where} (${entry.ref.label}: ${entry.maxRounds === null ? "no maxRounds" : `maxRounds ${entry.maxRounds}`})`,
          )
          .join(" and ") + `, the lower applied`;
  return { kind: "declared", maxRounds, source };
}

/** One bot this call would request, counted against the ceiling. */
export interface BotRound {
  readonly id: string;
  readonly login: string | null;
  /** Requests already on the timeline. */
  readonly requested: number;
  /** The number this request would be: `requested + 1`. */
  readonly next: number;
  readonly maxRounds: number;
  /** `next > maxRounds`: the request is refused. */
  readonly refused: boolean;
}

export function botRounds(
  events: readonly RequestEvent[],
  bots: readonly { readonly id: string; readonly login: string | null }[],
  maxRounds: number,
): BotRound[] {
  return bots.map((bot): BotRound => {
    const requested = requestsOf(events, bot.id, bot.login);
    return { id: bot.id, login: bot.login, requested, next: requested + 1, maxRounds, refused: requested + 1 > maxRounds };
  });
}

export function botLabel(bot: { readonly id: string; readonly login: string | null }): string {
  return bot.login === null ? bot.id : `${bot.login} (${bot.id})`;
}

/** The refusal, naming every bot past the ceiling, its count and the ceiling's source. */
export function ceilingRefusal(where: string, refused: readonly BotRound[], source: string): string {
  const named = refused
    .map(
      (bot): string =>
        `${botLabel(bot)} has been requested ${bot.requested} time${bot.requested === 1 ? "" : "s"}, so this would be request ${bot.next} of ${bot.maxRounds}`,
    )
    .join("; ");
  return `refused: ${named} on ${where}, past the round_policy.maxRounds ceiling declared in ${source}. Nothing was requested. A further round is the maintainer's to grant (a pull request raising maxRounds), never this verb's (zheref/nen#240).`;
}
