// src/parse/futon.ts -- the futon invocation grammar: `<repo>@<severity>[+]
// [then <terminal>]`, ported from the futon skill's §1.
//
// RESOLVE OR REFUSE, NEVER GUESS -- the skill states this as the one rule every
// parsing decision below is an instance of. An unparseable invocation is
// refused WITH the corrected line ready to paste, never run as "the closest
// valid reading, to see": a futon run applies labels and opens PRs, so a guess
// here is a guess with side effects.
//
// `+` MEANS "THIS BAND OR HIGHER", and nothing else -- `high+` is high union
// critical. A bare severity is that band ALONE; `medium` never quietly sweeps
// up the highs. The severity order below is a structural ranking (critical is
// more severe than high), not a vocabulary choice, so it is the one piece of
// domain knowledge this module is allowed to know without it being a §3
// violation -- the LABEL each severity is spelled as in any given repository
// still comes from that repository's own taxonomy (../schema/labels.ts).
//
// THE TERMINAL IS SELF-REPO ONLY, GENERALIZED. The skill's own rule is
// "valid on bankai-core only, refused anywhere else" -- because the terminal
// (`tag`, `tag+fanout`) is that repository's own release machinery, and a
// consumer's release is a different job entirely. This binary serves more than
// one repository (§3), so the rule is expressed structurally: a terminal is
// refused unless the band's resolved repository IS the one whose registry was
// read (the caller's own checkout, or an explicit --self match) -- never a
// literal "bankai-core" string.

export type Severity = "critical" | "high" | "medium" | "low";

/** Most severe first. This ranking is structural, not a vocabulary choice -- see the header. */
export const SEVERITY_ORDER: readonly Severity[] = ["critical", "high", "medium", "low"];

export type Terminal = "tag" | "tag+fanout";

export interface FutonBand {
  readonly severity: Severity;
  readonly plus: boolean;
  /** The expanded set this band covers, most severe first. */
  readonly severities: readonly Severity[];
}

export interface FutonInvocation {
  /** `null` means "the repo you are standing in" -- no token was given. */
  readonly repoToken: string | null;
  readonly band: FutonBand;
  readonly terminal: Terminal | null;
}

export interface FutonParseError {
  readonly message: string;
  /** The corrected line, ready to paste, when one can be offered. */
  readonly correctedLine: string | null;
}

export type FutonParseResult =
  | { readonly ok: true; readonly value: FutonInvocation }
  | { readonly ok: false; readonly error: FutonParseError };

function expandBand(severity: Severity, plus: boolean): readonly Severity[] {
  if (!plus) return [severity];
  const index = SEVERITY_ORDER.indexOf(severity);
  return SEVERITY_ORDER.slice(0, index + 1);
}

// The terminal is read from the LAST whole-word `then`, so an issue title (or
// a repo token) containing the word cannot be mistaken for the clause.
const THEN_SPLIT = /\bthen\b/gi;

