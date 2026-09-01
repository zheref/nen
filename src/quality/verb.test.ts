import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { qualityVerb } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: null,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen quality tooling -- CLI wiring", () => {
  it("resolves a scenario from a caller-supplied table", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({ x: { e2e: "Playwright" } }));
    const { context, out } = makeContext({ args: ["tooling"], values: { table, scenario: "x" } });
    expect(qualityVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/e2e: Playwright/);
  });

  it("exits 1 for an unknown scenario", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const table = join(dir, "table.json");
    writeFileSync(table, JSON.stringify({}));
    const { context } = makeContext({ args: ["tooling"], values: { table, scenario: "x" } });
    expect(qualityVerb.run(context)).toBe(1);
  });
});

describe("nen quality perf-compare -- CLI wiring", () => {
  it("exits 0 for ok, 1 for high/critical", () => {
    const ok = makeContext({ args: ["perf-compare"], values: { metric: "m", baseline: "100", measured: "105" } });
    expect(qualityVerb.run(ok.context)).toBe(0);
    const bad = makeContext({ args: ["perf-compare"], values: { metric: "m", baseline: "100", measured: "200" } });
    expect(qualityVerb.run(bad.context)).toBe(1);
    expect(bad.out.join("\n")).toMatch(/critical/);
  });

  it("requires --metric, --baseline and --measured", () => {
    expect(qualityVerb.run(makeContext({ args: ["perf-compare"] }).context)).toBe(2);
  });
});

describe("nen quality method-check -- CLI wiring", () => {
  it("passes a complete method block", () => {
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
    const { context, out } = makeContext({ args: ["method-check"], values: { input } });
    expect(qualityVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/OK/);
  });

  it("exits 1 and lists gaps for an incomplete block", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-quality-"));
    const input = join(dir, "method.json");
    writeFileSync(input, JSON.stringify({ device: "", os: "", releaseConfig: false, debuggerAttached: true, sampleSize: 1, firstDiscarded: false, median: null, p90: null, thermalState: null, networkCondition: null }));
    const { context, out } = makeContext({ args: ["method-check"], values: { input } });
    expect(qualityVerb.run(context)).toBe(1);
    expect(out.some((line): boolean => line.startsWith("gap:"))).toBe(true);
  });

  it("requires --input", () => {
    expect(qualityVerb.run(makeContext({ args: ["method-check"] }).context)).toBe(2);
  });
});

describe("nen quality -- refuses an unknown subcommand", () => {
  it("exits 2", () => {
    expect(qualityVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });
});
