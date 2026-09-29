// src/surface/links.ts -- a mirrored body's RELATIVE LINKS, re-aimed for the
// directory its copy lands in (zheref/nen#270).
//
// THE DEFECT THIS EXISTS FOR. ./mirror.ts carries a skill's or a persona's body
// into another surface's layout -- a flat `<name>/SKILL.md`, a nested
// `skills/<name>/SKILL.md`, an `agents/<stem>.md` at another depth than its
// source, an `AGENTS.md` at the mirror's root, a string inside a TOML file --
// and a relative link is a statement about WHERE ITS FILE IS. Copied verbatim to
// another depth the same text names another file, usually none: the first
// consumer's own link guard counted 404 of 2644 relative links dangling across
// its three mirrors. A dangling link raises nothing; an agent following one on
// a cold session reads nothing and proceeds.
//
// THE RULE, IN ONE SENTENCE. Resolve the link against the SOURCE file's own
// directory; when what it names is itself a mirrored item (a skill's SKILL.md
// or its directory, a persona, a shared include, the rules file) point it at
// that item's MIRROR location; otherwise point it at the same file on disk --
// either way relative to the DESTINATION file's directory, with the fragment
// kept. On a row whose personas are prose (the appendix), a persona's mirror
// location is its own section of that one document, so a link to it becomes
// `AGENTS.md#<heading anchor>` (a bare `#<anchor>` from inside that document),
// and a fragment the source link already carried is kept in its place.
//
// THE TREE A REWRITTEN LINK MAY REACH. A link out of the mirror names every
// directory between the mirror and its target, and that is only honest inside
// one tree: `--repo <path>`, else the working directory -- the base every verb
// in this binary takes (../repo/root.ts, which deliberately never walks up
// looking for `.git`). When the target or the destination is OUTSIDE it -- a
// mirror generated straight into an installed surface (`~/.codex`, another
// repository's `.cursor/`) -- the rewritten link would spell this machine's
// layout above both, true here and nowhere else. So that link is LEFT AS
// WRITTEN and named in the report (`linksVerbatim`), never re-aimed at a path
// nen made up. A link to a mirrored item is never in that set: its target
// moves with the mirror, so the path between them stays inside `--out`
// wherever `--out` is.
//
// EVERY END IS A REAL PATH. The root, the sources and `--out` are each resolved
// through every symlink first (../repo/contain.ts's `realContainment`, which
// also answers for an `--out` that does not exist yet). So a mirror installed
// as a symlink to the committed one -- a plugin directory pointing at the
// repository's own mirror -- regenerates to the same bytes the committed one
// holds, and `/tmp` against `/private/tmp` is not a difference.
//
// WHAT IS A LINK. The three CommonMark forms the first consumer's guard reads:
// the inline `[label](target)` (an image's too, and an image inside a link's
// label), with its angle-bracketed `](<target>)` and titled
// `](target "title")` variants, and the reference definition
// `[label]: target`. An inline link inside a FENCED block is still read -- a
// reader copies a path out of a fence, and a copied dangling path dangles the
// same -- but a reference definition there is not (a fence is code, and
// `[warn]: deprecated` in it is a log line, not a definition), and nothing
// inside an INLINE CODE SPAN is read at all, which is what a renderer does too.
//
// CODE THAT ONLY LOOKS LIKE A LINK (Nobunaga, the #270 review). Inside a fence
// the inline shape matches every call through an index -- `handlers[name](event)`,
// `xs[0](value)` -- and re-aiming `event` as a path would corrupt the sample
// while `check` called the corruption OK. So a `[` that sits directly after a
// word character, a `]`, a `)` or a backslash does not open a link: that is
// code, or an escaped bracket. A real link written flush against a word
// (`foo[bar](baz)`, which CommonMark does render) is carried as written -- the
// rarer of the two, and the one whose cost is a link left alone rather than
// a sample rewritten.
//
// WHAT IS NOT REWRITTEN, AND WHY. An absolute path, any `scheme:` target
// (`http(s):`, `mailto:`), a bare `#fragment` and a `~`-rooted path do not
// depend on where the file sits. An HTML `href`/`src` attribute and a path
// written as prose are not markdown links, and nothing here guesses which
// prose is a path. A footnote definition (`[^n]: text`) is not a link
// definition. A target carrying a character no portable path spelling uses --
// whitespace (outside `<...>`), `[ ] { } ^ * | $ < > " '`, a backtick or a
// backslash -- is a regex or a template placeholder inside an example, not a
// path; and a "target" followed by anything but a title (`](a b)`) is not a
// link at all. Each is carried exactly as written.
//
// DESTINATIONS AND TITLES ARE READ BY COMMONMARK'S RULES, NOT A PATTERN
// (Cursor Bugbot on #285). A bare destination may hold BALANCED parentheses
// (`a(b).md`), a `<...>` one anything but `<`, `>` or a line break
// (`<a (b).md>`), and a title -- `"..."`, `'...'` or `(...)` -- parentheses of
// its own. A `[^)]*` capture stopped at the first `)` of any of them and the
// link never reached the rewrite; unbalanced parentheses are still not a
// link, and are carried as written.
//
// THE CODE-SPAN RULE IS COMMONMARK'S BACKTICK-STRING RULE: a run of N
// backticks opens a span only when a run of exactly N closes it within the
// same paragraph, a backslash-escaped backtick opens nothing, and inside a
// fence backticks are literal. Not modelled, and stated rather than hidden:
// raw HTML or an autolink that CommonMark would let win over a backtick
// (`<a title="`">`), and an indented (four-space) code block, which reads as
// prose here.
//
// PATH ARITHMETIC ONLY. Whether the target EXISTS is never asked. A generation
// that read arbitrary files outside its inputs would change when one of them
// was deleted, and `check` would then report drift against a source nobody
// touched; a link that dangles in the source dangles the same way in the
// mirror, re-aimed at the same missing file, which is the source's defect to
// fix and a link guard's to find.

