// src/issue/shape.ts -- the issue-shape reads behind `nen issue body-check` and
// `nen issue questions`.
//
// BOTH ARE MEASUREMENTS, NEVER JUDGEMENTS ABOUT WHAT AN ISSUE SHOULD SAY. Which
// sections an issue of a kind must carry, what a section's content must match,
// which row prefixes number acceptance and success criteria, and which words a
// repository calls vague are all the CALLER's catalogue (`--requirements-from`),
// the same way `nen pr body-check` takes its requirements as caller data
// (../pr/bodycheck.ts). Nothing here names a repository, a section title or a
// row prefix of its own.
//
// ONE MARKDOWN READING. Headings come from ../pr/template.ts's `readLines`, so a
// heading inside fenced code or an HTML comment is never a section here either,
// and a section ends at the next heading at its level or higher, exactly as the
// derived pull-request check reads one. Rows, question lines and markers are
// read from the same lines with fenced code, comments and inline code masked:
// an example inside a code block is an example, not a row.
//
// EVERY MISS IS REPORTED, NEVER THE FIRST ONE ONLY -- the house rule for a check
// a caller round-trips on (../release/preflight.ts, ../pr/bodycheck.ts).

import { readLines, stripComments, validFenceOpening, type ReadLine } from "../pr/template.js";

/** The `--json` contract of `nen issue body-check`. */
export const ISSUE_BODY_CHECK_CONTRACT = "nen.issue.body-check/v0.1";
/** The `--json` contract of `nen issue questions`. */
export const ISSUE_QUESTIONS_CONTRACT = "nen.issue.questions/v0.1";

/** A catalogue refusal: the caller's file is malformed, or names a kind or section it does not declare. Exit 2. */
export class IssueShapeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IssueShapeError";
  }
}

export interface ContentRule {
  readonly name: string;
  readonly pattern: string;
}

export interface RowRule {
  /** The row prefix, e.g. `AC` for rows spelled `AC-1`, `AC-2`. */
  readonly prefix: string;
  /** The rows must be numbered 1, 2, ... n in document order: no gap, no repeat, no reorder. */
  readonly contiguous?: boolean;
  /** Every row's text after its id must carry a number or a percentage. */
  readonly measurable?: boolean;
}

export interface SectionRule {
  readonly id: string;
  /** The heading's words, matched case-insensitively with leading/trailing glyphs and whitespace runs folded. */
  readonly title: readonly string[];
  /** When given, the heading must be at exactly this level (1-6). */
  readonly level?: number;
  readonly content: readonly ContentRule[];
  readonly rows?: RowRule;
}

export interface IssueSectionsCatalogue {
  /** The caller's own id for its catalogue, echoed, never interpreted. */
  readonly contract: string | null;
  readonly sections: readonly SectionRule[];
  /** Kind -> the section ids an issue of that kind must carry, in order. */
  readonly kinds: Readonly<Record<string, readonly string[]>>;
  readonly vagueAdjectives: readonly string[];
}

const ROW_PREFIX = /^[A-Za-z][A-Za-z0-9]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function compiles(pattern: string, where: string): void {
  try {
    new RegExp(pattern, "im");
  } catch (error) {
    throw new IssueShapeError(`${where} has an unparseable pattern '${pattern}' (${error instanceof Error ? error.message : String(error)}).`);
  }
}

/**
 * Read and validate the caller's catalogue. Refuses, naming the field, rather
 * than skipping anything it cannot read: a section it could not parse would
 * otherwise read as a section nobody required.
 */
