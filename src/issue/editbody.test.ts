import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { certifyIssue, editBodyArgv, writeIssueBody } from "./editbody.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function issuePayload(number: number, id: number): string {
  return JSON.stringify({ number, id, title: "an issue", state: "open", labels: [] });
}

function prPayload(number: number, id: number): string {
  return JSON.stringify({
    number,
    id,
    title: "a pull request",
    state: "open",
    labels: [],
    pull_request: { url: `https://api.github.com/repos/zheref/nen/pulls/${number}` },
  });
}

describe("editBodyArgv -- the argv a dry run prints IS the argv that runs", () => {
  it("spells the write as 'issue edit <n> --repo <slug> --body-file <path>'", () => {
    expect(editBodyArgv(TARGET, 12, "notes/body.md")).toEqual([
      "issue",
      "edit",
      "12",
      "--repo",
      "zheref/nen",
      "--body-file",
      "notes/body.md",
    ]);
  });
});

describe("certifyIssue -- refuses (as a usage error) before any write when the number names a pull request", () => {
  it("returns without throwing for a genuine issue", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/issues/12", result: { stdout: issuePayload(12, 100) } }]);
    expect(() => certifyIssue(seams, TARGET, 12)).not.toThrow();
    expect(seams.calls.length).toBe(1);
  });

  it("throws naming the object when the number names a pull request", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/issues/925", result: { stdout: prPayload(925, 901) } }]);
    let message = "";
    try {
      certifyIssue(seams, TARGET, 925);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toMatch(/#925 names a pull request .* not an issue/);
    expect(message).toMatch(/nen pr edit-body/);
    expect(seams.calls.length).toBe(1);
  });

  it("propagates a read failure as its own error, not the object-class refusal", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/issues/12", result: { code: 1, stderr: "not found" } }]);
    expect(() => certifyIssue(seams, TARGET, 12)).toThrow(/could not read/);
  });
});

describe("writeIssueBody -- posts through the Runner seam", () => {
  it("runs exactly one gh call with the caller's own path", () => {
    const seams = new ScriptedSeams([
      { match: "gh issue edit 12 --repo zheref/nen --body-file notes/body.md", result: {} },
    ]);
    expect(() => writeIssueBody(seams, TARGET, 12, "notes/body.md")).not.toThrow();
    expect(seams.calls.length).toBe(1);
  });

  it("throws naming the object when gh refuses", () => {
    const seams = new ScriptedSeams([
      { match: "gh issue edit 12 --repo zheref/nen --body-file notes/body.md", result: { code: 1, stderr: "HTTP 404: Not Found" } },
    ]);
    expect(() => writeIssueBody(seams, TARGET, 12, "notes/body.md")).toThrow(/zheref\/nen#12/);
  });

  it("throws when gh could not be started at all, rather than reading code -1 as a refusal", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue edit 12 --repo zheref/nen --body-file notes/body.md",
        result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true },
      },
    ]);
    expect(() => writeIssueBody(seams, TARGET, 12, "notes/body.md")).toThrow(/ENOENT/);
  });
});
