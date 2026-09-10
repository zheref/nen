// src/pr/cascade.ts -- cascade a trunk branch into the current one, by MERGE.
//
// MERGE, NEVER REBASE. The drive skill (§5) is explicit and this is not a
// style preference: rebasing a branch that is already pushed rewrites commits
// another actor (a CI builder, a reviewer's fork) may already hold, and the
// force-push that follows is the exact operation this whole binary's callers
// refuse to reach for silently. `git merge` is the only cascade a shared branch
// tolerates.
//
// A CONFLICT IS REPORTED, NEVER RESOLVED HERE. This module fetches and merges;
// it does not run `git merge --abort`, does not pick a side, and does not
// push when the merge left conflict markers behind. Resolving a real conflict
// is a judgment call (which side's change is right) that stays with whoever
// is driving -- exactly the "what stays with the LLM" line issue #4 draws
// everywhere else. `--no-push` (below) does not change any of that: it only
// removes the push step from the CLEAN-merge path.
//
// `--no-push` STILL MUTATES. It fetches and merges into the current branch's
// working tree and index exactly as the pushing form does -- the only step it
// skips is the network write at the end. izanami's policy table (../parse/
// izanami.ts) therefore keeps this verb `mutating` in every spelling; a
// caller that wants a read-only preview has no such thing here, on purpose.

import { GIT, outputLines, type Seams } from "../seam/exec.js";

/**
 * One unmerged path from a conflicted merge, per `git ls-files -u`'s stage
 * table.
 *
 * KIND NAMING: the first word always names OUR side's action (the branch the
 * trunk is being merged into), the second the TRUNK's. `both-modified` and
 * `add-add` are symmetric by construction (stage 1 present or not decides
 * between them), but `modify-delete` (we kept it, the trunk deleted it) and
 * `delete-modify` (we deleted it, the trunk kept it) are not the same repair
 * and are never collapsed into one label.
 */
export interface CascadeConflict {
  readonly path: string;
  readonly kind: "both-modified" | "add-add" | "modify-delete" | "delete-modify";
  /** Commits on the current branch that touched this path since the merge base. */
  readonly ours: readonly string[];
  /** Commits on the trunk that touched this path since the merge base. */
  readonly theirs: readonly string[];
}

export interface CascadeResult {
  readonly conflicted: boolean;
  readonly pushed: boolean;
  /** Echoes whether `--no-push` was given -- true only when this call asked for it. */
  readonly noPush: boolean;
  readonly log: readonly string[];
  readonly error: string | null;
  /** Populated only when `conflicted` is true; `[]` on every other outcome. */
  readonly conflicts: readonly CascadeConflict[];
}

export interface CascadeOptions {
  /** Fetch and merge exactly as always, then stop -- never push. */
  readonly noPush?: boolean;
}

/**
 * `git ls-files -u`'s stage table, keyed by path: which of stage 1 (the
 * merge base), 2 (ours) and 3 (theirs) carry an entry for it. A path with no
 * entry for a stage was removed on that side (or, for stage 1, did not exist
 * before either side touched it).
 */
function parseUnmergedStages(lsFilesOutput: string): Map<string, Set<number>> {
  // mode SP blob-sha SP stage TAB path -- ls-files -u's one line format,
  // repeated once per (path, stage) pair a conflict left behind.
  const LINE = /^\S+\s+\S+\s+([1-3])\t(.+)$/;
  const byPath = new Map<string, Set<number>>();
  for (const line of outputLines(lsFilesOutput)) {
    const match = LINE.exec(line);
    if (match === null) continue; // defensive: every real ls-files -u line matches this shape
    const stage = Number(match[1] ?? "");
    const path = match[2] ?? "";
    const stages = byPath.get(path) ?? new Set<number>();
    stages.add(stage);
    byPath.set(path, stages);
  }
  return byPath;
}

