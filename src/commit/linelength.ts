// src/commit/linelength.ts -- commitlint's `body-max-line-length` and
// `footer-max-line-length` as DATA and as SEMANTICS, and the wrap `commit
// format` applies to --body so that it never emits a line those rules refuse
// (zheref/nen#290).
//
// WHY THIS EXISTS. `nen commit format` rendered --body as the caller typed
// it: a one-line paragraph of any length. A repository whose commitlint
// config extends @commitlint/config-conventional refuses a body line over
// 100 characters, so the verb's green was followed by the commit-msg hook's
// red -- in the sitting the issue came from, after `wc squash` had already
// reset, which left the message to be rewrapped and committed by hand.
//
// A LEAF MODULE, like ./case.ts for subject-case: it holds what the rules
// MEAN and nothing about where a repository states them. ./bodywidth.ts reads
// the rules from the repository's config (through ./commitlint.ts's search)
// and turns a verdict into the lines the verbs print.
//
// PORTED, WITH NO DEPENDENCY, FROM 21.2.3 (the version ./case.ts ports):
//
//   * @commitlint/rules' body-max-line-length and footer-max-line-length.
//     Each ignores its condition ('always' and 'never' mean the same), passes
//     an empty body/footer, and hands the whole section to @commitlint/
//     ensure's max-line-length.
//   * @commitlint/ensure's max-line-length: split on /\r?\n/, and EVERY line
//     must either hold an http(s) URL -- anywhere, matched by the
//     deliberately lenient /\bhttps?:\/\/\S+/ -- or be at most `max` UTF-16
//     code units long (JavaScript's String length, which is what commitlint
//     measures). A line holding a URL is exempt WHOLE, whatever else it holds.
//   * WHICH LINES ARE BODY AND WHICH ARE FOOTER, from conventional-commits-
//     parser 7.1.2 (the parser @commitlint/parse 21.2.3 runs): after the
//     header, lines are body until the first line that opens a footer -- a
//     note (`BREAKING CHANGE:` / `BREAKING-CHANGE:`, optionally after `* `)
//     or a footer token, `^(?:BREAKING CHANGE|[\w-]+)(?::\s+|\s+#).+` -- and
//     every line from there on is footer. So `Closes #290` or `Note: ...` at
//     the start of a line moves the REST of the message into the footer, and
//     the footer rule, not the body rule, judges it.
//   * WHAT THE HOOK NEVER SEES. A commit-msg hook runs `commitlint --edit`,
//     which strips comment lines -- those that start with '#', git's default
//     core.commentChar -- and everything from git's scissors line on; the
//     parser also drops `gpg:` lines. They are neither body nor footer.
//     core.commentChar itself is NOT read: a repository that sets another
//     comment character has its '#' lines judged here and not there.
//
// THE WRAP IS NEN'S, NOT COMMITLINT'S -- commitlint only judges. It touches
// ONLY a line the rule would refuse (so a message within its limits comes out
// byte-for-byte as it went in), and on such a line it:
//
//   * breaks only at spaces and tabs -- never inside a word, and never at a
//     no-break space -- so a URL, a path, or any unbroken token longer than
//     the width stays whole on a line of its own (a URL line is then exempt,
//     as commitlint exempts it);
//   * changes nothing but the breaks: the whitespace between two words that
//     stay on one line is kept, each break becomes the line's own terminator
//     (a CRLF line stays CRLF) and the hang indent, and only the line's
//     trailing whitespace is dropped (git drops it on commit anyway);
//   * keeps a list item's marker and hangs its continuation lines under the
//     item's text (`- `, `* `, `+ `, `1. `, `1) `, after up to three spaces);
//   * leaves a line indented as preformatted text (four spaces, or a tab)
//     exactly as it is -- rewrapping code or a log excerpt would corrupt it;
//   * NEVER CHANGES HOW COMMITLINT READS THE MESSAGE: no line it creates
//     starts with a footer token or note (it would move the rest of the
//     message into the footer), a '#' (git strips it as a comment under
//     --cleanup=strip, and the hook's commitlint never sees it) or `gpg:`;
//     and a line that OPENS the footer still opens it -- its first line keeps
//     the token with the word after it. A break that would do either moves a
//     word earlier; where no earlier break is safe, it moves to the next safe
//     break after it, and the line it leaves is over the width, reported
//     rather than traded for a message read differently (zheref/nen#290's
//     review, L1 -- held as a property in ./linelength.test.ts).
//
// Paragraph breaks are blank lines, and blank lines are never touched.

