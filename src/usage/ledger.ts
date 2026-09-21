// src/usage/ledger.ts -- the usage ledger's constants and its one reader, in a
// module with no command in it, so the report assembler can read the
// directory without importing a verb (../phase/ledger.ts's own rule, applied
// to the second ledger; zheref/nen#227) -- and its one writer, so the append
// can be exercised across processes without going through the verb.
//
// WHAT IS RECORDED. One ENTRY per `nen usage record` call: which surface ran
// (claude-code, codex, cursor, antigravity), which model alias, the token
// counts the surface exposed (input, output, cache read, cache write), the
// wall minutes, and where the numbers came from -- `claude /cost`, a session
// log, an Actions timing -- in the caller's own words. A surface that exposes
// NOTHING records `notReported: true` with every number null, because a
// ledger with a hole in it is honest and a ledger that silently skipped a
// surface is not.
//
// NUMBERS ARE NULL WHEN ABSENT, never zero. Zero is a measurement ("this call
// used no cache"); null is the absence of one, and the totals `nen usage show`
// prints and the `usage[]` rows `nen report data` carries keep the two apart.

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLedgerLock, writeLedgerAtomically, type LedgerLockOptions } from "../ledger/lock.js";

export const USAGE_LEDGER_DIR = ".nen/usage";
export const USAGE_CONTRACT = "nen.usage.ledger/v0.1";

/** KEY ORDER IS THE CONTRACT; ./command.test.ts pins it. */
export interface UsageEntry {
  readonly recordedAt: string;
  readonly surface: string;
  readonly model: string | null;
  readonly input: number | null;
  readonly output: number | null;
  readonly cacheRead: number | null;
  readonly cacheWrite: number | null;
  readonly minutes: number | null;
  readonly source: string | null;
  readonly note: string | null;
  readonly notReported: boolean;
}

export interface UsageLedger {
  readonly contract: string;
  readonly effort: string;
  readonly entries: readonly UsageEntry[];
}

/** The same id alphabet ../phase/command.ts admits, so one effort names both ledgers. */
export const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * `.nen/usage/<effort>.json`. `encodeURIComponent` is INJECTIVE on the id
 * alphabet ('/' -> '%2F', every other admitted character kept), so no two
 * efforts share a file -- ../phase/command.ts's `ledgerPath` states the
 * incident that rule comes from.
 */
export function usageLedgerPath(root: string, effort: string): string {
  return join(root, ...USAGE_LEDGER_DIR.split("/"), `${encodeURIComponent(effort)}.json`);
}

/** The ledger on disk, or an empty one; a file that is not this contract's is refused, never rewritten. */
export function readUsageLedger(path: string, effort: string): UsageLedger {
  if (!existsSync(path)) return { contract: USAGE_CONTRACT, effort, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`'${path}' is not readable JSON (${error instanceof Error ? error.message : String(error)}). A usage ledger nen cannot read is not rewritten over; move it aside.`);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { contract?: unknown }).contract !== USAGE_CONTRACT) {
    throw new Error(`'${path}' does not carry contract '${USAGE_CONTRACT}'. A ledger written by something else is not appended to.`);
  }
  const entries = (parsed as { entries?: unknown }).entries;
  if (!Array.isArray(entries)) throw new Error(`'${path}': 'entries' is not an array.`);
  return { contract: USAGE_CONTRACT, effort, entries: entries as UsageEntry[] };
}

/**
 * Append `entry` to `effort`'s ledger at `path`, creating the ledger when
 * there is none. THE READ-MODIFY-WRITE IS SERIALIZED under the shared
 * `withLedgerLock` (../ledger/lock.ts; Copilot review on zheref/nen#231, T7):
 * two `nen usage record` calls on the same effort at once -- one per surface,
 * say, at the end of a turn -- would otherwise both read the same `entries`
 * and the later write would drop the earlier entry. The ledger is written
 * through a temp file and a rename, so a reader never sees it torn.
 */
export function appendUsageEntry(path: string, effort: string, entry: UsageEntry, lock: LedgerLockOptions = {}): UsageLedger {
  return withLedgerLock(path, (): UsageLedger => {
    const ledger = readUsageLedger(path, effort);
    const next: UsageLedger = { ...ledger, entries: [...ledger.entries, entry] };
    writeLedgerAtomically(path, next);
    return next;
  }, lock);
}
