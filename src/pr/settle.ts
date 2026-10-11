// src/pr/settle.ts -- `nen pr threads settle` (zheref/nen#230): reply to and
// resolve a BATCH of review threads from one file, walking the thread list
// once.
//
// WHY A BATCH AT ALL. Settling a reviewer round with the single-thread verbs is
// `reply` then `resolve` per thread, and each of those walks the pull request's
// whole thread list before its one mutation -- 4N calls for N threads, and a
// shell loop improvised fresh every round. This walks once and sends 2N
// mutations: 2N + P (P = pages of 100 threads, 1 for most pull requests)
// where the loop costs 4N.
//
// THE FILE IS VALIDATED IN FULL BEFORE ANY MUTATION, and every problem is
// named in ONE refusal (exit 2), not the first one found. A malformed entry,
// an unreadable `bodyFile`, an empty body, a duplicated thread id, and -- once
// the single walk has run -- an id this pull request does not carry: each is a
// batch nobody can settle as written, and a batch half-sent before the typo on
// entry nine was noticed is exactly the partial settlement this verb exists to
// prevent. An unknown id is exit 2 here, where the single-thread verbs answer
// 4: in a batch it is a defect in the FILE, refused before anything is sent,
// not the outcome of a mutation.
//
// ALREADY-RESOLVED IS A PER-ENTRY DISPOSITION, NOT A REFUSAL. ./threads.ts's
// `resolve` answers exit 3 with nothing sent for a thread somebody else
// closed; here that same fact is reported against the entry that named it --
// nothing is sent to that thread, neither the reply nor the resolve -- and the
// rest of the batch proceeds. The batch then exits 3 (the single verb's code
// for the same fact) when everything else settled, so a caller does not
// record "I resolved it" about a thread the walk's snapshot showed somebody
// else had resolved. PER THE WALK'S SNAPSHOT, and only that: a thread resolved
// between the walk and its own mutation is not seen (GitHub accepts the
// resolve as a no-op) -- the same window `resolve` has between its list and
// its mutation.
//
// A FAILURE PARTWAY THROUGH STOPS, AND SAYS EXACTLY WHERE. Mutations are sent
// in file order, reply then resolve per thread. The first refused mutation
// stops the batch: every entry after it is `not-attempted`, and the report
// names which threads were replied to and resolved, which was replied to and
// NOT resolved, and which were never touched. Nothing is retried -- a retry of
// a reply whose acceptance could not be confirmed is a second public comment.
// The exit code is the single verbs' for the failure that stopped it (1 the
// API refused, 5 the credential could not authenticate).
//
// EVERY GUARD THE SINGLE-THREAD VERBS HAVE IS THEIRS, NOT A COPY. Each
// mutation goes through ./threads.ts's own `reply` and `resolve`, so the
// payload reads (a reply must name the comment it created; a resolve must
// come back `isResolved: true` for the thread it was sent for) are the ones
// those verbs already prove.

import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve as resolvePath, sep } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { redactRemoteCredentials } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import {
  printableArgv,
  reply as replyToThread,
  replyArgv,
  resolve as resolveThread,
  resolveArgv,
  ThreadsError,
  type ThreadsListing,
} from "./threads.js";

export const SETTLE_CONTRACT = "nen.pr.threads-settle/v0.1";

/** One validated entry of the `--from` file. */
export interface SettleEntry {
  readonly thread: string;
  /** The reply's bytes, exactly as they will be sent. */
  readonly body: string;
  /** `inline`, or the absolute path the body was read from. */
  readonly bodyFrom: string;
}

/**
 * What happened to one entry.
 *
 * `resolved` replied and resolved · `replied` replied, and the resolve was the
 * mutation that failed · `already-resolved` nothing sent, somebody else closed
 * it · `failed` the reply was the mutation that failed, nothing confirmed sent
 * · `not-attempted` after the batch stopped · `planned` a dry run.
 */
export type SettleDisposition = "resolved" | "replied" | "already-resolved" | "failed" | "not-attempted" | "planned";

