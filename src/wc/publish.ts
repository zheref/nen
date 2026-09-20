// src/wc/publish.ts -- `nen wc publish`: push the current branch to origin,
// and refuse every shape of push that could rewrite somebody else's history
// (zheref/nen#227; Hatsu's `aka` skill hand-rolled this).
//
// FOUR REFUSALS BEFORE ANY WRITE, all at exit 2, because each is a mistake in
// the invocation rather than a fact about the remote: a DETACHED HEAD (there
// is no branch to push); the TRUNK -- the workflow's `branch.base`, and
// `main`/`master` whatever the policy says -- because nothing here ever
// pushes the trunk directly; anything that LOOKS LIKE A REFSPEC OR A FORCE
// (a positional, a `+`, a `:`, a `--force` -- the last is already unknown to
// the parser); and a caller-supplied remote, because this verb pushes to
// `origin` and nowhere else.
//
// THE FIFTH IS A FACT ABOUT THE REMOTE, AND EXIT 1: an upstream that exists
// and is NOT an ancestor of the local branch is a push git would refuse
// without `--force`, and `needsForce: true` is the whole of what this verb
// says about it. What to do -- catch up, or decide the rewrite is wanted and
// do it by hand -- is not decided here.
//
// THE NAME IS VALIDATED BEFORE IT IS USED IN AN ARGV (Feitan S1). A branch git
// will happily hold -- `+main` passes `git check-ref-format --branch` -- is a
// FORCE once it sits in `git push origin +main`, and a trunk compare on the
// raw name misses it. So the name goes through git's own validator, then
// through `looksLikeRefspecOrForce`, and the push and the fetch spell their
// refspec IN FULL behind `--` / `--end-of-options`, where no leading `+` or
// `-` can change what the argv means. The trunk is compared against the
// NORMALIZED name (`refs/heads/main`, `+main` -> `main`).
//
// `git fetch` IS A READ, on ./squash.ts's argument; the ONE write is the push.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { SquashStateError } from "./squash.js";

export const PUBLISH_CONTRACT = "nen.wc.publish/v0.1";
export const REMOTE = "origin";

/** KEY ORDER IS THE CONTRACT; ./command.test.ts pins it. */
export interface PublishReport {
  readonly contract: string;
  readonly branch: string;
  readonly remote: string;
  /** The `<remote>/<branch>` the branch tracked before this call, or null. */
  readonly upstreamBefore: string | null;
  /** Commits on the branch not on its upstream; null when there is no upstream to count against. */
  readonly ahead: number | null;
  /** True when the upstream exists and the local branch is not a fast-forward of it. Nothing was pushed. */
  readonly needsForce: boolean;
  readonly pushed: boolean;
  readonly dryRun: boolean;
}

export type PublishOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "done"; readonly report: PublishReport; readonly lines: readonly string[] };

export interface PublishOptions {
  /** The workflow's `branch.base`, already loaded by the caller. */
  readonly base: string;
  readonly setUpstream: boolean;
  readonly dryRun: boolean;
}

interface GitCall {
  readonly code: number;
  readonly stdout: string;
  readonly spawnFailed: boolean;
  readonly error: string;
}

function runGit(seams: Seams, cwd: string, args: readonly string[]): GitCall {
  const result = seams.run(GIT, [...args], { cwd });
  return {
    code: result.code,
    stdout: result.stdout,
    spawnFailed: result.spawnFailed,
    error: outputLines(result.stderr).join(" ") || `exit ${result.code}`,
  };
}

/** The trunk names this verb refuses to push, whatever else the policy says. */
export const TRUNK_NAMES: readonly string[] = ["main", "master"];

/** True for a token that would change WHAT is pushed rather than name a branch. */
export function looksLikeRefspecOrForce(token: string): boolean {
  return token.startsWith("+") || token.includes(":") || token.startsWith("-");
}

