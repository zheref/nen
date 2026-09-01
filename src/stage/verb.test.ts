import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runStage } from "./verb.js";

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

describe("nen stage triage -- CLI wiring", () => {
  it("exits 0 when nothing is flagged", () => {
    const runner = new ScriptedRunner([
      { match: "git status --porcelain=v1 --ignored -uall", result: { stdout: " M src/a.ts\n" } },
    ]);
    expect(runStage(makeContext({ args: ["triage"] }).context, runner)).toBe(0);
  });

  it("exits 1 and lists the reason(s) when something is flagged", () => {
    const runner = new ScriptedRunner([
      { match: "git status --porcelain=v1 --ignored -uall", result: { stdout: "?? .env\n" } },
    ]);
    const { context, out } = makeContext({ args: ["triage"] });
    expect(runStage(context, runner)).toBe(1);
    expect(out.join("\n")).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("passes --scope and --mentions through to the triage", () => {
    const runner = new ScriptedRunner([
      { match: "git status --porcelain=v1 --ignored -uall", result: { stdout: " M src/old.ts\n" } },
    ]);
    const { context } = makeContext({
      args: ["triage"],
      values: { scope: "src/", mentions: "renames src/old.ts" },
    });
    expect(runStage(context, runner)).toBe(0);
  });

  it("refuses an unknown subcommand", () => {
    expect(runStage(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