export function parseFutonInvocation(raw: string): FutonParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: { message: "empty invocation. Expected '<repo>@<severity>[+] [then <terminal>]'.", correctedLine: null },
    };
  }

  const thenMatches = [...trimmed.matchAll(THEN_SPLIT)];
  const lastThen = thenMatches.at(-1);
  const head = lastThen === undefined ? trimmed : trimmed.slice(0, lastThen.index).trim();
  const tail = lastThen === undefined ? null : trimmed.slice(lastThen.index + lastThen[0].length).trim();

  let terminal: Terminal | null = null;
  if (tail !== null) {
    const lowered = tail.toLowerCase();
    if (lowered === "tag") terminal = "tag";
    else if (lowered === "tag+fanout") terminal = "tag+fanout";
    else {
      return {
        ok: false,
        error: {
          message: `'then ${tail}' is not a recognized terminal. Only 'then tag' and 'then tag+fanout' are accepted.`,
          correctedLine: `${head} then tag`,
        },
      };
    }
  }

  const at = head.indexOf("@");
  if (at === -1) {
    return {
      ok: false,
      error: {
        message: `'${head}' has no '@<severity>'. Expected '<repo>@<severity>[+]', or bare '@<severity>' to mean the repo you are standing in.`,
        correctedLine: null,
      },
    };
  }
  const repoPart = head.slice(0, at).trim();
  const severityPart = head.slice(at + 1).trim();
  const plus = severityPart.endsWith("+");
  const severityRaw = (plus ? severityPart.slice(0, -1) : severityPart).toLowerCase();
  const severity = SEVERITY_ORDER.find((candidate): boolean => candidate === severityRaw);
  if (severity === undefined) {
    return {
      ok: false,
      error: {
        message: `'${severityPart || "(none)"}' is not a severity. Expected one of ${SEVERITY_ORDER.join(", ")}, optionally suffixed '+'.`,
        correctedLine: `${repoPart === "" ? "" : `${repoPart}@`}${SEVERITY_ORDER[0]}${plus ? "+" : ""}${terminal === null ? "" : ` then ${terminal}`}`,
      },
    };
  }

  return {
    ok: true,
    value: {
      repoToken: repoPart === "" ? null : repoPart,
      band: { severity, plus, severities: expandBand(severity, plus) },
      terminal,
    },
  };
}

export interface FutonResolvedRepo {
  readonly slug: string;
  readonly code: string | null;
  /** The band's repo IS the registry's own repo -- a terminal is permitted here. */
  readonly isSelf: boolean;
}

export interface RepoResolver {
  /** `code -> full name`, exactly as the registry's `product_codes` states it -- `owner/name` in some registries, a bare name in others. */
  readonly productCodes: Readonly<Record<string, string>>;
  /**
   * `owner/name` slugs the registry lists under `maintained_tools` and
   * `pending_onboarding` -- the repositories it records WITHOUT listing them
   * as consumers. They are consulted (zheref/nen#27) because a code like the
   * registry's not-yet-onboarded consumer resolves to a bare name whose owner
   * is recorded exactly here and nowhere else.
   */
  readonly maintainedTools: readonly string[];
  readonly pendingOnboarding: readonly string[];
  byCode(code: string): { readonly repo: string; readonly code: string | null } | undefined;
  byRepo(repo: string): { readonly repo: string; readonly code: string | null } | undefined;
}

export class FutonResolveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FutonResolveError";
  }
}

function repoTail(slug: string): string {
  const at = slug.lastIndexOf("/");
  return (at === -1 ? slug : slug.slice(at + 1)).toLowerCase();
}

// `maintained_tools` then `pending_onboarding`, in file order.
function listedRepos(registry: RepoResolver): readonly string[] {
  return [...registry.maintainedTools, ...registry.pendingOnboarding];
}

// The listed repo whose TAIL a bare `product_codes` value names, if any. The
// lists record full slugs and the value records only a name, so the tail is
// the one comparison both sides actually state.
function listedRepoByTail(registry: RepoResolver, bareName: string): string | undefined {
  return listedRepos(registry).find((slug): boolean => repoTail(slug) === bareName.toLowerCase());
}

// The product code whose value names `slug`, when the registry assigns one --
// compared as recorded for a slug value, by tail for a bare one.
function codeRecordedFor(registry: RepoResolver, slug: string): string | null {
  const tail = repoTail(slug);
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (name.toLowerCase() === slug.toLowerCase()) return code;
    if (!name.includes("/") && name.toLowerCase() === tail) return code;
  }
  return null;
}

