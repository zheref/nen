import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { VerbContext } from "../cli/verb.js";
import { runTag } from "./verb.js";

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

describe("nen tag cut -- CLI wiring", () => {
  it("cuts a local-only tag by default", () => {
    const runner = new ScriptedRunner([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "" } },
      { match: "git merge-base --is-ancestor abc origin/main", result: { code: 0 } },
      { match: "git tag v1.0.0 abc", result: {} },
    ]);
    const { context, out } = makeContext({ args: ["cut"], values: { name: "v1.0.0", at: "abc" } });
    expect(runTag(context, runner)).toBe(0);
    expect(out.some((l): boolean => l.includes("NOT pushed"))).toBe(true);
  });

  it("--push actually pushes", () => {
    const runner = new ScriptedRunner([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "" } },
      { match: "git merge-base --is-ancestor abc origin/main", result: { code: 0 } },
      { match: "git tag v1.0.0 abc", result: {} },
      { match: "git push origin v1.0.0", result: {} },
    ]);
    const { context } = makeContext({ args: ["cut"], values: { name: "v1.0.0", at: "abc" }, booleans: new Set(["push"]) });
    expect(runTag(context, runner)).toBe(0);
  });

  it("requires --name and --at", () => {
    expect(runTag(makeContext({ args: ["cut"] }).context, new ScriptedRunner([]))).toBe(2);
  });

  it("refuses an unknown subcommand", () => {
    expect(runTag(makeContext({ args: ["bogus"] }).context, new ScriptedRunner([]))).toBe(2);
  });
});
