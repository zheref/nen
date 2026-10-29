// src/ledger/atomic-write.test.ts -- Windows replacement recovery (zheref/nen#566).
// Real files and the real final rename; only the conflicting syscall, platform,
// monotonic clock and sleep are controlled. The process contention proof stays
// in ../phase/ledger.test.ts and ../usage/ledger.test.ts, unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ledgerLockPath, withLedgerLock, writeLedgerAtomically } from "./lock.js";

const fixture = vi.hoisted(() => ({
  platform: "win32" as NodeJS.Platform,
  now: 0,
  frozenClock: false,
  sleepExtraMs: 0,
  failAttempts: 0,
  persistent: false,
  replacementError: Object.assign(new Error("sharing conflict"), { code: "EPERM", syscall: "rename" }),
  cleanupError: null as Error | null,
  renames: [] as { temp: string; path: string }[],
  writes: [] as string[],
  removals: [] as string[],
  sleeps: [] as number[],
  inspect: null as ((temp: string, path: string) => void) | null,
}));

vi.mock("node:os", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:os")>(),
  platform: (): NodeJS.Platform => fixture.platform,
}));

vi.mock("node:perf_hooks", async (importOriginal) => ({
  ...await importOriginal<typeof import("node:perf_hooks")>(),
  performance: { now: (): number => fixture.now },
}));

vi.mock("node:fs", async (importOriginal) => {
  const original = await importOriginal<typeof import("node:fs")>();
  return {
    ...original,
    writeFileSync: (...args: Parameters<typeof original.writeFileSync>): void => {
      if (typeof args[0] === "string" && args[0].endsWith(".tmp")) fixture.writes.push(args[0]);
      original.writeFileSync(...args);
    },
    renameSync: (...args: Parameters<typeof original.renameSync>): void => {
      const [from, to] = args;
      if (typeof from === "string" && from.endsWith(".tmp") && typeof to === "string") {
        fixture.renames.push({ temp: from, path: to });
        fixture.inspect?.(from, to);
        if (fixture.persistent || fixture.renames.length <= fixture.failAttempts) throw fixture.replacementError;
      }
      original.renameSync(...args);
    },
    rmSync: (...args: Parameters<typeof original.rmSync>): void => {
      const path = args[0];
      if (typeof path === "string") {
        fixture.removals.push(path);
        if (path.endsWith(".tmp") && fixture.cleanupError !== null) throw fixture.cleanupError;
      }
      original.rmSync(...args);
    },
  };
});

const roots: string[] = [];
const previousBytes = '{ "contract": "test/v1", "entries": ["prior"] }\n';
const nextDocument = { contract: "test/v1", entries: ["prior", "next"] };
const nextBytes = `${JSON.stringify(nextDocument, null, 2)}\n`;

function ledger(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-ledger-replace-"));
  roots.push(root);
  const path = join(root, "ledger.json");
  writeFileSync(path, previousBytes);
  return { root, path };
}

function thrownBy(body: () => void): unknown {
  try {
    body();
  } catch (error) {
    return error;
  }
  throw new Error("expected the write to fail");
}