export function parseCatalogue(raw: unknown): IssueSectionsCatalogue {
  if (!isRecord(raw)) {
    throw new IssueShapeError(`the catalogue is not a JSON object -- expected '{ "sections": [...], "kinds": { ... } }'.`);
  }
  const contract = raw["contract"];
  if (contract !== undefined && typeof contract !== "string") throw new IssueShapeError("'contract', when given, is a string.");
  const rawSections = raw["sections"];
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    throw new IssueShapeError("'sections' is not a non-empty array -- a catalogue with no sections would pass every body having checked nothing.");
  }
  const seen = new Set<string>();
  const sections = rawSections.map((entry: unknown, index: number): SectionRule => {
    if (!isRecord(entry)) throw new IssueShapeError(`sections[${index}] is not an object.`);
    const id = entry["id"];
    if (typeof id !== "string" || id === "") throw new IssueShapeError(`sections[${index}] has no string 'id'.`);
    if (seen.has(id)) throw new IssueShapeError(`section '${id}' is declared twice.`);
    seen.add(id);
    const rawTitle = entry["title"];
    const title = typeof rawTitle === "string" ? [rawTitle] : rawTitle;
    if (!Array.isArray(title) || title.length === 0 || !title.every((item): boolean => typeof item === "string" && foldTitle(item) !== "")) {
      throw new IssueShapeError(`section '${id}' needs 'title': a heading's words, or a non-empty array of them.`);
    }
    const level = entry["level"];
    if (level !== undefined && (typeof level !== "number" || !Number.isInteger(level) || level < 1 || level > 6)) {
      throw new IssueShapeError(`section '${id}' has a 'level' that is not a whole number from 1 to 6.`);
    }
    const rawContent = entry["content"] ?? [];
    if (!Array.isArray(rawContent)) throw new IssueShapeError(`section '${id}' has a 'content' that is not an array of { name, pattern }.`);
    const content = rawContent.map((rule: unknown, at: number): ContentRule => {
      if (!isRecord(rule) || typeof rule["name"] !== "string" || rule["name"] === "" || typeof rule["pattern"] !== "string" || rule["pattern"] === "") {
        throw new IssueShapeError(`section '${id}' content[${at}] is not a { name, pattern } pair of non-empty strings.`);
      }
      compiles(rule["pattern"], `section '${id}' content rule '${rule["name"]}'`);
      return { name: rule["name"], pattern: rule["pattern"] };
    });
    const rawRows = entry["rows"];
    let rows: RowRule | undefined;
    if (rawRows !== undefined) {
      if (!isRecord(rawRows) || typeof rawRows["prefix"] !== "string" || !ROW_PREFIX.test(rawRows["prefix"])) {
        throw new IssueShapeError(`section '${id}' has a 'rows' without a 'prefix' (a letter, then letters and digits, e.g. "AC").`);
      }
      for (const flag of ["contiguous", "measurable"] as const) {
        if (rawRows[flag] !== undefined && typeof rawRows[flag] !== "boolean") throw new IssueShapeError(`section '${id}' rows.${flag} is not a boolean.`);
      }
      rows = {
        prefix: rawRows["prefix"],
        ...(rawRows["contiguous"] === true ? { contiguous: true } : {}),
        ...(rawRows["measurable"] === true ? { measurable: true } : {}),
      };
    }
    return { id, title: title as string[], ...(level === undefined ? {} : { level: level as number }), content, ...(rows === undefined ? {} : { rows }) };
  });
  const rawKinds = raw["kinds"];
  if (!isRecord(rawKinds) || Object.keys(rawKinds).length === 0) {
    throw new IssueShapeError("'kinds' is not a non-empty object of kind -> [section id, ...].");
  }
  const kinds: Record<string, readonly string[]> = {};
  for (const [kind, ids] of Object.entries(rawKinds)) {
    if (kind.startsWith("$")) continue;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((item): boolean => typeof item === "string")) {
      throw new IssueShapeError(`kind '${kind}' is not a non-empty array of section ids.`);
    }
    const unknown = (ids as string[]).filter((item): boolean => !seen.has(item));
    if (unknown.length > 0) throw new IssueShapeError(`kind '${kind}' names undeclared section(s): ${unknown.join(", ")}.`);
    kinds[kind] = ids as string[];
  }
  if (Object.keys(kinds).length === 0) throw new IssueShapeError("'kinds' declares no kind.");
  const rawVague = raw["vagueAdjectives"] ?? [];
  if (!Array.isArray(rawVague) || !rawVague.every((item): boolean => typeof item === "string" && item.trim() !== "")) {
    throw new IssueShapeError("'vagueAdjectives', when given, is an array of non-empty strings.");
  }
  return { contract: typeof contract === "string" ? contract : null, sections, kinds, vagueAdjectives: (rawVague as string[]).map((word): string => word.trim()) };
}

