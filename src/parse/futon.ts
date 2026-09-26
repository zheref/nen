// src/parse/futon.ts -- the futon invocation grammar: `<repo>@<selector>[+]
// [then <terminal>]`, ported from the futon skill's §1. The selector is a
// severity (a band, `+` allowed) or any other label, matched exactly and
// never expanded -- a backlog carrying no severity taxonomy is still
// scoped by the maintainer's own word (zheref/hatsu futon, 2026-09-26).
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

/**
 * What follows `then`. `tag`/`tag+fanout` are the built-in terminals (and
 * keep the self-repo rule); one or more kebab skill tokens joined by `+`,
 * each optionally `plugin:`-prefixed and optionally `@<target>`-suffixed
 * (`getsuga+kagutsuchi@testflight+mugetsu@github`), are a skill chain run in
 * order; anything else is prose, kept verbatim.
 * Whether a named skill exists, and whether the step is allowed at all, is the
 * calling skill's to decide -- nen names the shape, never the authority.
 */
export type FutonThen =
  | { readonly kind: "terminal"; readonly terminal: Terminal }
  | { readonly kind: "skills"; readonly steps: readonly FutonStep[] }
  | { readonly kind: "prose"; readonly text: string };

export interface FutonStep {
  readonly skill: string;
  /** The destination the step names after `@`, verbatim; `null` when none. */
  readonly target: string | null;
}

const SKILL_STEP = /^((?:[a-z0-9][a-z0-9-]*:)?[a-z0-9][a-z0-9-]*)(?:@([A-Za-z0-9][A-Za-z0-9._\/-]*))?$/i;

function parseSkillChain(text: string): readonly FutonStep[] | null {
  const steps: FutonStep[] = [];
  for (const part of text.split("+")) {
    const match = SKILL_STEP.exec(part.trim());
    if (match === null) return null;
    steps.push({ skill: (match[1] ?? "").toLowerCase(), target: match[2] ?? null });
  }
  return steps;
}

export interface FutonBand {
  readonly severity: Severity;
  readonly plus: boolean;
  /** The expanded set this band covers, most severe first. */
  readonly severities: readonly Severity[];
}