/** The branch a name means once a leading `+` and a `refs/heads/` prefix are taken off -- what the trunk is compared against. */
export function normalizeBranchName(name: string): string {
  return name.replace(/^\++/, "").replace(/^refs\/heads\//, "");
}

/**
 * A branch name this verb is willing to put in a refspec: accepted by
 * `git check-ref-format --branch` (asked of git, never re-implemented) AND
 * free of the refspec/force shapes git's validator does not reject.
 * Returns the refusal text, or null.
 */
export function refuseBranchName(seams: Seams, cwd: string, name: string, what: string): string | null {
  const ok = runGit(seams, cwd, ["check-ref-format", "--branch", name]);
  if (ok.code !== 0) {
    return `${what} '${name}' is not a branch name git will accept ('git check-ref-format --branch' answered ${ok.error}). Nothing was fetched or pushed.`;
  }
  if (looksLikeRefspecOrForce(name)) {
    return `${what} '${name}' looks like a refspec or a force option (a leading '+' or '-', or a ':'), and this verb never lets a name change what a push or fetch does. Nothing was fetched or pushed.`;
  }
  return null;
}

/** The fetch that keeps `<remote>/<branch>` current, spelled in full so no name can become an option. */
export function fetchArgv(remote: string, branch: string): string[] {
  return ["fetch", "--end-of-options", remote, `refs/heads/${branch}:refs/remotes/${remote}/${branch}`];
}

export function publish(seams: Seams, cwd: string, options: PublishOptions): PublishOutcome {
  const branchResult = runGit(seams, cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (branchResult.code !== 0) {
    return {
      kind: "refused",
      reason: `HEAD is detached ('git symbolic-ref --short HEAD' failed: ${branchResult.error}) -- there is no branch to publish. Check a branch out, or cut one, and run this again.`,
    };
  }
  const branch = branchResult.stdout.trim();
  const named = normalizeBranchName(branch);
  if (named === options.base || TRUNK_NAMES.includes(named)) {
    return {
      kind: "refused",
      reason: `'${branch}' is the trunk${named === options.base ? " (nen/workflow.json's branch.base)" : ""}, and this verb never pushes the trunk directly: the trunk moves by merging a pull request. Cut a branch for this work.`,
    };
  }
  const badName = refuseBranchName(seams, cwd, branch, "the current branch");
  if (badName !== null) return { kind: "refused", reason: badName };

  const upstreamResult = runGit(seams, cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  const upstreamBefore = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null;
  let ahead: number | null = null;
  let needsForce = false;
  if (upstreamBefore !== null) {
    const slash = upstreamBefore.indexOf("/");
    if (slash === -1) {
      throw new SquashStateError(`the upstream '${upstreamBefore}' does not look like '<remote>/<branch>' -- refusing to reason about a remote this module cannot name from it.`);
    }
    const remote = upstreamBefore.slice(0, slash);
    const tracked = upstreamBefore.slice(slash + 1);
    const badTracked = refuseBranchName(seams, cwd, tracked, `the upstream's branch`);
    if (badTracked !== null) return { kind: "refused", reason: badTracked };
    // FETCH FIRST: a fast-forward decided against a stale remote-tracking ref
    // is a decision about yesterday's remote, and the push would still be
    // refused -- or, worse, accepted by a `--force` somebody typed next.
    const fetchArgs = fetchArgv(remote, tracked);
    const fetch = runGit(seams, cwd, fetchArgs);
    if (fetch.code !== 0) throw new SquashStateError(`could not fetch the upstream '${upstreamBefore}' ('git ${fetchArgs.join(" ")}' failed: ${fetch.error}).`);
    const ancestor = runGit(seams, cwd, ["merge-base", "--is-ancestor", upstreamBefore, "HEAD"]);
    if (ancestor.spawnFailed || ancestor.code > 1) {
      throw new SquashStateError(`could not test whether '${upstreamBefore}' is an ancestor of HEAD ('git merge-base --is-ancestor ${upstreamBefore} HEAD' failed: ${ancestor.error}).`);
    }
    needsForce = ancestor.code !== 0;
    const count = runGit(seams, cwd, ["rev-list", "--count", `${upstreamBefore}..HEAD`]);
    if (count.code !== 0 || !/^\d+$/.test(count.stdout.trim())) {
      throw new SquashStateError(`could not count the commits ahead of '${upstreamBefore}' ('git rev-list --count ${upstreamBefore}..HEAD' failed: ${count.error}).`);
    }
    ahead = Number(count.stdout.trim());
  }

  // THE REFSPEC IN FULL, behind `--`: `refs/heads/<b>:refs/heads/<b>` is a
  // plain update of that one ref whatever the name looks like.
  const argv = ["push", ...(options.setUpstream ? ["-u"] : []), REMOTE, "--", `refs/heads/${branch}:refs/heads/${branch}`];
  const report = (pushed: boolean): PublishReport => ({
    contract: PUBLISH_CONTRACT,
    branch,
    remote: REMOTE,
    upstreamBefore,
    ahead,
    needsForce,
    pushed,
    dryRun: options.dryRun,
  });
  if (needsForce) {
    return {
      kind: "done",
      report: report(false),
      lines: [
        `'${branch}' is not a fast-forward of its upstream '${upstreamBefore}': the push would need --force, and this verb never forces. Nothing was pushed. Catch the branch up first ('nen wc catch-up --base <ref>'), or decide the rewrite is wanted and do it by hand.`,
      ],
    };
  }
  if (options.dryRun) {
    return { kind: "done", report: report(false), lines: [`would run: git ${argv.join(" ")}${upstreamBefore === null ? "  (no upstream yet)" : `  (${ahead} ahead of ${upstreamBefore})`}`] };
  }
  const push = runGit(seams, cwd, argv);
  if (push.code !== 0) throw new SquashStateError(`could not push '${branch}' ('git ${argv.join(" ")}' failed: ${push.error}).`);
  return {
    kind: "done",
    report: report(true),
    lines: [`pushed '${branch}' to ${REMOTE}${options.setUpstream ? " (upstream set)" : ""}${ahead === null ? "" : ` -- ${ahead} commit(s) ahead of ${upstreamBefore}`}`],
  };
}
