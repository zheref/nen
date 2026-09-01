import { describe, expect, it } from "vitest";
import { ScriptedRunner, type ScriptedCall } from "../exec/seam.js";
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
    const runner = new ScriptedRunner([
      ...baseScript(),
      { match: "git tag v1.0.0 abc123", result: {} },
    ]);
    const result = cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(true);
    expect(result.pushed).toBe(false);
    expect(result.log.some((l): boolean => l.includes("NOT pushed"))).toBe(true);
    expect(runner.calls.some((c): boolean => c.args.includes("push"))).toBe(false);
  });

  it("pushes only when --push (push:true) is given", () => {
    const runner = new ScriptedRunner([
      ...baseScript(),
      { match: "git tag v1.0.0 abc123", result: {} },
      { match: "git push origin v1.0.0", result: {} },
    ]);
    const result = cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123", push: true });
    expect(result.pushed).toBe(true);
  });

  it("carries a --message through to git tag -m", () => {
    const runner = new ScriptedRunner([
      ...baseScript(),
      { match: "git tag -m a release v1.0.0 abc123", result: {} },
    ]);
    expect(cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123", message: "a release" }).ok).toBe(true);
  });

  it("refuses when the tag already exists on origin -- never re-tags", () => {
    const runner = new ScriptedRunner([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "sha refs/tags/v1.0.0\n" } },
    ]);
    const result = cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists on origin/);
  });

  it("refuses when the tag already exists locally", () => {
    const runner = new ScriptedRunner([
      { match: "git ls-remote --tags origin v1.0.0", result: { stdout: "" } },
      { match: "git tag -l v1.0.0", result: { stdout: "v1.0.0\n" } },
    ]);
    const result = cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/already exists locally/);
  });

  it("refuses when --at is not an ancestor of the trunk", () => {
    const runner = new ScriptedRunner(baseScript({ ancestorCode: 1 }));
    const result = cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/not an ancestor/);
  });

  it("distinguishes a genuine reachability-test failure from 'not an ancestor'", () => {
    const runner = new ScriptedRunner(baseScript({ ancestorCode: 128 }));
    const result = cutTag(runner, "/repo", { name: "v1.0.0", at: "abc123" });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/could not test reachability/);
  });
});
