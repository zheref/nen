// src/phase/ledger.test.ts -- the phase ledger's append under contention
// (Copilot review on zheref/nen#231): two `nen shu --effort` runs recording
// steps on the same open entry at once must both land, a held lock is waited
// for and then refused (never written past), a stale lock is broken and said
// so, and a write is never seen torn.

import { describe, expect, it } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  appendStepsToOpenPhase,
  IDLE_WAIT_MS,
  idleWait,
  ledgerLockPath,
  PHASE_CONTRACT,
  phaseLedgerPath,
  readLedger,
  WAIT_PHASES,
  writeLedger,
  type PhaseStep,
} from "./ledger.js";
import { localEffortHome } from "../ledger/home.js";

const step = (n: number, who: string): PhaseStep => ({ verb: "build", argv: `${who} ${n}`, exitCode: 0, durationMs: n, stalled: false });

function openLedgerAt(root: string, effort: string): string {
  const path = phaseLedgerPath(root, effort);
  writeLedger(path, {
    contract: PHASE_CONTRACT,
    effort,
    phases: [{ phase: "rasengan", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, durationMs: null, exitCode: null, surface: null, model: null, dial: null, note: null, steps: [] }],
  });
  return path;
}

function haveBun(): boolean {
  const probe = spawnSync("bun", ["--version"], { encoding: "utf8" });
  return !probe.error && probe.status === 0;
}

describe("appendStepsToOpenPhase under contention (zheref/nen#231)", () => {
  it.skipIf(!haveBun())("two processes appending at once lose nothing: every step of both lands, in ledger order", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-race-"));
    const path = openLedgerAt(root, "race");
    const ledgerModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "ledger.ts")).href;
    const homeModule = pathToFileURL(join(dirname(fileURLToPath(import.meta.url)), "..", "ledger", "home.ts")).href;
    const script = join(root, "append.ts");
    // Each process appends COUNT single-step batches, one lock cycle per batch,
    // so the two interleave at the lock rather than once at the start.
    const COUNT = 40;
    writeFileSync(script, [
      `import { appendStepsToOpenPhase } from ${JSON.stringify(ledgerModule)};`,
      `import { localEffortHome } from ${JSON.stringify(homeModule)};`,
      `const who = process.argv[2];`,
      `for (let n = 0; n < ${COUNT}; n += 1) {`,
      `  if (!appendStepsToOpenPhase(localEffortHome(${JSON.stringify(root)}, "phases"), "race", [{ verb: "build", argv: who + " " + n, exitCode: 0, durationMs: n, stalled: false }])) process.exit(3);`,
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
    const steps = readLedger(path, "race").phases[0]?.steps ?? [];
    expect(steps).toHaveLength(COUNT * 2);
    for (const who of ["a", "b"]) {
      expect(steps.filter((s): boolean => s.argv.startsWith(`${who} `)).map((s): number | null => s.durationMs)).toEqual(Array.from({ length: COUNT }, (_, n): number => n));
    }
    expect(existsSync(ledgerLockPath(path))).toBe(false);
    expect(readdirSync(dirname(path)).filter((name): boolean => name.endsWith(".tmp"))).toEqual([]);
  }, 30_000);

  it("a lock somebody holds is waited for, then refused by name -- and nothing is written past it", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-held-"));
    const path = openLedgerAt(root, "held");
    writeFileSync(ledgerLockPath(path), "99999\n");
    const before = readFileSync(path, "utf8");
    const warned: string[] = [];
    const started = Date.now();
    expect(() => appendStepsToOpenPhase(localEffortHome(root, "phases"), "held", [step(1, "late")], { waitMs: 150, warn: (l): void => { warned.push(l); } }))
      .toThrow(/'.*held\.json\.lock' is held by another nen run and was not released within 150ms/);
    expect(Date.now() - started).toBeGreaterThanOrEqual(100);
    expect(readFileSync(path, "utf8")).toBe(before);
    expect(existsSync(ledgerLockPath(path))).toBe(true);
    expect(warned).toEqual([]);
  });

  it("a stale lock (older than the threshold) is broken, said so on warn, and the append lands", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-stale-"));
    const path = openLedgerAt(root, "stale");
    const lock = ledgerLockPath(path);
    writeFileSync(lock, "1\n");
    const old = (Date.now() - 60_000) / 1000;
    utimesSync(lock, old, old);
    const warned: string[] = [];
    expect(appendStepsToOpenPhase(localEffortHome(root, "phases"), "stale", [step(7, "after")], { warn: (l): void => { warned.push(l); } })).toBe(true);
    expect(warned).toHaveLength(1);
    expect(warned[0]).toMatch(/broke the stale ledger lock '.*stale\.json\.lock' \(\d+s old; a holder that old has crashed\)/);
    expect(readLedger(path, "stale").phases[0]?.steps).toEqual([step(7, "after")]);
    expect(existsSync(lock)).toBe(false);
  });

  it("writes through a temp file and a rename: the ledger is whole and no temp file is left", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-ledger-atomic-"));
    const path = openLedgerAt(root, "atomic");
    expect(appendStepsToOpenPhase(localEffortHome(root, "phases"), "atomic", [step(1, "x"), step(2, "x")])).toBe(true);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({ contract: PHASE_CONTRACT, effort: "atomic" });
    expect(readdirSync(dirname(path))).toEqual(["atomic.json"]);
  });
});

