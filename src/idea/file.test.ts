import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
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
  it("finds no mismatch when bodies differ only by CRLF-vs-LF line endings", () => {
    const mismatches = compareReadBack(
      request(),
      "line one\r\nline two\r\n",
      { title: "an idea", body: "line one\nline two\n", labels: ["stage:idea"] },
    );
    expect(mismatches).toEqual([]);
  });

  // Review finding: normalize() used to also .trim(), which silently hid a
  // real read-back mismatch (trailing whitespace, a leading blank line) behind
  // the CRLF exception this verb advertises as the ONLY normalization applied.
  // The comparison must be exactly CRLF-normalization, nothing looser.
  it("reports a body mismatch on trailing whitespace GitHub did not add, rather than trimming it away", () => {
    const mismatches = compareReadBack(
      request(),
      "line one\nline two",
      { title: "an idea", body: "line one\nline two ", labels: ["stage:idea"] },
    );
    expect(mismatches.some((m): boolean => m.field === "body")).toBe(true);
  });

  it("reports a body mismatch on a leading blank line, rather than trimming it away", () => {
    const mismatches = compareReadBack(
      request(),
      "line one",
      { title: "an idea", body: "\nline one", labels: ["stage:idea"] },
    );
    expect(mismatches.some((m): boolean => m.field === "body")).toBe(true);
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
    const seams = new ScriptedSeams([]);
    const result = fileIdea(seams, TARGET, request({ title: "" }), "body", taxonomy());
    expect("refusals" in result && result.refusals.length > 0).toBe(true);
    expect(seams.calls).toEqual([]);
  });

  it("files, reads back, and finds no mismatch on a clean round trip", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      {
        match: "gh api repos/zheref/nen/issues/9",
        result: { stdout: JSON.stringify({ title: "an idea", body: "the body", labels: [{ name: "stage:idea" }] }) },
      },
    ]);
    const result = fileIdea(seams, TARGET, request(), "the body", taxonomy());
    expect("mismatches" in result && result.mismatches).toEqual([]);
  });

  it("surfaces a mismatch rather than reporting success", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      {
        match: "gh api repos/zheref/nen/issues/9",
        result: { stdout: JSON.stringify({ title: "SOMETHING ELSE", body: "the body", labels: [{ name: "stage:idea" }] }) },
      },
    ]);
    const result = fileIdea(seams, TARGET, request(), "the body", taxonomy());
    expect("mismatches" in result && result.mismatches.length).toBe(1);
  });

  // zheref/nen#77. The read-back had no object-class check, and the read it
  // used (`gh issue view --json title,body,labels`) could not have made one:
  // `--json pull_request` does not exist on that command. It is a REST read
  // now, so the discriminator arrives with the three compared fields in the
  // SAME call -- no extra round trip was spent to gain the check.
  //
  // A pull request here is not a mistyped flag: this verb just CREATED an
  // issue and is reading back the number that creation returned, so there is
  // no number for a caller to have got wrong. It means the verification fetch
  // reached a different object, and comparing title/body/labels against it
  // would report either a mismatch about a record nobody filed or -- if they
  // happen to agree -- a confident, false "read-back OK".
  it("fails loudly when the read-back answers with a PULL REQUEST, rather than comparing against it", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      {
        match: "gh api repos/zheref/nen/issues/9",
        result: {
          stdout: JSON.stringify({
            number: 9,
            title: "an idea",
            body: "the body",
            labels: [{ name: "stage:idea" }],
            pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/9" },
          }),
        },
      },
    ]);
    expect(() => fileIdea(seams, TARGET, request(), "the body", taxonomy())).toThrow(FileIdeaError);
  });

  // THE FIELDS AGREEING IS THE DANGEROUS CASE, and the one a naive fix would
  // wave through: every compared field matches, so a verb without the class
  // check prints "read-back OK" for a record it never saw.
  it("fails even when the pull request's title, body and labels all match what was submitted", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      {
        match: "gh api repos/zheref/nen/issues/9",
        result: {
          stdout: JSON.stringify({
            number: 9,
            title: "an idea",
            body: "the body",
            labels: [{ name: "stage:idea" }],
            pull_request: { url: "https://api.github.com/repos/zheref/nen/pulls/9" },
          }),
        },
      },
    ]);
    let message = "";
    try {
      fileIdea(seams, TARGET, request(), "the body", taxonomy());
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Actionable, and honest about what DID happen: the issue is filed, so a
    // caller must not re-file it, and the number is named so it can be checked.
    expect(message).toMatch(/idea filed as #9/);
    expect(message).toMatch(/PULL REQUEST, not an issue/);
    expect(message).toMatch(/verify it by hand/);
  });

  it("throws a named error when the read-back call itself fails -- the issue still exists", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue create --repo zheref/nen --title an idea --body-file body.md --assignee me --label stage:idea",
        result: { stdout: "https://github.com/zheref/nen/issues/9\n" },
      },
      { match: "gh api repos/zheref/nen/issues/9", result: { code: 1, stderr: "down" } },
    ]);
    expect(() => fileIdea(seams, TARGET, request(), "the body", taxonomy())).toThrow(FileIdeaError);
  });
});
