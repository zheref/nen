// src/dev/release-publish.test.ts -- the publisher behind `project.verbs.nen.release`.
// The script's own hermetic `--self-test` is the fixture set (a throwaway git
// repository, `gh` faked, nothing sent); this file runs it under vitest so CI
// carries it, and pins the pure helpers it rests on.

import { describe, expect, it } from "vitest";
import { composeNotes, parseArgs, previousTagOf, releasePublishMain, selfTest, slugFromRemote, unreleasedHeading } from "./release-publish.js";

describe("release-publish --self-test", () => {
  it("is all green", () => {
    const result = selfTest();
    expect(result.lines.filter((line): boolean => line.includes("FAIL"))).toEqual([]);
    expect(result.failed).toBe(0);
    expect(result.ran).toBeGreaterThan(20);
  });
});

describe("release-publish helpers", () => {
  it("derives the slug from both remote shapes", () => {
    expect(slugFromRemote("https://github.com/zheref/nen.git\n")).toBe("zheref/nen");
    expect(slugFromRemote("git@github.com:zheref/nen.git")).toBe("zheref/nen");
    expect(slugFromRemote("https://github.com/zheref/nen")).toBe("zheref/nen");
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
});
