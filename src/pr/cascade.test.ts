import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { cascadeMain } from "./cascade.js";

describe("cascadeMain -- merge, never rebase, and never resolve a conflict itself", () => {
  it("fetches, merges cleanly, and pushes", () => {
    const runner = new ScriptedRunner([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: {} },
      { match: "git push", result: {} },
    ]);
    const result = cascadeMain(runner, "/repo");
    expect(result).toMatchObject({ conflicted: false, pushed: true, error: null });
  });

  it("reports a conflict without pushing or aborting the merge", () => {
    const runner = new ScriptedRunner([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: { code: 1, stderr: "CONFLICT" } },
    ]);
    const result = cascadeMain(runner, "/repo");
    expect(result.conflicted).toBe(true);
    expect(result.pushed).toBe(false);
    expect(runner.calls.length).toBe(2); // never reaches push
  });

  it("uses --no-edit merge, never rebase, and takes a custom trunk", () => {
    const runner = new ScriptedRunner([
      { match: "git fetch origin develop", result: {} },
      { match: "git merge --no-edit origin/develop", result: {} },
      { match: "git push", result: {} },
    ]);
    expect(cascadeMain(runner, "/repo", "develop").pushed).toBe(true);
  });

  it("reports a fetch failure as an error, never as a conflict", () => {
    const runner = new ScriptedRunner([
      { match: "git fetch origin main", result: { code: 1, stderr: "network down" } },
    ]);
    const result = cascadeMain(runner, "/repo");
    expect(result.error).toMatch(/network down/);
    expect(result.conflicted).toBe(false);
  });

  it("reports a push failure distinctly from a merge conflict", () => {
    const runner = new ScriptedRunner([
      { match: "git fetch origin main", result: {} },
      { match: "git merge --no-edit origin/main", result: {} },
      { match: "git push", result: { code: 1, stderr: "rejected" } },
    ]);
    const result = cascadeMain(runner, "/repo");
    expect(result.conflicted).toBe(false);
    expect(result.error).toMatch(/rejected/);
  });
});
