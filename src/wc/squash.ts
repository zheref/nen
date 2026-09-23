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
//
// THE BASE IS A SECOND PUBLISHED PLACE, AND IT IS GUARDED ON ITS OWN
// (zheref/nen#251). The fold set is `git merge-base <onto> HEAD`..HEAD, so a
// branch carrying a CATCH-UP MERGE of its base folds every commit that merge
// brought in -- commits published on `origin/<base>`, which the `@{upstream}`
// guard never sees because they are not on `origin/<branch>`. Squashing them
// would rewrite other people's published history into one commit authored on
// this branch and flatten the merge's ancestry. So once the upstream guard
// passes, every folded commit reachable from the base -- `origin/<base>` and
// the local `<base>`, whichever resolve -- is named and the squash REFUSED.
// Refused rather than silently excluded: a fold that skipped the base commits
// would still collapse the merge into a single-parent commit, which is the
// ancestry loss the refusal exists to prevent.
//
// THE BASE CHECK DOES NOT FETCH. A catch-up merge can only have brought in
// commits this repository already holds, and `origin/<base>` is the ref `nen
// wc catch-up` fetched them into; the local `<base>` covers a merge of an
// unpushed trunk. A repository where neither ref resolves has no base to
// guard against, and the report says the check was NOT performed (an empty
// `baseRefs`, a text line saying so) rather than rendering it as clean.

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
      /** The base refs the fold set was checked against (`origin/<base>`, `<base>`); empty when neither resolves -- NOT checked. */
      readonly baseRefs: readonly string[];
    };

/** The remote a base is fetched into by `nen wc catch-up` -- ./publish.ts's REMOTE, restated so this module imports nothing from its own importer. */
const BASE_REMOTE = "origin";

/** How many base-reachable commits a refusal lists by name before it counts the rest. */
export const BASE_LIST_CAP = 20;

/** The base a squash guards against, and where its name came from -- quoted in the refusal. */
export interface SquashBase {
  /** The branch name, e.g. `main`. */
  readonly name: string;
  /** Where the name came from: `--base`, or nen/workflow.json's `branch.base` (its default when the file is absent). */
  readonly source: string;
}

