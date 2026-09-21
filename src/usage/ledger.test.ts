// src/usage/ledger.test.ts -- the usage ledger's append under contention
// (Copilot review on zheref/nen#231, T7): two `nen usage record` runs on the
// same effort at once must both land, through the lock ../ledger/lock.ts
// shares with the phase ledger, and a write is never seen torn.

import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ledgerLockPath } from "../ledger/lock.js";
import { appendUsageEntry, readUsageLedger, USAGE_CONTRACT, usageLedgerPath, type UsageEntry } from "./ledger.js";

const entry = (n: number, who: string): UsageEntry => ({
  recordedAt: "2026-09-20T10:00:00.000Z",
  surface: who,
  model: null,
  input: n,
  output: null,
  cacheRead: null,
  cacheWrite: null,
  minutes: null,
  source: null,
  note: null,
  notReported: false,
});

function haveBun(): boolean {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

describe("appendUsageEntry under contention (zheref/nen#231)", () => {
  it.skipIf(!haveBun())("two processes recording at once lose nothing: every entry of both lands, in ledger order", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-race-"));
    const path = usageLedgerPath(root, "race");
    const ledgerModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "ledger.ts")).href;
    const script = join(root, "record.ts");
    // Each process appends COUNT entries, one lock cycle per entry, so the two
    // interleave at the lock rather than once at the start. The first append
    // of each also races to CREATE the ledger, which is the other lost-write.
    const COUNT = 40;
    writeFileSync(script, [
      `import { appendUsageEntry } from ${JSON.stringify(ledgerModule)};`,
      `const who = process.argv[2];`,
      `for (let n = 0; n < ${COUNT}; n += 1) {`,
      `  appendUsageEntry(${JSON.stringify(path)}, "race", { recordedAt: "2026-09-20T10:00:00.000Z", surface: who, model: null, input: n, output: null, cacheRead: null, cacheWrite: null, minutes: null, source: null, note: null, notReported: false });`,
      `}`,
    ].join("\n"));
    const run = (who: string): Promise<{ code: number | null; stderr: string }> =>
      new Promise((resolve) => {
        const child = spawn("bun", [script, who], { stdio: ["ignore", "ignore", "pipe"] });
        let stderr = "";
        child.stderr.on("data", (chunk: Buffer): void => { stderr += chunk.toString(); });
        child.on("close", (code): void => { resolve({ code, stderr }); });
      });
    const [a, b] = await Promise.all([run("a"), run("b")]);
    expect(a).toEqual({ code: 0, stderr: "" });
    expect(b).toEqual({ code: 0, stderr: "" });
    const entries = readUsageLedger(path, "race").entries;
    expect(entries).toHaveLength(COUNT * 2);
    for (const who of ["a", "b"]) {
      expect(entries.filter((e): boolean => e.surface === who).map((e): number | null => e.input)).toEqual(Array.from({ length: COUNT }, (_, n): number => n));
    }
    expect(existsSync(ledgerLockPath(path))).toBe(false);
    expect(readdirSync(dirname(path)).filter((name): boolean => name.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  it("a lock somebody holds is waited for, then refused by name -- and nothing is written past it", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-held-"));
    const path = usageLedgerPath(root, "held");
    appendUsageEntry(path, "held", entry(0, "first"));
    writeFileSync(ledgerLockPath(path), "99999\n");
    const before = readFileSync(path, "utf8");
    expect(() => appendUsageEntry(path, "held", entry(1, "late"), { waitMs: 100 }))
      .toThrow(/'.*held\.json\.lock' is held by another nen run and was not released within 100ms/);
    expect(readFileSync(path, "utf8")).toBe(before);
  });

  it("a stale lock is broken, said so on warn, and the append lands", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-usage-stale-"));
    const path = usageLedgerPath(root, "stale");
    const lock = ledgerLockPath(path);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(lock, "1\n");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const warned: string[] = [];
    const written = appendUsageEntry(path, "stale", entry(7, "after"), { warn: (l): void => { warned.push(l); } });
    expect(written.entries).toEqual([entry(7, "after")]);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/broke the stale ledger lock '.*stale\.json\.lock'/);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ contract: USAGE_CONTRACT, effort: "stale" });
    expect(existsSync(lock)).toBe(false);
    expect(readdirSync(dirname(path))).toEqual(["stale.json"]);
  });
});
