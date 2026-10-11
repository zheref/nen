// src/shu/focused-guard.ts -- the proof a focused run's results path must pass
// before nen moves it aside, and the move itself (zheref/nen#207; the
// maintainer's structural ruling on PR #393).
//
// WHY THIS IS AN ALLOWLIST AND A PROOF, NOT A DENYLIST. The first guard asked
// "is this something nen must never delete?" -- the root, `.git`, `nen/`,
// anything `git ls-files` lists -- and a review reproduced it failing open
// four ways, each one deleting data: a case variant (`SRC`, which the
// case-sensitive pathspec does not list and a case-insensitive filesystem
// resolves to `src/`), a tracked symlink ancestor (`out -> src`, where
// ls-files stops at the link and the delete follows it), untracked work and a
// nested worktree (which git cannot list because it does not own them), and a
// submodule (whose content the superproject lists as one gitlink). A
// question with that many ways to answer "nothing here" wrongly is the wrong
// question. So:
//
//   1. the loader admits a results path only STRICTLY INSIDE `.nen/focused/`,
//      the directory nen owns for this (../schema/contract.ts);
//   2. before anything moves, and on `--dry-run` too, every read-only proof
//      below must hold, or the run is exit 2 having moved nothing;
//   3. nothing is DELETED to clear the path: it is RENAMED into
//      `.nen/focused/.previous/<run-id>/`, and only that area is ever pruned
//      -- after the same proof, keeping the last PREVIOUS_KEPT runs. A guard
//      miss then costs a rename, not data.
//
// THE PROOFS, IN ORDER -- each is a fact about the REAL filesystem, asked
// with lstat (never following a link) and realpath.native:
//
//   * every segment from the real root down to the path is a real directory
//     entry: no symlink, no junction or other reparse point (Node reports a
//     junction as a symlink; any other redirection shows up as a realpath
//     that differs from the segment's own path), and no case variant of an
//     existing entry;
//   * the path's real path is inside the real `.nen/focused`, and the real
//     root is not inside that;
//   * no `.git` entry, file or directory, exists at or below it -- no nested
//     repository, worktree or submodule;
//   * the real git directory (`git rev-parse --git-dir`) does not overlap it;
//   * `git --literal-pathspecs ls-files --recurse-submodules -z -- <path>`
//     lists nothing (belt and braces: the allowlist already excludes source).
//
// A git that cannot be started, or answers anything but a listing or "not a
// git repository", REFUSES: a question nen could not settle is never read as
// a yes.

import { lstatSync, mkdirSync, readdirSync, realpathSync, renameSync, rmSync, type Stats } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { GIT } from "../seam/exec.js";
import { FOCUSED_PREVIOUS, FOCUSED_RESULTS_DIR, focusedResultsRelative } from "../schema/contract.js";

/** How many moved-aside runs `.nen/focused/.previous` keeps. */
export const PREVIOUS_KEPT = 2;

/** The win32 file attribute a junction or any other reparse point carries. */
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;

/** What a successful proof established. */
export interface ClearProof {
  /** The real repository root. */
  readonly realRoot: string;
  /** The results path's own location under the real root (never a link). */
  readonly absolute: string;
  /** Repo-relative, `/`-separated, as on disk. */
  readonly relative: string;
  /** Whether anything is there to move aside. */
  readonly exists: boolean;
}

