// src/canon/mirror.ts -- render a stack's canonical rule set into every agent
// surface a consumer declares, and diff a committed mirror against a fresh
// rendering. The engine under `nen canon mirror generate|check` (CON-13).
//
// WHAT CON-13 ASKS FOR, in one sentence: a consumer repository authors no canon
// of its own, but carries a GENERATED, PINNED mirror of its stack's rule set in
// the rules location of EVERY agent surface it uses, rendered from a tag of the
// canonical handbooks repository with the consumer's `canon-values` bound into
// each `{{TOKEN}}`, and a drift check that fails when a mirror file is edited
// by hand or lags its pin. This module is the rendering and the check; the
// verb (./command.ts) is the argument handling around it.
//
// PROVENANCE. The first shape of this module was a port of the reference
// implementation's `scripts/sync_canon.py`, which rendered ONE directory (a
// Claude-Code-only rules directory) with a caller-supplied header template.
// Four of its decisions are carried whole, each with the reason its author
// recorded, because a port that drops a WHY is a port whose next maintainer
// "simplifies" it back into the bug:
//
//   1. An unbound `{{TOKEN}}` is a REFUSAL naming the file and the token,
//      never an empty substitution -- a rule rendered with a hole in it reads
//      as a rule about nothing.
//   2. Only files whose bytes changed are written, so a regenerate that changed
//      nothing leaves a clean working tree.
//   3. An orphaned mirror file (its canon source removed upstream) is deleted
//      by `generate` and reported by `check`, so the mirror is a self-healing
//      image of canon rather than a superset of it.
//   4. The generated header is read from the FIRST line only, so a
//      header-shaped line further down (a quoted example, a nested fence)
//      is never mistaken for the real one -- the stale/hand-edited
//      distinction depends on it.
//
// WHAT CHANGED, AND WHY. The surface set is DATA: every location, extension,
// frontmatter, size limit and caveat comes from ../surface/rules.ts's
// `canonMirror` block, so a surface added later is a row there and no branch
// here. The header is no longer caller-supplied: with four surfaces, three
// frontmatter shapes and a block-in-a-document form, a template and a
// read-back regex the caller had to keep in agreement was the fragile pair
// the surface mirror (../surface/mirror.ts) already retired -- so, like it,
// this module writes its OWN marker and reads its own marker back. The
// marker carries the pin (`<source>@<ref>`), the scenario and the canon
// file, all of them caller data; nothing in the marker is a name this binary
// chose (§3).
//
// THE COLLISION RULE: THE MARKER IS THE OWNERSHIP CLAIM. nen owns exactly the
// files that carry its marker, and nothing else.
//
//   * A destination that exists and carries NO marker was written by somebody
//     else. `generate` REFUSES -- before writing anything, for every surface --
//     rather than overwrite it, and names the file: the consumer moves or
//     renames its own rule, or drops it in favour of the canon one. "It
//     refused, but only after overwriting two of your files" is not a refusal.
//   * A file in a mirror directory with no canon source and no marker is the
//     consumer's own (CON-13 leaves repo-specific, non-canon config to the
//     consumer). It is FOREIGN: never deleted, never drift, listed so the
//     report says what it saw.
//   * A file with a marker and no canon source is an ORPHAN: canon removed or
//     renamed it upstream. `generate` deletes it; `check` reports it as extra.
//   * A `document` surface's file (an `AGENTS.md`) is shared by design: the
//     consumer writes its project-specifics prose there and nen owns only
//     the block between its BEGIN and END markers. Everything outside is
//     preserved byte for byte; a file with no block gets one appended; a file
//     whose block has lost its END marker is refused, because nen cannot tell
//     where the hand-written prose resumes.
//
// LINE ENDINGS ARE NORMALISED TO LF on both sides. The mirror is a build
// artifact whose bytes `check` compares across machines, and the canon
// checkout on a Windows host arrives CRLF while CI's is LF; a mirror that
// read as hand-edited for having been generated on the other platform would
// be a drift check nobody trusts. The consumer's own `.gitattributes` decides
// how the file is checked out; this module decides only what it compares.

import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { splitDocument } from "../surface/frontmatter.js";
import { canonLocation, type CanonMirrorRule, type SurfaceRow } from "../surface/rules.js";

/** A refusal this module raises; the command layer turns it into exit 2. */
export class CanonMirrorError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CanonMirrorError";
  }
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;

export class MissingTokenError extends CanonMirrorError {
  readonly filename: string;
  readonly token: string;
  constructor(filename: string, token: string) {
    super(
      `${filename}: {{${token}}} has no canon-values binding. Bind it under 'values:' in the canon-values file; a rule rendered with a hole in it is a rule about nothing.`,
    );
    this.name = "MissingTokenError";
    this.filename = filename;
    this.token = token;
  }
}

const normalizeEol = (text: string): string => text.replace(/\r\n/g, "\n");

