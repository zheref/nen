// src/issue/criteria.ts -- acceptance-criterion coverage as data (Hatsu's
// ruling HR-11): the AC rows an issue body carries, and the comparison of
// those rows against a pull request body's verify rows. Behind
// `nen issue criteria` and `nen pr converge`.
//
// TWO LISTS COMPARED, BY THE CALLER'S RULES. The issue's `- AC-{n}: ...` rows
// are one list; the PR body's `| <criterion> | <word> | <evidence> |` rows are
// the other. Each criterion is reported with the row that names it (or the
// lack of one), the vocabulary word that row carries and whether it carries
// evidence. Which words block, which word a `none` row says and whether
// evidence is required are the caller's catalogue's (`CoveragePolicy`); nen's
// defaults equal Hatsu's interim guard (scripts/pr_criteria_check.mts), which
// Hatsu retires at its repin (delivery round on zheref/nen#498, reading 3).
//
// WHAT IS NEVER A PASS. An issue that carries no AC row yields a
// `not-verifiable` row, which blocks -- there was nothing to compare, which is
// not the same as everything being covered -- and a pull request that closes
// no issue reports `verifiable: false`. A row nen cannot read (an unknown word, the
// wrong number of cells) is `malformed-row`, never skipped, and two rows for
// one criterion are `duplicate-rows`: nen will not pick one.

import { escapeRegExp } from "../pr/template.js";
import { criterionGrammar, criterionId, DEFAULT_CRITERION_GRAMMAR, maskedLines, readIdRows, sectionLines, type CriterionGrammar, type IssueSectionsCatalogue } from "./shape.js";

/** The `--json` contract of `nen issue criteria`. */
export const ISSUE_CRITERIA_CONTRACT = "nen.issue.criteria/v0.1";
/** The `--json` contract of `nen pr converge`. */
export const PR_CONVERGE_CONTRACT = "nen.pr.converge/v0.1";

// --- the issue side: `- AC-{n}: text` ----------------------------------------

export interface Criterion {
  /** The whole id: `AC-3`, or an epic-scoped `AC-12-001`, never truncated (zheref/nen#519). */
  readonly id: string;
  /** The id's last digit run: `AC-3` is 3, `AC-12-001` is 1. Rows are matched by `id`, never by this. */
  readonly number: number;
  readonly text: string;
  readonly line: number;
}

export interface CriteriaReport {
  /** False when the body carries no AC row: nothing to verify, never "all verified". */
  readonly verifiable: boolean;
  readonly criteria: readonly Criterion[];
  /** An AC number stated on more than one row, with every line; each row is still listed in `criteria`. */
  readonly duplicates: readonly { readonly id: string; readonly lines: readonly number[] }[];
  /** List rows whose first token is `AC-{n}` in no admitted shape (or inside a blockquote): never dropped, never a criterion. */
  readonly unrecognised: readonly { readonly line: number; readonly text: string }[];
}

/**
 * Every acceptance-criterion row of an issue body, in document order, outside
 * fenced code and HTML comments, read in ./shape.ts's one id-row grammar
 * (`readIdRows`): a list item -- `-`, `*`, `+`, `1.`, `1)`, a task-list
 * checkbox allowed -- whose first token is `<PREFIX>-<id>` and a colon. With a
 * catalogue the prefix is the catalogue's acceptance-row prefix, the id's
 * shape is the group its acceptance row pattern declares (zheref/nen#519
 * AC-3), and rows are read inside its acceptance section(s) only, exactly as
 * `issue body-check` reads them; with none the prefix is `AC`, the id is
 * one number or several joined by hyphens (`AC-3`, `AC-12-001`) and the
 * whole body is read. A list row naming the id in no admitted shape is
 * `unrecognised`.
 */
export function extractCriteria(body: string, catalogue: IssueSectionsCatalogue | null = null): CriteriaReport {
  const grammar = criterionGrammar(catalogue);
  const scope =
    catalogue === null || catalogue.criteriaSections.length === 0
      ? maskedLines(body, { keepInlineCode: true })
      : sectionLines(body, catalogue, catalogue.criteriaSections, { keepInlineCode: true });
  const read = readIdRows(scope, grammar.prefix, grammar.tail);
  const criteria: Criterion[] = read.rows.map((row): Criterion => ({ id: row.id, number: row.number, text: row.text, line: row.line }));
  const lines = new Map<string, number[]>();
  for (const criterion of criteria) lines.set(criterion.id, [...(lines.get(criterion.id) ?? []), criterion.line]);
  const duplicates = [...lines.entries()]
    .filter(([, at]): boolean => at.length > 1)
    .map(([id, at]): { id: string; lines: number[] } => ({ id, lines: at }));
  return { verifiable: criteria.length > 0, criteria, duplicates, unrecognised: read.unrecognised };
}

