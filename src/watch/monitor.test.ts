import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { watchCommand } from "./command.js";

class QueueSeams implements Seams {
  private readonly queue: CommandResult[];
  readonly now = (): Date => new Date("2026-01-01T00:00:00Z");
  readonly env = {};
  readonly platform: NodeJS.Platform = "linux";
  probePort: Seams["probePort"] = noPortProbe;
  runInteractive: Seams["runInteractive"] = (): never => {
    throw new Error("never");
  };
  runStreamed: Seams["runStreamed"] = (): never => {
    throw new Error("never");
  };
  constructor(queue: readonly CommandResult[]) {
    this.queue = [...queue];
  }
  run: Seams["run"] = (): CommandResult => {
    const next = this.queue.shift();
    if (next === undefined) throw new Error("ran out of scripted results");
    return next;
  };
}

const FALSE: CommandResult = { code: 1, stdout: "", stderr: "", spawnFailed: false };

async function capture(argv: readonly string[], repo: string, seams: Seams): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(watchCommand, argv, repo, false, io, seams);
  return { code, out, err };
}

describe("nen watch until reads the target's monitor policy (zheref/nen#216)", () => {
  it("monitor.maxCycles is the default bound: one false observation ends the watch at the bound, no sleep", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-monitor-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ monitor: { maxCycles: 1, pollSeconds: 300 } }));
    // ONE scripted result: a second observation would throw, proving the bound
    // was read from the file rather than left unbounded.
    const result = await capture(["watch", "until", "--command", "gh pr checks 1"], root, new QueueSeams([FALSE]));
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/--max-iterations bound \(1\)/);
  });

  it("a typed --max-iterations wins over the file", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-monitor-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ monitor: { maxCycles: 5, pollSeconds: 300 } }));
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--max-iterations", "1"],
      root,
      new QueueSeams([FALSE]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/bound \(1\)/);
  });

  it("with no policy file the watch is unbounded as before (a bound must be typed)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-nomonitor-"));
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--max-iterations", "1", "--interval-ms", "0"],
      root,
      new QueueSeams([FALSE]),
    );
    expect(result.code).toBe(1);
  });

  it("a policy file with NO monitor block keeps the old defaults: unbounded, so a typed bound is what ends it", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-watch-nomonitorblock-"));
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ coverage: { minimum: 80, recommended: 85, ideal: 90 } }));
    // TWO scripted results: with the loader's defaults wrongly read as declared,
    // maxCycles 20 would bound the watch and this case would still pass, so
    // the bound is typed as 2 and the watch must consume BOTH observations.
    const result = await capture(
      ["watch", "until", "--command", "gh pr checks 1", "--max-iterations", "2", "--interval-ms", "0"],
      root,
      new QueueSeams([FALSE, FALSE]),
    );
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/bound \(2\)/);
  });
});
