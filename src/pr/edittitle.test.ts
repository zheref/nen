import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { editTitleArgv, readPullRequestTitle, writePullRequestTitle } from "./edittitle.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("editTitleArgv -- the argv a dry run prints IS the argv that runs (zheref/nen#523)", () => {
  it("spells the write as 'pr edit <n> --repo <slug> --title <title>', the title one argv element", () => {
    expect(editTitleArgv(TARGET, 12, "feat: a title with spaces")).toEqual(["pr", "edit", "12", "--repo", "zheref/nen", "--title", "feat: a title with spaces"]);
  });
});

describe("readPullRequestTitle -- the certifying read returns the title; anything else refuses or throws", () => {
  it("returns the title the pulls endpoint answers", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/12", result: { stdout: JSON.stringify({ number: 12, title: "old" }) } }]);
    expect(readPullRequestTitle(seams, TARGET, 12, "certify")).toBe("old");
  });

  it("refuses a 404 as a usage error when certifying, without claiming the number IS an issue", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/17", result: { code: 1, stderr: "HTTP 404: Not Found" } }]);
    expect(() => readPullRequestTitle(seams, TARGET, 17, "certify")).toThrow(/#17 does not read as a pull request.*404.*nen pr edit-title/);
  });

  it("names 410 when the endpoint answered 410", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/18", result: { code: 1, stderr: "HTTP 410: Gone" } }]);
    expect(() => readPullRequestTitle(seams, TARGET, 18, "certify")).toThrow(/answered 410/);
  });

  it("a 404 on the read-back is a failure (exit 1), not a usage refusal: the write already happened", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/12", result: { code: 1, stderr: "HTTP 404" } }]);
    let error: unknown;
    try {
      readPullRequestTitle(seams, TARGET, 12, "read back");
    } catch (caught) {
      error = caught;
    }
    expect((error as Error).message).toMatch(/could not read back/);
    expect((error as Error).name).not.toBe("VerbUsageError");
  });

  it("throws on an answer with no string title, and on non-JSON", () => {
    const noTitle = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/12", result: { stdout: JSON.stringify({ number: 12 }) } }]);
    expect(() => readPullRequestTitle(noTitle, TARGET, 12, "certify")).toThrow(/no string 'title'/);
    const garbage = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/12", result: { stdout: "<html>" } }]);
    expect(() => readPullRequestTitle(garbage, TARGET, 12, "certify")).toThrow(/did not answer JSON/);
  });

  it("throws on a spawn failure rather than reading it as a 404", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/pulls/12", result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true } }]);
    expect(() => readPullRequestTitle(seams, TARGET, 12, "certify")).toThrow(/ENOENT/);
  });
});

describe("writePullRequestTitle -- posts through the Runner seam", () => {
  it("runs the argv and throws on a non-zero exit", () => {
    const ok = new ScriptedSeams([{ match: "gh pr edit 12 --repo zheref/nen --title t", result: {} }]);
    expect(() => writePullRequestTitle(ok, TARGET, 12, "t")).not.toThrow();
    const bad = new ScriptedSeams([{ match: "gh pr edit 12 --repo zheref/nen --title t", result: { code: 1, stderr: "HTTP 422" } }]);
    expect(() => writePullRequestTitle(bad, TARGET, 12, "t")).toThrow(/could not replace zheref\/nen#12's title: HTTP 422/);
  });
});
