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

export function publish(seams: Seams, cwd: string, options: PublishOptions): PublishOutcome {
  const branchResult = runGit(seams, cwd, ["symbolic-ref", "--short", "HEAD"]);
  if (branchResult.code !== 0) {
    return {
      kind: "refused",
      reason: `HEAD is detached ('git symbolic-ref --short HEAD' failed: ${branchResult.error}) -- there is no branch to publish. Check a branch out, or cut one, and run this again.`,
    };
  }
  const branch = branchResult.stdout.trim();
  if (branch === options.base || TRUNK_NAMES.includes(branch)) {
    return {
      kind: "refused",
      reason: `'${branch}' is the trunk${branch === options.base ? " (nen/workflow.json's branch.base)" : ""}, and this verb never pushes the trunk directly: the trunk moves by merging a pull request. Cut a branch for this work.`,
    };
  }

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
    // FETCH FIRST: a fast-forward decided against a stale remote-tracking ref
    // is a decision about yesterday's remote, and the push would still be
    // refused -- or, worse, accepted by a `--force` somebody typed next.
    const fetch = runGit(seams, cwd, ["fetch", remote, tracked]);
    if (fetch.code !== 0) throw new SquashStateError(`could not fetch the upstream '${upstreamBefore}' ('git fetch ${remote} ${tracked}' failed: ${fetch.error}).`);
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

  const argv = ["push", ...(options.setUpstream ? ["-u"] : []), REMOTE, branch];
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
