// src/shu/coverage/formats/xccov.ts -- the JSON an `xccov view --report --json`
// run writes for a result bundle. Pure: text in, one shape out.
//
// NO BRANCH FIGURE, AND THE KEY IS OMITTED RATHER THAN ZEROED. This tool
// measures executable lines and nothing else; a `branches: {covered: 0, total:
// 0}` in the output would read as "no branch is covered" to every caller that
// did not already know the tool, which is a finding nen would have invented.
// ../shape.ts's `measure` is what makes the key absent.
//
// THE ROWS ARE TARGETS -- the format's own word, and the only place in these
// five formats where the row unit is a build target rather than a file or a
// package. The per-file breakdown nested under each target is deliberately not
// read BY THE VERB'S OWN PARSE(): a report with one row per file for a whole
// app is a page of noise, and the file-level answer is the one this stack's
// developers already read in the IDE.
//
// `parseFiles` BELOW IS THE ONE EXCEPTION, and it exists for exactly one
// caller: `nen shu coverage --touched`. Touched-file matching needs a row PER
// FILE to compare against `git diff --name-only`'s own file list -- a target
// is a whole app or framework, and "this app was touched" is true of nearly
// every diff, which would keep every row and defeat the flag's purpose.
// ../../coverage.ts calls this only under --touched, never on the plain path,
// so `parse()`'s target-level rows are exactly what they always were.
//
// `lineCoverage` IS IGNORED, like every other format's own percentage: it is a
// FRACTION (0.71), not a percentage, and a reader who mistook one for the other
// would report a 71%-covered app as 0.71% covered. The counts are the fact.

import {
  counts,
  CoverageReportError,
  measure,
  requireCount,
  target,
  type CoverageFormat,
  type CoverageTarget,
  type ParsedCoverage,
} from "../shape.js";

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

/** The root object, and its "targets" array -- shared by both entry points below. */
function xccovRoot(text: string, path: string): { record: Readonly<Record<string, unknown>>; rows: readonly unknown[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CoverageReportError(
      `${path}: is not readable as JSON (${error instanceof Error ? error.message : String(error)}). This file was read as an xccov report because of its name or its first bytes.`,
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new CoverageReportError(
      `${path}: is JSON, but not an object. An xccov report is one object with "executableLines", "coveredLines" and a "targets" array.`,
    );
  }
  const rows = record["targets"];
  if (!Array.isArray(rows)) {
    throw new CoverageReportError(
      `${path}: has no "targets" array. That is the key this format states its per-target rows under; a report without it was written by something else, or by a step that failed halfway.`,
    );
  }
  return { record, rows };
}

function totalOf(record: Readonly<Record<string, unknown>>, path: string): ReturnType<typeof measure> {
  return measure(
    counts(
      requireCount(record["coveredLines"], path, "coveredLines"),
      requireCount(record["executableLines"], path, "executableLines"),
    ),
    null,
  );
}

/** Sorted, like every format here: see this file's header for why. */
function sorted(rows: readonly CoverageTarget[]): readonly CoverageTarget[] {
  return [...rows].sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
}

/**
 * The FILE-level rows nested under every target -- `targets[].files[]` --
 * for `--touched` only. See this file's header.
 *
 * `path` NAMES THE ROW, NEVER `name`. xccov's own `name` on a file entry is a
 * bare filename ("Store.swift"), which collides across every directory a
 * repository has; `path` is the absolute path the compiler recorded, and
 * ../../coverage.ts relativises it exactly as every other format's row name --
 * so a `--touched` row reads "Core/Store.swift", matchable against git's own
 * output, rather than a name two files in the same tree could both answer to.
 */
export function parseXccovFiles(text: string, path: string): ParsedCoverage {
  const { record, rows } = xccovRoot(text, path);
  const targets: CoverageTarget[] = [];
  rows.forEach((entry, index): void => {
    const row = asRecord(entry);
    if (row === null) {
      throw new CoverageReportError(`${path}: targets[${index}] is not an object.`);
    }
    const files = row["files"];
    if (!Array.isArray(files)) {
      // A TARGET WITH NO "files" ARRAY IS SKIPPED, NOT REFUSED. xccov omits it
      // for a target with nothing built into it (a resource bundle, an
      // aggregate target) -- exactly the rows this descent should drop anyway.
      return;
    }
    files.forEach((fileEntry, fileIndex): void => {
      const file = asRecord(fileEntry);
      if (file === null) {
        throw new CoverageReportError(`${path}: targets[${index}].files[${fileIndex}] is not an object.`);
      }
      const name = typeof file["path"] === "string" ? file["path"] : file["name"];
      if (typeof name !== "string") {
        throw new CoverageReportError(
          `${path}: targets[${index}].files[${fileIndex}] has neither "path" nor "name". A row nen cannot name is a row a reader cannot act on.`,
        );
      }
      targets.push(
        target(
          name,
          counts(
            requireCount(file["coveredLines"], path, `targets[${index}].files[${fileIndex}].coveredLines`),
            requireCount(file["executableLines"], path, `targets[${index}].files[${fileIndex}].executableLines`),
          ),
          null,
        ),
      );
    });
  });
  return { total: totalOf(record, path), targets: sorted(targets) };
}

export const XCCOV: CoverageFormat = {
  id: "xccov-report",
  label: "xccov JSON report",
  writtenAs: "the JSON an `xccov view --report --json` step writes to a file",

  namedBy(fileName: string): boolean {
    return fileName.toLowerCase().includes("xccov");
  },

  sniff(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{")) return false;
    try {
      const record = asRecord(JSON.parse(text));
      return (
        record !== null &&
        Array.isArray(record["targets"]) &&
        typeof record["executableLines"] === "number" &&
        typeof record["coveredLines"] === "number"
      );
    } catch {
      return false;
    }
  },

  parse(text: string, path: string): ParsedCoverage {
    const { record, rows } = xccovRoot(text, path);
    const targets = rows.map((entry, index): CoverageTarget => {
      const row = asRecord(entry);
      if (row === null) {
        throw new CoverageReportError(`${path}: targets[${index}] is not an object.`);
      }
      const name = row["name"];
      if (typeof name !== "string") {
        throw new CoverageReportError(
          `${path}: targets[${index}].name is absent. A row nen cannot name is a row a reader cannot act on.`,
        );
      }
      return target(
        name,
        counts(
          requireCount(row["coveredLines"], path, `targets[${index}].coveredLines`),
          requireCount(row["executableLines"], path, `targets[${index}].executableLines`),
        ),
        null,
      );
    });
    return { total: totalOf(record, path), targets: sorted(targets) };
  },
};
