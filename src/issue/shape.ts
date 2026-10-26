// src/issue/shape.ts -- the issue-shape reads behind `nen issue body-check` and
// `nen issue questions`.
//
// BOTH ARE MEASUREMENTS, NEVER JUDGEMENTS ABOUT WHAT AN ISSUE SHOULD SAY. Which
// sections an issue of a kind must carry, what a section's content must match,
// which row prefixes number acceptance and success criteria, and which words a
// repository calls vague are all the CALLER's catalogue (`--requirements-from`),
// the same way `nen pr body-check` takes its requirements as caller data
// (../pr/bodycheck.ts). Nothing here names a repository or a section title of
// its own; the two documented defaults -- the `AC` criterion prefix and the
// open-question grammar, both equal to Hatsu's catalogue -- apply only when
// the caller gives no catalogue. The catalogue is read in Hatsu's
// `hatsu.issue-sections/v1` shape as it is written (delivery round on
// zheref/nen#498, reading 1), or in nen's older array shape.
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

import { escapeRegExp, readLines, stripComments, validFenceOpening, type ReadLine } from "../pr/template.js";

/** The `--json` contract of `nen issue body-check`. */
export const ISSUE_BODY_CHECK_CONTRACT = "nen.issue.body-check/v0.1";
/** The `--json` contract of `nen issue questions`. */
export const ISSUE_QUESTIONS_CONTRACT = "nen.issue.questions/v0.1";
/** The `--json` contract of a comma-separated `--ref` batch: its own id, so a consumer keyed on the contract reads one shape per id (zheref/nen#515 F5). */
export const ISSUE_QUESTIONS_BATCH_CONTRACT = "nen.issue.questions.batch/v0.1";

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
  /**
   * The `hatsu.issue-sections/v1` row rules, when the catalogue is in that
   * shape: the whole-row pattern a row (read as `- <PREFIX>-<n>...`, list
   * marker and checkbox folded) must match, the resolved form's pattern (an
   * open-question row), and the pattern the row's text after its id must
   * match (`measure`). A row matching neither pattern is a `row-shape` miss.
   */
  readonly pattern?: string;
  readonly resolvedPattern?: string;
  readonly measure?: string;
  /** The catalogue's technology terms are advisories on these rows (acceptance criteria state intent). */
  readonly technology?: boolean;
  /**
   * The id's shape after `<PREFIX>-`, as a regular-expression source: the
   * first group its acceptance row `pattern` opens after the prefix
   * (zheref/nen#519). Set on the acceptance row only; every other row reads
   * `<PREFIX>-<n>`.
   */
  readonly idTail?: string;
}

export interface SectionRule {
  readonly id: string;
  /** The heading's words, matched case-insensitively with leading/trailing glyphs and whitespace runs folded. */
  readonly title: readonly string[];
  /** When given, the heading must be at exactly this level (1-6). */
  readonly level?: number;
  readonly content: readonly ContentRule[];
  readonly rows?: RowRule;
  /** The section may say only the catalogue's `noneText` (for example `None.`) in place of rows. */
  readonly none?: boolean;
}

/** The sections an issue of one kind must carry, and those it may carry. */
export interface KindRule {
  readonly required: readonly string[];
  readonly optional: readonly string[];
}

export interface TechnologyTerms {
  readonly words: readonly string[];
  readonly patterns: readonly { readonly id: string; readonly pattern: string }[];
}

/** The open-question row grammar: the open row's pattern and the resolved row's. */
export interface QuestionGrammar {
  readonly pattern: string;
  readonly resolvedPattern: string;
}

export interface IssueSectionsCatalogue {
  /** The caller's own id for its catalogue, echoed, never interpreted. */
  readonly contract: string | null;
  readonly sections: readonly SectionRule[];
  /** Kind -> the section ids an issue of that kind must carry (and may carry). */
  readonly kinds: Readonly<Record<string, KindRule>>;
  readonly vagueAdjectives: readonly string[];
  /** The kind read when no --kind is given (`common` in the v1 shape); null when the catalogue names none. */
  readonly defaultKind: string | null;
  /** The pattern a `none` section's only line may match in place of rows; null when the catalogue declares none. */
  readonly noneText: string | null;
  readonly technologyTerms: TechnologyTerms | null;
  /** The acceptance-criterion row prefix (`AC` by default) -- one extraction for body-check, criteria and converge. */
  readonly criteriaPrefix: string;
  /**
   * The criterion id's shape after `<PREFIX>-`, a regular-expression source:
   * the group the catalogue's acceptance row pattern declares, or
   * `DEFAULT_CRITERION_ID_TAIL` when it declares no acceptance pattern
   * (zheref/nen#519).
   */
  readonly criteriaIdTail: string;
  /** The section ids whose rows are the acceptance criteria; criteria are read inside these sections only. */
  readonly criteriaSections: readonly string[];
  /** The open-question grammar the catalogue declares; null when it declares none (nen's default applies). */
  readonly questions: QuestionGrammar | null;
}