import { parseRuleShape, type TupleFault } from "./rule.js";

/** The two rules this module ports. */
export type LineRuleName = "body-max-line-length" | "footer-max-line-length";

/** @commitlint/config-conventional 21.2.3's value for BOTH rules -- `[2, "always", 100]` -- and nen's documented width where no readable rule states one. */
export const CONVENTIONAL_MAX_LINE_LENGTH = 100;

/**
 * A line-length rule, read: off, or a level and the width commitlint
 * compares every line against. `max` is that comparison's number, exactly as
 * commitlint gets it (see parseLineLengthTuple); `stated` is the value as the
 * config wrote it, for the lines that name it.
 */
export type LineLengthSpec = { readonly level: 0 } | { readonly level: 1 | 2; readonly max: number; readonly stated: unknown };

export type LineTupleResult = { readonly ok: true; readonly spec: LineLengthSpec } | TupleFault;

/**
 * A `[level, 'always'|'never', max]` tuple: commitlint's shape checks
 * (./rule.ts's parseRuleShape, shared with subject-case) and nothing more.
 *
 * THE WIDTH IS NEVER REFUSED, because commitlint never refuses it: its
 * config-validator leaves a rule's value unconstrained, and the rule runs
 * `line.length <= value` whatever the value is (zheref/nen#290's review, M1).
 * So `max` is the number that comparison really uses -- `Number(value)`, the
 * coercion JavaScript's `<=` applies, with an absent value read as 0, the
 * rule's own default parameter: `"100"` and `[100]` are 100, `null`, `""`
 * and `false` are 0, `"abc"` and `{}` are NaN. A width below 1 -- or NaN --
 * is still a rule commitlint runs: it passes a message with no body and
 * refuses the body lines that value refuses. nen judges it exactly so, and
 * ./bodywidth.ts says in words what that value does; it only declines to WRAP
 * to it (usableWidth), since no wrap can satisfy it.
 */
export function parseLineLengthTuple(value: unknown): LineTupleResult {
  const shape = parseRuleShape(value, "max");
  if (!shape.ok) return shape;
  if (shape.level === 0) return { ok: true, spec: { level: 0 } };
  return { ok: true, spec: { level: shape.level, max: shape.value === undefined ? 0 : Number(shape.value), stated: shape.value } };
}

/** Whether a width is one a line can be wrapped to: at least 1 (NaN is not). */
export function usableWidth(max: number): boolean {
  return max >= 1;
}

/** @commitlint/ensure 21.2.3's exemption, verbatim: a line holding an http(s) URL passes whatever its length. */
export const URL_EXEMPTION = /\bhttps?:\/\/\S+/;

/** One line under @commitlint/ensure's max-line-length: exempt, or no longer than `max`. */
export function lineFits(line: string, max: number): boolean {
  return URL_EXEMPTION.test(line) || line.length <= max;
}

