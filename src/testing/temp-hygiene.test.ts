// The guard behind zheref/nen#635's AC-3: a test that creates a temp directory
// on its own, without arranging its removal, is reported.
//
// The suite's sandbox (global-setup.ts) removes whatever a test leaves, so a
// leak no longer costs the host anything. This guard keeps the habit honest: a
// test file that calls mkdtemp directly must be listed in
// temp-hygiene.baseline.json, and the list may only shrink -- a new file uses
// makeTempDir() from ./tempdir.ts (src/testing/ itself is the helper's home and is
// not scanned), and a listed file that no longer calls
// mkdtemp must be taken off the list.
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(process.cwd(), "src");
const BASELINE = join(SRC, "testing", "temp-hygiene.baseline.json");
const MKDTEMP = /\bmkdtemp(?:Sync)?\b/;
const COMMENT_LINE = /^\s*(?:\/\/|\*|\/\*)/;

/** Test files and test fixtures under src/, relative to the repository root, forward slashes. */
function testSupportFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules") continue;
      testSupportFiles(path, out);
    } else if (entry.isFile() && /\.ts$/.test(entry.name) && (/\.test\.ts$/.test(entry.name) || /[\\/]fixtures[\\/]/.test(path))) {
      out.push(relative(process.cwd(), path).split("\\").join("/"));
    }
  }
  return out;
}

function callsMkdtemp(file: string): boolean {
  return readFileSync(join(process.cwd(), file), "utf8")
    .split("\n")
    .some((line) => !COMMENT_LINE.test(line) && MKDTEMP.test(line));
}

describe("test temp directories (zheref/nen#635)", () => {
  const baseline = new Set<string>(JSON.parse(readFileSync(BASELINE, "utf8")) as string[]);
  const files = testSupportFiles(SRC).filter((file) => !file.startsWith("src/testing/"));
  const callers = files.filter(callsMkdtemp);

  it("refuses a test that makes a temp directory without makeTempDir()", () => {
    const fresh = callers.filter((file) => !baseline.has(file));
    expect(fresh, `call makeTempDir() from src/testing/tempdir.ts instead of mkdtemp in: ${fresh.join(", ")}`).toEqual([]);
  });

  it("keeps the baseline to files that still call mkdtemp (it only shrinks)", () => {
    const stale = [...baseline].filter((file) => !callers.includes(file));
    expect(stale, `remove from src/testing/temp-hygiene.baseline.json: ${stale.join(", ")}`).toEqual([]);
  });

  it("lists the baseline sorted and without duplicates", () => {
    const listed = JSON.parse(readFileSync(BASELINE, "utf8")) as string[];
    expect(listed).toEqual([...new Set(listed)].sort());
  });
});
