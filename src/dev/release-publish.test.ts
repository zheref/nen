// src/dev/release-publish.test.ts -- the publisher behind `project.verbs.nen.release`.
// The script's own hermetic `--self-test` is the fixture set (a throwaway git
// repository, `gh` faked, nothing sent); this file runs it under vitest so CI
// carries it, and pins the pure helpers it rests on.

import { describe, expect, it } from "vitest";
import { composeNotes, parseArgs, previousTagOf, releasePublishMain, remoteHost, selfTest, slugFromRemote, unreleasedHeading } from "./release-publish.js";

describe("release-publish --self-test", () => {
  it("is all green", () => {
    const result = selfTest();
    expect(result.lines.filter((line): boolean => line.includes("FAIL"))).toEqual([]);
    expect(result.failed).toBe(0);
    expect(result.ran).toBeGreaterThan(40);
  });
});

describe("release-publish helpers", () => {
  it("derives the slug from both remote shapes", () => {
    expect(slugFromRemote("https://github.com/zheref/nen.git\n")).toBe("zheref/nen");
    expect(slugFromRemote("git@github.com:zheref/nen.git")).toBe("zheref/nen");
    expect(slugFromRemote("https://github.com/zheref/nen")).toBe("zheref/nen");
  });

  it("refuses a remote that is not a repository instead of reading a slug out of its path", () => {
    expect(slugFromRemote("/tmp/bare/repo.git")).toBeUndefined();
    expect(slugFromRemote("../elsewhere/repo.git\n")).toBeUndefined();
    expect(slugFromRemote("file:///tmp/bare/repo.git")).toBeUndefined();
    expect(slugFromRemote("https://github.com/owner/name/extra")).toBeUndefined();
  });

  it("refuses a remote on any host but github.com -- every gh call targets github.com", () => {
    expect(slugFromRemote("git@git.example.com:owner/name.git")).toBeUndefined();
    expect(slugFromRemote("https://git.example.com/owner/name.git")).toBeUndefined();
    expect(slugFromRemote("ssh://git@git.example.com:2222/owner/name.git")).toBeUndefined();
    expect(slugFromRemote("ssh://git@github.com/zheref/nen.git")).toBe("zheref/nen");
    expect(slugFromRemote("https://GitHub.com/zheref/nen.git")).toBe("zheref/nen");
    expect(remoteHost("git@git.example.com:owner/name.git")).toBe("git.example.com");
    expect(remoteHost("https://user@git.example.com:8443/owner/name")).toBe("git.example.com");
    expect(remoteHost("/tmp/bare/repo.git")).toBeUndefined();
  });

  it("takes the tag immediately below the target", () => {
    expect(previousTagOf(["v3.0.0", "v2.0.0", "v1.0.0"], "v2.0.0")).toBe("v1.0.0");
    expect(previousTagOf(["v3.0.0", "v2.0.0"], "v2.0.0")).toBeUndefined();
  });

  it("composes the tag's section and nothing it did not write", () => {
    const log = "# Changelog\n\n## v2.0.0 — two\n\n- b\n\n## v1.0.0 — one\n\n- a\n";
    expect(composeNotes(log, "v2.0.0", "v1.0.0")).toEqual({ notes: "## v2.0.0 — two\n\n- b\n", sections: 1 });
    expect(composeNotes(log, "v9.0.0")).toBeUndefined();
    expect(unreleasedHeading("## v2.0.0 — unreleased\n", "v2.0.0")).toBe(true);
    expect(unreleasedHeading(log, "v2.0.0")).toBe(false);
  });

  it("refuses an unknown flag at exit 2", () => {
    expect(() => parseArgs(["--asset", "x"])).toThrow(/unexpected argument/);
    const err: string[] = [];
    expect(releasePublishMain(["--nope"], undefined, { out: (): void => undefined, err: (l): void => { err.push(l); } })).toBe(2);
    expect(err.join("\n")).toContain("release-publish: unexpected argument '--nope'");
  });

  it("refuses a value flag given twice rather than taking the last one", () => {
    expect(() => parseArgs(["--tag", "v1.0.0", "--tag", "v2.0.0"])).toThrow(/--tag is given more than once/);
    expect(() => parseArgs(["--slug", "a/b", "--slug", "c/d"])).toThrow(/--slug is given more than once/);
    expect(() => parseArgs(["--repo", ".", "--repo", ".."])).toThrow(/--repo is given more than once/);
    expect(parseArgs(["--json", "--json"]).json).toBe(true);
  });
});
