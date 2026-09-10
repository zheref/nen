import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { cascadeMain } from "./cascade.js";

describe("cascadeMain -- merge, never rebase, and never resolve a conflict itself", () => {
  it("fetches, merges cleanly, and pushes", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: {} },
      { match: "git push", result: {} },
    ]);
    const result = cascadeMain(seams, "/repo");
    expect(result).toMatchObject({ conflicted: false, pushed: true, noPush: false, error: null, conflicts: [] });
  });

  it("reports a conflict without pushing or aborting the merge, and still scans for unmerged paths", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
      // No unmerged paths in this fixture -- the scan runs, finds nothing, and
      // stops there rather than going on to ls-files/merge-base for nothing.
      { match: "git diff --name-only --diff-filter=U", result: {} },
    ]);
    const result = cascadeMain(seams, "/repo");
    expect(result.conflicted).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.conflicts).toEqual([]);
    expect(seams.calls.length).toBe(3); // fetch, merge, the unmerged-path scan -- never reaches push
  });

  it("uses --no-edit merge, never rebase, and takes a custom trunk", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin develop", result: {} },
      { match: "git merge --no-edit origin/develop", result: {} },
      { match: "git push", result: {} },
    ]);
    expect(cascadeMain(seams, "/repo", "develop").pushed).toBe(true);
  });

  it("reports a fetch failure as an error, never as a conflict", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: { code: 1, stderr: "network down" } },
    ]);
    const result = cascadeMain(seams, "/repo");
    expect(result.error).toMatch(/network down/);
    expect(result.conflicted).toBe(false);
    expect(result.conflicts).toEqual([]);
  });

  it("reports a push failure distinctly from a merge conflict", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: {} },
      { match: "git push", result: { code: 1, stderr: "rejected" } },
    ]);
    const result = cascadeMain(seams, "/repo");
    expect(result.conflicted).toBe(false);
    expect(result.error).toMatch(/rejected/);
  });

  describe("--no-push", () => {
    it("stops after a clean merge without ever calling push, and says so in the log", () => {
      const seams = new ScriptedSeams([
        { match: "git fetch origin main", result: {} },
        { match: "git merge --no-edit origin/main", result: {} },
      ]);
      const result = cascadeMain(seams, "/repo", "main", { noPush: true });
      expect(result).toMatchObject({ conflicted: false, pushed: false, noPush: true, error: null, conflicts: [] });
      expect(result.log).toContain("not pushed (--no-push)");
      expect(seams.calls.length).toBe(2); // fetch, merge -- push is never scripted, so a call would throw
    });

    it("still reports a conflict (never pushes either way) and still gathers conflicts[]", () => {
      const seams = new ScriptedSeams([
        { match: "git fetch origin main", result: {} },
        { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
        { match: "git diff --name-only --diff-filter=U", result: { stdout: "src/a.ts\n" } },
        { match: "git ls-files -u", result: { stdout: "100644 aaa 2\tsrc/a.ts\n100644 bbb 3\tsrc/a.ts\n" } },
        { match: "git merge-base HEAD origin/main", result: { stdout: "base123\n" } },
        { match: "git log --format=%H base123..HEAD -- src/a.ts", result: {} },
        { match: "git log --format=%H base123..origin/main -- src/a.ts", result: {} },
      ]);
      const result = cascadeMain(seams, "/repo", "main", { noPush: true });
      expect(result.noPush).toBe(true);
      expect(result.pushed).toBe(false);
      expect(result.conflicted).toBe(true);
      expect(result.conflicts).toEqual([{ path: "src/a.ts", kind: "add-add", ours: [], theirs: [] }]);
    });
  });

  describe("conflicts[]", () => {
    it("lists each unmerged path with its kind and each side's commits since the merge base", () => {
      const seams = new ScriptedSeams([
        { match: "git fetch origin main", result: {} },
        { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
        { match: "git diff --name-only --diff-filter=U", result: { stdout: "src/a.ts\nsrc/b.ts\n" } },
        {
          match: "git ls-files -u",
          result: {
            stdout: [
              "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tsrc/a.ts",
              "100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\tsrc/a.ts",
              "100644 cccccccccccccccccccccccccccccccccccccccc 3\tsrc/a.ts",
              "100644 dddddddddddddddddddddddddddddddddddddddd 2\tsrc/b.ts",
              "100644 eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee 3\tsrc/b.ts",
            ].join("\n"),
          },
        },
        { match: "git merge-base HEAD origin/main", result: { stdout: "base123\n" } },
        { match: "git log --format=%H base123..HEAD -- src/a.ts", result: { stdout: "ours1\nours2\n" } },
        { match: "git log --format=%H base123..origin/main -- src/a.ts", result: { stdout: "theirs1\n" } },
        { match: "git log --format=%H base123..HEAD -- src/b.ts", result: { stdout: "oursB\n" } },
        { match: "git log --format=%H base123..origin/main -- src/b.ts", result: { stdout: "theirsB\n" } },
      ]);
      const result = cascadeMain(seams, "/repo");
      expect(result.conflicts).toEqual([
        { path: "src/a.ts", kind: "both-modified", ours: ["ours1", "ours2"], theirs: ["theirs1"] },
        { path: "src/b.ts", kind: "add-add", ours: ["oursB"], theirs: ["theirsB"] },
      ]);
    });

    it("names modify-delete when we kept the path and the trunk deleted it, and delete-modify the other way round", () => {
      const seams = new ScriptedSeams([
        { match: "git fetch origin main", result: {} },
        { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
        { match: "git diff --name-only --diff-filter=U", result: { stdout: "kept-by-us.ts\nkept-by-them.ts\n" } },
        {
          match: "git ls-files -u",
          result: {
            stdout: [
              "100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa 1\tkept-by-us.ts",
              "100644 bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb 2\tkept-by-us.ts",
              "100644 cccccccccccccccccccccccccccccccccccccccc 1\tkept-by-them.ts",
              "100644 dddddddddddddddddddddddddddddddddddddddd 3\tkept-by-them.ts",
            ].join("\n"),
          },
        },
        { match: "git merge-base HEAD origin/main", result: { stdout: "base123\n" } },
        { match: "git log --format=%H base123..HEAD -- kept-by-us.ts", result: {} },
        { match: "git log --format=%H base123..origin/main -- kept-by-us.ts", result: {} },
        { match: "git log --format=%H base123..HEAD -- kept-by-them.ts", result: {} },
        { match: "git log --format=%H base123..origin/main -- kept-by-them.ts", result: {} },
      ]);
      const result = cascadeMain(seams, "/repo");
      expect(result.conflicts.map((conflict): string => conflict.kind)).toEqual(["modify-delete", "delete-modify"]);
    });

    it("still names the path and kind when the merge base cannot be resolved, blaming no commit on either side", () => {
      const seams = new ScriptedSeams([
        { match: "git fetch origin main", result: {} },
        { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
        { match: "git diff --name-only --diff-filter=U", result: { stdout: "shallow.ts\n" } },
        { match: "git ls-files -u", result: { stdout: "100644 aaa 2\tshallow.ts\n100644 bbb 3\tshallow.ts\n" } },
        { match: "git merge-base HEAD origin/main", result: { code: 1, stderr: "fatal: no merge base" } },
      ]);
      const result = cascadeMain(seams, "/repo");
      expect(result.conflicts).toEqual([{ path: "shallow.ts", kind: "add-add", ours: [], theirs: [] }]);
    });

    it("takes the custom trunk into the merge-base and per-side log calls, not a hard-coded 'main'", () => {
      const seams = new ScriptedSeams([
        { match: "git fetch origin develop", result: {} },
        { match: "git merge --no-edit origin/develop", result: { code: 1, stderr: "CONFLICT" } },
        { match: "git diff --name-only --diff-filter=U", result: { stdout: "src/a.ts\n" } },
        { match: "git ls-files -u", result: { stdout: "100644 aaa 2\tsrc/a.ts\n100644 bbb 3\tsrc/a.ts\n" } },
        { match: "git merge-base HEAD origin/develop", result: { stdout: "base456\n" } },
        { match: "git log --format=%H base456..HEAD -- src/a.ts", result: { stdout: "ours1\n" } },
        { match: "git log --format=%H base456..origin/develop -- src/a.ts", result: { stdout: "theirs1\n" } },
      ]);
      const result = cascadeMain(seams, "/repo", "develop");
      expect(result.conflicts).toEqual([{ path: "src/a.ts", kind: "add-add", ours: ["ours1"], theirs: ["theirs1"] }]);
    });
  });
});