/** The documented default acceptance-criterion prefix. */
export const DEFAULT_CRITERIA_PREFIX = "AC";

/**
 * The documented default criterion id shape after `<PREFIX>-`: one number, or
 * several joined by hyphens -- `AC-3`, and an epic-scoped `AC-12-001` read
 * whole (zheref/nen#519). It applies only when no catalogue declares an
 * acceptance row pattern; with one, the pattern's own id group is the shape.
 */
export const DEFAULT_CRITERION_ID_TAIL = "\\d{1,9}(?:-\\d{1,9})*";

/** The id shape every other numbered row (`SC-`, `AS-`, `OQ-`) is read in: one number. */
const ROW_ID_TAIL = "\\d{1,9}";

/** The criterion id grammar one catalogue (or none) gives: the prefix and the id shape after it. */
export interface CriterionGrammar {
  readonly prefix: string;
  readonly tail: string;
}

export const DEFAULT_CRITERION_GRAMMAR: CriterionGrammar = { prefix: DEFAULT_CRITERIA_PREFIX, tail: DEFAULT_CRITERION_ID_TAIL };

/** The criterion grammar of `catalogue`, or the documented default with none. */
export function criterionGrammar(catalogue: IssueSectionsCatalogue | null): CriterionGrammar {
  return catalogue === null ? DEFAULT_CRITERION_GRAMMAR : { prefix: catalogue.criteriaPrefix, tail: catalogue.criteriaIdTail };
}

/**
 * A row's id as reported and compared: `<PREFIX>-<tail>` as written, whole --
 * `AC-12-001` is never `AC-12` -- except that a tail of one digit run is its
 * number (`AC-01` is `AC-1`), the reading every `AC-{n}` row always had.
 */
export function criterionId(prefix: string, tail: string): string {
  return /^\d+$/.test(tail) ? `${prefix}-${Number(tail)}` : `${prefix}-${tail}`;
}

/** The number a row is ordered by: its id's last digit run (`AC-12-003` is 3), or 0 when it has none. */
export function idNumber(tail: string): number {
  const runs = tail.match(/\d+/g);
  return runs === null ? 0 : Number(runs[runs.length - 1]);
}

/**
 * The id group an acceptance row `pattern` opens right after `<id>-`:
 * `^- AC-([0-9]+): ...` gives `[0-9]+`, `^- AC-([0-9]+-[0-9]{3}): ...` gives
 * `[0-9]+-[0-9]{3}`. A non-capturing or named group is read the same way. A
 * pattern with no group there declares no id shape and is refused, naming the
 * field: the shape is the catalogue's, never a binary default substituted for
 * it (zheref/nen#519 AC-3).
 */
