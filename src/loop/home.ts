// src/loop/home.ts -- WHERE a loop's ledger lives, and the lost-ledger rule.
//
// THE GAP THIS CLOSES (Hatsu's SDD plan, finding D2 / autonomy-loop#1). The
// ledger used to live at `<--repo>/.nen/loop/<id>.json`. When `--repo` is an
// effort worktree, that `.nen/` goes with the worktree (Hatsu's 2026-10-20
// ruling makes a worktree's `.nen/` disposable), and a missing ledger read as
// "no loop began" -- iteration 1, a whole fresh cap, on exactly the loop that
// had already spent one. A cap that resets when a directory is cleaned up is
// not a cap.
//
// SO THE LEDGER MOVES TO THE GIT COMMON DIRECTORY, `<git-common-dir>/nen/loop/`:
// one directory shared by the main checkout and every linked worktree of the
// repository, which no worktree removal and no `git clean` touches -- the same
// durable home Hatsu's futon effort record and hanten's `.opened` traces use.
// Only when `--repo` is not inside a git repository at all does the ledger stay
// under `<--repo>/.nen/loop/`, which is then the only home there is.
//
// AND A LOST LEDGER IS NEVER A FRESH ONE. Every claim also writes
// `<id>.opened` beside the ledger. A missing ledger with that marker present is
// a loop that began and whose count is gone: refused, never iteration 1.
//
// "COULD NOT READ" IS NEVER "NOTHING FOUND". A git that cannot be run, or that
// refuses for any reason other than "not a git repository" (an unsafe
// directory, a broken repository), is a refusal -- falling back to the
// worktree-local path there would silently split one loop's count across two
// homes.

import { existsSync, lstatSync, realpathSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import type { Seams } from "../seam/exec.js";

/** The worktree-local home: the only home before this change, and the fallback. */
export const LOOP_LEDGER_DIR = ".nen/loop";

/** The durable home, relative to the git common directory. */
export const LOOP_COMMON_DIR = "nen/loop";

export interface LoopHome {
  /** Absolute directory the ledger and its `.opened` marker live in. */
  readonly dir: string;
  /** True when `dir` is under the git common directory. */
  readonly durable: boolean;
  /**
   * The worktree-local directory an older build wrote to under --repo, when it
   * differs from `dir`. Null in the fallback.
   */
  readonly legacyDir: string | null;
}

/**
 * Every worktree-local `.nen/loop/` an older build could have written to: the
 * one under `root` first, then each checkout `git worktree list` names (the
 * main checkout and every linked worktree), deduplicated. A loop begun in
 * worktree A under an older build and claimed from core after the upgrade must
 * be FOUND, not read as a fresh loop.
 *
 * A worktree list git cannot produce is a refusal, never "no other worktrees".
 */
export function legacyDirs(root: string, home: LoopHome, seams: Pick<Seams, "run">): string[] {
  if (home.legacyDir === null) return [];
  const result = seams.run("git", ["-C", root, "-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z"], {
    env: { LC_ALL: "C", LANGUAGE: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  if (result.spawnFailed || result.code !== 0) {
    throw new VerbUsageError(
      `git worktree list failed under ${root} (exit ${result.code}). Refusing rather than assuming no other checkout holds an older build's ledger for this loop: missing one would start its count again.`,
    );
  }
  // Checkouts are compared by their REAL path: git may spell one differently
  // from --repo (forward slashes, a Windows short name, macOS /private), and
  // listing --repo's own old home twice would read as two homes for one loop.
  const same = (first: string, second: string): boolean => canonical(first) === canonical(second);
  const roots = [root];
  for (const entry of result.stdout.split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const checkout = entry.slice("worktree ".length);
    if (!roots.some((known): boolean => same(known, checkout))) roots.push(checkout);
  }
  return [home.legacyDir, ...roots.slice(1).map((checkout): string => join(checkout, ...LOOP_LEDGER_DIR.split("/")))];
}

/** "Not a git repository", as git itself words it, and nothing looser. */
const NOT_A_REPOSITORY = /not a git repository/i;

/**
 * Resolve the ledger home for `root` (the resolved `--repo`).
 *
 * Throws VerbUsageError (exit 2) when git cannot answer the question, rather
 * than guessing a home -- see the header.
 */
export function resolveLoopHome(root: string, seams: Pick<Seams, "run">): LoopHome {
  const local = join(root, ...LOOP_LEDGER_DIR.split("/"));
  // A --repo that does not exist yet is not inside any repository; the old
  // behaviour (create it on the first claim) is kept for it.
  if (!existsSync(root)) return { dir: local, durable: false, legacyDir: null };

  // LC_ALL=C so "not a git repository" is git's English wording under any
  // locale, and the inherited repository-selecting variables dropped so a
  // caller's GIT_DIR (a hook, a wrapper) cannot point the lookup at another
  // repository's git directory.
  const result = seams.run("git", ["-C", root, "rev-parse", "--path-format=absolute", "--git-common-dir"], {
    env: { LC_ALL: "C", LANGUAGE: undefined, GIT_DIR: undefined, GIT_COMMON_DIR: undefined, GIT_WORK_TREE: undefined },
  });
  if (result.spawnFailed) {
    throw new VerbUsageError(
      `git could not be run to find this repository's common directory, so the loop ledger's durable home is unknown. Refusing rather than writing a worktree-local ledger a worktree cleanup would lose: install git, or run nen where it is on PATH.`,
    );
  }
  if (result.code !== 0) {
    if (NOT_A_REPOSITORY.test(result.stderr)) return { dir: local, durable: false, legacyDir: null };
    const detail = result.stderr.trim().split(/\r?\n/)[0] ?? "";
    throw new VerbUsageError(
      `git rev-parse --git-common-dir failed under ${root} (exit ${result.code}${detail === "" ? "" : `: ${detail}`}). Refusing rather than falling back to a worktree-local ledger: a loop whose count could live in two homes is a loop whose cap can be spent twice.`,
    );
  }
  const lines = result.stdout.trim().split(/\r?\n/);
  const line = lines[0] ?? "";
  if (lines.length !== 1 || line === "") {
    throw new VerbUsageError(
      `git rev-parse --git-common-dir under ${root} answered something that is not one path (${JSON.stringify(result.stdout)}). Refusing rather than guessing the loop ledger's home.`,
    );
  }
  const common = isAbsolute(line) ? line : resolve(root, line);
  return { dir: join(common, ...LOOP_COMMON_DIR.split("/")), durable: true, legacyDir: local };
}

/**
 * True when something exists at `path` -- a dangling link included, which is
 * damaged state rather than an absent file. Any error other than "not there"
 * is a refusal: could not read is never nothing found.
 */
export function present(path: string, what: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    throw new VerbUsageError(
      `the ${what} at ${path} could not be read (${code ?? String(error)}). Refusing rather than treating it as absent: an absent ${what} would hand out a fresh cap.`,
    );
  }
}

/** A path's real spelling when it exists, else its resolved one; case-folded on Windows. */
function canonical(path: string): string {
  let real: string;
  try {
    real = realpathSync.native(path);
  } catch {
    real = resolve(path);
  }
  return process.platform === "win32" ? real.toLowerCase() : real;
}
