import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { qualityCommand } from "./command.js";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("quality makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(qualityCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen quality tooling -- CLI wiring", () => {
  it("resolves a scenario from a caller-supplied table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({ x: { e2e: "Playwright" } }));
    const result = await capture(["quality", "tooling", "--table", table, "--scenario", "x"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/e2e: Playwright/);
  });

  it("exits 1 for an unknown scenario", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({}));
    const result = await capture(["quality", "tooling", "--table", table, "--scenario", "x"]);
    expect(result.code).toBe(1);
  });
});

describe("nen quality perf-compare -- CLI wiring", () => {
  it("exits 0 for ok, 1 for high/critical", async () => {
    const ok = await capture(["quality", "perf-compare", "--metric", "m", "--baseline", "100", "--measured", "105"]);
    expect(ok.code).toBe(0);
    const bad = await capture(["quality", "perf-compare", "--metric", "m", "--baseline", "100", "--measured", "200"]);
    expect(bad.code).toBe(1);
    expect(bad.out.join("\n")).toMatch(/critical/);
  });

  it("requires --metric, --baseline and --measured", async () => {
    expect((await capture(["quality", "perf-compare"])).code).toBe(2);
  });
});

describe("nen quality method-check -- CLI wiring", () => {
  it("passes a complete method block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const input = join(dir, "method.json");
    writeFileSync(
      input,
      JSON.stringify({
        device: "d",
        os: "o",
        releaseConfig: true,
        debuggerAttached: false,
        sampleSize: 5,
        firstDiscarded: true,
        median: 1,
        p90: 2,
        thermalState: "nominal",
        networkCondition: "wifi",
      }),
    );
    const result = await capture(["quality", "method-check", "--input", input]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/OK/);
  });

  it("exits 1 and lists gaps for an incomplete block", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const input = join(dir, "method.json");
    writeFileSync(input, JSON.stringify({ device: "", os: "", releaseConfig: false, debuggerAttached: true, sampleSize: 1, firstDiscarded: false, median: null, p90: null, thermalState: null, networkCondition: null }));
    const result = await capture(["quality", "method-check", "--input", input]);
    expect(result.code).toBe(1);
    expect(result.out.some((line): boolean => line.startsWith("gap:"))).toBe(true);
  });

  it("requires --input", async () => {
    expect((await capture(["quality", "method-check"])).code).toBe(2);
  });
});

describe("nen quality -- refuses an unknown subcommand", () => {
  it("exits 2", async () => {
    expect((await capture(["quality", "bogus"])).code).toBe(2);
  });
});
