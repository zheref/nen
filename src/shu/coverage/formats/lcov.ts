// src/shu/coverage/formats/lcov.ts -- the LCOV tracefile (`lcov.info`), the
// one format of the five that nearly every ecosystem can write. Pure: text in,
// one shape out.
//
// IT IS THE COMMON FALLBACK, and that is why it is here rather than only the
// four tool-specific formats: a repository whose reporter nen has never heard
// of can almost always be asked for this one, and the declaration then names
// the file. The rows are source files, which is this format's own unit.
//
// THE SUMMARY LINES ARE PREFERRED OVER COUNTING. `LF`/`LH` (lines found, lines
// hit) and `BRF`/`BRH` are the writer's own totals for the record, and a writer
// that states them has already decided what counts as an executable line.
// Counting `DA:` entries instead would silently disagree with the tool for any
// file whose reporter excludes something. Where the summary lines are absent --
// some writers omit them -- the entries are counted, which is the same fallback
// ./cobertura.ts makes for the same reason.
//
// A `BRDA` LINE ENDING IN `-` IS A BRANCH THAT WAS NEVER REACHED, not a branch
// taken zero times: the format distinguishes them and so does this reader. Both
// count towards the denominator; only a positive count is covered.

import {
  counts,
  CoverageReportError,
  sum,
  target,
  type CoverageCounts,
  type CoverageFormat,
  type CoverageMeasure,
  type CoverageTarget,
  type ParsedCoverage,
} from "../shape.js";

interface Record_ {
  linesFound: number | null;
  linesHit: number | null;
  countedLines: number;
  countedHits: number;
  branchesFound: number | null;
  branchesHit: number | null;
  countedBranches: number;
  countedBranchHits: number;
  sawBranch: boolean;
}

function blank(): Record_ {
  return {
    linesFound: null,
    linesHit: null,
    countedLines: 0,
    countedHits: 0,
    branchesFound: null,
    branchesHit: null,
    countedBranches: 0,
    countedBranchHits: 0,
    sawBranch: false,
  };
}

function numberOf(value: string | undefined): number | null {
  if (value === undefined) return null;
  const parsed = Number(value.trim());
  return Number.isFinite(parsed) ? parsed : null;
}

function linesOf(entry: Record_): CoverageCounts {
  return entry.linesFound !== null && entry.linesHit !== null
    ? counts(entry.linesHit, entry.linesFound)
    : counts(entry.countedHits, entry.countedLines);
}

function branchesOf(entry: Record_): CoverageCounts | null {
  if (entry.branchesFound !== null && entry.branchesHit !== null) {
    return counts(entry.branchesHit, entry.branchesFound);
  }
  return entry.sawBranch ? counts(entry.countedBranchHits, entry.countedBranches) : null;
}

/** Merge a second record for the same file into the first. */
function merge(into: Record_, from: Record_): void {
  // ADDED UP, NOT REPLACED. A tracefile with two records for one file was
  // written by two runs appended together; nen reports what the file says and
  // does not decide which run superseded which.
  into.linesFound = (into.linesFound ?? 0) + (from.linesFound ?? 0);
  into.linesHit = (into.linesHit ?? 0) + (from.linesHit ?? 0);
  into.countedLines += from.countedLines;
  into.countedHits += from.countedHits;
  if (from.branchesFound !== null) into.branchesFound = (into.branchesFound ?? 0) + from.branchesFound;
  if (from.branchesHit !== null) into.branchesHit = (into.branchesHit ?? 0) + from.branchesHit;
  into.countedBranches += from.countedBranches;
  into.countedBranchHits += from.countedBranchHits;
  into.sawBranch = into.sawBranch || from.sawBranch;
}

export const LCOV: CoverageFormat = {
  id: "lcov",
  label: "LCOV tracefile",
  writtenAs: "lcov.info",

  namedBy(fileName: string): boolean {
    return fileName.toLowerCase().endsWith(".info");
  },

  sniff(text: string): boolean {
    return /^SF:/m.test(text) && /^end_of_record\s*$/m.test(text);
  },

  parse(text: string, path: string): ParsedCoverage {
    const files = new Map<string, Record_>();
    let name: string | null = null;
    let current = blank();
    for (const raw of text.split("\n")) {
      const line = raw.trimEnd();
      const colon = line.indexOf(":");
      const key = colon === -1 ? line : line.slice(0, colon);
      const value = colon === -1 ? "" : line.slice(colon + 1);
      switch (key) {
        case "SF":
          name = value.trim();
          current = blank();
          break;
        case "DA": {
          const [, hits] = value.split(",");
          current.countedLines += 1;
          if ((numberOf(hits) ?? 0) > 0) current.countedHits += 1;
          break;
        }
        case "LF":
          current.linesFound = numberOf(value);
          break;
        case "LH":
          current.linesHit = numberOf(value);
          break;
        case "BRDA": {
          const taken = value.split(",")[3];
          current.sawBranch = true;
          current.countedBranches += 1;
          if (taken !== undefined && taken.trim() !== "-" && (numberOf(taken) ?? 0) > 0) {
            current.countedBranchHits += 1;
          }
          break;
        }
        case "BRF":
          current.branchesFound = numberOf(value);
          if (current.branchesFound !== null) current.sawBranch = true;
          break;
        case "BRH":
          current.branchesHit = numberOf(value);
          break;
        case "end_of_record": {
          if (name === null) break;
          const existing = files.get(name);
          if (existing === undefined) files.set(name, current);
          else merge(existing, current);
          name = null;
          break;
        }
        default:
          break;
      }
    }

    // A TRAILING RECORD WITH NO `end_of_record` IS A TRUNCATED FILE, AND IT IS
    // REFUSED RATHER THAN FLUSHED. This is the one format of the five whose
    // total is the sum of its own rows, so a record silently dropped here does
    // not make the total look wrong -- it makes it look RIGHT and smaller: one
    // complete record beside a truncated hundred-line one reports 100% for a
    // 90%-covered project, with nothing anywhere saying a row went missing.
    // Flushing the partial record is the other candidate and is worse: the
    // counts in it are whatever the writer got out before it stopped, which is
    // a number nen would then present as a measurement.
    if (name !== null) {
      throw new CoverageReportError(
        `${path}: ends mid-record at 'SF:${name}' -- there is no 'end_of_record' after it. An LCOV tracefile is one 'SF:<file>' ... 'end_of_record' block per source file, and a file that stops inside one was truncated (a killed run, a full disk, two writers on one path). nen will not add up the part that arrived: this format's total IS the sum of its rows, so a dropped row reads as a smaller project rather than as a missing one.`,
      );
    }
    if (files.size === 0) {
      throw new CoverageReportError(
        `${path}: contains no complete 'SF:' record. An LCOV tracefile is one 'SF:<file>' ... 'end_of_record' block per source file; a file with none is empty or not this format.`,
      );
    }

    const targets: readonly CoverageTarget[] = [...files.entries()]
      .map(([file, entry]): CoverageTarget => target(file, linesOf(entry), branchesOf(entry)))
      .sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    // THE TOTAL IS THE SUM OF THE ROWS, because this format has no total of its
    // own -- there is no header record and no trailer. Every other format here
    // states one; this is the one place summing is the format's answer rather
    // than a fallback.
    const total: CoverageMeasure = sum(targets);
    return { total, targets };
  },
};
