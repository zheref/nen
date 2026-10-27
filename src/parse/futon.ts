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
  /**
   * `--idle` was typed (HR-5): the run is an idle batch under the repository's
   * typed idle profile. nen reports the flag; what an idle run may do is the
   * calling skill's rule and nen/workflow.json's `idle` block.
   */
  readonly idle: boolean;
  /**
   * `--dry-run` was typed (zheref/nen#520): the caller asked for a dry futon
   * run. nen reports the flag; what a dry run does is the calling skill's rule.
   */
  readonly dryRun: boolean;
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

// The flags of the scope, in the order a corrected line writes them back.
const SCOPE_FLAGS = ["--idle", "--dry-run"] as const;
type ScopeFlag = (typeof SCOPE_FLAGS)[number];

// The text with every quoted span's interior blanked to spaces, same length,
// so a scan for flag tokens never reads inside quotes (`nen@"x --idle"`,
// `then "do not --dry-run here"`) and every index still maps to the original.
// An unmatched quote blanks nothing from there on: it is not a quoted span.
function blankQuoted(text: string): string {
  let out = "";
  let index = 0;
  while (index < text.length) {
    const char = text[index] as string;
    const close = char === '"' || char === "'" ? text.indexOf(char, index + 1) : -1;
    if (close === -1) {
      out += char;
      index++;
      continue;
    }
    out += char + " ".repeat(close - index - 1) + char;
    index = close + 1;
  }
  return out;
}

// A dash a terminal, a word processor or a phone keyboard may type in place of
// `--`: the hyphen and dash block (U+2010-2015), minus (U+2212), and the small
// and full-width hyphen-minus forms.
const DASHES = "‐-―−﹘﹣－";
const LEADING_DASHES = new RegExp(`^[-${DASHES}]+`);

// The scope flag a token is an attempt at, offered in a corrected line only
// for a variant that cannot mean anything else: another case, '_' or a
// Unicode dash for '-', a dash dropped or doubled, or ONE
// edit -- a substitution, an insertion, a deletion or two letters swapped
// (`--dryrun`, `--DRY-RUN`, `--dry_run`, `−−dry-run`,
// `--idel`). A '=<value>' suffix, a word that does not keep the flag's
// first three letters, or anything further (`-idea`, `--file`,
// `--title`) is no attempt at a scope flag: `null`, refused as an unknown
// option and dropped, never turned into a flag nobody typed (Nobunaga R2-1 on
// zheref/nen#562).
function scopeFlagAttempt(token: string): ScopeFlag | null {
  if ((SCOPE_FLAGS as readonly string[]).includes(token)) return token as ScopeFlag;
  // A token carrying '=<value>' is never offered a flag: `--idle=false` asks
  // for the OPPOSITE of `--idle`, and a corrected line that turned "not idle"
  // into an unattended batch would be the guess this refusal exists to stop
  // (Feitan F-6 on zheref/nen#562). It is an unknown option, dropped.
  if (token.includes("=")) return null;
  const bare = token.toLowerCase().replace(LEADING_DASHES, "").replace(new RegExp(`[-_\\s${DASHES}]`, "g"), "");
  if (bare === "") return null;
  // The one edit must also keep the flag's first three letters (`idl`, or
  // `ide` where the edit is the swap `--idel`), so a word that merely lands
  // one edit away (`--isle`, `--ile`) is no attempt at it.
  if (bare.startsWith("idl") || bare.startsWith("ide")) {
    if (swapDistance(bare, "idle") <= 1) return "--idle";
  }
  if (bare.startsWith("dry") && swapDistance(bare, "dryrun") <= 1) return "--dry-run";
  return null;
}

// Edit distance counting two adjacent letters swapped as one edit (optimal
// string alignment), so `idel` is one edit from `idle`.
function swapDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i): number[] => Array.from({ length: b.length + 1 }, (_, j): number => (i === 0 ? j : j === 0 ? i : 0)));
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let best = Math.min(d[i - 1]![j]! + 1, d[i]![j - 1]! + 1, d[i - 1]![j - 1]! + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) best = Math.min(best, d[i - 2]![j - 2]! + 1);
      d[i]![j] = best;
    }
  }
  return d[a.length]![b.length]!;
}