/**
 * The kind to check against: the one asked for, or the catalogue's only kind.
 * With several kinds and none asked for, it refuses -- picking one would be a
 * decision about what the issue is.
 */
export function selectKind(catalogue: IssueSectionsCatalogue, asked: string | undefined): string {
  const kinds = Object.keys(catalogue.kinds);
  if (asked !== undefined) {
    if (catalogue.kinds[asked] === undefined) throw new IssueShapeError(`kind '${asked}' is not declared in the catalogue (declared: ${kinds.join(", ")}).`);
    return asked;
  }
  if (kinds.length === 1) return kinds[0] as string;
  throw new IssueShapeError(`the catalogue declares ${kinds.length} kinds (${kinds.join(", ")}); pass --kind <kind>. Nen will not pick one.`);
}

/** Leading and trailing glyph runs (an emoji, a `§`) dropped, whitespace folded, lower-cased. */
export function foldTitle(text: string): string {
  return text
    .replace(/^[^\p{L}\p{N}]+/u, "")
    .replace(/[^\p{L}\p{N})\]]+$/u, "")
    .replace(/\s+/g, " ")
    .toLowerCase();
}

/** One source line as the row and marker readers see it: comments and inline code removed, fenced code blank. */
interface MaskedLine {
  readonly line: number;
  readonly text: string;
}

function maskedLines(body: string): MaskedLine[] {
  const rows = body.replace(/^﻿/, "").replace(/\r\n?/g, "\n").split("\n");
  const masked: MaskedLine[] = [];
  let fence: string | null = null;
  let comment = false;
  rows.forEach((raw, index): void => {
    if (fence !== null) {
      const marker = fence[0] as string;
      if (new RegExp(`^ {0,3}\\${marker}{${fence.length},}\\s*$`).test(raw)) fence = null;
      masked.push({ line: index + 1, text: "" });
      return;
    }
    const stripped = stripComments(raw, comment);
    comment = stripped.open;
    const open = validFenceOpening(stripped.text);
    if (open !== null) {
      fence = open;
      masked.push({ line: index + 1, text: "" });
      return;
    }
    masked.push({ line: index + 1, text: stripped.text.replace(/(`+)[^`]*?\1/g, " ") });
  });
  return masked;
}

export type SectionStatus = "ok" | "missing" | "empty";

export interface SectionReport {
  readonly id: string;
  readonly title: string;
  readonly status: SectionStatus;
  /** The heading's 1-based line, or null when missing. */
  readonly line: number | null;
}

export type MissKind = "missing" | "empty" | "content" | "no-rows" | "row-order" | "row-unmeasurable";

export interface Miss {
  readonly section: string;
  readonly kind: MissKind;
  readonly line: number | null;
  readonly detail: string;
}

export interface Row {
  readonly section: string;
  readonly id: string;
  readonly number: number;
  readonly line: number;
}

export interface Advisory {
  readonly kind: "vague";
  readonly word: string;
  readonly line: number;
}

export interface IssueBodyReport {
  readonly kind: string;
  readonly ok: boolean;
  readonly sections: readonly SectionReport[];
  readonly rows: readonly Row[];
  readonly misses: readonly Miss[];
  readonly advisories: readonly Advisory[];
}

function headingMatches(rule: SectionRule, line: ReadLine): boolean {
  if (line.kind !== "heading" || line.title === "") return false;
  if (rule.level !== undefined && line.level !== rule.level) return false;
  const folded = foldTitle(line.title);
  return rule.title.some((title): boolean => foldTitle(title) === folded);
}

