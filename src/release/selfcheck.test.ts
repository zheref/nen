import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { checkSelfEnumeration } from "./selfcheck.js";

describe("checkSelfEnumeration -- a git-mechanical fact, never a judgement", () => {
  it("lists itself when the merge is reachable from the cut point and not from the previous tag", () => {
    const seams = new ScriptedSeams([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 0 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 1 } },
    ]);
    const result = checkSelfEnumeration(seams, "/repo", "pr-sha", "v1.0.0", "cut-point");
    expect(result.shouldListItself).toBe(true);
  });

  it("does not list itself when it is already reachable from the previous tag", () => {
    const seams = new ScriptedSeams([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 0 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 0 } },
    ]);
    expect(checkSelfEnumeration(seams, "/repo", "pr-sha", "v1.0.0", "cut-point").shouldListItself).toBe(false);
  });

  it("does not list itself when it is not even reachable from the cut point", () => {
    const seams = new ScriptedSeams([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 1 } },
      { match: "git merge-base --is-ancestor pr-sha v1.0.0", result: { code: 1 } },
    ]);
    expect(checkSelfEnumeration(seams, "/repo", "pr-sha", "v1.0.0", "cut-point").shouldListItself).toBe(false);
  });

  it("throws on a genuine git failure rather than reading it as 'not an ancestor'", () => {
    const seams = new ScriptedSeams([
      { match: "git merge-base --is-ancestor pr-sha cut-point", result: { code: 128, stderr: "fatal" } },
    ]);
    expect(() => checkSelfEnumeration(seams, "/repo", "pr-sha", "v1.0.0", "cut-point")).toThrow();
  });

  it("throws, not a silent all-false result, when git itself never starts (spawnFailed, code -1)", () => {
    // The exact CommandResult src/seam/exec.ts's spawnRunner returns for an
    // ENOENT: `{ code: -1, spawnFailed: true }`. -1 is NOT > 1, so
    // `if (result.code > 1)` alone lets this fall through to
    // `result.code === 0` -- i.e. `false` for BOTH halves -- producing
    // `{ reachableFromCutPoint: false, alreadyInPreviousTag: false,
    // shouldListItself: false }` from a git that was never even run: a
    // silent WRONG answer, not a refusal.
    const seams = new ScriptedSeams([
      {
        match: "git merge-base --is-ancestor pr-sha cut-point",
        result: { code: -1, spawnFailed: true, stderr: "spawn git ENOENT" },
      },
    ]);
    expect(() => checkSelfEnumeration(seams, "/repo", "pr-sha", "v1.0.0", "cut-point")).toThrow();
    expect(() => checkSelfEnumeration(seams, "/repo", "pr-sha", "v1.0.0", "cut-point")).toThrow(
      /could not test whether/,
    );
  });
});
