import { describe, expect, it } from "vitest";
import { parseDiff } from "./diff.js";

const TWO_FILE_DIFF = [
  "diff --git a/src/a.ts b/src/a.ts",
  "index 111..222 100644",
  "--- a/src/a.ts",
  "+++ b/src/a.ts",
  "@@ -1,3 +1,3 @@",
  " context",
  "-old",
  "+new",
  "@@ -10,2 +10,3 @@",
  " more context",
  "+added",
  "diff --git a/src/b.ts b/src/b.ts",
  "index 333..444 100644",
  "--- a/src/b.ts",
  "+++ b/src/b.ts",
  "@@ -1,1 +1,1 @@",
  "-x",
  "+y",
  "",
].join("\n");

describe("parseDiff -- down to the hunk, never applying or judging", () => {
  it("splits multiple files, each into its own hunks", () => {
    const files = parseDiff(TWO_FILE_DIFF);
    expect(files.map((f): string => f.path)).toEqual(["src/a.ts", "src/b.ts"]);
    expect(files[0]?.hunks.length).toBe(2);
    expect(files[1]?.hunks.length).toBe(1);
  });

  it("a hunk's identity is its header plus its full body, verbatim", () => {
    const files = parseDiff(TWO_FILE_DIFF);
    const hunk = files[0]?.hunks[0];
    expect(hunk?.header).toBe("@@ -1,3 +1,3 @@");
    expect(hunk?.text).toBe("@@ -1,3 +1,3 @@\n context\n-old\n+new");
  });

  it("normalizes CRLF before parsing", () => {
    const crlf = TWO_FILE_DIFF.replace(/\n/g, "\r\n");
    const files = parseDiff(crlf);
    expect(files[0]?.hunks[0]?.text).not.toContain("\r");
  });

  it("returns an empty list for a diff with no changes", () => {
    expect(parseDiff("")).toEqual([]);
  });

  it("captures the preamble (diff --git, index, ---/+++) separately from hunks", () => {
    const files = parseDiff(TWO_FILE_DIFF);
    expect(files[0]?.preamble).toEqual([
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
    ]);
  });
});
