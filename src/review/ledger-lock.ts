// Nen-only coordination after an explicit legacy-writer migration boundary.
// The persistent .cycle.lock is evidence, NOT this mutex: its inode/mtime
// survive every normal release. Never use ledger/lock.ts's stale-unlink policy.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, rmdirSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { VerbUsageError } from "../cli/command.js";

export const CYCLE_MUTEX_WAIT_MS = 2_000;
export const CYCLE_STALE_MS = 30_000;

export function cycleMutexPath(lock: string): string { return `${lock}.nen-mutex`; }

/** Cooperative Nen callers serialize on atomic mkdir; no Python-lock claim. */
export async function withCycleMutex<T>(lock: string, body: () => T | Promise<T>, waitMs = CYCLE_MUTEX_WAIT_MS): Promise<T> {
  const mutex = cycleMutexPath(lock);
  mkdirSync(dirname(lock), { recursive: true });
  const deadline = performance.now() + waitMs;
  for (;;) {
    try { mkdirSync(mutex); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (performance.now() >= deadline) throw new VerbUsageError(`review ledger: mutex '${mutex}' remains held after ${waitMs}ms. No lock is removed by age; stop all writers and inspect/restore this ownership evidence before retrying.`);
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }
  }
  const identity = lstatSync(mutex);
  const owner = join(mutex, `owner-${process.pid}-${randomUUID()}`);
  try {
    writeFileSync(owner, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
    // O_CREAT without truncation/write leaves old .cycle.lock age intact.
    if (exists(lock) && !lstatSync(lock).isFile()) throw new VerbUsageError(`review ledger: '${lock}' is not a regular lock witness; restore it before retrying`);
    const fd = openSync(lock, constants.O_WRONLY | constants.O_CREAT | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0), 0o600);
    try {
      if (!fstatSync(fd).isFile()) throw new VerbUsageError(`review ledger: '${lock}' changed to a non-regular lock witness`);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    return await body();
  } finally {
    // Never recursively remove a mutex, or remove a replacement's ownership.
    const current = exists(mutex) ? lstatSync(mutex) : null;
    if (current !== null && current.dev === identity.dev && current.ino === identity.ino) {
      if (exists(owner)) unlinkSync(owner);
      rmdirSync(mutex);
    }
  }
}

function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
