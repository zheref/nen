// src/issue/privacy.ts -- refuse text that names a PRIVATE repository before it
// is written to a PUBLIC one (zheref/nen#329).
//
// WHY THE BINARY OWNS IT. A consumer's policy can forbid naming a private
// repository in a public issue, and drafts drift: public issue bodies named
// private repositories for weeks before anyone noticed. The only guard was a
// script every skill had to remember to pipe each title, body and comment
// through BEFORE calling nen -- so a skill that forgot, or a caller outside
// that one consumer, published unchecked. `issue file`, `issue comment` and
// `issue edit-body` are the three verbs that put caller-written text on a
// GitHub issue, so the check lives where the write does.
//
// THE BEHAVIOUR MATCHED is zheref/hatsu's `scripts/private_name_check.sh`:
//
//   - the list is the CREDENTIAL's live private list, `user/repos?visibility=
//     private`, every page, read on every call and never cached or written;
//   - each repository's NAME (the part after the owner) is matched,
//     case-insensitive and whole-word, taken literally. A word is a run of
//     [A-Za-z0-9-], so `name` inside `name-tools` is another word, while `_`
//     and `.` BOUND a word, failing closed: `_name_`, `__name__`, `my_name`,
//     `name.git` and a sentence's `name.` all match, and `owner/name` slugs and
//     URLs match through the name;
//   - a line holding `%`, `&`, `<`, `\`, `*`, a backtick or a non-ASCII
//     character is also read NORMALISED, twice (see `normalise` below), so a
//     name spelt through an escape, an entity, URL encoding, inline markup or an
//     invisible character is still a hit;
//   - the refusal NEVER prints the name: a hit is an index into the sorted list
//     and the line it was found on.
//
// THE IGNORE FILE, and only when the caller names it. `--private-names-ignore-
// file <path>` lists private repositories the caller has ruled too generic to
// police -- one per line, `#` comments and blanks ignored; a bare `name`
// exempts that name under every owner, an `owner/name` line that slug only,
// case-insensitive. No default path is ever read: an ignore list nen found on
// its own is an exemption nobody passed. An ignored hit is NEVER silent -- it is
// reported (stderr, and `ignored: true` under --json), it just does not block.
//
// WHAT IS NOT CARRIED OVER, deliberately: the script's one named exemption (a
// marker quoted byte for byte by one consumer's generator). That is the
// consumer's policy, not a property of the check, and an exemption nen invented
// would be a hole nobody reviewed.
//
// FAIL CLOSED, ALWAYS. An unreadable target visibility, an unreadable list, a
// list that may be truncated and a list that reads EMPTY are each a refusal --
// a token that cannot see private repositories would otherwise read green, and
// "could not look" must never read the same as "found nothing".

import { GH, outputLines, type Seams } from "../seam/exec.js";
import { plainLine } from "../cli/plain.js";
import type { Target } from "../github/target.js";

/** The exit code a private-name refusal answers with, in every verb that runs the check. */
export const PRIVATE_NAME_EXIT = 4;

/** The opt-out: the caller attests it ran its own check. Named in every run that uses it. */
export const SKIP_PRIVATE_NAME_CHECK_FLAG = "skip-private-name-check";

/** Page size asked of `user/repos`, and the size a full page is judged against. */
const PAGE_SIZE = 100;

/**
 * The most pages read before the list is called possibly-truncated -- 10,000
 * private repositories. Past it the run REFUSES rather than checking against a
 * partial list: a narrower list is a quieter guard.
 */
const MAX_PAGES = 100;

export type Visibility = "public" | "private" | "internal";

/** One place a private name was found. `index` is 1-based into the sorted list. */
export interface PrivateNameHit {
  /** Which input carried it: `title` or `body`. */
  readonly field: string;
  /** 1-based line within that field. */
  readonly line: number;
  readonly index: number;
  /** True when it was found only once the line was normalised. */
  readonly normalised: boolean;
  /** True when the caller's ignore file exempts this name: reported, never blocking. */
  readonly ignored: boolean;
}

