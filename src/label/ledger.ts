// src/label/ledger.ts -- the fixed-shape ledger entry `nen label apply`
// writes: object · label · time · run.
//
// WHY A LEDGER AT ALL. The issue's own framing: "label application under
// delegation, logged". A label mutation performed on an agent's behalf is the
// one class of write this repository's machinery makes routinely and without
// a human watching each one; the ledger is the after-the-fact record of every
// one of them, in one place, in one shape, so "what did the delegated agent
// actually change, and when" is answerable without re-deriving it from
// GitHub's own (mutable, prunable) label-event history.
//
// APPEND-ONLY, NEWLINE-DELIMITED JSON. One line per call, never rewritten:
// a ledger that could be edited after the fact is not a ledger. JSONL rather
// than a JSON array because appending to an array file means reading, editing
// and rewriting the whole file on every call -- exactly the shape that
// corrupts under a concurrent writer, which two labelling calls in the same
// tick are.
//
// A DRY-RUN STILL WRITES A LEDGER LINE, WITH `outcome: "dry-run"`. The
// decision to label something is worth recording even when nothing was
// mutated -- it is the difference between "nobody considered labelling this"
// and "this was weighed and deliberately not applied yet" (CON-38's
// dry-run-first convention, carried from scripts/sync-labels.sh).
//
// `outcome` IS THREE STATES, NOT A BOOLEAN (review finding). The line is
// appended AFTER the mutation is attempted, never before: this is the
// after-the-fact record the module's own header above promises, and a ledger
// that asserted `run: true` before GitHub had even answered was wrong in
// exactly the case an audit trail exists for -- a 404, a 403, a rate limit,
// or a PR closed since would exit 1 while the ledger kept a permanent record
// claiming the label was applied.

import { closeSync, constants, fstatSync, mkdirSync, openSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { VerbUsageError } from "../cli/command.js";

export const DEFAULT_LEDGER = ".nen/label-ledger.jsonl";

/** Only the default state directory is created; explicit ledger parents must exist. */
export function labelLedgerPath(root: string, explicit?: string): string {
  const path = resolveAgainstRepo(root, explicit ?? DEFAULT_LEDGER);
  const directory = dirname(path);
  try {
    if (explicit === undefined) mkdirSync(directory, { recursive: true });
    if (statSync(directory, { throwIfNoEntry: false })?.isDirectory() !== true) throw new Error("not a directory");
  } catch {
    throw new VerbUsageError(`--ledger '${path}' cannot be written: '${directory}' is not a directory or cannot be created.`);
  }
  return path;
}

/** Open before GitHub writes, so a refused ledger cannot leave an unlogged mutation. */
export function openLabelLedger(path: string): number {
  let fd: number | undefined;
  try {
    const existing = statSync(path, { throwIfNoEntry: false });
    if (existing !== undefined && !existing.isFile()) throw Object.assign(new Error("not a regular file"), { code: existing.isDirectory() ? "EISDIR" : "EINVAL" });
    // Follow legitimate file symlinks, but never block if the path becomes a FIFO
    // between stat and open. Validate the opened object, not just the earlier path.
    fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NONBLOCK);
    if (!fstatSync(fd).isFile()) throw Object.assign(new Error("not a regular file"), { code: "EINVAL" });
    return fd;
  } catch (error) {
    if (fd !== undefined) closeSync(fd);
    const code = (error as NodeJS.ErrnoException).code;
    throw new VerbUsageError(`--ledger '${path}' cannot be appended to${code === undefined ? "" : ` (${code})`}: nothing was written to GitHub.`);
  }
}

export type LedgerOutcome = "dry-run" | "applied" | "failed";

export interface LedgerEntry {
  /** The object token, e.g. `<CODE>-<IS|PR>-#<N>`. */
  readonly object: string;
  readonly label: string;
  /** ISO-8601. Always the caller's `Seams.now()`, never re-read per line. */
  readonly time: string;
  /** What actually happened: never mutated (dry run), mutated, or GitHub refused it. */
  readonly outcome: LedgerOutcome;
  readonly reason: string | null;
}

export function ledgerLine(entry: LedgerEntry): string {
  return JSON.stringify(entry);
}

/** Parse a ledger file's lines, skipping blanks. Malformed lines are reported, not thrown. */
export interface ParsedLedger {
  readonly entries: readonly LedgerEntry[];
  /** 1-indexed line numbers that failed to parse as a LedgerEntry. */
  readonly malformed: readonly number[];
}

function isLedgerEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record["object"] === "string" &&
    typeof record["label"] === "string" &&
    typeof record["time"] === "string" &&
    (record["outcome"] === "dry-run" || record["outcome"] === "applied" || record["outcome"] === "failed") &&
    (record["reason"] === null || typeof record["reason"] === "string")
  );
}

export function parseLedger(text: string): ParsedLedger {
  const entries: LedgerEntry[] = [];
  const malformed: number[] = [];
  const lines = text.split("\n");
  lines.forEach((line, index): void => {
    const trimmed = line.trim();
    if (trimmed === "") return;
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (isLedgerEntry(parsed)) {
        entries.push(parsed);
      } else {
        malformed.push(index + 1);
      }
    } catch {
      malformed.push(index + 1);
    }
  });
  return { entries, malformed };
}
