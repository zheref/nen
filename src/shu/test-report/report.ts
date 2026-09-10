// src/shu/test-report/report.ts -- the document `nen shu test-report` emits,
// and the text rendering derived from it. Pure: no seam, no pack, no filesystem.
//
// ONE DOCUMENT, WHATEVER HAPPENED. A dry run, a read that found no report, and
// a run whose results were parsed all emit the same ten keys in the same order
// -- `report` and the four counts carry null where there is nothing to say. The
// alternative, a different shape per outcome, is the thing that makes a `--json`
// consumer write a type test before it can read a field.
//
// HOW A READER TELLS "NOTHING WAS PARSED" FROM "NOTHING RAN", with no `dryRun`
// boolean to disagree with the rest of the document: `total === null` says
// nothing was parsed, and `exitCode` says what nen thought of that. It is the
// same rule ../coverage/report.ts uses, for the same reason -- two fields that
// could contradict each other about whether anything ran is one field too many.
//
// THE VERDICT IS THE RUN'S AND NEVER THIS DOCUMENT'S. `failed: 3` does not make
// `exitCode` non-zero, and `failed: 0` does not make it zero: the exit code
// belongs to the command the lane declared, and under `--from-artifacts`, where
// nothing ran at all, it is about the READ. A caller that wants a gate reads
// `failed` and decides for itself -- which is the same line ../coverage/report
// .ts draws under `--threshold`, and it is drawn here for a sharper reason: the
// one workflow that asks for this document asks for it precisely when the suite
// is red, and a verb that refused to report on a red suite would be useless in
// the case it exists for.

import { failuresFirst, type TestCase, type TestCounts } from "./shape.js";

/**
 * The contract string, restated rather than imported from ../run.ts.
 *
 * ../run.ts's `contractName` produces `nen.shu.<verb>/v0.1` for a verb, and
 * that module imports the subprocess seam -- so importing it here would put the
 * seam on the import path of every module under this directory. The two
 * spellings are pinned against each other by a test instead, exactly as
 * ../coverage/report.ts's is.
 */
export const TEST_REPORT_CONTRACT = "nen.shu.test-report/v0.1";

/** Which artifact was parsed, and what nen read it as. */
export interface TestReportSource {
  readonly format: string;
  /** Repo-relative, as the declaration wrote it. */
  readonly path: string;
}

/** KEY ORDER IS THE CONTRACT, and ../test-report.test.ts pins it. */
export interface TestReportDocument {
  readonly contract: string;
  readonly lane: string;
  readonly stack: string;
  /** The artifact nen actually parsed, or null when it parsed none. */
  readonly report: TestReportSource | null;
  /**
   * Every test the report listed, IN THE REPORT'S OWN ORDER.
   *
   * NOT SORTED, unlike the table below it. A machine reader comparing two runs
   * of one suite wants the order the runner produced, which carries information
   * a re-sort destroys (the file order, the shard order); a HUMAN scanning
   * terminal output wants the failures at the top. So the document keeps one
   * order and `renderTestReport` prints another, rather than both settling for
   * a compromise that serves neither.
   *
   * IT IS NOT ALWAYS THE WHOLE SUITE. One format states its totals and lists
   * only its failures (../test-report/formats/xcresult.ts), so `tests.length`
   * is not another spelling of `total` and a reader must not treat it as one.
   */
  readonly tests: readonly TestCase[];
  /** null on every path where nothing was parsed -- a dry run, a missing report. */
  readonly passed: number | null;
  readonly failed: number | null;
  readonly skipped: number | null;
  readonly total: number | null;
  /**
   * NEN's exit code, and the failures never move it.
   *
   * It is the RUN's where there was a run: a suite that failed exits 1 with its
   * failures parsed and reported, because that report is the reason anybody
   * asked. Where the run succeeded and the report is missing, unreadable or
   * undeclared, this verb's SECOND step answers 1 -- the same class of answer
   * this CLI returns 1 for everywhere else. Under `--from-artifacts` nothing
   * ran, so it is 0 for a read that worked however red the suite was.
   */
  readonly exitCode: number;
}

export interface AssembleRequest {
  readonly lane: string;
  readonly stack: string;
  readonly report: TestReportSource | null;
  readonly tests: readonly TestCase[];
  /** null when nothing was parsed. */
  readonly counts: TestCounts | null;
  readonly exitCode: number;
}

export function assembleTestReport(request: AssembleRequest): TestReportDocument {
  return {
    contract: TEST_REPORT_CONTRACT,
    lane: request.lane,
    stack: request.stack,
    report: request.report,
    tests: request.tests,
    passed: request.counts?.passed ?? null,
    failed: request.counts?.failed ?? null,
    skipped: request.counts?.skipped ?? null,
    total: request.counts?.total ?? null,
    exitCode: request.exitCode,
  };
}

