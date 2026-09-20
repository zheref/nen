// src/pr/threads.ts -- `nen pr threads list|reply|resolve` (zheref/nen#215):
// reading a pull request's review threads, answering one, and resolving one.
//
// WHY THIS IS NOT `gh pr comment`. A review THREAD is not a PR comment and not
// a review: it is a conversation anchored to a file and a line, it has a
// resolution state that exists only over GraphQL, and replying to one means
// `addPullRequestReviewThreadReply` against the thread's node id. Every driving
// loop that has to answer Copilot's eight threads has, until now, done it by
// hand or by a shell one-liner per thread -- which is how a reply lands on the
// wrong thread, and how "resolved" gets claimed for a thread nobody answered.
//
// THE LIST IS ./fetch.ts's WALK, WIDENED -- ITS DISCIPLINE, NOT ITS CODE, AND
// THE DIFFERENCE IS DELIBERATE. That module reads `reviewThreads` to completion
// with a fail-closed cursor loop for the READINESS GATE, whose `ReviewThread`
// carries two fields (`id`, `isResolved`) and goes through ../github/parse.ts's
// boundary validation, because a thread that will not parse must fail CON-32(d)
// rather than vanish from it. This verb needs a wider row -- `path`, `line`, and
// the first comment's author, body and url -- for a human to read and a driving
// loop to answer. Widening the gate's query to carry display fields would put
// three optional strings inside the one fetch whose failure mode is a false
// green, so the query lives here instead and the WALK'S RULE is restated
// verbatim: only the literal boolean `false` ends it, and every other outcome
// throws. The two must agree about how many threads exist, and they do, because
// they ask `reviewThreads(first:100)` the same way and neither stops early.
//
// EVERY MUTATION TAKES A THREAD ID, NEVER A POSITION. `--thread <id>` is the
// GraphQL node id `list` printed; there is no `--thread 3` meaning "the third
// one", because the third one changes between the list and the reply the moment
// anybody else comments. A thread id this pull request does not carry is exit 4,
// NAMED, rather than a mutation sent into the dark.
//
// ALREADY-RESOLVED IS EXIT 3 AND SENDS NOTHING. `resolveReviewThread` on a
// resolved thread is a no-op GitHub accepts, which would make this verb answer
// 0 and let a caller record "resolved it" about a thread somebody else closed.
// The distinction is the whole reason the codes go past 2: 0 "I resolved it", 3
// "it was already resolved", 4 "no such thread", 5 "I could not authenticate",
// 1 "the API refused", 2 "you typed it wrong".
//
// `--dry-run` PRINTS THE ARGV AND WRITES NOTHING, and it prints the argv that
// WOULD have run rather than a description of it -- the same shape
// ./editbody.ts uses. A dry run whose printed command differs from the real one
// is a dry run that proves nothing.
//
// EVERY `gh api` ARGV NAMES ITS `--method` EXPLICITLY. ./fetch.ts's module
// header states the whole incident (zheref/nen#19) and its sweep test holds the
// invariant over that module's builders; these builders follow the same rule
// for the same reason, and the mutations say POST because they ARE writes.

import { plainLine } from "../cli/plain.js";
import type { Target } from "../github/target.js";
import { GH, outputLines, type Seams } from "../seam/exec.js";
import { renderArgv } from "../shu/render.js";

export const THREADS_CONTRACT = "nen.pr.threads/v0.1";

/** How much of a thread's opening comment the list carries. */
export const FIRST_COMMENT_CHARS = 200;

export interface ThreadRow {
  readonly id: string;
  readonly isResolved: boolean;
  /** The file the thread is anchored to, or the empty string for an outdated one. */
  readonly path: string;
  /** The line, or `null` when GitHub reports none (an outdated diff hunk). */
  readonly line: number | null;
  readonly author: string;
  /** The first comment's body, cut to `FIRST_COMMENT_CHARS`. */
  readonly firstComment: string;
  readonly url: string;
}

/** Why a threads call stopped. The exit code is the caller's to return. */
export type ThreadsFailure = "not-found" | "auth" | "api" | "already-resolved";

export class ThreadsError extends Error {
  readonly kind: ThreadsFailure;
  constructor(kind: ThreadsFailure, message: string) {
    super(message);
    this.name = "ThreadsError";
    this.kind = kind;
  }
}

/** The exit code each failure answers with. See the module header. */
export const EXIT_FOR: Readonly<Record<ThreadsFailure, number>> = {
  api: 1,
  "already-resolved": 3,
  "not-found": 4,
  auth: 5,
};

