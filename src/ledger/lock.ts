// src/ledger/lock.ts -- the advisory lock and the atomic writer every
// on-disk ledger shares (Copilot review on zheref/nen#231, T1 and T7). The
// phase ledger (../phase/ledger.ts) and the usage ledger (../usage/ledger.ts)
// are both a JSON document appended to by read-modify-write, and a
// read-modify-write two processes run at once loses the earlier one's write;
// this module is the one place that is prevented, so neither ledger imports
// the other's verb to borrow it.

import { closeSync, mkdirSync, openSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync, writeSync } from "node:fs";
import { dirname } from "node:path";

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
 * Run `body` holding the advisory lock on `path`. The lock is `<ledger>.lock`,
 * created with O_EXCL (`wx`) so exactly one process holds it; another holder
 * is waited for with a short backoff up to `waitMs`, and a lock older than
 * `staleMs` is a crashed holder's -- broken, and said so on `warn`. The lock
 * is removed in `finally` whatever `body` did.
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
        warn(`nen: broke the stale ledger lock '${lock}' (${Math.round(age / 1000)}s old; a holder that old has crashed).`);
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

/**
 * Write `document` to `path` as pretty JSON THROUGH A TEMP FILE AND A RENAME,
 * so a reader never sees a torn ledger: `rename(2)` replaces the path in one
 * step, and a `show` that races a write reads either the old document or the
 * new one, never half of the new one.
 */
export function writeLedgerAtomically(path: string, document: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temp = `${path}.${process.pid}.${Math.random().toString(36).slice(2, 8)}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    renameSync(temp, path);
  } finally {
    rmSync(temp, { force: true });
  }
}
