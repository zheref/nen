// src/phase/ledger.ts -- the phase ledger's constants, shapes and the two
// file operations, in a module with no command in it, so the report assembler
// and the `shu` executor can read and append to the ledger without importing
// a verb (review finding on zheref/nen#216; the executor's need arrived with
// zheref/nen#227).

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { withLedgerLock, writeLedgerAtomically, type LedgerLockOptions } from "../ledger/lock.js";

// THE LOCK IS SHARED with the usage ledger (../ledger/lock.ts; Copilot review
// on zheref/nen#231, T7). Re-exported so this ledger's callers name one module.
export { LEDGER_LOCK_STALE_MS, LEDGER_LOCK_WAIT_MS, ledgerLockPath, withLedgerLock, type LedgerLockOptions } from "../ledger/lock.js";

export const PHASE_LEDGER_DIR = ".nen/phases";
/**
 * `v0.1` STILL, after `steps[]` arrived on an entry (zheref/nen#227). The key
 * is ADDITIVE: an entry `nen phase begin` wrote before it carries no `steps`
 * and every reader treats that as `[]`, and no key that was there moved or
 * changed meaning. A contract bump is for a reader that would misread the
 * old shape, and none does.
 */
export const PHASE_CONTRACT = "nen.phase.ledger/v0.1";

/** The same id alphabet `nen usage` admits, so one effort names both ledgers. */
export const EFFORT_ID = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/**
 * One `nen shu` step, appended to the OPEN phase entry it ran inside.
 *
 * `argv` IS ONE STRING -- the rendering `--dry-run`'s `would run:` line prints,
 * quoted by the project's one rule -- because a ledger row is read by a person
 * comparing runs, and a list of tokens is not what they compare. `durationMs`
 * is null when the tool never started (a spawn failure), exactly as the run
 * report itself says it.
 */
export interface PhaseStep {
  readonly verb: string;
  readonly argv: string;
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly stalled: boolean;
}

export interface PhaseEntry {
  readonly phase: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly surface: string | null;
  readonly model: string | null;
  readonly note: string | null;
  /**
   * Every `nen shu` step that ran while this entry was open (zheref/nen#227).
   * `[]` on `begin`; absent on an entry written before the key existed, which
   * every reader treats as `[]`.
   */
  readonly steps?: readonly PhaseStep[];
}

export interface PhaseLedger {
  readonly contract: string;
  readonly effort: string;
  readonly phases: readonly PhaseEntry[];
}

/**
 * `.nen/phases/<effort>.json`. `encodeURIComponent` is INJECTIVE on the id
 * alphabet: '/' -> '%2F' and every other admitted character is left as
 * itself, so no two effort ids share a file. A '/' -> '-' substitution was
 * not (Copilot review on zheref/nen#217): 'HA/85' and 'HA-85' appended to the
 * same ledger.
 */
export function phaseLedgerPath(root: string, effort: string): string {
  return join(root, ...PHASE_LEDGER_DIR.split("/"), `${encodeURIComponent(effort)}.json`);
}

export function readLedger(path: string, effort: string): PhaseLedger {
  if (!existsSync(path)) return { contract: PHASE_CONTRACT, effort, phases: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`'${path}' is not readable JSON (${error instanceof Error ? error.message : String(error)}). A phase ledger nen cannot read is not rewritten over; move it aside.`);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { contract?: unknown }).contract !== PHASE_CONTRACT) {
    throw new Error(`'${path}' does not carry contract '${PHASE_CONTRACT}'. A ledger written by something else is not appended to.`);
  }
  const phases = (parsed as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) throw new Error(`'${path}': 'phases' is not an array.`);
  return { contract: PHASE_CONTRACT, effort, phases: phases as PhaseEntry[] };
}

/** The ledger, written through ../ledger/lock.ts's temp-file-and-rename, so a reader never sees it torn. */
export function writeLedger(path: string, ledger: PhaseLedger): void {
  writeLedgerAtomically(path, ledger);
}

/** The index of the most recently opened entry still open, or -1. */
export function lastOpenIndex(ledger: PhaseLedger): number {
  for (let index = ledger.phases.length - 1; index >= 0; index -= 1) {
    if (ledger.phases[index]?.endedAt === null) return index;
  }
  return -1;
}

/**
 * Append `steps` to the OPEN phase entry on `effort`'s ledger, or do nothing.
 *
 * NOTHING IS WRITTEN WHEN NOTHING IS OPEN, and that is the whole contract
 * (zheref/nen#227): a `nen shu build` run outside any phase is not a phase of
 * its own and is never turned into one -- the ledger records what a caller
 * declared it was doing, and the executor only ever adds detail under it.
 * Returns whether anything was written, so a caller can say so.
 *
 * THE READ-MODIFY-WRITE IS SERIALIZED under `withLedgerLock` (Copilot review
 * on zheref/nen#231): two `nen shu --effort` runs recording steps on the same
 * open entry at once would otherwise both read the same `phases` and the
 * later write would drop the earlier run's steps.
 */
export function appendStepsToOpenPhase(root: string, effort: string, steps: readonly PhaseStep[], lock: LedgerLockOptions = {}): boolean {
  if (steps.length === 0) return false;
  const path = phaseLedgerPath(root, effort);
  // NO LEDGER, NO LOCK: taking one would create `.nen/phases/` for an effort
  // nobody began, and the answer is the same either way -- nothing is open.
  if (!existsSync(path)) return false;
  return withLedgerLock(path, (): boolean => {
    const ledger = readLedger(path, effort);
    const index = lastOpenIndex(ledger);
    if (index === -1) return false;
    const open = ledger.phases[index] as PhaseEntry;
    const updated: PhaseEntry = { ...open, steps: [...(open.steps ?? []), ...steps] };
    writeLedger(path, { ...ledger, phases: ledger.phases.map((entry, i): PhaseEntry => (i === index ? updated : entry)) });
    return true;
  }, lock);
}