// ---------------------------------------------------------------------------
// The canon-values file
// ---------------------------------------------------------------------------

export interface CanonValues {
  readonly scenario: string | null;
  /**
   * The surfaces this consumer renders its mirror into, from a top-level
   * `surfaces:` key -- an inline comma list or a `- name` block list -- or null
   * when the file states none. The CONSUMER's declaration: which surfaces a
   * repository is used with is a fact about that repository, never a default
   * this binary picks.
   */
  readonly surfaces: readonly string[] | null;
  readonly values: Readonly<Record<string, string>>;
}

const unquote = (value: string): string => {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed[0] === trimmed.at(-1) && (trimmed[0] === '"' || trimmed[0] === "'")) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
};

/**
 * A minimal, dependency-free reader for the canon-values schema: an optional
 * top-level `scenario:` key, an optional top-level `surfaces:` key (inline
 * `a, b` or a `- a` block), then a `values:` block of flat, one-per-line
 * `TOKEN: literal value` pairs indented under it. No other nesting.
 */
export function parseCanonValues(text: string): CanonValues {
  const values: Record<string, string> = {};
  let scenario: string | null = null;
  let surfaces: string[] | null = null;
  let inValues = false;
  let inSurfaces = false;

  for (const raw of normalizeEol(text).split("\n")) {
    const line = raw.split(" #")[0]?.replace(/\s+$/, "") ?? "";
    if (line.trim() === "" || line.trim().startsWith("#")) continue;
    if (!/^\s/.test(raw)) {
      const trimmed = line.trim().replace(/:$/, "");
      inValues = trimmed === "values";
      inSurfaces = false;
      const scenarioMatch = /^scenario:\s*(\S+)\s*$/.exec(line);
      if (scenarioMatch?.[1] !== undefined) scenario = scenarioMatch[1];
      const surfacesMatch = /^surfaces:\s*(.*)$/.exec(line);
      if (surfacesMatch !== null) {
        const inline = (surfacesMatch[1] ?? "").trim().replace(/^\[/, "").replace(/\]$/, "");
        surfaces = inline
          .split(",")
          .map(unquote)
          .filter((item): boolean => item !== "");
        inSurfaces = inline === "";
      }
      continue;
    }
    if (inSurfaces) {
      const item = /^\s*-\s*(.+)$/.exec(line);
      if (item?.[1] !== undefined && surfaces !== null) surfaces.push(unquote(item[1]));
      continue;
    }
    if (!inValues) continue;
    const match = /^\s*([A-Z0-9_]+):\s*(.*)$/.exec(line);
    if (match === null || match[1] === undefined) continue;
    values[match[1]] = unquote(match[2] ?? "");
  }
  return { scenario, surfaces, values };
}

// ---------------------------------------------------------------------------
// The pin and the markers
// ---------------------------------------------------------------------------

/** What every mirror file says it was generated from. All three are caller data. */
export interface CanonPin {
  /** The canonical repository, `owner/name`. */
  readonly source: string;
  /** The tag of that repository the mirror is rendered from. */
  readonly ref: string;
  readonly scenario: string;
}

const TEXT_PREFIX = "GENERATED by nen canon mirror from ";
const FILE_SUFFIX = " -- do not edit; change the canon and regenerate";
const BLOCK_BEGIN_PREFIX = "BEGIN GENERATED by nen canon mirror from ";
const BLOCK_BEGIN_SUFFIX = " -- do not edit between the markers; change the canon and regenerate";
export const BLOCK_END = "<!-- END GENERATED by nen canon mirror -->";
const SECTION_PREFIX = "<!-- canon: ";
const SECTION_SUFFIX = " -->";

/** For a refusal that names what a hand-written file lacks. */
export const MARKER_PREFIX = `<!-- ${TEXT_PREFIX}`;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The per-file marker, as a markdown line: `<!-- GENERATED by nen canon mirror
 * from <source>@<ref>: <scenario>/<file> -- do not edit; ... -->`. ASCII only
 * and `--` rather than an em dash, for the reason ../surface/mirror.ts gives:
 * the line is compared byte for byte across checkouts.
 */
export function fileMarker(pin: CanonPin, file: string): string {
  return `<!-- ${TEXT_PREFIX}${pin.source}@${pin.ref}: ${pin.scenario}/${file}${FILE_SUFFIX} -->`;
}

/** The BEGIN line of a document surface's managed block. */
export function blockBegin(pin: CanonPin): string {
  return `<!-- ${BLOCK_BEGIN_PREFIX}${pin.source}@${pin.ref}: ${pin.scenario}${BLOCK_BEGIN_SUFFIX} -->`;
}

/** The line that opens one canon file's section inside a block. */
export function sectionMarker(file: string): string {
  return `${SECTION_PREFIX}${file}${SECTION_SUFFIX}`;
}