// Resolves the invocation's repo token against the registry, or the current
// checkout's slug when the token was omitted. NEVER a prefix match: resolving
// 'Kro' to 'KroApple' because it is the only candidate points a MUTATING run at
// the wrong repository's backlog, which is exactly the failure this refuses.
export function resolveFutonRepo(
  registry: RepoResolver,
  repoToken: string | null,
  currentRepoSlug: string,
): FutonResolvedRepo {
  if (repoToken === null) {
    const entry = registry.byRepo(currentRepoSlug);
    return { slug: currentRepoSlug, code: entry?.code ?? null, isSelf: true };
  }

  const upper = repoToken.toUpperCase();
  const byCode = registry.byCode(upper);
  if (byCode !== undefined) {
    return { slug: byCode.repo, code: byCode.code, isSelf: byCode.repo.toLowerCase() === currentRepoSlug.toLowerCase() };
  }

  // A code the file's `product_codes` names but which no CONSUMER entry
  // claims: the registry's OWN repository (the code the whole file exists to
  // describe), or a repo it lists only under `maintained_tools`/
  // `pending_onboarding` (zheref/nen#27). What the VALUE records decides how
  // far resolution honestly reaches:
  //
  //   * an `owner/name` value is a complete answer -- some registries record
  //     their codes as full slugs, and this code path once assumed they never
  //     did, which refused the registry's own code FROM ITS OWN CHECKOUT;
  //   * a bare value states no owner, so the only honest comparisons are by
  //     TAIL: against the checkout `nen` is standing in, then against the
  //     slugs the maintained_tools/pending_onboarding lists record -- reading
  //     the owner out of the same file is not a guess;
  //   * a bare value matching neither stays an ERROR. The widening is in WHERE
  //     a code resolves from, never in what counts as a match.
  const recorded = registry.productCodes[upper];
  if (recorded !== undefined) {
    if (recorded.includes("/")) {
      return { slug: recorded, code: upper, isSelf: recorded.toLowerCase() === currentRepoSlug.toLowerCase() };
    }
    if (repoTail(currentRepoSlug) === recorded.toLowerCase()) {
      return { slug: currentRepoSlug, code: upper, isSelf: true };
    }
    const listed = listedRepoByTail(registry, recorded);
    if (listed !== undefined) {
      return { slug: listed, code: upper, isSelf: listed.toLowerCase() === currentRepoSlug.toLowerCase() };
    }
    throw new FutonResolveError(
      `'${repoToken}' resolves to '${recorded}' in this registry's own product_codes, but no owner is recorded for it (it names no consumer, maintained_tools or pending_onboarding entry) and the checkout you are standing in ('${currentRepoSlug}') is not it. Run this from '${recorded}''s own checkout, or name a repository this registry actually records.`,
    );
  }

  const byRepo = registry.byRepo(repoToken);
  if (byRepo !== undefined) {
    return { slug: byRepo.repo, code: byRepo.code, isSelf: byRepo.repo.toLowerCase() === currentRepoSlug.toLowerCase() };
  }

  // An `owner/name` token the registry lists under `maintained_tools` or
  // `pending_onboarding` -- recorded in the file, just not as a consumer, so
  // `byRepo` alone would refuse it (zheref/nen#27). Exact slug match only:
  // these lists carry full slugs, and a token disagreeing on the owner is a
  // different repository, not a near miss.
  const listedBySlug = listedRepos(registry).find(
    (slug): boolean => slug.toLowerCase() === repoToken.toLowerCase(),
  );
  if (listedBySlug !== undefined) {
    return {
      slug: listedBySlug,
      code: codeRecordedFor(registry, listedBySlug),
      isSelf: listedBySlug.toLowerCase() === currentRepoSlug.toLowerCase(),
    };
  }

  if (repoToken.toLowerCase() === currentRepoSlug.toLowerCase() || repoTail(repoToken) === repoTail(currentRepoSlug)) {
    return { slug: currentRepoSlug, code: registry.byRepo(currentRepoSlug)?.code ?? null, isSelf: true };
  }

  throw new FutonResolveError(
    `'${repoToken}' does not resolve against this registry's product_codes (${Object.keys(registry.productCodes).join(", ") || "(none)"}), its consumers, or its maintained_tools/pending_onboarding listings. Resolving it to a near match would point a mutating run at the wrong backlog.`,
  );
}
