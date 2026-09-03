import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { commentArgv, postComment, type CommentRequest } from "./comment.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function inline(issue: number, body: string): CommentRequest {
  return { issue, body, source: "inline" };
}

function fromFile(issue: number, body: string, path: string): CommentRequest {
  return { issue, body, source: "file", bodyFile: path };
}

describe("commentArgv -- the argv a dry run prints IS the argv that runs", () => {
  it("spells an inline body as --body", () => {
    expect(commentArgv(TARGET, inline(12, "new evidence"))).toEqual([
      "issue",
      "comment",
      "12",
      "--repo",
      "zheref/nen",
      "--body",
      "new evidence",
    ]);
  });

  // A body of any size on argv is a body against the host's command-line limit
  // (~32k on Windows, one of this repository's CI lanes) -- so a file body stays
  // a file all the way to `gh`, even though its bytes were read here for the
  // emptiness check and the dry-run transcript.
  it("spells a file body as --body-file, carrying the path the caller typed", () => {
    expect(commentArgv(TARGET, fromFile(12, "read from disk", "notes/body.md"))).toEqual([
      "issue",
      "comment",
      "12",
      "--repo",
      "zheref/nen",
      "--body-file",
      "notes/body.md",
    ]);
  });
});

describe("postComment -- posts through the Runner seam and reports where it landed", () => {
  it("runs exactly one gh call and reads the comment URL out of stdout", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue comment 12 --repo zheref/nen --body new evidence",
        result: { stdout: "https://github.com/zheref/nen/issues/12#issuecomment-777\n" },
      },
    ]);
    expect(postComment(seams, TARGET, inline(12, "new evidence"))).toEqual({
      url: "https://github.com/zheref/nen/issues/12#issuecomment-777",
    });
    expect(seams.calls.length).toBe(1);
  });

  // The endpoint `gh issue comment` drives serves a pull request's conversation
  // too, and this verb accepts that DELIBERATELY -- see ./comment.ts's header
  // for why that is the opposite call from zheref/nen#25's, and why it is right
  // here: nothing is classified, so nothing can be silently misclassified.
  it("posts on a number that names a pull request, and reports that URL", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue comment 925 --repo zheref/nen --body ping",
        result: { stdout: "https://github.com/zheref/nen/pull/925#issuecomment-1\n" },
      },
    ]);
    expect(postComment(seams, TARGET, inline(925, "ping")).url).toBe(
      "https://github.com/zheref/nen/pull/925#issuecomment-1",
    );
  });

  // The one place this differs from ./file.ts's fileIssue, which THROWS on a
  // missing URL: a create with no URL leaves nothing to report as filed, while
  // a comment with no URL has still been posted -- and throwing would tell the
  // caller their write failed, which is the report that makes them post twice.
  it("reports a null URL rather than throwing when gh printed none", () => {
    const seams = new ScriptedSeams([
      { match: "gh issue comment 12 --repo zheref/nen --body hi", result: { stdout: "" } },
    ]);
    expect(postComment(seams, TARGET, inline(12, "hi"))).toEqual({ url: null });
  });

  it("throws naming the object when gh refuses", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue comment 12 --repo zheref/nen --body hi",
        result: { code: 1, stderr: "HTTP 404: Not Found" },
      },
    ]);
    expect(() => postComment(seams, TARGET, inline(12, "hi"))).toThrow(/zheref\/nen#12/);
  });

  it("throws when gh could not be started at all, rather than reading code -1 as a refusal", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh issue comment 12 --repo zheref/nen --body hi",
        result: { code: -1, stderr: "spawn gh ENOENT", spawnFailed: true },
      },
    ]);
    expect(() => postComment(seams, TARGET, inline(12, "hi"))).toThrow(/ENOENT/);
  });
});