const FILE_MARKER_RE = new RegExp(
  `^<!-- ${escapeRegExp(TEXT_PREFIX)}(?<source>[^@\\s]+)@(?<ref>\\S+): (?<scenario>[^/\\s]+)/(?<file>\\S+)${escapeRegExp(FILE_SUFFIX)} -->$`,
);
const BLOCK_BEGIN_RE = new RegExp(
  `^<!-- ${escapeRegExp(BLOCK_BEGIN_PREFIX)}(?<source>[^@\\s]+)@(?<ref>\\S+): (?<scenario>\\S+)${escapeRegExp(BLOCK_BEGIN_SUFFIX)} -->$`,
);
const SECTION_RE = new RegExp(`^${escapeRegExp(SECTION_PREFIX)}(?<file>\\S+)${escapeRegExp(SECTION_SUFFIX)}$`);

export interface FileMarker extends CanonPin {
  readonly file: string;
}

/**
 * The marker a committed mirror file carries, or null when it carries none.
 *
 * READ FROM THE FIRST MARKDOWN LINE ONLY -- line 1 of a file with no
 * frontmatter, the first line after the closing fence otherwise -- for the
 * reason the module header gives (decision 4): a marker-shaped line anywhere
 * else is quoted text, and the one drift class this exists to catch (a
 * removed header) must read as hand-edited, never as stale or ok.
 */
export function readFileMarker(text: string): FileMarker | null {
  const first = normalizeEol(splitDocument(text).body).split("\n")[0] ?? "";
  const groups = FILE_MARKER_RE.exec(first)?.groups;
  if (groups === undefined) return null;
  return {
    source: groups["source"] ?? "",
    ref: groups["ref"] ?? "",
    scenario: groups["scenario"] ?? "",
    file: groups["file"] ?? "",
  };
}

/**
 * The two lines git writes around every conflicted hunk: `<<<<<<< <ours>` and
 * `>>>>>>> <theirs>`. The `=======` and diff3 `|||||||` lines git writes BETWEEN
 * them are deliberately not matched on their own: seven `=` under a line of
 * text is a markdown setext heading underline, which a hand-written rule may
 * well carry, and inside a real hunk they are always fenced by these two.
 */
const CONFLICT_FENCE_RE = /^(?:<{7}|>{7})(?: .*)?$/;

/** Where an unresolved merge conflict shows in a file: its first `<<<<<<<`/`>>>>>>>` line, 1-based. */
export interface ConflictMarker {
  readonly line: number;
  readonly text: string;
}

/**
 * The first merge-conflict fence line in `text` (`<<<<<<<` or `>>>>>>>`), or
 * null when it carries none (zheref/nen#309). A lone `=======` or `|||||||`
 * line is not a conflict -- see CONFLICT_FENCE_RE.
 *
 * WHY THE GUARD ASKS THIS FIRST. The ownership marker is read from line 1
 * only (see readFileMarker), and a conflicted merge puts `<<<<<<< HEAD`
 * exactly there -- so a file this mirror generated, caught mid-merge, carried
 * no readable marker and was refused as somebody's own hand-written rule. The
 * refusal was right; the cause it named sent the reader looking for a hand
 * edit that did not exist. And a conflict BELOW an intact marker must not be
 * regenerated over either: overwriting it would silently pick a side of a
 * merge nobody resolved. Either way the destination is refused, nothing is
 * written, and the refusal names the conflict.
 */
export function findConflictMarker(text: string): ConflictMarker | null {
  const lines = normalizeEol(text).split("\n");
  const index = lines.findIndex((line): boolean => CONFLICT_FENCE_RE.test(line));
  if (index === -1) return null;
  return { line: index + 1, text: lines[index] ?? "" };
}

function conflictRefusal(path: string, conflict: ConflictMarker): string {
  return `${path} has an unresolved merge conflict (line ${conflict.line}: '${conflict.text}'), so it is not regenerated over and nothing is written. Finish the merge -- resolve the conflict, or check out either side -- then regenerate.`;
}

function samePin(marker: CanonPin, pin: CanonPin): boolean {
  return marker.source === pin.source && marker.ref === pin.ref && marker.scenario === pin.scenario;
}

// ---------------------------------------------------------------------------
// The canon source
// ---------------------------------------------------------------------------

export interface CanonSource {
  /** The canon filename, e.g. `07-testing.md`. */
  readonly file: string;
  /** The filename without its extension, which names the mirror file on a directory surface. */
  readonly stem: string;
  /** The rule text with every `{{TOKEN}}` bound, LF line endings, ending in a newline. */
  readonly body: string;
}

function substitute(text: string, filename: string, values: Readonly<Record<string, string>>): string {
  return text.replace(TOKEN_RE, (_whole, token: string): string => {
    const bound = values[token];
    if (bound === undefined) throw new MissingTokenError(filename, token);
    return bound;
  });
}

