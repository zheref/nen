import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { resolveReleaseTarget, ResolveTargetError } from "./target.js";

describe("resolveReleaseTarget -- resolve, THEN test reachability", () => {
  it("resolves 'main' and 'last-commit' to origin/main's re-fetched tip", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git rev-parse origin/main", result: { stdout: "abc123\n" } },
      { match: "git merge-base --is-ancestor abc123 origin/main", result: { code: 0 } },
    ]);
    const result = resolveReleaseTarget(seams, "/repo", "main");
    expect(result).toEqual({ token: "main", sha: "abc123", isAncestorOfTrunk: true });
  });

  it("resolves an arbitrary hash or branch name via rev-parse", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git rev-parse feature/x", result: { stdout: "def456\n" } },
      { match: "git merge-base --is-ancestor def456 origin/main", result: { code: 1 } },
    ]);
    const result = resolveReleaseTarget(seams, "/repo", "feature/x");
    expect(result.isAncestorOfTrunk).toBe(false);
  });

  it("resolves 'checkout' to HEAD when the working copy is clean", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-parse HEAD", result: { stdout: "ghi789\n" } },
      { match: "git merge-base --is-ancestor ghi789 origin/main", result: { code: 0 } },
    ]);
    expect(resolveReleaseTarget(seams, "/repo", "checkout").sha).toBe("ghi789");
  });

  it("refuses 'checkout' outright when the working copy is dirty -- never resolves to HEAD anyway", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(() => resolveReleaseTarget(seams, "/repo", "checkout")).toThrow(/DIRTY working copy/);
  });

  it("throws distinctly when the reachability test itself fails (not merely 'not an ancestor')", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git rev-parse abc", result: { stdout: "abc\n" } },
      { match: "git merge-base --is-ancestor abc origin/main", result: { code: 128, stderr: "fatal: not a valid object" } },
    ]);
    expect(() => resolveReleaseTarget(seams, "/repo", "abc")).toThrow(ResolveTargetError);
  });

  it("takes a custom trunk", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin release", result: {} },
      { match: "git rev-parse origin/release", result: { stdout: "xyz\n" } },
      { match: "git merge-base --is-ancestor xyz origin/release", result: { code: 0 } },
    ]);
    expect(resolveReleaseTarget(seams, "/repo", "main", "release").sha).toBe("xyz");
  });
});