/** KEY ORDER IS THE CONTRACT; ./settle.test.ts pins it. */
export interface SettleOutcome {
  readonly thread: string;
  readonly disposition: SettleDisposition;
  readonly replied: boolean;
  readonly resolved: boolean;
  readonly bodyBytes: number;
  readonly bodyFrom: string;
  /** The full reply argv sent (or, under `--dry-run`, that would be); null when none would be. */
  readonly replyArgv: readonly string[] | null;
  readonly resolveArgv: readonly string[] | null;
  /** The failure that stopped the batch at this entry, else null. */
  readonly error: string | null;
}

/** KEY ORDER IS THE CONTRACT; ./settle.test.ts pins it. */
export interface SettleReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  readonly head: string;
  readonly from: string;
  readonly dryRun: boolean;
  /** True when every entry was settled (or, on a dry run, planned) and none stopped the batch. */
  readonly ok: boolean;
  /** The thread the batch stopped at, or null. */
  readonly stoppedAt: string | null;
  readonly entries: readonly SettleOutcome[];
}

const ENTRY_KEYS = new Set(["thread", "body", "bodyFile"]);

/**
 * The most characters (UTF-16 code units, JavaScript's `length`) one reply
 * body may carry -- GitHub's own comment limit. Checked in the all-problems
 * pass for an inline body and a `bodyFile` alike (Feitan F2), so no oversize
 * body reaches a mutation.
 */
export const MAX_BODY_CHARS = 65536;

/**
 * The most bytes a `bodyFile` may hold before it is read at all. A body within
 * the limit is at most 3 UTF-8 bytes per UTF-16 code unit -- 196608 bytes --
 * so this cap (4 per unit) is looser than it needs to be, never tighter: the
 * character count after the read is the limit that binds.
 */
const MAX_BODY_FILE_BYTES = MAX_BODY_CHARS * 4;

/** `realpath`, injectable so a test can swap a file for a symlink between the check and the open. */
export type Realpath = (path: string) => string;

/** The `open` flags every file this verb reads is opened with: never blocking, never following a final symlink. */
function readFlags(): number {
  return process.platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOFOLLOW;
}

/**
 * Whether a body carries a credential's shape, by CONTENT. This is the one
 * content-based shape nen already has -- ../seam/exec.ts's
 * `redactRemoteCredentials` (a GitHub token, a fine-grained PAT, a URL's
 * `user:secret@`) -- reused rather than duplicated: a body it would redact is
 * a body that would publish a credential. It is NOT a general secret scanner
 * (no cloud keys, no private-key blocks); that is a separate tool nen does
 * not have.
 */
function carriesCredential(body: string): boolean {
  return redactRemoteCredentials(body) !== body;
}

/** A character a terminal or a GraphQL id has no business carrying. */
const CONTROL = /[\u0000-\u001F\u007F-\u009F]/;

/** The validated batch, and the REAL directory every `bodyFile` was confined to. */
export interface SettleBatch {
  readonly entries: readonly SettleEntry[];
  readonly baseDir: string;
}

/** Whether any segment of a relative path starts with `.` (a lone `.` excepted). */
function hidden(path: string): boolean {
  return path.split(/[\\/]/).some((segment): boolean => segment.startsWith(".") && segment !== ".");
}

