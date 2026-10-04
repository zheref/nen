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
 *   unreadable, empty or possibly truncated); nothing was written.
 */
export interface PrivateNameCheck {
  readonly result: "clean" | "skipped-private-target" | "skipped-by-flag" | "refused" | "unavailable";
  readonly targetVisibility: Visibility | null;
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

/** Bytewise (LC_ALL=C) sort, de-duplicated -- the order an index points into. */
function sortedUnique(values: readonly string[]): readonly string[] {
  return [...new Set(values)].sort((a, b): number => {
    const left = Buffer.from(a, "utf8");
    const right = Buffer.from(b, "utf8");
    return Buffer.compare(left, right);
  });
}

// --- matching ----------------------------------------------------------------

/** A compiled matcher over one list: the regex and each lowercase name's index. */
export interface NameMatcher {
  readonly pattern: RegExp;
  readonly indexOf: ReadonlyMap<string, number>;
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
 * Compile the list. Each entry's NAME (after the last `/`) is matched; the
 * first entry wins a case twin across owners, so they share one index.
 * Longest first, so a name that is a prefix of another never shadows it.
 */
export function compileMatcher(list: readonly string[], ignore: IgnoreList | null = null): NameMatcher {
  const indexOf = new Map<string, number>();
  const names: string[] = [];
  const policed = new Set<string>();
  list.forEach((entry, position): void => {
    const name = entry.replace(/^.*\//, "");
    const key = name.toLowerCase();
    if (name === "") return;
    const exempt = ignore !== null && (ignore.names.has(key) || ignore.slugs.has(entry.toLowerCase()));
    if (!exempt) policed.add(key);
    if (indexOf.has(key)) return;
    indexOf.set(key, position + 1);
    names.push(name);
  });
  const ignored = new Set([...indexOf.keys()].filter((key): boolean => !policed.has(key)));
  const alternation = names
    .sort((a, b): number => b.length - a.length)
    .map(escapeRegExp)
    .join("|");
  const pattern = new RegExp(`(?<![A-Za-z0-9-])(${alternation})(?![A-Za-z0-9-])`, "gi");
  return { pattern, indexOf, ignored };
}

/** Named HTML entities the normalised reading decodes -- the script's own table. */
const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ",
  hyphen: "-", dash: "-", minus: "-", ndash: "-", mdash: "-", lowbar: "_",
  UnderBar: "_", period: ".", sol: "/", bsol: "\\", colon: ":", commat: "@",
  num: "#", percnt: "%", shy: "", zwsp: "", zwj: "", zwnj: "", NewLine: " ",
};

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
 * before ASCII punctuation dropped, NFKC applied, format characters (zero
 * width, soft hyphen) deleted and every dash folded to `-`. Those
 * transformations are what is handled; nothing else is claimed.
 */
export function normalise(line: string): string {
  let text = percentDecode(line);
  for (let pass = 0; pass < 2; pass++) {
    text = text.replace(/&#[xX]([0-9A-Fa-f]{1,6});/g, (_m, hex: string): string => codePoint(Number.parseInt(hex, 16)));
    text = text.replace(/&#([0-9]{1,7});/g, (_m, dec: string): string => codePoint(Number.parseInt(dec, 10)));
    text = text.replace(/&([A-Za-z][A-Za-z0-9]{1,31});/g, (whole, name: string): string => ENTITIES[name] ?? whole);
  }
  text = text.replace(/<\/?[A-Za-z][^<>]*>/g, "");
  text = text.replace(/\\(?=[!-/:-@[-`{-~])/g, "");
  text = text.normalize("NFKC");
  text = text.replace(/\p{Cf}/gu, "");
  text = text.replace(/\p{Pd}/gu, "-");
  return text;
}

/**
 * The second normalised reading: HTML comments, `*` and backticks removed, so
 * intraword emphasis and code spans that RENDER as one word read as one. `_`
 * stays: CommonMark never renders an intraword `_` as emphasis.
 */
export function normaliseMarkup(text: string): string {
  return text.replace(/<!--.*?-->/g, "").replace(/[*`]/g, "");
}

function needsNormalising(line: string): boolean {
  return /[%&<\\*`]|[^\x00-\x7F]/.test(line);
}

/** Every hit in the given fields, raw first, then each normalised reading. */
export function findPrivateNames(matcher: NameMatcher, fields: readonly CheckedText[]): readonly PrivateNameHit[] {
  const hits: PrivateNameHit[] = [];
  for (const { field, text } of fields) {
    text.split(/\r?\n/).forEach((line, offset): void => {
      const reported = new Set<string>();
      const scan = (candidate: string, normalised: boolean): void => {
        for (const match of candidate.matchAll(matcher.pattern)) {
          const key = (match[1] ?? "").toLowerCase();
          if (reported.has(key)) continue;
          const index = matcher.indexOf.get(key);
          if (index === undefined) continue;
          reported.add(key);
          hits.push({ field, line: offset + 1, index, normalised, ignored: matcher.ignored.has(key) });
        }
      };
      scan(line, false);
      if (!needsNormalising(line)) return;
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
): PrivateNameCheck {
  if (skip) return { result: "skipped-by-flag", targetVisibility: null, hits: [], error: null };
  let visibility: Visibility;
  try {
    visibility = readTargetVisibility(seams, target);
  } catch (error) {
    if (!(error instanceof PrivateListUnavailableError)) throw error;
    return { result: "unavailable", targetVisibility: null, hits: [], error: error.message };
  }
  if (visibility !== "public") {
    return { result: "skipped-private-target", targetVisibility: visibility, hits: [], error: null };
  }
  let list: readonly string[];
  try {
    list = readPrivateList(seams);
  } catch (error) {
    if (!(error instanceof PrivateListUnavailableError)) throw error;
    return { result: "unavailable", targetVisibility: visibility, hits: [], error: error.message };
  }
  const hits = findPrivateNames(compileMatcher(list, ignore), fields);
  const blocking = hits.some((hit): boolean => !hit.ignored);
  return { result: blocking ? "refused" : "clean", targetVisibility: visibility, hits, error: null };
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
        `nen issue: private-name check could not run -- ${check.error ?? "unknown error"}.`,
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