/** The canon filenames a rules directory holds: every `.md` minus the caller's never-mirrored set, sorted. */
export function canonFilenames(rulesDir: string, notMirrored: ReadonlySet<string>): readonly string[] {
  let entries: readonly string[];
  try {
    entries = readdirSync(rulesDir);
  } catch (error) {
    throw new CanonMirrorError(
      `--rules-dir '${rulesDir}' could not be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}. It is the stack's rules/ directory inside a checkout of the canonical handbooks repository at the pinned tag.`,
    );
  }
  const files = entries
    .filter((name): boolean => name.endsWith(".md") && !notMirrored.has(name) && statSync(join(rulesDir, name)).isFile())
    .sort();
  // A canon filename is written into every marker (`<scenario>/<file>`, and a
  // block's `<!-- canon: <file> -->` section line) and read back by a pattern
  // that stops at whitespace. A name the pattern cannot read back would render
  // fine and then check as hand-edited forever, so it is refused HERE, before
  // anything is rendered (Copilot, PR #274). The allowed shape is the one
  // every canon rule file already has.
  const unreadable = files.filter((name): boolean => !CANON_FILENAME.test(name));
  if (unreadable.length > 0) {
    throw new CanonMirrorError(
      `--rules-dir '${rulesDir}' holds ${unreadable.length === 1 ? "a rule file whose name" : "rule files whose names"} cannot be written into a marker and read back: ${unreadable.map((name): string => `'${name}'`).join(", ")}. A canon filename is letters, digits, '.', '_' and '-' (no whitespace, no path separator), ending in .md -- rename it upstream, or list it under --not-mirrored.`,
    );
  }
  return files;
}

/** The filename shape a marker can carry: no whitespace, no separator, `.md`. */
const CANON_FILENAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.md$/;

/**
 * Every canon rule file, read and bound.
 *
 * A rules directory with no rule file is a REFUSAL rather than an empty
 * rendering, for the reason ../surface/mirror.ts refuses an empty source: an
 * empty generation is indistinguishable from a correct one that mirrors
 * nothing, and writing it would delete every marked file in every surface as
 * an orphan -- which is exactly what a `--rules-dir` pointed one directory too
 * high, or at a tag that predates the canon (CON-13's pin-discipline
 * incident), would do silently.
 */
export function readCanonSources(
  rulesDir: string,
  values: Readonly<Record<string, string>>,
  notMirrored: ReadonlySet<string>,
): readonly CanonSource[] {
  const files = canonFilenames(rulesDir, notMirrored);
  if (files.length === 0) {
    throw new CanonMirrorError(
      `--rules-dir '${rulesDir}' holds no rule file (a .md outside --not-mirrored). A mirror rendered from nothing would delete every mirrored file as orphaned, so it is refused -- point --rules-dir at the stack's rules/ directory, at a tag that contains the canon.`,
    );
  }
  const sources = files.map((file): CanonSource => {
    const raw = normalizeEol(readFileSync(join(rulesDir, file), "utf8"));
    const bound = substitute(raw, file, values);
    return { file, stem: file.slice(0, -".md".length), body: bound.endsWith("\n") ? bound : `${bound}\n` };
  });
  refuseEmbeddedSectionMarkers(rulesDir, sources);
  return sources;
}

/**
 * A canon body may not carry a line that IS a section marker.
 *
 * The document shape (`AGENTS.md`) delimits one canon file from the next with a
 * `<!-- canon: <file> -->` line, and `sections()` splits on that shape wherever
 * it appears -- it cannot be first-line-only the way a file marker is, because
 * a document holds many bodies in sequence. So a canon file whose own body
 * contains that exact line would be split into a section that generate never
 * wrote, and the very next `check` would report the block generate had just
 * written as extra/missing/hand-edited (Bugbot, PR #278).
 *
 * Refused HERE, before anything is rendered on ANY surface, for the same reason
 * the filename guard above is: a body that cannot survive the round trip in one
 * shape is an upstream canon defect, not a per-surface accident, and a run that
 * wrote the directory surfaces and then refused the document one would leave a
 * consumer half-mirrored.
 */
function refuseEmbeddedSectionMarkers(rulesDir: string, sources: readonly CanonSource[]): void {
  const offenders: string[] = [];
  for (const source of sources) {
    const lines = source.body.split("\n");
    for (const [index, line] of lines.entries()) {
      if (SECTION_RE.test(line)) offenders.push(`'${source.file}' line ${index + 1}`);
    }
  }
  if (offenders.length === 0) return;
  throw new CanonMirrorError(
    `--rules-dir '${rulesDir}' holds ${offenders.length === 1 ? "a canon body that carries" : "canon bodies that carry"} a line which IS a section marker: ${offenders.join(", ")}. The document surface delimits its sections with that exact shape, so generate would write a block its own check reads as split -- change the line upstream (indent it, fence it, or reword it), or list the file under --not-mirrored.`,
  );
}

// ---------------------------------------------------------------------------
// Rendering, per surface
// ---------------------------------------------------------------------------

