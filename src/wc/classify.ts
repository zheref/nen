// src/wc/classify.ts -- the working-copy classification, tensho §2's table.
//
// FOUR CASES, EACH WITH A DIFFERENT FIRST MOVE: on the trunk and dirty
// (must move -- Ichigo never pushes the trunk), on a branch with the
// uncommitted work belonging to the same effort (reuse), on a branch where it
// is a DIFFERENT effort (a fresh branch, not a smuggled second concern), and on
// a clean branch (nothing to commit). This module decides only the first
// three of those FOUR CASES by git state alone -- trunk-or-not, dirty-or-not.
// It cannot decide "same effort" vs "different effort": the skill's own words
// are "'same effort' is a JUDGEMENT, so show the evidence rather than asserting
// it", and that is precisely the line issue #4's "what stays with the LLM"
// section draws. This module's job stops at gathering the evidence -- the
// branch's existing commit subjects and the uncommitted paths -- and handing
// it to whoever judges.
//
// A DETACHED HEAD IS CLASSIFIED, NOT REFUSED (zheref/nen#163). It used to be a
// hard refusal: `git symbolic-ref --short HEAD` fails on one, and this module
// threw rather than reading a branch name off empty output. The fail-closed
// half of that was right and stays; the REFUSAL was wrong. Every one of the
// three cases above is decided by two facts -- is this the trunk, is it dirty
// -- and a detached HEAD answers both: it is not the trunk (git checked out no
// branch, so it is standing on no branch's name) and its tree is as dirty as
// any other. The branch is ONE FIELD OF THE ANSWER, not a precondition of it.
// So `branch` is `string | null` and a detached HEAD carries `detachedAt`, the
// short sha it is standing on, which is the only thing a reader can act on
// there. A worktree added with `--detach`, a bisect and a rebase step are all
// ordinary working copies, and a caller running this on one wants the same
// answer everybody else gets.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";

export type WcCase =
  | "must-move"
  | "on-branch-dirty"
  | "on-branch-clean";

export interface WcState {
  /** The checked-out branch, or null on a DETACHED HEAD -- see the header. */
  readonly branch: string | null;
  /**
   * The short sha HEAD stands on, non-null EXACTLY when `branch` is null.
   *
   * Two fields rather than one nullable string, because "on a branch called
   * `abc1234`" and "detached at `abc1234`" are different facts and a single
   * field would make them the same one.
   */
  readonly detachedAt: string | null;
  readonly isTrunk: boolean;
  readonly dirty: boolean;
  /** Commits on this branch not on the base -- empty when isTrunk. */
  readonly aheadOfBase: number;
  /** Subjects of those commits, oldest first -- evidence for a same-effort judgement. */
  readonly existingCommitSubjects: readonly string[];
  /** Paths with uncommitted changes (staged, unstaged or untracked). */
  readonly uncommittedPaths: readonly string[];
}

export interface WcClassification {
  readonly case: WcCase;
  readonly evidence: readonly string[];
}

/**
 * How this checkout is named in a sentence: `'feature/x'`, or where a detached
 * HEAD is standing. One helper so every evidence line below says it the same
 * way, and so a null branch can never render as `on ''`.
 */
export function describeHead(state: WcState): string {
  return state.branch === null ? `a detached HEAD at ${state.detachedAt ?? "(unknown)"}` : `'${state.branch}'`;
}

export function classifyWorkingCopy(state: WcState): WcClassification {
  if (state.isTrunk) {
    if (!state.dirty) {
      return {
        case: "on-branch-clean",
        evidence: [`on the trunk (${describeHead(state)}) with nothing uncommitted -- nothing to move`],
      };
    }
    return {
      case: "must-move",
      evidence: [
        `on the trunk (${describeHead(state)}) with ${state.uncommittedPaths.length} uncommitted path(s) -- this MUST move to a fresh branch cut from the target base; nothing is ever committed to the trunk directly`,
      ],
    };
  }

  if (!state.dirty) {
    return {
      case: "on-branch-clean",
      evidence: [`on ${describeHead(state)} with nothing uncommitted -- open or report the existing PR`],
    };
  }

  return {
    case: "on-branch-dirty",
    evidence: [
      `on ${describeHead(state)}, ${state.aheadOfBase} commit(s) ahead of base, ${state.uncommittedPaths.length} uncommitted path(s) -- whether these are the SAME effort as the branch's existing commits is a judgement this module does not make; the commit subjects and paths below are the evidence for it`,
      ...(state.existingCommitSubjects.length === 0
        ? []
        : [`existing commits: ${state.existingCommitSubjects.map((s): string => `"${s}"`).join(", ")}`]),
    ],
  };
}

