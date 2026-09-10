// src/shu/test-report/shape.ts -- the ONE shape every test report is parsed
// into, and the counting that produces it. Pure: no seam, no pack, no
// filesystem, no clock.
//
// WHY ONE SHAPE AND NOT ONE PER RUNNER. Three report formats disagree about
// almost everything except three facts -- what a test is called, whether it
// passed, and how long it took -- and a caller comparing two lanes of one
// repository should not have to learn which runner wrote which file. So every
// parser lands here, and a format that cannot answer a field says `null` rather
// than filling it with a zero: `durationMs` is null on a report whose runner
// states no time, because "0ms" and "this report does not time its tests" are
// different sentences and only one of them is true.
//
// THREE STATUSES AND NOT SEVEN. The formats between them spell at least eight
// outcomes -- passed, failed, error, skipped, pending, todo, disabled, expected
// failure -- and every one of them answers one of three questions a caller
// actually asks: did it run and pass, did it run and fail, or did it not run.
// An `error` (the suite blew up before the assertion) is a FAILURE, because a
// caller deciding whether to ship cannot treat "the test did not get as far as
// failing" as anything else; a `pending`/`todo`/`disabled` is SKIPPED, because
// nothing was proved either way. Each parser states its own mapping and refuses
// a word it does not know rather than guessing which of the three it meant.
//
// THE COUNTS ARE THE ROWS' WHERE THERE ARE ROWS, AND THE REPORT'S WHERE THERE
// ARE NOT. Two of the three formats list every test, so `tally` counts what was
// parsed and the four numbers cannot disagree with `tests[]`. The third states
// its totals and lists only its failures, so `statedCounts` reads the numbers it
// states and refuses a set that cannot be true. Which of the two produced a
// document's counts is written in this file and in each format module, never
// inferred by a reader from the length of `tests[]`.

/** What a report says happened to one test. Three answers, never more. */
export type TestStatus = "passed" | "failed" | "skipped";

/**
 * One test, as every format is parsed into.
 *
 * KEY ORDER IS PART OF THE CONTRACT (`name`, `suite`, `status`, `durationMs`)
 * and ../test-report.test.ts pins it: `--json`'s reader is a script, and a
 * field that moves is a golden file that breaks for no reason.
 */
export interface TestCase {
  readonly name: string;
  /** The class, file or target this test is written in. Null when unstated. */
  readonly suite: string | null;
  readonly status: TestStatus;
  /** Milliseconds, to two decimals. Null when the report states no time. */
  readonly durationMs: number | null;
}

export interface TestCounts {
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly total: number;
}

/** What a parser returns: the rows it read, and the counts for them. */
export interface ParsedTests {
  readonly tests: readonly TestCase[];
  readonly counts: TestCounts;
}

/**
 * One report format nen can read.
 *
 * `namedBy` AND `sniff` ARE BOTH REQUIRED, AND NEITHER DECIDES ALONE, for the
 * reason ../coverage/shape.ts's counterpart states: a file name is a hint a
 * repository chose (two of these three are conventionally `.json`) and the
 * content is the fact. ../test-report/parse.ts tries the name first because
 * that is the cheap ordering, and confirms every candidate against the bytes
 * before parsing them.
 */
export interface TestReportFormat {
  /** The id `--json`'s `report.format` carries. */
  readonly id: string;
  /** What it is, for a human reading a refusal. */
  readonly label: string;
  /** What it is conventionally written as, for the refusal. */
  readonly writtenAs: string;
  /** A name-shaped hint. Never a verdict on its own. */
  namedBy(fileName: string): boolean;
  /** Does this text look like this format? The verdict. */
  sniff(text: string): boolean;
  /** Text in, one shape out. Throws `TestReportError` on a report it cannot read. */
  parse(text: string, path: string): ParsedTests;
}

/**
 * A report nen cannot read, with the path in the message.
 *
 * ITS OWN CLASS, CARRYING NO EXIT CODE, exactly as ../coverage/shape.ts's
 * `CoverageReportError` does and for its reason: the parsers know what is wrong
 * with a file; they do not know what a CLI does about it, and a module that
 * threw `ShuRefusal` would be a parser with an opinion about exit codes.
 */
export class TestReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TestReportError";
  }
}

/** The row order a rendering puts failures first in. Lower sorts earlier. */
const SEVERITY: Readonly<Record<TestStatus, number>> = { failed: 0, skipped: 1, passed: 2 };

/**
 * The worse of two outcomes for one test.
 *
 * A `<testcase>` can carry a `<failure>` AND a `<skipped>` -- a runner that
 * skipped a test after a failing setup writes both -- and a reader that took
 * the last child would report a failure as a skip on a file whose elements
 * happen to be in the other order. The worse one is the true one.
 */
export function worse(left: TestStatus, right: TestStatus): TestStatus {
  return SEVERITY[left] <= SEVERITY[right] ? left : right;
}

/** Failures first, then skips, then passes -- stable within each group. */
export function failuresFirst(tests: readonly TestCase[]): readonly TestCase[] {
  return [...tests].sort((left, right): number => SEVERITY[left.status] - SEVERITY[right.status]);
}

