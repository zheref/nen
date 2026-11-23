// The way a test makes a temp directory (zheref/nen#635): makeTempDir() creates
// it under the run's sandbox and removes it after every test in the importing
// file, pass or fail. A bare mkdtemp in a test is refused by temp-hygiene.test.ts.
//
//   import { makeTempDir } from "../testing/tempdir.js";
//   const dir = makeTempDir("nen-thing-");
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { removeTree } from "./temp-sandbox.js";

const made: string[] = [];

// Registered when the importing test file loads, so it runs for that file's tests.
afterEach(() => {
  for (const dir of made.splice(0)) removeTree(dir);
});

/** A fresh directory under the temp dir, removed after the current test. */
export function makeTempDir(prefix = "nen-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