function classifyConflictKind(stages: ReadonlySet<number>): CascadeConflict["kind"] {
  const hasBase = stages.has(1);
  const hasOurs = stages.has(2);
  const hasTheirs = stages.has(3);
  if (hasOurs && hasTheirs) return hasBase ? "both-modified" : "add-add";
  if (hasOurs) return "modify-delete";
  if (hasTheirs) return "delete-modify";
  // NEITHER stage 2 nor stage 3 has an entry. For a path git itself lists as
  // unmerged this cannot happen -- a delete/delete leaves no unmerged entry
  // at all, so every real conflict carries stage 2, stage 3, or both -- so
  // reaching here means this module's own read of `ls-files -u` came back
  // empty for the path (an unparsed line, e.g.), not that git found nothing.
  // `both-modified` is the least presumptuous of the four answers: unlike
  // `modify-delete`/`delete-modify`, it does not accuse either side of
  // deleting anything nen has no actual evidence for.
  return "both-modified";
}

/**
 * The commits on one ref range that touched `path`, the call site's
 * `mergeBase` exclusive through `ref` inclusive. Never throws: a `git log`
 * that fails to resolve (a shallow clone, an unreachable ref) answers with
 * no commits rather than aborting the whole conflict report over one path.
 */
function commitsTouching(seams: Seams, cwd: string, mergeBase: string, ref: string, path: string): readonly string[] {
  const result = seams.run(GIT, ["log", "--format=%H", `${mergeBase}..${ref}`, "--", path], { cwd });
  return result.code === 0 ? outputLines(result.stdout) : [];
}

/**
 * Every unmerged path left by a failed merge, with its conflict kind and the
 * commits each side contributed since the merge base -- read-only git calls
 * over a merge already in progress, never a resolution.
 */
function collectConflicts(seams: Seams, cwd: string, trunk: string): readonly CascadeConflict[] {
  const pathsResult = seams.run(GIT, ["diff", "--name-only", "--diff-filter=U"], { cwd });
  const paths = outputLines(pathsResult.stdout);
  if (paths.length === 0) return [];

  const stagesResult = seams.run(GIT, ["ls-files", "-u"], { cwd });
  const stagesByPath = parseUnmergedStages(stagesResult.stdout);

  const mergeBaseResult = seams.run(GIT, ["merge-base", "HEAD", `origin/${trunk}`], { cwd });
  const mergeBase = mergeBaseResult.code === 0 ? outputLines(mergeBaseResult.stdout)[0] : undefined;

  return paths.map((path): CascadeConflict => {
    const kind = classifyConflictKind(stagesByPath.get(path) ?? new Set<number>());
    if (mergeBase === undefined) {
      // The merge base itself could not be resolved -- report the path and
      // its kind (both come from the already-in-progress merge's own index,
      // not from the base), but blame no commit on either side.
      return { path, kind, ours: [], theirs: [] };
    }
    return {
      path,
      kind,
      ours: commitsTouching(seams, cwd, mergeBase, "HEAD", path),
      theirs: commitsTouching(seams, cwd, mergeBase, `origin/${trunk}`, path),
    };
  });
}

export function cascadeMain(seams: Seams, cwd: string, trunk = "main", options: CascadeOptions = {}): CascadeResult {
  const log: string[] = [];
  const noPush = options.noPush ?? false;

  const fetch = seams.run(GIT, ["fetch", "origin", trunk], { cwd });
  if (fetch.code !== 0) {
    return {
      conflicted: false,
      pushed: false,
      noPush,
      log,
      error: `could not fetch origin/${trunk}: ${outputLines(fetch.stderr).join(" ") || `exit ${fetch.code}`}`,
      conflicts: [],
    };
  }
  log.push(`fetched origin/${trunk}`);

  const merge = seams.run(GIT, ["merge", "--no-edit", `origin/${trunk}`], { cwd });
  if (merge.code !== 0) {
    log.push(`merge left conflicts -- resolve them, then commit and push yourself; this cascade never picks a side`);
    return { conflicted: true, pushed: false, noPush, log, error: null, conflicts: collectConflicts(seams, cwd, trunk) };
  }
  log.push(`merged origin/${trunk} cleanly`);

  if (noPush) {
    log.push("not pushed (--no-push)");
    return { conflicted: false, pushed: false, noPush, log, error: null, conflicts: [] };
  }

  const push = seams.run(GIT, ["push"], { cwd });
  if (push.code !== 0) {
    return {
      conflicted: false,
      pushed: false,
      noPush,
      log,
      error: `merged cleanly but could not push: ${outputLines(push.stderr).join(" ") || `exit ${push.code}`}`,
      conflicts: [],
    };
  }
  log.push("pushed");
  return { conflicted: false, pushed: true, noPush, log, error: null, conflicts: [] };
}
