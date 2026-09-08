// src/shu/coverage.ts -- `nen shu coverage`: run the lane's declared coverage
// verb through the executor like any other verb, then parse the report that run
// produced into one shape.
//
// THE RUN IS NOT SPECIAL AND THE PARSE IS. Every refusal ./run.ts has applies
// here unchanged, in the same order, with the same codes: an undeclared verb is
// still 4, a wrong host still 3, an unsatisfied precondition still 2, a tool
// that could not start still 5. This module adds exactly one thing the other
// nine executing verbs do not have -- a SECOND step after the tool exits, which
// reads a file the declaration named and turns it into numbers.
//
// WHERE THE REPORT COMES FROM, AND WHY IT IS `artifacts`. The declaration
// already has a field for "the repo-relative paths this verb produces", nen
// already reports whether each exists, and a coverage report is exactly one of
// those paths. A second field meaning nearly the same thing would be two ways to
// say one fact, and the first repository to fill in only one of them would get
// a refusal it could not read. So: the report is the first declared artifact
// whose NAME nen recognises as a format it reads, and a lane that names none
// gets a refusal that quotes the reference pack's advisory location for its
// stack -- a sentence, never a path nen goes and opens.
//
// WHAT `--threshold` DOES, AND THE ONE THING IT NEVER DOES. It reports `met`.
// It does not move the exit code, in either direction: a run whose coverage is
// under the bar still exits 0 if the tool exited 0, and a run over the bar whose
// tool failed still exits 1. zheref/nen#91's decision (v3 q16) is the reason and
// it is not a stylistic one -- the policy that prompted the flag scopes its bar
// to the files a pull request touched, which no coverage report can answer, so a
// nen that failed a build on this number would be enforcing a rule nobody wrote.
//
// THE EXECUTOR'S OWN REPORT IS NOT THROWN AWAY. In text mode it is printed
// first, exactly as `nen shu build` prints it; under `--json` it is rendered to
// STDERR while stdout carries the one coverage document, which is the same split
// ./run.ts already makes for a step's own output and for the same reason: stdout
// is exactly one object, and everything a human still needs is beside it.

import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { advisoryFor, type CoverageAdvisory } from "./coverage-defaults.js";
import { formatNamedBy, readReport, recognisedByName, supportedFormats } from "./coverage/parse.js";
import {
  assembleCoverage,
  renderCoverage,
  type CoverageReport,
  type CoverageSource,
} from "./coverage/report.js";
import { CoverageReportError, type CoverageMeasure, type CoverageTarget } from "./coverage/shape.js";
import { insideRepo, renderReport, runVerb, type ShuArtifactReport, type ShuReport } from "./run.js";

export interface CoverageOptions {
  readonly lane: string | null;
  readonly dryRun: boolean;
  /** `--threshold`, exactly as it was typed. Parsed here, refused here. */
  readonly threshold: string | null;
  /**
   * The reference pack's advisory report locations, by stack.
   *
   * PASSED IN, NEVER READ HERE. This module imports ./run.ts and therefore the
   * subprocess seam; ../profiles/inertness.test.ts fails the build if a module
   * that can spawn also reaches the catalogue. ../shu/command.ts is the join --
   * it imports both halves and spawns nothing itself -- exactly as it already is
   * for `shu tools`.
   */
  readonly advisories: Readonly<Record<string, CoverageAdvisory>>;
}

/**
 * `--threshold <0-100>`, refused rather than coerced.
 *
 * CHECKED BEFORE ANYTHING IS READ, because it is a fact about the command line
 * and not about the repository: a caller who typed `--threshold high` should be
 * told so without also needing a valid declaration to hear it.
 */
export function parseThreshold(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.trim());
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0 || value > 100) {
    throw new VerbUsageError(
      `--threshold '${raw}' is not a percentage between 0 and 100. Write the number alone ('--threshold 80', or '--threshold 82.5') -- nen compares it against the report's own line percentage and REPORTS whether it was met. It never changes the exit code, so a value nen cannot read is a usage error rather than something to guess at.`,
    );
  }
  return value;
}

/**
 * The artifact this verb's report is in: the first one whose NAME nen reads.
 *
 * BY NAME AND NOT BY CONTENT, and the reason is `--dry-run`: a dry run has to be
 * able to say which file the real run would parse, and it has run nothing, so
 * there is nothing on disk to sniff. A name that says one thing and a file that
 * turns out to be another is still caught -- ./coverage/parse.ts confirms every
 * candidate against the bytes before parsing them.
 */
function chooseArtifact(artifacts: readonly ShuArtifactReport[]): ShuArtifactReport | null {
  return artifacts.find((entry): boolean => recognisedByName(entry.value)) ?? null;
}

function sourceOf(artifact: ShuArtifactReport | null): CoverageSource | null {
  if (artifact === null) return null;
  const format = formatNamedBy(artifact.value);
  /* c8 ignore next -- chooseArtifact only returns a path a format claimed */
  if (format === null) return null;
  return { format: format.id, path: artifact.value };
}

