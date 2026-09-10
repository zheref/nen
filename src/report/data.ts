// src/report/data.ts -- the one document `nen report data` assembles: what an
// effort's branch contains, as facts, with nothing decided about them.
//
// IT READS AND NEVER WRITES. Not "writes only with a flag" -- there is no write
// path in this module at all, which is what lets a caller poll it (izanami
// classifies it read-only) and what makes it safe to run in the middle of a
// build. Every path it opens is one the caller named or one the repository's own
// declaration named; it creates no directory and touches no ref.
//
// EVERY ABSENCE IS `null`, AND `null` IS NEVER A FAILURE. Four of this
// document's fields describe things that legitimately are not there yet -- a
// repository with no coverage report, no build proof, no recorded stop, no tier
// table -- and a report verb that refused on any of them would be a report you
// could only run at the end. So an absent artifact is `null` and an absent tier
// is `null`, in a document whose shape does not otherwise change. What is NOT
// folded into a null is a git command that FAILS: an unresolvable `--base` is a
// refusal naming the ref (../wc/classify.ts's own rule -- "not checked" must
// never render as "clean"), because a commit list computed from a ref that does
// not exist is a confident wrong answer rather than an empty one.
//
// THE COVERAGE READ IS A READ OF A REPORT ALREADY ON DISK, and that is the whole
// difference between this and `nen shu coverage`, which RUNS the lane's coverage
// verb and then parses what the run produced. Both end in ../shu/coverage/parse
// .ts -- one parser, five formats, no second opinion about what an lcov file
// says -- and this one spawns nothing: it asks the declaration which file the
// coverage verb writes, and reads it if it is there. A stale report is possible
// and is the caller's to know about (`generatedAt` is this document's instant,
// not the report's); `nen shu coverage` is the verb that guarantees freshness by
// producing it.
//
// `repo` IS THE DIRECTORY'S NAME AND NEVER ITS PATH. This document is filled
// into a report that gets pasted into a pull request, and an absolute path
// carries the developer's account name and directory layout out of the machine
// that ran it -- the same leak ../shu/coverage.ts's `relativiseName` exists to
// close, arriving through a different field. The name is what a report wants to
// print anyway.