// A head token written as a flag: a run of dashes -- ASCII or any Unicode
// dash, mixed or repeated (`--x`, `-x`, `−−dry-run`,
// `－－dry-run`, `——dry-run`, `‐‐idle`) -- in front of a
// letter, or any `--` token (Feitan F-5 on zheref/nen#562). A lone `-` or a
// number (`-1`) is not.
const FLAG_SHAPED = new RegExp(`^[-${DASHES}]+\\p{L}`, "u");
function looksLikeFlag(token: string): boolean {
  return token.startsWith("--") || FLAG_SHAPED.test(token);
}

interface HeadToken {
  readonly text: string;
  readonly start: number;
  readonly end: number;
}

interface ScopeRead {
  /** The head with every flag-shaped token taken out. */
  readonly core: string;
  /** Each scope flag accepted at an end of the head, with how many copies. */
  readonly seen: ReadonlyMap<ScopeFlag, number>;
  /** Flag-shaped tokens refused where they stand, each with the flag it attempts (or null). */
  readonly refused: readonly { readonly token: string; readonly flag: ScopeFlag | null; readonly exact: boolean }[];
}

// Reads the scope flags off the head. An EXACT scope flag at either end is
// accepted, peeling inward until the first and the last token are no flag.
// Every other flag-shaped token outside quotes -- a near miss, an unknown
// `--option`, an exact flag left standing inside the selector -- is REFUSED,
// never read into the label: `nen@high --dryrun` taken as the label
// `high --dryrun` would be a live run asked for as a dry one (Feitan F1 on
// zheref/nen#562). A label that really carries such a word is quoted.
function readScopeFlags(head: string): ScopeRead {
  const blanked = blankQuoted(head);
  const tokens: HeadToken[] = [...blanked.matchAll(/\S+/g)].map((match): HeadToken => ({
    text: head.slice(match.index, match.index + match[0].length),
    start: match.index,
    end: match.index + match[0].length,
  }));
  const seen = new Map<ScopeFlag, number>();
  const taken = new Set<HeadToken>();
  let first = 0;
  let last = tokens.length - 1;
  for (let changed = true; changed && first <= last; ) {
    changed = false;
    for (const index of [first, last]) {
      const token = tokens[index];
      if (token === undefined || taken.has(token) || !(SCOPE_FLAGS as readonly string[]).includes(token.text)) continue;
      const flag = token.text as ScopeFlag;
      seen.set(flag, (seen.get(flag) ?? 0) + 1);
      taken.add(token);
      if (index === first) first++;
      else last--;
      changed = true;
      break;
    }
  }
  const refused: { token: string; flag: ScopeFlag | null; exact: boolean }[] = [];
  for (const token of tokens.slice(first, last + 1)) {
    if (!looksLikeFlag(token.text)) continue;
    taken.add(token);
    refused.push({ token: token.text, flag: scopeFlagAttempt(token.text), exact: (SCOPE_FLAGS as readonly string[]).includes(token.text) });
  }
  return { core: removeSpans(head, tokens.filter((token): boolean => taken.has(token))), seen, refused };
}

// The text with each span cut out together with the whitespace in front of it.
function removeSpans(text: string, spans: readonly { readonly start: number; readonly end: number }[]): string {
  let out = text;
  for (const span of [...spans].sort((a, b): number => b.start - a.start)) {
    let from = span.start;
    while (from > 0 && /\s/.test(out[from - 1] as string)) from--;
    out = out.slice(0, from) + out.slice(span.end);
  }
  return out.trim();
}

// An exact scope flag in the `then` clause, outside quotes, as a whole word --
// followed by whitespace, the end, or punctuation (`then x --dry-run;`, Feitan
// F3 on zheref/nen#562). Quoted text after `then` is prose and never scanned,
// so a corrected line never rewrites it.
function flagsInTail(tail: string): { readonly flags: ReadonlySet<ScopeFlag>; readonly rest: string } {
  const blanked = blankQuoted(tail);
  const flags = new Set<ScopeFlag>();
  const spans: { start: number; end: number }[] = [];
  for (const flag of SCOPE_FLAGS) {
    for (const match of blanked.matchAll(new RegExp(`(?<=^|\\s)${flag}(?=[\\s,;.:!?)\\]}]|$)`, "g"))) {
      flags.add(flag);
      spans.push({ start: match.index, end: match.index + flag.length });
    }
  }
  return { flags, rest: removeSpans(tail, spans) };
}

