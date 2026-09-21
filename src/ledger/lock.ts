// src/ledger/lock.ts -- the advisory lock and the atomic writer every
// on-disk ledger shares (Copilot review on zheref/nen#231, T1 and T7). The
// phase ledger (../phase/ledger.ts) and the usage ledger (../usage/ledger.ts)
// are both a JSON document appended to by read-modify-write, and a
// read-modify-write two processes run at once loses the earlier one's write;
// this module is the one place that is prevented, so neither ledger imports
// the other's verb to borrow it.

import { closeSync, fstatSync, linkSync, mkdirSync, openSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs";
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
  /**
   * Test seam: runs after a lock has been read as stale and before it is
   * taken -- the window another process can acquire in. Never set by a verb.
   */
  readonly beforeRecover?: () => void;
}

function sleepMs(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Remove the file at `lock` ONLY if it is still the inode `ino` -- never a
 * lock some other process created at that path since `ino` was observed
 * (Copilot review on zheref/nen#231, T8). There is no "unlink if inode is X"
 * in POSIX, so it is done in two steps that are each atomic: the path is
 * RENAMED aside (a rename fails with ENOENT if the file is gone, and succeeds
 * for exactly one of several processes trying, so a successful rename makes
 * this process the sole owner of whatever inode it moved), then the moved
 * file is inspected. Ours: unlink it, done. Somebody else's -- a holder that
 * acquired between our observation and our rename: it is put BACK with
 * `link(2)`, which refuses (EEXIST) rather than clobbers if a third process
 * has taken the path meanwhile, and the aside name is unlinked either way.
 * Returns true when `ino` was removed, false when it was already gone or the
 * path held another process's lock.
 */
function removeLockIfInode(lock: string, ino: number | bigint, warn: (line: string) => void): boolean {
  const aside = `${lock}.stale.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}`;
  try {
    renameSync(lock, aside);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
  try {
    if (statSync(aside).ino === ino) return true;
    // A live holder's lock, moved by mistake: put it back where it was.
    try {
      linkSync(aside, lock);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      warn(`nen: a lock created at '${lock}' while its stale predecessor was being removed could not be restored (a third holder took the path); that holder's release is not this process's to make.`);
    }
    return false;
  } finally {
    rmSync(aside, { force: true });
  }
}

/**
 * Run `body` holding the advisory lock on `path`. The lock is `<ledger>.lock`,
 * created with O_EXCL (`wx`) so exactly one process holds it; another holder
 * is waited for with a short backoff up to `waitMs`, and a lock older than
 * `staleMs` is a crashed holder's -- broken, and said so on `warn`. A stale
 * lock is broken by inode, never by path: between reading a lock as stale and
 * removing it, another process may have broken it first and acquired its own,
 * and removing THAT would let two bodies run at once. The lock is released in
 * `finally` whatever `body` did -- again by inode, so a lock this process no
 * longer owns (broken as stale under it, replaced by a fresh holder) is left
 * to the process that does.
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
  let ownIno: number | bigint;
  for (;;) {
    try {
      const fd = openSync(lock, "wx");
      try {
        writeSync(fd, `${process.pid}\n`);
        ownIno = fstatSync(fd).ino;
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      let seen: { readonly age: number; readonly ino: number | bigint };
      try {
        const stat = statSync(lock);
        seen = { age: Date.now() - stat.mtimeMs, ino: stat.ino };
      } catch {
        // The holder released it between our open and our stat: try again at once.
        continue;
      }
      if (seen.age > staleMs) {
        options.beforeRecover?.();
        if (removeLockIfInode(lock, seen.ino, warn)) {
          warn(`nen: broke the stale ledger lock '${lock}' (${Math.round(seen.age / 1000)}s old; a holder that old has crashed).`);
        }
        // Either way the path is now somebody's to take -- ours through `wx`,
        // or the fresh holder's, which the next round waits for.
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
    // Release by inode: if the lock at the path is no longer the one this
    // process created, somebody broke ours as stale and holds their own, and
    // it is theirs to release. Nothing here removes another holder's lock.
    removeLockIfInode(lock, ownIno, warn);
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