/**
 * The caller's ignore list: bare names (exempt under every owner) and
 * `owner/name` slugs (exempt for that repository only), both lowercase.
 */
export interface IgnoreList {
  readonly names: ReadonlySet<string>;
  readonly slugs: ReadonlySet<string>;
}

/**
 * Parse an ignore file's text: one entry per line, `#` to end of line a
 * comment, whitespace removed, blank lines skipped, compared lowercase.
 */
export function parseIgnoreList(text: string): IgnoreList {
  const names = new Set<string>();
  const slugs = new Set<string>();
  for (const raw of text.split(/\r?\n/)) {
    const entry = raw.replace(/#.*/, "").replace(/\s+/g, "").toLowerCase();
    if (entry === "") continue;
    if (entry.includes("/")) slugs.add(entry);
    else names.add(entry);
  }
  return { names, slugs };
}

/** One field of text to check, named for the report. */
export interface CheckedText {
  readonly field: string;
  readonly text: string;
}

/**
 * The check's verdict, carried on every --json report of the three verbs.
 *
 * `checked`/`clean` -- the target is public and nothing matched.
 * `skipped-private-target` -- a private or internal target: naming a private
 *   repository inside one leaks nothing, so the list is never read.
 * `skipped-by-flag` -- the opt-out was given; nothing was read.
 * `refused` -- at least one hit; nothing was written.
 * `unavailable` -- the check could not be performed (visibility or list
 *   unreadable, empty or possibly truncated, or every name on it ignored
 *   without --allow-all-ignored); nothing was written.
 */
export interface PrivateNameCheck {
  readonly result: "clean" | "skipped-private-target" | "skipped-by-flag" | "refused" | "unavailable";
  readonly targetVisibility: Visibility | null;
  /**
   * How many private repositories the list held, and under how many owners --
   * COUNTS ONLY, never a name. Null when the list was never read.
   */
  readonly listSize: number | null;
  readonly owners: number | null;
  readonly hits: readonly PrivateNameHit[];
  /** Why the check could not be performed; null unless `unavailable`. */
  readonly error: string | null;
}

/** Thrown when the check cannot run. Never carries a private name. */
export class PrivateListUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PrivateListUnavailableError";
  }
}

// --- reads -------------------------------------------------------------------

/**
 * The target's visibility, from `repos/{owner}/{name}`. Fail closed: a read
 * that fails, does not parse, or carries neither a known `visibility` nor a
 * boolean `private` throws. gh's own message is NOT echoed: it may name the
 * repository being asked about.
 */
