// src/pr/settle.ts -- `nen pr threads settle` (zheref/nen#230): reply to and
// resolve a BATCH of review threads from one file, walking the thread list
// once.
//
// WHY A BATCH AT ALL. Settling a reviewer round with the single-thread verbs is
// `reply` then `resolve` per thread, and each of those walks the pull request's
// whole thread list before its one mutation -- 4N calls for N threads, and a
// shell loop improvised fresh every round. This walks once and sends 2N
// mutations: 2N + 1 where the loop costs 4N.
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
// for the same fact) when everything else settled, so a caller can never
// record "I resolved it" about a thread it did not resolve.
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

import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve as resolvePath } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
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
 * The `--from` file, read and validated IN FULL. Every problem is collected
 * and the whole list refused once (exit 2): a caller fixing a batch should not
 * have to discover its problems one run at a time.
 *
 * `bodyFile` RESOLVES AGAINST THE FILE'S OWN DIRECTORY, not the process's and
 * not `--repo`'s: the batch file and the reply files it names are written
 * together, and a reference that moved with the shell would read a different
 * reply than the one written beside it. An absolute path is used as-is. The
 * body is read RAW -- the bytes on disk are the bytes posted, as `reply
 * --body-file` reads them.
 */
export function readSettleFile(fullPath: string): readonly SettleEntry[] {
  let text: string;
  try {
    text = readFileSync(fullPath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new VerbUsageError(
      `could not read --from '${fullPath}'${code === undefined ? "" : ` (${code})`}. It is the batch of replies this verb posts, so an unreadable one is refused before anything is sent.`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw new VerbUsageError(
      `--from '${fullPath}' is not JSON (${error instanceof Error ? error.message : String(error)}). It must be an array of { "thread": "<id>", "body": "<text>" } or { "thread": "<id>", "bodyFile": "<path>" }. Nothing was sent.`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new VerbUsageError(
      `--from '${fullPath}' must hold a JSON ARRAY of { "thread", "body" | "bodyFile" } entries; it holds ${parsed === null ? "null" : typeof parsed}. Nothing was sent.`,
    );
  }
  if (parsed.length === 0) {
    throw new VerbUsageError(`--from '${fullPath}' is an empty array: there is nothing to settle, and an empty batch is never assumed to be what was meant.`);
  }

  const baseDir = dirname(fullPath);
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
      problems.push(`${at}: unknown key(s) ${unknownKeys.map((key): string => `'${key}'`).join(", ")} -- an entry carries 'thread' and exactly one of 'body' or 'bodyFile'.`);
    }
    const thread = record["thread"];
    let threadOk = false;
    if (typeof thread !== "string" || thread.trim() === "") {
      problems.push(`${at}: 'thread' must be a non-empty string -- the GraphQL node id 'nen pr threads list' prints, never a position.`);
    } else if (thread !== thread.trim()) {
      problems.push(`${at}: 'thread' '${thread}' carries surrounding whitespace; an id is matched exactly and is never trimmed into another one.`);
    } else {
      threadOk = true;
      const earlier = firstSeen.get(thread);
      if (earlier !== undefined) {
        problems.push(`${at}: thread '${thread}' is already named by entry ${earlier}. One thread, one reply -- a second would post twice under your identity.`);
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
        const full = isAbsolute(value) ? value : resolvePath(baseDir, value);
        bodyFrom = full;
        try {
          body = readFileSync(full, "utf8");
        } catch (error) {
          const code = (error as NodeJS.ErrnoException).code;
          problems.push(`${at}: could not read bodyFile '${full}'${code === undefined ? "" : ` (${code})`}.`);
        }
      }
    }
    if (body !== null && body.trim() === "") {
      problems.push(`${at}: the body${bodyFrom === "inline" ? "" : ` in '${bodyFrom}'`} is empty (or holds only whitespace). An empty reply is never what a caller meant, and it is never assumed.`);
      body = null;
    }
    if (threadOk && body !== null) entries.push({ thread: thread as string, body, bodyFrom });
  });
  if (problems.length > 0) {
    throw new VerbUsageError(
      `--from '${fullPath}' cannot be settled as written; nothing was sent. ${problems.length} problem(s):\n  ${problems.join("\n  ")}`,
    );
  }
  return entries;
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
      `${slug}#${prNumber} carries no review thread with id ${unknown.map((id): string => `'${id}'`).join(", ")}; nothing was sent. Each id is the GraphQL node id 'nen pr threads list' prints for THIS pull request, never a position or another pull request's id. This pull request has ${listing.threads.length} thread(s).`,
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
 */
export function renderSettle(report: SettleReport): readonly string[] {
  const head = /^[0-9a-f]{40}$/i.test(report.head) ? report.head.slice(0, 8) : "unknown head";
  const settled = report.entries.filter((outcome): boolean => outcome.disposition === "resolved").length;
  const lines = [
    report.dryRun
      ? `${plainLine(report.target)}#${report.pr} @ ${head}: would settle ${report.entries.filter((outcome): boolean => outcome.disposition === "planned").length} of ${report.entries.length} thread(s) from ${plainLine(report.from)} -- dry run, nothing written`
      : `${plainLine(report.target)}#${report.pr} @ ${head}: settled ${settled} of ${report.entries.length} thread(s) from ${plainLine(report.from)}`,
  ];
  for (const outcome of report.entries) {
    const id = plainLine(outcome.thread);
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