// --- the PR side: `| <criterion> | <word> | <evidence> |` --------------------

/** The coverage vocabulary a verify row's second cell carries (HR-11). */
export const COVERAGE_WORDS = ["satisfied", "partial", "missing", "contradicts", "unrequested"] as const;
export type CoverageWord = (typeof COVERAGE_WORDS)[number];

/** How a verify row names its criterion: by the criterion's whole id (`criterionId`'s reading). */
export type RowCriterion =
  | { readonly kind: "id"; readonly id: string }
  | { readonly kind: "qualified"; readonly prefix: string | null; readonly issue: number; readonly id: string }
  | { readonly kind: "none" };

export interface VerifyRow {
  readonly line: number;
  /** The table line as written, trimmed: what a refusal quotes (zheref/nen#479 AC-3). */
  readonly raw: string;
  /** The first cell as written, trimmed. */
  readonly cell: string;
  readonly criterion: RowCriterion | null;
  readonly word: CoverageWord | null;
  readonly evidence: string;
  /** Why the row could not be read in full; null when it was. */
  readonly problem: string | null;
}

const WRAPPER = /^(?:\*\*|__|`)(.*)(?:\*\*|__|`)$/;

/** The verify-row cell grammar for one criterion grammar: a bare id, and an issue-qualified one. */
function cellPatterns(grammar: CriterionGrammar): { bare: RegExp; qualified: RegExp; mention: RegExp } {
  const id = `${escapeRegExp(grammar.prefix)}-(?<nenCellId>${grammar.tail})`;
  return {
    bare: new RegExp(`^${id}$`),
    qualified: new RegExp(`^(?<nenCellPrefix>[A-Za-z][A-Za-z0-9]*|[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+)?#(?<nenCellIssue>\\d{1,9})\\/${id}$`),
    mention: new RegExp(`${escapeRegExp(grammar.prefix)}-`, "i"),
  };
}

function unwrap(cell: string): string {
  let text = cell.trim();
  for (let match = WRAPPER.exec(text); match !== null; match = WRAPPER.exec(text)) text = (match[1] as string).trim();
  return text;
}