export function readTargetVisibility(seams: Seams, target: Target): Visibility {
  const result = seams.run(GH, ["api", `repos/${target.slug}`]);
  if (result.spawnFailed) {
    throw new PrivateListUnavailableError("gh could not be started, so the target's visibility could not be read");
  }
  if (result.code !== 0) {
    throw new PrivateListUnavailableError(`could not read the target's visibility (gh exited ${result.code})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout);
  } catch {
    throw new PrivateListUnavailableError("the target's repository read did not parse as JSON");
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new PrivateListUnavailableError("the target's repository read was not an object");
  }
  const record = parsed as Record<string, unknown>;
  const visibility = record["visibility"];
  if (typeof visibility === "string") {
    const lowered = visibility.toLowerCase();
    if (lowered === "public" || lowered === "private" || lowered === "internal") return lowered;
    throw new PrivateListUnavailableError("the target's visibility is not public, private or internal");
  }
  // An older server carries only the boolean. `false` reads as public, which is
  // the direction that CHECKS -- never the one that skips.
  const isPrivate = record["private"];
  if (typeof isPrivate === "boolean") return isPrivate ? "private" : "public";
  throw new PrivateListUnavailableError("the target's repository read carried no visibility");
}

/**
 * The credential's private repositories, as `owner/name`, sorted bytewise and
 * de-duplicated -- the order the refusal's indices point into. Every page is
 * read; a list that may be truncated, fails, or reads EMPTY throws.
 */
export function readPrivateList(seams: Seams): readonly string[] {
  const names: string[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const result = seams.run(GH, ["api", `user/repos?visibility=private&per_page=${PAGE_SIZE}&page=${page}`]);
    if (result.spawnFailed) {
      throw new PrivateListUnavailableError("gh could not be started, so the private repository list could not be read");
    }
    if (result.code !== 0) {
      const first = outputLines(result.stderr)[0];
      throw new PrivateListUnavailableError(
        `gh could not list the credential's private repositories (${first === undefined ? `exit ${result.code}` : first})`,
      );
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.stdout);
    } catch {
      throw new PrivateListUnavailableError(`page ${page} of the private repository list did not parse as JSON`);
    }
    if (!Array.isArray(parsed)) {
      throw new PrivateListUnavailableError(`page ${page} of the private repository list was not an array`);
    }
    for (const entry of parsed) {
      const fullName = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["full_name"] : undefined;
      if (typeof fullName !== "string" || fullName === "") {
        throw new PrivateListUnavailableError(`page ${page} of the private repository list carried an entry with no full_name`);
      }
      // EXACTLY `owner/name`, both halves non-empty and whitespace-free. A
      // malformed entry (`owner/`, `a/b/c`, a bare name) would be dropped or
      // mis-split by the matcher and police nothing, so the whole list is
      // refused rather than checked with a hole in it. The value is not echoed:
      // it may be a private name.
      if (!VALID_FULL_NAME.test(fullName)) {
        throw new PrivateListUnavailableError(
          `page ${page} of the private repository list carried a malformed full_name (entry ${names.length + 1}; not exactly owner/name), so the list is not checked against`,
        );
      }
      names.push(fullName);
    }
    if (parsed.length < PAGE_SIZE) {
      if (names.length === 0) {
        throw new PrivateListUnavailableError(
          "the private repository list read EMPTY -- the credential may not see private repositories (gh auth status; the token needs the repo scope), so nothing would be checked",
        );
      }
      return sortedUnique(names);
    }
  }
  throw new PrivateListUnavailableError(
    `the private repository list filled ${MAX_PAGES} pages of ${PAGE_SIZE}; it may be truncated, so it is not checked against`,
  );
}

/** One slash, a non-empty whitespace-free owner and name on either side. */
const VALID_FULL_NAME = /^[^\s/]+\/[^\s/]+$/;

/** Bytewise (LC_ALL=C) sort, de-duplicated -- the order an index points into. */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b): number => {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    return Buffer.compare(left, right);
  });
}

// --- matching ----------------------------------------------------------------

/**
 * A compiled matcher over one list: ONE REGEX PER NAME, and each lowercase
 * name's index.
 *
 * Per name, never one alternation: an alternation consumes the text it
 * matches, so a longer name (`vault.tools`, `my_vault`) hides every shorter
 * name it contains (`vault`) -- and when the longer one is ignored, the
 * shorter, still-policed one passed unseen. Each name is tested against the
 * whole line with its own boundary test, overlaps included, and exemptions
 * are applied only after every occurrence is found.
 */
export interface NameMatcher {
  readonly patterns: ReadonlyMap<string, RegExp>;
  readonly indexOf: ReadonlyMap<string, number>;
  /**
   * Each still-policed name's index: the FIRST entry carrying it that the
   * ignore list does not exempt. A blocking hit reports this one, so `#k`
   * resolves to the repository that actually blocked -- never to an exempt
   * twin that happens to sort first.
   */
  readonly policedIndexOf: ReadonlyMap<string, number>;
  /**
   * Lowercase names the ignore list exempts: a name is exempt only when EVERY
   * list entry carrying it is -- ignoring `a/thing` leaves `b/thing` policed,
   * and the two share one index, so the name still blocks.
   */
  readonly ignored: ReadonlySet<string>;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\/-]/g, "\\$&");
}

