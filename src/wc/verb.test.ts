import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runWc } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: BANKAI_REPO,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen wc classify -- CLI wiring", () => {
  it("reports must-move for a dirty trunk", () => {
    const runner = new ScriptedRunner([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    const { context, out } = makeContext({ args: ["classify"] });
    expect(runWc(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/case: must-move/);
  });

  it("always exits 0 -- a report, not a guard", () => {
    const runner = new ScriptedRunner([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(runWc(makeContext({ args: ["classify"] }).context, runner)).toBe(0);
  });

  it("refuses an unknown subcommand", () => {
    expect(runWc(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
