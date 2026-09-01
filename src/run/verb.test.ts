import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import type { VerbContext } from "../cli/verb.js";
import { doRun } from "./verb.js";

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

describe("nen run rerun-failed -- CLI wiring", () => {
  it("re-runs the failed jobs of a target run", () => {
    const { context, out } = makeContext({ args: ["rerun-failed"], values: { target: "zheref/KroApple", "run-id": "42" } });
    const runner = new ScriptedRunner([
      { match: "gh run rerun 42 --repo zheref/KroApple --failed", result: {} },
    ]);
    expect(doRun(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/re-ran the failed job/);
  });

  it("requires --target and --run-id", () => {
    expect(doRun(makeContext({ args: ["rerun-failed"] }).context, new ScriptedRunner([]))).toBe(2);
    expect(
      doRun(makeContext({ args: ["rerun-failed"], values: { target: "o/n" } }).context, new ScriptedRunner([])),
    ).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(doRun(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
