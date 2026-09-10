import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { performSquash, planSquash, SquashStateError } from "./squash.js";

const CLEAN = { match: "git status --porcelain=v1 -uall", result: { stdout: "" } };
const ANCESTOR_OK = { match: "git merge-base --is-ancestor main HEAD", result: { code: 0 } };
const MERGE_BASE = { match: "git merge-base main HEAD", result: { stdout: "base0000\n" } };
const NO_UPSTREAM = { match: "git rev-parse --abbrev-ref @{upstream}", result: { code: 1, stderr: "fatal: no upstream configured" } };

function twoCommits(): { match: string; result: { stdout: string } } {
  return {
    match: "git log base0000..HEAD --format=%H%x09%s",
    result: { stdout: "sha2\tsecond commit\nsha1\tfirst commit\n" },
  };
}

describe("planSquash -- refuses before anything moves", () => {
  it("refuses a dirty working tree, naming every path", () => {
    const seams = new ScriptedSeams([
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M a.ts\n?? b.ts\n" } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toMatch(/dirty/);
    expect(plan.reason).toContain("a.ts");
    expect(plan.reason).toContain("b.ts");
  });

  it("never calls merge-base at all when the tree is dirty", () => {
    const seams = new ScriptedSeams([{ match: "git status --porcelain=v1 -uall", result: { stdout: " M a.ts\n" } }]);
    planSquash(seams, "/repo", "main");
    expect(seams.calls.some((call): boolean => call.args.includes("merge-base"))).toBe(false);
  });

  it("refuses --onto when it is not an ancestor of HEAD, quoting what merge-base found", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      { match: "git merge-base --is-ancestor main HEAD", result: { code: 1 } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toMatch(/not an ancestor/);
    expect(plan.reason).toContain("base0000");
  });

  it("throws (never a refusal) when the ancestor check itself cannot run", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      { match: "git merge-base --is-ancestor main HEAD", result: { code: 129, stderr: "fatal: bad object" } },
    ]);
    expect((): unknown => planSquash(seams, "/repo", "main")).toThrow(SquashStateError);
  });

  it("throws when the merge-base itself cannot be resolved", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      { match: "git merge-base main HEAD", result: { code: 1, stderr: "fatal: not a valid object name" } },
    ]);
    expect((): unknown => planSquash(seams, "/repo", "main")).toThrow(SquashStateError);
  });

  it("answers nothing-to-squash (a SUCCESS, not a refusal) with zero commits ahead", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: "" } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("nothing-to-squash");
    if (plan.kind !== "nothing-to-squash") return;
    expect(plan.folded).toEqual([]);
  });

  it("answers nothing-to-squash with exactly one commit ahead, and never checks the upstream", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: "sha1\tonly commit\n" } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("nothing-to-squash");
    if (plan.kind !== "nothing-to-squash") return;
    expect(plan.folded).toEqual([{ sha: "sha1", subject: "only commit" }]);
    expect(seams.calls.some((call): boolean => call.args.includes("upstream"))).toBe(false);
  });

  it("answers ready with two or more commits, oldest first, when there is no upstream configured", () => {
    const seams = new ScriptedSeams([CLEAN, MERGE_BASE, ANCESTOR_OK, twoCommits(), NO_UPSTREAM]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.folded).toEqual([
      { sha: "sha1", subject: "first commit" },
      { sha: "sha2", subject: "second commit" },
    ]);
    expect(plan.upstream).toBeNull();
    expect(plan.mergeBase).toBe("base0000");
  });

  it("fetches the upstream and refuses when a folded commit is already reachable from it", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toContain("sha1");
    expect(plan.reason).toContain("origin/work");
    expect(plan.reason).toMatch(/already published; squashing would rewrite pushed history/);
  });

  it("fetches the upstream BEFORE checking reachability -- a stale ref must never hide a published commit", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 1 } },
      { match: "git merge-base --is-ancestor sha2 origin/work", result: { code: 1 } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("ready");
    const fetchIndex = seams.calls.findIndex((call): boolean => call.args[0] === "fetch");
    const checkIndex = seams.calls.findIndex(
      (call): boolean => call.args.join(" ") === "merge-base --is-ancestor sha1 origin/work",
    );
    expect(fetchIndex).toBeGreaterThanOrEqual(0);
    expect(fetchIndex).toBeLessThan(checkIndex);
  });

  it("answers ready and carries the upstream name when none of the folded commits are on it", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 1 } },
      { match: "git merge-base --is-ancestor sha2 origin/work", result: { code: 1 } },
    ]);
    const plan = planSquash(seams, "/repo", "main");
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.upstream).toBe("origin/work");
  });

  it("throws when the fetch of the upstream fails", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 1, stderr: "fatal: unable to access" } },
    ]);
    expect((): unknown => planSquash(seams, "/repo", "main")).toThrow(SquashStateError);
  });

  it("throws when the working copy's status cannot be read", () => {
    const seams = new ScriptedSeams([{ match: "git status --porcelain=v1 -uall", result: { code: 1, stderr: "fatal: not a git repository" } }]);
    expect((): unknown => planSquash(seams, "/repo", "main")).toThrow(SquashStateError);
  });
});

describe("performSquash -- the mechanism, and only the mechanism", () => {
  it("resets soft then commits with -F, and reads the new sha", () => {
    const seams = new ScriptedSeams([
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: "git commit -F msg.txt", result: { code: 0 } },
      { match: "git rev-parse HEAD", result: { stdout: "newsha00\n" } },
    ]);
    const sha = performSquash(seams, "/repo", "base0000", "msg.txt");
    expect(sha).toBe("newsha00");
    expect(seams.calls.map((call): string => call.args.join(" "))).toEqual([
      "reset --soft base0000",
      "commit -F msg.txt",
      "rev-parse HEAD",
    ]);
  });

  it("throws and never calls commit when the reset fails", () => {
    const seams = new ScriptedSeams([{ match: "git reset --soft base0000", result: { code: 1, stderr: "fatal: x" } }]);
    expect((): unknown => performSquash(seams, "/repo", "base0000", "msg.txt")).toThrow(SquashStateError);
    expect(seams.calls).toHaveLength(1);
  });

  it("names ORIG_HEAD recovery when the commit step fails after a successful reset", () => {
    const seams = new ScriptedSeams([
      { match: "git reset --soft base0000", result: { code: 0 } },
      { match: "git commit -F msg.txt", result: { code: 1, stderr: "fatal: nothing to commit" } },
    ]);
    expect((): unknown => performSquash(seams, "/repo", "base0000", "msg.txt")).toThrow(/ORIG_HEAD/);
  });
});