/** conventional-commits-parser 7.1.2's footer token, with `#` its only issue prefix (commitlint's). */
const FOOTER_TOKEN = /^(?:BREAKING CHANGE|[\w-]+)(?::\s+|\s+#).+/i;

/** conventional-commits-parser's notes pattern for the conventionalcommits keywords. */
const NOTE = /^(?:\*\s+)?(?:BREAKING CHANGE|BREAKING-CHANGE):\s*(.*)/i;

/** git's default core.commentChar, which `commitlint --edit` strips by. */
const COMMENT_CHAR = "#";

/** git's scissors line: it and everything after it is not the message. */
const SCISSORS = `${COMMENT_CHAR} ------------------------ >8 ------------------------`;

/** conventional-commits-parser's gpgFilter. */
const GPG = /^\s*gpg:/;

/** A line commitlint's parser never hands to a rule. */
function unseen(line: string): boolean {
  return line.startsWith(COMMENT_CHAR) || GPG.test(line);
}

/** Whether `line` opens commitlint's footer. */
export function opensFooter(line: string): boolean {
  return NOTE.test(line) || FOOTER_TOKEN.test(line);
}

export type Section = "body" | "footer";

/** One line of a message, numbered from 1 as an editor numbers it. */
export interface MessageLine {
  readonly number: number;
  readonly text: string;
  readonly section: Section;
}

/**
 * The body and footer lines commitlint's parser finds in `message`, each
 * numbered by its place in `message`. The header is line 1; a comment,
 * scissors or gpg line is in neither list.
 */
export function commitlintSections(message: string): { readonly body: readonly MessageLine[]; readonly footer: readonly MessageLine[] } {
  const lines = message.split(/\r?\n/);
  const body: MessageLine[] = [];
  const footer: MessageLine[] = [];
  // trimNewLines: the header is the first line with anything on it, and the
  // blank lines after the last one are not the message's.
  let index = lines.findIndex((line): boolean => line !== "");
  if (index === -1) return { body, footer };
  while (lines[lines.length - 1] === "") lines.pop();
  const scissors = lines.indexOf(SCISSORS);
  const end = scissors === -1 ? lines.length : scissors;
  let header = false;
  let section: Section = "body";
  for (; index < end; index += 1) {
    const text = lines[index] ?? "";
    if (unseen(text)) continue;
    if (!header) {
      header = true;
      continue;
    }
    if (section === "body" && opensFooter(text)) section = "footer";
    (section === "body" ? body : footer).push({ number: index + 1, text, section });
  }
  // cleanupCommit: the parser trims each section's leading and trailing
  // newlines, so an empty line at either end of a section is not in it -- it
  // matters under a width below 0 or NaN, where commitlint refuses a blank
  // line inside a section and passes one at its edge.
  return { body: trimEmpty(body), footer: trimEmpty(footer) };
}

/** A section without the empty lines at either end. */
function trimEmpty(lines: readonly MessageLine[]): readonly MessageLine[] {
  let first = 0;
  let last = lines.length;
  while (first < last && lines[first]?.text === "") first += 1;
  while (last > first && lines[last - 1]?.text === "") last -= 1;
  return lines.slice(first, last);
}

/** A line whose leading whitespace marks it preformatted: four spaces, or a tab. */
const PREFORMATTED = /^(?: {4}| {0,3}\t)/;

/** Up to three spaces of indent, then an optional list marker and its spaces. */
const LEAD = /^( {0,3})((?:[-*+]|\d{1,9}[.)]) +)?/;

/** A line that must not start a line the wrap creates. */
function unsafeStart(text: string): boolean {
  return unseen(text) || opensFooter(text);
}

/**
 * A line's lead (indent and list marker, and any spaces or tabs after them),
 * its words, and the whitespace between each pair. Words break ONLY at spaces
 * and tabs -- never at a no-break space (U+00A0) or any other character
 * JavaScript's \s would match -- and the whitespace between two words that
 * stay on one line is kept exactly as it was.
 */
function tokenize(line: string): { readonly lead: string; readonly words: readonly string[]; readonly gaps: readonly string[] } {
  const marker = LEAD.exec(line)?.[0] ?? "";
  const lead = marker + (/^[ \t]*/.exec(line.slice(marker.length))?.[0] ?? "");
  const parts = line.slice(lead.length).replace(/[ \t]+$/, "").split(/([ \t]+)/);
  const words: string[] = [];
  const gaps: string[] = [];
  parts.forEach((part, index): void => {
    if (index % 2 === 0) words.push(part);
    else gaps.push(part);
  });
  return { lead, words: words.length === 1 && words[0] === "" ? [] : words, gaps };
}

/** Why a line the wrap was asked to shorten is still too long. */
export type Unwrapped =
  /** Indented four spaces or a tab: never rewrapped. */
  | "preformatted"
  /** It holds a word longer than the width, which is never split. */
  | "unbroken"
  /** No break inside the width keeps how commitlint reads the message: each would start a line with a footer token, a note, '#' or `gpg:`, or cut this line's own footer token off the words after it. */
  | "unsafe";

