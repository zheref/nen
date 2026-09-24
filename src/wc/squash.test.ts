import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import { BASE_LIST_CAP, performSquash, planSquash, SquashStateError } from "./squash.js";

const CLEAN = { match: "git status --porcelain=v1 -uall", result: { stdout: "" } };
const ANCESTOR_OK = { match: "git merge-base --is-ancestor main HEAD", result: { code: 0 } };
const MERGE_BASE = { match: "git merge-base main HEAD", result: { stdout: "base0000\n" } };
const NO_UPSTREAM = { match: "git rev-parse --abbrev-ref @{upstream}", result: { code: 1, stderr: "fatal: no upstream configured" } };
const BASE = { name: "main", source: "--base" };
/** Neither origin/main nor main resolves: the base check is NOT performed. */
const NO_ORIGIN_BASE = { match: "git rev-parse --verify --quiet refs/remotes/origin/main^{commit}", result: { code: 1 } };
const NO_LOCAL_BASE = { match: "git rev-parse --verify --quiet refs/heads/main^{commit}", result: { code: 1 } };

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
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toMatch(/dirty/);
    expect(plan.reason).toContain("a.ts");
    expect(plan.reason).toContain("b.ts");
  });

  it("never calls merge-base at all when the tree is dirty", () => {
    const seams = new ScriptedSeams([{ match: "git status --porcelain=v1 -uall", result: { stdout: " M a.ts\n" } }]);
    planSquash(seams, "/repo", "main", BASE);
    expect(seams.calls.some((call): boolean => call.args.includes("merge-base"))).toBe(false);
  });

  it("refuses --onto when it is not an ancestor of HEAD, quoting what merge-base found", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      { match: "git merge-base --is-ancestor main HEAD", result: { code: 1 } },
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
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
    expect((): unknown => planSquash(seams, "/repo", "main", BASE)).toThrow(SquashStateError);
  });

  it("throws when the merge-base itself cannot be resolved", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      { match: "git merge-base main HEAD", result: { code: 1, stderr: "fatal: not a valid object name" } },
    ]);
    expect((): unknown => planSquash(seams, "/repo", "main", BASE)).toThrow(SquashStateError);
  });

  it("answers nothing-to-squash (a SUCCESS, not a refusal) with zero commits ahead", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: "" } },
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
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
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("nothing-to-squash");
    if (plan.kind !== "nothing-to-squash") return;
    expect(plan.folded).toEqual([{ sha: "sha1", subject: "only commit" }]);
    expect(seams.calls.some((call): boolean => call.args.includes("upstream"))).toBe(false);
  });

  it("answers ready with two or more commits, oldest first, when there is no upstream configured", () => {
    const seams = new ScriptedSeams([CLEAN, MERGE_BASE, ANCESTOR_OK, twoCommits(), NO_UPSTREAM, NO_ORIGIN_BASE, NO_LOCAL_BASE]);
    const plan = planSquash(seams, "/repo", "main", BASE);
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
    const plan = planSquash(seams, "/repo", "main", BASE);
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
      NO_ORIGIN_BASE,
      NO_LOCAL_BASE,
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
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
      NO_ORIGIN_BASE,
      NO_LOCAL_BASE,
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.upstream).toBe("origin/work");
    expect(plan.baseRefs).toEqual([]);
  });

  // ── the base guard (zheref/nen#251) ─────────────────────────────────────
  const ORIGIN_BASE = { match: "git rev-parse --verify --quiet refs/remotes/origin/main^{commit}", result: { stdout: "originsha\n" } };
  const LOCAL_BASE = { match: "git rev-parse --verify --quiet refs/heads/main^{commit}", result: { stdout: "localsha\n" } };

  it("refuses when a folded commit is already on origin/<base>, naming it and the ref it is on", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      NO_UPSTREAM,
      ORIGIN_BASE,
      // origin/main holds sha1: only sha2 is this branch's own.
      { match: "git rev-list HEAD --not base0000 originsha", result: { stdout: "sha2\n" } },
      LOCAL_BASE,
      { match: "git rev-list HEAD --not base0000 localsha", result: { stdout: "sha2\n" } },
    ]);
    const plan = planSquash(seams, "/repo", "main", { name: "main", source: "nen/workflow.json's branch.base" });
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toContain("sha1 ('first commit', on origin/main)");
    expect(plan.reason).not.toContain("sha2 (");
    expect(plan.reason).toContain("the base 'main' (nen/workflow.json's branch.base; checked against origin/main, main) already holds 1 of the 2 commit(s)");
    expect(plan.reason).toMatch(/flatten the merge's ancestry/);
  });

  it("refuses when only the LOCAL <base> holds a folded commit -- a merge of an unpushed trunk", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      NO_UPSTREAM,
      NO_ORIGIN_BASE,
      LOCAL_BASE,
      { match: "git rev-list HEAD --not base0000 localsha", result: { stdout: "sha1\n" } },
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toContain("sha2 ('second commit', on main)");
    expect(plan.reason).toContain("checked against main)");
  });

  it("answers ready and names the refs it checked when none of the folded commits is on the base", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      NO_UPSTREAM,
      ORIGIN_BASE,
      { match: "git rev-list HEAD --not base0000 originsha", result: { stdout: "sha2\nsha1\n" } },
      LOCAL_BASE,
      { match: "git rev-list HEAD --not base0000 localsha", result: { stdout: "sha2\nsha1\n" } },
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("ready");
    if (plan.kind !== "ready") return;
    expect(plan.baseRefs).toEqual(["origin/main", "main"]);
  });

  it("keeps the upstream refusal's precedence: a published commit is refused before the base is even read", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      { match: "git rev-parse --abbrev-ref @{upstream}", result: { stdout: "origin/work\n" } },
      { match: "git fetch origin work", result: { code: 0 } },
      { match: "git merge-base --is-ancestor sha1 origin/work", result: { code: 0 } },
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toMatch(/already published/);
    expect(seams.calls.some((call): boolean => call.args.includes("--verify"))).toBe(false);
  });

  it("throws (never 'no base') when resolving a base ref fails outright", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      NO_UPSTREAM,
      { match: "git rev-parse --verify --quiet refs/remotes/origin/main^{commit}", result: { code: 128, stderr: "fatal: not a git repository" } },
    ]);
    expect((): unknown => planSquash(seams, "/repo", "main", BASE)).toThrow(SquashStateError);
  });

  it(`lists at most ${BASE_LIST_CAP} base commits by name, oldest first, and counts the rest`, () => {
    const total = BASE_LIST_CAP + 2;
    // git log prints newest first; c0 is the oldest.
    const log = Array.from({ length: total }, (_, index): string => `c${total - 1 - index}\tbase commit ${total - 1 - index}`).join("\n");
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      { match: "git log base0000..HEAD --format=%H%x09%s", result: { stdout: `${log}\n` } },
      NO_UPSTREAM,
      ORIGIN_BASE,
      // origin/main holds every one of them.
      { match: "git rev-list HEAD --not base0000 originsha", result: { stdout: "" } },
      NO_LOCAL_BASE,
    ]);
    const plan = planSquash(seams, "/repo", "main", BASE);
    expect(plan.kind).toBe("refused");
    if (plan.kind !== "refused") return;
    expect(plan.reason).toContain(`already holds ${total} of the ${total} commit(s)`);
    expect(plan.reason).toContain("c0 ('base commit 0', on origin/main)");
    expect(plan.reason).toContain(`c${BASE_LIST_CAP - 1} ('base commit ${BASE_LIST_CAP - 1}', on origin/main)`);
    expect(plan.reason).not.toContain(`c${BASE_LIST_CAP} (`);
    expect(plan.reason).toContain("; and 2 more.");
  });

  it("throws when the base's rev-list cannot run", () => {
    const seams = new ScriptedSeams([
      CLEAN,
      MERGE_BASE,
      ANCESTOR_OK,
      twoCommits(),
      NO_UPSTREAM,
      ORIGIN_BASE,
      { match: "git rev-list HEAD --not base0000 originsha", result: { code: 128, stderr: "fatal: bad object" } },
    ]);
    expect((): unknown => planSquash(seams, "/repo", "main", BASE)).toThrow(SquashStateError);
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
    expect((): unknown => planSquash(seams, "/repo", "main", BASE)).toThrow(SquashStateError);
  });

  it("throws when the working copy's status cannot be read", () => {
    const seams = new ScriptedSeams([{ match: "git status --porcelain=v1 -uall", result: { code: 1, stderr: "fatal: not a git repository" } }]);
    expect((): unknown => planSquash(seams, "/repo", "main", BASE)).toThrow(SquashStateError);
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
