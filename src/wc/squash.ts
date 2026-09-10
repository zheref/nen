// src/wc/squash.ts -- `nen wc squash`: fold every commit on this branch
// since `git merge-base <onto> HEAD` into ONE, the workflow fold-in's aka
// residue closed ("wc squash missing: git reset --soft $(git merge-base
// origin/main HEAD) + one commit").
//
// REFUSE BEFORE ANYTHING MOVES. Every check `planSquash` makes is read-only
// -- status, merge-base, rev-list, rev-parse, fetch, is-ancestor -- and the
// two writing calls (`git reset --soft`, `git commit -F`) live in
// `performSquash`, the ONLY function in this module that mutates anything,
// called only once a plan has already answered "ready".
//
// `git fetch` FOR THE UPSTREAM-REACHABILITY CHECK IS NOT AN EXCEPTION TO
// "never touches a remote" -- it is a READ: it updates a remote-tracking ref
// this repository already keeps, never a branch, and this module never
// pushes. ../pr/cascade.ts's own header draws the identical line for its own
// fetch.
//
// `git reset --soft` IS RECOVERABLE, ON PURPOSE, which is what makes it safe
// to run before the commit that follows it is guaranteed to succeed: it only
// moves the branch ref and the index, never deletes a commit OBJECT, so a
// `git commit -F` that then fails (a vanished message file, a local hook)
// leaves the original commits reachable from `ORIG_HEAD` / the reflog. This
// module never runs a second write that could make that state permanent --
// no `--hard`, no `push` -- so the two-line recovery it names in its own
// error is always available.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";

export interface FoldedCommit {
  readonly sha: string;
  readonly subject: string;
}

export type SquashPlan =
  | { readonly kind: "refused"; readonly reason: string }
  | {
      readonly kind: "nothing-to-squash";
      readonly onto: string;
      readonly mergeBase: string;
      readonly folded: readonly FoldedCommit[];
    }
  | {
      readonly kind: "ready";
      readonly onto: string;
      readonly mergeBase: string;
      readonly folded: readonly FoldedCommit[];
      /** The resolved `<remote>/<branch>` this branch tracks, or null when none is set. */
      readonly upstream: string | null;
    };

/**
 * A git command this module could not run at all, as distinct from one that
 * ran and answered "refused" -- ../wc/classify.ts's own WcStateError draws
 * the identical line: "not checked" must never render as a decided outcome.
 * A caller (../wc/command.ts) lets this propagate as the verb's own failure
 * (exit 1), never as one of `planSquash`'s named refusals (exit 2).
 */
export class SquashStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SquashStateError";
  }
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

/** `<sha>\t<subject>` lines (git log's own `%H%x09%s`) into typed rows. */
function parseFolded(logOutput: string): FoldedCommit[] {
  return rawLines(logOutput).map((line): FoldedCommit => {
    const index = line.indexOf("\t");
    return index === -1
      ? { sha: line, subject: "" }
      : { sha: line.slice(0, index), subject: line.slice(index + 1) };
  });
}

/**
 * Every read-only fact `nen wc squash` needs, and the refusal decision, all
 * before a single write: a dirty working tree; `--onto` not an ancestor of
 * HEAD; any commit in the range already reachable from this branch's
 * upstream (fetched first). Fewer than two commits to fold is answered as
 * `nothing-to-squash` -- a SUCCESS, not a refusal, per the verb's own
 * contract.
 */
