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

function runOrEmpty(runner: Runner, args: readonly string[], cwd: string): string {
  const result = runner.run({ bin: "git", args: [...args], cwd });
  return result.code === 0 ? result.stdout : "";
}

export function readWorkingCopyState(runner: Runner, cwd: string, base: string): WcState {
  const branch = runOrEmpty(runner, ["symbolic-ref", "--short", "HEAD"], cwd).trim();
  const statusLines = lines(runOrEmpty(runner, ["status", "--porcelain=v1", "-uall"], cwd));
  const uncommittedPaths = statusLines
    .map((line): string => line.slice(3).trim())
    .filter((path): boolean => path !== "");
  const isTrunk = branch === base;

  let aheadOfBase = 0;
  let existingCommitSubjects: string[] = [];
  if (!isTrunk) {
    const countRaw = runOrEmpty(runner, ["rev-list", "--count", `${base}..HEAD`], cwd).trim();
    aheadOfBase = Number.isInteger(Number(countRaw)) ? Number(countRaw) : 0;
    existingCommitSubjects = lines(runOrEmpty(runner, ["log", `${base}..HEAD`, "--format=%s"], cwd)).reverse();
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
