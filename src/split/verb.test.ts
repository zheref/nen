import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { VerbContext } from "../cli/verb.js";
import { splitVerb } from "./verb.js";

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: null,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

function diffFor(path: string): string {
  return [`diff --git a/${path} b/${path}`, "index 1..2 100644", `--- a/${path}`, `+++ b/${path}`, "@@ -1,1 +1,1 @@", "-x", "+y", ""].join("\n");
}

describe("nen split verify -- CLI wiring", () => {
  it("exits 0 and reports OK when the split is complete", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, diffFor("a.ts"));
    writeFileSync(branchA, diffFor("a.ts"));
    const { context, out } = makeContext({ args: ["verify"], values: { original, branches: branchA } });
    expect(splitVerb.run(context)).toBe(0);
    expect(out.join("\n")).toMatch(/^OK/m);
  });

  it("exits 1 and names a missing hunk when a branch drops it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, diffFor("a.ts"));
    writeFileSync(branchA, "");
    const { context, out } = makeContext({ args: ["verify"], values: { original, branches: branchA } });
    expect(splitVerb.run(context)).toBe(1);
    expect(out.join("\n")).toMatch(/MISSING/);
  });

  it("takes a comma-separated --branches list", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    const branchB = join(dir, "b.diff");
    writeFileSync(original, [diffFor("a.ts"), diffFor("b.ts")].join("\n"));
    writeFileSync(branchA, diffFor("a.ts"));
    writeFileSync(branchB, diffFor("b.ts"));
    const { context } = makeContext({ args: ["verify"], values: { original, branches: `${branchA},${branchB}` } });
    expect(splitVerb.run(context)).toBe(0);
  });

  it("requires --original and --branches", () => {
    expect(splitVerb.run(makeContext({ args: ["verify"] }).context)).toBe(2);
  });

  it("reports a missing file loudly rather than crashing", () => {
    const { context, err } = makeContext({
      args: ["verify"],
      values: { original: "/nope/original.diff", branches: "/nope/a.diff" },
    });
    expect(splitVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/could not read/);
  });

  it("refuses an unknown subcommand", () => {
    expect(splitVerb.run(makeContext({ args: ["bogus"] }).context)).toBe(2);
  });

  // Review finding #6: an empty --original must never read as a passed proof.
  it("exits 1 and refuses when --original names no hunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "empty.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, "");
    writeFileSync(branchA, "");
    const { context, err } = makeContext({ args: ["verify"], values: { original, branches: branchA } });
    expect(splitVerb.run(context)).toBe(1);
    expect(err.join("\n")).toMatch(/names no hunks/);
  });

  it("exits 1 and names an ALTERED hunk when a branch's body diverges under the same header", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-split-"));
    const original = join(dir, "original.diff");
    const branchA = join(dir, "a.diff");
    writeFileSync(original, diffFor("a.ts"));
    writeFileSync(
      branchA,
      [`diff --git a/a.ts b/a.ts`, "index 1..2 100644", `--- a/a.ts`, `+++ a/a.ts`, "@@ -1,1 +1,1 @@", "-x", "+z", ""].join("\n"),
    );
    const { context, out } = makeContext({ args: ["verify"], values: { original, branches: branchA } });
    expect(splitVerb.run(context)).toBe(1);
    expect(out.join("\n")).toMatch(/ALTERED/);
  });
});