import { basename } from "node:path";
import { existsSync, readFileSync } from "node:fs";
import { VerbUsageError } from "../cli/command.js";
import { containedPath } from "../repo/contain.js";
import { proofRelativePath } from "../shu/proof.js";
import { openDeclaration } from "../shu/declaration.js";
import { formatNamedBy, readReport } from "../shu/coverage/parse.js";
import type { CoverageMeasure, CoverageTarget } from "../shu/coverage/shape.js";
import { GIT, normalizeEol, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";

export const DATA_CONTRACT = "nen.report.data/v0.1";

export interface ReportCommit {
  readonly sha: string;
  readonly subject: string;
  readonly author: string;
  /** Author date, ISO 8601 with offset, exactly as git prints `%aI`. */
  readonly date: string;
}

export interface ReportFile {
  /**
   * The path as of HEAD. For a rename or a copy this is the DESTINATION -- the
   * file that exists now -- and the source survives in `status` only as git's
   * similarity score, because this document's `path` is the thing a reader goes
   * and opens.
   */
  readonly path: string;
  /** git's own status token: `M`, `A`, `D`, `R100`, `C085`, … */
  readonly status: string;
  /** The caller's `--tiers` table, or null when it named no tier for this path. */
  readonly tier: string | null;
}

/**
 * ONE EVIDENCE ROW -- the shape this field will carry, declared now and produced
 * by nobody yet. See `evidenceRows()`.
 */
export interface ReportEvidence {
  readonly suite: string;
  readonly scene: string;
  readonly path: string;
  readonly status: string;
}

export interface ReportCoverage {
  readonly lane: string;
  /** The parser that read it (`lcov`, `istanbul-summary`, …). */
  readonly format: string;
  /** Repo-relative, as the declaration wrote it. */
  readonly path: string;
  readonly total: CoverageMeasure;
  readonly targets: readonly CoverageTarget[];
}

/** KEY ORDER IS THE CONTRACT; ./data.test.ts pins it. */
export interface ReportData {
  readonly contract: string;
  readonly repo: string;
  /** null means a detached HEAD -- this checkout is not on a branch. */
  readonly branch: string | null;
  readonly base: string;
  readonly generatedAt: string;
  readonly commits: readonly ReportCommit[];
  readonly files: readonly ReportFile[];
  readonly evidence: readonly ReportEvidence[];
  readonly coverage: ReportCoverage | null;
  /** `.nen/proof/<lane>.json`, verbatim, or null. */
  readonly proof: unknown;
  /** `.nen/last-stop.json`, verbatim, or null. */
  readonly lastStop: unknown;
}

export interface DataOptions {
  readonly base: string;
  /** `--tiers <file>`'s parsed table, or null when the flag was not given. */
  readonly tiers: TierTable | null;
  /** `--lane`, or the declaration's `defaultLane`, or null. */
  readonly lane: string | null;
}

/** `{ "<tier>": ["<prefix or glob>", …] }`, in the file's own key order. */
export type TierTable = ReadonlyMap<string, readonly string[]>;

// ── git ─────────────────────────────────────────────────────────────────────

/**
 * A UNIT SEPARATOR, NOT A TAB OR A PIPE. `git log --format` puts whatever the
 * commit says into `%s` and `%an`, and both can legitimately contain a tab, a
 * pipe or any other printable character somebody picked as a delimiter -- so a
 * subject with a tab in it would silently move the author into the date column.
 * `%x1f` is the ASCII field separator; git emits it literally and a commit
 * message cannot contain one, because git strips control characters from the
 * subject line it stores.
 */
const FIELD = "\u001f";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;

function git(seams: Seams, root: string, args: readonly string[]): { code: number; stdout: string; stderr: string } {
  const result = seams.run(GIT, [...args], { cwd: root });
  return {
    code: result.spawnFailed ? -1 : result.code,
    stdout: result.stdout,
    stderr: result.spawnFailed ? result.stderr : outputLines(result.stderr).join(" ") || `exit ${result.code}`,
  };
}

/**
 * The branch this checkout is on, or null for a detached HEAD.
 *
 * A FAILURE HERE IS NOT A REFUSAL, and this is the one place in the module where
 * that is true: `git symbolic-ref` fails for exactly one ordinary reason -- HEAD
 * is detached -- and a report that refused to describe a detached checkout would
 * be refusing to describe the state a bisect, a tag build and a CI checkout are
 * all in. The refusals that matter (this is not a repository at all; `--base`
 * does not resolve) are raised by the two reads below, both of which run against
 * the same directory moments later.
 */
export function readBranch(seams: Seams, root: string): string | null {
  const result = git(seams, root, ["symbolic-ref", "--short", "HEAD"]);
  return result.code === 0 ? result.stdout.trim() : null;
}

/**
 * `--base` resolved to a commit, or a refusal naming it.
 *
 * EXIT 2, NOT 1. A ref that does not resolve is a mistyped flag: no retry fixes
 * it, and the two reads that follow would each fail with git's own wording about
 * an "unknown revision" that never names the flag it came from.
 */
export function assertBase(seams: Seams, root: string, base: string): void {
  const result = git(seams, root, ["rev-parse", "--verify", "--quiet", `${base}^{commit}`]);
  if (result.code === 0) return;
  throw new VerbUsageError(
    `--base '${base}' does not resolve to a commit in this repository. It names the ref this branch is measured AGAINST -- the trunk, or the point the effort was cut from -- so 'origin/main' usually needs a 'git fetch' first. Nothing was read: a commit list computed from a ref that is not there would be an empty answer that looks like a checked one.`,
  );
}

/**
 * `git log <base>..HEAD`, newest first, as git orders it.
 *
 * NOT A `VerbUsageError`. `--base` is already known to resolve (`assertBase`
 * runs first) -- a failure here is git itself refusing ('not a git
 * repository', a corrupt object), never a mistyped flag, so it is a plain
 * `Error` and falls to `runFamily`'s "anything else is exit 1", matching this
 * family's own documented contract (`command.ts`'s `USAGE`, docs/USAGE.md).
 */
export function readCommits(seams: Seams, root: string, base: string): readonly ReportCommit[] {
  const result = git(seams, root, ["log", `${base}..HEAD`, `--format=${LOG_FORMAT}`]);
  if (result.code !== 0) {
    throw new Error(
      `could not read the commits on this branch ('git log ${base}..HEAD' failed: ${result.stderr}). Refusing to report an empty commit list, which would read as a branch with nothing on it.`,
    );
  }
  return rawLines(result.stdout).map((line): ReportCommit => {
    const [sha = "", subject = "", author = "", date = ""] = line.split(FIELD);
    return { sha, subject, author, date };
  });
}

/**
 * `git diff --name-status <base>...HEAD` -- THREE DOTS.
 *
 * The three-dot form diffs against the MERGE BASE, so a trunk that has moved on
 * since the branch was cut does not show up as this effort's changes. That is
 * the same set a pull request shows, which is the set a report about a pull
 * request is describing.
 *
 * NOT A `VerbUsageError`, for the same reason as `readCommits` above: `--base`
 * is already known to resolve, so a failure here is git itself refusing, not a
 * mistyped flag, and falls to `runFamily`'s "anything else is exit 1".
 */
export function readFiles(
  seams: Seams,
  root: string,
  base: string,
  tiers: TierTable | null,
): readonly ReportFile[] {
  const result = git(seams, root, ["diff", "--name-status", `${base}...HEAD`]);
  if (result.code !== 0) {
    throw new Error(
      `could not read the changed files ('git diff --name-status ${base}...HEAD' failed: ${result.stderr}). Refusing to report an empty file list, which would read as a branch that changed nothing.`,
    );
  }
  return rawLines(result.stdout).map((line): ReportFile => {
    // A rename/copy row is `R100\t<old>\t<new>`; every other row is
    // `<status>\t<path>`. The LAST field is the path as of HEAD either way,
    // which is what makes one expression right for both.
    const fields = line.split("\t");
    const status = (fields[0] ?? "").trim();
    const path = (fields.at(-1) ?? "").trim();
    return { path, status, tier: tierOf(path, tiers) };
  });
}

// ── tiers ───────────────────────────────────────────────────────────────────

/**
 * `--tiers <file>`, validated at the read seam.
 *
 * THE FILE'S KEY ORDER IS THE PRECEDENCE, and the first tier whose patterns
 * match a path wins. That is a decision the CALLER makes by writing the file in
 * an order, rather than one nen makes by sorting or by "most specific first" --
 * "most specific" is a judgement about somebody else's layout, and a report verb
 * does not make judgements.
 */
export function parseTiers(document: unknown, display: string): TierTable {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    throw new VerbUsageError(
      `'${display}' is not a tier table. It is a JSON object mapping a tier name to its paths: { "<tier>": ["<path prefix or glob>", …] }.`,
    );
  }
  const table = new Map<string, readonly string[]>();
  for (const [tier, patterns] of Object.entries(document)) {
    if (!Array.isArray(patterns) || patterns.some((entry): boolean => typeof entry !== "string")) {
      throw new VerbUsageError(
        `'${display}': tier '${tier}' is not a list of path patterns. Each tier names an array of strings -- a path prefix ('src/report'), or a glob ('src/**/*.test.ts').`,
      );
    }
    table.set(tier, patterns as readonly string[]);
  }
  return table;
}