/**
 * `line` broken at spaces and tabs into lines of at most `width` characters
 * where the words allow it. Returns the line unchanged when it is
 * preformatted or holds no break.
 *
 * NO LINE IT CREATES STARTS WITH A FOOTER TOKEN, A NOTE, '#' OR `gpg:`, AND
 * A LINE THAT OPENS THE FOOTER STILL OPENS IT: its first line keeps the token,
 * its separator and the word after it. The greedy break is moved a word
 * earlier until the new line starts safely; when no earlier break is safe, it
 * moves to the next safe break AFTER it -- the end of the line, at the latest
 * -- and the line it leaves is over the width, for the caller to report
 * (wrapBody's leftOver, why "unsafe"). The wrap never trades a long line for
 * a message commitlint reads differently.
 */
export function wrapLine(line: string, width: number): readonly string[] {
  if (PREFORMATTED.test(line)) return [line];
  const { lead, words, gaps } = tokenize(line);
  if (words.length < 2) return [line];
  const hang = " ".repeat(lead.length);
  const rest = (from: number): string => words.slice(from).map((word, index): string => word + (gaps[from + index] ?? "")).join("");
  const joined = (from: number, to: number): string => words.slice(from, to).map((word, index): string => (index === 0 ? "" : (gaps[from + index - 1] ?? "")) + word).join("");
  const unsafeAt = (at: number): boolean => at < words.length && unsafeStart(hang + rest(at));
  // A line that OPENS the footer must still open it after the wrap: its first
  // line keeps at least the token, its separator and the next word ("Note:"
  // alone opens nothing). A line that does not open it cannot start to, since
  // its first line is a prefix of it.
  let firstMin = 1;
  if (opensFooter(line)) {
    while (firstMin < words.length && !opensFooter(lead + joined(0, firstMin))) firstMin += 1;
  }
  const out: string[] = [];
  let prefix = lead;
  let start = 0;
  while (start < words.length) {
    let end = start + 1;
    let length = prefix.length + (words[start] ?? "").length;
    while (end < words.length && length + (gaps[end - 1] ?? "").length + (words[end] ?? "").length <= width) {
      length += (gaps[end - 1] ?? "").length + (words[end] ?? "").length;
      end += 1;
    }
    const floor = start === 0 ? firstMin : start + 1;
    if (end < floor) end = floor;
    if (unsafeAt(end)) {
      let earlier = end - 1;
      while (earlier >= floor && unsafeAt(earlier)) earlier -= 1;
      if (earlier >= floor) end = earlier;
      else {
        let later = end + 1;
        while (unsafeAt(later)) later += 1;
        end = later;
      }
    }
    out.push(prefix + joined(start, end));
    prefix = hang;
    start = end;
  }
  return out;
}

/** Why `line` is over `width` after wrapLine has done what it can, or null when wrapLine brings it under. */
export function unwrappable(line: string, width: number): Unwrapped | null {
  if (PREFORMATTED.test(line)) return "preformatted";
  const pieces = wrapLine(line, Math.floor(width));
  const over = pieces.filter((piece): boolean => !lineFits(piece, width));
  if (over.length === 0) return null;
  return over.some((piece): boolean => pieceWhy(piece, width) === "unbroken") ? "unbroken" : "unsafe";
}

/** A line the wrap left over its width, with its 0-based index in the wrapped text. */
export interface LeftOver {
  readonly index: number;
  readonly text: string;
  readonly section: Section;
  readonly why: Unwrapped;
}

/** A line of the input the wrap rewrote: its 0-based index in the input, its length, and the section whose width it was held to. */
export interface Rewrapped {
  readonly index: number;
  readonly length: number;
  readonly section: Section;
}

export interface WrappedBody {
  /** The body, rewrapped -- or the input itself, the same string, when no line needed it. */
  readonly text: string;
  /** The input's lines the wrap rewrote. */
  readonly rewrapped: readonly Rewrapped[];
  /** Lines still over their section's width after the wrap: preformatted, a word longer than the width, or no safe break. */
  readonly leftOver: readonly LeftOver[];
}

