import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import { classifyWorkingCopy, readWorkingCopyState, type WcState } from "./classify.js";

function state(overrides: Partial<WcState> = {}): WcState {
  return {
    branch: "main",
    isTrunk: true,
    dirty: false,
    aheadOfBase: 0,
    existingCommitSubjects: [],
    uncommittedPaths: [],
    ...overrides,
  };
}

describe("classifyWorkingCopy -- tensho §2's four cases, git-state-decidable ones only", () => {
  it("on the trunk, dirty -> must-move", () => {
    const result = classifyWorkingCopy(state({ dirty: true, uncommittedPaths: ["a.ts"] }));
    expect(result.case).toBe("must-move");
  });

  it("on the trunk, clean -> on-branch-clean, nothing to move", () => {
    expect(classifyWorkingCopy(state()).case).toBe("on-branch-clean");
  });

  it("on a branch, dirty -> on-branch-dirty, and never claims same-effort", () => {
    const result = classifyWorkingCopy(
      state({ branch: "feature/x", isTrunk: false, dirty: true, aheadOfBase: 2, existingCommitSubjects: ["a", "b"], uncommittedPaths: ["c.ts"] }),
    );
    expect(result.case).toBe("on-branch-dirty");
    expect(result.evidence.join(" ")).toMatch(/judgement this module does not make/);
    expect(result.evidence.join(" ")).toMatch(/"a", "b"/);
  });

  it("on a branch, clean -> on-branch-clean", () => {
    const result = classifyWorkingCopy(state({ branch: "feature/x", isTrunk: false, dirty: false }));
    expect(result.case).toBe("on-branch-clean");
  });
});

describe("readWorkingCopyState -- gathers the evidence via git", () => {
  it("reads branch, dirty paths and ahead-of-base commits", () => {
    const runner = new ScriptedRunner([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M src/a.ts\n?? src/new.ts\n" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "2\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "second commit\nfirst commit\n" } },
    ]);
    const result = readWorkingCopyState(runner, "/repo", "main");
    expect(result.branch).toBe("feature/x");
    expect(result.isTrunk).toBe(false);
    expect(result.dirty).toBe(true);
    expect(result.uncommittedPaths).toEqual(["src/a.ts", "src/new.ts"]);
    expect(result.aheadOfBase).toBe(2);
    // oldest first -- the ORDER a reader would want to see a same-effort story in.
    expect(result.existingCommitSubjects).toEqual(["first commit", "second commit"]);
  });

  it("skips the ahead-of-base calls entirely when standing on the trunk", () => {
    const runner = new ScriptedRunner([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
    ]);
    const result = readWorkingCopyState(runner, "/repo", "main");
    expect(result.isTrunk).toBe(true);
    expect(result.aheadOfBase).toBe(0);
    expect(runner.calls.length).toBe(2);
  });
});
