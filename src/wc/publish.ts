// src/wc/publish.ts -- `nen wc publish`: push the current branch to the remote
// its upstream names, and refuse every shape of push that could rewrite
// somebody else's history (zheref/nen#227; Hatsu's `aka` skill hand-rolled
// this).
//
// THE BRANCH NAME IS ALWAYS THE BRANCH'S OWN (zheref/nen#271): the refspec
// is `refs/heads/<b>:refs/heads/<b>`, and nothing else. WHICH REMOTE it goes
// to is decided in this order, and nowhere else:
//
//   1. NO UPSTREAM: `--remote <name>` when given (it must be one `git remote`
//      lists), else `origin`.
//   2. AN UPSTREAM OF THE SAME NAME (`fork/<b>`), without `--set-upstream`
//      or with it and no `--remote`: the upstream's remote. The branch
//      already says where it goes, so a `--remote` that disagrees is refused
//      -- and the refusal names `--set-upstream --remote <name>`, the one
//      route that moves it, never a `git branch --set-upstream-to` at a ref
//      the remote does not have yet.
//   3. `--set-upstream` REPLACING THE UPSTREAM -- one of another name, or one
//      of the same name with a `--remote` that names another remote:
//      `--remote <name>` when given (validated against `git remote` exactly as
//      in 1), else `origin` when this repository has one -- #271's own
//      "origin/<current branch name>" -- else the upstream's own remote. A
//      branch cut from `upstream/main` in a fork workflow is published to
//      `origin`, the fork, never to the canonical repository it was cut from
//      (Nobunaga F1 on the #271 change).
//
// IT USED TO FOLLOW THE UPSTREAM'S NAME, and that is the defect #271 records.
// Until then a local `feature` tracking `fork/topic` was pushed AS `topic`
// (Copilot review on zheref/nen#231, round 3, T9), so that the ref the
// fast-forward check looked at was the ref the push moved. That consistency
// was real, and it was bought at the price of pushing somewhere the caller
// never named: on 2026-09-28 a stacked effort cut with `shu warmup --from
// <another effort's branch>` tracked that other branch, and `wc publish
// --set-upstream` put its commit on the other branch -- and on the pull
// request open from it. A mismatched upstream is a FACT TO REPORT, never a
// destination to follow.
//
// SO A MISMATCHED UPSTREAM IS REFUSED, AT EXIT 2, UNLESS `--set-upstream`.
// When the upstream's branch name differs from the current branch's -- a
// stacked branch tracking its base, `git worktree add -b x origin/main`
// tracking the trunk, a local name tracking a remote of another name -- a
// bare publish refuses before any fetch, naming the branch, the upstream and
// the fix. `--set-upstream` is the fix: it publishes to `<remote>/<own name>`
// (the remote chosen by rule 3 above) and `-u` retracks the branch there,
// replacing the mismatched upstream (`retargetedUpstream: true`). The
// fast-forward is then judged against `<remote>/<own name>` when the remote
// already has that ref, and against nothing when it does not (nothing is
// there for a push to rewrite) -- never against the upstream's branch, which
// this push does not move.
//
// AN UPSTREAM BEING REPLACED MAY ALREADY BE GONE (Nobunaga F2). A stacked
// branch whose base was merged and deleted still names it; its fetch answers
// "couldn't find remote ref". That fetch only feeds `ahead`, so on this route
// -- and only this one -- the answer is `ahead: null` and a sentence saying
// the upstream is gone, never an exit 1 that blocks the one route the refusal
// above names. Any other fetch failure is still exit 1.
//
// THE TRUNK IS NEVER A DESTINATION (zheref/nen#234), and that promise is
// older than #271 and survives it unchanged. On 2026-09-21 a branch tracking
// `origin/main` was pushed as `refs/heads/x:refs/heads/main` and fast-forwarded
// the trunk with no pull request. #234 stopped that by publishing a
// trunk-tracking branch under its own name even without `--set-upstream`;
// #271 folds that case into the general one, so it now refuses without
// `--set-upstream` like every other mismatch -- which is also what git's own
// `push.default=simple` answers for it. A trunk DESTINATION is still checked
// on the final refspec, right before the push, but only as a defensive belt:
// the destination is the local name, and a local name that is the trunk was
// refused first, so the belt cannot fire unless a later change reintroduces a
// second route to the destination.
//
// FIVE REFUSALS BEFORE ANY WRITE, all at exit 2, because each is a mistake in
// the invocation rather than a fact about the remote: a DETACHED HEAD (there
// is no branch to push); the TRUNK -- the workflow's `branch.base`, and
// `main`/`master` whatever the policy says -- because nothing here ever
// pushes the trunk directly; anything that LOOKS LIKE A REFSPEC OR A FORCE
// (a positional, a `+`, a `:`, a `--force` -- the last is already unknown to
// the parser); a `--remote` this repository does not have, or one that
// contradicts a same-name upstream without `--set-upstream` (rule 2); and an
// UPSTREAM OF ANOTHER NAME without `--set-upstream` (above). Every one of
// them is decided before the fetch -- `git remote` is a local read.
//
// ONE MORE IS A FACT ABOUT THE REMOTE, AND EXIT 1: a ref this push would move
// that exists and is NOT an ancestor of the local branch is a push git would
// refuse without `--force`, and `needsForce: true` is the whole of what this
// verb says about it. What to do -- catch up, or decide the rewrite is wanted
// and do it by hand -- is not decided here.
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
  /** The local branch pushed: the source half of the refspec. */
  readonly branch: string;
  /** The remote pushed to, by the header's three rules: `--remote`/`origin` with no upstream; the upstream's own when it is kept; `--remote`, else `origin`, else the upstream's own when `--set-upstream` replaces it. */
  readonly remote: string;
  /**
   * The branch name on the remote the push updates. Always `branch` since
   * zheref/nen#271 -- a push never follows an upstream onto another name --
   * and kept so that a reader of the v0.1 contract has nothing to change.
   */
  readonly destination: string;
  /** The `<remote>/<branch>` the branch tracked before this call, or null. */
  readonly upstreamBefore: string | null;
  /** Commits on the branch not on `upstreamBefore`; null when there is no upstream to count against, or when the upstream `--set-upstream` replaces is gone from its remote (Nobunaga F2). */
  readonly ahead: number | null;
  /** True when the ref this push moves exists and the local branch is not a fast-forward of it. Nothing was pushed. */
  readonly needsForce: boolean;
  readonly pushed: boolean;
  readonly dryRun: boolean;
  /**
   * True when `--set-upstream` replaced the upstream -- one of ANOTHER name,
   * or one on another remote than `--remote` names -- with `<remote>/<branch>`;
   * or, on `--dry-run`, would. False
   * whenever nothing was (or would be) pushed, `needsForce` included: the
   * upstream is only rewritten by the `-u` of a push that lands
   * (zheref/nen#234, zheref/nen#271).
   */
  readonly retargetedUpstream: boolean;
}