function idTailOf(pattern: string, id: string, where: string): string {
  const refuse = (why: string): never => {
    throw new IssueShapeError(`${where} declares no criterion id shape: ${why}. Write the id as a group right after '${id}-', e.g. '^- ${id}-([0-9]+): ...'.`);
  };
  const marker = `${id}-(`;
  const at = pattern.indexOf(marker);
  if (at < 0) return refuse(`no group opens right after '${id}-'`);
  const open = at + marker.length - 1;
  let depth = 0;
  let inClass = false;
  let close = -1;
  for (let index = open; index < pattern.length; index += 1) {
    const char = pattern[index] as string;
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (inClass) {
      if (char === "]") inClass = false;
      continue;
    }
    if (char === "[") inClass = true;
    else if (char === "(") depth += 1;
    else if (char === ")") {
      depth -= 1;
      if (depth === 0) {
        close = index;
        break;
      }
    }
  }
  if (close < 0) return refuse(`the group after '${id}-' never closes`);
  let tail = pattern.slice(open + 1, close);
  if (tail.startsWith("?:")) tail = tail.slice(2);
  else if (/^\?<[A-Za-z_$][\w$]*>/.test(tail)) tail = tail.replace(/^\?<[A-Za-z_$][\w$]*>/, "");
  else if (tail.startsWith("?")) return refuse(`the group after '${id}-' is a lookaround, not the id`);
  let compiled: RegExp;
  try {
    compiled = new RegExp(`^(?:${tail})$`);
  } catch (error) {
    return refuse(`its id group '${tail}' does not compile (${error instanceof Error ? error.message : String(error)})`);
  }
  if (tail === "" || compiled.test("")) return refuse(`its id group '${tail}' matches an empty id`);
  return tail;
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
    throw new IssueShapeError(`the catalogue is not a JSON object -- expected '{ "sections": { ... }, "kinds": { ... } }'.`);
  }
  const contract = raw["contract"];
  if (contract !== undefined && typeof contract !== "string") throw new IssueShapeError("'contract', when given, is a string.");
  if (isRecord(raw["sections"])) return parseSectionsV1(raw, typeof contract === "string" ? contract : null);
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
  const kinds: Record<string, KindRule> = {};
  for (const [kind, ids] of Object.entries(rawKinds)) {
    if (kind.startsWith("$")) continue;
    if (!Array.isArray(ids) || ids.length === 0 || !ids.every((item): boolean => typeof item === "string")) {
      throw new IssueShapeError(`kind '${kind}' is not a non-empty array of section ids.`);
    }
    const unknown = (ids as string[]).filter((item): boolean => !seen.has(item));
    if (unknown.length > 0) throw new IssueShapeError(`kind '${kind}' names undeclared section(s): ${unknown.join(", ")}.`);
    kinds[kind] = { required: ids as string[], optional: [] };
  }
  if (Object.keys(kinds).length === 0) throw new IssueShapeError("'kinds' declares no kind.");
  const criteriaSections = sections.filter((section): boolean => section.rows?.prefix === DEFAULT_CRITERIA_PREFIX).map((section): string => section.id);
  return {
    contract: typeof contract === "string" ? contract : null,
    sections,
    kinds,
    vagueAdjectives: readVague(raw),
    defaultKind: null,
    noneText: null,
    technologyTerms: null,
    criteriaPrefix: DEFAULT_CRITERIA_PREFIX,
    criteriaIdTail: DEFAULT_CRITERION_ID_TAIL,
    criteriaSections,
    questions: null,
  };
}

function readVague(raw: Record<string, unknown>): string[] {
  const rawVague = raw["vagueAdjectives"] ?? [];
  if (!Array.isArray(rawVague) || !rawVague.every((item): boolean => typeof item === "string" && item.trim() !== "")) {
    throw new IssueShapeError("'vagueAdjectives', when given, is an array of non-empty strings.");
  }
  return (rawVague as string[]).map((word): string => word.trim());
}

function stringList(value: unknown, where: string, allowEmpty = false): string[] {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0) || !value.every((item): boolean => typeof item === "string" && item !== "")) {
    throw new IssueShapeError(`${where} is not ${allowEmpty ? "an" : "a non-empty"} array of non-empty strings.`);
  }
  return value as string[];
}

/** The row id a v1 `prefix` pattern names: `^- AC-` -> `AC`, `^- (~~)?OQ-` -> `OQ`. */
function rowIdOf(prefixPattern: string, where: string): string {
  const match = /([A-Za-z][A-Za-z0-9]*)-$/.exec(prefixPattern);
  if (match === null) throw new IssueShapeError(`${where}.prefix '${prefixPattern}' names no row id ending in '-' (e.g. "^- AC-").`);
  return match[1] as string;
}

/**
 * The `hatsu.issue-sections/v1` shape: `sections` an object of `{ heading,
 * rows?, none? }`, `kinds.<kind>` `{ template, required, optional }`, `common`
 * the sections an issue checked with no kind carries, top-level `rows` with
 * per-row `pattern`, `prefix`, `measure`, `resolvedPattern`, `noneText`, and
 * `technologyTerms` (advisories on acceptance rows). Every heading is level 2.
 */
