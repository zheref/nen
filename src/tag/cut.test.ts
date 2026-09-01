import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { cutTag } from "./cut.js";

function baseScript(overrides: { ancestorCode?: number } = {}): readonly ScriptedCall[] {
  return [
    { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
    { match: "git tag -l v1.0.0", result: { stdout: "" } },
    { match: "git merge-base --is-ancestor abc123 origin/main", result: { code: overrides.ancestorCode ?? 0 } },
  ];
}

describe("cutTag -- the commit is ALWAYS the caller's, never HEAD", () => {
  it("creates a local tag and does NOT push without --push", () => {
    const seams = new ScriptedSeams([
      ...baseScript(),
      { match: "git tag -a -m v1.0.0 v1.0.0 abc123", result: {} },
    ]);
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.log.some((l): boolean => l.includes("NOT pushed"))).toBe(true);
    expect(seams.calls.some((c): boolean => c.args.includes("push"))).toBe(false);
  });

  it("pushes only when --push (push:true) is given", () => {
    const seams = new ScriptedSeams([
      ...baseScript(),
      { match: "git tag -a -m v1.0.0 v1.0.0 abc123", result: {} },
      { match: "git push origin v1.0.0", result: {} },
    ]);
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123", push: true });
    expect(result.pushed).toBe(true);
  });

  it("carries a --message through to git tag -a -m", () => {
    const seams = new ScriptedSeams([
      ...baseScript(),
      { match: "git tag -a -m a release v1.0.0 abc123", result: {} },
    ]);
    expect(cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123", message: "a release" }).ok).toBe(true);
  });

  it("refuses when the tag already exists on origin -- never re-tags", () => {
    const seams = new ScriptedSeams([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "sha refs/tags/v1.0.0\n" } },
    ]);
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists on origin/);
  });

  it("refuses when the tag already exists locally", () => {
    const seams = new ScriptedSeams([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "v1.0.0\n" } },
    ]);
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists locally/);
  });

  // Review finding #4: a failed (not merely empty) existence check must
  // refuse, never be read as "does not exist".
  it("refuses when the remote existence check itself fails, rather than reading the failure as 'does not exist'", () => {
    const seams = new ScriptedSeams([
      { match: "git ls-remote --tags origin v1.0.0", result: { code: 128, stderr: "fatal: Could not read from remote repository.\n" } },
    ]);
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not determine whether/);
    expect(result.error).toMatch(/on origin/);
    // Never cut the tag on an unverified name.
    expect(seams.calls.some((c): boolean => c.args[0] === "tag" && c.args[1] !== "-l")).toBe(false);
  });

  it("refuses when the local existence check itself fails", () => {
    const seams = new ScriptedSeams([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { code: 1, stderr: "fatal: not a git repository\n" } },
    ]);
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not determine whether/);
    expect(result.error).toMatch(/locally/);
  });

  it("refuses when --at is not an ancestor of the trunk", () => {
    const seams = new ScriptedSeams(baseScript({ ancestorCode: 1 }));
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an ancestor/);
  });

  it("distinguishes a genuine reachability-test failure from 'not an ancestor'", () => {
    const seams = new ScriptedSeams(baseScript({ ancestorCode: 128 }));
    const result = cutTag(seams, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not test reachability/);
  });
});
