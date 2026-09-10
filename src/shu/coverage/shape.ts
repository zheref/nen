// src/shu/coverage/shape.ts -- the ONE shape every coverage report is parsed
// into, and the arithmetic that produces it. Pure: no seam, no pack, no
// filesystem, no clock.
//
// WHY ONE SHAPE AND NOT ONE PER TOOL. Five report formats disagree about
// everything except two facts -- how many lines could have run, and how many
// did -- and a caller comparing two lanes of one repository should not have to
// learn which tool wrote which file. So every parser lands here, and a format
// that cannot answer a field OMITS it rather than filling it with a zero:
// `branches` is absent on a report whose tool has no branch figure, because
// "0 of 0 branches" and "this tool does not measure branches" are different
// sentences and only one of them is true.
//
// `percent` IS COMPUTED HERE, FROM `covered` AND `total`, AND NEVER READ OUT OF
// THE REPORT. Three of the five formats carry a percentage of their own
// (`pct`, `line-rate`, `lineCoverage`), each rounded differently, one of them
// as a fraction rather than a percentage -- so trusting the file would make
// `nen shu coverage` report a different number for the same coverage depending
// on which tool wrote it. One divide, one rounding rule, five formats.
//
// A REPORT WITH NOTHING IN IT HAS NO PERCENTAGE. `0 / 0` is not 100% covered
// and it is not 0% covered: it is a report about no code, and nen says `null`
// rather than picking whichever of the two flatters the caller. The threshold
// comparison inherits that -- `met` is `null` when there is no number to
// compare, the same value it carries when nothing was parsed at all.

/** Lines (or branches): how many there were, how many ran, and the ratio. */
export interface CoverageCounts {
  readonly covered: number;
  readonly total: number;
  /** `covered / total`, as a percentage rounded to two decimals. Null for 0/0. */
  readonly percent: number | null;
}

/**
 * One measured unit, with `branches` present only when the tool measures them.
 *
 * KEY ORDER IS PART OF THE CONTRACT (`lines` before `branches`) and
 * ../coverage.test.ts pins it: `--json`'s reader is a script, and a field that
 * moves is a golden file that breaks for no reason.
 */
export interface CoverageMeasure {
  readonly lines: CoverageCounts;
  readonly branches?: CoverageCounts;
}

/** One row beneath the total: a package, a target, a file -- the format's unit. */
export interface CoverageTarget extends CoverageMeasure {
  readonly name: string;
  /**
   * Whether THIS ROW cleared `--threshold`, under `--touched` only.
   *
   * ABSENT rather than `undefined`-valued everywhere else: every parser above
   * constructs a row with no such key at all, and ../touched.ts is the one
   * place that adds it -- by spreading a threshold's own `met` onto a row it
   * has decided a touched file belongs to. A row from a plain (non-`--touched`)
   * `nen shu coverage` therefore never carries this key, which is what keeps
   * ../coverage.test.ts's "keys of a row" pin unchanged for that path.
   */
  readonly met?: boolean | null;
  /**
   * Which rung of `nen/workflow.json`'s coverage ladder this row is on, under
   * `--touched` when `--threshold` was NOT given and that file declares one.
   *
   * MUTUALLY EXCLUSIVE WITH `met`, IN PRACTICE: `met` answers an EXPLICIT
   * `--threshold`, `band` is the ladder's own stand-in for a repository that
   * declared a policy instead of typing a number on the command line, and
   * ../ladder.ts is the one place that adds it -- absent (not merely
   * `undefined`-valued) on every row this whole family already produced,
   * exactly as `met` is.
   */
  readonly band?: CoverageBand | null;
}

/** `nen/workflow.json`'s four rungs, in ascending order. */
export type CoverageBand = "under-minimum" | "minimum" | "recommended" | "ideal";

/** What a parser returns: the total, and the rows beneath it. */
export interface ParsedCoverage {
  readonly total: CoverageMeasure;
  readonly targets: readonly CoverageTarget[];
}

/**
 * One report format nen can read.
 *
 * `namedBy` AND `sniff` ARE BOTH REQUIRED, AND NEITHER DECIDES ALONE. A file
 * name is a hint a repository chose (`coverage.xml` is written by at least two
 * of these tools) and the content is the fact; ../parse.ts tries the name first
 * because that is the cheap ordering, and confirms every candidate against the
 * bytes before parsing them.
 */
export interface CoverageFormat {
  /** The id `--json`'s `report.format` carries. */
  readonly id: string;
  /** What it is, for a human reading a refusal. */
  readonly label: string;
  /** The file names this format is conventionally written to, for the refusal. */
  readonly writtenAs: string;
  /** A name-shaped hint. Never a verdict on its own. */
  namedBy(fileName: string): boolean;
  /** Does this text look like this format? The verdict. */
  sniff(text: string): boolean;
  /** Text in, one shape out. Throws `CoverageReportError` on a report it cannot read. */
  parse(text: string, path: string): ParsedCoverage;
}

