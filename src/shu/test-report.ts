// src/shu/test-report.ts -- `nen shu test-report`: run the lane's declared
// `test` through the executor like any other verb, then parse the results file
// that run produced into one shape.
//
// IT RUNS `test`, NOT A VERB OF ITS OWN, and that is the first thing to know
// about it. A repository that already declares how its tests run has said
// everything nen needs; asking it to declare a second, nearly identical
// invocation under `test-report` would be asking for two answers to one
// question, and the first repository to update only one of them would get a
// report about a command nobody runs. So this verb's declaration IS
// `project.verbs.<lane>.test`, its artifacts are that verb's `artifacts`, and
// every refusal ./run.ts has -- an undeclared verb is 4, a wrong host 3, an
// unsatisfied precondition 2, a program that could not start 5 -- fires here
// unchanged, in the same order, naming `test`.
//
// WHERE THE REPORT COMES FROM, AND WHY IT IS `artifacts`. ./coverage.ts's
// header argues this at length and the argument is the same one: the
// declaration already has a field for "the repo-relative paths this verb
// produces", and a results file is exactly one of those paths. So the report is
// the first declared artifact nen recognises, and a lane that names none gets a
// refusal listing the formats it reads.
//
// THE ONE PLACE THIS VERB DISAGREES WITH ITS SIBLING, AND WHY. `nen shu
// coverage` refuses to parse anything after a run that did not exit 0, because
// a coverage report from a failed run may be the previous run's and yesterday's
// numbers beside a red exit code are the one output that verb must not have.
// THIS verb parses that run anyway -- a failing suite is the interesting report,
// and a verb that went silent exactly when the tests went red would be useless
// in the case it exists for. The staleness risk is real and is answered rather
// than denied: the EXIT CODE IS ALWAYS THE RUN'S, so a caller that reads the
// code gets the run's verdict whatever the file said, and the numbers are
// reported beside it and never instead of it. What is still refused is parsing
// after a run that STARTED NOTHING -- a dry run, an unmet precondition, a
// program that could not be spawned -- because there the file on disk is
// certainly not this invocation's.
//
// AND THE FAILURES NEVER MOVE THE CODE EITHER. `failed: 3` does not make a
// green run red, and `--from-artifacts`, which runs nothing at all, exits 0 for
// a read that worked however red the suite was. nen reports what a report
// states; a caller that wants a gate reads `failed` and decides for itself.
// That is ./coverage.ts's `--threshold` rule (zheref/nen#91 v3 q16) applied to
// the same shape of question.
//
// THE EXECUTOR'S OWN REPORT IS NOT THROWN AWAY -- ON ANY PATH, INCLUDING THE
// ONE THAT THROWS. In text mode it is printed first, exactly as `nen shu build`
// prints it; under `--json` it is rendered to STDERR while stdout carries the
// one test-report document. ./coverage.ts's header spells out why the throwing
// path needs saying separately, and the same catch is below.

import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
// ONE RELATIVISING RULE FOR BOTH VERBS. `relativiseName` turns a report row
// naming somebody's home directory into a repo-relative one, and its own doc
// comment argues why that matters for a document people paste into issues. A
// test report's suite names have exactly the same problem -- one of the three
// formats names a suite with the absolute path of the test file -- and a second
// copy of that decision is a second place for it to drift.
import { relativiseName } from "./coverage.js";
import { openDeclaration } from "./declaration.js";
import { ShuRefusal } from "./exit.js";
import { renderInvocation } from "./render.js";
import { insideRepo, renderReport, runVerb, type ShuReport } from "./run.js";
import {
  directoryShaped,
  formatNamedBy,
  readTestReport,
  recognisedByName,
  supportedFormats,
} from "./test-report/parse.js";
import {
  assembleTestReport,
  renderReadOnly,
  renderTestReport,
  type TestReportDocument,
  type TestReportSource,
} from "./test-report/report.js";
import {
  TestReportError,
  type TestCase,
  type TestCounts,
} from "./test-report/shape.js";

/**
 * The verb whose invocation this one runs and whose artifacts it reads.
 *
 * NAMED ONCE, so the run, the artifact pointer and every refusal below cannot
 * come to disagree about which declaration this verb is about.
 */
