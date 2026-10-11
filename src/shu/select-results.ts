// src/shu/select-results.ts -- after a focused run, read the results file its
// `select` block declares and count the tests it EXECUTED (zheref/nen#207,
// the maintainer's ruling on the acceptance criterion of 2026-09-27).
//
// WHY A RUN THAT EXITED 0 IS NOT ENOUGH. A runner handed an identifier that
// matches nothing -- typed from memory, one class name off -- prints
// "Executed 0 tests" and exits 0. Read as a status code that is "ran, passed",
// and it certifies whatever the caller already believed. So a focused run's
// verdict is the exit code AND the count: zero executed is exit 6, and a
// results file that is missing, unreadable, in another format or simply not
// rewritten by this run is exit 1 -- never a pass.
//
// THE PARSERS ARE `nen shu test-report`'s, unchanged: one reader per format,
// so a focused run and a full report can never count the same file two ways.

import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { readTestReport } from "./test-report/parse.js";
import { TestReportError } from "./test-report/shape.js";

/** The fingerprint of a results path before the run, to prove the run wrote it. */
export type ResultsState = string | null;

/**
 * What is at the path now: null when nothing is; else a digest of the file's
 * bytes, size, mtime and inode -- or, for a directory, of every entry's name,
 * size and mtime. A run that leaves this unchanged did not write its results.
 */
export function resultsState(absolute: string): ResultsState {
  const stats = lstatSync(absolute, { throwIfNoEntry: false });
  if (stats === undefined) return null;
  const hash = createHash("sha256");
  if (stats.isDirectory()) {
    hash.update(`dir:${stats.mtimeMs}`);
    for (const name of readdirSync(absolute).sort()) {
      const entry = lstatSync(join(absolute, name), { throwIfNoEntry: false });
      hash.update(`\0${name}:${entry?.size ?? -1}:${entry?.mtimeMs ?? -1}`);
    }
  } else {
    hash.update(`file:${stats.size}:${stats.mtimeMs}:${stats.ino}:`);
    if (stats.isFile()) hash.update(readFileSync(absolute));
  }
  return hash.digest("hex");
}

/** The verdict on one focused run's results. */
export type ResultsVerdict =
  | { readonly ok: true; readonly executed: number }
  | { readonly ok: false; readonly why: string };

/**
 * Read the declared results and count the executed tests, or say why not.
 *
 * `display` is the path as the declaration wrote it; every sentence quotes it.
 */
export function readSelectionResults(
  absolute: string,
  display: string,
  format: string,
  before: ResultsState,
): ResultsVerdict {
  const after = resultsState(absolute);
  if (after === null) {
    return {
      ok: false,
      why: `the run exited 0 and left no results at '${display}'. nen cannot tell how many tests it executed, so this is not a pass: check that the focused argv writes its results there`,
    };
  }
  if (before !== null && before === after) {
    return {
      ok: false,
      why: `the run exited 0 and did not rewrite '${display}'; what is there is an earlier run's, and counting it would vouch for tests this run may never have executed`,
    };
  }
  let parsed;
  try {
    parsed = readTestReport(absolute, display);
  } catch (error) {
    if (!(error instanceof TestReportError)) throw error;
    return { ok: false, why: `the results could not be read: ${error.message}` };
  }
  if (parsed.format.id !== format) {
    return {
      ok: false,
      why: `'${display}' is ${parsed.format.id}, and the declaration says ${format}. nen counts a results file only in the format it was declared in`,
    };
  }
  const counts = parsed.parsed.counts;
  return { ok: true, executed: counts.passed + counts.failed };
}