export interface RenderedFile {
  /** Repository-relative, `/`-separated. */
  readonly path: string;
  readonly content: string;
  /** The canon file this renders. */
  readonly file: string;
}

export interface SurfaceRendering {
  readonly surface: string;
  readonly rule: CanonMirrorRule;
  /** The repository-relative location, for a report line. */
  readonly location: string;
  /** One file per canon file on a directory surface; empty on a document surface. */
  readonly files: readonly RenderedFile[];
  /** The managed block on a document surface; null on a directory surface. */
  readonly block: string | null;
  /** Everything worth a line: a block past the surface's read limit, a file past its line advice. */
  readonly notes: readonly string[];
}

type DirectoryRule = Extract<CanonMirrorRule, { kind: "directory" }>;
type DocumentRule = Extract<CanonMirrorRule, { kind: "document" }>;

const byteLength = (text: string): number => Buffer.byteLength(text, "utf8");

function renderDirectory(row: SurfaceRow, rule: DirectoryRule, sources: readonly CanonSource[], pin: CanonPin): SurfaceRendering {
  const files: RenderedFile[] = [];
  const notes: string[] = [];
  for (const source of sources) {
    const front = rule.frontmatter === null ? "" : rule.frontmatter.replaceAll("{name}", source.stem);
    const content = `${front}${fileMarker(pin, source.file)}\n${source.body}`;
    const path = `${rule.dir}/${source.stem}${rule.extension}`;
    const bytes = byteLength(content);
    if (rule.limitBytes !== null && bytes > rule.limitBytes) {
      throw new CanonMirrorError(
        `${source.file} renders to ${bytes} bytes at ${path} for '${row.surface}', over the ${rule.limitBytes}-byte limit the surface documents (${rule.source}). The surface would truncate it silently, and nen never cuts a rules file -- split the canon file upstream, then regenerate.`,
      );
    }
    if (rule.lineGuidance !== null) {
      const lines = content.split("\n").length;
      if (lines > rule.lineGuidance) {
        notes.push(
          `${path} is ${lines} lines; the surface advises under ${rule.lineGuidance} (${rule.source}). Written whole -- advice, not a ceiling.`,
        );
      }
    }
    files.push({ path, content, file: source.file });
  }
  return { surface: row.surface, rule, location: canonLocation(rule), files, block: null, notes };
}

function renderDocument(row: SurfaceRow, rule: DocumentRule, sources: readonly CanonSource[], pin: CanonPin): SurfaceRendering {
  const parts: string[] = [`${blockBegin(pin)}\n`];
  for (const source of sources) parts.push(`${sectionMarker(source.file)}\n${source.body}`);
  parts.push(`${BLOCK_END}\n`);
  const block = parts.join("");
  const notes: string[] = [];
  const bytes = byteLength(block);
  if (rule.warnBytes !== null && bytes > rule.warnBytes) {
    notes.push(
      `${rule.file}'s canon block is ${bytes} bytes; '${row.surface}' documents that it stops reading project documents at ${rule.warnBytes} bytes${rule.warnSetting === null ? "" : ` (${rule.warnSetting})`} (${rule.source}). The rules past that point are never read there -- raise the limit, or accept that this surface reads a prefix.`,
    );
  }
  return { surface: row.surface, rule, location: canonLocation(rule), files: [], block, notes };
}

/** One surface's rendering of the whole rule set. Refuses (exit 2 at the verb) a file over the surface's documented byte limit. */
export function renderSurface(row: SurfaceRow, sources: readonly CanonSource[], pin: CanonPin): SurfaceRendering {
  const rule = row.canonMirror;
  if (rule === null) {
    throw new CanonMirrorError(`'${row.surface}' documents no rules location a canon mirror could be rendered into.`);
  }
  return rule.kind === "directory" ? renderDirectory(row, rule, sources, pin) : renderDocument(row, rule, sources, pin);
}

// ---------------------------------------------------------------------------
// The mirror on disk
// ---------------------------------------------------------------------------

function absolute(root: string, relative: string): string {
  return join(root, ...relative.split("/"));
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

interface DirectoryEntry {
  readonly path: string;
  readonly marked: boolean;
}

/** A directory surface's candidates: the IMMEDIATE children of `dir` with the surface's extension. */
function directoryEntries(root: string, rule: DirectoryRule): readonly DirectoryEntry[] {
  const dir = absolute(root, rule.dir);
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .sort()
    .filter((name): boolean => name.endsWith(rule.extension) && statSync(join(dir, name)).isFile())
    .map((name): DirectoryEntry => ({
      path: `${rule.dir}/${name}`,
      marked: readFileMarker(readFileSync(join(dir, name), "utf8")) !== null,
    }));
}

/** Where a document's managed block sits, and the pin its BEGIN line carries. */
interface BlockSpan {
  /** Offset of the BEGIN line's first character. */
  readonly start: number;
  /** Offset just past the END line's newline. */
  readonly end: number;
  readonly pin: CanonPin;
  /** The lines between BEGIN and END, joined. */
  readonly inner: string;
}

type BlockLookup =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly span: BlockSpan }
  | { readonly kind: "malformed"; readonly reason: string };

