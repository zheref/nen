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
// read: a report with one row per file for a whole app is a page of noise, and
// the file-level answer is the one this stack's developers already read in the
// IDE.
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
    const targets = rows
      .map((entry, index): CoverageTarget => {
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
      })
      // Sorted, like every format here: the tool's own order is its build
      // order, which changes when a target is added and makes two runs of the
      // same repository diff against each other for no reason.
      .sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    return {
      total: measure(
        counts(
          requireCount(record["coveredLines"], path, "coveredLines"),
          requireCount(record["executableLines"], path, "executableLines"),
        ),
        null,
      ),
      targets,
    };
  },
};
