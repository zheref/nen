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

import { lines, type Runner } from "../exec/seam.js";

export type WcCase =
  | "must-move"
  | "on-branch-dirty"
  | "on-branch-clean";

export interface WcState {
  readonly branch: string;
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

export function classifyWorkingCopy(state: WcState): WcClassification {
  if (state.isTrunk) {
    if (!state.dirty) {
      return {
        case: "on-branch-clean",
        evidence: [`on the trunk ('${state.branch}') with nothing uncommitted -- nothing to move`],
      };
    }
    return {
      case: "must-move",
      evidence: [
        `on the trunk ('${state.branch}') with ${state.uncommittedPaths.length} uncommitted path(s) -- this MUST move to a fresh branch cut from the target base; nothing is ever committed to the trunk directly`,
      ],
    };
  }

  if (!state.dirty) {
    return {
      case: "on-branch-clean",
      evidence: [`on '${state.branch}' with nothing uncommitted -- open or report the existing PR`],
    };
  }

  return {
    case: "on-branch-dirty",
    evidence: [
      `on '${state.branch}', ${state.aheadOfBase} commit(s) ahead of base, ${state.uncommittedPaths.length} uncommitted path(s) -- whether these are the SAME effort as the branch's existing commits is a judgement this module does not make; the commit subjects and paths below are the evidence for it`,
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

function runGit(runner: Runner, args: readonly string[], cwd: string): { readonly code: number; readonly stdout: string; readonly error: string } {
  const result = runner.run({ bin: "git", args: [...args], cwd });
  return {
    code: result.code,
    stdout: result.stdout,
    error: (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`,
  };
}

export function readWorkingCopyState(runner: Runner, cwd: string, base: string): WcState {
  const branchResult = runGit(runner, ["symbolic-ref", "--short", "HEAD"], cwd);
  if (branchResult.code !== 0) {
    throw new WcStateError(
      `could not determine the current branch ('git symbolic-ref --short HEAD' failed: ${branchResult.error}). This usually means a detached HEAD, or a repository with no commits yet -- 'wc classify' classifies a checkout that is ON a branch, and refuses rather than reading a branch name off of empty output.`,
    );
  }
  const branch = branchResult.stdout.trim();

  const statusResult = runGit(runner, ["status", "--porcelain=v1", "-uall"], cwd);
  if (statusResult.code !== 0) {
    throw new WcStateError(
      `could not read the working copy's status ('git status --porcelain=v1 -uall' failed: ${statusResult.error}). Refusing to report a possibly-dirty working copy as clean.`,
    );
  }
  const statusLines = lines(statusResult.stdout);
  const uncommittedPaths = statusLines
    .map((line): string => line.slice(3).trim())
    .filter((path): boolean => path !== "");
  const isTrunk = branch === base;

  let aheadOfBase = 0;
  let existingCommitSubjects: string[] = [];
  if (!isTrunk) {
    const countResult = runGit(runner, ["rev-list", "--count", `${base}..HEAD`], cwd);
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

    const logResult = runGit(runner, ["log", `${base}..HEAD`, "--format=%s"], cwd);
    if (logResult.code !== 0) {
      throw new WcStateError(
        `could not read the commit subjects ahead of base ('git log ${base}..HEAD --format=%s' failed: ${logResult.error}).`,
      );
    }
    existingCommitSubjects = lines(logResult.stdout).reverse();
  }

  return {
    branch,
    isTrunk,
    dirty: uncommittedPaths.length > 0,
    aheadOfBase,
    existingCommitSubjects,
    uncommittedPaths,
  };
}
