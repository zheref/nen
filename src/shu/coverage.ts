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
// THE EXECUTOR'S OWN REPORT IS NOT THROWN AWAY -- ON ANY PATH, INCLUDING THE
// ONE THAT THROWS. In text mode it is printed first, exactly as `nen shu build`
// prints it; under `--json` it is rendered to STDERR while stdout carries the
// one coverage document, which is the same split ./run.ts already makes for a
// step's own output and for the same reason: stdout is exactly one object, and
// everything a human still needs is beside it. A step that could not be STARTED
// (exit 5) is the path where that promise is easiest to break, because ./run.ts
// hands the report to the sink and then THROWS: the throw is caught below, the
// captured report and a document carrying `exitCode: 5` are rendered, and only
// then does the refusal go on propagating -- so `nen shu coverage` prints on
// that path exactly what `nen shu build` prints on it.

import { readFileSync } from "node:fs";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { GIT, must } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";
import { loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
import { advisoryFor, type CoverageAdvisory } from "./coverage/advisory.js";
import { openDeclaration } from "./declaration.js";
import { ShuRefusal } from "./exit.js";
import { XCCOV, parseXccovFiles } from "./coverage/formats/xccov.js";
import { formatNamedBy, readReport, recognisedByName, supportedFormats } from "./coverage/parse.js";
import {
  assembleCoverage,
  renderCoverage,
  type CoverageLadderReport,
  type CoverageReport,
  type CoverageSource,
} from "./coverage/report.js";
import { bandRows } from "./coverage/ladder.js";
import { filterTouched, grainOf, type CoverageGrain, type TouchedFilter } from "./coverage/touched.js";
import { CoverageReportError, type CoverageMeasure, type CoverageTarget } from "./coverage/shape.js";
import { insideRepo, renderReport, runVerb, type ShuArtifactReport, type ShuReport } from "./run.js";

export interface CoverageOptions {
  readonly lane: string | null;
  readonly dryRun: boolean;
  /** `--threshold`, exactly as it was typed. Parsed here, refused here. */
  readonly threshold: string | null;
  /**
   * `--touched`: scope `targets` to the files `--base` diffs against HEAD.
   *
   * REQUIRES `base` NON-NULL, AND REFUSES THE REVERSE TOO -- validateTouched()
   * below, called before anything is spawned. A `--base` nobody asked
   * `--touched` for has nothing to do, and a flag accepted and ignored is worse
   * than one refused (../command.ts's own rule for a foreign flag, applied here
   * to a pair of this verb's own).
   */
  readonly touched: boolean;
  /** `--base <ref>`. `git diff --name-only <base>...HEAD` names the touched set. */
  readonly base: string | null;
  /**
   * The reference pack's advisory report locations, by stack.
   *
   * PASSED IN, NEVER READ HERE. This module imports ./run.ts and therefore
   * REACHES the subprocess seam; ../profiles/inertness.test.ts fails the build
   * if a module that can spawn also reaches the catalogue, and it means REACHES
   * on both sides -- through however many hops, so importing ./coverage-defaults
   * .ts here would be an offence this file could not talk its way out of. (It
   * was a direct-edge rule when this module was written, which is exactly why
   * this comment claimed a guard that was not guarding: the rule is transitive
   * now, and `src/shu/command.ts` is the argued join, named in that file's
   * allowlist.) ../shu/command.ts imports both halves and spawns nothing itself
   * -- exactly as it already is for `shu tools`.
   */
  readonly advisories: Readonly<Record<string, CoverageAdvisory>>;
}

/**
 * `--touched` and `--base` are required together, in both directions.
 *
 * CHECKED BEFORE ANYTHING IS SPAWNED, the same rule --threshold's own parse
 * follows two functions up: a caller who mistyped a flag pairing should not
 * also need a valid declaration to be told so.
 */
export function validateTouched(options: Pick<CoverageOptions, "touched" | "base">): void {
  if (options.touched && (options.base === null || options.base.trim() === "")) {
    throw new VerbUsageError(
      `--touched requires --base <ref>: nen filters the per-target rows to the files 'git diff --name-only <base>...HEAD' reports, and there is no base to diff against without one.`,
    );
  }
  if (!options.touched && options.base !== null) {
    throw new VerbUsageError(
      `--base is read only with --touched -- it names the ref '--touched' diffs against, and does nothing on its own. Add --touched, or drop --base.`,
    );
  }
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
  const trimmed = raw.trim();
  // DECIMAL DIGITS AND AT MOST ONE POINT, checked BEFORE `Number` sees the
  // string. `Number` also reads `0x50` (80), `0b1010000` (80), `1e2` (100) and
  // `Infinity` -- so `--threshold 0x50` was accepted as an eighty nobody typed,
  // and a caller who meant something else got a number instead of the refusal
  // that would have told them. A percentage is written the way a percentage is
  // written; every other spelling is a typo worth a sentence.
  const value = DECIMAL.test(trimmed) ? Number(trimmed) : Number.NaN;
  if (!Number.isFinite(value) || value < 0 || value > 100) {
    throw new VerbUsageError(
      `--threshold '${raw}' is not a percentage between 0 and 100, written in decimal digits. Write the number alone ('--threshold 80', or '--threshold 82.5') -- not '0x50', not '8e1', not a trailing '%' -- nen compares it against the report's own line coverage and REPORTS whether it was met. It never changes the exit code, so a value nen cannot read is a usage error rather than something to guess at.`,
    );
  }
  return value;
}

/** `80`, `82.5`, `0`. Not `0x50`, not `8e1`, not `+80`, not `.5`. */
const DECIMAL = /^\d+(?:\.\d+)?$/;

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

/**
 * Keys a `coverage` declaration may state that THIS RELEASE DOES NOT READ.
 *
 * `report` IS THE ONE THAT MATTERS AND IT IS NOT A TYPO. zheref/nen#91's v4
 * §2.10 published `verbs.<lane>.coverage.report: {kind, value, format}`, and a
 * repository that wrote its declaration against that document has a perfectly
 * reasonable-looking field naming its report -- which the schema preserves as
 * an unknown key and this verb never opens. Silence there is the worst possible
 * answer: the refusal said "declares no artifacts at all" to somebody looking
 * straight at the path they had declared. So the key is NAMED, with the pointer
 * and the field that replaced it.
 */
const IGNORED_KEYS: readonly string[] = ["report"];

/**
 * The keys this lane's `coverage` block states that nen does not read.
 *
 * IT RE-OPENS THE DECLARATION, on the refusal path only. ./run.ts's report is a
 * published contract carrying what the run DID, not what the file said; adding
 * the raw declaration to it would change nine other verbs' `--json` documents
 * to answer a question only this one asks. The read costs one `readFileSync` on
 * a path that is already a refusal, and the executor opened the same file
 * successfully seconds ago.
 */
function ignoredKeysOn(repoRoot: string, lane: string): readonly string[] {
  let raw: Readonly<Record<string, unknown>>;
  try {
    raw = openDeclaration(repoRoot).project.verbs[lane]?.["coverage"]?.raw ?? {};
    /* c8 ignore next 4 -- the executor opened this same file moments ago; a
       failure here means it changed under us, and a refusal about a missing key
       is not the place to report that. */
  } catch {
    return [];
  }
  return IGNORED_KEYS.filter((key): boolean => raw[key] !== undefined);
}

/** The refusal a lane with no readable artifact gets, advisory and all. */
function noReportSentence(
  repoRoot: string,
  lane: string,
  stack: string,
  artifacts: readonly ShuArtifactReport[],
  advisories: Readonly<Record<string, CoverageAdvisory>>,
): string {
  const declared =
    artifacts.length === 0
      ? "declares no artifacts at all"
      : `declares ${artifacts.length} artifact${artifacts.length === 1 ? "" : "s"} and nen recognises none of them as a coverage report: ${artifacts.map((entry): string => entry.value).join(", ")}`;
  const ignored = ignoredKeysOn(repoRoot, lane);
  const stale =
    ignored.length === 0
      ? ""
      : ` It DOES declare ${ignored.map((key): string => `project.verbs.${lane}.coverage.${key}`).join(" and ")}, which this release does not read: an earlier design named the report there, and the shipped verb reads 'artifacts' instead -- one field already means "the paths this verb produces", and two fields meaning nearly one thing is how a repository ends up filling in the one nen is not looking at. Move the path across.`;
  return `'coverage' on lane '${lane}' (${stack}) ${declared}.${stale} Name the file the tool writes under project.verbs.${lane}.coverage.artifacts and nen will parse it -- it reads the report a repository NAMES and never searches a tree for one. Formats: ${supportedFormats()} ${advisoryFor(advisories, stack)}`;
}

/**
 * A row name the report stated, made repo-relative when it is inside the repo.
 *
 * WHY THIS EXISTS: THE ROW NAMES ARE SOMEBODY'S HOME DIRECTORY. Three of the
 * five reporters in the field write ABSOLUTE paths as their keys -- nyc and
 * vitest's `json-summary` write `/Users/<username>/work/<repo>/src/a.ts`, and
 * the same run on Windows writes `C:\Users\<username>\...` -- so a `--json`
 * document pasted into an issue, or a table pasted into a pull request, carries
 * the developer's account name and directory layout out of the machine that ran
 * it. That is the same class of leak ./run.ts already refuses for a
 * declaration's env VALUES, and it costs one string operation to not do.
 *
 * INSIDE THE REPOSITORY ONLY, AND OTHERWISE UNTOUCHED. A name that does not
 * resolve under the repo root is left exactly as the report wrote it: nen
 * reports what a report states, and a row genuinely outside the tree (a linked
 * package, a generated file in a cache) is a fact about the run rather than
 * something to rewrite into a relative path that would resolve somewhere else.
 *
 * IT IS DONE HERE AND NOT IN A PARSER. The parsers take TEXT and return a
 * shape; a parser that knew a repository root would be a parser with a
 * filesystem in it, and ../profiles/inertness.test.ts holds that whole
 * directory to text-in-shape-out. This module is where the repo root already
 * is.
 *
 * BOTH SEPARATORS, ON EVERY PLATFORM, because the report was not necessarily
 * written on this one -- a CI runner's LCOV file read on a developer's mac is
 * an ordinary thing to do -- and the result is always `/`-separated so two runs
 * of the same repository on two platforms produce the same document.
 */
export function relativiseName(repoRoot: string, name: string): string {
  const root = stripTrailingSlash(toSlashes(repoRoot));
  const candidate = toSlashes(name);
  if (root === "" || !candidate.startsWith(`${root}/`)) return name;
  // The `/` in the test above is what makes this a path boundary rather than a
  // string prefix: `/w/repo-2/src/a.ts` starts with `/w/repo` and is not in it.
  const relative = candidate.slice(root.length + 1);
  return relative === "" ? name : relative;
}

function toSlashes(value: string): string {
  return value.replace(/\\/g, "/");
}

function stripTrailingSlash(value: string): string {
  return value.length > 1 && value.endsWith("/") ? value.slice(0, -1) : value;
}

/** Every row, relativised. The order and the counts are the parser's. */
export function relativiseTargets(
  repoRoot: string,
  targets: readonly CoverageTarget[],
): readonly CoverageTarget[] {
  return targets.map((row): CoverageTarget => {
    const name = relativiseName(repoRoot, row.name);
    return name === row.name ? row : { ...row, name };
  });
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
 * The FILE-level rows an xccov report carries under `targets[].files[]`, or
 * null on any failure -- see the call site's comment for why null is a fallback
 * rather than a refusal.
 */
function xccovFileRows(absolute: string, display: string): readonly CoverageTarget[] | null {
  try {
    return parseXccovFiles(readFileSync(absolute, "utf8"), display).targets;
  } catch {
    return null;
  }
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
      ? noReportSentence(repoRoot, run.lane, run.stack, run.artifacts, options.advisories)
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
    // UNDER --touched, AN xccov-report'S ROWS BECOME FILES, NOT TARGETS. A
    // target is a whole app or framework; matching THAT against a touched-file
    // list would keep nearly every row on nearly every diff, defeating the
    // flag. ./coverage/formats/xccov.ts's `parseXccovFiles` descends into
    // `targets[].files[]` for exactly this caller; a second, best-effort read
    // (the first one just proved the file exists and parses) that fails for
    // some other reason falls back to the target-level rows already in hand
    // rather than failing a run over a read this verb does not strictly need.
    const targets =
      options.touched && parsed.format.id === XCCOV.id
        ? (xccovFileRows(absolute, artifact.value) ?? parsed.coverage.targets)
        : parsed.coverage.targets;
    return {
      total: parsed.coverage.total,
      targets: relativiseTargets(repoRoot, targets),
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
export async function runCoverage(
  context: CommandContext,
  repoRoot: string,
  options: CoverageOptions,
): Promise<number> {
  const threshold = parseThreshold(options.threshold);
  validateTouched(options);
  const ladder = readLadder(repoRoot, options, threshold);
  // A HOLDER RATHER THAN A `let`: the assignment happens inside a callback, and
  // a `let` narrowed to `null` at its declaration is a type error at every read
  // below -- the compiler does not follow a closure it did not call.
  const captured: { report: ShuReport | null } = { report: null };
  const sink = (report: ShuReport): void => {
    captured.report = report;
  };

  let exitCode: number;
  try {
    exitCode = await runVerb(context, repoRoot, {
      verb: "coverage",
      lane: options.lane,
      dryRun: options.dryRun,
      // NEITHER FLAG BELONGS TO THIS VERB. `coverage` takes no destination and
      // has no `--run` gate -- ./command.ts's per-subcommand flag table refuses
      // both on it -- and the executor reads them only for the verbs that do.
      target: null,
      run: false,
      sink,
    });
  } catch (error) {
    // A REFUSAL THAT ALREADY HANDED OVER A REPORT STILL PRINTS IT. ./run.ts's
    // spawn-failure path (exit 5) emits the report and then throws, which is
    // how `nen shu build` manages to print nine lines and a document beside
    // "could not be started". With the report going to a SINK instead of to
    // the terminal, the same throw would have swallowed it whole -- the one
    // verb in the family that captures the report would be the one verb that
    // loses it, on the one path where the argv that failed is the thing the
    // reader needs. So it is rendered, with a document carrying the refusal's
    // own code, and the refusal then goes on to ../shu/command.ts unchanged.
    if (error instanceof ShuRefusal && captured.report !== null) {
      report(context, captured.report, repoRoot, options, threshold, ladder, error.code);
    }
    throw error;
  }

  const run = captured.report;
  /* c8 ignore next 2 -- runVerb emits exactly once on every path that returns */
  if (run === null) return exitCode;
  return report(context, run, repoRoot, options, threshold, ladder, exitCode);
}

/**
 * The ladder this invocation reports against, through the ONE loader.
 *
 * READ BEFORE THE RUN, NOT DURING THE REPORT, and the reason is what
 * `loadWorkflow` does with a policy file it cannot read: a malformed
 * `nen/workflow.json` is a `SchemaError` naming the pointer, and a refusal a
 * caller has to sit through a whole coverage build to hear is a refusal
 * delivered at the worst possible moment. Every other fact about the
 * invocation -- `--threshold`'s number, `--touched`'s pairing -- is settled
 * before anything is spawned, and the repository's own policy is no different.
 *
 * READ ONLY WHEN THERE IS NO EXPLICIT `--threshold` TO OVERRIDE IT, and only
 * under `--touched`: ./coverage/ladder.ts's header says why the scope is the
 * touched set rather than a plain run, and why a typed `--threshold` replaces
 * the file's policy for that one run instead of being reconciled against it.
 * Neither case touches the filesystem at all.
 *
 * AN ABSENT FILE IS A LADDER, NOT THE ABSENCE OF ONE. `loadWorkflow` answers
 * `present: false` carrying the published 80 / 85 / 90, so `--touched` bands
 * every row in a repository that has not written a policy yet; the report
 * carries `present` so a reader can tell a declared rung from an assumed one.
 * That is a change from the stand-in reader this replaced, which answered
 * "no ladder" and banded nothing.
 *
 * `source` IS THE REPO-RELATIVE NAME, NOT `loaded.path`. See
 * ./coverage/report.ts's `CoverageLadderReport`: this document gets pasted into
 * issues, and `relativiseTargets` below exists precisely so that it does not
 * carry somebody's home directory out of the machine that ran it.
 */
function readLadder(
  repoRoot: string,
  options: CoverageOptions,
  threshold: number | null,
): CoverageLadderReport | null {
  if (!options.touched || threshold !== null) return null;
  const loaded = loadWorkflow(repoRoot);
  const { minimum, recommended, ideal } = loaded.workflow.coverage;
  return { minimum, recommended, ideal, source: WORKFLOW_FILE, present: loaded.present };
}

/**
 * Render one run: the executor's report, then this verb's own document.
 *
 * ONE SEAM FOR BOTH OUTCOMES. The path that returns a code and the path that
 * throws print the same two things in the same order to the same streams --
 * which is the property that makes "the executor's report is never thrown
 * away" checkable rather than asserted twice and true once.
 */
function report(
  context: CommandContext,
  run: ShuReport,
  repoRoot: string,
  options: CoverageOptions,
  threshold: number | null,
  ladder: CoverageLadderReport | null,
  exitCode: number,
): number {
  // The executor's own rendering, first: to stdout as text, to stderr under
  // --json so the one document on stdout stays one document.
  const write = context.json ? context.io.err : context.io.out;
  for (const line of renderReport(run)) write(line);

  const parsed = parseAfterRun(run, repoRoot, options, exitCode);
  const touched = options.touched
    ? computeTouched(context, repoRoot, options.base as string, parsed, threshold)
    : null;
  // THE LADDER WAS DECIDED BEFORE THE RUN (see readLadder above): it is null
  // exactly when this invocation has none -- no --touched, or an explicit
  // --threshold overriding the file -- and otherwise carries the three rungs,
  // whether or not the repository declared them. Which rows there are and
  // whether they are banded are two separate questions, asked separately.
  const rows = touched === null ? parsed.targets : touched.filter.rows;
  const targets = ladder === null ? rows : bandRows(rows, ladder);
  const document: CoverageReport = assembleCoverage({
    lane: run.lane,
    stack: run.stack,
    total: parsed.total,
    targets,
    threshold,
    report: parsed.source,
    exitCode: parsed.exitCode,
    touched:
      touched === null
        ? null
        : {
            base: options.base as string,
            files: touched.files,
            matched: touched.filter.matched,
            unmatched: touched.filter.unmatched,
          },
    ladder,
  });
  emit(
    context.io,
    context.json,
    document,
    renderCoverage(document, parsed.why, touched === null ? null : touched.grain),
  );
  if (parsed.note !== null) context.io.err(parsed.note);
  return parsed.exitCode;
}

/**
 * `--touched`'s own read: which files a change touched, and which of the
 * report's own rows they matched.
 *
 * THE GIT CALL RUNS AFTER THE COVERAGE TOOL'S OWN RUN AND PARSE, never before:
 * `parsed` (the rows to filter) does not exist until then, and the touched-file
 * list itself never depends on what the tool did -- computing it earlier would
 * buy nothing and cost the property below. That ordering also means a
 * `--dry-run --touched` preview still names the touched set (`git diff` is a
 * read of THIS process's own input, not the declared tool `--dry-run` silences)
 * even though there is nothing yet to match it against.
 */
function computeTouched(
  context: CommandContext,
  repoRoot: string,
  base: string,
  parsed: Parsed,
  threshold: number | null,
): { readonly files: readonly string[]; readonly filter: TouchedFilter; readonly grain: CoverageGrain } {
  const result = must(context.seams, GIT, ["diff", "--name-only", `${base}...HEAD`], { cwd: repoRoot });
  // `rawLines`, NEVER `outputLines`: THESE ARE PATHS, AND A PATH'S SPACES ARE
  // PART OF IT. ../seam/lines.ts exists for exactly this distinction --
  // `outputLines` trims, which is right for turning a subprocess's stderr into
  // a sentence and wrong for output whose exact columns are the data. A file
  // committed as `src/ odd .ts` is a file git names with its spaces intact, and
  // a trimmed copy of that name matches no coverage row, so the one file the
  // caller most needs banded would be reported `unmatched` with nothing to say
  // why. (Raised by Copilot on zheref/nen#147.)
  const files = rawLines(result.stdout);
  const grain: CoverageGrain = parsed.source === null ? "file" : grainOf(parsed.source.format);
  return { files, filter: filterTouched(parsed.targets, files, grain, threshold), grain };
}