// ── the query ───────────────────────────────────────────────────────────────

const THREAD_FIELDS =
  "id isResolved path line comments(first:1){nodes{author{login} body url}}";

const LIST_QUERY = `query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100){nodes{${THREAD_FIELDS}} pageInfo{hasNextPage endCursor}}}}}`;

const LIST_PAGE_QUERY = `query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){headRefOid reviewThreads(first:100,after:$cursor){nodes{${THREAD_FIELDS}} pageInfo{hasNextPage endCursor}}}}}`;

/** ./fetch.ts's own backstop, restated for the same reason: 50 pages = 5000 threads. */
const MAX_PAGES = 50;

export function listArgv(target: Target, prNumber: number): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${LIST_QUERY}`,
    // See `listPageArgv` below for why the String! variables take `-f` and the
    // one Int! takes `-F` (Feitan F6).
    "-f",
    `owner=${target.owner}`,
    "-f",
    `name=${target.repo}`,
    "-F",
    `number=${prNumber}`,
  ];
}

export function listPageArgv(target: Target, prNumber: number, cursor: string): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${LIST_PAGE_QUERY}`,
    // `-f` FOR THE STRING VARIABLES, `-F` FOR THE NUMBER (Feitan F6). gh's
    // `-F` is the TYPED form: it coerces a value that looks like a number, a
    // boolean or null, and it reads a leading `@` as a FILE to slurp. `owner`,
    // `name` and `cursor` are `String!` in the query, and a cursor is an opaque
    // base64 token nen never inspects -- one that begins with `@` would make gh
    // try to open a file, and one that is all digits would be sent as an Int
    // against a String! variable and rejected by the server. `number` is the
    // one genuine `Int!`, so it keeps `-F`.
    "-f",
    `owner=${target.owner}`,
    "-f",
    `name=${target.repo}`,
    "-F",
    `number=${prNumber}`,
    "-f",
    `cursor=${cursor}`,
  ];
}

const REPLY_MUTATION =
  "mutation($threadId:ID!,$body:String!){addPullRequestReviewThreadReply(input:{pullRequestReviewThreadId:$threadId,body:$body}){comment{id url}}}";

const RESOLVE_MUTATION =
  "mutation($threadId:ID!){resolveReviewThread(input:{threadId:$threadId}){thread{id isResolved}}}";

export function replyArgv(threadId: string, body: string): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${REPLY_MUTATION}`,
    "-f",
    `threadId=${threadId}`,
    "-f",
    `body=${body}`,
  ];
}

export function resolveArgv(threadId: string): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${RESOLVE_MUTATION}`,
    "-f",
    `threadId=${threadId}`,
  ];
}

// ── running them ────────────────────────────────────────────────────────────

/**
 * Whether gh's own stderr says the credential is the problem.
 *
 * A HEURISTIC, NAMED AS ONE, AND DELIBERATELY NARROW. gh reports an expired or
 * absent token half a dozen ways and none of them is a code this process can
 * read, so the alternative to matching its words is reporting every failure as
 * the same exit 1 -- which is what makes a loop retry a token problem forever.
 * The phrases below are the ones gh and GitHub actually print; anything else
 * stays `api` (exit 1), because over-claiming "auth" would send a caller to
 * re-login over an outage.
 */
export function looksLikeAuthFailure(stderr: string): boolean {
  return /gh auth login|not logged into|bad credentials|requires authentication|HTTP 401|token has not been granted|insufficient|SAML enforcement/i.test(
    stderr,
  );
}

function runGraphql(seams: Seams, args: readonly string[], what: string): unknown {
  const result = seams.run(GH, [...args]);
  if (result.spawnFailed) {
    throw new ThreadsError("api", `could not run gh for ${what}: ${result.stderr}`);
  }
  const stderr = outputLines(result.stderr).join(" ");
  if (result.code !== 0) {
    throw new ThreadsError(
      looksLikeAuthFailure(`${stderr}\n${result.stdout}`) ? "auth" : "api",
      `${what} failed: ${stderr || `exit ${result.code}`}`,
    );
  }
  let parsed: { data?: unknown; errors?: unknown };
  try {
    parsed = JSON.parse(result.stdout) as typeof parsed;
  } catch (error) {
    throw new ThreadsError("api", `${what}: gh api graphql did not return JSON (${String(error)})`);
  }
  // A GraphQL 200 CARRYING `errors` IS A FAILURE, and this is the one transport
  // where that has to be said out loud: GitHub answers a refused mutation with
  // HTTP 200 and an `errors` array, so a caller reading only the exit code
  // records "replied" for a reply that never posted.
  if (Array.isArray(parsed.errors) && parsed.errors.length > 0) {
    const message = parsed.errors
      .map((entry): string => String((entry as { message?: unknown }).message ?? entry))
      .join("; ");
    throw new ThreadsError(looksLikeAuthFailure(message) ? "auth" : "api", `${what}: ${message}`);
  }
  return parsed.data;
}