import { dirname, join, parse, posix, relative, resolve, sep } from "node:path";
import { isContained, realContainment } from "../repo/contain.js";

/**
 * Where the caller's inputs and `--out` sit. ./mirror.ts reads these as REAL
 * absolute paths, which is what `resolveLinkOptions` hands back for the paths
 * the caller typed.
 */
export interface LinkOptions {
  /** The tree a rewritten link may reach: `--repo`, else the working directory. */
  readonly root: string;
  /** `--source`, the directory whose subdirectories are the skills. */
  readonly sourceDir: string;
  /** `--agents`, or null when no personas were given. */
  readonly agentsDir: string | null;
  /** `--rules`, or null when no rules file was given. */
  readonly rulesFile: string | null;
  /** `--out` (or `--installed`): where the mirror is, or is about to be. */
  readonly outDir: string;
}

/** The path the kernel would reach for `path`, symlinks resolved, whether or not it exists yet. */
function realPath(path: string): string {
  const absolute = resolve(path);
  return realContainment(parse(absolute).root, absolute).real;
}

/** The same five places as the caller typed them, each resolved to the real path `realPath` names. */
export function resolveLinkOptions(typed: LinkOptions): LinkOptions {
  return {
    root: realPath(typed.root),
    sourceDir: realPath(typed.sourceDir),
    agentsDir: typed.agentsDir === null ? null : realPath(typed.agentsDir),
    rulesFile: typed.rulesFile === null ? null : realPath(typed.rulesFile),
    outDir: realPath(typed.outDir),
  };
}

/** Where a mirrored item lands: a path under `--out`, and the anchor that finds it inside a shared document. */
export interface MirrorLocation {
  /** Relative to `--out`, `/`-separated. */
  readonly path: string;
  /** The heading anchor of the item's section, where it shares a document with others; else null. */
  readonly fragment: string | null;
}

export interface LinkContext {
  /** Real, absolute. */
  readonly root: string;
  /** Real, absolute. */
  readonly outDir: string;
  /** Every mirrored item, keyed by the real absolute path of its SOURCE (a file, or a skill's directory). */
  readonly items: ReadonlyMap<string, MirrorLocation>;
}

/**
 * The anchor a markdown renderer gives a heading: lowercased, every character
 * that is not a letter, a mark, a digit, a connector (`_`), a space or a hyphen
 * dropped, and each space made a hyphen -- GitHub's slug, which is what a
 * reader clicking the link in a rendered mirror meets. A heading repeated
 * earlier in the same document gets a `-1` suffix there that this does not
 * compute; the appendix's persona headings are the persona names, which a
 * repository keeps unique.
 */
