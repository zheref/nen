import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { parseLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import { createArgv, fileIssue, mentionedIssues, openPrCheck, validateFiling, type FileRequest } from "./file.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function taxonomy(): LabelTaxonomy {
  return parseLabelTaxonomy("/x/schemas/labels.json", {
    labels: [
      { name: "bug", color: "d93f0b", description: "a bug" },
      { name: "ns:sev/high", color: "d93f0b", description: "high" },
      { name: "ns:release/shipped", color: "0e8a16", description: "released" },
    ],
  });
}

describe("mentionedIssues", () => {
  it("finds every #N mention, deduplicated, in first-appearance order", () => {
    expect(mentionedIssues("see #12 and also #3, again #12")).toEqual([12, 3]);
  });

  it("returns empty for a body with no mentions", () => {
    expect(mentionedIssues("nothing here")).toEqual([]);
  });
});

describe("openPrCheck -- the guard against closing an issue with work in flight", () => {
  it("reports blocked when an open PR closes or mentions the issue", () => {
    const seams = new ScriptedSeams([
      {
        match:
          "gh pr list --repo zheref/nen --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
        result: {
          stdout: JSON.stringify([
            { number: 9, title: "fix", url: "https://x/9", isDraft: false, body: "see #12", closingIssuesReferences: [{ number: 5 }] },
          ]),
        },
      },
    ]);
    const report = openPrCheck(seams, TARGET, [5, 12, 99]);
    expect(report.findings.find((f): boolean => f.issue === 5)?.blocked).toBe(true);
    expect(report.findings.find((f): boolean => f.issue === 12)?.blocked).toBe(true);
    expect(report.findings.find((f): boolean => f.issue === 99)?.blocked).toBe(false);
    expect(report.truncated).toBe(false);
  });

  it("throws, naming the repository, when the list call fails", () => {
    const seams = new ScriptedSeams([
      {
        match:
          "gh pr list --repo zheref/nen --state open --limit 100 --json number,title,url,isDraft,body,closingIssuesReferences",
        result: { code: 1, stderr: "boom" },
      },
    ]);
    expect(() => openPrCheck(seams, TARGET, [1])).toThrow(/zheref\/nen/);
  });
});

describe("validateFiling -- reports every refusal, not just the first", () => {
  it("refuses a blank title, no labels, and no assignee all at once", () => {
    const request: FileRequest = {
      title: "",
      bodyFile: "body.md",
      labels: [],
      assignee: "",
      forbiddenFamilies: [],
    };
    const refusals = validateFiling(request, taxonomy());
    expect(refusals.length).toBe(3);
  });

  it("refuses a label absent from the target taxonomy", () => {
    const request: FileRequest = {
      title: "t",
      bodyFile: "b.md",
      labels: ["nonexistent"],
      assignee: "me",
      forbiddenFamilies: [],
    };
    const refusals = validateFiling(request, taxonomy());
    expect(refusals[0]?.reason).toMatch(/not in this repository's taxonomy/);
  });

  it("refuses a label in a forbidden family", () => {
    const request: FileRequest = {
      title: "t",
      bodyFile: "b.md",
      labels: ["ns:release/shipped"],
      assignee: "me",
      forbiddenFamilies: ["ns:release"],
    };
    const refusals = validateFiling(request, taxonomy());
    expect(refusals[0]?.reason).toMatch(/off-limits/);
  });

  it("passes clean for a well-formed request", () => {
    const request: FileRequest = {
      title: "t",
      bodyFile: "b.md",
      labels: ["bug"],
      assignee: "me",
      forbiddenFamilies: [],
    };
    expect(validateFiling(request, taxonomy())).toEqual([]);
  });
});

describe("createArgv -- labels and assignee IN the create call", () => {
  it("carries one --label per label, in order", () => {
    const argv = createArgv(TARGET, {
      title: "t",
      bodyFile: "b.md",
      labels: ["bug", "ns:sev/high"],
      assignee: "me",
      forbiddenFamilies: [],
    });
    expect(argv).toEqual([
      "issue",
      "create",
      "--repo",
      "zheref/nen",
      "--title",
      "t",
      "--body-file",
      "b.md",
      "--assignee",
      "me",
      "--label",
      "bug",
      "--label",
      "ns:sev/high",
    ]);
  });
});

describe("fileIssue", () => {
  it("reads the issue number and url out of stdout", () => {
    const request: FileRequest = {
      title: "t",
      bodyFile: "b.md",
      labels: ["bug"],
      assignee: "me",
      forbiddenFamilies: [],
    };
    const argv = createArgv(TARGET, request);
    const seams = new ScriptedSeams([
      { match: `gh ${argv.join(" ")}`, result: { stdout: "https://github.com/zheref/nen/issues/42\n" } },
    ]);
    expect(fileIssue(seams, TARGET, request)).toEqual({
      url: "https://github.com/zheref/nen/issues/42",
      number: 42,
    });
  });

  it("throws when gh reports no URL, rather than reporting a fake success", () => {
    const request: FileRequest = {
      title: "t",
      bodyFile: "b.md",
      labels: ["bug"],
      assignee: "me",
      forbiddenFamilies: [],
    };
    const argv = createArgv(TARGET, request);
    const seams = new ScriptedSeams([{ match: `gh ${argv.join(" ")}`, result: { stdout: "" } }]);
    expect(() => fileIssue(seams, TARGET, request)).toThrow(/no issue URL/);
  });
});