interface ThreadsPage {
  readonly headRefOid: string;
  readonly nodes: readonly unknown[];
  readonly hasNextPage: unknown;
  readonly endCursor: unknown;
}

function page(data: unknown, what: string): ThreadsPage {
  const pr = (data as { repository?: { pullRequest?: unknown } } | null)?.repository?.pullRequest as
    | {
        headRefOid?: unknown;
        reviewThreads?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
      }
    | null
    | undefined;
  if (pr === null || pr === undefined) {
    throw new ThreadsError("not-found", `${what}: the repository or the pull request does not exist, or is not visible to this credential.`);
  }
  const field = pr.reviewThreads;
  if (!Array.isArray(field?.nodes)) {
    throw new ThreadsError("api", `${what}: the response carried no reviewThreads.nodes array.`);
  }
  return {
    headRefOid: String(pr.headRefOid ?? ""),
    nodes: field?.nodes as readonly unknown[],
    hasNextPage: field?.pageInfo?.hasNextPage,
    endCursor: field?.pageInfo?.endCursor,
  };
}

function rowOf(node: unknown): ThreadRow {
  const thread = (node ?? {}) as {
    id?: unknown;
    isResolved?: unknown;
    path?: unknown;
    line?: unknown;
    comments?: { nodes?: readonly { author?: { login?: unknown }; body?: unknown; url?: unknown }[] };
  };
  const first = thread.comments?.nodes?.[0];
  const body = typeof first?.body === "string" ? first.body : "";
  return {
    id: String(thread.id ?? ""),
    // NOT `?? true`, EVER. ./fetch.ts's ReviewThread comment states the rule:
    // a resolution this process could not establish must never read as
    // resolved, because "resolved" is the value that clears a gate.
    isResolved: thread.isResolved === true,
    path: typeof thread.path === "string" ? thread.path : "",
    line: typeof thread.line === "number" ? thread.line : null,
    author: typeof first?.author?.login === "string" ? first.author.login : "",
    firstComment: body.length > FIRST_COMMENT_CHARS ? `${body.slice(0, FIRST_COMMENT_CHARS)}…` : body,
    url: typeof first?.url === "string" ? first.url : "",
  };
}

export interface ThreadsListing {
  readonly head: string;
  readonly threads: readonly ThreadRow[];
}

/**
 * Every review thread, paginated to completion.
 *
 * FAILS CLOSED, exactly as ./fetch.ts's walk does: only the literal boolean
 * `false` for `hasNextPage` ends it, and a page that neither ends the walk nor
 * carries a usable cursor is an error rather than a stopping point. A partial
 * list handed to a caller about to reply to "every unresolved thread" is the
 * same false-green shape one layer along.
 */
export function listThreads(seams: Seams, target: Target, prNumber: number): ThreadsListing {
  const what = `${target.slug}#${prNumber} review threads`;
  let current = page(runGraphql(seams, listArgv(target, prNumber), what), what);
  const head = current.headRefOid;
  const rows: ThreadRow[] = [];
  for (let pageNum = 1; ; pageNum += 1) {
    rows.push(...current.nodes.map(rowOf));
    if (current.hasNextPage === false) break;
    if (pageNum >= MAX_PAGES) {
      throw new ThreadsError("api", `${what}: hit the ${MAX_PAGES}-page pagination cap before hasNextPage went false`);
    }
    const cursor = current.endCursor;
    if (typeof cursor !== "string" || cursor === "") {
      throw new ThreadsError(
        "api",
        `${what}: page ${pageNum} did not answer hasNextPage:false but carried no usable cursor -- an unreadable hasNextPage must not be treated as the end of the walk`,
      );
    }
    current = page(runGraphql(seams, listPageArgv(target, prNumber, cursor), what), what);
  }
  return { head, threads: rows };
}

/**
 * The thread `--thread` names, or exit 4 NAMING IT.
 *
 * THE LOOKUP IS A FULL LIST, and it is not wasted work: it is what makes
 * "already resolved" (exit 3) and "no such thread" (exit 4) two different
 * answers instead of one GraphQL error, and it is what lets `--dry-run` be
 * truthful about a thread that does not exist.
 */