/**
 * One `bodyFile`, CONFINED TO THE BATCH FILE'S DIRECTORY (Feitan F1, Nobunaga
 * N2), or the problem that refuses it.
 *
 * WHY CONFINED. The body is posted PUBLICLY under the caller's identity, and
 * `nen *` runs without a prompt where it is allowlisted -- so a batch file that
 * could name `/etc/…`, `../../.ssh/id_ed25519`, a symlink out of its
 * directory, `/dev/stdin` or a FIFO would turn "settle these threads" into
 * "publish this local file", with nobody asked. So: an absolute path and any
 * `..` segment are refused outright; the path is `realpath`ed and must still
 * sit inside the batch file's own real directory (a symlink that escapes is
 * refused by where it LANDS, not what it is called); the file is opened
 * non-blocking (a FIFO must not hang the verb), `fstat`ed THROUGH THE
 * DESCRIPTOR it is read from, and must be a regular file no larger than the
 * body limit allows.
 *
 * NOR A FILE IN THE DIRECTORY NOBODY MEANT TO NAME (Feitan F4). A path segment
 * starting with `.` -- `.env`, `.git/config`, `.npmrc` -- is refused, in the
 * name given AND in the real path it resolves to (a plain-named symlink to
 * `.env` is refused too); a lone `.` segment names nothing hidden and is let
 * through. A file with more than one hard link is refused: a hard link to a
 * file outside the directory is indistinguishable from it by path.
 *
 * WHAT IS GUARANTEED, AND THE WINDOW THAT REMAINS (Feitan F5, Nobunaga R2-1).
 * Between `realpath` and `open` the path can be swapped. So the open refuses
 * to follow a FINAL symlink (`O_NOFOLLOW`), and after `fstat` the descriptor's
 * `dev`/`ino` must equal `lstat(real)`'s, `lstat(real)` must not be a symlink,
 * and `realpath(real)` must still be `real`. That guarantees the bytes read
 * are those of a regular, singly-linked file that sat at `real` -- inside the
 * directory -- when those checks ran. It does NOT guarantee against an
 * attacker who can rewrite the DIRECTORY components above `real` between the
 * open and the re-checks and restore them after: Node has no `openat`, so no
 * component-by-component open is available here. Whoever can do that already
 * writes into the batch's directory, and could edit the batch itself. On
 * win32 the open follows links and the re-checks are the guard.
 */
function readBodyFile(value: string, realBase: string, realpath: Realpath): { readonly body: string; readonly real: string } | { readonly problem: string } {
  const shown = plainLine(value);
  if (isAbsolute(value) || /^[\\/]/.test(value) || /^[A-Za-z]:/.test(value)) {
    return { problem: `'bodyFile' '${shown}' is absolute; a bodyFile is a path RELATIVE to the batch file's own directory, and may not leave it.` };
  }
  if (value.split(/[\\/]/).includes("..")) {
    return { problem: `'bodyFile' '${shown}' carries a '..' segment; a bodyFile may not leave the batch file's own directory.` };
  }
  if (hidden(value)) {
    return { problem: `'bodyFile' '${shown}' names a dot-file or dot-directory (.env, .git/config, .npmrc ...); those are never read as a reply.` };
  }
  let real: string;
  try {
    real = realpath(resolvePath(realBase, value));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: `could not read bodyFile '${shown}'${code === undefined ? "" : ` (${code})`}.` };
  }
  if (real !== realBase && !real.startsWith(realBase.endsWith(sep) ? realBase : `${realBase}${sep}`)) {
    return { problem: `'bodyFile' '${shown}' resolves to '${plainLine(real)}', outside the batch file's directory '${plainLine(realBase)}' (a symlink that escapes it is refused by where it lands).` };
  }
  if (hidden(relative(realBase, real))) {
    return { problem: `'bodyFile' '${shown}' resolves to a dot-file or dot-directory ('${plainLine(relative(realBase, real))}'); those are never read as a reply.` };
  }
  let fd: number;
  try {
    fd = openSync(real, readFlags());
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: `could not open bodyFile '${shown}'${code === undefined ? "" : ` (${code})`}.` };
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) {
      return { problem: `'bodyFile' '${shown}' is not a regular file (a directory, a device, a FIFO or a socket is never read as a reply).` };
    }
    if (stat.nlink > 1) {
      return { problem: `'bodyFile' '${shown}' has ${stat.nlink} hard links; a hard-linked file may be a file outside the directory under another name, and is never read as a reply.` };
    }
    const there = lstatSync(real);
    if (there.isSymbolicLink() || there.dev !== stat.dev || there.ino !== stat.ino || realpath(real) !== real) {
      return { problem: `'bodyFile' '${shown}' changed between its check and its open ('${plainLine(real)}' is no longer the file that was opened); it was not read.` };
    }
    if (stat.size > MAX_BODY_FILE_BYTES) {
      return { problem: `'bodyFile' '${shown}' is ${stat.size} bytes, more than a ${MAX_BODY_CHARS}-character body can be; it was not read.` };
    }
    return { body: readFileSync(fd, "utf8"), real };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return { problem: `could not read bodyFile '${shown}'${code === undefined ? "" : ` (${code})`}.` };
  } finally {
    closeSync(fd);
  }
}

