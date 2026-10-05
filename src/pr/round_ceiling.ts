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
// WHERE THE CEILING COMES FROM: `nen/gates.json` AT THE PULL REQUEST'S BASE,
// read the way `checks.excluded` is (../gates/base_exclusions.ts, Feitan F1),
// never the local checkout -- `--target` may name another repository than the
// one the caller stands in, and a pull request must not raise its own ceiling.
// No file at the base, or a file stating no `maxRounds`, declares no ceiling
// and the verb behaves as it always did. A base that cannot be read, or a file
// that does not validate, REFUSES the bot request (exit 1): a ceiling that was
// declared and could not be checked is never read as "no ceiling".
//
// BOTS ONLY. The ceiling caps the automated review rounds an agent requests
// (zheref/hatsu#102); a User or Team reviewer requested through `gh pr edit
// --add-reviewer` is a person asked once, and is not counted or capped.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";

/** One `review_requested` timeline event's requested reviewer. */
export interface RequestEvent {
  readonly login: string | null;
  readonly nodeId: string | null;
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
    events.push({
      login: typeof login === "string" && login !== "" ? login : null,
      nodeId: typeof nodeId === "string" && nodeId !== "" ? nodeId : null,
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
      `could not read ${what}'s timeline: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`,
    );
  }
  return parseRequestEvents(result.stdout, what);
}

/** How many of `events` request this bot: by node id, or by login (case-insensitive) where one is known. */
export function requestsOf(events: readonly RequestEvent[], id: string, login: string | null): number {
  const wanted = login?.toLowerCase() ?? null;
  return events.filter(
    (event): boolean =>
      event.nodeId === id || (wanted !== null && event.nodeId === null && event.login?.toLowerCase() === wanted),
  ).length;
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