export function requireThread(listing: ThreadsListing, threadId: string, slug: string, prNumber: number): ThreadRow {
  const thread = listing.threads.find((row): boolean => row.id === threadId);
  if (thread === undefined) {
    throw new ThreadsError(
      "not-found",
      `${slug}#${prNumber} carries no review thread with id '${threadId}'. The id is the GraphQL node id 'nen pr threads list' prints, never a position -- the third thread stops being the third one the moment anybody comments. This pull request has ${listing.threads.length} thread(s).`,
    );
  }
  return thread;
}

export interface ThreadsReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  readonly head: string;
  /** The thread acted on, or `null` for `list`. */
  readonly thread: string | null;
  readonly replied: boolean;
  readonly resolved: boolean;
  readonly dryRun: boolean;
  /** `list`'s rows; empty for the two mutations. */
  readonly threads: readonly ThreadRow[];
  /**
   * The exact `gh api graphql` argv the mutation ran, or WOULD have run under
   * `--dry-run`. `null` for `list`, which runs no mutation.
   *
   * APPENDED AT THE END OF THE KEY ORDER (Nobunaga N9). The human rendering has
   * always printed this line, and a `--dry-run` whose whole purpose is "show me
   * what you would send" was answering `--json` without the one field that says
   * it -- so a caller scripting the dry run had to parse the human output or
   * rebuild the argv themselves, which is how two spellings of one command
   * start to drift.
   */
  readonly argv: readonly string[] | null;
}

/**
 * WHY A MUTATION'S PAYLOAD IS READ, AND NOT JUST ITS `errors` (Copilot, #221
 * round 3).
 *
 * `runGraphql` already refuses an `errors` array on an HTTP 200, which is how
 * GitHub reports a REFUSED mutation. What it cannot see is a mutation that was
 * ACCEPTED and did nothing: a `data.addPullRequestReviewThreadReply` of `null`,
 * a `resolveReviewThread` whose thread comes back still unresolved, a payload
 * for a different thread. Each of those is a 200 with no `errors`, and each was
 * being reported as `replied: true` / `resolved: true` -- the verb telling a
 * caller it posted a reply that does not exist.
 *
 * SO SUCCESS IS READ OFF THE THING THAT WAS SUPPOSED TO CHANGE. A reply
 * succeeded when the comment it created has an id; a resolve succeeded when the
 * thread it names comes back `isResolved: true` AND is the thread that was
 * asked about. Anything else is an API error (exit 1) naming what came back --
 * never a cheerful zero.
 */
function mutationPayload(data: unknown, field: string, what: string): Record<string, unknown> {
  const payload = (data as Record<string, unknown> | null | undefined)?.[field];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new ThreadsError(
      "api",
      `${what}: the mutation was accepted and answered no '${field}' payload (${payload === null ? "null" : typeof payload}), so nothing can be confirmed to have changed. Nothing is reported as done.`,
    );
  }
  return payload as Record<string, unknown>;
}

export function reply(
  seams: Seams,
  target: Target,
  prNumber: number,
  listing: ThreadsListing,
  threadId: string,
  body: string,
  dryRun: boolean,
): { readonly argv: readonly string[]; readonly replied: boolean } {
  requireThread(listing, threadId, target.slug, prNumber);
  const argv = replyArgv(threadId, body);
  if (dryRun) return { argv, replied: false };
  const what = `${target.slug}#${prNumber} thread reply`;
  const payload = mutationPayload(runGraphql(seams, argv, what), "addPullRequestReviewThreadReply", what);
  const comment = payload["comment"];
  const id =
    typeof comment === "object" && comment !== null ? (comment as { id?: unknown }).id : undefined;
  if (typeof id !== "string" || id === "") {
    throw new ThreadsError(
      "api",
      `${what}: the mutation was accepted and named no created comment, so the reply cannot be confirmed to have posted. Re-read the thread with 'nen pr threads list' before sending it again -- this verb will not report a reply it cannot see.`,
    );
  }
  return { argv, replied: true };
}

