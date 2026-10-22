import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { PHASE_CONTRACT, PHASE_LEDGER_DIR, phaseCommand } from "./command.js";
import { appendStepsToOpenPhase } from "./ledger.js";

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
    const path = join(root, PHASE_LEDGER_DIR, "HA%2F85.json");
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

  it("'HA/85' and 'HA-85' are two ledgers, never one (the filename encoding is injective)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    await capture(["phase", "begin", "--effort", "HA/85", "--phase", "a"], root, "2026-01-01T00:00:00Z");
    await capture(["phase", "begin", "--effort", "HA-85", "--phase", "b"], root, "2026-01-01T00:00:01Z");
    const slash = await capture(["phase", "show", "--effort", "HA/85", "--json"], root, "2026-01-01T00:00:02Z");
    const dash = await capture(["phase", "show", "--effort", "HA-85", "--json"], root, "2026-01-01T00:00:02Z");
    expect((JSON.parse(slash.out.join("\n")) as { phases: { phase: string }[] }).phases.map((p): string => p.phase)).toEqual(["a"]);
    expect((JSON.parse(dash.out.join("\n")) as { phases: { phase: string }[] }).phases.map((p): string => p.phase)).toEqual(["b"]);
  });

  it("begins with 'steps: []', and show renders recorded steps indented under their phase (zheref/nen#227)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    await capture(["phase", "begin", "--effort", "x", "--phase", "rasengan"], root, "2026-01-01T00:00:00Z");
    const path = join(root, PHASE_LEDGER_DIR, "x.json");
    const fresh = JSON.parse(readFileSync(path, "utf8")) as { phases: { steps: unknown[] }[] };
    expect(fresh.phases[0]?.steps).toEqual([]);
    expect(Object.keys(fresh.phases[0] ?? {})).toEqual(["phase", "startedAt", "endedAt", "durationMs", "exitCode", "surface", "model", "note", "steps", "dial"]);
    expect(appendStepsToOpenPhase(root, "x", [
      { verb: "build", argv: "placeholder-tool go", exitCode: 0, durationMs: 1200, stalled: false },
      { verb: "lint", argv: "placeholder-tool lint", exitCode: null, durationMs: null, stalled: true },
    ])).toBe(true);
    const show = await capture(["phase", "show", "--effort", "x"], root, "2026-01-01T00:00:09Z");
    expect(show.out).toEqual([
      "effort: x (1 phase entry)",
      "  rasengan            open  2026-01-01T00:00:00.000Z",
      "    build        1200ms e0  placeholder-tool go",
      "    lint           STALLED  placeholder-tool lint",
    ]);
    // Ending the phase keeps the steps.
    await capture(["phase", "end", "--effort", "x", "--exit", "0"], root, "2026-01-01T00:00:10Z");
    expect((JSON.parse(readFileSync(path, "utf8")) as { phases: { steps: unknown[] }[] }).phases[0]?.steps).toHaveLength(2);
    // Nothing open: nothing appended, nothing written.
    expect(appendStepsToOpenPhase(root, "x", [{ verb: "build", argv: "x", exitCode: 0, durationMs: 1, stalled: false }])).toBe(false);
    // An entry written before the key existed renders without it.
    writeFileSync(path, JSON.stringify({ contract: PHASE_CONTRACT, effort: "x", phases: [{ phase: "old", startedAt: "2026-01-01T00:00:00.000Z", endedAt: "2026-01-01T00:00:01.000Z", durationMs: 1000, exitCode: 0, surface: null, model: null, note: null }] }));
    expect((await capture(["phase", "show", "--effort", "x"], root, "2026-01-01T00:00:09Z")).out).toHaveLength(2);
  });

  it("refuses a bad effort id and a negative exit", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    expect((await capture(["phase", "begin", "--effort", "../x", "--phase", "a"], root, "2026-01-01T00:00:00Z")).code).toBe(2);
    await capture(["phase", "begin", "--effort", "x", "--phase", "a"], root, "2026-01-01T00:00:00Z");
    expect((await capture(["phase", "end", "--effort", "x", "--exit", "-1"], root, "2026-01-01T00:00:00Z")).code).toBe(2);
  });
});

