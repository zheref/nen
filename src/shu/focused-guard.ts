// src/shu/focused-guard.ts -- the proof a focused run's results path must pass
// before nen moves it aside, the move itself, the `.previous` area it moves
// into, and the lock that keeps two focused runs out of each other's way
// (zheref/nen#207; the maintainer's structural ruling on PR #393).
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
//      `.nen/focused/.previous/<run-id>/`, and only run ids nen itself minted
//      there are ever pruned -- after the same proof, keeping the last
//      PREVIOUS_KEPT runs. A guard miss costs a rename now; the moved run is
//      deleted only after PREVIOUS_KEPT further focused runs.
//
// THE PROOFS, IN ORDER -- each is a fact about the REAL filesystem, asked
// with lstat (never following a link) and realpath.native:
//
//   * every segment from the real root down to the path is a real directory
//     entry: no symlink (Node reports a win32 junction as one), and its
//     native realpath equals its own path -- which is what catches any other
//     reparse point and any case variant of an existing entry;
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
// a yes. `.previous` is proved the same way before a run id is chosen in it.
//
// WHAT IS LEFT, STATED RATHER THAN IMPLIED AWAY. Every act here re-verifies
// what it acts on immediately before acting: the move re-checks each ancestor's
// device and inode against what the proof saw, and a prune first RENAMES the
// doomed run to a unique `.doomed-<hex>` inside `.previous`, re-checks every
// ancestor and the renamed entry's own device and inode, and only then
// removes it. Between that last check and the syscall that acts on it there
// is still a window of microseconds in which another process could swap a
// directory for a link. nen does not close it: it assumes a SINGLE USER's
// working copy, where the only other writer is that user's own tooling, and
// the `.nen/focused/.lock` below keeps two focused runs from racing each
// other. A hostile local writer with access to the tree is out of scope.

import { closeSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { GIT } from "../seam/exec.js";
import { FOCUSED_LOCK, FOCUSED_PREVIOUS, FOCUSED_RESULTS_DIR, focusedResultsRelative } from "../schema/contract.js";

/** How many moved-aside runs `.nen/focused/.previous` keeps. */
export const PREVIOUS_KEPT = 2;

/**
 * The shape of a run id nen mints: `<ISO stamp with : and . as ->-<pid>-<6 hex>`.
 * Only entries of exactly this shape are ever pruned; anything else in
 * `.previous` is reported and never touched.
 */
export const RUN_ID = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z-\d+-[0-9a-f]{6}$/;

/** One existing entry the proof walked: where, and which inode it was. */
interface Seen {
  readonly path: string;
  readonly dev: number;
  readonly ino: number;
}

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
  /** Every existing entry from the root down, in order -- re-checked before acting. */
  readonly chain: readonly Seen[];
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

/** The `code` of a Node filesystem error, or null. */
function errno(error: unknown): string | null {
  return typeof error === "object" && error !== null && typeof (error as { code?: unknown }).code === "string"
    ? (error as { code: string }).code
    : null;
}

type Refuse = (why: string) => never;

/**
 * Walk `rel` from the real root, segment by segment: every existing segment is
 * a real entry (not a link; native realpath equal to its own path) and every
 * one but the last is a directory. Returns the entries seen; stops at the
 * first absent one.
 */
function walk(realRoot: string, rel: string, refuse: Refuse): { readonly exists: boolean; readonly chain: readonly Seen[] } {
  const segments = rel.split("/");
  const chain: Seen[] = [];
  let current = realRoot;
  for (const [index, segment] of segments.entries()) {
    current = join(current, segment);
    const stats = lstatOf(current);
    if (stats === undefined) return { exists: false, chain };
    const shown = relative(realRoot, current);
    if (stats.isSymbolicLink()) refuse(`and '${shown}' on the way to it is a symlink or junction, which nen never follows`);
    const real = realpathSync.native(current);
    if (real !== current) refuse(`and '${shown}' on the way to it really resolves to '${real}' -- a reparse point or a case variant of the entry on disk`);
    if (index < segments.length - 1 && !stats.isDirectory()) refuse(`and '${shown}' on the way to it is not a directory`);
    chain.push({ path: current, dev: stats.dev, ino: stats.ino });
  }
  return { exists: true, chain };
}

/** Re-check every entry the proof saw: still there, still not a link, same inode. */
function reverify(chain: readonly Seen[], refuse: Refuse): void {
  for (const seen of chain) {
    const now = lstatOf(seen.path);
    if (now === undefined || now.isSymbolicLink() || now.dev !== seen.dev || now.ino !== seen.ino) {
      refuse(`and '${seen.path}' changed between the proof and the act (it is not the entry the proof saw)`);
    }
  }
}

/**
 * The read-only proofs for one path under the real root. Throws through
 * `refuse` naming the first that fails; touches nothing.
 */
function proveUnder(context: CommandContext, realRoot: string, rel: string, refuse: Refuse): { readonly exists: boolean; readonly chain: readonly Seen[] } {
  const walked = walk(realRoot, rel, refuse);
  const absolute = join(realRoot, ...rel.split("/"));
  if (walked.exists) {
    // INSIDE THE REAL `.nen/focused`, AND THE ROOT NOT INSIDE THAT.
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
    if (/not a git repository/i.test(gitDir.stderr)) return walked;
    refuse(`and 'git rev-parse --git-dir' failed (exit ${gitDir.code}), so nen cannot prove it holds nothing git owns`);
  }
  const reported = gitDir.stdout.trim();
  const gitPath = isAbsolute(reported) ? reported : join(realRoot, reported);
  const realGit = lstatOf(gitPath) === undefined ? gitPath : realpathSync.native(gitPath);
  if (within(realGit, absolute) || within(absolute, realGit)) refuse(`which overlaps git's own directory '${realGit}'`);
  const lsArgs = ["--literal-pathspecs", "-c", "core.quotePath=false", "ls-files", "--recurse-submodules", "-z", "--", rel];
  const tracked = context.seams.run(GIT, lsArgs, { cwd: realRoot });
  if (tracked.spawnFailed || tracked.code !== 0) {
    refuse(`and 'git ls-files' failed (exit ${tracked.code}), so nen cannot prove it holds no tracked file`);
  }
  const files = tracked.stdout.split("\0").filter((entry): boolean => entry !== "");
  if (files.length > 0) {
    refuse(`which holds ${files.length} file${files.length === 1 ? "" : "s"} git tracks (${files.slice(0, 3).map((file): string => `'${file}'`).join(", ")}${files.length > 3 ? ", ..." : ""})`);
  }
  return walked;
}

/** The first `.git` entry at or below `path`, never following a link; or null. */
function findGit(path: string): string | null {
  const stats = lstatOf(path);
  if (stats === undefined) return null;
  const name = path.slice(path.lastIndexOf(sep) + 1);
  if (name.toLowerCase() === ".git") return path;
  if (!stats.isDirectory() || stats.isSymbolicLink()) return null;
  for (const entry of readdirSync(path)) {
    const found = findGit(join(path, entry));
    if (found !== null) return found;
  }
  return null;
}

/** The refusal every act in this module raises: exit 2, nothing moved. */
function refuser(pointer: string, declared: string): Refuse {
  return (why: string): never => {
    throw new VerbUsageError(
      `${pointer} names '${declared}', ${why}. A results path must be GENERATED output strictly inside '${FOCUSED_RESULTS_DIR}/', which nen moves aside before every focused run. Nothing was moved or run.`,
    );
  };
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
  const refuse = refuser(pointer, declared);
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
  const walked = proveUnder(context, realRoot, relPath, refuse);
  return { realRoot, absolute, relative: relPath, exists: walked.exists, chain: walked.chain };
}

/**
 * Make sure `.nen` and `.nen/focused` exist as REAL directories under the real
 * root, creating each missing one non-recursively. Returns the proved chain.
 */
function ensureFocused(realRoot: string, refuse: Refuse): readonly Seen[] {
  let current = realRoot;
  for (const segment of FOCUSED_RESULTS_DIR.split("/")) {
    current = join(current, segment);
    if (lstatOf(current) === undefined) {
      try {
        mkdirSync(current);
      } catch (error) {
        if (errno(error) !== "EEXIST") refuse(`and '${current}' could not be created (${errno(error) ?? String(error)})`);
      }
    }
  }
  const walked = walk(realRoot, FOCUSED_RESULTS_DIR, refuse);
  const last = walked.chain.at(-1);
  if (!walked.exists || last === undefined || lstatOf(last.path)?.isDirectory() !== true) {
    refuse(`and '${FOCUSED_RESULTS_DIR}' is not a directory`);
  }
  return walked.chain;
}

/**
 * Prove `.nen/focused/.previous` (M1): absent, or a real directory -- not a
 * link, native realpath equal to its own path, inside the real `.nen/focused`
 * -- and create it non-recursively when absent. A file there, or a race that
 * left one, is a refusal naming the path.
 */
function provePrevious(realRoot: string, refuse: Refuse): readonly Seen[] {
  const focusedChain = ensureFocused(realRoot, refuse);
  const focused = join(realRoot, ...FOCUSED_RESULTS_DIR.split("/"));
  const previous = join(focused, FOCUSED_PREVIOUS);
  if (lstatOf(previous) === undefined) {
    try {
      mkdirSync(previous);
    } catch (error) {
      const code = errno(error);
      if (code !== "EEXIST") refuse(`and '${previous}' could not be created (${code ?? String(error)})`);
    }
  }
  const stats = lstatOf(previous);
  if (stats === undefined || stats.isSymbolicLink() || !stats.isDirectory()) {
    refuse(`and '${previous}' is not a real directory (a link, a file, or gone); nen moves results only into a '${FOCUSED_PREVIOUS}' it can prove is its own`);
  }
  const real = realpathSync.native(previous);
  if (real !== previous || !within(real, realpathSync.native(focused))) {
    refuse(`and '${previous}' really resolves to '${real}', not inside the real '${focused}'`);
  }
  return [...focusedChain, { path: previous, dev: (stats as Stats).dev, ino: (stats as Stats).ino }];
}

/** A fresh run id of the RUN_ID shape. */
function mintRunId(context: CommandContext): string {
  const stamp = context.seams.now().toISOString().replace(/[:.]/g, "-");
  return `${stamp}-${process.pid}-${randomBytes(3).toString("hex")}`;
}

/** Claim a run directory in `.previous` atomically (non-recursive mkdir, loop on EEXIST). */
function claimRun(context: CommandContext, previous: string, refuse: Refuse): string {
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const id = mintRunId(context);
    try {
      mkdirSync(join(previous, id));
      return id;
    } catch (error) {
      if (errno(error) === "EEXIST") continue;
      refuse(`and the run directory '${join(previous, id)}' could not be created (${errno(error) ?? String(error)})`);
    }
  }
  return refuse(`and no unused run id could be claimed in '${previous}'`);
}

