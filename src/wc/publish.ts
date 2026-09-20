// src/wc/publish.ts -- `nen wc publish`: push the current branch to the remote
// its upstream names, and refuse every shape of push that could rewrite
// somebody else's history (zheref/nen#227; Hatsu's `aka` skill hand-rolled
// this).
//
// THE REMOTE IS THE UPSTREAM'S (Copilot review on zheref/nen#231). A branch
// that tracks `fork/feature` is pushed to `fork`, and the fast-forward check
// below is made against THAT remote's ref -- the one the push will move --
// never against `origin` while pushing somewhere else. A branch with no
// upstream yet goes to `origin`, or to `--remote <name>` when the caller
// names one; a `--remote` that disagrees with an existing upstream is refused,
// because the branch already says where it goes.
//
// FOUR REFUSALS BEFORE ANY WRITE, all at exit 2, because each is a mistake in
// the invocation rather than a fact about the remote: a DETACHED HEAD (there
// is no branch to push); the TRUNK -- the workflow's `branch.base`, and
// `main`/`master` whatever the policy says -- because nothing here ever
// pushes the trunk directly; anything that LOOKS LIKE A REFSPEC OR A FORCE
// (a positional, a `+`, a `:`, a `--force` -- the last is already unknown to
// the parser); and a `--remote` this repository does not have, or one that
// contradicts the upstream.
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
//
// `--end-of-options` IS A PARSE-OPTIONS FLAG git has accepted on every
// parse-options command -- `fetch` included -- since 2.24 (2019). Verified on
// git 2.50.1: `git fetch --end-of-options origin refs/heads/x:refs/remotes/
// origin/x` fails only on the ref lookup ("couldn't find remote ref").
// Should an older git ever answer "unknown option", this module REFUSES at
// exit 2 naming the git version rather than fetching without the guard
// (`endOfOptionsRefusal`): a branch name that is an option would otherwise
// change what the fetch does, and that is the whole reason the flag is there.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { SquashStateError } from "./squash.js";

export const PUBLISH_CONTRACT = "nen.wc.publish/v0.1";
/** The remote a branch with no upstream goes to when the caller names none; catch-up's base always lives here. */
export const REMOTE = "origin";
/** `git fetch --end-of-options` landed in git 2.24; below it the guard is refused, never dropped. */
export const MIN_GIT_FOR_END_OF_OPTIONS = "2.24";