/** The first tier whose patterns claim this path, in the table's own order. */
export function tierOf(path: string, tiers: TierTable | null): string | null {
  if (tiers === null) return null;
  for (const [tier, patterns] of tiers) {
    if (patterns.some((pattern): boolean => matchesPattern(path, pattern))) return tier;
  }
  return null;
}

/**
 * A PREFIX OR A GLOB, decided by whether the pattern has a metacharacter in it.
 *
 * A pattern with no `*` or `?` is a PATH PREFIX, matched on SEGMENT BOUNDARIES:
 * `src/report` claims `src/report/data.ts` and does not claim `src/reporting.ts`
 * -- a bare `startsWith` would claim both, and a tier table that silently
 * over-claims is worse than one that misses, because the over-claim is invisible
 * in the report it produces.
 *
 * A pattern WITH one is a glob, in the narrow shell reading: `?` is one
 * character other than `/`, `*` is any run of characters other than `/`, and
 * `**` crosses separators. This is deliberately not a globbing LIBRARY -- no
 * brace expansion, no character classes, no extglob -- because a tier table is
 * a handful of directory patterns and every construct beyond these is one more
 * thing a report's tier column can be wrong about.
 */
export function matchesPattern(path: string, pattern: string): boolean {
  if (pattern === "") return false;
  if (!/[*?]/.test(pattern)) {
    const prefix = pattern.replace(/\/+$/, "");
    return path === prefix || path.startsWith(`${prefix}/`);
  }
  return globToRegExp(pattern).test(path);
}

