import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { certifyPullRequest, editBodyArgv, writePullRequestBody } from "./editbody.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("editBodyArgv -- the argv a dry run prints IS the argv that runs", () => {
  it("spells the write as 'pr edit <n> --repo <slug> --body-file <path>'", () => {
    expect(editBodyArgv(TARGET, 12, "notes/body.md")).toEqual([
      "pr",
      "edit",
      "12",
      "--repo",
      "zheref/nen",
      "--body-file",
      "notes/body.md",
    ]);
  });
});

describe("certifyPullRequest -- refuses (as a usage error) before any write when the number does not read as a pull request", () => {
  it("returns without throwing when the pulls endpoint resolves the number", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/pulls/12", result: { stdout: JSON.stringify({ number: 12 }) } },
    ]);
    expect(() => certifyPullRequest(seams, TARGET, 12)).not.toThrow();
    expect(seams.calls.length).toBe(1);
  });

  it("throws a usage error on a 404, without claiming the number IS an issue", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/pulls/17", result: { code: 1, stderr: "HTTP 404: Not Found" } },
    ]);
    let message = "";
    try {
      certifyPullRequest(seams, TARGET, 17);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/#17 does not read as a pull request/);
    expect(message).toMatch(/404/);
    expect(message).toMatch(/nen issue edit-body/);
    // Careful wording: this read cannot prove #17 IS an issue, only that it
    // is not a pull request -- see ./editbody.ts's header.
    expect(message).not.toMatch(/#17 names an issue/);
  });

  it("throws the same refusal shape on a 410 (Gone), naming 410 rather than 404", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/pulls/18", result: { code: 1, stderr: "HTTP 410: Gone" } },
    ]);
    let message = "";
    try {
      certifyPullRequest(seams, TARGET, 18);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/410/);
    expect(message).not.toMatch(/404/);
  });

  it("propagates any OTHER failure as its own error, not the object-class refusal", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/pulls/12", result: { code: 1, stderr: "HTTP 503: Service Unavailable" } },
    ]);
    expect(() => certifyPullRequest(seams, TARGET, 12)).toThrow(/could not certify/);
  });

  it("throws when gh could not be started at all, rather than reading a spawn failure as a 404", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/pulls/12", result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true } },
    ]);
    expect(() => certifyPullRequest(seams, TARGET, 12)).toThrow(/ENOENT/);
  });
});

describe("writePullRequestBody -- posts through the Runner seam", () => {
  it("runs exactly one gh call with the caller's own path", () => {
    const seams = new ScriptedSeams([
      { match: "gh pr edit 12 --repo zheref/nen --body-file notes/body.md", result: {} },
    ]);
    expect(() => writePullRequestBody(seams, TARGET, 12, "notes/body.md")).not.toThrow();
    expect(seams.calls.length).toBe(1);
  });

  it("throws naming the object when gh refuses", () => {
    const seams = new ScriptedSeams([
      { match: "gh pr edit 12 --repo zheref/nen --body-file notes/body.md", result: { code: 1, stderr: "HTTP 404: Not Found" } },
    ]);
    expect(() => writePullRequestBody(seams, TARGET, 12, "notes/body.md")).toThrow(/zheref\/nen#12/);
  });

  it("throws when gh could not be started at all, rather than reading code -1 as a refusal", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh pr edit 12 --repo zheref/nen --body-file notes/body.md",
        result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true },
      },
    ]);
    expect(() => writePullRequestBody(seams, TARGET, 12, "notes/body.md")).toThrow(/ENOENT/);
  });
});