/** The most bytes a `--from` batch file may hold: far past any real round, short of exhausting memory. */
export const MAX_BATCH_FILE_BYTES = 4 * 1024 * 1024;

/**
 * The `--from` file's text, read with `readBodyFile`'s discipline: opened
 * non-blocking (a FIFO must not hang the verb), `fstat`ed through the
 * descriptor it is then read from, required to be a regular file, and capped
 * at `MAX_BATCH_FILE_BYTES` before it is read -- so `/dev/zero`, a FIFO or a
 * directory given as `--from` is a named refusal (exit 2), never a hang or an
 * unbounded read.
 */
function readBatchFile(fullPath: string, shownPath: string): string {
  const refuse = (what: string): never => {
    throw new VerbUsageError(
      `could not read --from '${shownPath}': ${what}. It is the batch of replies this verb posts, so it is refused before anything is sent.`,
    );
  };
  let fd: number;
  try {
    fd = openSync(fullPath, process.platform === "win32" ? fsConstants.O_RDONLY : fsConstants.O_RDONLY | fsConstants.O_NONBLOCK);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return refuse(code === undefined ? "it could not be opened" : `it could not be opened (${code})`);
  }
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile()) return refuse("it is not a regular file (a directory, a device, a FIFO or a socket is never read as a batch)");
    if (stat.size > MAX_BATCH_FILE_BYTES) return refuse(`it is ${stat.size} bytes, over the ${MAX_BATCH_FILE_BYTES}-byte limit for a batch file; it was not read`);
    try {
      return readFileSync(fd, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      return refuse(code === undefined ? "it could not be read" : `it could not be read (${code})`);
    }
  } finally {
    closeSync(fd);
  }
}

/**
 * The `--from` file, read and validated IN FULL. Every problem is collected
 * and the whole list refused once (exit 2): a caller fixing a batch should not
 * have to discover its problems one run at a time.
 *
 * `bodyFile` RESOLVES AGAINST THE FILE'S OWN DIRECTORY, AND STAYS THERE --
 * `readBodyFile` above says why and how. The body is read RAW -- the bytes on
 * disk are the bytes posted, as `reply --body-file` reads them. Every
 * fragment of the file echoed into a refusal goes through `plainLine`
 * (Feitan F3): the file is text somebody else may have written.
 */
