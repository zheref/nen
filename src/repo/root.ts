// src/repo/root.ts -- the ONE way this binary decides which repository it is
// talking about.
//
// WHY IT EXISTS. bankai-core's cli/ derives a repo root FIVE independent times,
// each by walking up from `import.meta.url`:
//
//   cli/src/dualrun/runner.ts:31        REPO_ROOT
//   cli/src/ports/filesystem.ts:87      PORTS_REPO_ROOT
//   cli/src/ports/hostfs.ts:57          REPO_ROOT
//   cli/src/ports/repo_health_guard.ts:554  REPO_ROOT
//   cli/src/ports/repo_paths.ts:39      PORT_REPO_ROOT
//
// That idiom is not merely duplicated, it is UNAVAILABLE here. `bun build
// --compile` embeds the sources in a virtual filesystem, so a compiled binary's
// `import.meta.url` resolves to `/$bunfs/root/...` -- a path that exists on no
// disk, is not inside any checkout, and whose parent directories are not the
// repository (Akatsuki migration §3). Five constants computed that way would all
// be wrong in the same invisible way the first time the binary ships, and each
// would be wrong in its own file.
//
// THE REPLACEMENT, in one sentence: the base is `process.cwd()` AT THE CALL
// SITE, and an explicit `--repo <path>` overrides it. Both are properties of the
// INVOCATION, which is the only thing a relocatable binary can honestly know
// about where it is being pointed.
//
// `--repo` IS A FILESYSTEM PATH, never `owner/name`. The two meanings collide in
// every GitHub tool and the collision is silent -- `--repo zheref/nen` is a
// perfectly plausible relative directory -- so this module REFUSES an argument
// that looks like an `owner/name` slug and says which flag the caller wanted
// instead (`nen bootstrap --source`, and bootstrap/nen.sh's own `--source`).
// Refusing beats guessing: a path that resolves to a directory that happens to
// exist would silently read another repository's taxonomy.
//
// NO UPWARD WALK, DELIBERATELY. An earlier shape of this function climbed
// parents looking for `.git/`, which is convenient from a subdirectory and is
// exactly how a run inside a nested checkout (or a worktree, or `node_modules`
// of a vendored copy) silently retargets to the wrong repository. The base is
// the base; `--repo` is how a caller says otherwise, and `assertRepoRoot()` is
// how a caller that NEEDS a repository (rather than merely a directory) says so
// out loud.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

export interface RepoRootOptions {
  /** The explicit `--repo <path>` override, when the invocation carried one. */
  readonly repoFlag?: string | null | undefined;
  /** Defaults to `process.cwd()`, read AT THE CALL SITE -- never cached. */
  readonly cwd?: string;
}

export class RepoRootError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoRootError";
  }
}

// `owner/name`: one slash, both halves non-empty, no path-ish characters. It is
// deliberately NARROW -- `./a/b`, `a/b/c`, `/a/b` and `a\b` are all paths and
// must stay paths -- because the cost of a false positive here is refusing a
// legitimate relative directory, and the cost of a false negative is reading the
// wrong repository without saying so.
const OWNER_SLUG = /^[A-Za-z0-9][A-Za-z0-9._-]*\/[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function looksLikeOwnerSlug(value: string): boolean {
  return OWNER_SLUG.test(value);
}

// The target repository root for THIS invocation.
//
// Returns an absolute, normalized path. It does NOT require the directory to
// exist: a caller that only needs to compute a path (a usage message, a dry run)
// must not be forced through a filesystem check, and the callers that need one
// use assertRepoRoot().
export function resolveRepoRoot(options: RepoRootOptions = {}): string {
  const cwd = options.cwd ?? process.cwd();
  const flag = options.repoFlag;

  if (flag === null || flag === undefined) return resolve(cwd);

  if (flag.trim() === "") {
    throw new RepoRootError(
      // The example is deliberately anonymous. Naming a real repository here
      // would put a system's name into a shipped string, which is §3's
      // prohibition arriving through the one door a value-level sweep would
      // otherwise wave through: an error message.
      "--repo was given an empty value. It takes the PATH of the target repository's working tree (e.g. --repo ../my-checkout); omit it entirely to use the current directory.",
    );
  }

  if (looksLikeOwnerSlug(flag)) {
    throw new RepoRootError(
      `--repo takes a filesystem PATH, not an owner/name slug, and '${flag}' reads as a slug. Nen reads a repository's taxonomy from a checkout on disk, so point it at one (--repo ../${flag.split("/")[1] ?? "checkout"}). To name a GitHub repository to fetch release assets from, use 'nen bootstrap --source ${flag}'.`,
    );
  }

  // `resolve` already handles both, but the branch is spelled out so the
  // relative case is visibly anchored to the CALL SITE's cwd rather than to
  // anything ambient.
  return isAbsolute(flag) ? resolve(flag) : resolve(cwd, flag);
}

// The same resolution, plus the two checks a caller that is about to READ the
// repository needs: the path exists, and it is a directory.
//
// It deliberately does NOT require `.git/`. Nen reads a repo's schema files, and
// a schema directory extracted from a tarball, mounted in a container, or laid
// out by a test fixture is a legitimate target; requiring a `.git` would refuse
// those for no benefit, and the loud error a caller actually needs is "there is
// no schemas/ here", which the schema loaders raise by name.
export function assertRepoRoot(options: RepoRootOptions = {}): string {
  const root = resolveRepoRoot(options);
  const source =
    options.repoFlag === null || options.repoFlag === undefined
      ? "the current directory"
      : `--repo ${options.repoFlag}`;

  if (!existsSync(root)) {
    throw new RepoRootError(
      `${source} resolves to '${root}', which does not exist. Nen reads the TARGET repository's files from disk; point --repo at a checkout.`,
    );
  }
  if (!statSync(root).isDirectory()) {
    throw new RepoRootError(
      `${source} resolves to '${root}', which is a file, not a directory. --repo takes the root of a repository's working tree.`,
    );
  }
  return root;
}
