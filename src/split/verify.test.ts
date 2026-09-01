import { describe, expect, it } from "vitest";
import { verifySplit } from "./verify.js";

function fileDiff(path: string, hunks: readonly string[]): string {
  const lines = [`diff --git a/${path} b/${path}`, `index 1..2 100644`, `--- a/${path}`, `+++ b/${path}`];
  for (const hunk of hunks) lines.push(hunk);
  return lines.join("\n");
}

const HUNK_A1 = "@@ -1,1 +1,1 @@\n-old1\n+new1";
const HUNK_A2 = "@@ -10,1 +10,1 @@\n-old2\n+new2";
const HUNK_B1 = "@@ -1,1 +1,1 @@\n-oldB\n+newB";

describe("verifySplit -- union of branches equals the original, hunk for hunk", () => {
  it("passes when every original hunk lands in exactly one branch", () => {
    const original = [fileDiff("a.ts", [HUNK_A1, HUNK_A2]), fileDiff("b.ts", [HUNK_B1])].join("\n");
    const branchA = fileDiff("a.ts", [HUNK_A1, HUNK_A2]);
    const branchB = fileDiff("b.ts", [HUNK_B1]);
    const result = verifySplit(original, [branchA, branchB]);
    expect(result.ok).toBe(true);
    expect(result.missing).toEqual([]);
    expect(result.duplicated).toEqual([]);
    expect(result.extra).toEqual([]);
  });

  it("splits one file's hunks across two branches cleanly", () => {
    const original = fileDiff("a.ts", [HUNK_A1, HUNK_A2]);
    const branchA = fileDiff("a.ts", [HUNK_A1]);
    const branchB = fileDiff("a.ts", [HUNK_A2]);
    expect(verifySplit(original, [branchA, branchB]).ok).toBe(true);
  });

  it("reports a hunk missing from every branch -- the skill's 'leftover hunk'", () => {
    const original = fileDiff("a.ts", [HUNK_A1, HUNK_A2]);
    const branchA = fileDiff("a.ts", [HUNK_A1]);
    const result = verifySplit(original, [branchA]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ path: "a.ts", header: "@@ -10,1 +10,1 @@" }]);
  });

  it("reports a hunk duplicated across two branches, naming both", () => {
    const original = fileDiff("a.ts", [HUNK_A1]);
    const branchA = fileDiff("a.ts", [HUNK_A1]);
    const branchB = fileDiff("a.ts", [HUNK_A1]);
    const result = verifySplit(original, [branchA, branchB]);
    expect(result.ok).toBe(false);
    expect(result.duplicated).toEqual([{ path: "a.ts", header: "@@ -1,1 +1,1 @@", branches: [0, 1] }]);
  });

  it("reports a hunk present in a branch but absent from the original as extra", () => {
    const original = fileDiff("a.ts", [HUNK_A1]);
    const branchA = fileDiff("a.ts", [HUNK_A1, HUNK_A2]);
    const result = verifySplit(original, [branchA]);
    expect(result.ok).toBe(false);
    expect(result.extra).toEqual([{ path: "a.ts", header: "@@ -10,1 +10,1 @@" }]);
  });

  it("reports a whole file missing from every branch as every one of its hunks", () => {
    const original = [fileDiff("a.ts", [HUNK_A1]), fileDiff("b.ts", [HUNK_B1])].join("\n");
    const branchA = fileDiff("a.ts", [HUNK_A1]);
    const result = verifySplit(original, [branchA]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([{ path: "b.ts", header: "@@ -1,1 +1,1 @@" }]);
  });

  // Review finding #6 (part 2): an empty original diff must never read as a
  // passed completeness proof -- it is indistinguishable from "wrong base"
  // or "nothing staged".
  it("refuses an empty original diff instead of passing it trivially", () => {
    const result = verifySplit("", []);
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/names no hunks/);
  });

  it("refuses an empty original diff even when branch diffs are also empty", () => {
    const result = verifySplit("", ["", ""]);
    expect(result.ok).toBe(false);
    expect(result.error).not.toBeNull();
  });

  // Review finding #6 (part 1): diff.ts's own header states identity is the
  // hunk's EXACT TEXT, not just its header -- verify.ts compared headers
  // only, so a hunk altered in transit reported as landed.
  it("reports a hunk ALTERED, not landed, when the header matches but the body was changed in transit", () => {
    const original = fileDiff("secret.ts", ["@@ -1,3 +1,4 @@\n+const SECRET = readEnv();"]);
    const branchA = fileDiff("secret.ts", ["@@ -1,3 +1,4 @@\n+const SECRET = 'hunter2';"]);
    const result = verifySplit(original, [branchA]);
    expect(result.ok).toBe(false);
    expect(result.missing).toEqual([]);
    expect(result.extra).toEqual([]);
    expect(result.altered).toHaveLength(1);
    expect(result.altered[0]).toMatchObject({ path: "secret.ts", header: "@@ -1,3 +1,4 @@", branch: 0 });
    expect(result.altered[0]?.diff).toContain("hunter2");
  });

  it("does NOT report altered for a hunk whose header and body both match exactly", () => {
    const original = fileDiff("a.ts", [HUNK_A1]);
    const branchA = fileDiff("a.ts", [HUNK_A1]);
    const result = verifySplit(original, [branchA]);
    expect(result.ok).toBe(true);
    expect(result.altered).toEqual([]);
  });

  it("counts files in original and across branches", () => {
    const original = [fileDiff("a.ts", [HUNK_A1]), fileDiff("b.ts", [HUNK_B1])].join("\n");
    const result = verifySplit(original, [fileDiff("a.ts", [HUNK_A1]), fileDiff("b.ts", [HUNK_B1])]);
    expect(result.filesInOriginal).toBe(2);
    expect(result.filesInBranches).toBe(2);
  });
});
