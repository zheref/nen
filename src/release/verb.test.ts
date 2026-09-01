import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runRelease } from "./verb.js";

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

describe("nen release resolve-target -- CLI wiring", () => {
  it("exits 0 for an ancestor, 1 for a non-ancestor", () => {
    const runner = new ScriptedRunner([
      { match: "git fetch origin main", result: {} },
      { match: "git rev-parse origin/main", result: { stdout: "sha1\n" } },
      { match: "git merge-base --is-ancestor sha1 origin/main", result: { code: 0 } },
    ]);
    expect(runRelease(makeContext({ args: ["resolve-target"], values: { token: "main" } }).context, runner)).toBe(0);
  });

  it("requires --token", () => {
    expect(runRelease(makeContext({ args: ["resolve-target"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});

describe("nen release self-check -- CLI wiring", () => {
  it("reports shouldListItself and always exits 0 -- a report, not a guard", () => {
    const runner = new ScriptedRunner([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 0 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 1 } },
    ]);
    const { context, out } = makeContext({
      args: ["self-check"],
      values: { "pr-merge-sha": "pr-sha", "previous-tag": "v1.0.0", "cut-point": "cut-point" },
    });
    expect(runRelease(context, runner)).toBe(0);
    expect(out.join("\n")).toMatch(/should list ITSELF/);
  });

  it("requires all three flags", () => {
    expect(runRelease(makeContext({ args: ["self-check"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});

describe("nen release -- refuses an unknown subcommand", () => {
  it("exits 2", () => {
    expect(runRelease(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