function findBlock(text: string): BlockLookup {
  const lines = text.split("\n");
  const begins: number[] = [];
  const ends: number[] = [];
  lines.forEach((line, index): void => {
    if (BLOCK_BEGIN_RE.test(line)) begins.push(index);
    if (line === BLOCK_END) ends.push(index);
  });
  if (begins.length === 0 && ends.length === 0) return { kind: "none" };
  if (begins.length > 1) {
    return { kind: "malformed", reason: `carries ${begins.length} BEGIN markers; nen owns exactly one block per document` };
  }
  if (begins.length === 0) return { kind: "malformed", reason: "carries an END marker with no BEGIN marker above it" };
  const begin = begins[0] ?? 0;
  const end = ends.find((index): boolean => index > begin);
  if (end === undefined) {
    return {
      kind: "malformed",
      reason: "has a BEGIN marker with no END marker after it, so nen cannot tell where the hand-written prose resumes",
    };
  }
  const groups = BLOCK_BEGIN_RE.exec(lines[begin] ?? "")?.groups ?? {};
  const offsetOf = (lineIndex: number): number =>
    lines.slice(0, lineIndex).reduce((sum, line): number => sum + line.length + 1, 0);
  return {
    kind: "found",
    span: {
      start: offsetOf(begin),
      end: Math.min(offsetOf(end + 1), text.length),
      pin: { source: groups["source"] ?? "", ref: groups["ref"] ?? "", scenario: groups["scenario"] ?? "" },
      inner: lines.slice(begin + 1, end).join("\n"),
    },
  };
}

type Splice = { readonly content: string } | { readonly refused: string };

/** The document once `block` replaces its managed block -- or joins a document that has none. */
function spliceBlock(existing: string | null, block: string): Splice {
  if (existing === null) return { content: block };
  const text = normalizeEol(existing);
  const lookup = findBlock(text);
  if (lookup.kind === "malformed") return { refused: lookup.reason };
  if (lookup.kind === "none") {
    if (text.trim() === "") return { content: block };
    // One blank line between the consumer's prose and the block, however the
    // prose ended -- and never a third newline.
    const separator = text.endsWith("\n\n") ? "" : text.endsWith("\n") ? "\n" : "\n\n";
    return { content: `${text}${separator}${block}` };
  }
  const before = text.slice(0, lookup.span.start);
  const after = text.slice(lookup.span.end);
  return { content: `${before}${block}${after}` };
}

/**
 * Every destination this rendering would refuse to write, as messages.
 *
 * RUN FOR EVERY SURFACE BEFORE THE FIRST BYTE IS WRITTEN ANYWHERE (the verb
 * does this): a guard applied surface by surface would leave the first
 * surface written when the second turned out to hold somebody's own file.
 */
export function guardSurface(root: string, rendering: SurfaceRendering): readonly string[] {
  const refusals: string[] = [];
  const rule = rendering.rule;
  if (rule.kind === "directory") {
    const dir = absolute(root, rule.dir);
    if (existsSync(dir) && !statSync(dir).isDirectory()) {
      refusals.push(`${rule.dir} exists and is not a directory; '${rendering.surface}' reads its rules from a directory there.`);
      return refusals;
    }
    for (const file of rendering.files) {
      const path = absolute(root, file.path);
      if (isSymlink(path)) {
        refusals.push(`${file.path} is a symbolic link; a write there lands wherever the link points, which is not a file this verb generated.`);
        continue;
      }
      if (!existsSync(path)) continue;
      const text = readFileSync(path, "utf8");
      // Asked BEFORE the marker: a conflicted destination is refused whether
      // or not its marker survived on line 1 (zheref/nen#309).
      const conflict = findConflictMarker(text);
      if (conflict !== null) {
        refusals.push(conflictRefusal(file.path, conflict));
        continue;
      }
      if (readFileMarker(text) === null) {
        refusals.push(
          `${file.path} exists and carries no '${MARKER_PREFIX}...' line, so it was written by hand and is not this mirror's to overwrite. Move or rename the consumer's own rule (a subdirectory of ${rule.dir}/ is left alone), or delete it in favour of the canon file.`,
        );
      }
    }
    return refusals;
  }
  const path = absolute(root, rule.file);
  if (isSymlink(path)) {
    refusals.push(`${rule.file} is a symbolic link; a write there lands wherever the link points.`);
    return refusals;
  }
  if (existsSync(path) && !statSync(path).isFile()) {
    refusals.push(`${rule.file} exists and is not a regular file.`);
    return refusals;
  }
  const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
  // A conflicted document is refused whole, block intact or not: a conflict
  // that duplicated or split the BEGIN/END pair would otherwise be named as
  // a broken marker pair -- true, and still the wrong cause -- and one in the
  // consumer's prose is not this verb's to carry into a fresh write.
  const conflict = existing === null ? null : findConflictMarker(existing);
  if (conflict !== null) {
    refusals.push(conflictRefusal(rule.file, conflict));
    return refusals;
  }
  const spliced = spliceBlock(existing, rendering.block ?? "");
  if ("refused" in spliced) {
    refusals.push(`${rule.file} ${spliced.refused}. Restore the marker pair, or remove the whole block and regenerate.`);
  }
  return refusals;
}