export function readSettleFile(fullPath: string, realpath: Realpath = realpathSync): SettleBatch {
  const shownPath = plainLine(fullPath);
  const text = readBatchFile(fullPath, shownPath);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new VerbUsageError(
      `--from '${shownPath}' is not JSON (${plainLine(error instanceof Error ? error.message : String(error))}). It must be an array of { "thread": "<id>", "body": "<text>" } or { "thread": "<id>", "bodyFile": "<path>" }. Nothing was sent.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new VerbUsageError(
      `--from '${shownPath}' must hold a JSON ARRAY of { "thread", "body" | "bodyFile" } entries; it holds ${parsed === null ? "null" : typeof parsed}. Nothing was sent.`,
    );
  }
  if (parsed.length === 0) {
    throw new VerbUsageError(`--from '${shownPath}' is an empty array: there is nothing to settle, and an empty batch is never assumed to be what was meant.`);
  }

  let realBase: string;
  try {
    realBase = realpath(dirname(fullPath));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new VerbUsageError(
      `could not resolve the directory of --from '${shownPath}'${code === undefined ? "" : ` (${code})`}; every bodyFile is confined to it, so nothing was sent.`,
    );
  }
  const problems: string[] = [];
  const entries: SettleEntry[] = [];
  const firstSeen = new Map<string, number>();
  parsed.forEach((raw: unknown, index: number): void => {
    const at = `entry ${index}`;
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
      problems.push(`${at}: not an object.`);
      return;
    }
    const record = raw as Record<string, unknown>;
    const unknownKeys = Object.keys(record).filter((key): boolean => !ENTRY_KEYS.has(key));
    if (unknownKeys.length > 0) {
      problems.push(`${at}: unknown key(s) ${unknownKeys.map((key): string => `'${plainLine(key)}'`).join(", ")} -- an entry carries 'thread' and exactly one of 'body' or 'bodyFile'.`);
    }
    const thread = record["thread"];
    let threadOk = false;
    if (typeof thread !== "string" || thread.trim() === "") {
      problems.push(`${at}: 'thread' must be a non-empty string -- the GraphQL node id 'nen pr threads list' prints, never a position.`);
    } else if (CONTROL.test(thread)) {
      problems.push(`${at}: 'thread' '${plainLine(thread)}' carries a control character; no GraphQL node id does.`);
    } else if (thread !== thread.trim()) {
      problems.push(`${at}: 'thread' '${plainLine(thread)}' carries surrounding whitespace; an id is matched exactly and is never trimmed into another one.`);
    } else {
      threadOk = true;
      const earlier = firstSeen.get(thread);
      if (earlier !== undefined) {
        problems.push(`${at}: thread '${plainLine(thread)}' is already named by entry ${earlier}. One thread, one reply -- a second would post twice under your identity.`);
      } else {
        firstSeen.set(thread, index);
      }
    }
    const hasBody = Object.prototype.hasOwnProperty.call(record, "body");
    const hasBodyFile = Object.prototype.hasOwnProperty.call(record, "bodyFile");
    let body: string | null = null;
    let bodyFrom = "inline";
    if (hasBody && hasBodyFile) {
      problems.push(`${at}: carries both 'body' and 'bodyFile'; give exactly one, so there is no question which bytes are posted.`);
    } else if (!hasBody && !hasBodyFile) {
      problems.push(`${at}: carries neither 'body' nor 'bodyFile'; a reply needs its bytes.`);
    } else if (hasBody) {
      const value = record["body"];
      if (typeof value !== "string") problems.push(`${at}: 'body' must be a string.`);
      else body = value;
    } else {
      const value = record["bodyFile"];
      if (typeof value !== "string" || value.trim() === "") {
        problems.push(`${at}: 'bodyFile' must be a non-empty path string.`);
      } else {
        const read = readBodyFile(value, realBase, realpath);
        if ("problem" in read) {
          problems.push(`${at}: ${read.problem}`);
        } else {
          body = read.body;
          bodyFrom = read.real;
        }
      }
    }
    const where = bodyFrom === "inline" ? "" : ` in '${plainLine(relative(realBase, bodyFrom))}'`;
    if (body !== null && body.trim() === "") {
      problems.push(`${at}: the body${where} is empty (or holds only whitespace). An empty reply is never what a caller meant, and it is never assumed.`);
      body = null;
    } else if (body !== null && body.length > MAX_BODY_CHARS) {
      problems.push(`${at}: the body${where} is ${body.length} characters, over the ${MAX_BODY_CHARS}-character limit GitHub puts on a comment.`);
      body = null;
    } else if (body !== null && carriesCredential(body)) {
      // THE MATCH IS NEVER ECHOED: naming the entry is enough, and printing it
      // would put the credential in a terminal and a log.
      problems.push(`${at}: the body${where} carries a credential's shape (a GitHub token, a fine-grained PAT, or a URL's user:secret@); it would be posted publicly, so it is refused.`);
      body = null;
    }
    if (threadOk && body !== null) entries.push({ thread: thread as string, body, bodyFrom });
  });
  if (problems.length > 0) {
    throw new VerbUsageError(
      `--from '${shownPath}' cannot be settled as written; nothing was sent. ${problems.length} problem(s):\n  ${problems.join("\n  ")}`,
    );
  }
  return { entries, baseDir: realBase };
}

/**
 * Every entry naming a thread the single walk did not find -- refused as a
 * batch (exit 2) before any mutation, each id named.
 */
export function refuseUnknownThreads(listing: ThreadsListing, entries: readonly SettleEntry[], slug: string, prNumber: number): void {
  const known = new Set(listing.threads.map((row): string => row.id));
  const unknown = entries.filter((entry): boolean => !known.has(entry.thread)).map((entry): string => entry.thread);
  if (unknown.length > 0) {
    throw new VerbUsageError(
      `${slug}#${prNumber} carries no review thread with id ${unknown.map((id): string => `'${plainLine(id)}'`).join(", ")}; nothing was sent. Each id is the GraphQL node id 'nen pr threads list' prints for THIS pull request, never a position or another pull request's id. This pull request has ${listing.threads.length} thread(s).`,
    );
  }
}

