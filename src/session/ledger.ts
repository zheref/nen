// Caller-reported session identity only: no environment, harness or process reads.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLedgerLock, writeLedgerAtomically, type LedgerLockOptions } from "../ledger/lock.js";
import { encodeEffortId } from "../usage/ledger.js";

export const SESSION_LEDGER_DIR = ".nen/sessions";
export const SESSION_CONTRACT = "nen.session.ledger/v0.1";

export interface SessionEntry {
  readonly recordedAt: string;
  readonly surface: string;
  readonly model: string | null;
  readonly dial: string | null;
  readonly title: string | null;
  readonly id: string | null;
  readonly source: string | null;
}

export interface SessionLedger {
  readonly contract: string;
  readonly effort: string;
  readonly entries: readonly SessionEntry[];
}

/** Validation tests meaning without trimming the values that are stored. */
export function isSessionEntry(value: unknown): value is SessionEntry {
  if (typeof value !== "object" || value === null) return false;
  const row = value as Record<string, unknown>;
  const nullable = (key: string): boolean => row[key] === null || typeof row[key] === "string";
  const identifies = (key: string): boolean => typeof row[key] === "string" && row[key].trim() !== "";
  return typeof row["recordedAt"] === "string" && typeof row["surface"] === "string" && row["surface"].trim() !== ""
    && ["model", "dial", "title", "id", "source"].every(nullable) && (identifies("title") || identifies("id"));
}

export function sessionLedgerPath(root: string, effort: string): string {
  return join(root, ...SESSION_LEDGER_DIR.split("/"), `${encodeEffortId(effort)}.json`);
}

export function readSessionLedger(path: string, effort: string): SessionLedger {
  if (!existsSync(path)) return { contract: SESSION_CONTRACT, effort, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`'${path}' is not readable JSON (${error instanceof Error ? error.message : String(error)}). A session ledger nen cannot read is not rewritten over; move it aside.`);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { contract?: unknown }).contract !== SESSION_CONTRACT) {
    throw new Error(`'${path}' does not carry contract '${SESSION_CONTRACT}'. A ledger written by something else is not appended to.`);
  }
  const doc = parsed as { effort?: unknown; entries?: unknown };
  if (doc.effort !== effort) throw new Error(`'${path}': 'effort' does not match '${effort}'.`);
  if (!Array.isArray(doc.entries)) throw new Error(`'${path}': 'entries' is not an array.`);
  if (!doc.entries.every(isSessionEntry)) throw new Error(`'${path}': invalid session entry. A ledger nen cannot read is not rewritten over.`);
  return { contract: SESSION_CONTRACT, effort, entries: doc.entries };
}

/** Serialize the complete read-modify-write; atomic rename keeps readers whole. */
export function appendSessionEntry(path: string, effort: string, entry: SessionEntry, lock: LedgerLockOptions = {}): SessionLedger {
  return withLedgerLock(path, (): SessionLedger => {
    const ledger = readSessionLedger(path, effort);
    const next: SessionLedger = { ...ledger, entries: [...ledger.entries, entry] };
    writeLedgerAtomically(path, next);
    return next;
  }, lock);
}