export function headingAnchor(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
}

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;
/**
 * A bare target carrying one of these is not a path (see the header).
 * Parentheses are NOT on the list: CommonMark lets a bare destination hold
 * balanced ones (`a(b).md`), and the reader below only hands over a
 * destination whose parentheses balance.
 */
const NOT_A_PATH = /[\s[\]{}^*|$<>"'`\\]/;
/** Inside `<...>` whitespace and parentheses are legal path characters. */
const NOT_A_BRACKETED_PATH = /[[\]{}^*|$<>"'`\\\n]/;
/**
 * What may follow a reference definition's target and still leave one:
 * nothing, or a title -- `"..."`, `'...'` or `(...)`, a backslash escaping its
 * own delimiter, parentheses free inside the quoted two.
 */
const TITLE = /^(?:\s+(?:"(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|\((?:[^()\\\n]|\\.)*\)))?\s*$/;
/** A bare destination ends at whitespace or an ASCII control character. */
const DESTINATION_END = /[\s\u0000-\u001f\u007f]/;
/** CommonMark's nesting limit for balanced parentheses in a bare destination. */
const MAX_PAREN_DEPTH = 32;
/** A label character: anything but a bracket, a newline only where it does not end the paragraph. */
const LABEL_CHAR = String.raw`(?:[^\[\]\n]|\n(?![ \t\r]*(?:\n|$)))`;
/**
 * The OPENING of the inline form, `[label](`. The label may wrap lines and
 * hold one level of nested brackets (`[![img](a.png)](b.md)`,
 * `` [`code`](x) ``). The lookbehind is the header's CODE THAT ONLY LOOKS LIKE
 * A LINK rule. What follows the `(` -- destination, title, closing `)` -- is
 * read by `readInside`, not by a pattern: a destination may hold balanced
 * parentheses and a title parentheses of its own (Cursor Bugbot on #285), and
 * a `[^)]*` stops at the first of either, leaving the link at its source
 * spelling to dangle at the copy's depth.
 */
const INLINE_OPEN = String.raw`(?<![\w\])\\])\[((?:${LABEL_CHAR}|\[${LABEL_CHAR}*\])*)\]\(`;
/** The reference definition; a label starting `^` is a footnote and is not matched. */
const DEFINITION = /^([ \t]*\[(?!\^)[^\]\n]+\]:[ \t]*)(<[^>\n]*>|[^\s<>]+)([^\n]*)$/gm;
/** A fence's opening or closing line: three or more backticks or tildes, indented or not. */
const FENCE = /^[ \t]*(`{3,}|~{3,})(.*)$/;

/** Decides a link target's replacement: the new target, or null to carry it as written. */
type Aim = (raw: string, bracketed: boolean) => string | null;

/** A slice of a document, and whether it is inside a fenced code block. */
interface Segment {
  readonly text: string;
  readonly fenced: boolean;
}

/**
 * `text` cut at its fences, each fence line going with the block it opens or
 * closes. An unclosed fence runs to the end, as CommonMark reads it; a
 * backtick fence whose info string holds a backtick is not a fence.
 */
function segments(text: string): readonly Segment[] {
  const found: Segment[] = [];
  let current = "";
  let fence: { char: string; length: number } | null = null;
  const flush = (fenced: boolean): void => {
    if (current !== "") found.push({ text: current, fenced });
    current = "";
  };
  for (const line of text.split(/(?<=\n)/)) {
    const bare = line.replace(/\r?\n$/, "");
    const marker = FENCE.exec(bare);
    const run = marker?.[1] ?? "";
    if (fence === null) {
      if (marker !== null && !(run.startsWith("`") && (marker[2] ?? "").includes("`"))) {
        flush(false);
        fence = { char: run.charAt(0), length: run.length };
      }
      current += line;
      continue;
    }
    current += line;
    if (marker !== null && (marker[2] ?? "").trim() === "" && run.charAt(0) === fence.char && run.length >= fence.length) {
      flush(true);
      fence = null;
    }
  }
  flush(fence !== null);
  return found;
}

/** A line holding nothing but whitespace, read from where `lastIndex` points. */
const BLANK_LINE = /[ \t]*(?:\r?\n|$)/y;

/** The `[start, end)` ranges of the inline code spans in `text`, which holds no fence (see the header). */
function codeSpans(text: string): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  const runAt = (at: number): number => {
    let length = 0;
    while (text.charAt(at + length) === "`") length += 1;
    return length;
  };
  let at = 0;
  while (at < text.length) {
    const char = text.charAt(at);
    if (char === "\\") {
      at += 2;
      continue;
    }
    if (char !== "`") {
      at += 1;
      continue;
    }
    const length = runAt(at);
    let scan = at + length;
    let close = -1;
    while (scan < text.length) {
      if (text.charAt(scan) === "`") {
        const other = runAt(scan);
        if (other === length) {
          close = scan;
          break;
        }
        scan += other;
        continue;
      }
      // A blank line ends the paragraph, and a span never crosses one.
      if (text.charAt(scan) === "\n") {
        BLANK_LINE.lastIndex = scan + 1;
        if (BLANK_LINE.test(text)) break;
      }
      scan += 1;
    }
    if (close < 0) {
      at += length;
      continue;
    }
    spans.push([at, close + length]);
    at = close + length;
  }
  return spans;
}

function within(spans: readonly (readonly [number, number])[], at: number): boolean {
  return spans.some(([start, end]): boolean => at >= start && at < end);
}

/** An inline link's inside, read from just after its `(`. */
interface Inside {
  /** Whitespace before the destination, kept as written. */
  readonly lead: string;
  /** The destination, without its `<...>`. */
  readonly raw: string;
  readonly bracketed: boolean;
  /** Everything between the destination and the closing `)` -- whitespace and a title -- kept as written. */
  readonly tail: string;
  /** The index just past the closing `)`. */
  readonly end: number;
}

/** True for a space or a tab -- the only whitespace an inside may hold, since it never spans a line. */
function blank(char: string): boolean {
  return char === " " || char === "\t";
}

/**
 * The inside of an inline link that opened just before `start`, read by
 * CommonMark's rules, or null when what follows the `(` is not one:
 *
 * - a DESTINATION: `<...>` holding anything but `<`, `>` or a line break (a
 *   backslash escaping the next character), or a bare run with no whitespace
 *   or control character whose unescaped parentheses BALANCE, nested at most
 *   32 deep; an empty one is allowed;
 * - then, after at least one space or tab, an optional TITLE: `"..."` or
 *   `'...'`, which may hold parentheses, or `(...)`, which may not hold an
 *   unescaped `(`; a backslash escapes the next character in all three;
 * - then optional spaces or tabs, and the closing `)`.
 *
 * Deliberately ONE LINE: CommonMark lets a line break stand between the
 * destination and the title, and lets a title wrap, but the consumer guard
 * this rewrite answers to reads links a line at a time, and a link it cannot
 * read is one neither side can check.
 */
function readInside(text: string, start: number): Inside | null {
  let at = start;
  while (blank(text.charAt(at))) at += 1;
  const lead = text.slice(start, at);
  let raw: string;
  let bracketed = false;
  if (text.charAt(at) === "<") {
    let scan = at + 1;
    while (scan < text.length && text.charAt(scan) !== ">") {
      const char = text.charAt(scan);
      if (char === "<" || char === "\n") return null;
      scan += char === "\\" ? 2 : 1;
    }
    if (text.charAt(scan) !== ">") return null;
    raw = text.slice(at + 1, scan);
    bracketed = true;
    at = scan + 1;
  } else {
    let scan = at;
    let depth = 0;
    while (scan < text.length) {
      const char = text.charAt(scan);
      if (char === "\\") {
        scan += 2;
        continue;
      }
      if (DESTINATION_END.test(char)) break;
      if (char === "(") {
        depth += 1;
        if (depth > MAX_PAREN_DEPTH) return null;
      } else if (char === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      scan += 1;
    }
    if (depth !== 0) return null;
    raw = text.slice(at, scan);
    at = scan;
  }
  const destinationEnd = at;
  while (blank(text.charAt(at))) at += 1;
  const open = text.charAt(at);
  if (at > destinationEnd && (open === '"' || open === "'" || open === "(")) {
    const close = open === "(" ? ")" : open;
    let scan = at + 1;
    while (scan < text.length && text.charAt(scan) !== close) {
      const char = text.charAt(scan);
      if (char === "\n" || (open === "(" && char === "(")) return null;
      scan += char === "\\" ? 2 : 1;
    }
    if (text.charAt(scan) !== close) return null;
    at = scan + 1;
    while (blank(text.charAt(at))) at += 1;
  }
  if (text.charAt(at) !== ")") return null;
  return { lead, raw, bracketed, tail: text.slice(destinationEnd, at), end: at + 1 };
}

/** True when `token`'s unescaped parentheses balance -- a reference definition's bare destination obeys the inline rule. */
function balanced(token: string): boolean {
  let depth = 0;
  for (let at = 0; at < token.length; at += 1) {
    const char = token.charAt(at);
    if (char === "\\") at += 1;
    else if (char === "(") depth += 1;
    else if (char === ")" && --depth < 0) return false;
  }
  return depth === 0;
}

/** A replaced target in the form it came in; a bare one that now holds whitespace is bracketed, or it would stop being a link. */
function spell(aimed: string, bracketed: boolean): string {
  return bracketed || /\s/.test(aimed) ? `<${aimed}>` : aimed;
}

/** Every inline link in `text`, its target through `aim` and its label read the same way (an image inside a link). */
function inlineLinks(text: string, aim: Aim, readSpans: boolean): string {
  const spans = readSpans ? codeSpans(text) : [];
  // A fresh pattern per call: the label recursion below re-enters this
  // function, and a shared global pattern's lastIndex would be clobbered.
  const opener = new RegExp(INLINE_OPEN, "g");
  let result = "";
  let copied = 0;
  for (let match = opener.exec(text); match !== null; match = opener.exec(text)) {
    const start = match.index;
    const label = match[1] ?? "";
    // Both the `[` and the `](` must be outside every code span: a link
    // written inside one is code, and so is a span that swallows the `](`.
    const inside = within(spans, start) || within(spans, start + 1 + label.length) ? null : readInside(text, start + match[0].length);
    if (inside === null) {
      // Not a link from this `[`; one may still open inside its label (an
      // image in a link whose own destination is not one).
      opener.lastIndex = start + 1;
      continue;
    }
    const relabelled = inlineLinks(label, aim, readSpans);
    const aimed = aim(inside.raw, inside.bracketed);
    const destination =
      aimed === null ? text.slice(start + match[0].length + inside.lead.length, inside.end - 1 - inside.tail.length) : spell(aimed, inside.bracketed);
    result += `${text.slice(copied, start)}[${relabelled}](${inside.lead}${destination}${inside.tail})`;
    copied = inside.end;
    opener.lastIndex = inside.end;
  }
  return result + text.slice(copied);
}

/** Every reference definition in `text` (no fence in it) that does not start inside a code span. */
function definitions(text: string, aim: Aim): string {
  const spans = codeSpans(text);
  return text.replace(DEFINITION, (whole: string, prefix: string, token: string, tail: string, offset: number): string => {
    if (within(spans, offset) || !TITLE.test(tail)) return whole;
    const bracketed = token.startsWith("<");
    if (!bracketed && !balanced(token)) return whole;
    const aimed = aim(bracketed ? token.slice(1, -1) : token, bracketed);
    return aimed === null ? whole : `${prefix}${spell(aimed, bracketed)}${tail}`;
  });
}

/**
 * `text` with every link target `aim` answers for replaced, and every other
 * byte as it was. The ONE reading of "what is a link" in this module: the
 * rewrite and `check`'s relocated comparison (`maskLinksOutOfMirror`) both go
 * through it, so the two can never disagree about which text is a link.
 */
export function mapLinkTargets(text: string, aim: Aim): string {
  return segments(text)
    .map((segment): string => (segment.fenced ? inlineLinks(segment.text, aim, false) : definitions(inlineLinks(segment.text, aim, true), aim)))
    .join("");
}

/** A target's path and its `#fragment`/`?query` tail, or null when it is not a relative path (see the header). */
function relativeTarget(raw: string, bracketed: boolean): { pathPart: string; suffix: string } | null {
  if (raw === "" || raw.startsWith("#") || raw.startsWith("/") || raw.startsWith("~") || SCHEME.test(raw)) return null;
  const cut = raw.search(/[#?]/);
  const pathPart = cut < 0 ? raw : raw.slice(0, cut);
  if (pathPart === "" || (bracketed ? NOT_A_BRACKETED_PATH : NOT_A_PATH).test(pathPart)) return null;
  return { pathPart, suffix: cut < 0 ? "" : raw.slice(cut) };
}

/** What a link out of the mirror reads as under `maskLinksOutOfMirror`: no path spelling holds a NUL. */
const OUT_OF_MIRROR = "\u0000";

/**
 * Every path a link may land on INSIDE a mirror whose generated files are
 * `paths`: each file, each directory holding one, and the mirror's root (`.`).
 */
export function mirrorPathsOf(paths: readonly string[]): ReadonlySet<string> {
  const found = new Set<string>(["."]);
  for (const path of paths) {
    for (let at = path; at !== "." && at !== ""; at = posix.dirname(at)) found.add(at);
  }
  return found;
}

/**
 * `text` (a generated file at `destination`) with the target of every
 * relative link that LEAVES the mirror replaced by one placeholder, and every
 * link that lands inside it (on a file or directory `mirrorPaths` names) kept.
 *
 * WHY `check` NEEDS IT (Nobunaga, the #270 review). A link inside the mirror
 * reads the same wherever the mirror sits; a link out of it is spelled for
 * the place the mirror was GENERATED, and a copy moved elsewhere -- a copied
 * install, or a check run from another root than the generate -- carries the
 * old spelling. Two files equal under this mask are the same generation,
 * aimed from another location: stale, not hand-edited.
 */
export function maskLinksOutOfMirror(text: string, destination: string, mirrorPaths: ReadonlySet<string>): string {
  return mapLinkTargets(text, (raw: string, bracketed: boolean): string | null => {
    const target = relativeTarget(raw, bracketed);
    if (target === null) return null;
    const landed = posix.normalize(posix.join(posix.dirname(destination), target.pathPart)).replace(/\/+$/, "");
    return mirrorPaths.has(landed === "" ? "." : landed) ? null : OUT_OF_MIRROR;
  });
}

/** `relative`'s answer with `/` separators on every platform. */
function slashed(path: string): string {
  return sep === "/" ? path : path.split(sep).join("/");
}

/**
 * Re-aims the relative links of the text it is handed, counting what it
 * changed and remembering what it declined to, across every file of one
 * generation.
 */
export class LinkRewriter {
  private count = 0;
  private readonly declined = new Set<string>();

  constructor(private readonly context: LinkContext) {}

  /** Links re-aimed so far. */
  get rewritten(): number {
    return this.count;
  }

  /** `<destination>: <target>` for every relative link left as written because it would have left the tree, sorted. */
  get verbatim(): readonly string[] {
    return [...this.declined].sort();
  }

  /**
   * `text`, read from the source file at `sourceFile` (real, absolute), with
   * every relative link re-aimed for `destination` (a `/`-separated path under
   * `--out`).
   */
  rewrite(text: string, sourceFile: string, destination: string): string {
    return mapLinkTargets(text, (raw: string, bracketed: boolean): string | null => this.aim(raw, bracketed, sourceFile, destination));
  }

  /** The target re-aimed for `destination`, or null to carry it exactly as written. */
  private aim(raw: string, bracketed: boolean, sourceFile: string, destination: string): string | null {
    const relativeLink = relativeTarget(raw, bracketed);
    if (relativeLink === null) return null;
    const pathPart = relativeLink.pathPart;
    let suffix = relativeLink.suffix;

    const target = resolve(dirname(sourceFile), pathPart);
    const destinationFile = join(this.context.outDir, ...destination.split("/"));
    const item = this.context.items.get(target);
    let path: string;
    if (item !== undefined) {
      if (item.fragment !== null && suffix === "") suffix = `#${item.fragment}`;
      // The item shares THIS document (a persona linking a sibling inside the
      // appendix): the anchor alone is the link.
      if (item.path === destination && suffix.startsWith("#")) return this.changed(raw, suffix);
      path = relative(dirname(destinationFile), join(this.context.outDir, ...item.path.split("/")));
    } else {
      if (!isContained(this.context.root, target) || !isContained(this.context.root, destinationFile)) {
        this.declined.add(`${destination}: ${raw}`);
        return null;
      }
      path = relative(dirname(destinationFile), target);
    }
    let aimed = slashed(path);
    if (aimed === "") aimed = ".";
    if (pathPart.endsWith("/") && !aimed.endsWith("/")) aimed = `${aimed}/`;
    return this.changed(raw, `${aimed}${suffix}`);
  }

  /** `aimed`, counted -- or null when it is what was written already. */
  private changed(raw: string, aimed: string): string | null {
    if (aimed === raw) return null;
    this.count += 1;
    return aimed;
  }
}
