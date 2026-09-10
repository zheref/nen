import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SchemaError } from "../schema/errors.js";
import { messageFileRefusals, parseCommitMessageFile } from "./messagefile.js";

/** A fresh directory with no nen/workflow.json at all -- the default case. */
function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "nen-wc-messagefile-"));
}

/** A repository whose nen/workflow.json states exactly this `commits` block. */
function repoWithPolicy(commits: unknown): string {
  const root = tempRoot();
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ commits }));
  return root;
}

describe("parseCommitMessageFile -- turning a raw file back into CommitMessageInput", () => {
  it("parses a bare header", () => {
    const result = parseCommitMessageFile("feat: add a thing\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input).toMatchObject({
      type: "feat",
      scope: null,
      breaking: false,
      subject: "add a thing",
      body: [],
      trailers: [],
    });
  });

  it("parses a scope and a breaking marker", () => {
    const result = parseCommitMessageFile("feat(cli)!: add a thing\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.scope).toBe("cli");
    expect(result.value.input.breaking).toBe(true);
  });

  it("reads the body as the paragraphs between the header and the trailers", () => {
    const result = parseCommitMessageFile("feat: add a thing\n\nfirst paragraph\n\nsecond paragraph\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.body).toEqual(["first paragraph", "second paragraph"]);
    expect(result.value.input.trailers).toEqual([]);
  });

  it("reads a MULTI-LINE final paragraph of Key: value lines as trailers", () => {
    const result = parseCommitMessageFile(
      "feat: add a thing\n\nwhy it matters\n\nCloses: #12\nAkatsuki-Agent: kurapika\n",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.body).toEqual(["why it matters"]);
    expect(result.value.input.trailers).toEqual([
      { key: "Closes", value: "#12" },
      { key: "Akatsuki-Agent", value: "kurapika" },
    ]);
  });

  it("does NOT read the last paragraph as trailers when even one line fails the shape", () => {
    const result = parseCommitMessageFile("feat: add a thing\n\nCloses: #12\nnot a trailer line\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The whole paragraph stays body -- this module never guesses that a
    // paragraph was MEANT as trailers.
    expect(result.value.input.trailers).toEqual([]);
    expect(result.value.input.body).toEqual(["Closes: #12\nnot a trailer line"]);
  });

  it("reads trailers with no preceding body paragraph", () => {
    const result = parseCommitMessageFile("feat: add a thing\n\nCloses: #12\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.body).toEqual([]);
    expect(result.value.input.trailers).toEqual([{ key: "Closes", value: "#12" }]);
  });

  it("refuses an empty file", () => {
    const result = parseCommitMessageFile("");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toMatch(/empty/);
  });

  it("refuses a header with no Conventional Commits shape at all", () => {
    const result = parseCommitMessageFile("just some words, no colon\n");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons.join(" ")).toMatch(/does not look like a Conventional Commits header/);
  });

  it("still extracts a TYPE even when it is not a known one -- the shape checker refuses THAT, not the parser", () => {
    const result = parseCommitMessageFile("bogus: a thing\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.type).toBe("bogus");
  });

  it("normalizes CRLF before parsing", () => {
    const result = parseCommitMessageFile("feat: add a thing\r\n\r\nbody line\r\n");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.input.body).toEqual(["body line"]);
  });
});

describe("messageFileRefusals -- the same shape 'nen commit format' enforces", () => {
  it("passes a well-formed message with no trailers and no workflow file", () => {
    expect(messageFileRefusals(tempRoot(), "feat: add a thing\n")).toEqual([]);
  });

  it("refuses an unparseable header", () => {
    const refusals = messageFileRefusals(tempRoot(), "no header shape here\n");
    expect(refusals.some((r): boolean => r.includes("Conventional Commits header"))).toBe(true);
  });

  it("refuses an unknown type, reusing validateCommitMessage", () => {
    const refusals = messageFileRefusals(tempRoot(), "bogus: a thing\n");
    expect(refusals.some((r): boolean => r.includes("not one of"))).toBe(true);
  });

  it("refuses a header over the 72-character length limit", () => {
    const refusals = messageFileRefusals(tempRoot(), `feat: ${"x".repeat(80)}\n`);
    expect(refusals.some((r): boolean => r.includes("72-character"))).toBe(true);
  });

  it("reports EVERY problem in one pass, not just the first", () => {
    const refusals = messageFileRefusals(tempRoot(), `bogus: ${"x".repeat(80)}\n`);
    expect(refusals.length).toBeGreaterThan(1);
  });

  it("passes an ordinary trailer with no workflow file at all", () => {
    expect(messageFileRefusals(tempRoot(), "feat: add a thing\n\nCloses: #12\n")).toEqual([]);
  });

  it("refuses an attribution trailer the repository's workflow.json does not admit", () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: [] });
    const refusals = messageFileRefusals(root, "feat: add a thing\n\nCo-Authored-By: A <a@b>\n");
    expect(refusals.some((r): boolean => r.includes("Co-Authored-By"))).toBe(true);
    expect(refusals.some((r): boolean => r.includes("allowedAttributionTrailers"))).toBe(true);
  });

  it("admits an attribution trailer the workflow.json explicitly allows", () => {
    const root = repoWithPolicy({ allowedAttributionTrailers: ["Akatsuki-Agent"] });
    expect(messageFileRefusals(root, "feat: add a thing\n\nAkatsuki-Agent: kurapika\n")).toEqual([]);
  });

  it("never opens the workflow file at all when the message carries no trailers", () => {
    // A malformed workflow.json would throw on load; passing with one on disk
    // that IS malformed proves this path never reads it.
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), "{ not json");
    expect(messageFileRefusals(root, "feat: add a thing\n")).toEqual([]);
  });

  it("throws the loader's SchemaError when the workflow file IS present and malformed, and the message DOES carry a trailer", () => {
    const root = tempRoot();
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), "{ not json");
    expect((): unknown => messageFileRefusals(root, "feat: add a thing\n\nCloses: #12\n")).toThrow(SchemaError);
  });
});
