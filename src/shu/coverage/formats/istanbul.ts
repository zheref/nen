// src/shu/coverage/formats/istanbul.ts -- the JSON summary the Istanbul family
// of reporters writes (`coverage-summary.json`). Pure: text in, one shape out.
//
// THE ROWS ARE FILES, AND THAT IS THE FORMAT'S OWN UNIT rather than a choice
// made here. This document is a map with one reserved key -- `total` -- and one
// entry per source file; there is no package, module or target level in it at
// all. A reader wanting per-package rows out of a workspace runs the verb per
// package, which is what the declarations in the field already do (one step per
// workspace member), and each step overwrites or extends its own report.
//
// THE `pct` THE FILE CARRIES IS IGNORED. ../shape.ts's header says why: five
// formats, five rounding conventions, one divide here.

import {
  counts,
  CoverageReportError,
  measure,
  requireCount,
  target,
  type CoverageCounts,
  type CoverageFormat,
  type CoverageMeasure,
  type ParsedCoverage,
} from "../shape.js";

const SUMMARY_FILE = "coverage-summary.json";

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readJson(text: string, path: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new CoverageReportError(
      `${path}: is not readable as JSON (${error instanceof Error ? error.message : String(error)}). This file was read as an Istanbul JSON summary because of its name or its first bytes.`,
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new CoverageReportError(
      `${path}: is JSON, but not an object. An Istanbul summary is a map of "total" plus one entry per file.`,
    );
  }
  return record;
}

/** One `{lines, branches, ...}` block, of which two keys are read. */
function counterOf(value: unknown, path: string, pointer: string): CoverageMeasure {
  const record = asRecord(value);
  if (record === null) {
    throw new CoverageReportError(
      `${path}: ${pointer} is not an object. Each entry carries a "lines" block, and usually a "branches" one.`,
    );
  }
  const lines = asRecord(record["lines"]);
  if (lines === null) {
    throw new CoverageReportError(
      `${path}: ${pointer}.lines is absent. Line coverage is the one figure every format nen reads must carry -- a report without it is a report about nothing nen can compare.`,
    );
  }
  const branches = asRecord(record["branches"]);
  return measure(
    counts(
      requireCount(lines["covered"], path, `${pointer}.lines.covered`),
      requireCount(lines["total"], path, `${pointer}.lines.total`),
    ),
    branches === null
      ? null
      : counts(
          requireCount(branches["covered"], path, `${pointer}.branches.covered`),
          requireCount(branches["total"], path, `${pointer}.branches.total`),
        ),
  );
}

function looksLikeSummary(record: Readonly<Record<string, unknown>>): boolean {
  const total = asRecord(record["total"]);
  if (total === null) return false;
  const lines = asRecord(total["lines"]);
  return lines !== null && typeof lines["covered"] === "number" && typeof lines["total"] === "number";
}

export const ISTANBUL: CoverageFormat = {
  id: "istanbul-summary",
  label: "Istanbul JSON summary",
  writtenAs: SUMMARY_FILE,

  namedBy(fileName: string): boolean {
    return fileName === SUMMARY_FILE || fileName.endsWith(`-${SUMMARY_FILE}`);
  },

  sniff(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{")) return false;
    try {
      const record = asRecord(JSON.parse(text));
      return record !== null && looksLikeSummary(record);
    } catch {
      return false;
    }
  },

  parse(text: string, path: string): ParsedCoverage {
    const record = readJson(text, path);
    if (record["total"] === undefined) {
      throw new CoverageReportError(
        `${path}: has no "total" entry. An Istanbul summary states the run's total under that key; a file with per-file entries and no total is a partial write, and nen will not add the rows up and call the result the tool's answer.`,
      );
    }
    const targets = Object.keys(record)
      .filter((key): boolean => key !== "total")
      .sort()
      .map((key): ReturnType<typeof target> => {
        const entry = counterOf(record[key], path, key);
        const branches: CoverageCounts | null = entry.branches ?? null;
        return target(key, entry.lines, branches);
      });
    return { total: counterOf(record["total"], path, "total"), targets };
  },
};
