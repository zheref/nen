import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { classifyWorkingCopy, readWorkingCopyState, WcStateError, type WcState } from "./classify.js";

function state(overrides: Partial<WcState> = {}): WcState {
  return {
    branch: "main",
    detachedAt: null,
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
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M src/a.ts\n?? src/new.ts\n" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "2\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "second commit\nfirst commit\n" } },
    ]);
    const result = readWorkingCopyState(seams, "/repo", "main");
    expect(result.branch).toBe("feature/x");
    expect(result.isTrunk).toBe(false);
    expect(result.dirty).toBe(true);
    expect(result.uncommittedPaths).toEqual(["src/a.ts", "src/new.ts"]);
    expect(result.aheadOfBase).toBe(2);
    // oldest first -- the ORDER a reader would want to see a same-effort story in.
    expect(result.existingCommitSubjects).toEqual(["first commit", "second commit"]);
  });

  it("skips the ahead-of-base calls entirely when standing on the trunk", () => {
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
    ]);
    const result = readWorkingCopyState(seams, "/repo", "main");
    expect(result.isTrunk).toBe(true);
    expect(result.aheadOfBase).toBe(0);
    expect(seams.calls.length).toBe(2);
  });

  // Review finding: a failed git command used to be silently read as empty
  // output, which then defaulted to a confident (and wrong) reading -- an
  // invalid --base made 'rev-list' fail, but `Number("") === 0` turned that
  // into a clean `aheadOfBase: 0`, and a failed 'git status' turned into zero
  // uncommitted paths (a DIRTY tree reported as clean). Every one of these must
  // throw rather than manufacture a zero. A DETACHED HEAD is not one of them
  // any more (zheref/nen#163): it is a fact about the checkout, asked a second
  // question and answered, not a reading nen had to guess at.
  it("classifies a DETACHED HEAD with branch: null and the short sha, rather than refusing", () => {
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
      { match: "git rev-parse --short HEAD", result: { stdout: "1a2b3c4\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M src/a.ts\n" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "1\n" } },
      { match: "git log main..HEAD --format=%s", result: { stdout: "a commit\n" } },
    ]);
    const result = readWorkingCopyState(seams, "/repo", "main");
    expect(result.branch).toBeNull();
    expect(result.detachedAt).toBe("1a2b3c4");
    // Standing on no branch means standing on no TRUNK, whatever --base says.
    expect(result.isTrunk).toBe(false);
    expect(result.dirty).toBe(true);
    expect(classifyWorkingCopy(result).case).toBe("on-branch-dirty");
    expect(classifyWorkingCopy(result).evidence.join(" ")).toContain("on a detached HEAD at 1a2b3c4");
  });

  it("a detached HEAD is never must-move, even when --base would name the commit it sits on", () => {
    const detached = state({ branch: null, detachedAt: "1a2b3c4", isTrunk: false, dirty: true, uncommittedPaths: ["a.ts"] });
    expect(classifyWorkingCopy(detached).case).toBe("on-branch-dirty");
  });

  it("still refuses when HEAD names no branch AND resolves to no commit", () => {
    // The other case the old refusal was folding in: a repository with no
    // commits yet. There is no working copy state to classify there.
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref" } },
      { match: "git rev-parse --short HEAD", result: { code: 128, stderr: "fatal: ambiguous argument 'HEAD'" } },
    ]);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(WcStateError);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(/resolves to no commit/);
  });

  it("throws when 'git status' fails, rather than reporting a possibly-dirty tree as clean", () => {
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { code: 1, stderr: "fatal: not a git repository" } },
    ]);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(WcStateError);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(/status/);
  });

  it("throws when 'git rev-list --count' fails (e.g. an invalid --base), rather than reporting 0 commits ahead", () => {
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count bogus-base..HEAD", result: { code: 128, stderr: "fatal: bad revision 'bogus-base..HEAD'" } },
    ]);
    expect(() => readWorkingCopyState(seams, "/repo", "bogus-base")).toThrow(WcStateError);
    expect(() => readWorkingCopyState(seams, "/repo", "bogus-base")).toThrow(/ahead of base/);
  });

  it("throws when 'git rev-list --count' prints something non-numeric, rather than guessing", () => {
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "not-a-number\n" } },
    ]);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(WcStateError);
  });

  it("throws when 'git log' fails after a successful rev-list, rather than reporting no existing commits", () => {
    const seams = new ScriptedSeams([
      { match: "git symbolic-ref --short HEAD", result: { stdout: "feature/x\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: "" } },
      { match: "git rev-list --count main..HEAD", result: { stdout: "2\n" } },
      { match: "git log main..HEAD --format=%s", result: { code: 1, stderr: "fatal: bad object" } },
    ]);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(WcStateError);
    expect(() => readWorkingCopyState(seams, "/repo", "main")).toThrow(/commit subjects/);
  });
});