// FAIL-CLOSED, THE HOUSE DEFAULT. A failed git invocation must surface as an
// error, never as a confident empty/zero -- "not checked" must never render
// as "clean". The helper this replaced (runOrEmpty) turned ANY git failure
// into "" and let the caller's own defaulting (Number("") === 0, lines("")
// === []) manufacture a fully-formed, wrong answer: a detached HEAD or a
// missing/invalid --base made 'rev-list' fail, and the verb printed
// `aheadOfBase: 0` -- indistinguishable from a real, checked zero. A failed
// 'git status' was worse still: it read as zero uncommitted paths, i.e. a
// DIRTY working copy reported as clean. Every call below throws a named,
// located error instead; ../../src/index.ts's top-level catch turns it into
// a stderr message and a non-zero exit for both the text and --json paths --
// there is no successful JSON shape for "the state could not be read".
export class WcStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WcStateError";
  }
}

function runGit(seams: Seams, args: readonly string[], cwd: string): { readonly code: number; readonly stdout: string; readonly error: string } {
  const result = seams.run(GIT, [...args], { cwd });
  return {
    code: result.code,
    stdout: result.stdout,
    error: outputLines(result.stderr).join(" ") || `exit ${result.code}`,
  };
}

export function readWorkingCopyState(seams: Seams, cwd: string, base: string): WcState {
  // A FAILED `symbolic-ref` IS STILL NEVER READ AS A BRANCH NAME -- it is asked
  // a second question instead. `git symbolic-ref --short HEAD` fails on a
  // detached HEAD *and* on a repository with no commits yet, and the two are
  // told apart by whether HEAD resolves to a commit at all: it does on the
  // first and cannot on the second. So the detached case gets the short sha it
  // is standing on and is classified like any other working copy
  // (zheref/nen#163), while an unresolvable HEAD is still the refusal it always
  // was -- there is nothing there to classify.
  const branchResult = runGit(seams, ["symbolic-ref", "--short", "HEAD"], cwd);
  let branch: string | null = branchResult.stdout.trim();
  let detachedAt: string | null = null;
  if (branchResult.code !== 0) {
    branch = null;
    const headResult = runGit(seams, ["rev-parse", "--short", "HEAD"], cwd);
    if (headResult.code !== 0) {
      throw new WcStateError(
        `could not determine what HEAD is ('git symbolic-ref --short HEAD' failed: ${branchResult.error}; 'git rev-parse --short HEAD' then failed: ${headResult.error}). A detached HEAD is classified normally, with branch: null -- this is the other case: HEAD names no branch AND resolves to no commit, which is a repository with no commits yet or one nen cannot read at all, and there is no working copy there to classify.`,
      );
    }
    detachedAt = headResult.stdout.trim();
    if (detachedAt === "") {
      throw new WcStateError(
        `HEAD is detached and 'git rev-parse --short HEAD' printed nothing -- refusing to report a detached HEAD without saying where it is standing.`,
      );
    }
  }

  const statusResult = runGit(seams, ["status", "--porcelain=v1", "-uall"], cwd);
  if (statusResult.code !== 0) {
    throw new WcStateError(
      `could not read the working copy's status ('git status --porcelain=v1 -uall' failed: ${statusResult.error}). Refusing to report a possibly-dirty working copy as clean.`,
    );
  }
  const statusLines = rawLines(statusResult.stdout);
  const uncommittedPaths = statusLines
    .map((line): string => line.slice(3).trim())
    .filter((path): boolean => path !== "");
  // A DETACHED HEAD IS NEVER THE TRUNK. It is standing on a commit, not on a
  // branch, so `must-move` -- whose whole meaning is "you are about to commit
  // to the trunk" -- cannot apply: a commit made here lands on no branch at all.
  const isTrunk = branch !== null && branch === base;

  let aheadOfBase = 0;
  let existingCommitSubjects: string[] = [];
  if (!isTrunk) {
    const countResult = runGit(seams, ["rev-list", "--count", `${base}..HEAD`], cwd);
    if (countResult.code !== 0) {
      throw new WcStateError(
        `could not count commits ahead of base ('git rev-list --count ${base}..HEAD' failed: ${countResult.error}). This usually means --base '${base}' does not name a ref reachable from HEAD. Refusing to report 0 commits ahead, which would read as a checked answer rather than an unreadable one.`,
      );
    }
    const countRaw = countResult.stdout.trim();
    if (!/^\d+$/.test(countRaw)) {
      throw new WcStateError(
        `'git rev-list --count ${base}..HEAD' printed a non-numeric count ('${countRaw}') -- refusing to guess an ahead-of-base figure from it.`,
      );
    }
    aheadOfBase = Number(countRaw);

    const logResult = runGit(seams, ["log", `${base}..HEAD`, "--format=%s"], cwd);
    if (logResult.code !== 0) {
      throw new WcStateError(
        `could not read the commit subjects ahead of base ('git log ${base}..HEAD --format=%s' failed: ${logResult.error}).`,
      );
    }
    existingCommitSubjects = rawLines(logResult.stdout).reverse();
  }

  return {
    branch,
    detachedAt,
    isTrunk,
    dirty: uncommittedPaths.length > 0,
    aheadOfBase,
    existingCommitSubjects,
    uncommittedPaths,
  };
}