/**
 * Move the proven results path aside into `.nen/focused/.previous/<run-id>/`,
 * then prune that area to the last PREVIOUS_KEPT nen-minted runs.
 */
export function moveResultsAside(context: CommandContext, proof: ClearProof, pointer: string, declared: string): void {
  if (!proof.exists) return;
  const refuse = refuser(pointer, declared);
  const previousChain = provePrevious(proof.realRoot, refuse);
  const previous = join(proof.realRoot, ...FOCUSED_RESULTS_DIR.split("/"), FOCUSED_PREVIOUS);
  const id = claimRun(context, previous, refuse);
  const inside = proof.relative.slice(FOCUSED_RESULTS_DIR.length + 1).split("/");
  // Parents INSIDE the run directory nen just created and owns.
  let parent = join(previous, id);
  for (const segment of inside.slice(0, -1)) {
    parent = join(parent, segment);
    mkdirSync(parent);
  }
  const destination = join(parent, inside.at(-1) as string);
  reverify([...proof.chain, ...previousChain], refuse);
  try {
    renameSync(proof.absolute, destination);
  } catch (error) {
    const code = errno(error);
    refuse(`and moving it to '${destination}' failed (${code ?? String(error)}${code === "EXDEV" ? ": a different filesystem" : ""})`);
  }
  prunePrevious(context, proof.realRoot, previous, id);
}

function prunePrevious(context: CommandContext, realRoot: string, previous: string, justMoved: string): void {
  const entries = readdirSync(previous).sort();
  const foreign = entries.filter((entry): boolean => !RUN_ID.test(entry));
  if (foreign.length > 0) {
    context.io.err(
      `nen leaves ${foreign.map((entry): string => `'${entry}'`).join(", ")} in '${FOCUSED_RESULTS_DIR}/${FOCUSED_PREVIOUS}' alone: not a run id nen minted, so never pruned.`,
    );
  }
  const runs = entries.filter((entry): boolean => RUN_ID.test(entry) && entry !== justMoved);
  // THE RUN JUST MOVED IS ALWAYS KEPT, and counts as one of the kept.
  for (const run of runs.slice(0, Math.max(0, runs.length - (PREVIOUS_KEPT - 1)))) {
    const rel = `${FOCUSED_RESULTS_DIR}/${FOCUSED_PREVIOUS}/${run}`;
    try {
      pruneOne(context, realRoot, previous, rel, run);
    } catch (error) {
      context.io.err(`nen kept '${rel}' rather than prune it: ${error instanceof Error ? error.message : String(error)}.`);
    }
  }
}