function globToRegExp(pattern: string): RegExp {
  let source = "";
  for (let index = 0; index < pattern.length; index += 1) {
    const character = pattern[index] as string;
    if (character === "*") {
      if (pattern[index + 1] === "*") {
        source += ".*";
        index += 1;
        // `a/**/b` must also match `a/b`: the separator after `**` is optional.
        if (pattern[index + 1] === "/") index += 1;
        continue;
      }
      source += "[^/]*";
      continue;
    }
    if (character === "?") {
      source += "[^/]";
      continue;
    }
    source += character.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}

// ── the artifacts under .nen/ and the declaration ───────────────────────────

/**
 * A JSON artifact this verb reports VERBATIM, or null.
 *
 * VERBATIM, AND THEREFORE UNVALIDATED. `.nen/proof/<lane>.json` and
 * `.nen/last-stop.json` are written by the harness around nen (the brief's
 * `rasengan` and `jutaisho`), not by this binary, and this release has no schema
 * for either -- so nen carries what is there rather than inventing a shape to
 * hold it to and refusing a file a later version writes one field differently.
 * A file that is not JSON at all is `null` with the reason on stderr: a report
 * is not the place to fail a run over a marker file.
 */
export function readJsonArtifact(absolute: string, display: string, warn: (line: string) => void): unknown {
  if (!existsSync(absolute)) return null;
  try {
    return JSON.parse(normalizeEol(readFileSync(absolute, "utf8"))) as unknown;
  } catch (error) {
    warn(`${display} is present and is not valid JSON (${error instanceof Error ? error.message : String(error)}); reported as null.`);
    return null;
  }
}

/**
 * A path under `.nen/` for this lane, refused when the lane name escapes it.
 *
 * `--lane ../../etc/passwd` would otherwise address a file outside the tree
 * through a flag whose whole meaning is "a key in this repository's own
 * declaration". Exit 2, naming it.
 */
export function proofPath(root: string, lane: string): string {
  // WHERE A PROOF LIVES IS ../shu/proof.ts's FACT, not this file's. That module
  // writes the file (`nen shu build`) and `nen commit check` reads it; a second
  // spelling of the path here would be a second answer the day it moves. Only
  // the refusal is this verb's own, because it names THIS verb's flag.
  const absolute = containedPath(root, proofRelativePath(lane));
  if (absolute === null) {
    throw new VerbUsageError(
      `--lane '${lane}' resolves outside the repository (the build proof would be read from '${proofRelativePath(lane)}'). A lane is a key in this repository's own declaration, not a path.`,
    );
  }
  return absolute;
}

/**
 * The lane's coverage report, parsed, or null.
 *
 * EVERY REASON THERE IS NOTHING TO REPORT ENDS IN THE SAME `null`, with the
 * reason on stderr: no declaration, no lane, no `coverage` verb, no artifact nen
 * recognises, the file not written yet, or a file that does not parse. They are
 * six different sentences and one answer, because the caller of a REPORT verb
 * asked "what is the coverage" and the honest answer to all six is "there is
 * none to show" -- `nen shu coverage` is the verb that turns each of them into a
 * refusal with a repair, and it is named in every one of these lines.
 */
export function readCoverage(
  root: string,
  lane: string | null,
  warn: (line: string) => void,
): ReportCoverage | null {
  if (lane === null) return null;
  let artifacts: readonly string[];
  try {
    artifacts = declaredArtifacts(root, lane);
  } catch (error) {
    warn(`coverage: ${error instanceof Error ? error.message : String(error)} Reported as null.`);
    return null;
  }
  const declared = artifacts.find((entry): boolean => formatNamedBy(entry) !== null);
  if (declared === undefined) {
    warn(
      `coverage: lane '${lane}' declares no artifact nen recognises as a coverage report, so there is none to read. 'nen shu coverage --repo <path> --lane ${lane}' names the repair.`,
    );
    return null;
  }
  const absolute = containedPath(root, declared);
  if (absolute === null || !existsSync(absolute)) {
    warn(
      `coverage: lane '${lane}' declares '${declared}', which is not there. Run 'nen shu coverage --repo <path> --lane ${lane}' to produce it; reported as null.`,
    );
    return null;
  }
  try {
    const parsed = readReport(absolute, declared);
    return {
      lane,
      format: parsed.format.id,
      path: declared,
      total: parsed.coverage.total,
      targets: parsed.coverage.targets,
    };
  } catch (error) {
    warn(`coverage: ${error instanceof Error ? error.message : String(error)} Reported as null.`);
    return null;
  }
}

/**
 * `project.verbs.<lane>.coverage.artifacts`, read off the declaration's
 * preserved `raw` block.
 *
 * OFF `raw` RATHER THAN OFF A TYPED FIELD, because the schema has no typed
 * field for it: ../schema/contract.ts's `Invocation` closes over what nen
 * EXECUTES (`exe`/`argv`, `steps`, `unsupported`) and preserves everything else
 * verbatim, and ../shu/render.ts reads `artifacts` out of that same `raw` for
 * the executor. Two readers of one key, both narrow, neither guessing: a value
 * that is not an array of strings is not an artifact list, and this one answers
 * "no artifacts" rather than refusing, because ../shu/render.ts is the reader
 * whose job is to refuse it.
 */
export function declaredArtifacts(root: string, lane: string): readonly string[] {
  const project = openDeclaration(root).project;
  const invocation = project.verbs[lane]?.["coverage"];
  if (invocation === undefined) {
    throw new VerbUsageError(`lane '${lane}' declares no 'coverage' verb, so there is no report to read.`);
  }
  const declared = invocation.raw["artifacts"];
  if (!Array.isArray(declared)) return [];
  return declared.filter((entry): entry is string => typeof entry === "string");
}

/**
 * `evidence` IS EMPTY IN THIS RELEASE, AND THE EMPTY LIST IS THE SEAM.
 *
 * The rows belong to `nen shu evidence --base <ref>`, which reads
 * `project.evidence` (globs, mechanism, a `{suite}-{scene}` template) and groups
 * the changed artifacts it finds -- and that verb does not exist yet. Two things
 * follow, and both are deliberate. The FIELD ships now, so a template written
 * against this contract does not change shape when the verb lands: `{{#each
 * evidence}}` renders nothing today and renders rows tomorrow. And the GLOBBING
 * is not implemented here, even though ./data.ts already has a matcher a few
 * screens up: that matcher answers "which tier is this path in" over paths git
 * already listed, while evidence means walking a tree for files git may not have
 * changed -- a different question, whose answers must come from the ONE verb
 * that owns `project.evidence`, or the two will disagree about what an evidence
 * row is the first time the scene template changes.
 */
export function evidenceRows(): readonly ReportEvidence[] {
  return [];
}

// ── the document ────────────────────────────────────────────────────────────

/** Everything above, in the contract's key order. */
export function assembleData(
  seams: Seams,
  root: string,
  options: DataOptions,
  warn: (line: string) => void,
): ReportData {
  assertBase(seams, root, options.base);
  const lastStop = containedPath(root, ".nen/last-stop.json");
  return {
    contract: DATA_CONTRACT,
    repo: basename(root),
    branch: readBranch(seams, root),
    base: options.base,
    generatedAt: seams.now().toISOString(),
    commits: readCommits(seams, root, options.base),
    files: readFiles(seams, root, options.base, options.tiers),
    evidence: evidenceRows(),
    coverage: readCoverage(root, options.lane, warn),
    proof:
      options.lane === null
        ? null
        : readJsonArtifact(proofPath(root, options.lane), proofRelativePath(options.lane), warn),
    /* c8 ignore next -- containedPath cannot reject a literal relative path */
    lastStop: lastStop === null ? null : readJsonArtifact(lastStop, ".nen/last-stop.json", warn),
  };
}

/** The compact human summary. `--json` carries the document itself. */
export function renderData(data: ReportData): readonly string[] {
  const lines: string[] = [
    `repo: ${data.repo}${data.branch === null ? " (detached HEAD)" : ` on '${data.branch}'`}, base '${data.base}'`,
    `generated: ${data.generatedAt}`,
    `commits: ${data.commits.length}`,
  ];
  for (const commit of data.commits) lines.push(`  ${commit.sha.slice(0, 8)} ${commit.subject}`);
  const tiered = data.files.filter((file): boolean => file.tier !== null).length;
  lines.push(`files: ${data.files.length}${tiered === 0 ? "" : ` (${tiered} tiered)`}`);
  for (const file of data.files) {
    lines.push(`  ${file.status.padEnd(4)} ${file.path}${file.tier === null ? "" : `  [${file.tier}]`}`);
  }
  lines.push(
    `evidence: ${data.evidence.length} row(s) -- 'nen shu evidence' fills this; this verb never globs a tree`,
  );
  lines.push(`coverage: ${renderCoverageLine(data.coverage)}`);
  lines.push(`proof: ${data.proof === null ? "none" : "present"}`);
  lines.push(`last stop: ${data.lastStop === null ? "none" : "present"}`);
  return lines;
}

function renderCoverageLine(coverage: ReportCoverage | null): string {
  if (coverage === null) return "none read";
  const percent = coverage.total.lines.percent;
  return `${percent === null ? "no lines measured" : `${percent}% lines`} on '${coverage.lane}' (${coverage.format}, ${coverage.path})`;
}
