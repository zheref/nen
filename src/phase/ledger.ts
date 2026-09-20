// src/phase/ledger.ts -- the phase ledger's constants, shapes and the two
// file operations, in a module with no command in it, so the report assembler
// and the `shu` executor can read and append to the ledger without importing
// a verb (review finding on zheref/nen#216; the executor's need arrived with
// zheref/nen#227).

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";

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

/**
 * WRITTEN THROUGH A TEMP FILE AND A RENAME, so a reader never sees a torn
 * ledger (Copilot review on zheref/nen#231): `rename(2)` replaces the path in
 * one step, and a `nen phase show` that races a write reads either the old
 * document or the new one, never half of the new one.
 */
export function writeLedger(path: string, ledger: PhaseLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}

/** The lock file beside a ledger: `<ledger>.lock`. */
export function ledgerLockPath(path: string): string {
  return `${path}.lock`;
}

/** A lock older than this is a crashed holder's, and is broken -- said so. */
export const LEDGER_LOCK_STALE_MS = 30_000;
/** How long an append waits for another holder before giving up. */
export const LEDGER_LOCK_WAIT_MS = 2_000;
const LEDGER_LOCK_BACKOFF_MS = 25;

export interface LedgerLockOptions {
  /** Where "broke a stale lock" is said. Defaults to stderr. */
  readonly warn?: (line: string) => void;
  /** Test seam: how long to wait before giving up. */
  readonly waitMs?: number;
  /** Test seam: the age past which a lock is stale. */
  readonly staleMs?: number;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Run `body` holding the advisory lock on `path` (Copilot review on
 * zheref/nen#231). The lock is `<ledger>.lock`, created with O_EXCL (`wx`) so
 * exactly one process holds it; another holder is waited for with a short
 * backoff up to `waitMs`, and a lock older than `staleMs` is a crashed
 * holder's -- broken, and said so on `warn`. The lock is removed in `finally`
 * whatever `body` did.
 */
export function withLedgerLock<T>(path: string, body: () => T, options: LedgerLockOptions = {}): T {
  const lock = ledgerLockPath(path);
  const waitMs = options.waitMs ?? LEDGER_LOCK_WAIT_MS;
  const staleMs = options.staleMs ?? LEDGER_LOCK_STALE_MS;
  const warn = options.warn ?? ((line: string): void => {
    process.stderr.write(`${line}\n`);
  });
  mkdirSync(dirname(path), { recursive: true });
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let age: number | null = null;
      try {
        age = Date.now() - statSync(lock).mtimeMs;
      } catch {
        // The holder released it between our open and our stat: try again at once.
        continue;
      }
      if (age > staleMs) {
        warn(`nen: broke the stale phase-ledger lock '${lock}' (${Math.round(age / 1000)}s old; a holder that old has crashed).`);
        rmSync(lock, { force: true });
        continue;
      }
      if (Date.now() >= deadline) {
        throw new Error(`'${lock}' is held by another nen run and was not released within ${waitMs}ms. The ledger was not appended to; run again, or remove the lock if nothing holds it.`);
      }
      sleepMs(LEDGER_LOCK_BACKOFF_MS);
    }
  }
  try {
    return body();
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      /* already gone: somebody broke it as stale; nothing to release */
    }
  }
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