export type PublishOutcome =
  | { readonly kind: "refused"; readonly reason: string }
  | { readonly kind: "done"; readonly report: PublishReport; readonly lines: readonly string[] };

export interface PublishOptions {
  /** The workflow's `branch.base`, already loaded by the caller. */
  readonly base: string;
  readonly setUpstream: boolean;
  readonly dryRun: boolean;
  /** `--remote <name>`: where a branch with NO upstream goes, and where `--set-upstream` takes one whose upstream it replaces; null means the header's defaults. */
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
 * The branch a tracked name means with ONE leading `refs/heads/` taken off.
 * `git rev-parse --abbrev-ref <b>@{upstream}` reports `origin/main`, never
 * `origin/refs/heads/main`; but a tracked name that already carries the
 * prefix would otherwise be spelled `refs/heads/refs/heads/main` in the
 * fetch refspec, so it is stripped once, defensively, before it is used
 * in an argv (Copilot review on zheref/nen#235). A leading `+` is NOT taken
 * off here: that shape is refused by refuseBranchName, never normalized away.
 */
export function trackedBranchName(name: string): string {
  return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
}

/** True when `name`, normalized, is the workflow's `branch.base` or one of TRUNK_NAMES. */
export function isTrunk(name: string, base: string): boolean {
  const named = normalizeBranchName(name);
  return named === base || TRUNK_NAMES.includes(named);
}

/**
 * The exit-2 refusal for a push whose DESTINATION -- the branch name on the
 * remote the refspec would update -- is the trunk, or null when it is not
 * (zheref/nen#234). Compared normalized, so `refs/heads/main` and `+main` are
 * the trunk too.
 *
 * A DEFENSIVE BELT THAT CANNOT FIRE TODAY, and kept on purpose. Since
 * zheref/nen#271 the destination is the local name, and a local name that is
 * the trunk is refused before anything else runs -- so this check only
 * matters the day a change reintroduces a second route to the destination.
 * It runs right before the push argv is built so that such a change meets it
 * without anybody having to remember it exists. (It used to name the
 * upstream as the route the push would take; that route is gone, and so is
 * the clause -- Nobunaga F3.)
 */
export function trunkDestinationRefusal(branch: string, destination: string, base: string): string | null {
  if (!isTrunk(destination, base)) return null;
  const why = normalizeBranchName(destination) === base ? " (nen/workflow.json's branch.base)" : "";
  return `the push destination '${destination}' for '${branch}' is the trunk${why}, and this verb never pushes the trunk directly: the trunk moves by merging a pull request. Cut a branch for this work. Nothing was pushed.`;
}

/**
 * The exit-2 refusal for a bare publish of a branch whose upstream names a
 * branch of ANOTHER name (zheref/nen#271), or null when the names agree.
 *
 * BOTH NAMES ARE SAID, AND SO IS THE ONE FIX THIS VERB OFFERS. The upstream is
 * never followed -- that is how one effort's commit landed on another's pull
 * request -- and it is never silently ignored either, because a push under the
 * branch's own name that left the upstream where it was would leave every
 * later reader of `@{upstream}` (`wc squash`'s published-commit guard,
 * `wc catch-up`'s auto strategy, `pr open`'s is-it-pushed check) reasoning
 * against a branch this one was never published to. `--set-upstream` pushes
 * to `<remote>/<branch>` and rewrites the upstream in the same act.
 *
 * `tracked` is the upstream's branch with one `refs/heads/` taken off, as
 * trackedBranchName gives it; the names are compared exactly, because git
 * compares ref names exactly. `remote` is where `--set-upstream` would take
 * it -- rule 3 of this file's header, already resolved by the caller -- so the
 * route the refusal names is the route the verb would take.
 */
export function foreignUpstreamRefusal(branch: string, upstreamBefore: string, remote: string, tracked: string, base: string): string | null {
  if (tracked === branch) return null;
  // The trunk is said by name, and it drops the "publish that branch instead"
  // alternative: the trunk is never published by this verb at all.
  const trunk = isTrunk(tracked, base);
  const named = trunk ? `, the trunk${normalizeBranchName(tracked) === base ? " (nen/workflow.json's branch.base)" : ""} -- which is never a destination either` : "";
  const otherwise = trunk ? "" : `; if the commits really belong on '${tracked}', check that branch out and publish it instead`;
  return `'${branch}' tracks '${upstreamBefore}', whose branch '${tracked}' is not '${branch}'${named}. This verb pushes a branch only under its own name, and never follows an upstream onto another one: that is how one effort's commits land on another branch and on the pull request open from it (zheref/nen#271). Pass --set-upstream to publish '${branch}' to '${remote}/${branch}' and retrack it there, replacing '${upstreamBefore}' (add --remote <name> to publish it to another remote)${otherwise}. Nothing was fetched or pushed.`;
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

/**
 * True when a failed fetch said the remote has no such ref -- git's own
 * "couldn't find remote ref" -- and nothing else. Only an upstream this call
 * is REPLACING may be read that way (Nobunaga F2): its fetch feeds `ahead`
 * and nothing more. Every other failure, and this one on any other route,
 * stays the exit-1 git failure it is.
 */
export function isMissingRemoteRef(fetch: GitCall): boolean {
  return !fetch.spawnFailed && /couldn't find remote ref/i.test(fetch.error);
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
  if (isTrunk(branch, options.base)) {
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
  // Where the push lands on the remote: the branch's OWN name, whatever the
  // upstream says (zheref/nen#271). A `const`, so no route below can move it.
  const destination = branch;
  // The upstream's branch and remote, once there is one; whether its branch
  // is another name than this branch's (a stacked branch tracking its base, a
  // worktree branch tracking `origin/main`); and whether this call REPLACES
  // the upstream -- rule 3 of this file's header -- which only
  // `--set-upstream` ever does.
  let tracked: string | null = null;
  let upstreamRemote: string | null = null;
  let foreignUpstream = false;
  let replacing = false;
  // True when the upstream being replaced no longer exists on its remote
  // (Nobunaga F2): `ahead` is then null, and the text says why.
  let upstreamGone = false;
  // `git remote`, read at most once, and only on a route that needs it.
  let remotes: readonly string[] | null = null;
  const listRemotes = (): readonly string[] => {
    if (remotes === null) {
      const known = runGit(seams, cwd, ["remote"]);
      if (known.code !== 0) throw new SquashStateError(`could not list this repository's remotes ('git remote' failed: ${known.error}).`);
      remotes = outputLines(known.stdout);
    }
    return remotes;
  };
  // A NAMED REMOTE MUST EXIST, asked of git: `git push nosuch` fails late
  // and loudly, and the refusal here names the mistake instead. The same
  // check on every route that honours `--remote`.
  const unknownRemote = (name: string): string | null => {
    const names = listRemotes();
    return names.includes(name) ? null : `this repository has no remote named '${name}' (it has: ${names.join(", ") || "none"}). Nothing was fetched or pushed.`;
  };
  if (upstreamBefore !== null) {
    const upstream = splitUpstream(upstreamBefore);
    const from = upstream.remote;
    upstreamRemote = from;
    tracked = trackedBranchName(upstream.branch);
    if (looksLikeRefspecOrForce(from)) {
      return { kind: "refused", reason: `the upstream's remote '${from}' looks like an option or a refspec (a leading '+' or '-', or a ':'), and this verb never lets a name change what a push or fetch does. Nothing was fetched or pushed.` };
    }
    const badTracked = refuseBranchName(seams, cwd, tracked, `the upstream's branch`);
    if (badTracked !== null) return { kind: "refused", reason: badTracked };
    foreignUpstream = tracked !== branch;
    if (asked !== null && asked !== from) {
      const unknown = unknownRemote(asked);
      if (unknown !== null) return { kind: "refused", reason: unknown };
      // RULE 2: a same-name upstream already says where the branch goes, and
      // only --set-upstream moves it. The refusal names THAT route -- never
      // `git branch --set-upstream-to <asked>/<branch>`, which git refuses
      // outright while the remote has no such branch, i.e. on exactly the
      // first publish this would be (Nobunaga F1).
      if (!options.setUpstream && !foreignUpstream) {
        return {
          kind: "refused",
          reason: `'${branch}' tracks '${upstreamBefore}', so without --set-upstream it is pushed to '${from}' -- --remote '${asked}' names a different one. Drop --remote to publish to '${from}', or pass --set-upstream --remote ${asked} to publish it to '${asked}/${branch}' and track that instead. Nothing was fetched or pushed.`,
        };
      }
    }
    // RULE 3: the remote a replacing publish goes to -- --remote, else origin
    // when this repository has one, else the upstream's own. Resolved BEFORE
    // the refusal below, so the route it names is the route the verb takes.
    const retracks = foreignUpstream || (options.setUpstream && asked !== null && asked !== from);
    remote = retracks ? (asked ?? (listRemotes().includes(REMOTE) ? REMOTE : from)) : from;
    // A MISMATCHED UPSTREAM IS REPORTED, NEVER FOLLOWED (zheref/nen#271). A
    // bare publish refuses here, before the fetch, naming both names; with
    // --set-upstream the push goes to `<remote>/<branch>` and its `-u`
    // replaces the upstream.
    if (!options.setUpstream) {
      const mismatched = foreignUpstreamRefusal(branch, upstreamBefore, remote, tracked, options.base);
      if (mismatched !== null) return { kind: "refused", reason: mismatched };
    }
    replacing = retracks;
    // FETCH FIRST: a fast-forward decided against a stale remote-tracking ref
    // is a decision about yesterday's remote, and the push would still be
    // refused -- or, worse, accepted by a `--force` somebody typed next. The
    // upstream is fetched even when it is being replaced, because `ahead` is
    // counted against it -- and on that route alone a branch the remote no
    // longer has is an answer (`ahead: null`), not a failure (F2).
    const fetchArgs = fetchArgv(from, tracked);
    const fetch = runGit(seams, cwd, fetchArgs);
    if (fetch.code !== 0) {
      const tooOld = endOfOptionsRefusal(seams, cwd, fetchArgs, fetch);
      if (tooOld !== null) return { kind: "refused", reason: tooOld };
      if (replacing && isMissingRemoteRef(fetch)) upstreamGone = true;
      else throw new SquashStateError(`could not fetch the upstream '${upstreamBefore}' ('git ${fetchArgs.join(" ")}' failed: ${fetch.error}).`);
    }
    // THE FAST-FORWARD IS JUDGED AGAINST THE REF THE PUSH MOVES. That is the
    // upstream itself when this call keeps it -- and `<remote>/<branch>` when
    // it replaces it, where the push goes instead: that ref is fetched and
    // compared when the remote has it, and when the remote does not (asked
    // with `ls-remote --exit-code`, exit 2 = no such ref) there is nothing a
    // push could rewrite, so no force is possible.
    let moved: string | null = replacing ? null : upstreamBefore;
    if (replacing) {
      const probe = runGit(seams, cwd, ["ls-remote", "--exit-code", remote, `refs/heads/${branch}`]);
      if (probe.code === 0) {
        const ownArgs = fetchArgv(remote, branch);
        const own = runGit(seams, cwd, ownArgs);
        if (own.code !== 0) throw new SquashStateError(`could not fetch '${remote}/${branch}', the ref this push updates ('git ${ownArgs.join(" ")}' failed: ${own.error}).`);
        moved = `${remote}/${branch}`;
      } else if (probe.spawnFailed || probe.code !== 2) {
        throw new SquashStateError(`could not ask '${remote}' whether it has 'refs/heads/${branch}' ('git ls-remote --exit-code ${remote} refs/heads/${branch}' failed: ${probe.error}).`);
      }
    }
    if (moved !== null) {
      const ancestor = runGit(seams, cwd, ["merge-base", "--is-ancestor", moved, "HEAD"]);
      if (ancestor.spawnFailed || ancestor.code > 1) {
        throw new SquashStateError(`could not test whether '${moved}' is an ancestor of HEAD ('git merge-base --is-ancestor ${moved} HEAD' failed: ${ancestor.error}).`);
      }
      needsForce = ancestor.code !== 0;
    }
    if (!upstreamGone) {
      const count = runGit(seams, cwd, ["rev-list", "--count", `${upstreamBefore}..HEAD`]);
      if (count.code !== 0 || !/^\d+$/.test(count.stdout.trim())) {
        throw new SquashStateError(`could not count the commits ahead of '${upstreamBefore}' ('git rev-list --count ${upstreamBefore}..HEAD' failed: ${count.error}).`);
      }
      ahead = Number(count.stdout.trim());
    }
  } else {
    // RULE 1: no upstream -- --remote when given, else origin.
    remote = asked ?? REMOTE;
    if (asked !== null) {
      const unknown = unknownRemote(asked);
      if (unknown !== null) return { kind: "refused", reason: unknown };
    }
  }

  // THE DESTINATION IS NEVER THE TRUNK -- a defensive belt that cannot fire
  // while the destination is the local name (a local trunk was refused
  // first); it is here for the day a second route to the destination is
  // added (zheref/nen#234, Nobunaga F3).
  const trunkDestination = trunkDestinationRefusal(branch, destination, options.base);
  if (trunkDestination !== null) return { kind: "refused", reason: trunkDestination };

  // THE UPSTREAM IS REWRITTEN ONLY BY THE `-u` OF A PUSH THAT LANDS: a
  // needsForce answer pushes nothing, so it retargets nothing, and the report
  // says so rather than announcing a retrack that did not happen. On
  // --dry-run it is the prediction, as `destination` is.
  const retargetedUpstream = replacing && !needsForce;

  // THE REFSPEC IN FULL, behind `--`: `refs/heads/<b>:refs/heads/<b>` is a
  // plain update of that one ref whatever the name looks like.
  const argv = ["push", ...(options.setUpstream ? ["-u"] : []), remote, "--", `refs/heads/${branch}:refs/heads/${destination}`];
  const report = (pushed: boolean): PublishReport => ({
    contract: PUBLISH_CONTRACT,
    branch,
    remote,
    destination,
    upstreamBefore,
    ahead,
    needsForce,
    pushed,
    dryRun: options.dryRun,
    retargetedUpstream,
  });
  // What the text says about an upstream this call replaces: what it named,
  // where the branch went instead, and where its upstream is (or would be)
  // now. Only --set-upstream reaches here with one -- a bare publish refused
  // above.
  const replaced = !foreignUpstream
    ? `another remote ('${upstreamRemote ?? ""}')`
    : tracked !== null && isTrunk(tracked, options.base)
      ? "the trunk"
      : "another branch";
  if (needsForce) {
    const against = replacing ? `'${remote}/${branch}', the ref this push updates` : `its upstream '${upstreamBefore}'`;
    const kept = replacing ? ` Its upstream still names '${upstreamBefore}': nothing was retracked either.` : "";
    return {
      kind: "done",
      report: report(false),
      lines: [
        `'${branch}' is not a fast-forward of ${against}: the push would need --force, and this verb never forces. Nothing was pushed.${kept} Catch the branch up first ('nen wc catch-up --base <ref>'), or decide the rewrite is wanted and do it by hand.`,
      ],
    };
  }
  if (options.dryRun) {
    const counted =
      upstreamBefore === null
        ? "  (no upstream yet)"
        : ahead === null
          ? `  (nothing counted: '${upstreamBefore}' is gone from ${upstreamRemote ?? ""})`
          : `  (${ahead} ahead of ${upstreamBefore})`;
    const retrack = !retargetedUpstream ? "" : ` -- its upstream '${upstreamBefore}' names ${replaced}, so it would go to ${remote} under its own name and then track ${remote}/${branch}`;
    return { kind: "done", report: report(false), lines: [`would run: git ${argv.join(" ")}${counted}${retrack}`] };
  }
  const push = runGit(seams, cwd, argv);
  if (push.code !== 0) throw new SquashStateError(`could not push '${branch}' ('git ${argv.join(" ")}' failed: ${push.error}).`);
  const counted =
    ahead !== null
      ? ` -- ${ahead} commit(s) ahead of ${upstreamBefore}`
      : upstreamGone
        ? ` -- nothing counted: '${upstreamBefore}' is gone from ${upstreamRemote ?? ""}`
        : "";
  const retracked = !retargetedUpstream ? "" : ` -- its upstream '${upstreamBefore}' named ${replaced}, so it went to ${remote} under its own name and now tracks ${remote}/${branch}`;
  return {
    kind: "done",
    report: report(true),
    lines: [`pushed '${branch}' to ${remote}${options.setUpstream ? " (upstream set)" : ""}${counted}${retracked}`],
  };
}