export function resolve(
  seams: Seams,
  target: Target,
  prNumber: number,
  listing: ThreadsListing,
  threadId: string,
  dryRun: boolean,
): { readonly argv: readonly string[]; readonly resolved: boolean } {
  const thread = requireThread(listing, threadId, target.slug, prNumber);
  if (thread.isResolved) {
    throw new ThreadsError(
      "already-resolved",
      `${target.slug}#${prNumber} thread '${threadId}' is already resolved; nothing was sent. GitHub accepts resolveReviewThread on a resolved thread as a no-op, which would let this verb answer 0 and let you record having resolved a thread somebody else closed.`,
    );
  }
  const argv = resolveArgv(threadId);
  if (dryRun) return { argv, resolved: false };
  const what = `${target.slug}#${prNumber} thread resolve`;
  const payload = mutationPayload(runGraphql(seams, argv, what), "resolveReviewThread", what);
  const answered = payload["thread"];
  if (typeof answered !== "object" || answered === null) {
    throw new ThreadsError(
      "api",
      `${what}: the mutation was accepted and named no thread, so the resolution cannot be confirmed. Nothing is reported as resolved.`,
    );
  }
  const record = answered as { id?: unknown; isResolved?: unknown };
  // THE ANSWER MUST BE ABOUT THE THREAD THAT WAS ASKED ABOUT. A payload naming
  // another id is not this thread's resolution, however true it is.
  if (typeof record.id === "string" && record.id !== threadId) {
    throw new ThreadsError(
      "api",
      `${what}: the mutation answered for thread '${record.id}', which is not the thread '${threadId}' it was sent for. Nothing is reported as resolved.`,
    );
  }
  if (record.isResolved !== true) {
    throw new ThreadsError(
      "api",
      `${what}: the mutation was accepted and the thread came back isResolved:${String(record.isResolved)}. A resolve that did not resolve is not a success, and this verb will not report one.`,
    );
  }
  return { argv, resolved: true };
}

/**
 * One mutation argv, rendered for a `would run:` / `ran:` line.
 *
 * THE BODY IS SUMMARISED, NOT PRINTED (Nobunaga N4). A reply body is a file
 * somebody wrote: it is routinely multi-line, and dropping it into a single
 * `would run:` line both breaks the line and puts un-quoted text -- `$(…)`,
 * backticks, a newline -- where a reader is being invited to copy and paste.
 * Two different mistakes, one fix: the body element becomes its byte count and
 * its first line, and every OTHER element goes through ../shu/render.ts's
 * `renderArgv`, which is the quoting this repository already uses for exactly
 * this line ("the thing you approve is the thing that runs"). The FULL argv,
 * unsummarised, is in `--json`'s `argv` for a caller that wants it.
 */
export function printableArgv(argv: readonly string[]): string {
  const shown = argv.map((token): string => {
    if (!token.startsWith("body=")) return token;
    const body = token.slice("body=".length);
    const first = body.split(/\r?\n/)[0] ?? "";
    const bytes = Buffer.byteLength(body, "utf8");
    const elided = first.length > 60 ? `${first.slice(0, 60)}…` : first;
    return `body=<${bytes} byte(s); first line: ${plainLine(elided)}${body.includes("\n") ? " …" : ""}>`;
  });
  return renderArgv({ exe: "gh", argv: shown });
}

/**
 * A head SHA fit to print, or the words that say there is not one.
 *
 * VALIDATED BEFORE IT IS TRUNCATED (Copilot, #221 round 3). The summary line
 * took the first eight characters of whatever `headRefOid` held -- a field
 * this module reads leniently -- so a value that was not a SHA was printed as
 * though it were one, and a control character in it reached the terminal
 * intact. Eight characters of something else is indistinguishable from a real
 * short SHA, which is worse than saying nothing: a reader copies it.
 */
function shortHead(head: string): string {
  return /^[0-9a-f]{40}$/i.test(head) ? head.slice(0, 8) : "unknown head";
}

/** The human lines `list` prints. */
export function renderThreads(report: ThreadsReport): readonly string[] {
  const unresolved = report.threads.filter((thread): boolean => !thread.isResolved).length;
  const lines = [
    `${plainLine(report.target)}#${report.pr} @ ${shortHead(plainLine(report.head))}: ${report.threads.length} review thread(s), ${unresolved} unresolved`,
  ];
  for (const thread of report.threads) {
    // A PATH, AN AUTHOR AND A COMMENT ARE ALL STRINGS SOMEBODY ELSE TYPED, and
    // a terminal executes a control character rather than printing it (Feitan
    // F4). `--json` above carries the bytes unchanged.
    lines.push(
      `  ${thread.isResolved ? "resolved  " : "UNRESOLVED"}  ${plainLine(thread.id)}  ${plainLine(thread.path)}${thread.line === null ? "" : `:${thread.line}`}  @${plainLine(thread.author)}`,
    );
    if (thread.firstComment !== "") lines.push(`      ${plainLine(thread.firstComment)}`);
  }
  return lines;
}
