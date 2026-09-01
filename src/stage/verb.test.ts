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
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/a.ts\0" } },
    ]);
    expect(runStage(makeContext({ args: ["triage"] }).context, runner)).toBe(0);
  });

  it("exits 1 and lists the reason(s) when something is flagged", () => {
    const runner = new ScriptedRunner([
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: "?? .env\0" } },
    ]);
    const { context, out } = makeContext({ args: ["triage"] });
    expect(runStage(context, runner)).toBe(1);
    expect(out.join("\n")).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("passes --scope and --mentions through to the triage", () => {
    const runner = new ScriptedRunner([
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/old.ts\0" } },
    ]);
    const { context } = makeContext({
      args: ["triage"],
      values: { scope: "src/", mentions: "renames src/old.ts" },
    });
    expect(runStage(context, runner)).toBe(0);
  });

  it("flags a real secret file even at a non-ASCII path (BLOCKER #3)", () => {
    const runner = new ScriptedRunner([
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: "?? secrëts/.env\0" },
      },
    ]);
    const { context, out } = makeContext({ args: ["triage"] });
    expect(runStage(context, runner)).toBe(1);
    expect(out.join("\n")).toMatch(/secrëts\/\.env {2}\[secret-shape\]/);
  });

  it("refuses an unknown subcommand", () => {
    expect(runStage(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
