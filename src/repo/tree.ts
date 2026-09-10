// src/repo/tree.ts -- one number for "what does this working copy contain right
// now", computed by git and never by nen.
//
// WHY THIS EXISTS AT ALL. `nen shu build` records a build proof and `nen commit
// check` reads it back, and the whole value of the pair is one question: is the
// tree in front of me the tree that was proved green? Anything nen invented
// itself to answer that -- a file list, a mtime sweep, a hash of its own -- is a
// second definition of "the same tree" for somebody to disagree with. Git
// already has one, it is the tree object, and both sides of the comparison
// compute it the same way here so they cannot come apart.
//
// IT IS THE WORKING COPY, NOT THE INDEX, and that is the decision the rest of
// this file is about. A bare `git write-tree` hashes what is STAGED, which is
// exactly wrong for this pair: the build ran against the files on disk with
// nothing staged, and the check runs a moment before a commit with everything
// staged, so the two would disagree every single time and the proof would be
// useless in the one workflow it was written for. So the tree is built the only
// way git offers that touches nothing the developer can see:
//
//   1. a TEMPORARY INDEX, never the repository's own. `GIT_INDEX_FILE` points
//      git at a scratch file; the real `.git/index` is not read, not written,
//      and not refreshed, so nothing about what the developer has staged
//      changes -- and a `nen commit check` run mid-review cannot disturb the
//      commit that is about to be made.
//   2. `git add -A` into it, which hashes every non-ignored file in the tree.
//   3. `git rm --cached` for `.nen/`, dropping nen's own artifacts back out.
//   4. `git write-tree`, which turns that index into one sha.
//
// `.nen/` IS DROPPED, AND IT HAS TO BE. The proof itself lands at
// `.nen/proof/<lane>.json` AFTER the hash is taken, so a tree that counted it
// would hash differently the instant the proof was written -- the check would
// fail immediately, every time, against the very tree it had just proved. The
// scratch index lives under the same directory for the same reason: it is
// dropped by the same step, so it cannot alter the number it is being used to
// compute, whether or not the repository ignores `.nen/`.
//
// IT IS A SEPARATE `rm --cached` RATHER THAN AN `:(exclude)` PATHSPEC, and that
// is a bug fixed rather than a style: `git add -A -- . ':(exclude).nen'` in a
// repository that ALREADY ignores `.nen/` -- which is every repository `nen
// scaffold init` has touched -- exits 1 with "the following paths are ignored
// by one of your .gitignore files", because naming a path in a pathspec at all
// makes it explicit enough for that warning. Every proof write in the field
// would have failed on it. Removing the entries afterwards asks git nothing
// about ignore rules and behaves identically whether `.nen/` is ignored,
// tracked, or absent (`--ignore-unmatch`).
//
// WHAT IT WRITES, HONESTLY STATED: loose git objects for the file contents (git
// does this for `git status` too, and an unreferenced object is collected by the
// next `gc`) and one scratch index it removes. No ref moves, no branch changes,
// nothing the repository tracks is touched, and the developer's own index is
// not read. That is what lets ../parse/izanami.ts classify `commit check`
// read-only with a straight face.

import { mkdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { GIT, must, type Seams } from "../seam/exec.js";

/**
 * The directory nen keeps its own artifacts in, repo-relative.
 *
 * ONE DEFINITION, because three things live under it -- the build proof, the
 * stop marker, and the scratch index below -- and a second spelling of the
 * directory is a second directory the day one of them is renamed.
 */
export const NEN_DIR = ".nen";

/**
 * Drop nen's own artifacts back out of the scratch index.
 *
 * `--cached` touches the index and never the working tree, `-f` skips the
 * safety check that compares against HEAD (there is nothing to protect in a
 * scratch index), and `--ignore-unmatch` makes "there was nothing there" the
 * ordinary answer it is.
 */
const DROP_NEN: readonly string[] = [
  "rm",
  "-r",
  "-f",
  "--cached",
  "--quiet",
  "--ignore-unmatch",
  "--",
  NEN_DIR,
];

/** Where the scratch index goes. Under `.nen/`, which the hash excludes. */
function scratchIndexPath(root: string): string {
  return join(root, NEN_DIR, "write-tree.index");
}

/**
 * The git tree object of this working copy, as one sha.
 *
 * A git that could not be STARTED, or that refused, raises `ToolError` through
 * `must` -- the caller reports it as the failure it is rather than as an empty
 * hash, because "these trees differ" and "nen could not ask" are different
 * answers and only one of them means anything.
 */
export function workingTreeHash(seams: Seams, root: string): string {
  const index = scratchIndexPath(root);
  mkdirSync(dirname(index), { recursive: true });
  const env = { GIT_INDEX_FILE: index };
  try {
    // A FRESH, EMPTY INDEX EVERY TIME. Left over from a previous run it would
    // carry that run's stat cache and, worse, its FILE LIST -- a file deleted
    // since would still be in the tree, and the hash would say the working copy
    // still contains it.
    rmSync(index, { force: true });
    must(seams, GIT, ["add", "-A", "--", "."], { cwd: root, env });
    must(seams, GIT, DROP_NEN, { cwd: root, env });
    return must(seams, GIT, ["write-tree"], { cwd: root, env }).stdout.trim();
  } finally {
    // THE SCRATCH FILE NEVER OUTLIVES THE CALL, on the refusal path as much as
    // on the clean one: a stale index under `.nen/` is a file a reader would
    // have to work out the provenance of, and it is worthless the moment this
    // function returns.
    rmSync(index, { force: true });
  }
}
