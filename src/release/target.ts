// src/release/target.ts -- getsuga §1's target resolution: resolve the
// invocation token, then test reachability -- "the load-bearing check".
//
// A TAG IS A PROMISE THE CODE IS ON THE TRUNK. `git merge-base --is-ancestor
// <resolved> origin/<trunk>` is the one command that promise reduces to, and
// this module runs it and reports the verdict; it never decides what to do
// about a non-ancestor (getsuga §6: build it, then tag it -- a judgment/
// workflow step, not this module's).
//
// A DIRTY CHECKOUT IS NEVER THE CUT POINT. Uncommitted work is not in any
// commit, so there is nothing to tag -- this is reported as its own refusal
// rather than resolving to HEAD and letting reachability catch it later,
// because HEAD is always reachable from itself and would otherwise pass.

import { GIT, outputLines, type Seams } from "../seam/exec.js";

export type ReleaseTargetToken = "main" | "last-commit" | "checkout" | string;

export interface ResolvedTarget {
  readonly token: ReleaseTargetToken;
  readonly sha: string;
  readonly isAncestorOfTrunk: boolean;
}

export class ResolveTargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ResolveTargetError";
  }
}

function run(
  seams: Seams,
  args: readonly string[],
  cwd: string,
): { code: number; stdout: string; stderr: string; spawnFailed: boolean } {
  const result = seams.run(GIT, [...args], { cwd });
  return { code: result.code, stdout: result.stdout, stderr: result.stderr, spawnFailed: result.spawnFailed };
}

export function resolveReleaseTarget(
  seams: Seams,
  cwd: string,
  token: ReleaseTargetToken,
  trunk = "main",
): ResolvedTarget {
  // Re-fetch, always -- "main" and "last-commit" both name origin/<trunk>'s
  // TIP, and a stale local ref would resolve to a commit that is no longer it.
  const fetch = run(seams, ["fetch", "origin", trunk], cwd);
  if (fetch.code !== 0) {
    throw new ResolveTargetError(`could not fetch origin/${trunk}: ${outputLines(fetch.stderr).join(" ") || `exit ${fetch.code}`}`);
  }

  if (token === "checkout") {
    const status = run(seams, ["status", "--porcelain=v1", "-uall"], cwd);
    if (status.code === 0 && status.stdout.trim() !== "") {
      throw new ResolveTargetError(
        "'checkout' resolves to a DIRTY working copy. Uncommitted work is not in any commit, so there is nothing to tag -- commit and PR it first (nen tensho's own job), then resume once it lands.",
      );
    }
  }

  const ref = token === "main" || token === "last-commit" ? `origin/${trunk}` : token === "checkout" ? "HEAD" : token;
  const revParse = run(seams, ["rev-parse", ref], cwd);
  if (revParse.code !== 0) {
    throw new ResolveTargetError(
      `'${token}' does not resolve to a commit (git rev-parse '${ref}' failed): ${outputLines(revParse.stderr).join(" ") || `exit ${revParse.code}`}`,
    );
  }
  const sha = revParse.stdout.trim();

  const ancestor = run(seams, ["merge-base", "--is-ancestor", sha, `origin/${trunk}`], cwd);
  // `merge-base --is-ancestor` reports its verdict AS the exit code (0 =
  // ancestor, 1 = not), never on stderr -- so a code above 1, OR a git that
  // never started at all (spawnFailed -- reported as code -1, which is NOT
  // above 1), is a git failure (an unknown ref, a shallow clone missing
  // history, no `git` on PATH) and must not be read as "not an ancestor",
  // which would send a reachable release target through getsuga §6's off-main
  // build path for no reason.
  if (ancestor.spawnFailed || ancestor.code > 1) {
    throw new ResolveTargetError(
      `could not test reachability of '${sha}' against origin/${trunk}: ${outputLines(ancestor.stderr).join(" ") || `exit ${ancestor.code}`}`,
    );
  }

  return { token, sha, isAncestorOfTrunk: ancestor.code === 0 };
}