beforeEach(() => {
  Object.assign(fixture, {
    platform: "win32", now: 0, frozenClock: false, sleepExtraMs: 0,
    failAttempts: 0, persistent: false, cleanupError: null,
    replacementError: Object.assign(new Error("sharing conflict"), { code: "EPERM", syscall: "rename" }),
    renames: [], writes: [], removals: [], sleeps: [], inspect: null,
  });
  vi.spyOn(Atomics, "wait").mockImplementation((_array, _index, _value, timeout): "timed-out" => {
    const duration = timeout ?? 0;
    fixture.sleeps.push(duration);
    if (!fixture.frozenClock) fixture.now += duration + fixture.sleepExtraMs;
    return "timed-out";
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("atomic ledger replacement recovery on Windows (zheref/nen#566)", () => {
  it("retries a transient EPERM with one complete temp file under the same lock, then really replaces the ledger", () => {
    const { root, path } = ledger();
    const lock = ledgerLockPath(path);
    fixture.failAttempts = 2;
    withLedgerLock(path, () => {
      const identity = { ino: statSync(lock).ino, token: readFileSync(lock, "utf8") };
      fixture.inspect = (temp, destination): void => {
        expect(destination).toBe(path);
        expect(readFileSync(temp, "utf8")).toBe(nextBytes);
        expect(readFileSync(path, "utf8")).toBe(previousBytes);
        expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ contract: "test/v1", entries: ["prior"] });
        expect({ ino: statSync(lock).ino, token: readFileSync(lock, "utf8") }).toEqual(identity);
      };
      writeLedgerAtomically(path, nextDocument);
      expect({ ino: statSync(lock).ino, token: readFileSync(lock, "utf8") }).toEqual(identity);
    });
    expect(fixture.renames).toHaveLength(3);
    expect(fixture.writes).toEqual([fixture.renames[0]?.temp]);
    expect(new Set(fixture.renames.map(({ temp }) => temp)).size).toBe(1);
    expect(fixture.sleeps).toEqual([25, 25]);
    expect(fixture.removals).not.toContain(path);
    expect(readFileSync(path, "utf8")).toBe(nextBytes);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(nextDocument);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(root)).toEqual(["ledger.json"]);
  });

  it("refuses persistent EPERM at the monotonic deadline, releases its lock and leaves the exact prior readable ledger", () => {
    const { root, path } = ledger();
    const lock = ledgerLockPath(path);
    fixture.persistent = true;
    const error = thrownBy(() => withLedgerLock(path, () => {
      const identity = { ino: statSync(lock).ino, token: readFileSync(lock, "utf8") };
      fixture.inspect = (temp): void => {
        expect(readFileSync(temp, "utf8")).toBe(nextBytes);
        expect(readFileSync(path, "utf8")).toBe(previousBytes);
        expect({ ino: statSync(lock).ino, token: readFileSync(lock, "utf8") }).toEqual(identity);
      };
      writeLedgerAtomically(path, nextDocument);
    }));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain(path);
    expect((error as Error).message).toMatch(/Windows: EPERM.*500ms and 21 attempts.*prior ledger was not removed; retry/);
    expect((error as Error).cause).toBe(fixture.replacementError);
    expect(fixture.now).toBe(500);
    expect(fixture.renames).toHaveLength(20);
    expect(fixture.sleeps).toEqual(Array<number>(20).fill(25));
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ contract: "test/v1", entries: ["prior"] });
    expect(fixture.removals).not.toContain(path);
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(root)).toEqual(["ledger.json"]);
  });

  it("caps a persistent conflict at 21 attempts and 20 sleeps even when the monotonic clock is frozen", () => {
    const { root, path } = ledger();
    fixture.persistent = true;
    fixture.frozenClock = true;
    const error = thrownBy(() => writeLedgerAtomically(path, nextDocument));
    expect((error as Error).cause).toBe(fixture.replacementError);
    expect((error as Error).message).toContain("after 21 attempt(s)");
    expect(fixture.renames).toHaveLength(21);
    expect(fixture.sleeps).toEqual(Array<number>(20).fill(25));
    expect(fixture.now).toBe(0);
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
    expect(readdirSync(root)).toEqual(["ledger.json"]);
  });

  it("does not attempt another replacement after a sleep overruns the deadline", () => {
    const { path } = ledger();
    fixture.persistent = true;
    fixture.sleepExtraMs = 1_000;
    expect(() => writeLedgerAtomically(path, nextDocument)).toThrow(/EPERM persisted after 1 attempt/);
    expect(fixture.renames).toHaveLength(1);
    expect(fixture.sleeps).toEqual([25]);
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
  });

  it("sleeps only the remaining deadline budget", () => {
    const { path } = ledger();
    fixture.persistent = true;
    fixture.inspect = (): void => { fixture.now = 490; };
    expect(() => writeLedgerAtomically(path, nextDocument)).toThrow(/EPERM persisted after 1 attempt/);
    expect(fixture.sleeps).toEqual([10]);
    expect(fixture.renames).toHaveLength(1);
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
  });

  it.each([
    ["linux", "EPERM"], ["darwin", "EPERM"], ["win32", "EACCES"], ["win32", "ENOENT"],
  ] as const)("on %s, %s fails immediately with the original error", (platform, code) => {
    const { root, path } = ledger();
    fixture.platform = platform;
    fixture.persistent = true;
    fixture.replacementError = Object.assign(new Error("original filesystem refusal"), { code, syscall: "rename" });
    expect(thrownBy(() => writeLedgerAtomically(path, nextDocument))).toBe(fixture.replacementError);
    expect(fixture.renames).toHaveLength(1);
    expect(fixture.sleeps).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
    expect(readdirSync(root)).toEqual(["ledger.json"]);
  });

  it("preserves the exhausted Windows replacement error and its cause when temp cleanup also fails", () => {
    const { root, path } = ledger();
    fixture.persistent = true;
    fixture.frozenClock = true;
    fixture.cleanupError = new Error("cleanup was also denied");
    const error = thrownBy(() => writeLedgerAtomically(path, nextDocument));
    expect((error as Error).message).toContain("EPERM persisted after 21 attempt(s)");
    expect((error as Error).cause).toBe(fixture.replacementError);
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
    const temp = fixture.renames[0]?.temp;
    expect(temp).toBeDefined();
    expect(readFileSync(temp as string, "utf8")).toBe(nextBytes);
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toHaveLength(1);
  });

  it("preserves an immediate replacement error when temp cleanup also fails", () => {
    const { path } = ledger();
    fixture.platform = "linux";
    fixture.persistent = true;
    fixture.cleanupError = new Error("cleanup was also denied");
    expect(thrownBy(() => writeLedgerAtomically(path, nextDocument))).toBe(fixture.replacementError);
    expect(fixture.sleeps).toEqual([]);
    expect(readFileSync(path, "utf8")).toBe(previousBytes);
  });

  it("still reports cleanup failure after a successful replacement", () => {
    const { path } = ledger();
    fixture.cleanupError = new Error("cleanup failed after replacement");
    expect(thrownBy(() => writeLedgerAtomically(path, nextDocument))).toBe(fixture.cleanupError);
    expect(readFileSync(path, "utf8")).toBe(nextBytes);
  });
});