export interface SurfaceWriteResult {
  readonly surface: string;
  readonly location: string;
  readonly written: readonly string[];
  readonly unchanged: readonly string[];
  /** Orphans: marked files with no canon source, removed. */
  readonly deleted: readonly string[];
  /** The consumer's own files beside the mirror: unmarked, sourceless, left alone. */
  readonly foreign: readonly string[];
  readonly notes: readonly string[];
}

/**
 * Write one surface's rendering into the consumer, touching only what changed
 * and deleting the orphans -- or, with `dryRun`, compute the same lists and
 * write nothing. Assumes `guardSurface` came back empty.
 */
export function writeSurface(root: string, rendering: SurfaceRendering, dryRun = false): SurfaceWriteResult {
  const rule = rendering.rule;
  const written: string[] = [];
  const unchanged: string[] = [];
  const deleted: string[] = [];
  const foreign: string[] = [];

  if (rule.kind === "directory") {
    const generated = new Set(rendering.files.map((file): string => file.path));
    for (const file of rendering.files) {
      const path = absolute(root, file.path);
      if (existsSync(path) && normalizeEol(readFileSync(path, "utf8")) === file.content) {
        unchanged.push(file.path);
        continue;
      }
      written.push(file.path);
      if (dryRun) continue;
      mkdirSync(absolute(root, rule.dir), { recursive: true });
      writeFileSync(path, file.content, "utf8");
    }
    for (const entry of directoryEntries(root, rule)) {
      if (generated.has(entry.path)) continue;
      if (!entry.marked) {
        foreign.push(entry.path);
        continue;
      }
      deleted.push(entry.path);
      if (!dryRun) rmSync(absolute(root, entry.path));
    }
  } else {
    const path = absolute(root, rule.file);
    const existing = existsSync(path) ? readFileSync(path, "utf8") : null;
    const spliced = spliceBlock(existing, rendering.block ?? "");
    /* c8 ignore next -- guardSurface refused this shape before writeSurface was reached */
    if ("refused" in spliced) throw new CanonMirrorError(`${rule.file} ${spliced.refused}.`);
    if (existing !== null && normalizeEol(existing) === spliced.content) {
      unchanged.push(rule.file);
    } else {
      written.push(rule.file);
      if (!dryRun) writeFileSync(path, spliced.content, "utf8");
    }
  }

  return {
    surface: rendering.surface,
    location: rendering.location,
    written: written.sort(),
    unchanged: unchanged.sort(),
    deleted: deleted.sort(),
    foreign: foreign.sort(),
    notes: rendering.notes,
  };
}

// ---------------------------------------------------------------------------
// Checking
// ---------------------------------------------------------------------------

export type DriftClass = "missing" | "extra" | "stale" | "handEdited";

export interface SurfaceCheckReport {
  readonly surface: string;
  readonly location: string;
  /** Byte-identical to a fresh rendering at the pin. */
  readonly ok: readonly string[];
  /** Canon has it; the mirror does not. */
  readonly missing: readonly string[];
  /** The mirror has a marked file (or block section) with no canon source. */
  readonly extra: readonly string[];
  /** Generated, but for another pin (source, ref or scenario): never regenerated after the pin moved. */
  readonly stale: readonly string[];
  /** Marked for this pin but not a fresh rendering's bytes -- or carrying no marker at all. */
  readonly handEdited: readonly string[];
  /** Unmarked, sourceless files beside the mirror: the consumer's own, not drift. */
  readonly foreign: readonly string[];
}

const BLOCK_PREAMBLE = "(text inside the block before its first canon section)";

function emptyReport(rendering: SurfaceRendering): SurfaceCheckReport {
  return { surface: rendering.surface, location: rendering.location, ok: [], missing: [], extra: [], stale: [], handEdited: [], foreign: [] };
}