/**
 * The counts of a list of rows.
 *
 * USED BY THE TWO FORMATS THAT LIST EVERY TEST. `total` is the number of rows
 * and nothing else: a format that also states a total of its own is not asked
 * for it here, because two numbers that could disagree about how many tests
 * there were is one number too many, and the rows are the ones a caller can go
 * and read.
 */
export function tally(tests: readonly TestCase[]): TestCounts {
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const test of tests) {
    if (test.status === "passed") passed += 1;
    else if (test.status === "failed") failed += 1;
    else skipped += 1;
  }
  return { passed, failed, skipped, total: tests.length };
}

/**
 * The counts a report STATES, refused rather than repaired.
 *
 * MORE TESTS ACCOUNTED FOR THAN THERE WERE IS A REFUSAL, not a total nen
 * quietly raises. This is ../coverage/shape.ts's "more covered than there is to
 * cover" rule applied to the one format here that states its totals instead of
 * listing its rows: the three figures and the total came from four places in
 * the file, and a set of them that cannot all be true took them from a merged
 * report, a half-written one, or a template with a stale figure in it.
 * Reporting the sum would carry that damage into a document as though it were a
 * measurement; clamping the total up to the sum would hide it entirely.
 *
 * FEWER IS NOT A REFUSAL, and the asymmetry is the honest one: a run with
 * expected failures, or one whose total counts a test the three buckets do not,
 * legitimately accounts for fewer tests than it ran. nen reports both numbers
 * and invents neither.
 */
export function statedCounts(
  passed: number,
  failed: number,
  skipped: number,
  total: number,
  path: string,
): TestCounts {
  if (passed + failed + skipped > total) {
    throw new TestReportError(
      `${path}: states ${passed} passed, ${failed} failed and ${skipped} skipped out of ${total} tests, which accounts for more tests than it says it ran. nen neither raises the total to fit nor divides the difference: the four figures came from different places, and a report that says so is a report to go and look at.`,
    );
  }
  return { passed, failed, skipped, total };
}

/**
 * A number a report stated, refused rather than coerced.
 *
 * A COUNT THAT IS NOT A NUMBER IS A MALFORMED REPORT, not a zero -- the
 * argument is ../coverage/shape.ts's `requireCount`, verbatim, and it is
 * restated rather than imported because a test report and a coverage report
 * share no other vocabulary and an import edge between the two parse trees
 * would be there to save nine lines.
 */
export function requireCount(value: unknown, path: string, pointer: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new TestReportError(
      `${path}: ${pointer} is ${describe(value)}, and a test count is a non-negative whole number. nen reports what a report states and never coerces a count -- a total assembled out of guesses is worse than no total.`,
    );
  }
  return value;
}

/** A name a report stated, refused rather than filled in. */
export function requireName(value: unknown, path: string, pointer: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TestReportError(
      `${path}: ${pointer} is ${describe(value)}, and a test's name is the one thing a row must carry. nen will not number an anonymous test: a row nobody can look up is not a finding.`,
    );
  }
  return value;
}

/** A suite name a report stated, or null where it states none. */
export function optionalName(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== "" ? value : null;
}

/**
 * The value a refusal quotes back, including the ones JSON cannot spell.
 *
 * `JSON.stringify(Infinity)` IS THE STRING `"null"`, and so is `NaN`'s, so a
 * message built out of it would tell a reader whose figure overflowed on the
 * way in that it was `null` -- a different mistake with a different fix.
 */
function describe(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}

/**
 * Milliseconds, to two decimals, or null.
 *
 * TWO DECIMALS RATHER THAN THE FLOAT, for ../coverage/shape.ts's reason: a
 * document carrying `12.999999999999998` is a golden file that differs the day
 * a platform rounds the last bit differently, and no reader of a test report
 * needs a finer figure than a hundredth of a millisecond.
 *
 * A NEGATIVE OR NON-FINITE TIME IS AN ABSENCE, NOT A REFUSAL. A clock that went
 * backwards is a fact about the machine that ran the suite rather than about
 * this report's ability to say what passed, and refusing the whole file over it
 * would throw away every row to protect one field that is already optional.
 */
export function milliseconds(value: number | null): number | null {
  if (value === null || !Number.isFinite(value) || value < 0) return null;
  return Math.round(value * 100) / 100;
}

/** Seconds as a report states them, in milliseconds. */
export function millisecondsFromSeconds(value: number | null): number | null {
  return value === null ? null : milliseconds(value * 1000);
}

/**
 * Several parsed files as one report.
 *
 * ONE DIRECTORY OF XML IS ONE REPORT, and this is where that becomes true: a
 * runner that writes a file per suite has not written several reports, it has
 * written one across several files, and a caller asking "did the suite pass"
 * wants the run's numbers rather than the last file's. Order is the order the
 * files were read, which ../parse.ts fixes by sorting the paths.
 */
export function mergeParsed(parts: readonly ParsedTests[]): ParsedTests {
  const tests = parts.flatMap((part): readonly TestCase[] => part.tests);
  return { tests, counts: tally(tests) };
}