export const SOURCE_VERB = "test";

export interface TestReportOptions {
  readonly lane: string | null;
  readonly dryRun: boolean;
  /** `--from-artifacts`: read the declared results and run nothing at all. */
  readonly fromArtifacts: boolean;
}

/**
 * The artifact this verb's report is in.
 *
 * TWO PASSES, AND THE SECOND ONE IS WEAKER ON PURPOSE. The first takes the
 * first artifact whose NAME states a format nen reads (`.xml`, `.json`); only
 * if none does is the second tried, which takes the first artifact whose last
 * segment carries no extension at all -- the shape of a DIRECTORY, which is
 * what a runner that writes one file per suite declares. That order is what
 * keeps the weaker rule from shadowing the stronger one: a lane declaring both
 * `build/libs/app` (a binary, extension-less) and `build/test-results.xml`
 * would otherwise be refused on the strength of a guess about the first.
 *
 * BY NAME AND NOT BY CONTENT, in both passes, and the reason is `--dry-run`: a
 * dry run has to be able to say which path the real run would parse, and it has
 * run nothing, so there is nothing on disk to sniff. A name that says one thing
 * and a path that turns out to be another is still caught --
 * ./test-report/parse.ts settles what a path IS with `statSync` and what a file
 * contains with the bytes, before either is parsed.
 */
export function chooseArtifact(artifacts: readonly string[]): string | null {
  return (
    artifacts.find((value): boolean => recognisedByName(value)) ??
    artifacts.find((value): boolean => directoryShaped(value)) ??
    null
  );
}

/**
 * What nen would call the chosen artifact before it has opened it.
 *
 * A DIRECTORY-SHAPED PATH HAS NO FORMAT YET, so it is reported as the XML tree
 * it will be read as only once the read has confirmed it. Until then the
 * document carries the path with the format nen expects, which is the honest
 * answer for a dry run: "this is the file I would parse, and this is what I
 * would try to read it as".
 */
function sourceOf(artifact: string | null): TestReportSource | null {
  if (artifact === null) return null;
  const named = formatNamedBy(artifact);
  return { format: named?.id ?? "junit", path: artifact };
}

/** The refusal a lane with no readable artifact gets. */
function noReportSentence(
  lane: string,
  stack: string,
  artifacts: readonly string[],
): string {
  const declared =
    artifacts.length === 0
      ? "declares no artifacts at all"
      : `declares ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} and nen recognises none of them as a test report: ${artifacts.join(", ")}`;
  return `'${SOURCE_VERB}' on lane '${lane}' (${stack}) ${declared}. Name the file the runner writes -- or the DIRECTORY it writes one file per suite into -- under project.verbs.${lane}.${SOURCE_VERB}.artifacts and nen will parse it: it reads the report a repository NAMES and never searches a tree for one. Formats: ${supportedFormats()}. A path with no extension in its last segment is taken as a directory of XML.`;
}

/** Every suite name made repo-relative, where it names a path inside the repo. */
function relativiseSuites(
  repoRoot: string,
  tests: readonly TestCase[],
): readonly TestCase[] {
  return tests.map((test): TestCase => {
    if (test.suite === null) return test;
    const suite = relativiseName(repoRoot, test.suite);
    return suite === test.suite ? test : { ...test, suite };
  });
}

interface Parsed {
  readonly report: TestReportSource | null;
  readonly tests: readonly TestCase[];
  readonly counts: TestCounts | null;
  readonly exitCode: number;
  /** The short reason nothing was parsed, for the text rendering. */
  readonly why: string | null;
  /** The long one, printed on stderr after the document. Null when all is well. */
  readonly note: string | null;
}

/**
 * Everything that happens once there is a declaration to read artifacts from.
 *
 * `baseExit` IS THE RUN'S CODE, and it is the floor: a parse that succeeds
 * returns it unchanged, and a parse that fails raises a zero to 1 and leaves a
 * non-zero alone. That is what makes "the exit code is the run's" true on every
 * path rather than on the happy one.
 */
