// The guard behind zheref/nen#635's AC-3: a test that creates a temp directory
// on its own, without arranging its removal, is reported.
//
// The suite's sandbox (global-setup.ts) removes whatever a test leaves, so a
// leak no longer costs the host anything. This guard keeps the habit honest.
// Every test file, test kit and fixture under src/ that mentions mkdtemp is
// listed in temp-hygiene.baseline.json with how many lines mention it, and:
//   - a file not listed, or a listed file with MORE such lines, fails, naming
//     the file: use makeTempDir() from ./tempdir.ts;
//   - a listed file with FEWER lines (or none) fails too, until its entry is
//     lowered or removed, so the baseline records every step down and a step
//     up is a visible diff in review.
// src/testing/ is the helper's own home and is not scanned.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const BASELINE = join(SRC, "testing", "temp-hygiene.baseline.json");
const MKDTEMP = /\bmkdtemp(?:Sync)?\b/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;
const TEST_SUPPORT = /(?:\.test\.ts|\.testkit\.ts|[\\/]testkit\.ts)$/;

/** Test files, test kits and fixtures under src/, relative to the repository root, forward slashes. */
function testSupportFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      testSupportFiles(path, out);
    } else if (entry.isFile() && entry.name.endsWith(".ts") && (TEST_SUPPORT.test(path) || /[\\/]fixtures[\\/]/.test(path))) {
      out.push(relative(process.cwd(), path).split("\\").join("/"));
    }
  }
  return out;
}

/** How many non-comment lines of the file mention mkdtemp. */
function mentions(file: string): number {
  return readFileSync(join(process.cwd(), file), "utf8")
    .split("\n")
    .filter((line) => !COMMENT_LINE.test(line) && MKDTEMP.test(line)).length;
}

describe("test temp directories (zheref/nen#635)", () => {
  const baseline = JSON.parse(readFileSync(BASELINE, "utf8")) as Record<string, number>;
  const actual = new Map<string, number>(
    testSupportFiles(SRC)
      .filter((file) => !file.startsWith("src/testing/"))
      .map((file): [string, number] => [file, mentions(file)])
      .filter(([, count]) => count > 0),
  );

  it("refuses a test, kit or fixture that makes a temp directory without makeTempDir()", () => {
    const grown = [...actual].filter(([file, count]) => count > (baseline[file] ?? 0)).map(([file]) => file);
    expect(grown, `call makeTempDir() from src/testing/tempdir.ts instead of mkdtemp in: ${grown.join(", ")}`).toEqual([]);
  });

  it("refuses an aliased mkdtemp import, which would hide later calls from the line count", () => {
    const aliased = [...actual.keys(), ...Object.keys(baseline)].filter((file) => /\bmkdtemp(?:Sync)?\s+as\b/.test(readFileSync(join(process.cwd(), file), "utf8")));
    expect(aliased, `import mkdtemp under its own name, or use makeTempDir(), in: ${aliased.join(", ")}`).toEqual([]);
  });

  it("records every step down: a listed file that mentions mkdtemp less often is lowered or removed", () => {
    const shrunk = Object.entries(baseline)
      .filter(([file, count]) => (actual.get(file) ?? 0) < count)
      .map(([file]) => `${file} (now ${actual.get(file) ?? 0})`);
    expect(shrunk, `lower or remove in src/testing/temp-hygiene.baseline.json: ${shrunk.join(", ")}`).toEqual([]);
  });

  it("lists the baseline sorted, with positive whole counts", () => {
    const files = Object.keys(baseline);
    expect(files).toEqual([...files].sort());
    for (const count of Object.values(baseline)) expect(Number.isInteger(count) && count > 0).toBe(true);
  });
});