/** A table line's cells, split on unescaped pipes (GFM: a pipe inside a code span splits too unless escaped). */
function cellsOf(text: string): string[] | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("|")) return null;
  const cells: string[] = [];
  let current = "";
  for (let index = 1; index < trimmed.length; index += 1) {
    const char = trimmed[index] as string;
    if (char === "\\" && trimmed[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  if (current.trim() !== "") cells.push(current);
  return cells.map((cell): string => cell.trim());
}

function parseCriterionCell(cell: string, grammar: CriterionGrammar): RowCriterion | null {
  const text = unwrap(cell);
  if (/^none$/i.test(text)) return { kind: "none" };
  const patterns = cellPatterns(grammar);
  const bare = patterns.bare.exec(text);
  if (bare !== null) return { kind: "id", id: criterionId(grammar.prefix, bare.groups?.["nenCellId"] as string) };
  const qualified = patterns.qualified.exec(text);
  if (qualified !== null) {
    const groups = qualified.groups as Record<string, string | undefined>;
    return { kind: "qualified", prefix: groups["nenCellPrefix"] ?? null, issue: Number(groups["nenCellIssue"]), id: criterionId(grammar.prefix, groups["nenCellId"] as string) };
  }
  return null;
}

/**
 * Every verify row of a PR body: a table line, outside fenced code and HTML
 * comments, whose first cell names a criterion (`AC-{n}`,
 * `<CODE>#<N>/AC-{n}`, `<owner/name>#<N>/AC-{n}`, `#<N>/AC-{n}`) or `none`.
 * The id after the prefix is read in `grammar` -- the closing issues' own
 * criterion grammar, so `NN#519/AC-12-001` names `AC-12-001` whole
 * (zheref/nen#519 AC-2). A first cell that mentions the prefix and is none of
 * those is a malformed row, listed with its problem rather than dropped.
 * Header and separator rows name no criterion and are not rows here.
 */
export function readVerifyRows(body: string, grammar: CriterionGrammar = DEFAULT_CRITERION_GRAMMAR): VerifyRow[] {
  const rows: VerifyRow[] = [];
  const mention = cellPatterns(grammar).mention;
  const p = grammar.prefix;
  for (const line of maskedLines(body, { keepInlineCode: true })) {
    const cells = cellsOf(line.text);
    if (cells === null || cells.length === 0) continue;
    const first = cells[0] as string;
    const criterion = parseCriterionCell(first, grammar);
    if (criterion === null) {
      if (mention.test(first)) {
        rows.push({ line: line.line, raw: line.text.trim(), cell: first, criterion: null, word: null, evidence: "", problem: `'${first}' is not a criterion: write ${p}-<n>, <CODE>#<N>/${p}-<n>, <owner/name>#<N>/${p}-<n> or none` });
      }
      continue;
    }
    if (cells.length !== 3) {
      rows.push({ line: line.line, raw: line.text.trim(), cell: first, criterion, word: null, evidence: "", problem: `the row has ${cells.length} cell(s); a verify row has three: criterion, coverage word, evidence` });
      continue;
    }
    const rawWord = unwrap(cells[1] as string).toLowerCase();
    const word = (COVERAGE_WORDS as readonly string[]).includes(rawWord) ? (rawWord as CoverageWord) : null;
    // ONE STATUS PER ROW (zheref/nen#479 AC-2): a cell naming two or more of the
    // five words ('satisfied, partial', 'partial/missing') is refused by name,
    // never read as either.
    const named = word === null ? COVERAGE_WORDS.filter((candidate): boolean => new RegExp(`\\b${candidate}\\b`).test(rawWord)) : [];
    rows.push({
      line: line.line,
      raw: line.text.trim(),
      cell: first,
      criterion,
      word,
      evidence: cells[2] as string,
      problem:
        word !== null
          ? null
          : named.length > 1
            ? `'${(cells[1] as string).trim()}' carries more than one status (${named.join(", ")}); a verify row carries exactly one of ${COVERAGE_WORDS.join(", ")}`
            : `'${(cells[1] as string).trim()}' is not a coverage word: one of ${COVERAGE_WORDS.join(", ")}`,
    });
  }
  return rows;
}

/** Evidence that says nothing: empty, a dash, or a `<placeholder>` left from the template. */
export function hasEvidence(evidence: string): boolean {
  const text = evidence.trim();
  return text !== "" && !/^[-–—]+$/.test(text) && !/^<[^<>]*>$/.test(text);
}

// --- the comparison ----------------------------------------------------------

/** One closing issue as the comparison sees it: where it lives and its body's criteria. */
export interface ClosingIssue {
  /** `owner/name`. */
  readonly target: string;
  readonly number: number;
  readonly report: CriteriaReport;
  /** How the issue is named in a report, when it is not `owner/name#N` (a `--criteria` list read off the command line). */
  readonly label?: string;
}

export type Coverage =
  | "covered-with-evidence"
  | "covered-without-evidence"
  | "missing-row"
  | "malformed-row"
  | "duplicate-rows"
  | "not-verifiable";

export interface CriterionCoverage {
  /** `owner/name#N`. */
  readonly issue: string;
  /** `AC-{n}`; null on a `not-verifiable` row, which stands for an issue with no criterion. */
  readonly id: string | null;
  readonly text: string | null;
  readonly coverage: Coverage;
  /** The row's vocabulary word when exactly one readable row names the criterion. */
  readonly word: CoverageWord | null;
  readonly evidence: string | null;
  /** The verify row lines that name this criterion (several on duplicate-rows). */
  readonly rows: readonly number[];
  /** The one row as written, when exactly one row names the criterion: quoted by a refusal. */
  readonly raw: string | null;
}

export interface UnmatchedRow {
  readonly line: number;
  readonly cell: string;
  readonly reason: string;
}

export interface ConvergeReport {
  /** False when the PR closes no issue or any closing issue states no criterion. */
  readonly verifiable: boolean;
  readonly criteria: readonly CriterionCoverage[];
  /** `none` rows: a change no criterion asked for, with their word and evidence. */
  readonly unrequested: readonly { readonly line: number; readonly word: CoverageWord | null; readonly evidence: string; readonly problem: string | null }[];
  /** Rows naming a criterion no closing issue carries, or naming one ambiguously. */
  readonly unmatched: readonly UnmatchedRow[];
  /** Rows whose first cell mentions AC- and names no criterion. */
  readonly malformed: readonly UnmatchedRow[];
  readonly counts: Readonly<Record<Coverage, number>> & { readonly words: Readonly<Record<CoverageWord, number>> };
  /** One line per row that sets exit 1: a criterion, an unrecognised issue row, a none row with a problem, an unmatched or malformed verify row. */
  readonly blocking: readonly string[];
}

/**
 * The caller's coverage rules: which words block, which word a `none` row
 * carries, and whether a row's evidence is required. They are the caller's
 * catalogue's (`--requirements-from`, its `coverage` block); nen's defaults
 * equal Hatsu's current rules (scripts/pr_criteria_check.mts), so the verb
 * behaves the same with no catalogue.
 */
export interface CoveragePolicy {
  readonly blocking: readonly CoverageWord[];
  readonly noneWord: CoverageWord;
  readonly evidenceRequired: boolean;
}

export const DEFAULT_COVERAGE_POLICY: CoveragePolicy = { blocking: ["missing", "contradicts"], noneWord: "unrequested", evidenceRequired: true };

/** A catalogue's `coverage` block over the defaults; refuses (throws Error with the field) rather than skipping. */
export function readCoveragePolicy(raw: unknown): CoveragePolicy {
  if (raw === undefined) return DEFAULT_COVERAGE_POLICY;
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) throw new Error("'coverage', when given, is an object of { blocking, none, evidence }.");
  const entry = raw as Record<string, unknown>;
  const word = (value: unknown, where: string): CoverageWord => {
    if (typeof value !== "string" || !(COVERAGE_WORDS as readonly string[]).includes(value)) throw new Error(`${where} '${String(value)}' is not one of ${COVERAGE_WORDS.join(", ")}.`);
    return value as CoverageWord;
  };
  const blocking = entry["blocking"] === undefined ? DEFAULT_COVERAGE_POLICY.blocking : Array.isArray(entry["blocking"]) ? entry["blocking"].map((item): CoverageWord => word(item, "coverage.blocking")) : null;
  if (blocking === null) throw new Error("coverage.blocking is not an array of coverage words.");
  const evidence = entry["evidence"];
  if (evidence !== undefined && evidence !== "required" && evidence !== "optional") throw new Error("coverage.evidence is 'required' or 'optional'.");
  return {
    blocking,
    noneWord: entry["none"] === undefined ? DEFAULT_COVERAGE_POLICY.noneWord : word(entry["none"], "coverage.none"),
    evidenceRequired: evidence === undefined ? DEFAULT_COVERAGE_POLICY.evidenceRequired : evidence === "required",
  };
}

/** The coverages that make `nen pr converge` exit 1 whatever the policy says. */
const BLOCKING_COVERAGE: ReadonlySet<Coverage> = new Set(["missing-row", "malformed-row", "duplicate-rows", "not-verifiable"]);

/**
 * Which closing issues a row's criterion can name. A bare `AC-{n}` names every
 * closing issue that states AC-{n}; `#N/AC-{n}` names closing issue N, and a
 * prefix holding a slash must be that issue's repository. A CODE prefix is
 * echoed and never resolved. Ids are compared whole: `AC-12` never names
 * `AC-12-001`.
 */
function candidates(criterion: RowCriterion, issues: readonly ClosingIssue[]): ClosingIssue[] {
  if (criterion.kind === "none") return [];
  const id = criterion.id;
  return issues.filter((issue): boolean => {
    if (!issue.report.criteria.some((entry): boolean => entry.id === id)) return false;
    if (criterion.kind === "id") return true;
    if (issue.number !== criterion.issue) return false;
    const prefix = criterion.prefix;
    return prefix === null || !prefix.includes("/") || prefix.toLowerCase() === issue.target.toLowerCase();
  });
}

/**
 * Compare the closing issues' criteria with the PR body's verify rows. The
 * catalogue the issues' criteria were read with is the one the verify rows'
 * ids are read with: one criterion grammar for both lists (zheref/nen#519).
 */
export function converge(issues: readonly ClosingIssue[], prBody: string, policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY, catalogue: IssueSectionsCatalogue | null = null): ConvergeReport {
  const grammar = criterionGrammar(catalogue);
  const rows = readVerifyRows(prBody, grammar);
  const byKey = new Map<string, VerifyRow[]>();
  const unrequested: ConvergeReport["unrequested"][number][] = [];
  const unmatched: UnmatchedRow[] = [];
  const malformed: UnmatchedRow[] = [];
  const key = (issue: ClosingIssue, id: string): string => `${issue.target.toLowerCase()}#${issue.number}/${id}`;
  for (const row of rows) {
    if (row.criterion === null) {
      malformed.push({ line: row.line, cell: row.cell, reason: row.problem ?? "unreadable" });
      continue;
    }
    if (row.criterion.kind === "none") {
      const problem =
        row.problem ??
        (row.word !== policy.noneWord
          ? `a none row says ${policy.noneWord}, not '${row.word}': it names no criterion to be ${row.word}`
          : policy.evidenceRequired && !hasEvidence(row.evidence)
            ? "the none row carries no evidence (empty, a dash or a <placeholder>)"
            : null);
      unrequested.push({ line: row.line, word: row.word, evidence: row.evidence, problem });
      continue;
    }
    const found = candidates(row.criterion, issues);
    if (found.length === 0) {
      unmatched.push({ line: row.line, cell: row.cell, reason: "no closing issue states this criterion" });
    } else if (found.length > 1) {
      unmatched.push({
        line: row.line,
        cell: row.cell,
        reason: `ambiguous: ${found.map((issue): string => `${issue.target}#${issue.number}`).join(" and ")} each state ${row.criterion.id}; write <CODE>#<N>/${grammar.prefix}-<n>`,
      });
    } else {
      const at = key(found[0] as ClosingIssue, row.criterion.id);
      byKey.set(at, [...(byKey.get(at) ?? []), row]);
    }
  }

  const criteria: CriterionCoverage[] = [];
  for (const issue of issues) {
    const name = issue.label ?? `${issue.target}#${issue.number}`;
    if (!issue.report.verifiable) {
      criteria.push({ issue: name, id: null, text: null, coverage: "not-verifiable", word: null, evidence: null, rows: [], raw: null });
      continue;
    }
    const seen = new Set<string>();
    for (const criterion of issue.report.criteria) {
      if (seen.has(criterion.id)) continue;
      seen.add(criterion.id);
      const named = byKey.get(key(issue, criterion.id)) ?? [];
      const lines = named.map((row): number => row.line);
      const only = named.length === 1 ? (named[0] as VerifyRow) : null;
      let coverage: Coverage;
      if (only === null) coverage = named.length === 0 ? "missing-row" : "duplicate-rows";
      else if (only.problem !== null) coverage = "malformed-row";
      else coverage = hasEvidence(only.evidence) ? "covered-with-evidence" : "covered-without-evidence";
      criteria.push({
        issue: name,
        id: criterion.id,
        text: criterion.text,
        coverage,
        word: only?.word ?? null,
        evidence: only === null ? null : only.evidence,
        rows: lines,
        raw: only === null ? null : only.raw,
      });
    }
  }

  const coverageCounts: Record<Coverage, number> = {
    "covered-with-evidence": 0,
    "covered-without-evidence": 0,
    "missing-row": 0,
    "malformed-row": 0,
    "duplicate-rows": 0,
    "not-verifiable": 0,
  };
  const words: Record<CoverageWord, number> = { satisfied: 0, partial: 0, missing: 0, contradicts: 0, unrequested: 0 };
  const blocking: string[] = [];
  const blockingWords = new Set<CoverageWord>(policy.blocking);
  for (const entry of criteria) {
    coverageCounts[entry.coverage] += 1;
    if (entry.word !== null) words[entry.word] += 1;
    const where = `${entry.issue}/${entry.id ?? "-"}`;
    // The row is QUOTED wherever it is the reason (zheref/nen#479 AC-3): a
    // reader of a refused merge sees the line that refused it.
    const quoted = entry.raw === null ? "" : ` -- row line ${entry.rows[0] ?? "?"}: ${entry.raw}`;
    if (entry.coverage === "missing-row") blocking.push(`${where}: missing-row (no verify row names ${entry.id ?? "it"})`);
    else if (BLOCKING_COVERAGE.has(entry.coverage)) blocking.push(`${where}: ${entry.coverage === "not-verifiable" ? "not-verifiable (the issue states no criterion)" : entry.coverage}${quoted}`);
    else if (entry.word !== null && blockingWords.has(entry.word)) blocking.push(`${where}: ${entry.word}${quoted}`);
    else if (entry.word === policy.noneWord) blocking.push(`${where}: ${entry.word} on a criterion (only a none row says ${policy.noneWord})`);
    else if (entry.coverage === "covered-without-evidence" && policy.evidenceRequired) blocking.push(`${where}: no evidence`);
  }
  for (const issue of issues) {
    for (const row of issue.report.unrecognised) blocking.push(`${issue.label ?? `${issue.target}#${issue.number}`}: unrecognised criterion row at line ${row.line}`);
  }
  for (const row of unrequested) if (row.problem !== null) blocking.push(`none row line ${row.line}: ${row.problem}`);
  for (const row of unmatched) blocking.push(`row line ${row.line} '${row.cell}': unmatched -- ${row.reason}`);
  for (const row of malformed) blocking.push(`row line ${row.line}: malformed -- ${row.reason}`);
  return {
    verifiable: issues.length > 0 && issues.every((issue): boolean => issue.report.verifiable),
    criteria,
    unrequested,
    unmatched,
    malformed,
    counts: { ...coverageCounts, words },
    blocking,
  };
}