/**
 * Compile the list. Each entry's NAME (after the `/`) is matched; the first
 * entry wins a case twin across owners, so they share one index.
 */
export function compileMatcher(list: readonly string[], ignore: IgnoreList | null = null): NameMatcher {
  const indexOf = new Map<string, number>();
  const names: string[] = [];
  const policedIndexOf = new Map<string, number>();
  list.forEach((entry, position): void => {
    const name = entry.replace(/^.*\//, "");
    const key = name.toLowerCase();
    if (name === "") return;
    const exempt = ignore !== null && (ignore.names.has(key) || ignore.slugs.has(entry.toLowerCase()));
    if (!exempt && !policedIndexOf.has(key)) policedIndexOf.set(key, position + 1);
    if (indexOf.has(key)) return;
    indexOf.set(key, position + 1);
    names.push(name);
  });
  const ignored = new Set([...indexOf.keys()].filter((key): boolean => !policedIndexOf.has(key)));
  const patterns = new Map<string, RegExp>(
    names.map((name): [string, RegExp] => [
      name.toLowerCase(),
      new RegExp(`(?<![A-Za-z0-9-])${escapeRegExp(name)}(?![A-Za-z0-9-])`, "i"),
    ]),
  );
  return { patterns, indexOf, policedIndexOf, ignored };
}

/**
 * Named HTML entities the normalised reading decodes -- the script's own
 * table. A MAP, never an object literal: `&constructor;` or `&toString;` must
 * not resolve through Object.prototype into a function's source text.
 */
const ENTITIES: ReadonlyMap<string, string> = new Map([
  ["amp", "&"], ["lt", "<"], ["gt", ">"], ["quot", '"'], ["apos", "'"], ["nbsp", " "],
  ["hyphen", "-"], ["dash", "-"], ["minus", "-"], ["ndash", "-"], ["mdash", "-"], ["lowbar", "_"],
  ["UnderBar", "_"], ["period", "."], ["sol", "/"], ["bsol", "\\"], ["colon", ":"], ["commat", "@"],
  ["num", "#"], ["percnt", "%"], ["shy", ""], ["zwsp", ""], ["zwj", ""], ["zwnj", ""], ["NewLine", " "],
]);

function codePoint(value: number): string {
  return value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff) ? "�" : String.fromCodePoint(value);
}

/** %XX decoded as BYTES, then the whole read as UTF-8 (invalid sequences become U+FFFD). */
function percentDecode(line: string): string {
  const source = Buffer.from(line, "utf8");
  const bytes: number[] = [];
  for (let i = 0; i < source.length; i++) {
    const byte = source[i] as number;
    if (byte === 0x25 && i + 2 < source.length) {
      const hex = String.fromCharCode(source[i + 1] as number, source[i + 2] as number);
      if (/^[0-9A-Fa-f]{2}$/.test(hex)) {
        bytes.push(Number.parseInt(hex, 16));
        i += 2;
        continue;
      }
    }
    bytes.push(byte);
  }
  return new TextDecoder("utf-8").decode(Uint8Array.from(bytes));
}

/**
 * The first normalised reading: %XX decoded, UTF-8 decoded, HTML entities
 * decoded (twice, for a doubly-escaped one), inline tags and backslash escapes
 * before ASCII punctuation dropped, NFKC applied, format characters and
 * default-ignorable code points (zero width, soft hyphen, U+034F, variation
 * selectors) deleted and every dash, U+2212 included, folded to `-`. Those
 * transformations are what is handled; nothing else is claimed.
 */
export function normalise(line: string): string {
  return normaliseReading(line, true);
}

/**
 * The same reading with inline tags KEPT. Stripping a tag strips what is
 * inside it too -- an autolink `<https://…/v%61ult>` or an `href="…"` -- so
 * the decoded text is scanned before the tags go as well as after.
 */
export function normaliseKeepingTags(line: string): string {
  return normaliseReading(line, false);
}