function checkDirectory(root: string, rendering: SurfaceRendering, rule: DirectoryRule, pin: CanonPin): SurfaceCheckReport {
  const ok: string[] = [];
  const missing: string[] = [];
  const stale: string[] = [];
  const handEdited: string[] = [];
  for (const file of rendering.files) {
    const path = absolute(root, file.path);
    if (!existsSync(path) || !statSync(path).isFile()) {
      missing.push(file.path);
      continue;
    }
    const existing = normalizeEol(readFileSync(path, "utf8"));
    const marker = readFileMarker(existing);
    if (marker === null) handEdited.push(file.path);
    else if (!samePin(marker, pin)) stale.push(file.path);
    else if (existing !== file.content) handEdited.push(file.path);
    else ok.push(file.path);
  }
  const generated = new Set(rendering.files.map((file): string => file.path));
  const extra: string[] = [];
  const foreign: string[] = [];
  for (const entry of directoryEntries(root, rule)) {
    if (generated.has(entry.path)) continue;
    (entry.marked ? extra : foreign).push(entry.path);
  }
  return {
    ...emptyReport(rendering),
    ok: ok.sort(),
    missing: missing.sort(),
    extra: extra.sort(),
    stale: stale.sort(),
    handEdited: handEdited.sort(),
    foreign: foreign.sort(),
  };
}

interface BlockSections {
  /** Canon file -> the section's body, as the block carries it. */
  readonly bodies: ReadonlyMap<string, string>;
  /** Whatever sits between the BEGIN line and the first section marker, trimmed. */
  readonly preamble: string;
}

/** The block's inner text split at its section markers. */
function sections(inner: string): BlockSections {
  const bodies = new Map<string, string>();
  let current: string | null = null;
  let buffer: string[] = [];
  const preamble: string[] = [];
  const flush = (): void => {
    if (current !== null) bodies.set(current, buffer.length === 0 ? "" : `${buffer.join("\n")}\n`);
    buffer = [];
  };
  for (const line of inner.split("\n")) {
    const file = SECTION_RE.exec(line)?.groups?.["file"];
    if (file !== undefined) {
      flush();
      current = file;
      continue;
    }
    if (current === null) preamble.push(line);
    else buffer.push(line);
  }
  flush();
  return { bodies, preamble: preamble.join("\n").trim() };
}

function checkDocument(
  root: string,
  rendering: SurfaceRendering,
  rule: DocumentRule,
  pin: CanonPin,
  sources: readonly CanonSource[],
): SurfaceCheckReport {
  const files = sources.map((source): string => source.file);
  const base = emptyReport(rendering);
  const path = absolute(root, rule.file);
  if (!existsSync(path) || !statSync(path).isFile()) return { ...base, missing: files };
  const lookup = findBlock(normalizeEol(readFileSync(path, "utf8")));
  if (lookup.kind === "none") return { ...base, missing: files };
  // A block whose marker pair is broken is a hand edit to every rule in it:
  // nothing inside can be trusted to be where nen left it.
  if (lookup.kind === "malformed") return { ...base, handEdited: files };
  if (!samePin(lookup.span.pin, pin)) return { ...base, stale: files };
  const found = sections(lookup.span.inner);
  const ok: string[] = [];
  const missing: string[] = [];
  const handEdited: string[] = [];
  for (const source of sources) {
    const body = found.bodies.get(source.file);
    if (body === undefined) missing.push(source.file);
    else if (body !== source.body) handEdited.push(source.file);
    else ok.push(source.file);
  }
  const extra = [...found.bodies.keys()].filter((file): boolean => !files.includes(file)).sort();
  if (found.preamble !== "") extra.push(BLOCK_PREAMBLE);
  return { ...base, ok: ok.sort(), missing: missing.sort(), extra, handEdited: handEdited.sort() };
}

/** The committed mirror of one surface against a fresh rendering. Reads everything, writes nothing. */
export function checkSurface(
  root: string,
  rendering: SurfaceRendering,
  pin: CanonPin,
  sources: readonly CanonSource[],
): SurfaceCheckReport {
  const rule = rendering.rule;
  return rule.kind === "directory"
    ? checkDirectory(root, rendering, rule, pin)
    : checkDocument(root, rendering, rule, pin, sources);
}

export function surfaceReportOk(report: SurfaceCheckReport): boolean {
  return report.missing.length === 0 && report.extra.length === 0 && report.stale.length === 0 && report.handEdited.length === 0;
}

const ISSUE_LABELS: Readonly<Record<DriftClass, string>> = {
  handEdited: "hand-edited (differs from a fresh rendering, or carries no marker)",
  stale: "stale (generated for another pin)",
  missing: "missing from the mirror",
  extra: "orphaned in the mirror (no canon source)",
};

/** A markdown table of every drift row across the surfaces, or the one-line all-clear. */
export function renderReportMarkdown(reports: readonly SurfaceCheckReport[]): string {
  const rows: string[] = [];
  for (const report of reports) {
    for (const key of ["handEdited", "stale", "missing", "extra"] as const) {
      for (const file of report[key]) rows.push(`| \`${report.surface}\` | \`${file}\` | ${ISSUE_LABELS[key]} |`);
    }
  }
  if (rows.length === 0) return "No drift -- every mirror file on every surface matches a fresh rendering.\n";
  return `| Surface | File | Issue |\n|---|---|---|\n${rows.join("\n")}\n`;
}