export interface SettleResult {
  readonly outcomes: readonly SettleOutcome[];
  /** The failure that stopped the batch, or null. */
  readonly failure: ThreadsError | null;
  readonly stoppedAt: string | null;
}

/**
 * Send the batch: reply then resolve, per entry, in file order, stopping at
 * the first refused mutation. `listing` is the ONE walk; `entries` have
 * already passed `readSettleFile` and `refuseUnknownThreads`.
 */
export function settleThreads(
  seams: Seams,
  target: Target,
  prNumber: number,
  listing: ThreadsListing,
  entries: readonly SettleEntry[],
  dryRun: boolean,
): SettleResult {
  const outcomes: SettleOutcome[] = [];
  let failure: ThreadsError | null = null;
  let stoppedAt: string | null = null;
  for (const entry of entries) {
    const row = listing.threads.find((thread): boolean => thread.id === entry.thread);
    const bodyBytes = Buffer.byteLength(entry.body, "utf8");
    const base = { thread: entry.thread, bodyBytes, bodyFrom: entry.bodyFrom };
    if (row?.isResolved === true) {
      outcomes.push({ ...base, disposition: "already-resolved", replied: false, resolved: false, replyArgv: null, resolveArgv: null, error: null });
      continue;
    }
    if (failure !== null) {
      outcomes.push({ ...base, disposition: "not-attempted", replied: false, resolved: false, replyArgv: null, resolveArgv: null, error: null });
      continue;
    }
    if (dryRun) {
      outcomes.push({
        ...base,
        disposition: "planned",
        replied: false,
        resolved: false,
        replyArgv: replyArgv(entry.thread, entry.body),
        resolveArgv: resolveArgv(entry.thread),
        error: null,
      });
      continue;
    }
    let sentReply: readonly string[];
    try {
      sentReply = replyToThread(seams, target, prNumber, listing, entry.thread, entry.body, false).argv;
    } catch (error) {
      if (!(error instanceof ThreadsError)) throw error;
      failure = error;
      stoppedAt = entry.thread;
      outcomes.push({ ...base, disposition: "failed", replied: false, resolved: false, replyArgv: replyArgv(entry.thread, entry.body), resolveArgv: null, error: error.message });
      continue;
    }
    try {
      const sentResolve = resolveThread(seams, target, prNumber, listing, entry.thread, false).argv;
      outcomes.push({ ...base, disposition: "resolved", replied: true, resolved: true, replyArgv: sentReply, resolveArgv: sentResolve, error: null });
    } catch (error) {
      if (!(error instanceof ThreadsError)) throw error;
      failure = error;
      stoppedAt = entry.thread;
      outcomes.push({ ...base, disposition: "replied", replied: true, resolved: false, replyArgv: sentReply, resolveArgv: resolveArgv(entry.thread), error: error.message });
    }
  }
  // Fix the key order to the contract's, whatever order the spreads produced.
  return { outcomes: outcomes.map(ordered), failure, stoppedAt };
}

function ordered(outcome: SettleOutcome): SettleOutcome {
  return {
    thread: outcome.thread,
    disposition: outcome.disposition,
    replied: outcome.replied,
    resolved: outcome.resolved,
    bodyBytes: outcome.bodyBytes,
    bodyFrom: outcome.bodyFrom,
    replyArgv: outcome.replyArgv,
    resolveArgv: outcome.resolveArgv,
    error: outcome.error,
  };
}

/**
 * The batch's exit code: the stopping failure's (the single verbs' table),
 * else 3 when any entry was already resolved, else 0.
 */
export function settleExit(result: SettleResult, exitFor: Readonly<Record<string, number>>): number {
  if (result.failure !== null) return exitFor[result.failure.kind] ?? 1;
  return result.outcomes.some((outcome): boolean => outcome.disposition === "already-resolved") ? 3 : 0;
}

