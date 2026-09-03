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
//   5. A TOKEN RESOLVES FROM EVERYTHING THE FILE RECORDS, not just
//      `consumers[]` (zheref/nen#27). A registry names repositories in more
//      places than its consumer list: its OWN source repository appears only
//      as a `product_codes` value, its tooling repos only under
//      `maintained_tools`, and a not-yet-onboarded consumer only under
//      `pending_onboarding`. A lookup that stopped at the consumer entries
//      refused the registry's own origin FROM ITS OWN CHECKOUT -- five
//      independent skill ports tripped on exactly that. The widening is in
//      WHERE a token resolves from, never in what counts as a match: every
//      comparison below is still exact, and a genuine miss is still an error.
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
  // Consumers AND the maintained_tools/pending_onboarding listings, deduped: a
  // refusal that omitted the listed repos would tell the caller to re-type
  // from an incomplete menu -- the very gap rule 5 closes (zheref/nen#27). A
  // repo can appear in both (a maintained tool that is also a consumer).
  const repos: string[] = [];
  const seen = new Set<string>();
  for (const repo of [...registry.consumers.map((entry): string => entry.repo), ...listedRepos(registry)]) {
    if (seen.has(lower(repo))) continue;
    seen.add(lower(repo));
    repos.push(repo);
  }
  const listed = repos.join(", ");
  return `Codes: ${codes === "" ? "(none recorded)" : codes}. Repositories: ${listed === "" ? "(none recorded)" : listed}.`;
}

function entryFor(registry: RepoRegistry, repo: string): ConsumerEntry | null {
  const wanted = lower(repo);
  return (
    registry.consumers.find((entry): boolean => lower(entry.repo) === wanted) ??
    registry.consumers.find((entry): boolean => lower(nameHalf(entry.repo)) === wanted) ??
    null
  );
}

// `maintained_tools` then `pending_onboarding`, in file order -- the
// repositories the registry records WITHOUT listing them as consumers (its own
// tooling, and consumers that have not onboarded yet). See rule 5.
function listedRepos(registry: RepoRegistry): readonly string[] {
  return [...registry.maintainedTools, ...registry.pendingOnboarding];
}

// The `owner/name` the registry records for a `product_codes` VALUE: the
// consumer entry when one claims it, else a maintained_tools/pending_onboarding
// listing -- matched exactly, or by name half when the value is bare, because a
// bare value cannot disagree about an owner it never states. Null when the file
// records only the bare name; the value is then carried through as recorded,
// since inventing an owner is a guess.
function recordedRepoFor(registry: RepoRegistry, name: string): string | null {
  const entry = entryFor(registry, name);
  if (entry !== null) return entry.repo;
  const wanted = lower(name);
  return (
    listedRepos(registry).find((repo): boolean => lower(repo) === wanted) ??
    (name.includes("/")
      ? undefined
      : listedRepos(registry).find((repo): boolean => lower(nameHalf(repo)) === wanted)) ??
    null
  );
}

// The product code whose value names `slug`, when the registry assigns one.
// The same comparison discipline as recordedRepoFor, from the other side: a
// slug value must match as recorded, a bare value matches the name half.
function codeFor(registry: RepoRegistry, slug: string): string | null {
  const wanted = lower(slug);
  const shortName = lower(nameHalf(slug));
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (lower(name) === wanted) return code;
    if (!name.includes("/") && lower(name) === shortName) return code;
  }
  return null;
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
    // A bare value whose owner IS recorded elsewhere in the file (a
    // maintained_tools/pending_onboarding listing) reports the recorded
    // `owner/name`, not the bare half -- same rule as resolveToken's step 2.
    const repo = recordedRepoFor(registry, name) ?? name;
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
  //    A bare value whose owner the file DOES record elsewhere (a consumer, or
  //    a maintained_tools/pending_onboarding listing) reports that recorded
  //    `owner/name` -- reading the owner out of the same file is not a guess.
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (lower(code) !== wanted) continue;
    const entry = entryFor(registry, name);
    return [{ repo: recordedRepoFor(registry, name) ?? name, code, kind: "code", entry }];
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
    return [{ repo: recordedRepoFor(registry, name) ?? name, code, kind: "name", entry }];
  }

  // 3.5 THE REST OF WHAT THE FILE RECORDS (rule 5, zheref/nen#27). Steps 1-3
  //     read `consumers[]` first and `product_codes` only through its KEYS and
  //     short names, which left three exact spellings unresolvable -- each one
  //     something the registry itself wrote down:

  // 3.5a A `product_codes` VALUE, exactly. Registries that record their codes
  //      as `owner/name` slugs make a value the ONLY full spelling of the
  //      registry's own repository -- and an origin is always slug-shaped, so
  //      this is precisely the lookup the no-token form was missing.
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (lower(name) !== wanted) continue;
    const entry = entryFor(registry, name);
    return [{ repo: entry?.repo ?? name, code, kind: "slug", entry }];
  }

  // 3.5b A repository listed under `maintained_tools` or `pending_onboarding`,
  //      by exact slug then exact short name. These lists exist precisely to
  //      record repositories that are NOT consumers yet; refusing them is
  //      refusing the file's own contents. `entry` stays null -- being listed
  //      is not the same claim as being a consumer.
  const listedBySlug = listedRepos(registry).find((repo): boolean => lower(repo) === wanted);
  if (listedBySlug !== undefined) {
    return [{ repo: listedBySlug, code: codeFor(registry, listedBySlug), kind: "slug", entry: null }];
  }
  const listedByName = listedRepos(registry).find(
    (repo): boolean => lower(nameHalf(repo)) === wanted,
  );
  if (listedByName !== undefined) {
    return [{ repo: listedByName, code: codeFor(registry, listedByName), kind: "name", entry: null }];
  }

  // 3.5c An `owner/name` token whose NAME HALF a bare `product_codes` value
  //      records, when nothing in the file claims that name under ANY owner. A
  //      bare value states no owner, so the token's own owner is the only one
  //      on offer and nothing is guessed -- the same tail comparison
  //      ../parse/futon.ts has always used for the registry's own code. When
  //      the file DOES record an owner for the name (a consumer or a listed
  //      repo -- necessarily a different owner, or an earlier exact step would
  //      have matched), the token contradicts the file and stays an error.
  if (wanted.includes("/")) {
    for (const [code, name] of Object.entries(registry.productCodes)) {
      if (name.includes("/") || lower(name) !== lower(nameHalf(wanted))) continue;
      if (recordedRepoFor(registry, name) !== null) continue;
      return [{ repo: token, code, kind: "name", entry: null }];
    }
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
