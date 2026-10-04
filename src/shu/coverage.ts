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

import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { GIT, must } from "../seam/exec.js";
import { loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
import { advisoryFor, type CoverageAdvisory } from "./coverage/advisory.js";
import { digestArtifacts, nulPaths, readCaptureSidecar, recordCapture, takeFingerprint } from "./capture-provenance.js";
import { captureRefusal, judgeCapture, sidecarPath, type CaptureProblem } from "./coverage/capture.js";
import { openDeclaration } from "./declaration.js";
import { EXIT_COVERAGE_STALE_CAPTURE, EXIT_COVERAGE_UNJOINED, ShuRefusal } from "./exit.js";
import { renderInvocation } from "./render.js";
import { XCCOV, parseXccovFiles } from "./coverage/formats/xccov.js";
import {
  formatNamedBy,
  readReport,
  recognisedByName,
  supportedFormats,
  type ParsedReport,
} from "./coverage/parse.js";
import {
  assembleCoverage,
  renderCoverage,
  renderFromCapture,
  type CoverageLadderReport,
  type CoverageReport,
  type CoverageSource,
  type TouchedArtifact,
} from "./coverage/report.js";
import { rebaseRows, resolveRoot, rootCandidates } from "./coverage/roots.js";
import { joinSourceFiles } from "./coverage/files.js";
import { bandRows } from "./coverage/ladder.js";
import {
  expectedGrainOf,
  filterTouchedGroups,
  grainOf,
  type CoverageGrain,
  type TouchedFilter,
  type TouchedGroup,
} from "./coverage/touched.js";
import { CoverageReportError, type CoverageMeasure, type CoverageTarget } from "./coverage/shape.js";
import { insideRepo, renderReport, runVerb, type ShuArtifactReport, type ShuReport } from "./run.js";

export interface CoverageOptions {
  readonly lane: string | null;
  readonly dryRun: boolean;
  /** `--effort <id>`: the phase ledger the run's steps are appended to (zheref/nen#227). */
  readonly effort?: string | null;
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
   * `--from-capture`: build the `--touched` table from the reports already on
   * disk and run NOTHING (zheref/nen#250) -- after nen has judged them current
   * (./coverage/capture.ts). Only with `--touched`; never with `--dry-run` or
   * `--effort`. See validateFromCapture().
   */
  readonly fromCapture?: boolean;
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
  // A BASE THAT BEGINS WITH '-' WOULD REACH GIT AS AN OPTION, not a ref:
  // '--base=--output=<path>' made 'git diff' WRITE a file from a line izanami
  // certifies read-only (hanten round 1 on zheref/nen#250, N5). No ref git
  // accepts begins with '-', so refusing the shape costs no real base.
  if (options.base !== null && options.base.startsWith("-")) {
    throw new VerbUsageError(
      `--base '${options.base}' begins with '-', so git would read it as an option rather than a ref. No branch, tag or commit name begins with '-'; name the ref itself (e.g. '--base origin/main').`,
    );
  }
}

/**
 * The base must name a commit, asked of git BEFORE anything is spawned:
 * `git rev-parse --verify --quiet --end-of-options <base>^{commit}`. A base
 * that names nothing is a mistyped flag, exit 2 -- and it was once learned
 * only after a whole coverage run, from the diff that ran after it.
 */
function verifyBase(context: CommandContext, repoRoot: string, base: string): void {
  const result = context.seams.run(
    GIT,
    ["rev-parse", "--verify", "--quiet", "--end-of-options", `${base}^{commit}`],
    { cwd: repoRoot },
  );
  if (result.spawnFailed || result.code !== 0) {
    throw new VerbUsageError(
      `--base '${base}' does not name a commit in this repository ('git rev-parse --verify ${base}^{commit}' found none). Name a branch, tag or commit that exists here -- fetch it first if it is a remote's.`,
    );
  }
}

/**
 * `--from-capture` is read only under `--touched`, and with neither `--dry-run`
 * nor `--effort` (zheref/nen#250).
 *
 * CHECKED BEFORE ANYTHING IS READ, like the pairing above. Each refusal is a
 * flag that would otherwise be accepted and ignored:
 *
 *   * WITHOUT --touched there is no touched set, so "current" would be judged
 *     against the uncommitted files alone -- a weaker test than the one this
 *     flag promises, on the table it was not asked for.
 *   * WITH --dry-run, both forms run nothing and they answer different
 *     questions: one prints the command and parses nothing, the other parses
 *     what is on disk. nen will not pick one (`test-report`'s own rule for
 *     `--from-artifacts`, for the same reason).
 *   * WITH --effort, there is no step to append to the phase ledger: the
 *     ledger records what RAN, and this form runs nothing.
 */
export function validateFromCapture(
  options: Pick<CoverageOptions, "touched" | "dryRun" | "effort" | "fromCapture">,
): void {
  if (options.fromCapture !== true) return;
  if (!options.touched) {
    throw new VerbUsageError(
      `--from-capture is read only with --touched --base <ref>: nen reuses a capture only after judging it current against the files a change touched, and without --touched there is no touched set to judge it against.`,
    );
  }
  if (options.dryRun) {
    throw new VerbUsageError(
      `'coverage' was given both --dry-run and --from-capture. --dry-run prints the coverage command this lane declares and parses nothing; --from-capture runs nothing and parses the capture already on disk. Both start no declared process and they answer different questions, so nen will not pick one for you.`,
    );
  }
  if (options.effort !== undefined && options.effort !== null) {
    throw new VerbUsageError(
      `--effort is not read with --from-capture: the phase ledger records the steps a run performed, and --from-capture runs nothing, so there is nothing to append. Drop --effort, or drop --from-capture to measure with a run the ledger records.`,
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

/**
 * What the parse needs to know about where the reports came from: the lane, its
 * stack and absolute cwd, and the declared artifacts.
 *
 * A `ShuReport` IS ONE, and so is the resolved-but-not-run invocation
 * `--from-capture` builds (zheref/nen#250) -- the one parse, reached two ways,
 * rather than a second parse that could come to disagree with the first.
 */
type CoverageRun = Pick<ShuReport, "lane" | "stack" | "cwd" | "artifacts">;

interface Parsed {
  readonly total: CoverageMeasure | null;
  readonly targets: readonly CoverageTarget[];
  readonly source: CoverageSource | null;
  readonly exitCode: number;
  /** The short reason nothing was parsed, for the text rendering. */
  readonly why: string | null;
  /** The long one, printed on stderr after the document. Null when all is well. */
  readonly note: string | null;
  /**
   * Under `--touched` only: every declared report's rows, rebased onto that
   * report's own root, one group per report. Empty otherwise, and empty on
   * every path that parsed nothing.
   */
  readonly groups: readonly TouchedGroup[];
  /** Under `--touched` only: each declared report's account, root and all. */
  readonly artifacts: readonly TouchedArtifact[];
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
 * The lane's `cwd`, repo-relative and `/`-separated (`""` at the root).
 *
 * ../run.ts reports it ABSOLUTE, joined lexically under the same `repoRoot`
 * this module holds, so a prefix strip is exact; a cwd that somehow is not
 * under the root falls back to the root, which is the candidate every
 * single-package repository already resolves to.
 */
function laneCwdRelative(repoRoot: string, cwd: string): string {
  const root = stripTrailingSlash(toSlashes(repoRoot));
  const lane = stripTrailingSlash(toSlashes(cwd));
  if (lane === root) return "";
  const relative = relativiseName(repoRoot, cwd);
  return relative === cwd && isAbsolutePath(relative) ? "" : toSlashes(relative);
}

function isAbsolutePath(value: string): boolean {
  return /^([A-Za-z]:)?[\\/]/.test(value);
}

/**
 * "Is this repo-relative path a FILE in the working tree?" -- the one
 * filesystem question ./coverage/roots.ts asks, answered here because that
 * directory is text-in-shape-out. A directory, a dangling link, or anything
 * `stat` cannot answer is "no": a root is only evidenced by files it holds.
 */
function fileExists(repoRoot: string): (repoRelative: string) => boolean {
  return (repoRelative: string): boolean => {
    try {
      return statSync(join(repoRoot, repoRelative)).isFile();
    } catch {
      return false;
    }
  };
}

/**
 * Every spelling of the repository root: as nen was given it, and as the
 * filesystem resolves it, when the two differ (zheref/nen#296 review, F2).
 *
 * A TOOL WRITES WHAT `getcwd` RETURNED, and that is the RESOLVED path: a
 * coverage run inside a checkout reached through `/tmp` (macOS: `/private/tmp`),
 * a `mktemp` directory (`/var` -> `/private/var`), a symlinked workspace, or a
 * Windows 8.3 short name writes a `<source>` that no longer starts with the
 * `--repo` nen was handed -- and anchoring only that spelling turned the same
 * report into exit 0 through one path and exit 6 through the other.
 */
export function repoRootSpellings(repoRoot: string): readonly string[] {
  let real: string;
  try {
    real = realpathSync.native(repoRoot);
  } catch {
    return [repoRoot];
  }
  return stripTrailingSlash(toSlashes(real)) === stripTrailingSlash(toSlashes(repoRoot)) ? [repoRoot] : [repoRoot, real];
}

/**
 * `fileExists`, answering with the path's ON-DISK spelling (zheref/nen#296
 * review, F3) -- or null when it is not a file.
 *
 * ON A CASE-INSENSITIVE FILESYSTEM (macOS, Windows) `core/models/a.cs` EXISTS
 * when the file is `Core/Models/A.cs`, and a row kept under the report's
 * spelling then matched no touched path -- git names the file as it is on
 * disk -- while the account still counted it as found. So the answer is the
 * real path's tail, adopted ONLY when it is the same path in another letter
 * case: a real path that differs any other way went through a symlink, and
 * a link's target is not the name git gives the file. On a case-sensitive
 * filesystem the two never differ, and the answer is the question.
 *
 * ONLY THE LETTER CASE IS TAKEN FROM DISK, NEVER THE UNICODE FORM (review
 * round 3). macOS keeps a name in whatever composition it was created in --
 * `Café.cs` may sit on disk DECOMPOSED (NFD) -- while git, with
 * `core.precomposeUnicode` (its default there), names it COMPOSED (NFC).
 * Adopting the real path's tail verbatim turned a report and a diff that both
 * said `Café.cs` into a row named with the NFD bytes, which matched nothing.
 * So the adopted spelling is put back into NFC: the case the disk has, in the
 * form git uses. When the real tail is byte-identical to the question the
 * question is returned untouched, so a name that is NFD in git and on disk
 * (a Linux checkout) is never rewritten.
 */
export function fileLocator(repoRoot: string): (repoRelative: string) => string | null {
  const exists = fileExists(repoRoot);
  let realRoot: string | null | undefined;
  return (repoRelative: string): string | null => {
    if (!exists(repoRelative)) return null;
    if (realRoot === undefined) {
      try {
        realRoot = realpathSync.native(repoRoot);
      } catch {
        /* c8 ignore next -- the root was just statted through; a failure here is a race */
        realRoot = null;
      }
    }
    if (realRoot === null) return repoRelative;
    let real: string;
    try {
      real = realpathSync.native(join(repoRoot, repoRelative));
    } catch {
      /* c8 ignore next -- statted a moment ago */
      return repoRelative;
    }
    const tail = toSlashes(relativiseName(realRoot, real));
    return tail !== repoRelative && foldCase(tail) === foldCase(repoRelative) ? tail.normalize("NFC") : repoRelative;
  };
}

/**
 * What an ABSOLUTE path outside the repository is on this machine -- a file or
 * a directory, with its real path -- or null (zheref/nen#296, review round 3).
 *
 * ./coverage/roots.ts asks this about a `<source>` a report states outside the
 * repository (coverage.py's site-packages) and about `<source>/<name>` under
 * it, so that a same-named file there counts as a second answer instead of
 * letting the union of both files' lines be credited to the one inside. It is
 * a `stat` and a `realpath`: nothing is opened or read. A path that is not
 * absolute on THIS platform (`D:\...` on POSIX) is not asked at all -- `stat`
 * would resolve it against the process's own directory.
 */
export function pathProbe(absolute: string): { readonly kind: "file" | "directory"; readonly real: string } | null {
  if (!isAbsolute(absolute)) return null;
  try {
    const stats = statSync(absolute);
    const kind = stats.isFile() ? "file" : stats.isDirectory() ? "directory" : null;
    if (kind === null) return null;
    let real: string;
    try {
      real = realpathSync.native(absolute);
    } catch {
      /* c8 ignore next -- statted a moment ago */
      real = absolute;
    }
    return { kind, real };
  } catch {
    return null;
  }
}

/** Letter case and Unicode composition set aside -- what a case-insensitive filesystem compares. */
function foldCase(value: string): string {
  return value.normalize("NFC").toLowerCase();
}

interface TouchedSources {
  readonly groups: readonly TouchedGroup[];
  readonly artifacts: readonly TouchedArtifact[];
}

/**
 * Under `--touched`, EVERY declared report nen reads -- not only the first --
 * each rebased onto its own root (zheref/nen#236 acceptance 2 and 3).
 *
 * WHY ONLY UNDER `--touched`. A plain run reports ONE report's total and rows,
 * and has since the verb shipped; its `total`, `report` and `threshold.met`
 * stay exactly that first report's here too, so `--threshold`'s aggregate
 * means what it always meant. What `--touched` asks is different -- "which of
 * the files this change touched did the tests measure?" -- and a workspace
 * answers that across every member's report, or it cannot answer it at all.
 *
 * THE FIRST REPORT IS NOT READ TWICE: its outcome is handed in -- its parse
 * and the rows already extracted from it, or the error it failed with. Every
 * other one is opened here through the same `insideRepo` containment and the
 * same one `readReport`. One that cannot be read -- the FIRST included -- is
 * NAMED in `artifacts[].error` and turns the run into exit 1, and the reports
 * after it are still read: a missing first report must not hide a sound second
 * one, nor go unlisted itself. Reporting an unread report's files `unmatched`
 * instead would be the silent miss this whole change exists to remove.
 * (Raised by Copilot on zheref/nen#254.)
 */
function readTouchedSources(
  run: CoverageRun,
  repoRoot: string,
  primary: PrimaryRead,
): TouchedSources {
  const laneCwd = laneCwdRelative(repoRoot, run.cwd);
  const exists = fileExists(repoRoot);
  const locate = fileLocator(repoRoot);
  const repoRoots = repoRootSpellings(repoRoot);
  const groups: TouchedGroup[] = [];
  const artifacts: TouchedArtifact[] = [];
  for (const artifact of chooseArtifacts(run.artifacts)) {
    let parsed: ParsedReport;
    let raw: readonly CoverageTarget[];
    if (artifact === primary.artifact) {
      if (primary.error !== null) {
        artifacts.push(unread(artifact.value, primary.error));
        continue;
      }
      parsed = primary.parsed;
      raw = primary.rows;
    } else {
      const absolute = insideRepo(repoRoot, artifact.value, `project.verbs.${run.lane}.coverage.artifacts`);
      try {
        parsed = readReport(absolute, artifact.value);
      } catch (error) {
        if (!(error instanceof CoverageReportError)) throw error;
        artifacts.push(unread(artifact.value, error.message));
        continue;
      }
      raw = fileGrainRows(absolute, artifact.value, parsed);
    }
    // A REPORT THAT NAMES ITS FILES IS MATCHED BY FILE (zheref/nen#296).
    // Cobertura's own rows are packages, but every `<class>` names the file
    // it came from; ./coverage/files.ts resolves those names against the
    // report's `<source>` roots and the usual candidates, one name at a time,
    // and hands back FILE rows under their on-disk spelling. A name that is
    // ambiguous or resolves nowhere is never matched -- its touched file is
    // `unmatched`, never credited to another file or its package, and the
    // account says why -- and a view that cannot be measured is this report's
    // `error`, exit 1, exactly like an unreadable report.
    const view = parsed.coverage.files;
    if (view !== undefined) {
      const joined = joinSourceFiles(view, {
        repoRoots,
        artifactPath: artifact.value,
        format: parsed.format.id,
        laneCwd,
        locate,
        probe: pathProbe,
      });
      if (joined.group !== null) groups.push(joined.group);
      artifacts.push(joined.artifact);
      continue;
    }
    const grain = grainOf(parsed.format.id);
    if (grain === "package") {
      // PACKAGE ROWS ARE NOT PATHS, so there is no root to rebase them onto:
      // ./coverage/touched.ts matches a package's segments anywhere inside a
      // touched path, which already works from any root.
      groups.push({ rows: relativiseTargets(repoRoot, raw), grain });
      artifacts.push({
        path: artifact.value,
        format: parsed.format.id,
        root: null,
        basis: null,
        rows: raw.length,
        onDisk: null,
        error: null,
      });
      continue;
    }
    const resolved = resolveRoot(raw, rootCandidates(artifact.value, laneCwd), exists);
    groups.push({ rows: relativiseTargets(repoRoot, rebaseRows(raw, resolved.root)), grain });
    artifacts.push({
      path: artifact.value,
      format: parsed.format.id,
      root: resolved.root === "" ? "." : resolved.root,
      basis: resolved.basis,
      rows: raw.length,
      onDisk: resolved.onDisk,
      error: null,
    });
  }
  return { groups, artifacts };
}

/**
 * The first report's outcome, handed to `readTouchedSources` so it is never
 * read twice: its parse and the rows already taken from it, or the message it
 * failed with.
 */
type PrimaryRead =
  | {
      readonly artifact: ShuArtifactReport;
      readonly parsed: ParsedReport;
      readonly rows: readonly CoverageTarget[];
      readonly error: null;
    }
  | { readonly artifact: ShuArtifactReport; readonly parsed: null; readonly rows: null; readonly error: string };

/** A declared report that could not be read, as `touched.artifacts` lists it. */
function unread(path: string, error: string): TouchedArtifact {
  return { path, format: null, root: null, basis: null, rows: 0, onDisk: null, error };
}

/**
 * The rows `--touched` matches: an xccov report's FILE rows (see
 * `parseAfterRun`), every other format's own rows.
 */
function fileGrainRows(absolute: string, display: string, parsed: ParsedReport): readonly CoverageTarget[] {
  return parsed.format.id === XCCOV.id
    ? (xccovFileRows(absolute, display) ?? parsed.coverage.targets)
    : parsed.coverage.targets;
}

/** Every declared artifact whose NAME nen reads, in declaration order. */
function chooseArtifacts(artifacts: readonly ShuArtifactReport[]): readonly ShuArtifactReport[] {
  return artifacts.filter((entry): boolean => recognisedByName(entry.value));
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
  run: CoverageRun,
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
      groups: [],
      artifacts: [],
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
      groups: [],
      artifacts: [],
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
      groups: [],
      artifacts: [],
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
    const targets = options.touched ? fileGrainRows(absolute, artifact.value, parsed) : parsed.coverage.targets;
    // The format is re-stated from what actually PARSED the file, which is
    // not always the one the name suggested: the content decides.
    const parsedSource: CoverageSource = { format: parsed.format.id, path: artifact.value };
    if (options.touched) {
      const sources = readTouchedSources(run, repoRoot, { artifact, parsed, rows: targets, error: null });
      const failed = sources.artifacts.filter((entry): boolean => entry.error !== null);
      return {
        total: parsed.coverage.total,
        targets: relativiseTargets(repoRoot, targets),
        source: parsedSource,
        exitCode: failed.length === 0 ? 0 : 1,
        why:
          failed.length === 0
            ? null
            : `the run succeeded and ${failed.length} of its declared reports could not be read -- see below`,
        note: failed.length === 0 ? null : failed.map((entry): string => entry.error ?? "").join("\n"),
        groups: sources.groups,
        artifacts: sources.artifacts,
      };
    }
    return {
      total: parsed.coverage.total,
      targets: relativiseTargets(repoRoot, targets),
      source: parsedSource,
      exitCode: 0,
      why: null,
      note: null,
      groups: [],
      artifacts: [],
    };
  } catch (error) {
    if (!(error instanceof CoverageReportError)) throw error;
    // EXIT 1, NOT 2. The invocation was correct and the run succeeded; a file
    // that is missing or unreadable is a fact about this repository's tooling,
    // which is the same class this CLI answers 1 for everywhere else.
    if (!options.touched) {
      return {
        total: null,
        targets: [],
        source,
        exitCode: 1,
        why: "the run succeeded and its report could not be read -- see below",
        note: error.message,
        groups: [],
        artifacts: [],
      };
    }
    // UNDER --touched THE REMAINING REPORTS ARE STILL READ, and the first one's
    // failure is listed among them: the run stays exit 1, but a sound second
    // report still answers for the files it measured, and `touched.artifacts`
    // names every report that did not (Copilot on zheref/nen#254).
    const sources = readTouchedSources(run, repoRoot, {
      artifact,
      parsed: null,
      rows: null,
      error: error.message,
    });
    const failed = sources.artifacts.filter((entry): boolean => entry.error !== null);
    return {
      total: null,
      targets: [],
      source,
      exitCode: 1,
      why: `the run succeeded and ${failed.length} of its declared reports could not be read -- see below`,
      note: failed.map((entry): string => entry.error ?? "").join("\n"),
      groups: sources.groups,
      artifacts: sources.artifacts,
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
  validateFromCapture(options);
  const ladder = readLadder(repoRoot, options, threshold);
  if (options.touched) verifyBase(context, repoRoot, options.base as string);
  if (options.fromCapture === true) return fromCapture(context, repoRoot, options, threshold, ladder);
  // A HOLDER RATHER THAN A `let`: the assignment happens inside a callback, and
  // a `let` narrowed to `null` at its declaration is a type error at every read
  // below -- the compiler does not follow a closure it did not call.
  const captured: { report: ShuReport | null } = { report: null };
  const sink = (report: ShuReport): void => {
    captured.report = report;
  };

  let exitCode: number;
  try {
    // THE RUN RECORDS ITS CAPTURE'S PROVENANCE (zheref/nen#250): the tree's
    // fingerprint before it starts, the reports' hashes once it has exited 0
    // -- the sidecar `--from-capture` later proves a capture against.
    exitCode = await recordCapture(
      context,
      repoRoot,
      { lane: options.lane, verb: "coverage", recordAs: "coverage", dryRun: options.dryRun },
      () =>
        runVerb(context, repoRoot, {
          verb: "coverage",
          lane: options.lane,
          dryRun: options.dryRun,
          // NEITHER FLAG BELONGS TO THIS VERB. `coverage` takes no destination
          // and has no `--run` gate -- ./command.ts's per-subcommand flag table
          // refuses both on it -- and the executor reads them only for the
          // verbs that do.
          target: null,
          run: false,
          sink,
          effort: options.effort ?? null,
        }),
    );
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
      report(context, captured.report, renderReport(captured.report), repoRoot, options, threshold, ladder, error.code, null);
    }
    throw error;
  }

  const run = captured.report;
  /* c8 ignore next 2 -- runVerb emits exactly once on every path that returns */
  if (run === null) return exitCode;
  return report(context, run, renderReport(run), repoRoot, options, threshold, ladder, exitCode, null);
}

/**
 * `--touched --from-capture`: the table from the reports already on disk, with
 * NO run (zheref/nen#250) -- once nen has PROVED them a capture of this tree.
 *
 * THE INVOCATION IS RESOLVED, NOT RUN, and that is deliberate: the reports are
 * a property of `project.verbs.<lane>.coverage.artifacts`, so reading them
 * means rendering that invocation, with every refusal it carries -- a lane
 * that seats `coverage` is still exit 4 in its own words, a host the
 * declaration excludes still 3, an unknown lane still 2. `test-report
 * --from-artifacts` reads its results the same way. ./run.ts is never called,
 * so neither the declared argv nor a precondition probe is spawned: the only
 * subprocesses are nen's own fixed-argv git reads.
 *
 * THE PROOF COMES BEFORE THE PARSE. The sidecar the producing run wrote is
 * read; the tree is fingerprinted NOW and the reports hashed NOW
 * (./coverage/capture.ts says what, and why no clock is involved); and any
 * difference -- or no sidecar at all -- is refused at
 * EXIT_COVERAGE_STALE_CAPTURE naming every reason, with no document: nothing
 * was measured, and a document would be another tree's numbers beside a
 * refusal code. A proven capture is handed to the SAME parse, join, banding
 * and document a run's report gets, at exit 0 for the read, so the `touched`
 * shape and the 6 for "joined nothing" are exactly what the run form produces.
 */
function fromCapture(
  context: CommandContext,
  repoRoot: string,
  options: CoverageOptions,
  threshold: number | null,
  ladder: CoverageLadderReport | null,
): number {
  const { project } = openDeclaration(repoRoot);
  const plan = renderInvocation(project, {
    lane: options.lane,
    verb: "coverage",
    platform: context.seams.platform,
  });
  const cwd = insideRepo(repoRoot, plan.cwdRelative, `project.lanes.${plan.lane}.cwd`);
  const reports = plan.artifacts.filter((value): boolean => recognisedByName(value));
  const digests = digestArtifacts(repoRoot, plan.lane, reports);
  const problems = proveCapture(context, repoRoot, plan.lane, reports, digests);
  if (problems.length > 0) throw new ShuRefusal(EXIT_COVERAGE_STALE_CAPTURE, captureRefusal(problems));
  const files = touchedFiles(context, repoRoot, options.base as string);
  const present = new Set(digests.filter((entry): boolean => entry.sha256 !== null).map((entry): string => entry.path));
  const run: CoverageRun = {
    lane: plan.lane,
    stack: plan.stack,
    cwd,
    artifacts: plan.artifacts.map(
      (value): ShuArtifactReport => ({ kind: "path", value, exists: present.has(value) || existsOnDisk(repoRoot, value) }),
    ),
  };
  const header = renderFromCapture(plan.lane, plan.stack, reports, sidecarPath(plan.lane));
  return report(context, run, header, repoRoot, { ...options, dryRun: false }, threshold, ladder, 0, files);
}

/**
 * Every reason the capture on disk is not proven a capture of this tree.
 *
 * NO SIDECAR AND NO REPORT ARE REFUSALS TOO. A lane that declares no report nen
 * reads has nothing to reuse; the run form answers that at exit 1 with the
 * field to declare, and this form refuses it rather than reporting a table of
 * nothing as if it had been proven.
 */
function proveCapture(
  context: CommandContext,
  repoRoot: string,
  lane: string,
  reports: readonly string[],
  digests: ReturnType<typeof digestArtifacts>,
): readonly CaptureProblem[] {
  const path = sidecarPath(lane);
  const read = readCaptureSidecar(repoRoot, lane);
  if (read.state === "missing") return [{ reason: "no-sidecar", sidecar: path }];
  if (read.state === "unreadable") return [{ reason: "unreadable-sidecar", sidecar: path, why: read.why }];
  const now = takeFingerprint(context.seams, repoRoot, reports);
  if (!now.ok) {
    return [{ reason: "unreadable-sidecar", sidecar: path, why: `the tree cannot be fingerprinted now: ${now.why}` }];
  }
  return judgeCapture(read.sidecar, { lane, artifacts: digests, fingerprint: now.fingerprint, head: now.head });
}

function existsOnDisk(repoRoot: string, value: string): boolean {
  try {
    return statSync(join(repoRoot, value)).isFile();
  } catch {
    return false;
  }
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
  run: CoverageRun,
  header: readonly string[],
  repoRoot: string,
  options: CoverageOptions,
  threshold: number | null,
  ladder: CoverageLadderReport | null,
  exitCode: number,
  files: readonly string[] | null,
): number {
  // The executor's own rendering (or --from-capture's header), first: to
  // stdout as text, to stderr under --json so the one document on stdout
  // stays one document.
  const write = context.json ? context.io.err : context.io.out;
  for (const line of header) write(line);

  const parsed = parseAfterRun(run, repoRoot, options, exitCode);
  const touched = options.touched
    ? computeTouched(context, repoRoot, options.base as string, parsed, threshold, files)
    : null;
  // THE LADDER WAS DECIDED BEFORE THE RUN (see readLadder above): it is null
  // exactly when this invocation has none -- no --touched, or an explicit
  // --threshold overriding the file -- and otherwise carries the three rungs,
  // whether or not the repository declared them. Which rows there are and
  // whether they are banded are two separate questions, asked separately.
  const unjoined =
    touched !== null && !options.dryRun && parsed.exitCode === 0
      ? unjoinedSentence(parsed, touched.files, touched.filter)
      : null;
  const exit = unjoined === null ? parsed.exitCode : EXIT_COVERAGE_UNJOINED;
  const rows = touched === null ? parsed.targets : touched.filter.rows;
  const targets = ladder === null ? rows : bandRows(rows, ladder);
  const document: CoverageReport = assembleCoverage({
    lane: run.lane,
    stack: run.stack,
    total: parsed.total,
    targets,
    threshold,
    report: parsed.source,
    exitCode: exit,
    touched:
      touched === null
        ? null
        : {
            base: options.base as string,
            files: touched.files,
            matched: touched.filter.matched,
            unmatched: touched.filter.unmatched,
            artifacts: parsed.artifacts,
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
  if (unjoined !== null) context.io.err(unjoined);
  return exit;
}

/**
 * The refusal a `--touched` run gets when it measured NOTHING -- or null when
 * it measured something, or there was nothing to measure.
 *
 * zheref/nen#236 ACCEPTANCE 4. "0 of 58 matched" at exit 0 is indistinguishable
 * from "measured, and fine" to a caller reading `$?`, and on the repository
 * that reported it a declared 80% touched-file floor was being "enforced" by a
 * verb that had measured no file at all. So a non-empty touched set with no
 * match is EXIT_COVERAGE_UNJOINED (6), never 0 -- and the sentence shows both
 * path shapes side by side, because the likeliest cause is a root mismatch and
 * the fastest diagnosis is seeing `src/a.ts` next to `packages/core/src/a.ts`.
 *
 * AN EMPTY TOUCHED SET IS NOT THIS. A diff that names no file has nothing to
 * join, and "nothing touched, nothing measured" is a true answer at exit 0.
 * A diff that touches only files no test measures (a README) IS this, on
 * purpose: nen cannot tell "nothing to measure" from "could not join" by
 * looking, and the one it must never do is report either as a pass.
 */
function unjoinedSentence(
  parsed: Parsed,
  files: readonly string[],
  filter: TouchedFilter,
): string | null {
  if (files.length === 0 || filter.matched.length > 0) return null;
  const rows = parsed.groups.flatMap((group): readonly CoverageTarget[] => group.rows);
  // A per-file view's UNRESOLVED names are shown beside the rows: when a
  // Cobertura report resolved nothing, they are the only path shape the
  // report used, and "(none)" would hide exactly what went wrong.
  const unresolved = parsed.artifacts.flatMap((entry): readonly string[] =>
    (entry.unresolved ?? []).map((name): string => name.name),
  );
  const sample = (values: readonly string[]): string =>
    values.length === 0 ? "(none)" : values.slice(0, 2).map((value): string => `'${value}'`).join(", ");
  const roots = parsed.artifacts
    .map((entry): string =>
      entry.error !== null
        ? `${entry.path} (not read)`
        : `${entry.path} -> root ${entry.root ?? "(package rows, no root)"}`,
    )
    .join("; ");
  const unresolvedNote =
    unresolved.length === 0
      ? ""
      : ` (plus ${unresolved.length} file name${unresolved.length === 1 ? "" : "s"} a report stated that resolved to no file in this tree, never matched)`;
  return `--touched joined 0 of ${files.length} touched file${files.length === 1 ? "" : "s"} to the ${rows.length} row${rows.length === 1 ? "" : "s"} nen read${unresolvedNote}, so NOTHING was measured -- exit ${EXIT_COVERAGE_UNJOINED}, not 0. Path shape SEEN in the report rows: ${sample([...rows.map((row): string => row.name), ...unresolved])}. Path shape EXPECTED, as git names the touched files (repo-relative): ${sample(files)}. Roots used: ${roots === "" ? "(none)" : roots}. If the two shapes should meet, the report was written from a root nen did not infer -- declare the artifact under the directory its tool ran in (e.g. '<package>/coverage/lcov.info'), or have the tool write repo-relative paths. If they should not -- the change touches no file any test measures -- this is still not a pass: nen cannot tell 'nothing to measure' from 'could not join' by looking.`;
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
  known: readonly string[] | null,
): { readonly files: readonly string[]; readonly filter: TouchedFilter; readonly grain: CoverageGrain | null } {
  // --from-capture has already read the touched set to judge the capture
  // against it; asking git twice could only produce a second answer.
  const files = known ?? touchedFiles(context, repoRoot, base);
  // EVERY DECLARED REPORT, EACH AT ITS OWN GRAIN (zheref/nen#236): `groups`
  // is one entry per report nen read, already rebased onto that report's
  // root, and empty on every path that parsed nothing.
  return { files, filter: filterTouchedGroups(parsed.groups, files, threshold), grain: touchedGrain(parsed) };
}

/**
 * `git -c core.quotePath=false diff --name-only -z <base>...HEAD`, in the
 * repository root, split on NUL.
 *
 * `-z` AND `core.quotePath=false`, BOTH (hanten round 1 on zheref/nen#250,
 * N1). Without them git C-quotes any path with a byte outside printable ASCII
 * -- `src/café.ts` arrives as `"src/caf\303\251.ts"` -- and that string
 * matches no report row, so the one non-ASCII file a change touched was
 * reported `unmatched` with nothing to say why. NUL is the one byte a path
 * cannot hold, so the split is exact.
 */
function touchedFiles(context: CommandContext, repoRoot: string, base: string): readonly string[] {
  const result = must(
    context.seams,
    GIT,
    ["-c", "core.quotePath=false", "diff", "--name-only", "-z", `${base}...HEAD`],
    { cwd: repoRoot },
  );
  // `rawLines`, NEVER `outputLines`: THESE ARE PATHS, AND A PATH'S SPACES ARE
  // PART OF IT. ../seam/lines.ts exists for exactly this distinction --
  // `outputLines` trims, which is right for turning a subprocess's stderr into
  // a sentence and wrong for output whose exact columns are the data. A file
  // committed as `src/ odd .ts` is a file git names with its spaces intact, and
  // a trimmed copy of that name matches no coverage row, so the one file the
  // caller most needs banded would be reported `unmatched` with nothing to say
  // why. (Raised by Copilot on zheref/nen#147.) A NUL split keeps them too.
  return nulPaths(result.stdout);
}

/**
 * The grain the text rendering NARRATES, or null for no note.
 *
 * FROM EVERY REPORT READ, NOT THE FIRST: "rows matched BY PACKAGE" under a
 * package-grain first report would be false of a file-grain second one's rows
 * (Copilot on zheref/nen#254). Mixed grains get no global note -- each report's
 * own `from:` line already says which kind of rows it has. With no report read
 * at all (a dry run, a failed run), the first declared report's format answers,
 * as it always has.
 */
function touchedGrain(parsed: Parsed): CoverageGrain | null {
  // BEFORE ANY REPORT IS READ, cobertura's grain is not the format's to say:
  // its bytes decide (file rows whenever its classes name files), so a
  // preview carries no "BY PACKAGE" note for it (zheref/nen#296).
  if (parsed.groups.length === 0) return parsed.source === null ? "file" : expectedGrainOf(parsed.source.format);
  const grains = new Set(parsed.groups.map((group): CoverageGrain => group.grain));
  return grains.size === 1 ? (parsed.groups[0]?.grain ?? "file") : null;
}
