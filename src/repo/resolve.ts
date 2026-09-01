// src/repo/resolve.ts -- `nen repo resolve`: a repository TOKEN against the
// target repository's `schemas/repos.json`.
//
// PORTED FROM the resolution rule stated, identically, in eight bankai-core
// skills (backlog-state §1, backlog-board §1, futon §1, drive §1, build §1,
// pr-state §1, file §1, senkei). Their own summary of it is three words --
// "resolve or fail, never guess" -- and every clause below is one of the
// failures that phrasing was written after.
//
// THE FOUR RULES, and why each exists:
//
//   1. CASE-INSENSITIVE, on both sides. "bc@g4 is BC@G4" (backlog-state §1).
//      A maintainer types lowercase; a registry stores uppercase codes; a
//      resolution that cared would refuse a correct invocation.
//
//   2. AN UNKNOWN TOKEN IS AN ERROR THAT LISTS THE CODES, never a guess.
//      Verbatim, from drive §1: "Resolving `Kro` to `KroApple` because it is the
//      only prefix match reports the wrong repo's PR, and this skill MUTATES
//      what it is pointed at." So there is NO prefix matching, NO fuzzy
//      matching, and no "did you mean" that resolves on the reader's behalf --
//      the codes are listed and the caller re-types.
//
//   3. THE CWD-ORIGIN FALLBACK IS A RESOLUTION, NOT A DEFAULT. With no token,
//      the subject is the repository the caller is standing in: read `origin`
//      and resolve THAT against the registry, by the same rules. An `origin`
//      that resolves to nothing is an ERROR -- backlog-state §1 is explicit that
//      it "is never a fallback to `all`: sweeping four repos because one could
//      not be identified reports far more than was asked for and hides the
//      failure inside a bigger answer."
//
//   4. `all` IS A TOKEN, AND IT LOSES TO THE REGISTRY. It is checked only after
//      every registry lookup has failed, so a repository the registry actually
//      names `all` still resolves to itself. Keyword-first would make the
//      registry's contents change the meaning of a keyword.
//
// NOTHING HERE KNOWS A CODE OR A REPOSITORY NAME. `BC`, `KP` and the rest are
// keys of the target repository's own file; this module has no opinion about
// which exist, which is the §3 discipline applied to the one place a two-letter
// code feels most like a constant.

import { GIT, outputLines, type Seams } from "../seam/exec.js";
import type { ConsumerEntry, RepoRegistry } from "../schema/repos.js";

/** How a token was matched. Reported, because "it matched" is not the same claim as "it matched as a code". */
export type ResolutionKind = "code" | "slug" | "name" | "origin" | "all";

export interface ResolvedRepo {
  /** `owner/name` where the registry records one, else exactly what it records. */
  readonly repo: string;
  /** The product code, when the registry assigns one to this repository. */
  readonly code: string | null;
  readonly kind: ResolutionKind;
  /** The registry entry, when the repository is a listed consumer. */
  readonly entry: ConsumerEntry | null;
}

export interface Resolution {
  /** Exactly what the caller typed, or null when the cwd's origin was used. */
  readonly token: string | null;
  /** The `origin` URL the cwd fallback read, when it was used. */
  readonly origin: string | null;
  readonly repos: readonly ResolvedRepo[];
}

export class RepoResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoResolutionError";
  }
}

const ALL_TOKEN = "all";

function lower(value: string): string {
  return value.toLowerCase();
}

/** The name half of `owner/name`, or the whole string when there is no slash. */
export function nameHalf(slug: string): string {
  const slash = slug.lastIndexOf("/");
  return slash === -1 ? slug : slug.slice(slash + 1);
}

function known(registry: RepoRegistry): string {
  const codes = Object.entries(registry.productCodes)
    .map(([code, name]): string => `${code} (${name})`)
    .join(", ");
  const consumers = registry.consumers.map((entry): string => entry.repo).join(", ");
  return `Codes: ${codes === "" ? "(none recorded)" : codes}. Repositories: ${consumers === "" ? "(none recorded)" : consumers}.`;
}

function entryFor(registry: RepoRegistry, repo: string): ConsumerEntry | null {
  const wanted = lower(repo);
  return (
    registry.consumers.find((entry): boolean => lower(entry.repo) === wanted) ??
    registry.consumers.find((entry): boolean => lower(nameHalf(entry.repo)) === wanted) ??
    null
  );
}

/**
 * Every repository the registry names, in file order: the consumers, plus any
 * repository a product code names that is not itself a consumer.
 *
 * The second half matters and is easy to miss: a registry records its OWN
 * repository as a product code without listing itself as a consumer of itself,
 * so a sweep built from `consumers` alone silently omits the very repository
 * whose file it just read.
 */
export function allRepos(registry: RepoRegistry): readonly ResolvedRepo[] {
  const out: ResolvedRepo[] = registry.consumers.map((entry): ResolvedRepo => ({
    repo: entry.repo,
    code: entry.code,
    kind: "slug",
    entry,
  }));
  const seen = new Set(out.map((item): string => lower(item.repo)));
  for (const [code, name] of Object.entries(registry.productCodes)) {
    const entry = entryFor(registry, name);
    const repo = entry?.repo ?? name;
    if (seen.has(lower(repo))) continue;
    seen.add(lower(repo));
    out.push({ repo, code, kind: "code", entry });
  }
  return out;
}