function parseArtifacts(
  repoRoot: string,
  lane: string,
  stack: string,
  artifacts: readonly string[],
  baseExit: number,
): Parsed {
  const artifact = chooseArtifact(artifacts);
  const source = sourceOf(artifact);
  if (artifact === null) {
    return {
      report: null,
      tests: [],
      counts: null,
      exitCode: baseExit === 0 ? 1 : baseExit,
      why: "this lane declares no test report nen reads -- see below",
      note: noReportSentence(lane, stack, artifacts),
    };
  }
  const absolute = insideRepo(
    repoRoot,
    artifact,
    `project.verbs.${lane}.${SOURCE_VERB}.artifacts`,
  );
  try {
    const read = readTestReport(absolute, artifact);
    return {
      // The format is re-stated from what actually PARSED the report, which is
      // not always the one the name suggested: the content decides.
      report: { format: read.format.id, path: artifact },
      tests: relativiseSuites(repoRoot, read.parsed.tests),
      counts: read.parsed.counts,
      exitCode: baseExit,
      why: null,
      note: null,
    };
  } catch (error) {
    if (!(error instanceof TestReportError)) throw error;
    // EXIT 1, NOT 2. The invocation was correct; a report that is missing or
    // unreadable is a fact about this repository's tooling, which is the class
    // this CLI answers 1 for everywhere else.
    return {
      report: source,
      tests: [],
      counts: null,
      exitCode: baseExit === 0 ? 1 : baseExit,
      why: "the report could not be read -- see below",
      note: error.message,
    };
  }
}

/**
 * Did this run actually execute the command, all the way to a tool's own code?
 *
 * THE QUESTION IS NOT "DID IT SUCCEED". A suite that ran and failed is exactly
 * what this verb is for. The question is whether anything was spawned at all,
 * because a report on disk after a run that spawned nothing is certainly some
 * earlier run's -- and ./run.ts already answers it in the report: `log.mode` is
 * `dry-run` on every path that started nothing (a dry run, an unmet
 * precondition), and a step that could not be SPAWNED carries a null exit code
 * rather than a number.
 */
function ranSomething(run: ShuReport): boolean {
  if (run.log.mode !== "streamed") return false;
  const last = run.steps[run.steps.length - 1];
  return last !== undefined && last.exitCode !== null;
}

/**
 * One test-report run, from declaration to document.
 *
 * The executor's report is captured rather than printed (./run.ts's `sink`) so
 * that stdout carries exactly one JSON document. It is not discarded: see this
 * file's header for where it goes in each mode.
 */
export async function runTestReport(
  context: CommandContext,
  repoRoot: string,
  options: TestReportOptions,
): Promise<number> {
  // TWO WAYS OF SAYING "RUN NOTHING" IS NOT A CLEARER INSTRUCTION THAN ONE.
  // `--dry-run` renders the command and parses nothing; `--from-artifacts`
  // renders no command and parses what is on disk. A caller who typed both has
  // not said which output they wanted, and honouring either would silently
  // discard the other. Refused before the declaration is opened, because it is
  // a fact about the command line rather than about the repository.
  if (options.dryRun && options.fromArtifacts) {
    throw new VerbUsageError(
      `'test-report' was given both --dry-run and --from-artifacts. --dry-run prints the '${SOURCE_VERB}' command this lane declares and parses nothing; --from-artifacts runs nothing and parses the results already on disk. Both start no process and they answer different questions, so nen will not pick one for you.`,
    );
  }
  if (options.fromArtifacts) return readOnly(context, repoRoot, options);

  const captured: { report: ShuReport | null } = { report: null };
  const sink = (report: ShuReport): void => {
    captured.report = report;
  };

  let exitCode: number;
  try {
    exitCode = await runVerb(context, repoRoot, {
      verb: SOURCE_VERB,
      lane: options.lane,
      dryRun: options.dryRun,
      // NEITHER FLAG BELONGS TO THIS VERB. `test` takes no destination and has
      // no `--run` gate -- ./command.ts's per-subcommand flag table refuses
      // both on it -- and the executor reads them only for the verbs that do.
      target: null,
      run: false,
      sink,
    });
  } catch (error) {
    // A REFUSAL THAT ALREADY HANDED OVER A REPORT STILL PRINTS IT: ./run.ts's
    // spawn-failure path (exit 5) emits the report and then throws, and with
    // the report going to a SINK the throw would otherwise swallow it whole on
    // the one path where the argv that failed is the thing the reader needs.
    if (error instanceof ShuRefusal && captured.report !== null) {
      report(context, captured.report, repoRoot, options, error.code);
    }
    throw error;
  }

  const run = captured.report;
  /* c8 ignore next 2 -- runVerb emits exactly once on every path that returns */
  if (run === null) return exitCode;
  return report(context, run, repoRoot, options, exitCode);
}

