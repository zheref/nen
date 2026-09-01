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
    expect(result).toMatchObject({ conflicted: false, pushed: true, error: null });
  });

  it("reports a conflict without pushing or aborting the merge", () => {
    const seams = new ScriptedSeams([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
    ]);
    const result = cascadeMain(seams, "/repo");
    expect(result.conflicted).toBe(true);
    expect(result.pushed).toBe(false);
    expect(seams.calls.length).toBe(2); // never reaches push
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
});
