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

  // Issue #21: String.split on a trailing-newline text leaves a final '' --
  // the greedy body capture swallowed it into whichever hunk happened to be
  // LAST in its own diff text, so the same hunk got a different identity
  // depending on whether anything followed it. Bodies now terminate exactly
  // per the '@@ -a,b +c,d @@' counts.
  it("does not swallow the trailing newline's phantom '' into the last hunk (issue #21)", () => {
    // TWO_FILE_DIFF ends with '' -- the split-artifact of a trailing newline.
    const files = parseDiff(TWO_FILE_DIFF);
    expect(files[1]?.hunks[0]?.text).toBe("@@ -1,1 +1,1 @@\n-x\n+y");
  });

  it("gives a hunk the same identity whether or not it is last in its diff text (issue #21)", () => {
    // The same hunk, once alone in a single-file diff (nothing after it but
    // the trailing newline) and once followed by another hunk -- the exact
    // asymmetry that made a one-file branch diff disagree with the multi-file
    // original it was cut from.
    const alone = [
      "diff --git a/src/a.ts b/src/a.ts",
      "index 111..222 100644",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1,3 +1,3 @@",
      " context",
      "-old",
      "+new",
      "",
    ].join("\n");
    expect(parseDiff(alone)[0]?.hunks[0]?.text).toBe(parseDiff(TWO_FILE_DIFF)[0]?.hunks[0]?.text);
  });

  it("keeps '\\ No newline at end of file' inside the hunk body it annotates", () => {
    const diff = [
      "diff --git a/x b/x",
      "index 1..2 100644",
      "--- a/x",
      "+++ b/x",
      "@@ -1,1 +1,1 @@",
      "-x",
      "+y",
      "\\ No newline at end of file",
      "",
    ].join("\n");
    expect(parseDiff(diff)[0]?.hunks[0]?.text).toBe("@@ -1,1 +1,1 @@\n-x\n+y\n\\ No newline at end of file");
  });

  it("reads the count-omitted '@@ -3 +3 @@' form as one line per side", () => {
    const diff = ["diff --git a/x b/x", "index 1..2 100644", "--- a/x", "+++ b/x", "@@ -3 +3 @@", "-x", "+y", ""].join("\n");
    expect(parseDiff(diff)[0]?.hunks[0]?.text).toBe("@@ -3 +3 @@\n-x\n+y");
  });
});