// The line with each typed flag once, after the scope and before any `then`.
function scopeLine(scope: string, flags: ReadonlySet<ScopeFlag>, then: string | null): string {
  const written = SCOPE_FLAGS.filter((flag): boolean => flags.has(flag)).map((flag): string => ` ${flag}`).join("");
  return `${scope}${written}${then === null || then === "" ? "" : ` then ${then}`}`;
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

  // N7: THE SELECTOR IS CHECKED BEFORE ANY THEN-CLAUSE REFUSAL. A missing or
  // malformed '@<selector>' is the more fundamental defect -- there is no
  // repo/severity scope to even evaluate a chain against -- so it must be
  // reported first regardless of what the 'then' clause contains, and
  // 'correctedLine: null' (the empty-selector case just below) must never be
  // shadowed by a chain-level refusal that DOES offer a corrected line (a
  // near-miss terminal, a reserved step name, a duplicate step): '@ then
  // mugetsu+mugetsu' is refused for its missing selector, never for the
  // duplicate 'mugetsu' step the chain also happens to carry.
  // `--idle` (HR-5) and `--dry-run` (zheref/nen#520) are OPTIONAL FLAGS OF
  // THE SCOPE, before any `then`: tokens at the start or the end of the head
  // (`--idle nen@bug`, `nen@bug --dry-run --idle`), in any order. Only those
  // places, so a quoted label that merely contains the text (`nen@"x --idle"`)
  // is never read as a flag. After `then` a flag would be indistinguishable
  // from prose, so it is refused there with the line moved, never silently
  // dropped: an idle run read as attended, or a dry run read as a live one, is
  // a guess with side effects. Each is one flag: typed twice -- at both ends,
  // twice at the same end, or once on each side of `then` -- it is refused
  // with one kept, never read as part of the label (zheref/nen#491 AC-2).
  const scope = readScopeFlags(head);
  const scopeHead = scope.core;
  const moved = tail === null ? { flags: new Set<ScopeFlag>(), rest: null } : flagsInTail(tail);
  const thenText = moved.rest;
  const attempted = scope.refused.map((entry): ScopeFlag | null => entry.flag).filter((flag): flag is ScopeFlag => flag !== null);
  const typed = new Set<ScopeFlag>([...scope.seen.keys(), ...moved.flags, ...attempted]);
  const copies = (flag: ScopeFlag): number =>
    (scope.seen.get(flag) ?? 0) + (moved.flags.has(flag) ? 1 : 0) + attempted.filter((each): boolean => each === flag).length;
  const twice = SCOPE_FLAGS.find((flag): boolean => copies(flag) > 1);
  const misplaced = SCOPE_FLAGS.find((flag): boolean => moved.flags.has(flag));
  // A word that is no exact flag is named first: it is the one the caller
  // most likely did not mean (`nen@bug --dry-run --verbose` names --verbose).
  const stray = scope.refused.find((entry): boolean => !entry.exact) ?? scope.refused[0];
  if (twice !== undefined || stray !== undefined || misplaced !== undefined) {
    const correctedLine = scopeLine(scopeHead, typed, thenText);
    const message =
      twice !== undefined
        ? `'${twice}' is given twice. It is one flag of the scope.`
        : stray !== undefined
          ? stray.exact
            ? `'${stray.token}' stands inside the selector. A flag of the scope is the first or the last token before 'then'; quote the label to keep the word in it.`
            : stray.flag !== null
              ? `'${stray.token}' is not '${stray.flag}', and is never read into the label. Type the flag exactly, or quote the label to keep the word in it.`
              : `'${stray.token}' is not a flag of futon's scope (${SCOPE_FLAGS.join(", ")}), and is never read into the label. Drop it, or quote the label to keep the word in it.`
          : `'${misplaced}' after 'then' is read as part of the then clause. It is a flag of the scope: put it before 'then'.`;
    return { ok: false, error: { message, correctedLine } };
  }
  const idle = typed.has("--idle");
  const dryRun = typed.has("--dry-run");

  const at = scopeHead.indexOf("@");
  if (at === -1) {
    return {
      ok: false,
      error: {
        message: `'${head}' has no '@<severity>' or '@<label>'. Expected '<repo>@<severity>[+]' or '<repo>@<label>', or a bare '@...' to mean the repo you are standing in.`,
        correctedLine: null,
      },
    };
  }
  const repoPart = scopeHead.slice(0, at).trim();
  const selectorPart = scopeHead.slice(at + 1).trim();
  // F6: a trailing '+' is the band operator ONLY when the token in front of
  // it is itself a severity -- otherwise it stays part of the label verbatim
  // ('c++' is the label 'c++', not the label 'c' with a refused '+').
  const plusCandidate = selectorPart.endsWith("+") ? stripQuotes(selectorPart.slice(0, -1).trim()) : null;
  const plus = plusCandidate !== null && (SEVERITY_ORDER as readonly string[]).includes(plusCandidate.toLowerCase());
  const selectorRaw = stripQuotes((plus ? (plusCandidate as string) : selectorPart).trim());
  if (selectorRaw === "") {
    // NEVER MANUFACTURE A SELECTOR. The maintainer's ruling (2026-09-28): a
    // missing selector is a missing DECISION -- which severity or label this
    // run scopes to is the one thing only a human (or a picker relaying a
    // human's choice) may state for a chain that goes on to publish. Filling
    // in `critical` here would hand a picker a COMPLETE, parseable line it
    // could paste and run without ever having chosen a selector -- silently
    // picking the most severe band on the caller's behalf. `correctedLine` is
    // `null` so nothing downstream can mistake "the shape of a fix" for "the
    // fix", the same distinction this module already draws for the two
    // structural failures above (an unparseable head, a malformed chain).
    return {
      ok: false,
      error: {
        message: `no selector after '@'. Expected a severity (${SEVERITY_ORDER.join(", ")}, optionally suffixed '+') or a label -- nen will not guess one, because the selector is the scoping decision a chain that goes on to publish must never have silently picked for it.`,
        correctedLine: null,
      },
    };
  }

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
      if (steps !== null) {
        // DUPLICATE STEP REFUSAL: the same skill against the same target
        // twice is never a chain anybody meant to write -- 'mugetsu@a' run
        // after 'mugetsu@a' either double-runs an advance-go against the
        // same target (harmless at best, a double-publish at worst) or is a
        // paste error, and nen cannot tell which without guessing. Compared
        // on the BARE skill name (namespace prefix stripped, lower-cased --
        // the same normalization ../schema/workflow.ts's futon.advanceGo
        // keys read) and the target lower-cased too (N9 -- 'mugetsu@A' and
        // 'mugetsu@a' name the same target under any spelling a caller
        // types), because a genuinely DIFFERENT target is a different step:
        // 'mugetsu@a+mugetsu@b' stays allowed, and this rule states no
        // ordering requirement at all. N8: EVERY later repeat is collected,
        // not just the first one found -- 'a+b+a+b' drops BOTH repeats in
        // the corrected line, not only the first 'a'.
        const seen = new Set<string>();
        const duplicateIndices: number[] = [];
        for (const [index, step] of steps.entries()) {
          const bareSkill = step.skill.replace(/^[a-z0-9][a-z0-9-]*:/i, "").toLowerCase();
          const key = `${bareSkill}@${(step.target ?? "").toLowerCase()}`;
          if (seen.has(key)) {
            duplicateIndices.push(index);
            continue;
          }
          seen.add(key);
        }
        if (duplicateIndices.length > 0) {
          const dupParts = normalized.split("+");
          const corrected = dupParts.filter((_part, index): boolean => !duplicateIndices.includes(index));
          const dupStep = steps[duplicateIndices[0]!]!;
          return {
            ok: false,
            error: {
              message: `'${dupStep.skill}${dupStep.target === null ? "" : `@${dupStep.target}`}' appears more than once in the chain '${tail}' -- the same skill against the same target twice is never a chain nen will run without asking: it is either a double-run of the same step or a paste error, and nen cannot tell which.`,
              correctedLine: `${head} then ${corrected.join("+")}`,
            },
          };
        }
      }
      then = steps === null ? { kind: "prose", text: tail } : { kind: "skills", steps };
    } else {
      then = { kind: "prose", text: tail };
    }
  }

  const severity = SEVERITY_ORDER.find((candidate): boolean => candidate === selectorRaw.toLowerCase());
  if (severity === undefined) {
    // Any other token is a label, taken exactly as typed -- including one
    // that ends in a literal '+' that failed F6's severity check above
    // ('c++' is the label 'c++', not a refused severity-band operator).
    return {
      ok: true,
      value: { repoToken: repoPart === "" ? null : repoPart, band: null, label: selectorRaw, terminal, then, idle, dryRun },
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
      idle,
      dryRun,
    },
  };
}

/**
 * Strips a matching pair of surrounding quotes. The unquoted branch returns
 * `text` as given (the caller has already trimmed it); the quoted branch
 * returns the interior VERBATIM -- boundary spaces inside the quotes are the
 * label, e.g. `@" bug "` names the label `' bug '`, not `'bug'`.
 */
function stripQuotes(text: string): string {
  const match = /^(["'])(.*)\1$/.exec(text);
  return match === null ? text : (match[2] ?? "");
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
