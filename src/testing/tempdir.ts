// The way a test makes a temp directory (zheref/nen#635): makeTempDir() creates
// it under the run's sandbox and removes it when the importing test file's
// tests have finished, pass or fail. Removal is per FILE, not per test, so a
// directory made in beforeAll, in a describe body or at module scope stays
// there for every test that uses it. A bare mkdtemp in a test file is refused
// by temp-hygiene.test.ts.
//
//   import { makeTempDir } from "../testing/tempdir.js";
//   const dir = makeTempDir("nen-thing-");
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";
import { removeTree } from "./temp-sandbox.js";

const made: string[] = [];

/** Removes every directory makeTempDir made so far; a removal that fails is left to the sandbox, never failing the test. */
export function cleanupTempDirs(): void {
  for (const dir of made.splice(0)) {
    try {
      removeTree(dir);
    } catch {
      // The run's sandbox removes it at the end.
    }
  }
}

// Registered when the importing test file loads, so it runs after that file's tests.
afterAll(cleanupTempDirs);

/** A fresh directory under the temp dir, removed after the importing file's tests. */
export function makeTempDir(prefix = "nen-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}