/** The refusal a lane with no readable artifact gets, advisory and all. */
function noReportSentence(
  lane: string,
  stack: string,
  artifacts: readonly ShuArtifactReport[],
  advisories: Readonly<Record<string, CoverageAdvisory>>,
): string {
  const declared =
    artifacts.length === 0
      ? "declares no artifacts at all"
      : `declares ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} and nen recognises none of them as a coverage report: ${artifacts.map((entry): string => entry.value).join(", ")}`;
  return `'coverage' on lane '${lane}' (${stack}) ${declared}. Name the file the tool writes under project.verbs.${lane}.coverage.artifacts and nen will parse it -- it reads the report a repository NAMES and never searches a tree for one. Formats: ${supportedFormats()}. ${advisoryFor(advisories, stack)}`;
}

interface Parsed {
  readonly total: CoverageMeasure | null;
  readonly targets: readonly CoverageTarget[];
  readonly source: CoverageSource | null;
  readonly exitCode: number;
  /** The short reason nothing was parsed, for the text rendering. */
  readonly why: string | null;
  /** The long one, printed on stderr after the document. Null when all is well. */
  readonly note: string | null;
}

/**
 * Everything that happens after the executor returns.
 *
 * A RUN THAT DID NOT SUCCEED IS NOT PARSED, and that is the sharpest rule in
 * this file. A coverage report is a file on disk; a run that failed may have
 * written it, may have half-written it, or may have failed before touching it
 * -- in which case the file sitting there is the PREVIOUS run's, and nen cannot
 * tell the difference by looking. Reporting yesterday's numbers as today's,
 * beside a red exit code, is the one failure this verb must not have. So the
 * numbers are reported only for a run nen watched exit 0, and every other
 * outcome says plainly that nothing was parsed.
 */
function parseAfterRun(
  run: ShuReport,
  repoRoot: string,
  options: CoverageOptions,
  exitCode: number,
): Parsed {
  const artifact = chooseArtifact(run.artifacts);
  const source = sourceOf(artifact);
  const advisory =
    artifact === null
      ? noReportSentence(run.lane, run.stack, run.artifacts, options.advisories)
      : null;

  if (options.dryRun) {
    // NOTHING RAN, SO NOTHING IS PARSED -- including the report that may well be
    // sitting on disk from a previous run. A dry run that read it would report
    // numbers for a command it did not execute, which is the same lie as
    // parsing after a failure and easier to believe.
    return {
      total: null,
      targets: [],
      source,
      exitCode,
      why: "this was a dry run: nothing ran, so there is no report to read",
      note: advisory,
    };
  }
  if (exitCode !== 0) {
    return {
      total: null,
      targets: [],
      source,
      exitCode,
      why: "the run did not succeed, and a report from a run that failed may be a previous run's",
      note: null,
    };
  }
  if (artifact === null || source === null) {
    return {
      total: null,
      targets: [],
      source: null,
      exitCode: 1,
      why: "the run succeeded and this lane declares no report nen reads -- see below",
      note: advisory,
    };
  }

  const absolute = insideRepo(
    repoRoot,
    artifact.value,
    `project.verbs.${run.lane}.coverage.artifacts`,
  );
  try {
    const parsed = readReport(absolute, artifact.value);
    return {
      total: parsed.coverage.total,
      targets: parsed.coverage.targets,
      // The format is re-stated from what actually PARSED the file, which is
      // not always the one the name suggested: the content decides.
      source: { format: parsed.format.id, path: artifact.value },
      exitCode: 0,
      why: null,
      note: null,
    };
  } catch (error) {
    if (!(error instanceof CoverageReportError)) throw error;
    // EXIT 1, NOT 2. The invocation was correct and the run succeeded; a file
    // that is missing or unreadable is a fact about this repository's tooling,
    // which is the same class this CLI answers 1 for everywhere else.
    return {
      total: null,
      targets: [],
      source,
      exitCode: 1,
      why: "the run succeeded and its report could not be read -- see below",
      note: error.message,
    };
  }
}

/**
 * One coverage run, from declaration to document.
 *
 * The executor's report is captured rather than printed (./run.ts's `sink`) so
 * that stdout carries exactly one JSON document. It is not discarded: see this
 * file's header for where it goes in each mode.
 */
export function runCoverage(
  context: CommandContext,
  repoRoot: string,
  options: CoverageOptions,
): number {
  const threshold = parseThreshold(options.threshold);
  // A HOLDER RATHER THAN A `let`: the assignment happens inside a callback, and
  // a `let` narrowed to `null` at its declaration is a type error at every read
  // below -- the compiler does not follow a closure it did not call.
  const captured: { report: ShuReport | null } = { report: null };
  const exitCode = runVerb(context, repoRoot, {
    verb: "coverage",
    lane: options.lane,
    dryRun: options.dryRun,
    target: null,
    sink: (report): void => {
      captured.report = report;
    },
  });
  const run = captured.report;
  /* c8 ignore next 2 -- runVerb emits exactly once on every path that returns */
  if (run === null) return exitCode;

  // The executor's own rendering, first: to stdout as text, to stderr under
  // --json so the one document on stdout stays one document.
  const write = context.json ? context.io.err : context.io.out;
  for (const line of renderReport(run)) write(line);

  const parsed = parseAfterRun(run, repoRoot, options, exitCode);
  const document: CoverageReport = assembleCoverage({
    lane: run.lane,
    stack: run.stack,
    total: parsed.total,
    targets: parsed.targets,
    threshold,
    report: parsed.source,
    exitCode: parsed.exitCode,
  });
  emit(context.io, context.json, document, renderCoverage(document, parsed.why));
  if (parsed.note !== null) context.io.err(parsed.note);
  return parsed.exitCode;
}
