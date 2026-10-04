import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import {
  BodyNotSentError,
  bodySha256,
  certifyIssue,
  checkExpectedBody,
  editBodyArgv,
  parseExpectedSha256,
  readBackAfterFailedWrite,
  writeIssueBody,
} from "./editbody.js";

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
    expect(() => writeIssueBody(seams, TARGET, 12, "notes/body.md")).toThrow(BodyNotSentError);
    expect(() => writeIssueBody(seams, TARGET, 12, "notes/body.md")).toThrow(/gh could not be started \(spawn gh ENOENT\), so nothing was sent/);
  });
});

describe("bodySha256 / parseExpectedSha256 / checkExpectedBody -- the lost-update check (zheref/nen#205)", () => {
  const ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("hashes the UTF-8 bytes exactly, with no trimming or newline normalisation", () => {
    expect(bodySha256("abc")).toBe(ABC);
    expect(bodySha256("abc\n")).not.toBe(ABC);
    expect(bodySha256("a\r\nb")).not.toBe(bodySha256("a\nb"));
  });

  it("accepts 64 hex digits in either case and returns them lowercase; refuses anything else as a usage error", () => {
    expect(parseExpectedSha256(ABC.toUpperCase())).toBe(ABC);
    for (const bad of ["", "abc", `${ABC}a`, ABC.replace("b", "z"), ` ${ABC}`]) {
      expect(() => parseExpectedSha256(bad)).toThrow(/64 hex digits/);
    }
  });

  it("reports none / matched / conflict from the certifying read's body", () => {
    const summary = { number: 12, id: 1, title: "t", state: "open", labels: [], isPullRequest: false, body: "abc" };
    expect(checkExpectedBody(summary, null, "zheref/nen")).toEqual({ currentSha256: ABC, currentBytes: 3, expectedSha256: null, result: "none" });
    expect(checkExpectedBody(summary, ABC, "zheref/nen").result).toBe("matched");
    expect(checkExpectedBody(summary, bodySha256("other"), "zheref/nen").result).toBe("conflict");
    // GitHub's null body is "" -- it reaches here already as "".
    expect(checkExpectedBody({ ...summary, body: "" }, bodySha256(""), "zheref/nen").result).toBe("matched");
  });

  it("a read with NO body field is not the empty body: unhashed without an expectation, refused with one (N9)", () => {
    const bodiless = { number: 12, id: 1, title: "t", state: "open", labels: [], isPullRequest: false };
    expect(checkExpectedBody(bodiless, null, "zheref/nen")).toEqual({
      currentSha256: null,
      currentBytes: null,
      expectedSha256: null,
      result: "none",
    });
    expect(() => checkExpectedBody(bodiless, bodySha256(""), "zheref/nen")).toThrow(
      /zheref\/nen#12's read carried no 'body' field, so --expect-body-sha256 cannot be compared with it -- nothing was written/,
    );
  });

  it("certifyIssue hands back the read it made, body included, so the check costs no second request", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/12", result: { stdout: JSON.stringify({ number: 12, id: 1, title: "t", state: "open", labels: [], body: "abc" }) } },
    ]);
    expect(certifyIssue(seams, TARGET, 12).body).toBe("abc");
    expect(seams.calls.length).toBe(1);
  });
});

describe("readBackAfterFailedWrite -- evidence about an uncertain write, never a verdict", () => {
  it("says whether the body now equals the submitted bytes", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/12", result: { stdout: JSON.stringify({ number: 12, id: 1, body: "sent" }) } },
    ]);
    expect(readBackAfterFailedWrite(seams, TARGET, 12, bodySha256("sent"), bodySha256("before"))).toEqual({
      currentSha256: bodySha256("sent"),
      matchesSubmitted: true,
      matchesPrevious: false,
      readError: null,
    });
    const unchanged = readBackAfterFailedWrite(seams, TARGET, 12, bodySha256("other"), bodySha256("sent"));
    expect(unchanged.matchesSubmitted).toBe(false);
    expect(unchanged.matchesPrevious).toBe(true);
    expect(readBackAfterFailedWrite(seams, TARGET, 12, bodySha256("sent"), null).matchesPrevious).toBeNull();
  });

  it("a read-back with no body field is reported as a read error, not hashed as empty", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/zheref/nen/issues/12", result: { stdout: JSON.stringify({ number: 12, id: 1 }) } },
    ]);
    expect(readBackAfterFailedWrite(seams, TARGET, 12, bodySha256(""), bodySha256(""))).toEqual({
      currentSha256: null,
      matchesSubmitted: null,
      matchesPrevious: null,
      readError: "zheref/nen#12's read-back carried no 'body' field",
    });
  });

  it("reports a failed read-back as unknown rather than throwing over the write's own error", () => {
    const seams = new ScriptedSeams([{ match: "gh api repos/zheref/nen/issues/12", result: { code: 1, stderr: "HTTP 503" } }]);
    expect(readBackAfterFailedWrite(seams, TARGET, 12, bodySha256("sent"), null)).toEqual({
      currentSha256: null,
      matchesSubmitted: null,
      matchesPrevious: null,
      readError: "could not read zheref/nen#12: HTTP 503",
    });
  });
});