// ── the text rendering ──────────────────────────────────────────────────────
//
// THE LABEL COLUMN IS ../run.ts'S, RESTATED FOR THE SAME REASON THE CONTRACT
// STRING IS. These lines are printed directly under that module's, and a block
// indented differently from the run block above it reads as a different
// program's output. Fifteen is the width there; ../test-report.test.ts pins
// that the two agree.
const LABEL_WIDTH = 15;

function labelled(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * The two lines `--from-artifacts` prints instead of an executor report.
 *
 * THERE IS NO RUN TO REPORT ON, so the lane and the stack -- which every other
 * form of this verb reads off ../run.ts's report -- have to be said here, and
 * the second line says plainly what a reader of a report with no command above
 * it needs to know: nothing was executed, so the file parsed below is whatever
 * the last run to write it left there.
 */
export function renderReadOnly(lane: string, stack: string): readonly string[] {
  return [
    labelled("lane", `${lane}  (${stack})`),
    labelled(
      "read",
      "--from-artifacts -- nothing was run. The report below is whatever is on disk, written by whichever run last wrote it; nen cannot tell how old it is.",
    ),
  ];
}

/** `12.00ms`, or `--` where the report timed nothing. */
export function formatDuration(durationMs: number | null): string {
  return durationMs === null ? "--" : `${durationMs.toFixed(2)}ms`;
}

/** `12 tests -- 10 passed, 1 failed, 1 skipped`. */
export function formatTotals(counts: TestCounts): string {
  return `${counts.total} test${counts.total === 1 ? "" : "s"} -- ${counts.passed} passed, ${counts.failed} failed, ${counts.skipped} skipped`;
}

function widthOf(values: readonly string[], floor: number): number {
  return values.reduce((width, value): number => Math.max(width, value.length), floor);
}

function describe(test: TestCase): string {
  return test.suite === null ? test.name : `${test.suite} > ${test.name}`;
}

/**
 * The per-test table: the outcome first, then the time, then the name.
 *
 * FAILURES FIRST, and that is the whole design of this rendering. Everything
 * else on screen is a number; the rows are what somebody is going to act on,
 * and a red row eleven hundred lines down a passing suite is a row nobody
 * reads. The document keeps the report's own order (see `tests` above).
 *
 * NAME LAST BECAUSE A NAME IS AS LONG AS SOMEBODY ELSE'S DIRECTORY TREE --
 * ../coverage/report.ts's argument, and the same one applies: two of the three
 * formats name a suite with a file path, and a name-first table pushes every
 * outcome to a different column on every row.
 */
function testTable(tests: readonly TestCase[]): readonly string[] {
  const rows = failuresFirst(tests);
  const outcomes = rows.map((test): string => (test.status === "failed" ? "FAILED" : test.status));
  const durations = rows.map((test): string => formatDuration(test.durationMs));
  const outcomeWidth = widthOf(outcomes, "outcome".length);
  const durationWidth = widthOf(durations, "time".length);
  const header = `  ${"outcome".padEnd(outcomeWidth)}  ${"time".padEnd(durationWidth)}  test`;
  return [
    header,
    ...rows.map((test, index): string => {
      const outcome = outcomes[index] ?? "";
      const duration = durations[index] ?? "";
      return `  ${outcome.padEnd(outcomeWidth)}  ${duration.padEnd(durationWidth)}  ${describe(test)}`;
    }),
  ];
}

/**
 * The human rendering, derived from the same document `--json` prints.
 *
 * `why` IS THE ONE THING THE DOCUMENT DOES NOT CARRY: the short reason nothing
 * was parsed. Four different things produce null counts -- a dry run, a run
 * that started nothing, a lane with no readable artifact, and a report that
 * could not be read -- and the caller knows which; the document does not,
 * because its ten keys are a published contract and an eleventh "reason" string
 * would be one more thing for a machine reader to branch on. A HUMAN gets the
 * sentence; ../test-report.ts prints the long form of it on stderr.
 */
export function renderTestReport(
  report: TestReportDocument,
  why: string | null = null,
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
  const counts =
    report.total === null
      ? null
      : {
          passed: report.passed ?? 0,
          failed: report.failed ?? 0,
          skipped: report.skipped ?? 0,
          total: report.total,
        };
  lines.push(
    labelled(
      "totals",
      counts === null ? `(nothing parsed${why === null ? "" : ` -- ${why}`})` : formatTotals(counts),
    ),
  );
  if (report.tests.length === 0) {
    if (counts !== null) lines.push(labelled("tests", "(the report lists none)"));
  } else {
    lines.push("tests:");
    for (const row of testTable(report.tests)) lines.push(row);
    // THE ONE PLACE THE TWO NUMBERS CAN DISAGREE, said out loud rather than
    // left for a reader to notice. A summary format lists its failures and
    // counts the whole suite, so a table of three rows under a total of two
    // hundred is correct and looks like a bug.
    if (counts !== null && report.tests.length !== counts.total) {
      lines.push(
        labelled(
          "rows",
          `${report.tests.length} of ${counts.total} -- this report states its totals and lists only the tests above. The counts are its own.`,
        ),
      );
    }
  }
  return lines;
}
