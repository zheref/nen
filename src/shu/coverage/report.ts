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

/**
 * `--touched --base <ref>`'s own account of what it did, or null without it.
 *
 * `files` IS EVERYTHING `git diff --name-only <base>...HEAD` NAMED, whether or
 * not a row matched it -- `matched` and `unmatched` partition that same list,
 * never a different one, so `matched.length + unmatched.length ===
 * files.length` always holds. A file this repository's coverage tool never
 * measures at all (a config file, a fixture, a doc) is `unmatched`, and that is
 * a finding rather than a bug: it is precisely the set a reviewer of a
 * `--touched` run would otherwise have to work out by hand.
 */
export interface TouchedReport {
  readonly base: string;
  readonly files: readonly string[];
  readonly matched: readonly string[];
  readonly unmatched: readonly string[];
}

/**
 * `nen/workflow.json`'s coverage ladder, restated here rather than imported.
 *
 * RESTATED FOR THE SAME REASON `COVERAGE_CONTRACT` IS: ../coverage/ladder.ts
 * imports `thresholdMet` from THIS file, and importing ladder.ts back would be
 * a cycle. The two shapes are structural rather than pinned by a test, because
 * this one carries an extra field (`source`) ladder.ts's own `CoverageLadder`
 * does not: ../coverage.ts is the one place that reads both and is where a
 * drift between them would first fail to typecheck.
 */
export interface CoverageLadderReport {
  readonly minimum: number;
  readonly recommended: number;
  readonly ideal: number;
  /** Where nen read it from. Currently always `nen/workflow.json`. */
  readonly source: string;
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
  /**
   * NEN's exit code, and the threshold never moves it.
   *
   * It is not simply the executor's: a run that exited 0 and whose report is
   * missing, unreadable or undeclared is a 1 this verb's SECOND step decides
   * (../coverage.ts's `parseAfterRun`), which is the same class of answer this
   * CLI returns 1 for everywhere else. What it never is, in either direction,
   * is a verdict about the number: see this file's header.
   */
  readonly exitCode: number;
  /** null without `--touched`. APPENDED rather than inserted, so every reader who indexed the first eight keys by position is unaffected. */
  readonly touched: TouchedReport | null;
  /**
   * `nen/workflow.json`'s coverage ladder, or null.
   *
   * ONLY EVER NON-NULL UNDER `--touched` WITH `--threshold` ABSENT AND A
   * `workflow.json` DECLARING ONE -- ../coverage/ladder.ts's own header says
   * why the scope is `--touched` and not a plain run. Present, it means every
   * touched row also carries its own `band`; absent, `--touched`'s rows are
   * exactly what they were before this field existed.
   */
  readonly ladder: CoverageLadderReport | null;
}

export interface AssembleRequest {
  readonly lane: string;
  readonly stack: string;
  readonly total: CoverageMeasure | null;
  readonly targets: readonly CoverageTarget[];
  readonly threshold: number | null;
  readonly report: CoverageSource | null;
  readonly exitCode: number;
  readonly touched: TouchedReport | null;
  readonly ladder: CoverageLadderReport | null;
}

/**
 * Whether the line coverage cleared the bar, or null when there is no ratio.
 *
 * COMPARED ON THE COUNTS, NOT ON THE PERCENTAGE THE TABLE PRINTS. `percent` is
 * rounded to two decimals for display (../coverage/shape.ts says why), and a
 * comparison against a rounded number answers a different question from the one
 * the caller asked: 19999 of 25000 lines is 79.996%, which rounds to 80.00 and
 * would report `met: true` at `--threshold 80`. A caller that gates its own
 * pipeline on `met` would then fail open on every project within half a
 * rounding step of its bar -- the one direction this flag must never be wrong
 * in, because a threshold that quietly says yes is indistinguishable from a
 * threshold nobody set. `covered * 100 >= value * total` is the same comparison
 * with no division and no rounding in it at all.
 *
 * `>=` AND NOT `>`: a threshold of 80 met by exactly 80 is met, which is what
 * every tool that carries one of these means by it and what a reader assumes
 * without checking.
 */