function normaliseReading(line: string, stripTags: boolean): string {
  let text = percentDecode(line);
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(/&#[xX]([0-9A-Fa-f]{1,6});/g, (_m, hex: string): string => codePoint(Number.parseInt(hex, 16)));
    text = text.replace(/&#([0-9]{1,7});/g, (_m, dec: string): string => codePoint(Number.parseInt(dec, 10)));
    text = text.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (whole, name: string): string => ENTITIES.get(name) ?? whole);
  }
  if (stripTags) text = text.replace(/<\/?[A-Za-z][^<>]*>/g, "");
  text = text.replace(/\\(?=[!-/:-@[-`{-~])/g, "");
  text = text.normalize("NFKC");
  // Format characters AND every default-ignorable code point (U+034F
  // combining grapheme joiner, variation selectors, ...): each renders as
  // nothing, so each can split a name invisibly.
  text = text.replace(/[\p{Cf}\p{Default_Ignorable_Code_Point}]/gu, "");
  // Every dash, and U+2212 MINUS SIGN, which is a math symbol (Sm) rather than
  // a dash (Pd) but renders as one.
  text = text.replace(/[\p{Pd}\u2212]/gu, "-");
  return text;
}

/**
 * The second normalised reading: HTML comments, `*`, `~` and backticks
 * removed, so intraword emphasis, strikethrough (`~~`) and code spans that
 * RENDER as one word read as one. `_` stays: CommonMark never renders an
 * intraword `_` as emphasis.
 */
export function normaliseMarkup(text: string): string {
  return text.replace(/<!--.*?-->/g, "").replace(/[*~`]/g, "");
}

function needsNormalising(line: string): boolean {
  return /[%&<\\*~`]|[^\x00-\x7F]/.test(line);
}

/** Every hit in the given fields, raw first, then each normalised reading. */
export function findPrivateNames(matcher: NameMatcher, fields: readonly CheckedText[]): readonly PrivateNameHit[] {
  const hits: PrivateNameHit[] = [];
  for (const { field, text } of fields) {
    text.split(/\r?\n/).forEach((line, offset): void => {
      const reported = new Set<string>();
      const scan = (candidate: string, normalised: boolean): void => {
        for (const [key, pattern] of matcher.patterns) {
          if (reported.has(key) || !pattern.test(candidate)) continue;
          const ignored = matcher.ignored.has(key);
          const index = ignored ? matcher.indexOf.get(key) : matcher.policedIndexOf.get(key);
          if (index === undefined) continue;
          reported.add(key);
          hits.push({ field, line: offset + 1, index, normalised, ignored });
        }
      };
      scan(line, false);
      if (!needsNormalising(line)) return;
      // Decoded with tags kept FIRST, so a name inside a link destination or
      // an attribute is read before the tag-stripped reading removes it.
      const withTags = normaliseKeepingTags(line);
      scan(withTags, true);
      scan(normaliseMarkup(withTags), true);
      const first = normalise(line);
      scan(first, true);
      scan(normaliseMarkup(first), true);
    });
  }
  return hits;
}

// --- the check, as a verb runs it -----------------------------------------------

/**
 * Run the whole check for one write: the opt-out, then the target's
 * visibility, then the live list and the match. Never throws for a check that
 * could not run -- that is the `unavailable` verdict, which the caller refuses
 * on exactly as it refuses a hit.
 */
export function checkPrivateNames(
  seams: Seams,
  target: Target,
  fields: readonly CheckedText[],
  skip: boolean,
  ignore: IgnoreList | null = null,
  allowAllIgnored: boolean = false,
): PrivateNameCheck {
  const unread = { listSize: null, owners: null };
  if (skip) return { result: "skipped-by-flag", targetVisibility: null, ...unread, hits: [], error: null };
  let visibility: Visibility;
  try {
    visibility = readTargetVisibility(seams, target);
  } catch (error) {
    if (!(error instanceof PrivateListUnavailableError)) throw error;
    return { result: "unavailable", targetVisibility: null, ...unread, hits: [], error: error.message };
  }
  if (visibility !== "public") {
    return { result: "skipped-private-target", targetVisibility: visibility, ...unread, hits: [], error: null };
  }
  let list: readonly string[];
  try {
    list = readPrivateList(seams);
  } catch (error) {
    if (!(error instanceof PrivateListUnavailableError)) throw error;
    return { result: "unavailable", targetVisibility: visibility, ...unread, hits: [], error: error.message };
  }
  const counts = {
    listSize: list.length,
    owners: new Set(list.map((entry): string => entry.replace(/\/.*$/, "").toLowerCase())).size,
  };
  const matcher = compileMatcher(list, ignore);
  // EVERY NAME IGNORED is a check that polices nothing: refused as
  // unavailable, the script's rule, unless the caller says it means it.
  if (matcher.policedIndexOf.size === 0 && !allowAllIgnored) {
    return {
      result: "unavailable",
      targetVisibility: visibility,
      ...counts,
      hits: [],
      error: `every private name is ignored (the ignore file exempts all ${counts.listSize}), so nothing would be checked; pass --allow-all-ignored if that is meant`,
    };
  }
  const hits = findPrivateNames(matcher, fields);
  const blocking = hits.some((hit): boolean => !hit.ignored);
  return { result: blocking ? "refused" : "clean", targetVisibility: visibility, ...counts, hits, error: null };
}

/** Whether a verdict stops the write. */
export function blocksWrite(check: PrivateNameCheck): boolean {
  return check.result === "refused" || check.result === "unavailable";
}

/** The exit a blocking verdict answers with: 4 for a hit, 1 for a check that could not run. */
export function blockingExit(check: PrivateNameCheck): number {
  return check.result === "refused" ? PRIVATE_NAME_EXIT : 1;
}

/**
 * The human lines for a verdict, for stderr. Empty for `clean` and for a
 * private target (nothing to say), so a passing run's text output is
 * unchanged. The opt-out is always named.
 */
export function privateNameLines(check: PrivateNameCheck, target: Target): readonly string[] {
  const where = (hit: PrivateNameHit): string =>
    `${hit.field}:${hit.line}: private repository #${hit.index}${hit.normalised ? " (spelt through an escape, entity, encoding, markup or invisible character)" : ""}`;
  // An ignored hit is never silent, whatever the verdict.
  const ignoredLines = check.hits
    .filter((hit): boolean => hit.ignored)
    .map((hit): string => `nen issue: ignored: ${where(hit)} (ignore file)`);
  switch (check.result) {
    case "clean":
      return ignoredLines;
    case "skipped-private-target":
      return [];
    case "skipped-by-flag":
      return [
        `nen issue: private-name check SKIPPED by --${SKIP_PRIVATE_NAME_CHECK_FLAG} -- the caller attests it ran its own; nothing was compared against the private repository list.`,
      ];
    case "unavailable":
      return [
        // plainLine: the error can carry gh's stderr, which is text nen did
        // not write; --json keeps the bytes.
        `nen issue: private-name check could not run -- ${plainLine(check.error ?? "unknown error")}.`,
        `  ${target.slug} may be public, so nothing was written: a check that cannot read is a refusal, never a pass. Fix the read, or pass --${SKIP_PRIVATE_NAME_CHECK_FLAG} after running your own check.`,
      ];
    case "refused": {
      const blocking = check.hits.filter((hit): boolean => !hit.ignored);
      return [
        ...ignoredLines,
        ...blocking.map((hit): string => `nen issue: ${where(hit)}`),
        `nen issue: ${blocking.length} mention(s) of a private repository in text bound for PUBLIC ${target.slug}; nothing was written. Redact them and retry.`,
        `  #k indexes the credential's private list, sorted bytewise: gh api --paginate 'user/repos?visibility=private&per_page=100' -q '.[].full_name' | LC_ALL=C sort -u | sed -n '<k>p'`,
      ];
    }
  }
}