// zheref/nen#639: a readiness phase held open from one sitting to the final
// report counted ~110 hours of waiting as spend. Derived at read time only.
describe("idleWait -- what spend counts of one phase", () => {
  const MINUTE = 60_000;
  const steps = (...ms: (number | null)[]): PhaseStep[] => ms.map((durationMs): PhaseStep => ({ verb: "build", argv: "x", exitCode: 0, durationMs, stalled: false }));

  it("is one hour on readiness only", () => {
    expect(IDLE_WAIT_MS).toBe(60 * MINUTE);
    expect(WAIT_PHASES).toEqual(["readiness"]);
  });

  it("is null/null for an OPEN phase, wait or not", () => {
    expect(idleWait({ phase: "readiness", durationMs: null, steps: [] })).toEqual({ countedMs: null, idleWaitMs: null });
    expect(idleWait({ phase: "rasengan", durationMs: null })).toEqual({ countedMs: null, idleWaitMs: null });
  });

  it("counts only the timed steps of a closed wait phase untimed for over the line", () => {
    expect(idleWait({ phase: "readiness", durationMs: 396726699, steps: [] })).toEqual({ countedMs: 0, idleWaitMs: 396726699 });
    // An entry written before `steps[]` existed reads as none.
    expect(idleWait({ phase: "readiness", durationMs: 2 * IDLE_WAIT_MS })).toEqual({ countedMs: 0, idleWaitMs: 2 * IDLE_WAIT_MS });
    // An untimed step counts 0 toward the timed total.
    expect(idleWait({ phase: "readiness", durationMs: 3 * IDLE_WAIT_MS, steps: steps(5 * MINUTE, null) })).toEqual({
      countedMs: 5 * MINUTE,
      idleWaitMs: 3 * IDLE_WAIT_MS - 5 * MINUTE,
    });
  });

  it("counts the whole duration at, and just under, the line -- and just over it is idle", () => {
    expect(idleWait({ phase: "readiness", durationMs: IDLE_WAIT_MS, steps: [] })).toEqual({ countedMs: IDLE_WAIT_MS, idleWaitMs: 0 });
    expect(idleWait({ phase: "readiness", durationMs: 59 * MINUTE, steps: [] })).toEqual({ countedMs: 59 * MINUTE, idleWaitMs: 0 });
    expect(idleWait({ phase: "readiness", durationMs: IDLE_WAIT_MS + 1, steps: [] })).toEqual({ countedMs: 0, idleWaitMs: IDLE_WAIT_MS + 1 });
    // The line is on the UNTIMED span: steps that cover the phase keep it whole.
    expect(idleWait({ phase: "readiness", durationMs: 5 * 24 * 60 * MINUTE, steps: steps(5 * 24 * 60 * MINUTE - 10 * MINUTE) })).toEqual({
      countedMs: 5 * 24 * 60 * MINUTE,
      idleWaitMs: 0,
    });
  });

  it("never calls a phase that is not a wait phase idle, however long and untimed", () => {
    expect(idleWait({ phase: "rasengan", durationMs: 5 * 24 * 60 * MINUTE, steps: [] })).toEqual({ countedMs: 5 * 24 * 60 * MINUTE, idleWaitMs: 0 });
    expect(idleWait({ phase: "pr", durationMs: 132619, steps: [] })).toEqual({ countedMs: 132619, idleWaitMs: 0 });
  });
});