/**
 * `--from-artifacts`: resolve the lane's `test`, read its results, run nothing.
 *
 * IT RESOLVES THE INVOCATION IT IS NOT GOING TO RUN, and that is deliberate.
 * The artifact list is a property of `project.verbs.<lane>.test`, so reading it
 * means rendering that invocation -- which brings the same refusals with it: a
 * lane that declares no `test` is still exit 4 in the repository's own words,
 * and a `test` the declaration restricts to another platform is still exit 3.
 * One resolver, one set of answers; a second, laxer path to the same field
 * would be a second opinion about what this lane declares.
 *
 * NOTHING IS SPAWNED. `renderInvocation` renders; ./run.ts is what runs, and it
 * is not called from here.
 */
function readOnly(
  context: CommandContext,
  repoRoot: string,
  options: TestReportOptions,
): number {
  const { project } = openDeclaration(repoRoot);
  const plan = renderInvocation(project, {
    lane: options.lane,
    verb: SOURCE_VERB,
    platform: context.seams.platform,
  });
  const write = context.json ? context.io.err : context.io.out;
  for (const line of renderReadOnly(plan.lane, plan.stack)) write(line);

  const parsed = parseArtifacts(repoRoot, plan.lane, plan.stack, plan.artifacts, 0);
  return finish(context, plan.lane, plan.stack, parsed);
}

/**
 * Render one run: the executor's report, then this verb's own document.
 *
 * ONE SEAM FOR BOTH OUTCOMES -- the path that returns a code and the path that
 * throws print the same two things in the same order to the same streams, which
 * is what makes "the executor's report is never thrown away" checkable rather
 * than asserted twice and true once.
 */
function report(
  context: CommandContext,
  run: ShuReport,
  repoRoot: string,
  options: TestReportOptions,
  exitCode: number,
): number {
  const write = context.json ? context.io.err : context.io.out;
  for (const line of renderReport(run)) write(line);

  const parsed = ranSomething(run)
    ? parseArtifacts(repoRoot, run.lane, run.stack, run.artifacts.map((entry): string => entry.value), exitCode)
    : nothingRan(run, options, exitCode);
  return finish(context, run.lane, run.stack, parsed);
}

/**
 * The answer for a run that started no process.
 *
 * NOTHING IS PARSED -- including the results file that may well be sitting on
 * disk from a previous run. Reading it would report numbers for a command this
 * invocation did not execute, which is the one lie this verb's whole design is
 * arranged around not telling; the header says why the FAILING case is
 * different and this one is not.
 */
function nothingRan(run: ShuReport, options: TestReportOptions, exitCode: number): Parsed {
  const artifacts = run.artifacts.map((entry): string => entry.value);
  const artifact = chooseArtifact(artifacts);
  return {
    report: sourceOf(artifact),
    tests: [],
    counts: null,
    exitCode,
    why: options.dryRun
      ? "this was a dry run: nothing ran, so there is no report to read"
      : "no step ran, so any report on disk belongs to an earlier run",
    note: artifact === null ? noReportSentence(run.lane, run.stack, artifacts) : null,
  };
}

/** Emit the one document, in both renderings, and answer with its code. */
function finish(
  context: CommandContext,
  lane: string,
  stack: string,
  parsed: Parsed,
): number {
  const document: TestReportDocument = assembleTestReport({
    lane,
    stack,
    report: parsed.report,
    tests: parsed.tests,
    counts: parsed.counts,
    exitCode: parsed.exitCode,
  });
  emit(context.io, context.json, document, renderTestReport(document, parsed.why));
  if (parsed.note !== null) context.io.err(parsed.note);
  return parsed.exitCode;
}
