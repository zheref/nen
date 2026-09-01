import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { parseLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import type { FileRequest } from "../issue/file.js";
import { compareReadBack, fileIdea, FileIdeaError } from "./file.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function taxonomy(): LabelTaxonomy {
  return parseLabelTaxonomy("/x/schemas/labels.json", {
    labels: [{ name: "stage:idea", color: "d93f0b", description: "an idea" }],
  });
}

function request(overrides: Partial<FileRequest> = {}): FileRequest {
  return {
    title: "an idea",
    bodyFile: "body.md",
    labels: ["stage:idea"],
    assignee: "me",
    forbiddenFamilies: [],
    ...overrides,
  };
}

describe("compareReadBack", () => {
  it("finds no mismatch when everything matches, ignoring CRLF-vs-LF and whitespace", () => {
    const mismatches = compareReadBack(
      request(),
      "line one\r\nline two\r\n",
      { title: "an idea", body: "line one\nline two", labels: ["stage:idea"] },
    );
    expect(mismatches).toEqual([]);
  });

  it("reports a title mismatch", () => {
    const mismatches = compareReadBack(request(), "body", { title: "different", body: "body", labels: ["stage:idea"] });
    expect(mismatches).toEqual([{ field: "title", expected: "an idea", actual: "different" }]);
  });

  it("reports a body mismatch", () => {
    const mismatches = compareReadBack(request(), "expected body", { title: "an idea", body: "actual body", labels: ["stage:idea"] });
    expect(mismatches.some((m): boolean => m.field === "body")).toBe(true);
  });

  it("reports a label-set mismatch regardless of order", () => {
    const withExtra = compareReadBack(
      { ...request(), labels: ["a", "b"] },
      "body",
      { title: "an idea", body: "body", labels: ["b", "a", "c"] },
    );
    expect(withExtra.some((m): boolean => m.field === "labels")).toBe(true);

    const sameOrderDifferent = compareReadBack(
      { ...request(), labels: ["a", "b"] },
      "body",
      { title: "an idea", body: "body", labels: ["b", "a"] },
    );
    expect(sameOrderDifferent).toEqual([]);
  });
});

describe("fileIdea -- file, then read back, then compare", () => {
  it("returns refusals without ever calling gh when the request is invalid", () => {
    const runner = new ScriptedRunner([]);
    const result = fileIdea(runner, TARGET, request({ title: "" }), "body", taxonomy());
    expect("refusals" in result && result.refusals.length > 0).toBe(true);
    expect(runner.calls).toEqual([]);
  });

  it("files, reads back, and finds no mismatch on a clean round trip", () => {
    const runner = new ScriptedRunner([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      {
        match: "gh issue view 9 --repo zheref/nen --json title,body,labels",
        result: { stdout: JSON.stringify({ title: "an idea", body: "the body", labels: [{ name: "stage:idea" }] }) },
      },
    ]);
    const result = fileIdea(runner, TARGET, request(), "the body", taxonomy());
    expect("mismatches" in result && result.mismatches).toEqual([]);
  });

  it("surfaces a mismatch rather than reporting success", () => {
    const runner = new ScriptedRunner([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      {
        match: "gh issue view 9 --repo zheref/nen --json title,body,labels",
        result: { stdout: JSON.stringify({ title: "SOMETHING ELSE", body: "the body", labels: [{ name: "stage:idea" }] }) },
      },
    ]);
    const result = fileIdea(runner, TARGET, request(), "the body", taxonomy());
    expect("mismatches" in result && result.mismatches.length).toBe(1);
  });

  it("throws a named error when the read-back call itself fails -- the issue still exists", () => {
    const runner = new ScriptedRunner([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      { match: "gh issue view 9 --repo zheref/nen --json title,body,labels", result: { code: 1, stderr: "down" } },
    ]);
    expect(() => fileIdea(runner, TARGET, request(), "the body", taxonomy())).toThrow(FileIdeaError);
  });
});
