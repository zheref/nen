import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { checkSelfEnumeration } from "./selfcheck.js";

describe("checkSelfEnumeration -- a git-mechanical fact, never a judgement", () => {
  it("lists itself when the merge is reachable from the cut point and not from the previous tag", () => {
    const runner = new ScriptedRunner([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 0 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 1 } },
    ]);
    const result = checkSelfEnumeration(runner, "/repo", "pr-sha", "v1.0.0", "cut-point");
    expect(result.shouldListItself).toBe(true);
  });

  it("does not list itself when it is already reachable from the previous tag", () => {
    const runner = new ScriptedRunner([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 0 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 0 } },
    ]);
    expect(checkSelfEnumeration(runner, "/repo", "pr-sha", "v1.0.0", "cut-point").shouldListItself).toBe(false);
  });

  it("does not list itself when it is not even reachable from the cut point", () => {
    const runner = new ScriptedRunner([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 1 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 1 } },
    ]);
    expect(checkSelfEnumeration(runner, "/repo", "pr-sha", "v1.0.0", "cut-point").shouldListItself).toBe(false);
  });

  it("throws on a genuine git failure rather than reading it as 'not an ancestor'", () => {
    const runner = new ScriptedRunner([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 128, stderr: "fatal" } },
    ]);
    expect(() => checkSelfEnumeration(runner, "/repo", "pr-sha", "v1.0.0", "cut-point")).toThrow();
  });
});