export interface FutonInvocation {
  /** `null` means "the repo you are standing in" -- no token was given. */
  readonly repoToken: string | null;
  /** Set when the selector is a severity; `null` when it is a label. Exactly one of `band`/`label` is set. */
  readonly band: FutonBand | null;
  /** The literal label the run filters on when the selector is not a severity. */
  readonly label: string | null;
  /** The built-in terminal, when the `then` clause is one; `null` otherwise. */
  readonly terminal: Terminal | null;
  /** The whole `then` clause, classified; `null` when there is none. */
  readonly then: FutonThen | null;
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

// The clause starts at the FIRST `then` after the '@' that has whitespace on
// both sides (or the string's end) -- 'nen@then-review' names a LABEL, not a
// then clause, because nothing after the word is whitespace. Prose after a
// real split may itself say "then" without splitting a second time.
const THEN_SPLIT = /(?<=\s)then(?=\s|$)/gi;

// Where a quoted selector right after '@' ends, so a "then" living INSIDE the
// quotes (`nen@"ready then ship"`) is never mistaken for the clause split --
// it returns `atIndex` itself (a no-op search boundary) when the selector
// is not quoted.
function quotedSelectorEnd(text: string, atIndex: number): number {
  const afterAt = text.slice(atIndex + 1);
  const opened = /^(\s*)(["'])/.exec(afterAt);
  if (opened === null) return atIndex;
  const quote = opened[2] as string;
  const openPos = atIndex + 1 + opened[1]!.length;
  const closePos = text.indexOf(quote, openPos + 1);
  return closePos === -1 ? atIndex : closePos;
}

// The skill name a chain step names, ignoring its '@target' suffix and any
// namespace prefix -- what F3's reserved-name rule and F4's near-miss check
// both actually compare against.
function stepName(part: string): string {
  const withoutTarget = (part.trim().split("@")[0] ?? "");
  return withoutTarget.replace(/^[a-z0-9][a-z0-9-]*:/i, "").toLowerCase();
}

function editDistance(a: string, b: string): number {
  const rows = a.length + 1;
  const cols = b.length + 1;
  const dp: number[][] = Array.from({ length: rows }, (): number[] => new Array(cols).fill(0));
  for (let i = 0; i < rows; i++) dp[i]![0] = i;
  for (let j = 0; j < cols; j++) dp[0]![j] = j;
  for (let i = 1; i < rows; i++) {
    for (let j = 1; j < cols; j++) {
      dp[i]![j] = a[i - 1] === b[j - 1] ? dp[i - 1]![j - 1]! : 1 + Math.min(dp[i - 1]![j]!, dp[i]![j - 1]!, dp[i - 1]![j - 1]!);
    }
  }
  return dp[rows - 1]![cols - 1]!;
}

// A near-miss of one of the two built-in terminals (edit distance <= 2),
// checked against the WHOLE normalized then-clause -- 'tga' misses 'tag' by
// one substitution, 'tag+fanuot' misses 'tag+fanout' by a two-character swap.
function nearMissTerminal(lowered: string): Terminal | null {
  if (lowered !== "tag" && editDistance(lowered, "tag") <= 2) return "tag";
  if (lowered !== "tag+fanout" && editDistance(lowered, "tag+fanout") <= 2) return "tag+fanout";
  return null;
}

export function parseFutonInvocation(raw: string): FutonParseResult {
  const trimmed = raw.trim();
  if (trimmed === "") {
    return {
      ok: false,
      error: { message: "empty invocation. Expected '<repo>@<severity>[+] [then <terminal>]' or '<repo>@<label> [then <terminal>]'.", correctedLine: null },
    };
  }

  const atIndex = trimmed.indexOf("@");
  const thenSearchFrom = atIndex === -1 ? -1 : quotedSelectorEnd(trimmed, atIndex);
  const firstThen = [...trimmed.matchAll(THEN_SPLIT)].find((match): boolean => match.index > thenSearchFrom);
  const head = firstThen === undefined ? trimmed : trimmed.slice(0, firstThen.index).trim();
  const tail = firstThen === undefined ? null : trimmed.slice(firstThen.index + firstThen[0].length).trim();

  let terminal: Terminal | null = null;
  let then: FutonThen | null = null;
  if (tail !== null) {
    if (tail === "") {
      return {
        ok: false,
        error: {
          message: "'then' names nothing. Expected 'then tag', 'then tag+fanout', 'then <skill>' or 'then <what to do, in prose>'.",
          correctedLine: head,
        },
      };
    }
    // F12: normalize spacing around the chain operator BEFORE classifying, so
    // 'getsuga + mugetsu' reads as the chain 'getsuga+mugetsu' rather than
    // falling through to prose merely because someone put spaces around '+'.
    const normalized = tail.replace(/\s*\+\s*/g, "+");
    const lowered = normalized.toLowerCase();
    if (lowered === "tag" || lowered === "tag+fanout") {
      terminal = lowered as Terminal;
      then = { kind: "terminal", terminal };
    } else if (!/\s/.test(normalized)) {
      const parts = normalized.split("+");
      if (parts.some((part): boolean => part.trim() === "")) {
        return {
          ok: false,
          error: {
            message: `'${tail}' is a malformed chain -- an empty step between '+'s. Expected '<skill>[@target][+<skill>[@target]...]'.`,
            correctedLine: null,
          },
        };
      }
      // F4 checked BEFORE F3's reserved-name rule: a two-part typo like
      // 'tag+fanuot' names 'tag' exactly, so the reserved-name rule would
      // otherwise catch it first and report the wrong reason.
      const nearMiss = nearMissTerminal(lowered);
      if (nearMiss !== null) {
        return {
          ok: false,
          error: {
            message: `'${tail}' is not a recognized terminal (closest to 'then ${nearMiss}'). Expected 'then tag', 'then tag+fanout', 'then <skill>' or 'then <what to do, in prose>'.`,
            correctedLine: `${head} then ${nearMiss}`,
          },
        };
      }
      const names = parts.map(stepName);
      const hasTag = names.includes("tag");
      const hasFanout = names.includes("fanout");
      if (parts.length > 1 && (hasTag || hasFanout)) {
        // F3: 'tag'/'fanout' are the terminal's own vocabulary and are
        // reserved as step names -- a chain naming either alongside other
        // steps escapes the terminal's self-repo rule.
        const remaining = parts.filter((_part, index): boolean => names[index] !== "tag" && names[index] !== "fanout");
        const suggestions: string[] = [];
        if (hasTag && hasFanout) suggestions.push(`${head} then tag+fanout`);
        else if (hasTag) suggestions.push(`${head} then tag`);
        if (remaining.length > 0) suggestions.push(`${head} then ${remaining.join("+")}`);
        return {
          ok: false,
          error: {
            message: "'tag' and 'fanout' are reserved step names -- the terminal's own vocabulary -- and cannot appear inside a skill chain. Use 'then tag' or 'then tag+fanout' alone, or the chain without them.",
            correctedLine: suggestions[0] ?? `${head} then tag`,
          },
        };
      }
      const steps = parseSkillChain(normalized);
      then = steps === null ? { kind: "prose", text: tail } : { kind: "skills", steps };
    } else {
      then = { kind: "prose", text: tail };
    }
  }

  const at = head.indexOf("@");
  if (at === -1) {
    return {
      ok: false,
      error: {
        message: `'${head}' has no '@<severity>' or '@<label>'. Expected '<repo>@<severity>[+]' or '<repo>@<label>', or a bare '@...' to mean the repo you are standing in.`,
        correctedLine: null,
      },
    };
  }
  const repoPart = head.slice(0, at).trim();
  const selectorPart = head.slice(at + 1).trim();
  // F6: a trailing '+' is the band operator ONLY when the token in front of
  // it is itself a severity -- otherwise it stays part of the label verbatim
  // ('c++' is the label 'c++', not the label 'c' with a refused '+').
  const plusCandidate = selectorPart.endsWith("+") ? stripQuotes(selectorPart.slice(0, -1).trim()) : null;
  const plus = plusCandidate !== null && (SEVERITY_ORDER as readonly string[]).includes(plusCandidate.toLowerCase());
  const selectorRaw = stripQuotes((plus ? (plusCandidate as string) : selectorPart).trim());
  const suffix = tail === null ? "" : ` then ${tail}`;
  const repoPrefix = repoPart === "" ? "@" : `${repoPart}@`;
  if (selectorRaw === "") {
    return {
      ok: false,
      error: {
        message: `no selector after '@'. Expected a severity (${SEVERITY_ORDER.join(", ")}, optionally suffixed '+') or a label.`,
        correctedLine: `${repoPrefix}${SEVERITY_ORDER[0]}${suffix}`,
      },
    };
  }
  const severity = SEVERITY_ORDER.find((candidate): boolean => candidate === selectorRaw.toLowerCase());
  if (severity === undefined) {
    // Any other token is a label, taken exactly as typed -- including one
    // that ends in a literal '+' that failed F6's severity check above
    // ('c++' is the label 'c++', not a refused severity-band operator).
    return {
      ok: true,
      value: { repoToken: repoPart === "" ? null : repoPart, band: null, label: selectorRaw, terminal, then },
    };
  }

  return {
    ok: true,
    value: {
      repoToken: repoPart === "" ? null : repoPart,
      band: { severity, plus, severities: expandBand(severity, plus) },
      label: null,
      terminal,
      then,
    },
  };
}

function stripQuotes(text: string): string {
  const match = /^(["'])(.*)\1$/.exec(text);
  return match === null ? text : (match[2] ?? "").trim();
}

/** The selector as typed back: `high+`, `medium`, or a label. */
export function formatFutonSelector(invocation: FutonInvocation): string {
  if (invocation.band !== null) return `${invocation.band.severity}${invocation.band.plus ? "+" : ""}`;
  return invocation.label ?? "";
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
//
// TWO PASSES, exact before tail, so file order cannot decide the answer: a
// single pass returned the FIRST entry that matched EITHER way, letting an
// earlier bare value's tail match ({A: "KroCloud"}) shadow a later value that
// records this very slug in full ({B: "zheref/KroCloud"}). A value that
// matches as recorded is the file's own complete spelling of this repository;
// a tail comparison is a derived reading of a value that stated no owner, and
// it may honestly belong to a DIFFERENT owner's repo of the same name -- so
// exactness outranks it regardless of where each entry sits in the file.
function codeRecordedFor(registry: RepoResolver, slug: string): string | null {
  const wanted = slug.toLowerCase();
  for (const [code, name] of Object.entries(registry.productCodes)) {
    if (name.toLowerCase() === wanted) return code;
  }
  const tail = repoTail(slug);
  for (const [code, name] of Object.entries(registry.productCodes)) {
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