/** The section heading `index` opens: its line indexes, up to the next heading at its level or higher. */
function extentOf(read: readonly ReadLine[], index: number, level: number): number[] {
  const indexes: number[] = [];
  for (let at = index + 1; at < read.length; at++) {
    const line = read[at] as ReadLine;
    if (line.kind === "heading" && line.level <= level) break;
    indexes.push(at);
  }
  return indexes;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A list item or table row whose first token is `<prefix>-<n>` (bold, struck or code-quoted spans allowed). */
function rowPattern(prefix: string): RegExp {
  return new RegExp(`^\\s*(?:(?:[-*+]|\\d{1,9}[.)])\\s+(?:\\[[ xX]\\]\\s+)?|\\|\\s*)(?:\\*\\*|__|~~|\\*|_)*${escapeRegExp(prefix)}-(\\d{1,9})\\b(.*)$`);
}

/**
 * Check one issue body against the catalogue's sections for `kind`.
 *
 * A SECTION IS `missing` when no heading matches it, `empty` when its heading
 * carries no content line before the next heading at its level or higher (a
 * deeper sub-heading is structure; content under it counts). A present section
 * is then held to its content rules and its row rule; every failure is a miss.
 * Vague adjectives are ADVISORIES: reported with their line, never a miss.
 */
export function checkIssueBody(body: string, catalogue: IssueSectionsCatalogue, kind: string): IssueBodyReport {
  const ids = catalogue.kinds[kind];
  if (ids === undefined) throw new IssueShapeError(`kind '${kind}' is not declared in the catalogue.`);
  const read = readLines(body, { strictFences: true });
  const masked = maskedLines(body);
  const sections: SectionReport[] = [];
  const misses: Miss[] = [];
  const rows: Row[] = [];
  for (const id of ids) {
    const rule = catalogue.sections.find((section): boolean => section.id === id) as SectionRule;
    const title = rule.title[0] as string;
    const headings = read.flatMap((line, index): number[] => (headingMatches(rule, line) ? [index] : []));
    if (headings.length === 0) {
      sections.push({ id, title, status: "missing", line: null });
      misses.push({ section: id, kind: "missing", line: null, detail: `no heading '${title}'${rule.level === undefined ? "" : ` at level ${rule.level}`}` });
      continue;
    }
    // The first heading that carries content is the section; with none, the first one is, and it is empty.
    const extents = headings.map((index): number[] => extentOf(read, index, (read[index] as { level: number }).level));
    const filledAt = extents.findIndex((extent): boolean => extent.some((at): boolean => read[at]?.kind === "content"));
    const chosen = filledAt < 0 ? 0 : filledAt;
    const headingIndex = headings[chosen] as number;
    const extent = extents[chosen] as number[];
    if (filledAt < 0) {
      sections.push({ id, title, status: "empty", line: headingIndex + 1 });
      misses.push({ section: id, kind: "empty", line: headingIndex + 1, detail: `'${title}' has a heading and nothing under it` });
      continue;
    }
    sections.push({ id, title, status: "ok", line: headingIndex + 1 });
    const text = extent.map((at): string => { const line = read[at]; return line?.kind === "content" ? line.text : ""; }).join("\n");
    for (const content of rule.content) {
      if (!new RegExp(content.pattern, "im").test(text)) {
        misses.push({ section: id, kind: "content", line: headingIndex + 1, detail: `'${title}' does not satisfy '${content.name}'` });
      }
    }
    if (rule.rows !== undefined) {
      const pattern = rowPattern(rule.rows.prefix);
      const found = extent.flatMap((at): { number: number; rest: string; line: number }[] => {
        const line = masked[at] as MaskedLine;
        const match = pattern.exec(line.text);
        return match === null ? [] : [{ number: Number(match[1]), rest: match[2] ?? "", line: line.line }];
      });
      for (const row of found) rows.push({ section: id, id: `${rule.rows.prefix}-${row.number}`, number: row.number, line: row.line });
      if (found.length === 0) {
        misses.push({ section: id, kind: "no-rows", line: headingIndex + 1, detail: `'${title}' carries no ${rule.rows.prefix}-{n} row` });
      }
      if (rule.rows.contiguous) {
        const numbered = new Set<number>();
        found.forEach((row, position): void => {
          const prefix = rule.rows?.prefix ?? "";
          if (numbered.has(row.number)) {
            misses.push({ section: id, kind: "row-order", line: row.line, detail: `${prefix}-${row.number} repeats an earlier row's number` });
          } else if (row.number !== position + 1) {
            misses.push({ section: id, kind: "row-order", line: row.line, detail: `${prefix}-${row.number} is row ${position + 1}; rows are numbered ${prefix}-1 to ${prefix}-${found.length} in order` });
          }
          numbered.add(row.number);
        });
      }
      if (rule.rows.measurable) {
        for (const row of found) {
          if (!/[0-9]|%/.test(row.rest)) {
            misses.push({ section: id, kind: "row-unmeasurable", line: row.line, detail: `${rule.rows.prefix}-${row.number} states no number or percentage` });
          }
        }
      }
    }
  }
  const advisories: Advisory[] = [];
  if (catalogue.vagueAdjectives.length > 0) {
    const words = catalogue.vagueAdjectives.map((word): RegExp => new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(word)}(?![\\p{L}\\p{N}_-])`, "giu"));
    for (const line of masked) {
      if (read[line.line - 1]?.kind === "heading") continue;
      catalogue.vagueAdjectives.forEach((word, at): void => {
        const regex = words[at] as RegExp;
        regex.lastIndex = 0;
        if (regex.test(line.text)) advisories.push({ kind: "vague", word, line: line.line });
      });
    }
  }
  return { kind, ok: misses.length === 0, sections, rows, misses, advisories };
}

// --- nen issue questions ------------------------------------------------------

export interface OpenQuestion {
  readonly id: string;
  readonly number: number;
  readonly gate: string;
  readonly line: number;
}

export interface ResolvedQuestion {
  readonly id: string;
  readonly number: number;
  readonly line: number;
}

export interface NeedsMarker {
  /** The marker's label: `CLARIFICATION`, or a row id such as `HR-4`. */
  readonly label: string;
  readonly line: number;
}

export interface QuestionsReport {
  readonly counts: { readonly open: number; readonly resolved: number; readonly needsMarkers: number; readonly unrecognised: number };
  readonly open: readonly OpenQuestion[];
  readonly resolved: readonly ResolvedQuestion[];
  readonly needsMarkers: readonly NeedsMarker[];
  /** Lines that carry an `OQ-{n}` list row in neither admitted shape: reported, never guessed at. */
  readonly unrecognised: readonly { readonly line: number; readonly text: string }[];
}

const LIST_ITEM = /^\s*(?:[-*+]|\d{1,9}[.)])\s+/;
const OPEN_ROW = /^\s*[-*+]\s+OQ-(\d{1,9})\s+\(([^()\n]+)\)\s*:/;
const RESOLVED_ROW = /^\s*[-*+]\s+~~OQ-(\d{1,9})~~\s*(?:→|->)\s*A\s*:/;
const ANY_OQ_ROW = /^(?:~~|\*\*|_|\*)*OQ-\d/;
const NEEDS_MARKER = /\[NEEDS(?:[ \t]+([^\]:\n]+?))?[ \t]*(?::[^\]\n]*)?\]/g;

/**
 * Count an issue body's open questions, resolved ones and `[NEEDS ...]`
 * markers. Counts only: whether a build may start with an open question is
 * the caller's rule. A list row that names `OQ-{n}` in neither admitted shape
 * is listed as unrecognised rather than dropped or counted as either.
 */
export function countQuestions(body: string): QuestionsReport {
  const open: OpenQuestion[] = [];
  const resolved: ResolvedQuestion[] = [];
  const needsMarkers: NeedsMarker[] = [];
  const unrecognised: { line: number; text: string }[] = [];
  for (const line of maskedLines(body)) {
    const openMatch = OPEN_ROW.exec(line.text);
    const resolvedMatch = RESOLVED_ROW.exec(line.text);
    if (openMatch !== null) {
      open.push({ id: `OQ-${Number(openMatch[1])}`, number: Number(openMatch[1]), gate: (openMatch[2] as string).trim(), line: line.line });
    } else if (resolvedMatch !== null) {
      resolved.push({ id: `OQ-${Number(resolvedMatch[1])}`, number: Number(resolvedMatch[1]), line: line.line });
    } else if (LIST_ITEM.test(line.text) && ANY_OQ_ROW.test(line.text.replace(LIST_ITEM, ""))) {
      unrecognised.push({ line: line.line, text: line.text.trim() });
    }
    for (const marker of line.text.matchAll(NEEDS_MARKER)) {
      needsMarkers.push({ label: (marker[1] ?? "").trim(), line: line.line });
    }
  }
  return {
    counts: { open: open.length, resolved: resolved.length, needsMarkers: needsMarkers.length, unrecognised: unrecognised.length },
    open,
    resolved,
    needsMarkers,
    unrecognised,
  };
}
