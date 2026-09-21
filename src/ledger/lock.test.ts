// src/ledger/lock.test.ts -- the advisory lock's two races (Copilot review on
// zheref/nen#231, T8): a stale lock is broken by IDENTITY -- inode AND the
// token in it, because ext4 recycles a just-freed inode for the next file at
// the path (the ubuntu check on #231 removed a successor's lock that way) --
// so a holder that acquired between "read as stale" and "removed" keeps its
// lock, and the release in `finally` never removes a lock this process no
// longer owns. The "other process" below writes a different token and, on
// APFS, lands on a different inode; on ext4 it may land on the SAME inode,
// and the assertions hold either way.
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ledgerLockPath, withLedgerLock } from "./lock.js";

const staleLock = (lock: string): void => {
  writeFileSync(lock, "1\n");
  const old = new Date(Date.now() - 120_000);
  utimesSync(lock, old, old);
};

describe("withLedgerLock -- stale recovery and release are by identity (inode and token), never by path", () => {
  it("a holder that acquires between the stale read and the recovery keeps its lock: nothing of theirs is removed, and the wait is refused by name", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-lock-toctou-"));
    const path = join(root, "ledger.json");
    const lock = ledgerLockPath(path);
    staleLock(lock);
    const warned: string[] = [];
    let raced = false;
    expect(() =>
      withLedgerLock(path, (): void => {
        throw new Error("the body must not run: another process holds the lock");
      }, {
        staleMs: 1_000,
        waitMs: 150,
        warn: (line): void => { warned.push(line); },
        beforeRecover: (): void => {
          // The other process: breaks the stale lock itself and takes the path
          // with a FRESH lock of its own, in the window after our stat.
          if (raced) return;
          raced = true;
          unlinkSync(lock);
          writeFileSync(lock, "other\n");
        },
      }),
    ).toThrow(/'.*ledger\.json\.lock' is held by another nen run and was not released within 150ms/);
    expect(raced).toBe(true);
    // The fresh holder's lock is exactly where it left it, contents and all.
    // Its inode is not asserted: on ext4 it is very often the stale one's, reused.
    expect(readFileSync(lock, "utf8")).toBe("other\n");
    // Nothing was said about breaking a stale lock -- none was broken -- and no aside file survives.
    expect(warned).toEqual([]);
    expect(readdirSync(root)).toEqual(["ledger.json.lock"]);
  });

  it("a genuinely stale lock is broken, said so, and the body runs under a lock this process created", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-lock-stale-"));
    const path = join(root, "ledger.json");
    const lock = ledgerLockPath(path);
    staleLock(lock);
    const warned: string[] = [];
    let ownIno: number | bigint = 0;
    const result = withLedgerLock(path, (): string => {
      ownIno = statSync(lock).ino;
      expect(readFileSync(lock, "utf8")).toMatch(new RegExp(`^${process.pid} [a-z0-9]+\\n$`));
      return "ran";
    }, { staleMs: 1_000, waitMs: 150, warn: (line): void => { warned.push(line); } });
    expect(result).toBe("ran");
    expect(ownIno).not.toBe(0);
    expect(warned).toEqual([expect.stringMatching(/broke the stale ledger lock '.*ledger\.json\.lock' \(\d+s old; a holder that old has crashed\)/)]);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(root)).toEqual([]);
  });

  it("the release in finally leaves a lock this process no longer owns -- broken under it and replaced -- to its new holder", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-lock-release-"));
    const path = join(root, "ledger.json");
    const lock = ledgerLockPath(path);
    const warned: string[] = [];
    withLedgerLock(path, (): void => {
      // Another process broke our lock as stale (a slow body) and holds its own.
      unlinkSync(lock);
      writeFileSync(lock, "successor\n");
    }, { waitMs: 150, warn: (line): void => { warned.push(line); } });
    expect(readFileSync(lock, "utf8")).toBe("successor\n");
    expect(warned).toEqual([]);
    expect(readdirSync(root)).toEqual(["ledger.json.lock"]);
    // And when the lock is simply gone, the release is silent.
    unlinkSync(lock);
    withLedgerLock(path, (): void => { unlinkSync(lock); }, { waitMs: 150, warn: (line): void => { warned.push(line); } });
    expect(warned).toEqual([]);
    expect(readdirSync(root)).toEqual([]);
  });

  it("two holders' bodies never overlap when one breaks a stale lock and the other arrives at the same time", () => {
    // Sequential in one process, but through the same paths a second process
    // would take: the recovery leaves exactly one lock, ours, and the body of
    // a second call waits for it rather than running beside it.
    const root = mkdtempSync(join(tmpdir(), "nen-lock-two-"));
    const path = join(root, "ledger.json");
    const lock = ledgerLockPath(path);
    staleLock(lock);
    const order: string[] = [];
    withLedgerLock(path, (): void => {
      order.push("first");
      expect(() => withLedgerLock(path, (): void => { order.push("second"); }, { staleMs: 60_000, waitMs: 100, warn: (): void => {} })).toThrow(/held by another nen run/);
    }, { staleMs: 1_000, waitMs: 150, warn: (): void => {} });
    expect(order).toEqual(["first"]);
    expect(existsSync(lock)).toBe(false);
  });
});