/** KEY ORDER IS THE CONTRACT; ./command.test.ts pins it. */
export interface PublishReport {
  readonly contract: string;
  readonly branch: string;
  /** The remote pushed to: the upstream's own, or `--remote`/`origin` when the branch has no upstream. */
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
  /** `--remote <name>`: where a branch with NO upstream goes; null means `origin`. */
  readonly remote?: string | null;
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

/**
 * The exit-2 refusal for a git that rejected `--end-of-options` on the fetch,
 * or null when the failure was something else (a missing ref, no network),
 * which the caller reports as the fetch failure it is. The guard is NEVER
 * dropped to make the fetch go through: the version is named and the caller
 * upgrades git.
 */
export function endOfOptionsRefusal(seams: Seams, cwd: string, fetchArgs: readonly string[], fetch: GitCall): string | null {
  if (fetch.spawnFailed || !/unknown option|unrecognized option|end-of-options/i.test(fetch.error)) return null;
  const version = runGit(seams, cwd, ["--version"]);
  const named = version.code === 0 ? version.stdout.trim() : "git (version unknown)";
  return `${named} rejected '--end-of-options' on fetch ('git ${fetchArgs.join(" ")}' answered: ${fetch.error}). 'wc publish' and 'wc catch-up' need git >= ${MIN_GIT_FOR_END_OF_OPTIONS}, and the flag is never dropped to make the fetch go through: it is what keeps a branch name from being read as an option. Upgrade git. Nothing was fetched or pushed.`;
}

/** The `<remote>/<branch>` an upstream names, split at the first '/', the way ../pr/open.ts splits it. */
export function splitUpstream(upstream: string): { readonly remote: string; readonly branch: string } {
  const slash = upstream.indexOf("/");
  if (slash === -1) {
    throw new SquashStateError(`the upstream '${upstream}' does not look like '<remote>/<branch>' -- refusing to reason about a remote this module cannot name from it.`);
  }
  return { remote: upstream.slice(0, slash), branch: upstream.slice(slash + 1) };
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

  const asked = options.remote ?? null;
  if (asked !== null && (asked.trim() === "" || looksLikeRefspecOrForce(asked) || asked.includes("/"))) {
    return { kind: "refused", reason: `--remote '${asked}' is not a remote name this verb will put in a push argv (a leading '+' or '-', a ':' or a '/'). Nothing was fetched or pushed.` };
  }
  const upstreamResult = runGit(seams, cwd, ["rev-parse", "--abbrev-ref", `${branch}@{upstream}`]);
  const upstreamBefore = upstreamResult.code === 0 ? upstreamResult.stdout.trim() : null;
  let ahead: number | null = null;
  let needsForce = false;
  let remote: string;
  if (upstreamBefore !== null) {
    const upstream = splitUpstream(upstreamBefore);
    remote = upstream.remote;
    const tracked = upstream.branch;
    if (looksLikeRefspecOrForce(remote)) {
      return { kind: "refused", reason: `the upstream's remote '${remote}' looks like an option or a refspec (a leading '+' or '-', or a ':'), and this verb never lets a name change what a push or fetch does. Nothing was fetched or pushed.` };
    }
    if (asked !== null && asked !== remote) {
      return {
        kind: "refused",
        reason: `'${branch}' tracks '${upstreamBefore}', so it is pushed to '${remote}' -- --remote '${asked}' names a different one. This verb pushes where the branch's upstream says: drop --remote, or retrack the branch ('git branch --set-upstream-to ${asked}/${branch}') first. Nothing was fetched or pushed.`,
      };
    }
    const badTracked = refuseBranchName(seams, cwd, tracked, `the upstream's branch`);
    if (badTracked !== null) return { kind: "refused", reason: badTracked };
    // FETCH FIRST, FROM THE REMOTE THE PUSH GOES TO: a fast-forward decided
    // against a stale remote-tracking ref is a decision about yesterday's
    // remote, and the push would still be refused -- or, worse, accepted by a
    // `--force` somebody typed next.
    const fetchArgs = fetchArgv(remote, tracked);
    const fetch = runGit(seams, cwd, fetchArgs);
    if (fetch.code !== 0) {
      const tooOld = endOfOptionsRefusal(seams, cwd, fetchArgs, fetch);
      if (tooOld !== null) return { kind: "refused", reason: tooOld };
      throw new SquashStateError(`could not fetch the upstream '${upstreamBefore}' ('git ${fetchArgs.join(" ")}' failed: ${fetch.error}).`);
    }
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
  } else {
    remote = asked ?? REMOTE;
    if (asked !== null) {
      // A NAMED REMOTE MUST EXIST, asked of git: `git push nosuch` fails late
      // and loudly, and the refusal here names the mistake instead.
      const known = runGit(seams, cwd, ["remote"]);
      if (known.code !== 0) throw new SquashStateError(`could not list this repository's remotes ('git remote' failed: ${known.error}).`);
      const names = outputLines(known.stdout);
      if (!names.includes(asked)) {
        return { kind: "refused", reason: `this repository has no remote named '${asked}' (it has: ${names.join(", ") || "none"}). Nothing was fetched or pushed.` };
      }
    }
  }

  // THE REFSPEC IN FULL, behind `--`: `refs/heads/<b>:refs/heads/<b>` is a
  // plain update of that one ref whatever the name looks like.
  const argv = ["push", ...(options.setUpstream ? ["-u"] : []), remote, "--", `refs/heads/${branch}:refs/heads/${branch}`];
  const report = (pushed: boolean): PublishReport => ({
    contract: PUBLISH_CONTRACT,
    branch,
    remote,
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
    lines: [`pushed '${branch}' to ${remote}${options.setUpstream ? " (upstream set)" : ""}${ahead === null ? "" : ` -- ${ahead} commit(s) ahead of ${upstreamBefore}`}`],
  };
}
