import { describe, expect, it } from "vitest";
import { formatCommitMessage, validateCommitMessage, type CommitMessageInput } from "./format.js";

function input(overrides: Partial<CommitMessageInput> = {}): CommitMessageInput {
  return {
    type: "feat",
    scope: null,
    breaking: false,
    subject: "add a thing",
    body: [],
    trailers: [],
    ...overrides,
  };
}

describe("formatCommitMessage", () => {
  it("formats a bare header", () => {
    expect(formatCommitMessage(input())).toBe("feat: add a thing");
  });

  it("includes a scope and a breaking marker", () => {
    expect(formatCommitMessage(input({ scope: "cli", breaking: true }))).toBe("feat(cli)!: add a thing");
  });

  it("adds a blank-line-separated body", () => {
    expect(formatCommitMessage(input({ body: ["why it matters"] }))).toBe(
      "feat: add a thing\n\nwhy it matters",
    );
  });

  it("joins multiple body paragraphs with a blank line between them", () => {
    expect(formatCommitMessage(input({ body: ["first", "second"] }))).toBe(
      "feat: add a thing\n\nfirst\n\nsecond",
    );
  });

  it("appends caller-supplied trailers, never a literal baked in here", () => {
    const message = formatCommitMessage(
      input({ trailers: [{ key: "Closes", value: "#12" }, { key: "Some-Trailer", value: "x" }] }),
    );
    expect(message).toBe("feat: add a thing\n\nCloses: #12\nSome-Trailer: x");
  });
});

describe("validateCommitMessage -- shape only, never content", () => {
  it("passes a well-formed input", () => {
    expect(validateCommitMessage(input())).toEqual([]);
  });

  it("refuses an unknown type", () => {
    const refusals = validateCommitMessage(input({ type: "bogus" as never }));
    expect(refusals.some((r): boolean => r.includes("not one of"))).toBe(true);
  });

  it("refuses an empty subject", () => {
    expect(validateCommitMessage(input({ subject: "" })).length).toBeGreaterThan(0);
  });

  it("refuses a header over the length limit", () => {
    const refusals = validateCommitMessage(input({ subject: "x".repeat(80) }));
    expect(refusals.some((r): boolean => r.includes("72-character"))).toBe(true);
  });

  it("refuses a subject ending in punctuation", () => {
    expect(validateCommitMessage(input({ subject: "add a thing." })).length).toBeGreaterThan(0);
  });

  it("refuses an empty-string scope (should be null, not '')", () => {
    expect(validateCommitMessage(input({ scope: "" })).length).toBeGreaterThan(0);
  });

  it("refuses a trailer key containing a colon", () => {
    expect(validateCommitMessage(input({ trailers: [{ key: "Bad:Key", value: "x" }] })).length).toBeGreaterThan(0);
  });
});
