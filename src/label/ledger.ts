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
