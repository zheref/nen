// src/shu/select-results.ts -- before a focused run, clear the results path
// its `select` block declares; after it, read that path and count the tests
// the run EXECUTED (zheref/nen#207, the maintainer's ruling on the acceptance
// criterion of 2026-09-27, and the round-2 ruling on stale results).
//
// WHY A RUN THAT EXITED 0 IS NOT ENOUGH. A runner handed an identifier that
// matches nothing -- typed from memory, one class name off -- prints
// "Executed 0 tests" and exits 0. Read as a status code that is "ran, passed",
// and it certifies whatever the caller already believed. So a focused run's
// verdict is the exit code AND the count: zero executed is exit 6, and a
// results path that is missing, unreadable or in another format is exit 1 --
// never a pass.
//
// WHY THE PATH IS CLEARED RATHER THAN FINGERPRINTED (Nobunaga N10). A JUnit
// results DIRECTORY is read whole, one file per suite: a run that matched
// nothing and wrote one empty `new.xml` beside an earlier run's `old.xml` was
// counted as the earlier run's three tests. A digest of the directory can say
// "something changed"; it cannot say which files are this run's. Removing the
// declared path before the spawn makes the answer structural: whatever is
// there afterwards, this run wrote. The loader has already proved the path
// disjoint from every regression output; ../shu/run.ts re-proves it on the
// REAL path, and refuses a symlink, before anything here deletes.
//
// THE PARSERS ARE `nen shu test-report`'s, unchanged: one reader per format,
// so a focused run and a full report can never count the same file two ways.

import { lstatSync, rmSync } from "node:fs";
import { readTestReport } from "./test-report/parse.js";
import { TestReportError } from "./test-report/shape.js";

/** Is the declared results path itself a symlink? (Never followed, never removed.) */
export function isSymlink(absolute: string): boolean {
  return lstatSync(absolute, { throwIfNoEntry: false })?.isSymbolicLink() === true;
}

/** Remove the declared results path -- a file, or a directory recursively. */
export function clearResults(absolute: string): void {
  rmSync(absolute, { recursive: true, force: true });
}

/** The verdict on one focused run's results. */
export type ResultsVerdict =
  | { readonly ok: true; readonly executed: number }
  | { readonly ok: false; readonly why: string };

/**
 * Read the declared results and count the executed tests, or say why not.
 *
 * EXECUTED IS `total - skipped` (Nobunaga N12). A summary format states its
 * counts, and may state a total the passed/failed buckets do not fully
 * account for (expected failures, an outcome nen does not bucket) -- those
 * tests still RAN. For a format whose counts nen tallies from rows, the two
 * readings are the same number.
 *
 * `display` is the path as the declaration wrote it; every sentence quotes it.
 */
export function readSelectionResults(absolute: string, display: string, format: string): ResultsVerdict {
  if (lstatSync(absolute, { throwIfNoEntry: false }) === undefined) {
    return {
      ok: false,
      why: `the run exited 0 and left no results at '${display}' (nen cleared that path before the run). nen cannot tell how many tests it executed, so this is not a pass: check that the focused argv writes its results there`,
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
  return { ok: true, executed: counts.total - counts.skipped };
}