export function planSquash(seams: Seams, cwd: string, onto: string): SquashPlan {
  // 1. THE WORKING TREE MUST BE CLEAN. Same invocation as ../wc/classify.ts's
  // readWorkingCopyState, so the two verbs never disagree about what "dirty"
  // means.
  const status = runGit(seams, cwd, ["status", "--porcelain=v1", "-uall"]);
  if (status.code !== 0) {
    throw new SquashStateError(
      `could not read the working copy's status ('git status --porcelain=v1 -uall' failed: ${status.error}).`,
    );
  }
  const dirtyPaths = rawLines(status.stdout)
    .map((line): string => line.slice(3).trim())
    .filter((path): boolean => path !== "");
  if (dirtyPaths.length > 0) {
    return {
      kind: "refused",
      reason: `the working tree is dirty -- ${dirtyPaths.length} uncommitted or untracked path(s): ${dirtyPaths.join(", ")}. Commit or stash them first; a squash never folds work that was never committed.`,
    };
  }

  // 2. --onto MUST BE AN ANCESTOR OF HEAD. `git merge-base <onto> HEAD` is
  // computed regardless of the answer below, because its result is what the
  // reset target IS on success and what the refusal NAMES on failure -- "say
  // what merge-base found", not merely that it disagreed.
  const mergeBase = runGit(seams, cwd, ["merge-base", onto, "HEAD"]);
  if (mergeBase.code !== 0) {
    throw new SquashStateError(
      `could not compute the merge base of --onto '${onto}' and HEAD ('git merge-base ${onto} HEAD' failed: ${mergeBase.error}).`,
    );
  }
  const mergeBaseSha = mergeBase.stdout.trim();

  const ancestor = runGit(seams, cwd, ["merge-base", "--is-ancestor", onto, "HEAD"]);
  // A code above 1, or a git that never started (spawnFailed), is a git
  // FAILURE and must never be read as "not an ancestor" -- ../tag/cut.ts's
  // own ancestor check draws the identical line.
  if (ancestor.spawnFailed || ancestor.code > 1) {
    throw new SquashStateError(
      `could not test whether --onto '${onto}' is an ancestor of HEAD ('git merge-base --is-ancestor ${onto} HEAD' failed: ${ancestor.error}).`,
    );
  }
  if (ancestor.code !== 0) {
    return {
      kind: "refused",
      reason: `--onto '${onto}' is not an ancestor of HEAD -- 'git merge-base ${onto} HEAD' found '${mergeBaseSha}' as the nearest shared commit, which is not '${onto}' itself, so this branch has diverged from --onto rather than being built on top of it. Only a branch built on top of --onto can be squashed onto it.`,
    };
  }

  // 3. THE COMMITS THIS SQUASH WOULD FOLD, oldest first -- the same
  // top-to-bottom convention ../wc/classify.ts's own existingCommitSubjects
  // reads.
  const log = runGit(seams, cwd, ["log", `${mergeBaseSha}..HEAD`, "--format=%H%x09%s"]);
  if (log.code !== 0) {
    throw new SquashStateError(
      `could not read the commits ahead of '${mergeBaseSha}' ('git log ${mergeBaseSha}..HEAD' failed: ${log.error}).`,
    );
  }
  const folded = parseFolded(log.stdout).reverse();

  // FEWER THAN TWO IS NOT A REFUSAL. There is nothing to fold -- zero commits
  // (--onto resolves to HEAD itself) or exactly one (nothing to collapse) --
  // so this is the verb's own success case, reported at exit 0 by the caller.
  if (folded.length < 2) {
    return { kind: "nothing-to-squash", onto, mergeBase: mergeBaseSha, folded };
  }

  // 4. NONE OF THE FOLDED COMMITS MAY ALREADY BE ON THE UPSTREAM. No upstream
  // configured is not a refusal -- there is nothing published to protect.
  const upstreamResult = runGit(seams, cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  let upstream: string | null = null;
  if (upstreamResult.code === 0) {
    upstream = upstreamResult.stdout.trim();
    const slash = upstream.indexOf("/");
    if (slash === -1) {
      throw new SquashStateError(
        `the upstream '${upstream}' does not look like '<remote>/<branch>' -- refusing to fetch a remote this module cannot name from it.`,
      );
    }
    const remote = upstream.slice(0, slash);
    const branch = upstream.slice(slash + 1);
    // FETCH FIRST -- a stale remote-tracking ref would let an already-pushed
    // commit slip past the check below by simply being invisible to it.
    const fetch = runGit(seams, cwd, ["fetch", remote, branch]);
    if (fetch.code !== 0) {
      throw new SquashStateError(
        `could not fetch the upstream '${upstream}' ('git fetch ${remote} ${branch}' failed: ${fetch.error}).`,
      );
    }
    for (const commit of folded) {
      const reachable = runGit(seams, cwd, ["merge-base", "--is-ancestor", commit.sha, upstream]);
      if (reachable.spawnFailed || reachable.code > 1) {
        throw new SquashStateError(
          `could not test whether commit '${commit.sha}' is already on the upstream '${upstream}' ('git merge-base --is-ancestor ${commit.sha} ${upstream}' failed: ${reachable.error}).`,
        );
      }
      if (reachable.code === 0) {
        return {
          kind: "refused",
          reason: `commit ${commit.sha} ('${commit.subject}') is already on the upstream '${upstream}' -- already published; squashing would rewrite pushed history. Rebase or cut a fresh branch instead of folding a commit that is already there.`,
        };
      }
    }
  }

  return { kind: "ready", onto, mergeBase: mergeBaseSha, folded, upstream };
}

/**
 * The mechanism, and ONLY the mechanism: `git reset --soft <mergeBase>` then
 * `git commit -F <messageFile>`, both through the seam. Call this only after
 * `planSquash` has answered `"ready"` -- every refusal this module makes
 * runs strictly before either of these two calls.
 */
export function performSquash(seams: Seams, cwd: string, mergeBaseSha: string, messageFile: string): string {
  const reset = runGit(seams, cwd, ["reset", "--soft", mergeBaseSha]);
  if (reset.code !== 0) {
    throw new SquashStateError(
      `could not reset to '${mergeBaseSha}' ('git reset --soft ${mergeBaseSha}' failed: ${reset.error}). Nothing was committed; the branch is unchanged.`,
    );
  }
  const commit = runGit(seams, cwd, ["commit", "-F", messageFile]);
  if (commit.code !== 0) {
    throw new SquashStateError(
      `reset to '${mergeBaseSha}' but 'git commit -F ${messageFile}' failed: ${commit.error}. The original commits are not lost -- recover them with 'git reset --hard ORIG_HEAD'.`,
    );
  }
  const head = runGit(seams, cwd, ["rev-parse", "HEAD"]);
  if (head.code !== 0) {
    throw new SquashStateError(
      `squashed, but could not read the new commit's sha ('git rev-parse HEAD' failed: ${head.error}).`,
    );
  }
  return head.stdout.trim();
}
