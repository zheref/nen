import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { PHASE_CONTRACT, PHASE_LEDGER_DIR, phaseCommand } from "./command.js";

function seamsAt(iso: string): Seams {
  return {
    run: (): never => {
      throw new Error("must not be called");
    },
    now: (): Date => new Date(iso),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
}

async function capture(argv: readonly string[], repo: string, at: string): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(phaseCommand, argv, repo, false, io, seamsAt(at));
  return { code, out, err };
}

describe("nen phase begin|end -- the per-phase timing ledger", () => {
  it("begins, ends, and records the elapsed milliseconds from the seam's clock", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    const begin = await capture(["phase", "begin", "--effort", "HA/85", "--phase", "breath", "--surface", "codex"], root, "2026-01-01T00:00:00Z");
    expect(begin.code).toBe(0);
    const path = join(root, PHASE_LEDGER_DIR, "HA-85.json");
    expect(existsSync(path)).toBe(true);

    const end = await capture(["phase", "end", "--effort", "HA/85", "--exit", "0"], root, "2026-01-01T00:00:07.500Z");
    expect(end.code).toBe(0);
    expect(end.out.join("\n")).toMatch(/ended breath on 'HA\/85' after 7500ms \(exit 0\)/);
    const ledger = JSON.parse(readFileSync(path, "utf8")) as { contract: string; phases: { phase: string; durationMs: number; surface: string; exitCode: number }[] };
    expect(ledger.contract).toBe(PHASE_CONTRACT);
    expect(ledger.phases[0]?.durationMs).toBe(7500);
    expect(ledger.phases[0]?.surface).toBe("codex");
    expect(ledger.phases[0]?.exitCode).toBe(0);
  });

  it("refuses a second open entry with the same name, and an end with nothing open", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    expect((await capture(["phase", "end", "--effort", "x"], root, "2026-01-01T00:00:00Z")).code).toBe(2);
    expect((await capture(["phase", "begin", "--effort", "x", "--phase", "a"], root, "2026-01-01T00:00:00Z")).code).toBe(0);
    const twice = await capture(["phase", "begin", "--effort", "x", "--phase", "a"], root, "2026-01-01T00:00:01Z");
    expect(twice.code).toBe(2);
    expect(twice.err.join("\n")).toMatch(/already open/);
  });

  it("ends the named phase when two are open, and show lists both", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    await capture(["phase", "begin", "--effort", "x", "--phase", "outer"], root, "2026-01-01T00:00:00Z");
    await capture(["phase", "begin", "--effort", "x", "--phase", "inner"], root, "2026-01-01T00:00:01Z");
    const end = await capture(["phase", "end", "--effort", "x", "--phase", "outer", "--exit", "1"], root, "2026-01-01T00:00:05Z");
    expect(end.out.join("\n")).toMatch(/ended outer .* after 5000ms \(exit 1\)/);
    const show = await capture(["phase", "show", "--effort", "x"], root, "2026-01-01T00:00:09Z");
    expect(show.out.join("\n")).toMatch(/2 phase entries/);
    expect(show.out.join("\n")).toMatch(/inner\s+open/);
  });

  it("refuses a bad effort id and a negative exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    expect((await capture(["phase", "begin", "--effort", "../x", "--phase", "a"], root, "2026-01-01T00:00:00Z")).code).toBe(2);
    await capture(["phase", "begin", "--effort", "x", "--phase", "a"], root, "2026-01-01T00:00:00Z");
    expect((await capture(["phase", "end", "--effort", "x", "--exit", "-1"], root, "2026-01-01T00:00:00Z")).code).toBe(2);
  });
});