function ids(outcomes: readonly SettleOutcome[], disposition: SettleDisposition): string {
  const found = outcomes.filter((outcome): boolean => outcome.disposition === disposition).map((outcome): string => plainLine(outcome.thread));
  return found.length === 0 ? "none" : found.join(", ");
}

/**
 * The human lines. Every string nen did not write -- an id, a body line, an
 * error GitHub phrased -- goes through `plainLine`; `--json` keeps the bytes.
 *
 * A DRY RUN PRINTS EACH REPLY BODY IN FULL, one `|`-prefixed line per body
 * line, under the two `would run:` lines, because "show me exactly what you
 * would post" is the whole question a dry run answers -- and the `would run:`
 * line summarises the body (./threads.ts's `printableArgv`). Control
 * characters are stripped there as everywhere; `--json`'s `replyArgv` carries
 * the exact bytes.
 *
 * EVERY ENTRY LINE NAMES WHERE ITS BODY CAME FROM (Feitan F1): a `bodyFile`'s
 * REAL path -- after symlinks -- relative to `baseDir`, the batch file's real
 * directory, so a reader sees which file was posted, not only what it was
 * called in the batch.
 */
export function renderSettle(report: SettleReport, baseDir: string): readonly string[] {
  const head = /^[0-9a-f]{40}$/i.test(report.head) ? report.head.slice(0, 8) : "unknown head";
  const settled = report.entries.filter((outcome): boolean => outcome.disposition === "resolved").length;
  const lines = [
    report.dryRun
      ? `${plainLine(report.target)}#${report.pr} @ ${head}: would settle ${report.entries.filter((outcome): boolean => outcome.disposition === "planned").length} of ${report.entries.length} thread(s) from ${plainLine(report.from)} -- dry run, nothing written`
      : `${plainLine(report.target)}#${report.pr} @ ${head}: settled ${settled} of ${report.entries.length} thread(s) from ${plainLine(report.from)}`,
  ];
  for (const outcome of report.entries) {
    const id = `${plainLine(outcome.thread)}${outcome.bodyFrom === "inline" ? "" : `  [body: ${plainLine(relative(baseDir, outcome.bodyFrom))}]`}`;
    switch (outcome.disposition) {
      case "planned":
        lines.push(`  ${id}  would reply (${outcome.bodyBytes} byte(s)) and resolve`);
        if (outcome.replyArgv !== null) lines.push(`      would run: ${printableArgv(outcome.replyArgv)}`);
        if (outcome.resolveArgv !== null) lines.push(`      would run: ${printableArgv(outcome.resolveArgv)}`);
        for (const bodyLine of bodyOf(outcome.replyArgv).split(/\r?\n/)) lines.push(`      | ${plainLine(bodyLine)}`);
        break;
      case "resolved":
        lines.push(`  ${id}  replied, resolved`);
        break;
      case "replied":
        lines.push(`  ${id}  REPLIED, NOT RESOLVED: ${plainLine(outcome.error ?? "")}`);
        break;
      case "failed":
        lines.push(`  ${id}  FAILED, nothing confirmed sent: ${plainLine(outcome.error ?? "")}`);
        break;
      case "already-resolved":
        lines.push(`  ${id}  already resolved -- nothing ${report.dryRun ? "would be" : "was"} sent to it`);
        break;
      default:
        lines.push(`  ${id}  not attempted (the batch stopped at ${plainLine(report.stoppedAt ?? "")})`);
    }
  }
  return lines;
}

/** The stderr line a stopped batch prints: exactly what was done, and that nothing was retried. */
export function stoppedLine(report: SettleReport): string {
  return `stopped at thread '${plainLine(report.stoppedAt ?? "")}'; nothing was retried. Replied to and resolved: ${ids(report.entries, "resolved")}. Replied to, NOT resolved: ${ids(report.entries, "replied")}. Reply failed (nothing confirmed sent): ${ids(report.entries, "failed")}. Already resolved, nothing sent: ${ids(report.entries, "already-resolved")}. Not attempted: ${ids(report.entries, "not-attempted")}. Re-read with 'nen pr threads list' before sending anything again.`;
}

function bodyOf(argv: readonly string[] | null): string {
  const token = argv?.find((element): boolean => element.startsWith("body=")) ?? "body=";
  return token.slice("body=".length);
}
