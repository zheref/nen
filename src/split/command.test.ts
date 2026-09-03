import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { splitCommand } from "./command.js";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("split verify makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(splitCommand, argv, null, false, io, seams);
  return { code, out, err };
}

function diffFor(path: string): string {
  return [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
}

// Issue #21's exact fixture, byte for byte from the report: two files, one
// hunk each, every diff text ending in a trailing newline (whose '' split-
// artifact the greedy body capture used to swallow into each text's LAST
// hunk -- so the file NOT listed last falsely reported ALTERED with
// 'line 9: original "(absent)" vs branch ""').
const ISSUE_21_ORIGINAL = [
  "diff --git a/src/parser.py b/src/parser.py",
  "index 1111111..2222222 100644",
  "--- a/src/parser.py",
  "+++ b/src/parser.py",
  "@@ -1,5 +1,10 @@",
  " def parse():",
  "-    pass",
  "+    return True",
  "+    # extra",
  "+    # extra2",
  "+    # extra3",
  "+    # extra4",
  "diff --git a/docs/readme.md b/docs/readme.md",
  "index 3333333..4444444 100644",
  "--- a/docs/readme.md",
  "+++ b/docs/readme.md",
  "@@ -1,3 +1,7 @@",
  " # Title",
  "-old line",
  "+new line",
  "+extra1",
  "+extra2",
  "+extra3",
  "",
].join("\n");
// Each axis diff is byte-identical to its half of the original -- the split
// below is what the issue calls "confirmed byte-identical, per-file".
const ISSUE_21_PARSER = `${ISSUE_21_ORIGINAL.split("\n").slice(0, 12).join("\n")}\n`;
const ISSUE_21_DOCS = ISSUE_21_ORIGINAL.split("\n").slice(12).join("\n");

describe("nen split verify -- CLI wiring", () => {
  it("exits 0 and reports OK when the split is complete", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, diffFor("a.ts"));
    writeFileSync(branchA, diffFor("a.ts"));
    const result = await capture(["split", "verify", "--original", original, "--branches", branchA]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^OK/m);
  });

  it("exits 1 and names a missing hunk when a branch drops it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, diffFor("a.ts"));
    writeFileSync(branchA, "");
    const result = await capture(["split", "verify", "--original", original, "--branches", branchA]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/MISSING/);
  });

  it("takes a comma-separated --branches list", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    const branchB = join(dir, "b.diff");
    writeFileSync(original, [diffFor("a.ts"), diffFor("b.ts")].join("\n"));
    writeFileSync(branchA, diffFor("a.ts"));
    writeFileSync(branchB, diffFor("b.ts"));
    const result = await capture(["split", "verify", "--original", original, "--branches", `${branchA},${branchB}`]);
    expect(result.code).toBe(0);
  });

  it("requires --original and --branches", async () => {
    expect((await capture(["split", "verify"])).code).toBe(2);
  });

  it("reports a missing file loudly rather than crashing", async () => {
    const result = await capture(["split", "verify", "--original", "/nope/original.diff", "--branches", "/nope/a.diff"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["split", "bogus"])).code).toBe(2);
  });

  // Review finding #6: an empty --original must never read as a passed proof.
  it("exits 1 and refuses when --original names no hunks", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "empty.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, "");
    writeFileSync(branchA, "");
    const result = await capture(["split", "verify", "--original", original, "--branches", branchA]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/names no hunks/);
  });

  // Issue #21: a genuinely byte-identical two-file split must report OK with
  // the branches in EITHER order -- pre-fix, whichever file was not last in
  // --original falsely reported ALTERED.
  it("exits 0 on issue #21's byte-identical two-file fixture, branches in issue order", async () => {
    // The fixture really is the split it claims to be: the two axis halves
    // concatenate back to the original, byte for byte.
    expect(ISSUE_21_PARSER + ISSUE_21_DOCS).toBe(ISSUE_21_ORIGINAL);
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const parser = join(dir, "axis-parser.diff");
    const docs = join(dir, "axis-docs.diff");
    writeFileSync(original, ISSUE_21_ORIGINAL);
    writeFileSync(parser, ISSUE_21_PARSER);
    writeFileSync(docs, ISSUE_21_DOCS);
    const result = await capture(["split", "verify", "--original", original, "--branches", `${parser},${docs}`]);
    expect(result.out.join("\n")).not.toMatch(/ALTERED/);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/^OK/m);
  });

  it("exits 0 on issue #21's fixture with the branch order swapped", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const parser = join(dir, "axis-parser.diff");
    const docs = join(dir, "axis-docs.diff");
    writeFileSync(original, ISSUE_21_ORIGINAL);
    writeFileSync(parser, ISSUE_21_PARSER);
    writeFileSync(docs, ISSUE_21_DOCS);
    const result = await capture(["split", "verify", "--original", original, "--branches", `${docs},${parser}`]);
    expect(result.out.join("\n")).not.toMatch(/ALTERED/);
    expect(result.code).toBe(0);
  });

  // Issue #21's hunk-boundary shape at the CLI: a branch genuinely short one
  // file reports exactly that file's MISSING line -- and no false ALTERED on
  // the hunk that survived.
  it("reports only MISSING, never a false ALTERED, when one axis diff is genuinely absent", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const parser = join(dir, "axis-parser.diff");
    writeFileSync(original, ISSUE_21_ORIGINAL);
    writeFileSync(parser, ISSUE_21_PARSER);
    const result = await capture(["split", "verify", "--original", original, "--branches", parser]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/MISSING \(in original, in no branch\): docs\/readme\.md/);
    expect(result.out.join("\n")).not.toMatch(/ALTERED/);
  });

  it("exits 1 and names an ALTERED hunk when a branch's body diverges under the same header", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, diffFor("a.ts"));
    writeFileSync(
      branchA,
      [`diff --git a/a.ts b/a.ts`, "index 1..2 100644", `--- a/a.ts`, `+++ a.ts`, "@@ -1,1 +1,1 @@", "-x", "+z", ""].join("\n"),
    );
    const result = await capture(["split", "verify", "--original", original, "--branches", branchA]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/ALTERED/);
  });
});