describe("phase effort dial (#437)", () => {
  it("records verbatim, defaults null, and normalizes a legacy ledger on show/end", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-dial-"));
    await capture(["phase", "begin", "--effort", "e", "--phase", "p", "--surface", "claude-code", "--dial", " high custom "], root, "2026-01-01T00:00:00Z");
    let result = await capture(["phase", "show", "--effort", "e", "--json"], root, "2026-01-01T00:00:01Z");
    expect(JSON.parse(result.out.join("\n")).phases[0].dial).toBe(" high custom ");
    await capture(["phase", "begin", "--effort", "e", "--phase", "other"], root, "2026-01-01T00:00:01Z");
    const path = join(root, PHASE_LEDGER_DIR, "e.json");
    const doc = JSON.parse(readFileSync(path, "utf8"));
    expect(doc.phases[1].dial).toBeNull();
    delete doc.phases[0].dial;
    writeFileSync(path, JSON.stringify(doc));
    result = await capture(["phase", "show", "--effort", "e", "--json"], root, "2026-01-01T00:00:02Z");
    expect(JSON.parse(result.out.join("\n")).phases[0].dial).toBeNull();
    await capture(["phase", "end", "--effort", "e", "--phase", "p"], root, "2026-01-01T00:00:03Z");
    expect(JSON.parse(readFileSync(path, "utf8")).phases[0].dial).toBeNull();
  });
});

describe("nen phase begin --resume (Hatsu SDD plan N6)", () => {
  const LEDGER = (root: string): { phases: { phase: string; startedAt: string; endedAt: string | null; resumedAt?: string[] }[] } =>
    JSON.parse(readFileSync(join(root, PHASE_LEDGER_DIR, "e1.json"), "utf8")) as { phases: { phase: string; startedAt: string; endedAt: string | null; resumedAt?: string[] }[] };

  it("continues an entry already open with the same name: resumedAt appended, the start kept, no second entry", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    expect((await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan"], root, "2026-01-01T00:00:00Z")).code).toBe(0);
    const first = await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan", "--resume"], root, "2026-01-01T00:05:00Z");
    expect(first.code).toBe(0);
    expect(first.out.join("\n")).toMatch(/resumed rasengan on 'e1' at 2026-01-01T00:05:00.000Z \(open since 2026-01-01T00:00:00.000Z\)/);
    expect((await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan", "--resume"], root, "2026-01-01T00:09:00Z")).code).toBe(0);
    const ledger = LEDGER(root);
    expect(ledger.phases).toHaveLength(1);
    expect(ledger.phases[0]).toMatchObject({ phase: "rasengan", startedAt: "2026-01-01T00:00:00.000Z", endedAt: null, resumedAt: ["2026-01-01T00:05:00.000Z", "2026-01-01T00:09:00.000Z"] });
    const shown = await capture(["phase", "show", "--effort", "e1"], root, "2026-01-01T00:10:00Z");
    expect(shown.out.join("\n")).toMatch(/resumed at 2026-01-01T00:05:00.000Z, 2026-01-01T00:09:00.000Z/);
  });

  it("still refuses the same open name without --resume, naming --resume", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan"], root, "2026-01-01T00:00:00Z");
    const again = await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan"], root, "2026-01-01T00:01:00Z");
    expect(again.code).toBe(2);
    expect(again.err.join("\n")).toMatch(/already open on effort 'e1'.*--resume/);
    expect(LEDGER(root).phases).toHaveLength(1);
  });

  it("refuses --resume while a differently named phase is open, writing nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    await capture(["phase", "begin", "--effort", "e1", "--phase", "breath"], root, "2026-01-01T00:00:00Z");
    const refused = await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan", "--resume"], root, "2026-01-01T00:01:00Z");
    expect(refused.code).toBe(2);
    expect(refused.err.join("\n")).toMatch(/'breath' is open instead/);
    expect(LEDGER(root).phases.map((entry) => entry.phase)).toEqual(["breath"]);
  });

  it("begins a fresh entry when nothing is open at all, and is refused on 'end' and 'show'", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-phase-"));
    const began = await capture(["phase", "begin", "--effort", "e1", "--phase", "rasengan", "--resume"], root, "2026-01-01T00:00:00Z");
    expect(began.code).toBe(0);
    expect(began.out.join("\n")).toMatch(/began rasengan .*nothing was open to continue/);
    expect(LEDGER(root).phases[0]?.resumedAt).toBeUndefined();
    expect((await capture(["phase", "end", "--effort", "e1", "--resume"], root, "2026-01-01T00:01:00Z")).code).toBe(2);
    expect((await capture(["phase", "show", "--effort", "e1", "--resume"], root, "2026-01-01T00:01:00Z")).code).toBe(2);
  });
});