export function thresholdMet(total: CoverageMeasure | null, value: number): boolean | null {
  if (total === null || total.lines.total <= 0) return null;
  return total.lines.covered * 100 >= value * total.lines.total;
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
    touched: request.touched,
    ladder: request.ladder,
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
  // `met` AND `band` ARE COLUMNS ONLY WHEN AT LEAST ONE ROW CARRIES ONE --
  // which is exactly `--touched` given a `--threshold` (`met`) or given a
  // `nen/workflow.json` ladder and NO `--threshold` (`band`), per ../shape.ts's
  // own rule for both keys. The two never co-occur on one run in practice
  // (../coverage/ladder.ts is read only when `--threshold` was NOT given), but
  // nothing here assumes that -- a plain `nen shu coverage` run's table is
  // simply byte-identical to what it always printed, either way.
  const anyMet = targets.some((entry): boolean => entry.met !== undefined);
  const anyBand = targets.some((entry): boolean => entry.band !== undefined);
  const lines = targets.map((entry): string => formatCounts(entry.lines));
  const branches = targets.map((entry): string =>
    entry.branches === undefined ? "--" : formatCounts(entry.branches),
  );
  const met = targets.map((entry): string =>
    entry.met === undefined ? "" : entry.met === null ? "--" : entry.met ? "met" : "NOT met",
  );
  const band = targets.map((entry): string => (entry.band === undefined ? "" : (entry.band ?? "--")));
  const lineWidth = widthOf([...lines, "lines"], 0);
  const branchWidth = widthOf([...branches, "branches"], 0);
  const metWidth = widthOf([...met, "met"], 0);
  const bandWidth = widthOf([...band, "band"], 0);
  const header = `  ${"lines".padEnd(lineWidth)}  ${anyBranches ? `${"branches".padEnd(branchWidth)}  ` : ""}${anyMet ? `${"met".padEnd(metWidth)}  ` : ""}${anyBand ? `${"band".padEnd(bandWidth)}  ` : ""}target`;
  const rows = targets.map((entry, index): string => {
    const line = lines[index] ?? "";
    const branch = branches[index] ?? "";
    const metColumn = met[index] ?? "";
    const bandColumn = band[index] ?? "";
    return `  ${line.padEnd(lineWidth)}  ${anyBranches ? `${branch.padEnd(branchWidth)}  ` : ""}${anyMet ? `${metColumn.padEnd(metWidth)}  ` : ""}${anyBand ? `${bandColumn.padEnd(bandWidth)}  ` : ""}${entry.name}`;
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
 *
 * `touchedGrain` IS THE OTHER THING THE DOCUMENT DOES NOT CARRY, on purpose:
 * ../coverage.ts's brief scopes `--json`'s `touched` key to exactly `{ base,
 * files, matched, unmatched }`, and "these rows are packages, not files" is a
 * fact about the FORMAT (`report.report.format`) that a machine reader already
 * has -- ../coverage/touched.ts's `grainOf` derives it from the same field.
 * Only the human sentence needs the derived word, so only the human sentence
 * takes it as a parameter, the same way `why` already does. `null` prints no
 * such note -- the plain non-`--touched` path, and any path where the grain is
 * "file" (identity is not worth narrating).
 */
export function renderCoverage(
  report: CoverageReport,
  why: string | null = null,
  touchedGrain: "file" | "package" | null = null,
): readonly string[] {
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
  } else if (report.ladder !== null) {
    // NO --threshold, AND A LADDER: this is the ONLY case that prints one, and
    // never both -- see ../coverage/ladder.ts's own header for why it is read
    // only when --threshold was not given.
    const l = report.ladder;
    lines.push(
      labelled(
        "ladder",
        `${l.source} -- minimum ${l.minimum}% / recommended ${l.recommended}% / ideal ${l.ideal}%. REPORTED per row as 'band', and never enforced: nen exits ${report.exitCode} here, whatever the bands say.`,
      ),
    );
  }
  if (report.touched !== null) {
    const t = report.touched;
    const grainNote = touchedGrain === "package" ? " -- rows matched BY PACKAGE, not by file" : "";
    lines.push(
      labelled(
        "touched",
        `base ${t.base}: ${t.files.length} file${t.files.length === 1 ? "" : "s"} (${t.matched.length} matched, ${t.unmatched.length} unmatched)${grainNote}`,
      ),
    );
    if (t.unmatched.length > 0) {
      lines.push(`  unmatched: ${t.unmatched.join(", ")}`);
    }
  }
  return lines;
}