/** Two paths are one on this platform's rules (win32: case-insensitive). */
function samePath(a: string, b: string): boolean {
  return process.platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

/** `child` is `parent` or inside it, on this platform's rules. */
function within(child: string, parent: string): boolean {
  const c = process.platform === "win32" ? child.toLowerCase() : child;
  const p = process.platform === "win32" ? parent.toLowerCase() : parent;
  return c === p || c.startsWith(p.endsWith(sep) ? p : `${p}${sep}`);
}

function lstatOf(path: string): Stats | undefined {
  return lstatSync(path, { throwIfNoEntry: false });
}

/** A symlink, a junction, or (win32) any reparse point. */
function redirects(stats: Stats): boolean {
  if (stats.isSymbolicLink()) return true;
  const attributes = (stats as Stats & { attributes?: number }).attributes;
  return typeof attributes === "number" && (attributes & FILE_ATTRIBUTE_REPARSE_POINT) !== 0;
}

/**
 * The read-only proofs for one path under the real root. Throws
 * VerbUsageError (exit 2) naming the first that fails; touches nothing.
 */
function proveUnder(context: CommandContext, realRoot: string, rel: string, refuse: (why: string) => never): boolean {
  // EVERY SEGMENT, FROM THE ROOT DOWN, IS ITSELF: not a link, not a junction,
  // not a case variant of the entry the disk actually holds.
  let current = realRoot;
  let exists = true;
  for (const segment of rel.split("/")) {
    current = join(current, segment);
    const stats = lstatOf(current);
    if (stats === undefined) {
      exists = false;
      break;
    }
    if (redirects(stats)) refuse(`and '${relative(realRoot, current)}' on the way to it is a symlink or junction, which nen never follows`);
    const real = realpathSync.native(current);
    if (real !== current) {
      refuse(`and '${relative(realRoot, current)}' on the way to it really resolves to '${real}' -- a reparse point or a case variant of the entry on disk`);
    }
    if (!stats.isDirectory() && current !== join(realRoot, ...rel.split("/"))) {
      refuse(`and '${relative(realRoot, current)}' on the way to it is not a directory`);
    }
  }
  const absolute = join(realRoot, ...rel.split("/"));
  // INSIDE THE REAL `.nen/focused`, AND THE ROOT NOT INSIDE THAT.
  const focusedStats = lstatOf(join(realRoot, ...FOCUSED_RESULTS_DIR.split("/")));
  if (exists) {
    if (focusedStats === undefined) refuse(`and '${FOCUSED_RESULTS_DIR}' does not exist to hold it`);
    const realFocused = realpathSync.native(join(realRoot, ...FOCUSED_RESULTS_DIR.split("/")));
    const realResults = realpathSync.native(absolute);
    if (!within(realResults, realFocused) || samePath(realResults, realFocused)) {
      refuse(`which really resolves to '${realResults}', not strictly inside the real '${realFocused}'`);
    }
    if (within(realRoot, realFocused)) refuse(`and the real repository root '${realRoot}' is inside '${realFocused}'`);
    // NO `.git` AT OR BELOW: no nested repository, worktree or submodule.
    const nested = findGit(absolute);
    if (nested !== null) refuse(`and '${relative(realRoot, nested)}' is a git entry -- a nested repository, worktree or submodule lives there`);
  }
  // GIT: its own directory does not overlap, and it tracks nothing here.
  const gitDir = context.seams.run(GIT, ["rev-parse", "--git-dir"], { cwd: realRoot });
  if (gitDir.spawnFailed) refuse("and git could not be started to prove it holds nothing git owns");
  if (gitDir.code !== 0) {
    if (/not a git repository/i.test(gitDir.stderr)) return exists;
    refuse(`and 'git rev-parse --git-dir' failed (exit ${gitDir.code}), so nen cannot prove it holds nothing git owns`);
  }
  const reported = gitDir.stdout.trim();
  const gitPath = isAbsolute(reported) ? reported : join(realRoot, reported);
  const realGit = lstatOf(gitPath) === undefined ? gitPath : realpathSync.native(gitPath);
  if (within(realGit, absolute) || within(absolute, realGit)) {
    refuse(`which overlaps git's own directory '${realGit}'`);
  }
  const lsArgs = ["--literal-pathspecs", "-c", "core.quotePath=false", "ls-files", "--recurse-submodules", "-z", "--", rel];
  const tracked = context.seams.run(GIT, lsArgs, { cwd: realRoot });
  if (tracked.spawnFailed || tracked.code !== 0) {
    refuse(`and 'git ls-files' failed (exit ${tracked.code}), so nen cannot prove it holds no tracked file`);
  }
  const files = tracked.stdout.split("\0").filter((entry): boolean => entry !== "");
  if (files.length > 0) {
    refuse(`which holds ${files.length} file${files.length === 1 ? "" : "s"} git tracks (${files.slice(0, 3).map((file): string => `'${file}'`).join(", ")}${files.length > 3 ? ", ..." : ""})`);
  }
  return exists;
}

/** The first `.git` entry at or below `path`, never following a link; or null. */
function findGit(path: string): string | null {
  const stats = lstatOf(path);
  if (stats === undefined) return null;
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (name.toLowerCase() === ".git") return path;
  if (!stats.isDirectory() || redirects(stats)) return null;
  for (const entry of readdirSync(path)) {
    const found = findGit(join(path, entry));
    if (found !== null) return found;
  }
  return null;
}

/**
 * Prove the declared results path may be moved aside. Read-only: `--dry-run`
 * calls exactly this, and so does the real run immediately before moving.
 */
export function proveResultsClearable(
  context: CommandContext,
  repoRoot: string,
  declared: string,
  pointer: string,
  regressionOutputs: readonly string[],
): ClearProof {
  const refuse = (why: string): never => {
    throw new VerbUsageError(
      `${pointer} names '${declared}', ${why}. A results path must be GENERATED output strictly inside '${FOCUSED_RESULTS_DIR}/', which nen moves aside before every focused run. Nothing was moved or run.`,
    );
  };
  const rel = focusedResultsRelative(declared);
  if (rel === null) refuse(`which is not strictly inside '${FOCUSED_RESULTS_DIR}/'`);
  const relPath = rel as string;
  const realRoot = realpathSync.native(repoRoot);
  const absolute = join(realRoot, ...relPath.split("/"));
  // A REGRESSION OUTPUT THAT IS ITSELF A LINK INTO `.nen/focused` is the one
  // overlap the loader's lexical check cannot see; asked here of real paths.
  for (const output of regressionOutputs) {
    const target = resolve(realRoot, output);
    const realOutput = lstatOf(target) === undefined ? target : realpathSync.native(target);
    if (within(realOutput, absolute) || within(absolute, realOutput)) {
      refuse(`which overlaps '${output}', a regression output (really '${realOutput}')`);
    }
  }
  const exists = proveUnder(context, realRoot, relPath, refuse);
  return { realRoot, absolute: join(realRoot, ...relPath.split("/")), relative: relPath, exists };
}

/** A sortable, filesystem-safe id for this run's move-aside directory. */
function runId(context: CommandContext, previous: string): string {
  const stamp = context.seams.now().toISOString().replace(/[:.]/g, "-");
  let id = stamp;
  for (let n = 1; lstatOf(join(previous, id)) !== undefined; n += 1) id = `${stamp}-${String(n).padStart(3, "0")}`;
  return id;
}

/**
 * Move the proven results path aside into `.nen/focused/.previous/<run-id>/`,
 * then prune that area to the last PREVIOUS_KEPT runs -- each pruned entry
 * re-proved first, and kept (with a line on stderr) if the proof fails.
 */
export function moveResultsAside(context: CommandContext, proof: ClearProof): void {
  if (!proof.exists) return;
  const focused = join(proof.realRoot, ...FOCUSED_RESULTS_DIR.split("/"));
  const previous = join(focused, FOCUSED_PREVIOUS);
  const id = runId(context, previous);
  const inside = proof.relative.slice(FOCUSED_RESULTS_DIR.length + 1);
  const destination = join(previous, id, ...inside.split("/"));
  mkdirSync(dirname(destination), { recursive: true });
  renameSync(proof.absolute, destination);
  prunePrevious(context, proof.realRoot, previous);
}

function prunePrevious(context: CommandContext, realRoot: string, previous: string): void {
  const runs = readdirSync(previous).sort();
  for (const run of runs.slice(0, Math.max(0, runs.length - PREVIOUS_KEPT))) {
    const rel = `${FOCUSED_RESULTS_DIR}/${FOCUSED_PREVIOUS}/${run}`;
    try {
      proveUnder(context, realRoot, rel, (why: string): never => {
        throw new VerbUsageError(why);
      });
    } catch (error) {
      context.io.err(
        `nen kept '${rel}' rather than prune it: ${error instanceof Error ? error.message : String(error)}.`,
      );
      continue;
    }
    rmSync(join(previous, run), { recursive: true, force: true });
  }
}
