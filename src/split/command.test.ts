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