/** One folded commit found on the base, and the base ref it was found on. */
export interface BaseHit {
  readonly commit: FoldedCommit;
  readonly ref: string;
}

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
export function parseFolded(logOutput: string): FoldedCommit[] {
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
 * upstream (fetched first); any commit in the range already on the base
 * (`origin/<base>` or `<base>`; zheref/nen#251). Fewer than two commits to
 * fold is answered as `nothing-to-squash` -- a SUCCESS, not a refusal, per
 * the verb's own contract.
 */
export function planSquash(seams: Seams, cwd: string, onto: string, base: SquashBase): SquashPlan {
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
  const { upstream, published } = findPublishedCommit(seams, cwd, folded);
  if (published !== null) {
    return {
      kind: "refused",
      reason: `commit ${published.sha} ('${published.subject}') is already on the upstream '${upstream ?? ""}' -- already published; squashing would rewrite pushed history. Rebase or cut a fresh branch instead of folding a commit that is already there.`,
    };
  }

  // 5. NONE OF THE FOLDED COMMITS MAY ALREADY BE ON THE BASE (zheref/nen#251).
  // After the upstream guard, so every refusal that existed before keeps its
  // precedence and its words.
  const { refs: baseRefs, reachable } = findBaseReachable(seams, cwd, mergeBaseSha, folded, base.name);
  if (reachable.length > 0) {
    const listed = reachable
      .slice(0, BASE_LIST_CAP)
      .map((hit): string => `${hit.commit.sha} ('${hit.commit.subject}', on ${hit.ref})`);
    const more = reachable.length > BASE_LIST_CAP ? `; and ${reachable.length - BASE_LIST_CAP} more` : "";
    return {
      kind: "refused",
      reason: `${reachable.length} of the ${folded.length} commit(s) since 'git merge-base ${onto} HEAD' (${mergeBaseSha}) are already on the base '${base.name}' (${base.source}; checked against ${baseRefs.join(", ")}) -- a merge of the base brought them into this branch, and squashing would rewrite the base's published history into one commit on this branch and flatten the merge's ancestry: ${listed.join("; ")}${more}. Squash only this branch's own commits (an --onto at or after the last base merge), or publish them unsquashed.`,
    };
  }

  return { kind: "ready", onto, mergeBase: mergeBaseSha, folded, upstream, baseRefs };
}

/**
 * Which folded commits the base already holds. The candidate refs are
 * `origin/<base>` and `<base>`, each resolved with `git rev-parse --verify
 * --quiet <full ref>^{commit}` -- an absent ref is exit 1 and is skipped; a
 * git that never started, or any other code, is a git FAILURE and throws,
 * never read as "no base". Per resolved ref, ONE `git rev-list HEAD --not
 * <merge-base> <ref sha>` lists the folded commits that ref does NOT hold;
 * every folded commit missing from that list is on the base.
 */
export function findBaseReachable(
  seams: Seams,
  cwd: string,
  mergeBaseSha: string,
  folded: readonly FoldedCommit[],
  base: string,
): { readonly refs: readonly string[]; readonly reachable: readonly BaseHit[] } {
  const candidates = [
    { short: `${BASE_REMOTE}/${base}`, full: `refs/remotes/${BASE_REMOTE}/${base}` },
    { short: base, full: `refs/heads/${base}` },
  ];
  const refs: string[] = [];
  const hits = new Map<string, BaseHit>();
  for (const candidate of candidates) {
    const resolved = runGit(seams, cwd, ["rev-parse", "--verify", "--quiet", `${candidate.full}^{commit}`]);
    if (resolved.spawnFailed || resolved.code > 1) {
      throw new SquashStateError(
        `could not resolve the base ref '${candidate.full}' ('git rev-parse --verify --quiet ${candidate.full}^{commit}' failed: ${resolved.error}).`,
      );
    }
    if (resolved.code !== 0) continue;
    const refSha = resolved.stdout.trim();
    refs.push(candidate.short);
    const own = runGit(seams, cwd, ["rev-list", "HEAD", "--not", mergeBaseSha, refSha]);
    if (own.code !== 0) {
      throw new SquashStateError(
        `could not list the folded commits '${candidate.short}' does not hold ('git rev-list HEAD --not ${mergeBaseSha} ${refSha}' failed: ${own.error}).`,
      );
    }
    const notOnBase = new Set(rawLines(own.stdout).map((line): string => line.trim()));
    for (const commit of folded) {
      if (!notOnBase.has(commit.sha) && !hits.has(commit.sha)) hits.set(commit.sha, { commit, ref: candidate.short });
    }
  }
  // Oldest first: the fold set's own order.
  const reachable = folded.flatMap((commit): BaseHit[] => {
    const hit = hits.get(commit.sha);
    return hit === undefined ? [] : [hit];
  });
  return { refs, reachable };
}

/** What the published-commit check found: the upstream, and the first commit already on it. */
export interface PublishedCheck {
  /** The resolved `<remote>/<branch>` this branch tracks, or null when none is set. */
  readonly upstream: string | null;
  /** The first of `commits` (in the order given) reachable from the upstream, or null. */
  readonly published: FoldedCommit | null;
}

/**
 * THE PUBLISHED-COMMIT DETECTION, shared by `wc squash` (which refuses to fold
 * one) and `wc catch-up` (whose `auto` strategy merges rather than rebases
 * when one exists; zheref/nen#227). One reader, so the two verbs never
 * disagree about what "already pushed" means: the branch's `@{upstream}`,
 * FETCHED FIRST -- a stale remote-tracking ref would let an already-pushed
 * commit slip past by simply being invisible -- then `git merge-base
 * --is-ancestor <sha> <upstream>` per commit. No upstream is `{upstream:
 * null, published: null}`: there is nothing published to protect.
 */
export function findPublishedCommit(seams: Seams, cwd: string, commits: readonly FoldedCommit[]): PublishedCheck {
  const upstreamResult = runGit(seams, cwd, ["rev-parse", "--abbrev-ref", "@{upstream}"]);
  if (upstreamResult.code !== 0) return { upstream: null, published: null };
  const upstream = upstreamResult.stdout.trim();
  const slash = upstream.indexOf("/");
  if (slash === -1) {
    throw new SquashStateError(
      `the upstream '${upstream}' does not look like '<remote>/<branch>' -- refusing to fetch a remote this module cannot name from it.`,
    );
  }
  const remote = upstream.slice(0, slash);
  const branch = upstream.slice(slash + 1);
  const fetch = runGit(seams, cwd, ["fetch", remote, branch]);
  if (fetch.code !== 0) {
    throw new SquashStateError(
      `could not fetch the upstream '${upstream}' ('git fetch ${remote} ${branch}' failed: ${fetch.error}).`,
    );
  }
  for (const commit of commits) {
    const reachable = runGit(seams, cwd, ["merge-base", "--is-ancestor", commit.sha, upstream]);
    if (reachable.spawnFailed || reachable.code > 1) {
      throw new SquashStateError(
        `could not test whether commit '${commit.sha}' is already on the upstream '${upstream}' ('git merge-base --is-ancestor ${commit.sha} ${upstream}' failed: ${reachable.error}).`,
      );
    }
    if (reachable.code === 0) return { upstream, published: commit };
  }
  return { upstream, published: null };
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