/** One token against the registry. Throws rather than guessing. */
export function resolveToken(registry: RepoRegistry, token: string): readonly ResolvedRepo[] {
  const wanted = lower(token);

  // 1. `owner/name`, exactly.
  const bySlug = registry.consumers.find((entry): boolean => lower(entry.repo) === wanted);
  if (bySlug !== undefined) {
    return [{ repo: bySlug.repo, code: bySlug.code, kind: "slug", entry: bySlug }];
  }

  // 2. A product code, exactly. The registry's `product_codes` values are the
  //    authority on what a code names, and they are `owner/name` in some
  //    registries and a bare name in others -- both are carried through as
  //    recorded rather than normalized, because inventing an owner is a guess.
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (lower(code) !== wanted) continue;
    const entry = entryFor(registry, name);
    return [{ repo: entry?.repo ?? name, code, kind: "code", entry }];
  }
  const byEntryCode = registry.consumers.find(
    (entry): boolean => entry.code !== null && lower(entry.code) === wanted,
  );
  if (byEntryCode !== undefined) {
    return [{ repo: byEntryCode.repo, code: byEntryCode.code, kind: "code", entry: byEntryCode }];
  }

  // 3. The short name -- the name half of a slug, exactly. NOT a prefix.
  const byName = registry.consumers.find(
    (entry): boolean => lower(nameHalf(entry.repo)) === wanted,
  );
  if (byName !== undefined) {
    return [{ repo: byName.repo, code: byName.code, kind: "name", entry: byName }];
  }
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (lower(nameHalf(name)) !== wanted) continue;
    const entry = entryFor(registry, name);
    return [{ repo: entry?.repo ?? name, code, kind: "name", entry }];
  }

  // 4. `all`, LAST -- see the header. A registry that names a repository `all`
  //    keeps it.
  if (wanted === ALL_TOKEN) {
    return allRepos(registry).map((item): ResolvedRepo => ({ ...item, kind: "all" }));
  }

  throw new RepoResolutionError(
    `'${token}' does not name a repository in this registry (${registry.path}). It is matched exactly -- as a product code, an owner/name slug, or a repository's short name -- and never as a prefix: resolving a prefix to "the only match" is how a verb reports the wrong repository's backlog. ${known(registry)}`,
  );
}

// `git remote get-url origin` -> `owner/name`.
//
// BOTH URL SPELLINGS, because a checkout is cloned over HTTPS or over SSH
// depending on who cloned it and neither is wrong: `https://host/owner/name.git`
// and `git@host:owner/name.git`. A resolver that understood one would report "not
// a repository" for half of all checkouts.
export function ownerNameFromRemote(url: string): string | null {
  const trimmed = url.trim().replace(/\.git$/, "");
  if (trimmed === "") return null;
  const ssh = /^[^@\s]+@[^:\s]+:(.+)$/.exec(trimmed);
  const path = ssh?.[1] ?? trimmed.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^/]+\//, "");
  const parts = path.split("/").filter((part): boolean => part !== "");
  if (parts.length < 2) return null;
  const name = parts[parts.length - 1];
  const owner = parts[parts.length - 2];
  return owner === undefined || name === undefined ? null : `${owner}/${name}`;
}

export interface ResolveOptions {
  readonly registry: RepoRegistry;
  readonly seams: Seams;
  /** The token the caller typed, or null to resolve from the working directory. */
  readonly token: string | null;
  /** The directory whose `origin` the fallback reads. */
  readonly cwd: string;
}

export function resolve(options: ResolveOptions): Resolution {
  const { registry, token } = options;
  if (token !== null) {
    return { token, origin: null, repos: resolveToken(registry, token) };
  }

  const result = options.seams.run(GIT, ["remote", "get-url", "origin"], { cwd: options.cwd });
  if (result.spawnFailed || result.code !== 0) {
    throw new RepoResolutionError(
      `no repository token was given and '${options.cwd}' has no readable 'origin' remote (${result.spawnFailed ? "git could not be started" : result.stderr.trim()}). With no token the subject is the repository you are standing in; naming one explicitly is the other way. This is never widened to every repository in the registry -- sweeping them all because one could not be identified reports far more than was asked for and hides the failure inside a bigger answer.`,
    );
  }
  const url = outputLines(result.stdout)[0] ?? "";
  const slug = ownerNameFromRemote(url);
  if (slug === null) {
    throw new RepoResolutionError(
      `'${options.cwd}' has an 'origin' of '${url}', which does not read as an owner/name repository. ${known(registry)}`,
    );
  }
  let repos;
  try {
    repos = resolveToken(registry, slug);
  } catch {
    throw new RepoResolutionError(
      `'${options.cwd}' has an 'origin' of '${url}', which resolves to '${slug}' -- and that is not in this registry (${registry.path}). An origin is a token like any other: it is an error, never a fallback to every repository. ${known(registry)}`,
    );
  }
  return { token: null, origin: url, repos: repos.map((item): ResolvedRepo => ({ ...item, kind: "origin" })) };
}
