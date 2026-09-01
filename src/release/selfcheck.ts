// src/release/selfcheck.ts -- getsuga §3's self-enumeration check: "a release
// PR lists itself IFF its own merge falls inside the range it reconciles."
//
// A GIT-MECHANICAL FACT, NOT A JUDGEMENT. The range a release PR reconciles is
// `<previousTag>..<cutPoint>`; the PR lists itself exactly when its own merge
// commit is IN that range -- reachable from the cut point, and NOT already
// reachable from the previous tag. Both halves are `git merge-base
// --is-ancestor` calls, which is why the skill calls this "a fact to check,
// not a habit": getting it wrong needs no judgment error, only checking it
// against the wrong two commits.

import { lines, type Runner } from "../exec/seam.js";

export interface SelfCheckResult {
  readonly prMergeSha: string;
  readonly previousTag: string;
  readonly cutPoint: string;
  readonly reachableFromCutPoint: boolean;
  readonly alreadyInPreviousTag: boolean;
  /** true: the PR is in `<previousTag>..<cutPoint>` and must list itself. */
  readonly shouldListItself: boolean;
}

export class SelfCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SelfCheckError";
  }
}

function isAncestor(runner: Runner, cwd: string, ancestor: string, descendant: string): boolean {
  const result = runner.run({ bin: "git", args: ["merge-base", "--is-ancestor", ancestor, descendant], cwd });
  if (result.code > 1) {
    throw new SelfCheckError(
      `could not test whether '${ancestor}' is an ancestor of '${descendant}': ${lines(result.stderr).join(" ") || `exit ${result.code}`}`,
    );
  }
  return result.code === 0;
}

export function checkSelfEnumeration(
  runner: Runner,
  cwd: string,
  prMergeSha: string,
  previousTag: string,
  cutPoint: string,
): SelfCheckResult {
  const reachableFromCutPoint = isAncestor(runner, cwd, prMergeSha, cutPoint);
  const alreadyInPreviousTag = isAncestor(runner, cwd, prMergeSha, previousTag);
  return {
    prMergeSha,
    previousTag,
    cutPoint,
    reachableFromCutPoint,
    alreadyInPreviousTag,
    shouldListItself: reachableFromCutPoint && !alreadyInPreviousTag,
  };
}