/** Each line of `text` with the terminator that ended it ("" for the last). */
function linesOf(text: string): { readonly text: string; readonly eol: string }[] {
  const out: { text: string; eol: string }[] = [];
  // Lazy up to the first LF (with its CR, if any) or the end: a bare CR
  // stays inside its line, as commitlint's /\r?\n/ split leaves it.
  const pattern = /([^\n]*?)(\r?\n|$)/g;
  for (;;) {
    const match = pattern.exec(text);
    /* c8 ignore next -- the pattern matches the empty string at the end, so it never fails */
    if (match === null) break;
    out.push({ text: match[1] ?? "", eol: match[2] ?? "" });
    if ((match[2] ?? "") === "") break;
  }
  return out;
}

/** The section each line parses into, as commitlint's parser assigns it; null for a line it never sees. */
function sectionsOf(lines: readonly string[]): readonly (Section | null)[] {
  let section: Section = "body";
  return lines.map((line): Section | null => {
    if (unseen(line)) return null;
    if (section === "body" && opensFooter(line)) section = "footer";
    return section;
  });
}

/**
 * Why a line the wrap left over `width` is so: preformatted; "unbroken" when
 * it holds a word longer than the width -- that word is the overflow, even
 * on a line that opens the footer, whose token must keep the word after it
 * (#290's review, F4); otherwise "unsafe", no break keeping the reading.
 */
function pieceWhy(line: string, width: number): Unwrapped {
  if (PREFORMATTED.test(line)) return "preformatted";
  const { lead, words } = tokenize(line);
  if (words.length < 2) return "unbroken";
  return words.some((word, index): boolean => (index === 0 ? lead.length : 0) + word.length > width) ? "unbroken" : "unsafe";
}

/**
 * `body` -- the text between the header and the trailer block -- with every
 * line commitlint would refuse wrapped to its section's `widths`; a section
 * whose width is null is never wrapped (its rule is off, or states a width
 * no wrap can meet). The sections are found as commitlint finds them (a
 * footer token or note opens the footer for the rest of the text), since a
 * --body can hold both -- and every line of the result is MEASURED AGAIN
 * under the section it parses into, so what is reported left over is what
 * commitlint would refuse.
 *
 * WHAT IT CHANGES, AND NOTHING ELSE: on a rewrapped line, the whitespace at
 * each break becomes the line's own terminator (CRLF stays CRLF) and the hang
 * indent, and trailing whitespace is dropped -- git's own cleanup drops it on
 * commit anyway. Every other byte of the input, on every line, is kept.
 */
export function wrapBody(body: string, widths: Readonly<Record<Section, number | null>>): WrappedBody {
  const lines = linesOf(body);
  const sections = sectionsOf(lines.map((line): string => line.text));
  const needs = lines.map((line, index): Section | null => {
    const section = sections[index] ?? null;
    if (section === null) return null;
    const width = widths[section];
    return width === null || lineFits(line.text, width) ? null : section;
  });
  if (needs.every((need): boolean => need === null)) return { text: body, rewrapped: [], leftOver: [] };
  const out: { text: string; eol: string }[] = [];
  const rewrapped: Rewrapped[] = [];
  let lastEol = "\n";
  lines.forEach((line, index): void => {
    if (line.eol !== "") lastEol = line.eol;
    const need = needs[index] ?? null;
    const width = need === null ? null : widths[need];
    if (need === null || width === null || width === undefined) {
      out.push(line);
      return;
    }
    const pieces = wrapLine(line.text, Math.floor(width));
    if (pieces.length > 1 || pieces[0] !== line.text) rewrapped.push({ index, length: line.text.length, section: need });
    const between = line.eol === "" ? lastEol : line.eol;
    pieces.forEach((piece, at): void => {
      out.push({ text: piece, eol: at === pieces.length - 1 ? line.eol : between });
    });
  });
  const leftOver: LeftOver[] = [];
  const outSections = sectionsOf(out.map((line): string => line.text));
  out.forEach((line, index): void => {
    const section = outSections[index] ?? null;
    if (section === null) return;
    const width = widths[section];
    if (width !== null && !lineFits(line.text, width)) leftOver.push({ index, text: line.text, section, why: pieceWhy(line.text, width) });
  });
  return { text: out.map((line): string => line.text + line.eol).join(""), rewrapped, leftOver };
}
