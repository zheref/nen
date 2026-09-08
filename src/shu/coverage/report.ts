// src/shu/coverage/report.ts -- the document `nen shu coverage` emits, and the
// text rendering derived from it. Pure: no seam, no pack, no filesystem.
//
// ONE DOCUMENT, WHATEVER HAPPENED. A dry run, a run whose tool failed, and a
// run that produced a report nen parsed all emit the same eight keys in the
// same order -- `total` and `report` carry null where there is nothing to say.
// The alternative, a different shape per outcome, is the thing that makes a
// `--json` consumer write a type test before it can read a field.
//
// HOW A READER TELLS A DRY RUN FROM A REAL ONE, with no `dryRun` boolean to
// disagree with the rest of the document: `exitCode === 0 && total === null`.
// Nothing else produces that pair -- a successful run whose report could not be
// read exits 1, and a run that was parsed has a total. It is the same rule
// ../run.ts's report uses for the same reason (`steps[].exitCode === null`):
// two fields that could contradict each other about whether anything ran is one
// field too many.
//
// THE THRESHOLD IS REPORTED AND NEVER ENFORCED. `met` is the answer to a
// question the caller asked; `exitCode` is the run's. zheref/nen#91's decision
// (v3 q16) is that nen never decides whether a number is good enough -- the one
// repository whose policy prompted the flag scopes its bar to the files a PR
// touched, which is a git-diff-aware judgement no coverage report can answer.
// A caller that wants a gate reads `met` and decides for itself.

import type { CoverageCounts, CoverageMeasure, CoverageTarget } from "./shape.js";

/**
 * The contract string, restated rather than imported from ../run.ts.
 *
 * ../run.ts's `contractName` produces the same string for this verb, and that
 * module imports the subprocess seam -- so importing it here would put the
 * seam on the import path of every module under this directory, which is the
 * property ../../profiles/inertness.test.ts and ../coverage.test.ts hold this
 * directory to. The two spellings are pinned against each other by a test
 * instead, the same way ../render.ts's placeholder list is pinned against the
 * pack's.
 */
export const COVERAGE_CONTRACT = "nen.shu.coverage/v0.1";

export interface CoverageThreshold {
  readonly value: number;
  /** null when there was no number to compare -- not a failure, an absence. */
  readonly met: boolean | null;
}

/** Which file was parsed, and what nen read it as. */
export interface CoverageSource {
  readonly format: string;
  /** Repo-relative, as the declaration wrote it. */
  readonly path: string;
}

/** KEY ORDER IS THE CONTRACT, and ../coverage.test.ts pins it. */
export interface CoverageReport {
  readonly contract: string;
  readonly lane: string;
  readonly stack: string;
  /** null when nothing was parsed: a dry run, or a run that failed. */
  readonly total: CoverageMeasure | null;
  readonly targets: readonly CoverageTarget[];
  readonly threshold: CoverageThreshold | null;
  readonly report: CoverageSource | null;
  /** NEN's exit code -- the executor's, never moved by the threshold. */
  readonly exitCode: number;
}

export interface AssembleRequest {
  readonly lane: string;
  readonly stack: string;
  readonly total: CoverageMeasure | null;
  readonly targets: readonly CoverageTarget[];
  readonly threshold: number | null;
  readonly report: CoverageSource | null;
  readonly exitCode: number;
}

/**
 * `total.lines.percent >= value`, or null when there is no percentage.
 *
 * `>=` AND NOT `>`: a threshold of 80 met by exactly 80 is met, which is what
 * every tool that carries one of these means by it and what a reader assumes
 * without checking.
 */
export function thresholdMet(total: CoverageMeasure | null, value: number): boolean | null {
  const percent = total?.lines.percent;
  if (percent === undefined || percent === null) return null;
  return percent >= value;
}

export function assembleCoverage(request: AssembleRequest): CoverageReport {
  return {
    contract: COVERAGE_CONTRACT,
    lane: request.lane,
    stack: request.stack,
    total: request.total,
    targets: request.targets,
    threshold:
      request.threshold === null
        ? null
        : { value: request.threshold, met: thresholdMet(request.total, request.threshold) },
    report: request.report,
    exitCode: request.exitCode,
  };
}

