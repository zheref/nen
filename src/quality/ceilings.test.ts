import { describe, expect, it } from "vitest";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "../index.js";
import { makeTempDir } from "../testing/tempdir.js";
import { compareBudgets, parsePerfCeilings } from "./ceilings.js";

const source = "zheref/bankai-handbooks@v0.12.0 handbooks/quality-baseline.md QA-13";
const declaration = { source, ceilings: [{ metric: "P1", ceiling: 2000, unit: "ms" }] };

async function compare(metric: string, baseline: string, measured: string, declared: unknown = declaration, json = true): Promise<{ code: number; out: string[]; err: string[]; report: () => Record<string, unknown> }> {
  const root = makeTempDir("nen-ceilings-");
  writeFileSync(join(root, "ceilings.json"), JSON.stringify(declared));
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(["quality", "perf-compare", "--repo", root, "--metric", metric,
    "--baseline", baseline, "--measured", measured, "--ceilings", "ceilings.json", ...(json ? ["--json"] : [])],
  { out: (s): void => { out.push(s); }, err: (s): void => { err.push(s); } });
  return { code, out, err, report: (): Record<string, unknown> => JSON.parse(out.join("\n")) as Record<string, unknown> };
}

describe("QA-13 absolute ceilings", () => {
  it("AC-1 reports an absolute breach even when relative performance improves", async () => {
    const result = await compare("P1", "4000", "2001");
    expect(result.code).toBe(1);
    expect(result.report()).toMatchObject({ metric: "P1", severity: "ok", absolute: {
      status: "breached", ceiling: 2000, unit: "ms", source,
    } });
  });

  it("AC-2 retains the absolute verdict while refusing a zero-baseline percentage", async () => {
    const result = await compare("P1", "0", "2000");
    expect(result.code).toBe(1);
    expect(result.report()).toMatchObject({ regressionPct: null, severity: null,
      percentageReason: expect.stringContaining("zero baseline"), absolute: { status: "within" } });
  });

  it("AC-3 says no ceiling applies to a metric absent from the declaration", async () => {
    const result = await compare("P2", "100", "100");
    expect(result.code).toBe(0);
    expect(result.report()).toMatchObject({ absolute: { status: "no-ceiling", ceiling: null, source } });
  });

  it("AC-4 names the declaration source and never guesses from a tool name", async () => {
    const result = await compare("Lighthouse", "100", "9999");
    expect(result.report()).toMatchObject({ absolute: { status: "no-ceiling", source } });
    const missingSource = await compare("P1", "100", "2001", { ceilings: declaration.ceilings });
    expect(missingSource.code).toBe(2);
    expect(missingSource.err.join("\n")).toContain("source");
  });

  it.each([
    ["P1", 2000, "ms"], ["P7-apple", 250, "ms"], ["P7-android", 5, "%"],
    ["P7-web", 200, "ms"], ["P5-web", 300, "KB compressed"],
  ] as const)("checks the declared inclusive %s ceiling without unit conversion", (metric, ceiling, unit) => {
    const declared = parsePerfCeilings(JSON.stringify({ source, ceilings: [{ metric, ceiling, unit }] }));
    expect(compareBudgets(metric, 1, ceiling, declared).absolute.status).toBe("within");
    expect(compareBudgets(metric, 1, ceiling + 0.001, declared).absolute.status).toBe("breached");
    expect(compareBudgets(metric.toLowerCase(), 1, ceiling + 1, declared).absolute.status).toBe("no-ceiling");
  });

  it("retains no-declaration and empty-declaration provenance distinctly", () => {
    expect(compareBudgets("P1", 0, 2001, null)).toMatchObject({ regressionPct: null,
      absolute: { status: "no-ceiling", source: null } });
    expect(compareBudgets("P1", 1, 1, { source, ceilings: [] }).absolute.source).toBe(source);
  });

  it.each([null, [], {}, { source, ceilings: {} }, { source: " ", ceilings: [] },
    { source: "bad\nsource", ceilings: [] }, { source, ceilings: [null] },
    { source, ceilings: [{ metric: "P1", ceiling: -1, unit: "ms" }] },
    { source, ceilings: [{ metric: "P1", ceiling: "2000", unit: "ms" }] },
    { source, ceilings: [{ metric: "P1", ceiling: 2000, unit: "" }] },
    { source, ceilings: [...declaration.ceilings, ...declaration.ceilings] },
  ])("refuses malformed or duplicate declaration rows: %j", (bad) => {
    expect(() => parsePerfCeilings(JSON.stringify(bad))).toThrow();
  });

  it("refuses invalid JSON and overflowing declaration numbers", () => {
    expect(() => parsePerfCeilings("{" )).toThrow();
    expect(() => parsePerfCeilings('{"source":"s","ceilings":[{"metric":"m","unit":"ms","ceiling":1e400}]}')).toThrow();
  });

  it("prints both human verdicts with the ceiling and source", async () => {
    const result = await compare("P1", "0", "2001", declaration, false);
    expect(result.out).toEqual(["P1: percentage refused -- zero baseline: a percentage regression is undefined",
      `absolute: breached -- 2001 ms vs ceiling 2000; source: ${source}`]);
    expect((await compare("P2", "1", "1", declaration, false)).out[1]).toBe(`absolute: no ceiling applies in ${source}`);
  });

  it.each([["1", " "], [" ", "1"], ["1", ""], ["", "1"]])("refuses blank numeric input (%j, %j) instead of manufacturing zero", async (baseline, measured) => {
    const result = await compare("P1", baseline, measured);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toContain("numbers");
  });

  it.each(["\u2028", "\u2029", "\u0085"])("refuses Unicode line/control separators %j in every declaration string", (separator) => {
    for (const field of ["source", "metric", "unit"]) {
      const value = { source, ceilings: [{ metric: "P1", unit: "ms", ceiling: 2000 }] };
      if (field === "source") value.source += separator;
      else Object.assign(value.ceilings[0] ?? {}, { [field]: `a${separator}b` });
      expect(() => parsePerfCeilings(JSON.stringify(value))).toThrow();
    }
  });

  it.each(["tooling", "method-check"])("refuses --ceilings on %s instead of ignoring it", async (verb) => {
    const out: string[] = [];
    const err: string[] = [];
    const code = await run(["quality", verb, "--ceilings", "missing.json"],
      { out: (s): void => { out.push(s); }, err: (s): void => { err.push(s); } });
    expect(code).toBe(2);
    expect(out).toEqual([]);
    expect(err.join("\n")).toContain("--ceilings is only valid with perf-compare");
  });

  it("names percentage overflow without losing severity or the absolute verdict", async () => {
    const result = await compare("P1", "1e-308", "2001");
    expect(result.code).toBe(1);
    expect(result.report()).toMatchObject({ regressionPct: null, severity: "critical",
      percentageReason: expect.stringContaining("numeric range"), absolute: { status: "breached" } });
  });
});
