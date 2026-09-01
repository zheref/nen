// src/github/target.ts -- `--target owner/name`, the GitHub-side counterpart to
// `--repo <path>`.
//
// THE TWO FLAGS ARE DELIBERATELY DIFFERENT WORDS. `--repo` is a filesystem PATH
// -- ../repo/root.ts refuses an `owner/name` slug handed to it, because a slug
// is also a plausible relative directory and reading the wrong repository's
// taxonomy without saying so is the failure that refusal exists to prevent.
// The verbs that talk to GitHub still need to name a repository, so they take
// `--target`, and this module is the one place the two meanings are told apart.
//
// RESOLVE OR REFUSE, NEVER GUESS. Every skill this ports from says the same
// thing in its own words: an unresolved token is an error, and resolving `Kro`
// to `KroApple` because it is the only prefix match points a MUTATING run at the
// wrong repository's backlog. So there is no prefix matching, no case
// correction, and no inference from the working directory here -- a caller that
// wants the current checkout's remote asks for it explicitly (`fromRemote`),
// and gets a named failure when the remote resolves to nothing.

import { looksLikeOwnerSlug } from "../repo/root.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";

export interface Target {
  readonly owner: string;
  readonly repo: string;
  /** `owner/name`, the form every `gh --repo` flag takes. */
  readonly slug: string;
}

export class TargetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TargetError";
  }
}

export function parseTarget(value: string): Target {
  if (!looksLikeOwnerSlug(value)) {
    throw new TargetError(
      `--target takes an owner/name repository slug and '${value}' is not one. It is the GitHub side of the pair: --repo names a checkout on disk, --target names the repository on GitHub.`,
    );
  }
  const [owner, repo] = value.split("/");
  if (owner === undefined || repo === undefined) {
    throw new TargetError(`--target '${value}' does not split into owner and name.`);
  }
  return { owner, repo, slug: `${owner}/${repo}` };
}

// The `origin` remote of a checkout, as a target.
//
// It is a SEPARATE, explicitly-requested step rather than a default, because a
// verb that silently fell back to the working directory's remote would target
// whichever repository the shell happened to be standing in -- which is exactly
// how a mutating run lands on the wrong backlog.
export function targetFromRemote(
  seams: Seams,
  cwd: string,
  remote = "origin",
): Target {
  const result = seams.run(GIT, ["remote", "get-url", remote], { cwd });
  const url = outputLines(result.stdout)[0];
  if (result.code !== 0 || url === undefined) {
    throw new TargetError(
      `no '${remote}' remote in '${cwd}', so there is nothing to resolve a repository from. Name it with --target owner/name.`,
    );
  }
  const parsed = parseRemoteUrl(url);
  if (parsed === null) {
    throw new TargetError(
      `the '${remote}' remote is '${url}', which does not read as a GitHub repository. Name it with --target owner/name.`,
    );
  }
  return parsed;
}

// Both spellings git writes, and nothing else. `git@host:owner/name.git` and
// `https://host/owner/name(.git)`; the host is not checked, because an
// enterprise install is a legitimate host and refusing it would be this
// module's own guess about where a repository may live.
export function parseRemoteUrl(url: string): Target | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  const ssh = /^[^@]+@[^:]+:([^/]+)\/(.+)$/.exec(trimmed);
  if (ssh !== null && ssh[1] !== undefined && ssh[2] !== undefined) {
    return { owner: ssh[1], repo: ssh[2], slug: `${ssh[1]}/${ssh[2]}` };
  }
  const https = /^[a-z]+:\/\/[^/]+\/([^/]+)\/([^/]+)$/.exec(trimmed);
  if (https !== null && https[1] !== undefined && https[2] !== undefined) {
    return { owner: https[1], repo: https[2], slug: `${https[1]}/${https[2]}` };
  }
  return null;
}
