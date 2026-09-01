import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runPr } from "./verb.js";
import { retargetArgv } from "./retarget.js";
import type { Target } from "../github/target.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

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

describe("nen pr -- CLI wiring", () => {
  it("requires --target", () => {
    const { context, err } = makeContext({ args: ["fetch"], values: { pr: "1" } });
    expect(runPr(context, new ScriptedRunner([]))).toBe(1);
    expect(err.join("\n")).toMatch(/--target/);
  });

  it("requires a valid --pr", () => {
    const { context } = makeContext({ args: ["fetch"], values: { target: "o/n" } });
    expect(runPr(context, new ScriptedRunner([]))).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(runPr(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });

  it("retarget requires --base", () => {
    const { context } = makeContext({ args: ["retarget"], values: { target: "o/n", pr: "1" } });
    expect(runPr(context, new ScriptedRunner([]))).toBe(2);
  });

  it("retarget exits 0 on success and calls gh with the right argv", () => {
    const { context, out } = makeContext({
      args: ["retarget"],
      values: { target: "zheref/nen", pr: "12", base: "release/1.0" },
    });
    const runner = new ScriptedRunner([
      { match: `gh ${retargetArgv(TARGET, 12, "release/1.0").join(" ")}`, result: {} },
    ]);
    expect(runPr(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/now targets/);
  });

  it("cascade-main resolves the repo root and reports a conflict as exit 1", () => {
    const { context } = makeContext({ args: ["cascade-main"], repoFlag: BANKAI_REPO });
    const runner = new ScriptedRunner([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
    ]);
    expect(runPr(context, runner)).toBe(1);
  });
});