// ── the text rendering ──────────────────────────────────────────────────────
//
// THE LABEL COLUMN IS ../run.ts'S, RESTATED FOR THE SAME REASON THE CONTRACT
// STRING IS. These lines are printed directly under that module's, and a
// coverage block indented differently from the run block above it reads as a
// different program's output. Fifteen is the width there; ../coverage.test.ts
// pins that the two agree, so a change to either is caught rather than seen.
const LABEL_WIDTH = 15;

function labelled(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/** `82.35%` -- or `--%` where there was nothing to divide. */
export function formatPercent(counts: CoverageCounts): string {
  return counts.percent === null ? "--" : `${counts.percent.toFixed(2)}%`;
}

/** `82.35% (14/17)`. */
function formatCounts(counts: CoverageCounts): string {
  return `${formatPercent(counts)} (${counts.covered}/${counts.total})`;
}

function measureLine(measure: CoverageMeasure): string {
  return `lines ${formatCounts(measure.lines)}${
    measure.branches === undefined ? "" : `   branches ${formatCounts(measure.branches)}`
  }`;
}

function widthOf(values: readonly string[], floor: number): number {
  return values.reduce((width, value): number => Math.max(width, value.length), floor);
}

/**
 * The per-target table: numbers first in fixed columns, the name last.
 *
 * NAME LAST BECAUSE A NAME IS AS LONG AS SOMEBODY ELSE'S DIRECTORY TREE. Two of
 * the five formats name a row with a source path, and a name-first table pushes
 * every number to a different column on every row, which is the one thing a
 * column of percentages exists to prevent.
 */
function targetTable(targets: readonly CoverageTarget[]): readonly string[] {
  const anyBranches = targets.some((entry): boolean => entry.branches !== undefined);
  const lines = targets.map((entry): string => formatCounts(entry.lines));
  const branches = targets.map((entry): string =>
    entry.branches === undefined ? "--" : formatCounts(entry.branches),
  );
  const lineWidth = widthOf([...lines, "lines"], 0);
  const branchWidth = widthOf([...branches, "branches"], 0);
  const header = `  ${"lines".padEnd(lineWidth)}  ${anyBranches ? `${"branches".padEnd(branchWidth)}  ` : ""}target`;
  const rows = targets.map((entry, index): string => {
    const line = lines[index] ?? "";
    const branch = branches[index] ?? "";
    return `  ${line.padEnd(lineWidth)}  ${anyBranches ? `${branch.padEnd(branchWidth)}  ` : ""}${entry.name}`;
  });
  return [header, ...rows];
}

/**
 * The human rendering, derived from the same document `--json` prints.
 *
 * `why` IS THE ONE THING THE DOCUMENT DOES NOT CARRY: the short reason nothing
 * was parsed. Four different things produce a null total -- a dry run, a run
 * that failed, a lane with no report declared, and a report that could not be
 * read -- and the caller knows which; the document does not, because its eight
 * keys are a published contract and a fifth "reason" string would be one more
 * thing for a machine reader to branch on when `exitCode` and `report` already
 * tell it what it needs. A HUMAN gets the sentence; ../coverage.ts prints the
 * long form of it on stderr immediately after.
 */
export function renderCoverage(report: CoverageReport, why: string | null = null): readonly string[] {
  const lines: string[] = [];
  lines.push(
    labelled(
      "report",
      report.report === null
        ? "(none -- nothing was parsed)"
        : `${report.report.path}  (${report.report.format})`,
    ),
  );
  lines.push(
    labelled(
      "total",
      report.total === null ? `(nothing parsed${why === null ? "" : ` -- ${why}`})` : measureLine(report.total),
    ),
  );
  if (report.targets.length === 0) {
    if (report.total !== null) lines.push(labelled("targets", "(the report states none)"));
  } else {
    lines.push("targets:");
    for (const row of targetTable(report.targets)) lines.push(row);
  }
  if (report.threshold !== null) {
    const verdict =
      report.threshold.met === null
        ? "not compared -- there is no percentage to compare it with"
        : report.threshold.met
          ? "met"
          : "NOT met";
    lines.push(
      labelled(
        "threshold",
        `${report.threshold.value}% -- ${verdict}. This is REPORTED and never enforced: nen exits ${report.exitCode} here, and the threshold moved that by nothing.`,
      ),
    );
  }
  return lines;
}