/**
 * A report nen cannot read, with the path in the message.
 *
 * ITS OWN CLASS, CARRYING NO EXIT CODE. The parsers know what is wrong with a
 * file; they do not know what a CLI does about it, and a module that threw
 * `ShuRefusal` would be a parser with an opinion about exit codes. ../coverage.ts
 * catches this and answers 1 -- "the file is there and says something nen cannot
 * read" is the same class as a malformed declaration, which this CLI already
 * answers 1 everywhere else.
 */
export class CoverageReportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CoverageReportError";
  }
}

/**
 * `covered`/`total` as a percentage, rounded to two decimals.
 *
 * TWO DECIMALS RATHER THAN THE FLOAT. `14/17` is 82.35294117647058, and a
 * report printing that in a table is noise; a report printing it in `--json` is
 * a golden file that differs across platforms the day one of them rounds the
 * last bit differently. Two decimals is finer than any threshold anybody states
 * and coarse enough to be stable.
 */
export function percentOf(covered: number, total: number): number | null {
  if (total <= 0) return null;
  return Math.round((covered / total) * 10000) / 100;
}

/**
 * Counts, with the percentage derived rather than carried.
 *
 * MORE COVERED THAN THERE IS TO COVER IS A REFUSAL, NOT A PERCENTAGE OVER 100.
 * Every format here states its two numbers separately -- `lines-covered` beside
 * `lines-valid`, `coveredLines` beside `executableLines`, `LH` beside `LF` --
 * and a file where the first exceeds the second took them from two different
 * places (a merged report, a half-written one, a template with a stale figure
 * in it). Reporting `117.65%` would carry that damage into a table and a
 * `--json` document as though it were a measurement; clamping it to 100% would
 * hide it entirely. The counts are named in the refusal so the reader can see
 * which two disagree.
 */
export function counts(covered: number, total: number): CoverageCounts {
  if (covered > total) {
    throw new CoverageReportError(
      `states ${covered} of ${total} covered, which is more covered than there is to cover. nen neither clamps that to 100% nor divides it out to a percentage above it: the two figures came from different places, and a report that says so is a report to go and look at.`,
    );
  }
  return { covered, total, percent: percentOf(covered, total) };
}

/**
 * A measure with `branches` present only when there is a branch figure.
 *
 * The conditional spread is deliberate rather than `branches: undefined`: the
 * key must be ABSENT from `Object.keys`, not merely absent from the JSON text,
 * so the two renderings cannot disagree about whether the tool measured them.
 */
export function measure(lines: CoverageCounts, branches: CoverageCounts | null): CoverageMeasure {
  return { lines, ...(branches === null ? {} : { branches }) };
}

/** The same, named. */
export function target(
  name: string,
  lines: CoverageCounts,
  branches: CoverageCounts | null,
): CoverageTarget {
  return { name, lines, ...(branches === null ? {} : { branches }) };
}

/**
 * Sum a list of measures into one total.
 *
 * BRANCHES SURVIVE ONLY IF SOMETHING MEASURED THEM. A format whose rows carry
 * no branch counts must not produce a `0 of 0 branches` total out of adding
 * nothing up -- that reads as "no branches are covered", which is a finding
 * this report would have invented.
 */
export function sum(measures: readonly CoverageMeasure[]): CoverageMeasure {
  let lineCovered = 0;
  let lineTotal = 0;
  let branchCovered = 0;
  let branchTotal = 0;
  let anyBranches = false;
  for (const entry of measures) {
    lineCovered += entry.lines.covered;
    lineTotal += entry.lines.total;
    if (entry.branches !== undefined) {
      anyBranches = true;
      branchCovered += entry.branches.covered;
      branchTotal += entry.branches.total;
    }
  }
  return measure(
    counts(lineCovered, lineTotal),
    anyBranches ? counts(branchCovered, branchTotal) : null,
  );
}

/**
 * A number a report stated, refused rather than coerced.
 *
 * A COUNT THAT IS NOT A NUMBER IS A MALFORMED REPORT, not a zero. Coercing
 * `"14"` would be convenient and would also mean a report whose counts had
 * become strings for some reason nobody noticed still produced a total -- and a
 * total assembled out of guesses is the one output this verb must never have.
 */
export function requireCount(value: unknown, path: string, pointer: string): number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new CoverageReportError(
      `${path}: ${pointer} is ${describeCount(value)}, and a coverage count is a non-negative number. nen reports what a report states and never coerces a count -- a total assembled out of guesses is worse than no total.`,
    );
  }
  return value;
}

/**
 * The value a refusal quotes back, including the ones JSON cannot spell.
 *
 * `JSON.stringify(Infinity)` IS THE STRING `"null"`, and so is `NaN`'s -- so a
 * message built out of it told a reader whose `1e400` overflowed on the way in
 * that their count was `null`, which is a different mistake with a different
 * fix. Non-finite numbers are printed as themselves; everything else is still
 * JSON, because quoting is what distinguishes the string `"17"` from 17 and
 * that distinction is the whole point of the refusal above it.
 */
function describeCount(value: unknown): string {
  if (value === undefined) return "absent";
  if (typeof value === "number" && !Number.isFinite(value)) return String(value);
  return JSON.stringify(value);
}
