// src/shu/coverage/touched.ts -- matching a coverage report's own rows against
// the files a change touched. Pure: no seam, no pack, no filesystem, no clock.
//
// `nen shu coverage --touched --base <ref>` scopes the report to the files
// `git diff --name-only <base>...HEAD` names, because that is the shape the
// policy that prompted `--threshold` actually asks about (../coverage.ts's own
// header, and zheref/nen#91 v3 q16): coverage of the WHOLE repository is not
// the same question as coverage of what a change touched, and no coverage
// report on its own can answer the second one. The git call itself lives in
// ../coverage.ts, which already reaches the seam; this module takes the
// touched-file list as a plain array and does string matching on it.
//
// TWO GRAINS, BECAUSE THE FIVE FORMATS DISAGREE ABOUT WHAT A ROW IS.
// istanbul-summary, lcov and (once ../coverage.ts has descended into
// `targets[].files[]` for it) xccov-report all name a ROW after one SOURCE
// FILE, so a touched file matches a row by plain equality. cobertura and
// jacoco name a row after a PACKAGE or namespace -- a directory of files, not
// one -- so a touched file matches such a row when the file's own path
// contains that package's segments, in order, with at least one segment left
// over afterwards for the file itself. Neither grain is asked of the
// declaration or the report: it follows from `report.format`, which
// ../coverage.ts already carries.

import { thresholdMet } from "./report.js";
import type { CoverageTarget } from "./shape.js";

export type CoverageGrain = "file" | "package";

/** Formats whose rows are packages/namespaces rather than files. */
const PACKAGE_GRAIN_FORMATS: ReadonlySet<string> = new Set(["cobertura", "jacoco"]);

/**
 * The grain a format's rows are in, for touched-matching.
 *
 * EVERY OTHER FORMAT ID DEFAULTS TO "file", xccov-report included: under
 * `--touched`, ../coverage.ts replaces xccov's own target-level rows with the
 * descended file-level ones (`targets[].files[]`) before this module ever sees
 * them, so by the time a row reaches here it already IS a file row -- exactly
 * like istanbul's or lcov's.
 */
export function grainOf(formatId: string): CoverageGrain {
  return PACKAGE_GRAIN_FORMATS.has(formatId) ? "package" : "file";
}

function toPosix(value: string): string {
  return value.replace(/\\/g, "/");
}

/**
 * A package/namespace name, split into path-like segments.
 *
 * TWO SEPARATORS TRIED, NEITHER ASSUMED. JaCoCo writes a Java package as
 * `com/example/foo` -- already slash-separated, and directly a substring of
 * the file path Java's own directory-per-package convention produces
 * (`src/main/java/com/example/foo/Bar.java`). Some Cobertura writers instead
 * state a dotted namespace (`MyApp.Services`), which is never a literal
 * directory but is still the closest fact on offer. A name with a `/` in it
 * is read as already segmented; one with none is split on `.` instead, and a
 * name with neither is one bare segment.
 */
function packageSegments(name: string): readonly string[] {
  const bySlash = toPosix(name)
    .split("/")
    .filter((part): boolean => part !== "");
  if (bySlash.length > 1) return bySlash;
  const byDot = name.split(".").filter((part): boolean => part !== "");
  return byDot.length > 0 ? byDot : bySlash;
}

/**
 * Does `file` sit under package `name` -- its segments appearing, in order,
 * as a CONTIGUOUS run somewhere in the file's own path, with at least one
 * path segment left over afterwards (the file itself)?
 *
 * "AT LEAST ONE SEGMENT LEFT OVER" IS LOAD-BEARING: without it, a package
 * named after the file's own containing directory (`packages[i] ===
 * fileSegments[fileSegments.length - 1]`, the LAST segment) would need the
 * package's run to end exactly at the file, which the `<` bound below already
 * refuses -- a package is a directory, and a directory is never the same path
 * as one of the files inside it.
 */
export function touchedByPackage(file: string, name: string): boolean {
  const segments = packageSegments(name);
  if (segments.length === 0) return false;
  const fileSegments = toPosix(file)
    .split("/")
    .filter((part): boolean => part !== "");
  for (let start = 0; start + segments.length < fileSegments.length; start++) {
    if (segments.every((segment, offset): boolean => fileSegments[start + offset] === segment)) {
      return true;
    }
  }
  return false;
}

export interface TouchedFilter {
  /** The rows a touched file matched, in the report's own (sorted) order. */
  readonly rows: readonly CoverageTarget[];
  /** Touched files that matched at least one row, in git's own order. */
  readonly matched: readonly string[];
  /** Touched files that matched none, in the same order. */
  readonly unmatched: readonly string[];
}

/**
 * Filter a report's rows down to the ones a change touched.
 *
 * `threshold`, WHEN GIVEN, IS ATTACHED PER ROW as `met` -- reusing
 * ../coverage/report.ts's own `thresholdMet`, on the COUNTS and never the
 * rounded percentage, for the reason that module's header states (a 79.996%
 * row must not read `met: true` at `--threshold 80` just because its printed
 * percentage rounds up to it). A row with no threshold given carries no `met`
 * key at all -- ../shape.ts's own rule for the field, so a plain `--touched`
 * run's rows look exactly like every other row this family prints.
 */
export function filterTouched(
  rows: readonly CoverageTarget[],
  touchedFiles: readonly string[],
  grain: CoverageGrain,
  threshold: number | null,
): TouchedFilter {
  const matchedFiles = new Set<string>();
  const kept: CoverageTarget[] = [];
  for (const row of rows) {
    const rowMatches =
      grain === "file"
        ? touchedFiles.filter((file): boolean => toPosix(file) === toPosix(row.name))
        : touchedFiles.filter((file): boolean => touchedByPackage(file, row.name));
    if (rowMatches.length === 0) continue;
    for (const file of rowMatches) matchedFiles.add(file);
    kept.push(threshold === null ? row : { ...row, met: thresholdMet(row, threshold) });
  }
  return {
    rows: kept,
    matched: touchedFiles.filter((file): boolean => matchedFiles.has(file)),
    unmatched: touchedFiles.filter((file): boolean => !matchedFiles.has(file)),
  };
}
