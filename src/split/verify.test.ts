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

  it("passes trivially for an empty original and no branches", () => {
    expect(verifySplit("", []).ok).toBe(true);
  });

  it("counts files in original and across branches", () => {
    const original = [fileDiff("a.ts", [HUNK_A1]), fileDiff("b.ts", [HUNK_B1])].join("\n");
    const result = verifySplit(original, [fileDiff("a.ts", [HUNK_A1]), fileDiff("b.ts", [HUNK_B1])]);
    expect(result.filesInOriginal).toBe(2);
    expect(result.filesInBranches).toBe(2);
  });
});