function parseSectionsV1(raw: Record<string, unknown>, contract: string | null): IssueSectionsCatalogue {
  const rawSections = raw["sections"] as Record<string, unknown>;
  const rawRows = raw["rows"] ?? {};
  if (!isRecord(rawRows)) throw new IssueShapeError("'rows', when given, is an object of row id -> { pattern, prefix, ... }.");
  const rowRules = new Map<string, RowRule>();
  for (const [key, entry] of Object.entries(rawRows)) {
    if (key.startsWith("$")) continue;
    if (!isRecord(entry) || typeof entry["pattern"] !== "string" || typeof entry["prefix"] !== "string") {
      throw new IssueShapeError(`rows.${key} is not a { pattern, prefix } pair of strings.`);
    }
    compiles(entry["pattern"], `rows.${key}`);
    compiles(entry["prefix"], `rows.${key}.prefix`);
    for (const field of ["measure", "resolvedPattern"] as const) {
      if (entry[field] !== undefined) {
        if (typeof entry[field] !== "string") throw new IssueShapeError(`rows.${key}.${field}, when given, is a string.`);
        compiles(entry[field] as string, `rows.${key}.${field}`);
      }
    }
    const rowId = rowIdOf(entry["prefix"], `rows.${key}`);
    rowRules.set(key, {
      prefix: rowId,
      contiguous: true,
      pattern: entry["pattern"],
      ...(typeof entry["resolvedPattern"] === "string" ? { resolvedPattern: entry["resolvedPattern"] } : {}),
      ...(typeof entry["measure"] === "string" ? { measure: entry["measure"] } : {}),
      ...(key === "acceptance" ? { technology: true, idTail: idTailOf(entry["pattern"], rowId, `rows.${key}.pattern`) } : {}),
    });
  }
  const sections: SectionRule[] = [];
  const rowsOf = new Map<string, string>();
  for (const [id, entry] of Object.entries(rawSections)) {
    if (id.startsWith("$")) continue;
    if (!isRecord(entry) || typeof entry["heading"] !== "string" || foldTitle(entry["heading"]) === "") {
      throw new IssueShapeError(`sections.${id} has no string 'heading'.`);
    }
    let rows: RowRule | undefined;
    if (entry["rows"] !== undefined) {
      const key = entry["rows"];
      if (typeof key !== "string" || !rowRules.has(key)) throw new IssueShapeError(`sections.${id}.rows names '${String(key)}', which 'rows' does not declare.`);
      rows = rowRules.get(key) as RowRule;
      rowsOf.set(id, key);
    }
    if (entry["none"] !== undefined && typeof entry["none"] !== "boolean") throw new IssueShapeError(`sections.${id}.none is not a boolean.`);
    sections.push({ id, title: [entry["heading"]], level: 2, content: [], ...(rows === undefined ? {} : { rows }), ...(entry["none"] === true ? { none: true } : {}) });
  }
  if (sections.length === 0) throw new IssueShapeError("'sections' declares no section -- a catalogue with no sections would pass every body having checked nothing.");
  const declared = new Set(sections.map((section): string => section.id));
  const known = (ids: string[], where: string): string[] => {
    const unknown = ids.filter((item): boolean => !declared.has(item));
    if (unknown.length > 0) throw new IssueShapeError(`${where} names undeclared section(s): ${unknown.join(", ")}.`);
    return ids;
  };
  const rawKinds = raw["kinds"];
  if (!isRecord(rawKinds)) throw new IssueShapeError("'kinds' is not an object of kind -> { required, optional }.");
  const kinds: Record<string, KindRule> = {};
  for (const [kind, entry] of Object.entries(rawKinds)) {
    if (kind.startsWith("$")) continue;
    if (!isRecord(entry)) throw new IssueShapeError(`kinds.${kind} is not a { required, optional } object.`);
    kinds[kind] = {
      required: known(stringList(entry["required"], `kinds.${kind}.required`), `kinds.${kind}.required`),
      optional: known(stringList(entry["optional"] ?? [], `kinds.${kind}.optional`, true), `kinds.${kind}.optional`),
    };
  }
  let defaultKind: string | null = null;
  if (raw["common"] !== undefined) {
    const common = known(stringList(raw["common"], "'common'"), "'common'");
    if (kinds["common"] !== undefined) throw new IssueShapeError("'kinds' declares a kind named 'common', which the top-level 'common' list already names.");
    kinds["common"] = { required: common, optional: [] };
    defaultKind = "common";
  }
  if (Object.keys(kinds).length === 0) throw new IssueShapeError("'kinds' declares no kind.");
  const noneText = raw["noneText"];
  if (noneText !== undefined) {
    if (typeof noneText !== "string") throw new IssueShapeError("'noneText', when given, is a string pattern.");
    compiles(noneText, "'noneText'");
  }
  let technologyTerms: TechnologyTerms | null = null;
  const rawTech = raw["technologyTerms"];
  if (rawTech !== undefined) {
    if (!isRecord(rawTech)) throw new IssueShapeError("'technologyTerms', when given, is an object of { words, patterns }.");
    const words = stringList(rawTech["words"] ?? [], "technologyTerms.words", true);
    const rawPatterns = rawTech["patterns"] ?? [];
    if (!Array.isArray(rawPatterns)) throw new IssueShapeError("technologyTerms.patterns is not an array of { id, pattern }.");
    const patterns = rawPatterns.map((entry: unknown, at: number): { id: string; pattern: string } => {
      if (!isRecord(entry) || typeof entry["id"] !== "string" || typeof entry["pattern"] !== "string") {
        throw new IssueShapeError(`technologyTerms.patterns[${at}] is not an { id, pattern } pair of strings.`);
      }
      compiles(entry["pattern"], `technologyTerms.patterns[${at}]`);
      return { id: entry["id"], pattern: entry["pattern"] };
    });
    technologyTerms = { words, patterns };
  }
  const acceptance = rowRules.get("acceptance");
  const question = isRecord(rawRows["question"]) ? rawRows["question"] : null;
  const questions =
    question !== null && typeof question["pattern"] === "string" && typeof question["resolvedPattern"] === "string"
      ? { pattern: question["pattern"], resolvedPattern: question["resolvedPattern"] }
      : null;
  return {
    contract,
    sections,
    kinds,
    vagueAdjectives: readVague(raw),
    defaultKind,
    noneText: typeof noneText === "string" ? noneText : null,
    technologyTerms,
    criteriaPrefix: acceptance?.prefix ?? DEFAULT_CRITERIA_PREFIX,
    criteriaIdTail: acceptance?.idTail ?? DEFAULT_CRITERION_ID_TAIL,
    criteriaSections: [...rowsOf.entries()].filter(([, key]): boolean => key === "acceptance").map(([id]): string => id),
    questions,
  };
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
  if (catalogue.defaultKind !== null) return catalogue.defaultKind;
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
export interface MaskedLine {
  readonly line: number;
  readonly text: string;
}

/**
 * The body's lines with fenced code blanked and HTML comments removed; inline
 * code is masked too unless `keepInlineCode` (../issue/criteria.ts reads a
 * criterion's text and a verify row's evidence, where inline code is content).
 */
export function maskedLines(body: string, options: { readonly keepInlineCode?: boolean } = {}): MaskedLine[] {
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
    masked.push({ line: index + 1, text: options.keepInlineCode === true ? stripped.text : stripped.text.replace(/(`+)(?!`)[\s\S]*?(?<!`)\1(?!`)/g, " ") });
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

export type MissKind = "missing" | "empty" | "content" | "no-rows" | "row-order" | "row-unmeasurable" | "row-shape";

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
  readonly kind: "vague" | "technology";
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

/** A list item or table row whose first token is `<prefix>-<n>` (bold, struck or code-quoted spans allowed). */
function rowPattern(prefix: string): RegExp {
  return new RegExp(`^\\s*(?:(?:[-*+]|\\d{1,9}[.)])\\s+(?:\\[[ xX]\\]\\s+)?|\\|\\s*)(?:\\*\\*|__|~~|\\*|_)*${escapeRegExp(prefix)}-(\\d{1,9})\\b(.*)$`);
}

// --- the one id-row grammar ----------------------------------------------------
//
// ONE READING of a numbered row (`AC-{n}`, `OQ-{n}`, ...) for `issue
// body-check`, `issue criteria`, `issue questions` and `pr converge`
// (delivery round on zheref/nen#498, readings 2 and 21). A row is a LIST ITEM
// -- `-`, `*`, `+`, `1.` or `1)`, up to three spaces of indent, an optional
// task-list checkbox `[ ]` / `[x]` -- whose first token is the id, bold or
// underscored spellings of the id read. The ADMITTED criterion shape is then
// `<PREFIX>-<n>:` and its text. A list item whose first token is the id in no
// admitted shape, or one inside a blockquote, is UNRECOGNISED: reported with
// its line, never dropped and never counted.

/** A list item's lead: indent, an optional blockquote run, the marker, an optional task-list checkbox. */
const LIST_LEAD = /^(\s{0,3}(?:>\s?)*)\s*(?:[-*+]|\d{1,9}[.)])\s+(?:\[[ xX]\]\s+)?/;

export interface IdRow {
  /** The row's whole id, `criterionId`'s reading: `AC-3`, `AC-12-001`. */
  readonly id: string;
  /** The id's last digit run (`idNumber`): what row order is checked by. */
  readonly number: number;
  /** The text after `<PREFIX>-<id>:`, trimmed. */
  readonly text: string;
  readonly line: number;
  /** The row as `- <PREFIX>-<id>: <text>`, the form a catalogue pattern is matched against. */
  readonly canonical: string;
}

export interface IdRowsRead {
  readonly rows: readonly IdRow[];
  readonly unrecognised: readonly { readonly line: number; readonly text: string }[];
  /** List items (outside blockquotes) whose first token is not the id: what a v1 rows section calls not-a-row. */
  readonly otherItems: readonly { readonly line: number; readonly text: string; readonly rest: string }[];
}

/**
 * Read the `<prefix>-<id>` rows of `lines` in the one admitted grammar. The id
 * after `<prefix>-` is `tail`, a regular-expression source: one number when
 * none is given (every `SC-`, `AS-`, `OQ-` row), the criterion grammar's
 * shape for acceptance rows (zheref/nen#519). Given a `tail`, a row's
 * `canonical` carries its id as written, so a catalogue pattern is matched
 * against what the row says.
 */
export function readIdRows(lines: readonly MaskedLine[], prefix: string, tail?: string): IdRowsRead {
  const id = escapeRegExp(prefix);
  const shape = tail ?? ROW_ID_TAIL;
  const first = new RegExp(`^(?:\\*\\*|__|~~|\\*|_)*${id}-(?:\\d|(?:${shape}))`);
  const admitted = new RegExp(`^(?:\\*\\*|__)?${id}-(?<nenRowId>${shape})(?:\\*\\*|__)?\\s*:(?:\\*\\*|__)?\\s*(?<nenRowText>.*)$`);
  const rows: IdRow[] = [];
  const unrecognised: { line: number; text: string }[] = [];
  const otherItems: { line: number; text: string; rest: string }[] = [];
  for (const line of lines) {
    const lead = LIST_LEAD.exec(line.text);
    if (lead === null) continue;
    const quoted = (lead[1] ?? "").includes(">");
    const rest = line.text.slice(lead[0].length);
    if (!first.test(rest)) {
      if (!quoted) otherItems.push({ line: line.line, text: line.text.trim(), rest });
      continue;
    }
    const match = admitted.exec(rest);
    if (quoted || match === null) {
      unrecognised.push({ line: line.line, text: line.text.trim() });
      continue;
    }
    const written = match.groups?.["nenRowId"] as string;
    const text = (match.groups?.["nenRowText"] as string).trim();
    const rowId = criterionId(prefix, written);
    rows.push({ id: rowId, number: idNumber(written), text, line: line.line, canonical: `- ${tail === undefined ? rowId : `${prefix}-${written}`}: ${text}` });
  }
  return { rows, unrecognised, otherItems };
}

/** The masked lines of the sections `ids` name (every heading matching one), in document order. */
export function sectionLines(body: string, catalogue: IssueSectionsCatalogue, ids: readonly string[], options: { readonly keepInlineCode?: boolean } = {}): MaskedLine[] {
  const read = readLines(body, { strictFences: true });
  const masked = maskedLines(body, options);
  const picked = new Set<number>();
  for (const id of ids) {
    const rule = catalogue.sections.find((section): boolean => section.id === id);
    if (rule === undefined) continue;
    read.forEach((line, index): void => {
      if (!headingMatches(rule, line)) return;
      for (const at of extentOf(read, index, (line as { level: number }).level)) picked.add(at);
    });
  }
  return [...picked].sort((a, b): number => a - b).map((at): MaskedLine => masked[at] as MaskedLine);
}

function wordPattern(word: string): RegExp {
  return new RegExp(`(?<![\\p{L}\\p{N}_-])${escapeRegExp(word)}(?![\\p{L}\\p{N}_-])`, "iu");
}

/**
 * Check one issue body against the catalogue's sections for `kind`.
 *
 * A SECTION IS `missing` when no heading matches it, `empty` when its heading
 * carries no content line before the next heading at its level or higher (a
 * deeper sub-heading is structure; content under it counts). An optional
 * section is never missing, and is empty only when its heading is present
 * with nothing under it. A `none` section whose only line matches the
 * catalogue's `noneText` is satisfied without rows. A present section is then
 * held to its content rules and its row rule; every failure is a miss. Vague
 * adjectives, and technology terms on acceptance rows, are ADVISORIES:
 * reported with their line, never a miss.
 */
export function checkIssueBody(body: string, catalogue: IssueSectionsCatalogue, kind: string): IssueBodyReport {
  const spec = catalogue.kinds[kind];
  if (spec === undefined) throw new IssueShapeError(`kind '${kind}' is not declared in the catalogue.`);
  const read = readLines(body, { strictFences: true });
  const masked = maskedLines(body);
  const sections: SectionReport[] = [];
  const misses: Miss[] = [];
  const rows: Row[] = [];
  const advisories: Advisory[] = [];
  const none = catalogue.noneText === null ? null : new RegExp(catalogue.noneText, "i");
  const wanted = [...spec.required.map((id): [string, boolean] => [id, true]), ...spec.optional.map((id): [string, boolean] => [id, false])];
  for (const [id, required] of wanted) {
    const rule = catalogue.sections.find((section): boolean => section.id === id) as SectionRule;
    const title = rule.title[0] as string;
    const headings = read.flatMap((line, index): number[] => (headingMatches(rule, line) ? [index] : []));
    if (headings.length === 0) {
      if (!required) continue;
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
    const contentLines = extent.flatMap((at): string[] => { const line = read[at]; return line?.kind === "content" && line.text.trim() !== "" ? [line.text.trim()] : []; });
    const text = extent.map((at): string => { const line = read[at]; return line?.kind === "content" ? line.text : ""; }).join("\n");
    for (const content of rule.content) {
      if (!new RegExp(content.pattern, "im").test(text)) {
        misses.push({ section: id, kind: "content", line: headingIndex + 1, detail: `'${title}' does not satisfy '${content.name}'` });
      }
    }
    if (rule.none === true && none !== null && contentLines.length === 1 && none.test(contentLines[0] as string)) continue;
    if (rule.rows === undefined) continue;
    const prefix = rule.rows.prefix;
    const rowMissesFrom = misses.length;
    let found: { id: string; number: number; rest: string; line: number }[];
    if (rule.rows.pattern === undefined) {
      const pattern = rowPattern(prefix);
      found = extent.flatMap((at): { id: string; number: number; rest: string; line: number }[] => {
        const line = masked[at] as MaskedLine;
        const match = pattern.exec(line.text);
        return match === null ? [] : [{ id: `${prefix}-${Number(match[1])}`, number: Number(match[1]), rest: match[2] ?? "", line: line.line }];
      });
    } else {
      // The v1 shape: every list item in a rows section is a row in its pattern's shape.
      const lines = extent.map((at): MaskedLine => masked[at] as MaskedLine);
      const idRows = readIdRows(lines, prefix, rule.rows.idTail);
      const open = new RegExp(rule.rows.pattern);
      const resolved = rule.rows.resolvedPattern === undefined ? null : new RegExp(rule.rows.resolvedPattern);
      const idFirst = new RegExp(`^(?:~~)?${escapeRegExp(prefix)}-(\\d{1,9})`);
      found = [];
      const tryRow = (line: number, canonical: string, rowId: string, number: number, rest: string): void => {
        if (open.test(canonical) || (resolved !== null && resolved.test(canonical))) found.push({ id: rowId, number, rest, line });
        else misses.push({ section: rule.id, kind: "row-shape", line, detail: `not the ${prefix} row shape: '${canonical}'` });
      };
      for (const row of idRows.rows) tryRow(row.line, row.canonical, row.id, row.number, row.text);
      for (const row of idRows.unrecognised) {
        // A resolved question row (`~~OQ-1~~ → A: ...`) carries no colon after its id: matched as written.
        const lead = LIST_LEAD.exec(row.text);
        const quoted = lead !== null && (lead[1] ?? "").includes(">");
        const rest = lead === null ? row.text : row.text.slice(lead[0].length);
        const number = idFirst.exec(rest.replace(/^(?:\*\*|__)/, ""));
        if (!quoted && resolved !== null && number !== null) tryRow(row.line, `- ${rest}`, `${prefix}-${Number(number[1])}`, Number(number[1]), rest);
        else misses.push({ section: rule.id, kind: "row-shape", line: row.line, detail: `a row naming ${prefix}-<n> in no admitted shape: '${row.text}'` });
      }
      for (const item of idRows.otherItems) {
        if (rule.none === true && none !== null && none.test(item.text)) continue;
        misses.push({ section: rule.id, kind: "row-shape", line: item.line, detail: `a list item that is not a ${prefix} row: '${item.text}'` });
      }
      found.sort((a, b): number => a.line - b.line);
      const shaped = misses.splice(rowMissesFrom).sort((a, b): number => (a.line ?? 0) - (b.line ?? 0));
      misses.push(...shaped);
    }
    for (const row of found) rows.push({ section: id, id: row.id, number: row.number, line: row.line });
    if (found.length === 0 && rule.none !== true) {
      misses.push({ section: id, kind: "no-rows", line: headingIndex + 1, detail: `'${title}' carries no ${prefix}-{n} row` });
    }
    if (rule.rows.contiguous) {
      const numbered = new Set<number>();
      found.forEach((row, position): void => {
        if (numbered.has(row.number)) {
          misses.push({ section: id, kind: "row-order", line: row.line, detail: `${row.id} repeats an earlier row's number` });
        } else if (row.number !== position + 1) {
          misses.push({ section: id, kind: "row-order", line: row.line, detail: `${row.id} is row ${position + 1}; rows are numbered ${prefix}-1 to ${prefix}-${found.length} in order` });
        }
        numbered.add(row.number);
      });
    }
    const measure = rule.rows.measure !== undefined ? new RegExp(rule.rows.measure) : rule.rows.measurable ? /[0-9]|%/ : null;
    if (measure !== null) {
      for (const row of found) {
        if (!measure.test(row.rest)) {
          misses.push({ section: id, kind: "row-unmeasurable", line: row.line, detail: `${row.id} states no number or percentage` });
        }
      }
    }
    if (rule.rows.technology === true && catalogue.technologyTerms !== null) {
      const terms = catalogue.technologyTerms;
      for (const row of found) {
        const source = masked.find((line): boolean => line.line === row.line);
        const raw = body.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n")[row.line - 1] ?? source?.text ?? "";
        const after = raw.replace(LIST_LEAD, "").replace(new RegExp(`^(?:\\*\\*|__)?${escapeRegExp(prefix)}-(?:${rule.rows.idTail ?? ROW_ID_TAIL})(?:\\*\\*|__)?\\s*:\\s*`), "");
        for (const word of terms.words) if (wordPattern(word).test(after)) advisories.push({ kind: "technology", word, line: row.line });
        for (const pattern of terms.patterns) {
          const hit = new RegExp(pattern.pattern).exec(after);
          if (hit !== null) advisories.push({ kind: "technology", word: `${pattern.id} '${hit[0].trim()}'`, line: row.line });
        }
      }
    }
  }
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

/**
 * nen's default open-question grammar: exactly the rows Hatsu's catalogue
 * (`hatsu.issue-sections/v1`, rows.question) admits. A resolved row carries
 * its answer, its date and its ruling reference; one lacking any of them is
 * unrecognised, never resolved (HR-4). A caller's `--requirements-from`
 * catalogue replaces both patterns.
 */
export const DEFAULT_QUESTION_GRAMMAR: QuestionGrammar = {
  pattern: "^- OQ-([0-9]+) \\(([^()]+)\\): .+$",
  resolvedPattern: "^- ~~OQ-([0-9]+)~~ → A: .+ \\(([0-9]{4}-[0-9]{2}-[0-9]{2}), [^()]+\\)$",
};
const ANY_OQ = /OQ-\d/;
const NEEDS_MARKER = /\[NEEDS(?:[ \t]+([^\]:\n]+?))?[ \t]*(?::[^\]\n]*)?\]/g;

/**
 * Count an issue body's open questions, resolved ones and `[NEEDS ...]`
 * markers. Counts only: whether a build may start with an open question is
 * the caller's rule. A row is a list item (task-list checkbox folded); its
 * text is matched against the grammar's open and resolved patterns. Any list
 * row -- a blockquoted one included -- that names `OQ-{n}` and matches
 * neither is listed as unrecognised rather than dropped or counted as either.
 */
export function countQuestions(body: string, grammar: QuestionGrammar = DEFAULT_QUESTION_GRAMMAR): QuestionsReport {
  const open: OpenQuestion[] = [];
  const resolved: ResolvedQuestion[] = [];
  const needsMarkers: NeedsMarker[] = [];
  const unrecognised: { line: number; text: string }[] = [];
  const openPattern = new RegExp(grammar.pattern);
  const resolvedPattern = new RegExp(grammar.resolvedPattern);
  for (const line of maskedLines(body)) {
    const lead = LIST_LEAD.exec(line.text);
    if (lead !== null) {
      const quoted = (lead[1] ?? "").includes(">");
      const canonical = `- ${line.text.slice(lead[0].length).trimEnd()}`;
      const openMatch = quoted ? null : openPattern.exec(canonical);
      const resolvedMatch = quoted || openMatch !== null ? null : resolvedPattern.exec(canonical);
      const id = (match: RegExpExecArray): string => (/^[- ~*_]*([A-Za-z][A-Za-z0-9]*-)/.exec(canonical)?.[1] ?? "OQ-") + String(Number(match[1]));
      if (openMatch !== null) {
        open.push({ id: id(openMatch), number: Number(openMatch[1]), gate: (openMatch[2] ?? "").trim(), line: line.line });
      } else if (resolvedMatch !== null) {
        resolved.push({ id: id(resolvedMatch), number: Number(resolvedMatch[1]), line: line.line });
      } else if (ANY_OQ.test(line.text)) {
        unrecognised.push({ line: line.line, text: line.text.trim() });
      }
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