/**
 * Prove one run, rename it to a unique `.doomed-<hex>`, re-verify every
 * ancestor and the renamed entry's own inode, and only then remove it.
 */
function pruneOne(context: CommandContext, realRoot: string, previous: string, rel: string, run: string): void {
  const refuse: Refuse = (why: string): never => {
    throw new Error(why);
  };
  const proved = proveUnder(context, realRoot, rel, refuse);
  if (!proved.exists) return;
  const entry = proved.chain.at(-1) as Seen;
  const ancestors = proved.chain.slice(0, -1);
  const doomed = join(previous, `.doomed-${randomBytes(6).toString("hex")}`);
  reverify(proved.chain, refuse);
  renameSync(join(previous, run), doomed);
  reverify(ancestors, refuse);
  const now = lstatOf(doomed);
  if (now === undefined || now.isSymbolicLink() || now.dev !== entry.dev || now.ino !== entry.ino) {
    refuse(`'${doomed}' is not the run the proof saw; left in place`);
  }
  rmSync(doomed, { recursive: true, force: true });
}

// ── the lock (M6) ────────────────────────────────────────────────────────────

/** A held `.nen/focused/.lock`: release it, idempotently. */
export interface FocusedLock {
  release(): void;
}

/** Is a process with this pid alive on this host? */
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errno(error) === "EPERM";
  }
}

/**
 * Take `.nen/focused/.lock` with O_EXCL, holding `{pid, startedAt}`, for the
 * whole of a focused run: move, run and read. Another LIVE holder is exit 2
 * naming its pid. A lock whose pid is gone is reported and removed -- only
 * after it is proved a regular file inside the real `.nen/focused` -- and the
 * take is tried once more. Released in the caller's `finally` and, should the
 * process exit first, in an exit handler.
 */
export function acquireFocusedLock(context: CommandContext, repoRoot: string, pointer: string, declared: string): FocusedLock {
  const refuse = refuser(pointer, declared);
  const realRoot = realpathSync.native(repoRoot);
  ensureFocused(realRoot, refuse);
  const focused = join(realRoot, ...FOCUSED_RESULTS_DIR.split("/"));
  const lock = join(focused, FOCUSED_LOCK);
  const body = JSON.stringify({ pid: process.pid, startedAt: context.seams.now().toISOString() });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    let fd: number;
    try {
      fd = openSync(lock, "wx");
    } catch (error) {
      if (errno(error) !== "EEXIST") refuse(`and the lock '${lock}' could not be taken (${errno(error) ?? String(error)})`);
      const stats = lstatOf(lock);
      if (stats === undefined) continue;
      if (stats.isSymbolicLink() || !stats.isFile() || realpathSync.native(lock) !== lock || !within(lock, realpathSync.native(focused))) {
        refuse(`and '${lock}' is not a regular lock file inside '${focused}'; nen will not touch it`);
      }
      let holder: { pid?: unknown; startedAt?: unknown } = {};
      try {
        holder = JSON.parse(readFileSync(lock, "utf8")) as { pid?: unknown; startedAt?: unknown };
      } catch {
        holder = {};
      }
      const pid = typeof holder.pid === "number" ? holder.pid : null;
      if (pid !== null && alive(pid)) {
        refuse(`and another focused run holds '${lock}' (pid ${pid}${typeof holder.startedAt === "string" ? `, started ${holder.startedAt}` : ""}); wait for it to finish`);
      }
      context.io.err(`nen removed a stale focused lock '${lock}' (pid ${pid ?? "unreadable"} is not running).`);
      unlinkSync(lock);
      continue;
    }
    writeSync(fd, body);
    closeSync(fd);
    let held = true;
    const release = (): void => {
      if (!held) return;
      held = false;
      (process as NodeJS.EventEmitter).removeListener("exit", release);
      try {
        if (readFileSync(lock, "utf8") === body) unlinkSync(lock);
      } catch {
        // Already gone: nothing to release.
      }
    };
    (process as NodeJS.EventEmitter).once("exit", release);
    return { release };
  }
  return refuse(`and the lock '${lock}' could not be taken`);
}
