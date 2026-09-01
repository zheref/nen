import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runLabels } from "./verb.js";
import { listLabelNamesArgv, renameArgv } from "./rename.js";

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

describe("nen labels sync -- CLI wiring", () => {
  it("dry-run reports every label without calling gh", () => {
    const { context, out } = makeContext({ args: ["sync"], values: { target: "zheref/nen" }, booleans: new Set(["dry-run"]) });
    const runner = new ScriptedRunner([]);
    expect(runLabels(context, runner)).toBe(0);
    expect(out.length).toBeGreaterThan(0);
    expect(runner.calls).toEqual([]);
  });

  it("requires --target", () => {
    expect(runLabels(makeContext({ args: ["sync"] }).context, new ScriptedRunner([]))).toBe(1);
  });
});

describe("nen labels rename -- CLI wiring", () => {
  const TARGET = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

  it("renames per --map and exits 0 on success", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: { stdout: JSON.stringify([{ name: "old" }]) } },
      { match: `gh ${renameArgv(TARGET, { from: "old", to: "new" }).join(" ")}`, result: {} },
    ]);
    const { context, out } = makeContext({ args: ["rename"], values: { target: "zheref/nen", map: "old=new" } });
    expect(runLabels(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/renamed/);
  });

  it("requires --map", () => {
    const { context } = makeContext({ args: ["rename"], values: { target: "zheref/nen" } });
    expect(runLabels(context, new ScriptedRunner([]))).toBe(2);
  });

  it("exits 1 when a mapping fails", () => {
    const runner = new ScriptedRunner([
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: { stdout: "[]" } },
    ]);
    const { context } = makeContext({ args: ["rename"], values: { target: "zheref/nen", map: "old=new" } });
    expect(runLabels(context, runner)).toBe(1);
  });
});

describe("nen labels -- refuses an unknown subcommand", () => {
  it("exits 2", () => {
    expect(runLabels(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
