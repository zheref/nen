// src/issue/criteria.ts -- acceptance-criterion coverage as data (Hatsu's
// ruling HR-11): the AC rows an issue body carries, and the comparison of
// those rows against a pull request body's verify rows. Behind
// `nen issue criteria` and `nen pr converge`.
//
// TWO LISTS COMPARED, NOTHING DECIDED. The issue's `- AC-{n}: ...` rows are one
// list; the PR body's `| <criterion> | <word> | <evidence> |` rows are the
// other. Each criterion is reported with the row that names it (or the lack of
// one), the vocabulary word that row carries and whether it carries evidence.
// Whether a `partial` is acceptable, or whether a PR may land with an issue
// that states no criterion, is the caller's rule. The exit code only says
// which of the facts below were found.
//
// WHAT IS NEVER A PASS. An issue that carries no AC row yields a
// `not-verifiable` row -- there was nothing to compare, which is not the same
// as everything being covered -- and a pull request that closes no issue
// reports `verifiable: false`. A row nen cannot read (an unknown word, the
// wrong number of cells) is `malformed-row`, never skipped, and two rows for
// one criterion are `duplicate-rows`: nen will not pick one.

import { maskedLines } from "./shape.js";

/** The `--json` contract of `nen issue criteria`. */
export const ISSUE_CRITERIA_CONTRACT = "nen.issue.criteria/v0.1";
/** The `--json` contract of `nen pr converge`. */
export const PR_CONVERGE_CONTRACT = "nen.pr.converge/v0.1";

// --- the issue side: `- AC-{n}: text` ----------------------------------------

export interface Criterion {
  readonly id: string;
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
}

/** A list row whose first token is `AC-{n}` followed by a colon: `- AC-3: text`. */
const AC_ROW = /^\s{0,3}[-*+]\s+AC-(\d{1,9})\s*:\s*(.*)$/;

/**
 * Every `- AC-{n}: …` row of an issue body, in document order, outside fenced
 * code and HTML comments. Nothing else is a criterion: a heading, a paragraph
 * or a table row naming AC-1 is prose about it.
 */
export function extractCriteria(body: string): CriteriaReport {
  const criteria: Criterion[] = [];
  for (const line of maskedLines(body, { keepInlineCode: true })) {
    const match = AC_ROW.exec(line.text);
    if (match === null) continue;
    const number = Number(match[1]);
    criteria.push({ id: `AC-${number}`, number, text: (match[2] as string).trim(), line: line.line });
  }
  const lines = new Map<string, number[]>();
  for (const criterion of criteria) lines.set(criterion.id, [...(lines.get(criterion.id) ?? []), criterion.line]);
  const duplicates = [...lines.entries()]
    .filter(([, at]): boolean => at.length > 1)
    .map(([id, at]): { id: string; lines: number[] } => ({ id, lines: at }));
  return { verifiable: criteria.length > 0, criteria, duplicates };
}

// --- the PR side: `| <criterion> | <word> | <evidence> |` --------------------

/** The coverage vocabulary a verify row's second cell carries (HR-11). */
export const COVERAGE_WORDS = ["satisfied", "partial", "missing", "contradicts", "unrequested"] as const;
export type CoverageWord = (typeof COVERAGE_WORDS)[number];

/** How a verify row names its criterion. */
export type RowCriterion =
  | { readonly kind: "id"; readonly number: number }
  | { readonly kind: "qualified"; readonly prefix: string | null; readonly issue: number; readonly number: number }
  | { readonly kind: "none" };

export interface VerifyRow {
  readonly line: number;
  /** The first cell as written, trimmed. */
  readonly cell: string;
  readonly criterion: RowCriterion | null;
  readonly word: CoverageWord | null;
  readonly evidence: string;
  /** Why the row could not be read in full; null when it was. */
  readonly problem: string | null;
}

const WRAPPER = /^(?:\*\*|__|`)(.*)(?:\*\*|__|`)$/;
const BARE_ID = /^AC-(\d{1,9})$/;
const QUALIFIED_ID = /^([A-Za-z][A-Za-z0-9]*|[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+)?#(\d{1,9})\/AC-(\d{1,9})$/;

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

function parseCriterionCell(cell: string): RowCriterion | null {
  const text = unwrap(cell);
  if (/^none$/i.test(text)) return { kind: "none" };
  const bare = BARE_ID.exec(text);
  if (bare !== null) return { kind: "id", number: Number(bare[1]) };
  const qualified = QUALIFIED_ID.exec(text);
  if (qualified !== null) {
    return { kind: "qualified", prefix: qualified[1] ?? null, issue: Number(qualified[2]), number: Number(qualified[3]) };
  }
  return null;
}

/**
 * Every verify row of a PR body: a table line, outside fenced code and HTML
 * comments, whose first cell names a criterion (`AC-{n}`,
 * `<CODE>#<N>/AC-{n}`, `<owner/name>#<N>/AC-{n}`, `#<N>/AC-{n}`) or `none`.
 * A first cell that mentions `AC-` and is none of those is a malformed row,
 * listed with its problem rather than dropped. Header and separator rows name
 * no criterion and are not rows here.
 */
export function readVerifyRows(body: string): VerifyRow[] {
  const rows: VerifyRow[] = [];
  for (const line of maskedLines(body, { keepInlineCode: true })) {
    const cells = cellsOf(line.text);
    if (cells === null || cells.length === 0) continue;
    const first = cells[0] as string;
    const criterion = parseCriterionCell(first);
    if (criterion === null) {
      if (/AC-/i.test(first)) {
        rows.push({ line: line.line, cell: first, criterion: null, word: null, evidence: "", problem: `'${first}' is not a criterion: write AC-<n>, <CODE>#<N>/AC-<n>, <owner/name>#<N>/AC-<n> or none` });
      }
      continue;
    }
    if (cells.length !== 3) {
      rows.push({ line: line.line, cell: first, criterion, word: null, evidence: "", problem: `the row has ${cells.length} cell(s); a verify row has three: criterion, coverage word, evidence` });
      continue;
    }
    const rawWord = unwrap(cells[1] as string).toLowerCase();
    const word = (COVERAGE_WORDS as readonly string[]).includes(rawWord) ? (rawWord as CoverageWord) : null;
    rows.push({
      line: line.line,
      cell: first,
      criterion,
      word,
      evidence: cells[2] as string,
      problem: word === null ? `'${(cells[1] as string).trim()}' is not a coverage word: one of ${COVERAGE_WORDS.join(", ")}` : null,
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
  /** `<issue>/<id>: <reason>` for every criterion that sets exit 1. */
  readonly blocking: readonly string[];
}

/** The coverages and words that make `nen pr converge` exit 1. */
const BLOCKING_COVERAGE: ReadonlySet<Coverage> = new Set(["missing-row", "malformed-row", "duplicate-rows"]);
const BLOCKING_WORDS: ReadonlySet<CoverageWord> = new Set(["missing", "contradicts"]);

/**
 * Which closing issues a row's criterion can name. A bare `AC-{n}` names every
 * closing issue that states AC-{n}; `#N/AC-{n}` names closing issue N, and a
 * prefix holding a slash must be that issue's repository. A CODE prefix is
 * echoed and never resolved.
 */
function candidates(criterion: RowCriterion, issues: readonly ClosingIssue[]): ClosingIssue[] {
  if (criterion.kind === "none") return [];
  const number = criterion.number;
  return issues.filter((issue): boolean => {
    if (!issue.report.criteria.some((entry): boolean => entry.number === number)) return false;
    if (criterion.kind === "id") return true;
    if (issue.number !== criterion.issue) return false;
    const prefix = criterion.prefix;
    return prefix === null || !prefix.includes("/") || prefix.toLowerCase() === issue.target.toLowerCase();
  });
}

/** Compare the closing issues' criteria with the PR body's verify rows. */
export function converge(issues: readonly ClosingIssue[], prBody: string): ConvergeReport {
  const rows = readVerifyRows(prBody);
  const byKey = new Map<string, VerifyRow[]>();
  const unrequested: ConvergeReport["unrequested"][number][] = [];
  const unmatched: UnmatchedRow[] = [];
  const malformed: UnmatchedRow[] = [];
  const key = (issue: ClosingIssue, number: number): string => `${issue.target.toLowerCase()}#${issue.number}/AC-${number}`;
  for (const row of rows) {
    if (row.criterion === null) {
      malformed.push({ line: row.line, cell: row.cell, reason: row.problem ?? "unreadable" });
      continue;
    }
    if (row.criterion.kind === "none") {
      unrequested.push({ line: row.line, word: row.word, evidence: row.evidence, problem: row.problem });
      continue;
    }
    const found = candidates(row.criterion, issues);
    if (found.length === 0) {
      unmatched.push({ line: row.line, cell: row.cell, reason: "no closing issue states this criterion" });
    } else if (found.length > 1) {
      unmatched.push({
        line: row.line,
        cell: row.cell,
        reason: `ambiguous: ${found.map((issue): string => `${issue.target}#${issue.number}`).join(" and ")} each state AC-${row.criterion.number}; write <CODE>#<N>/AC-<n>`,
      });
    } else {
      const at = key(found[0] as ClosingIssue, row.criterion.number);
      byKey.set(at, [...(byKey.get(at) ?? []), row]);
    }
  }

  const criteria: CriterionCoverage[] = [];
  for (const issue of issues) {
    const name = `${issue.target}#${issue.number}`;
    if (!issue.report.verifiable) {
      criteria.push({ issue: name, id: null, text: null, coverage: "not-verifiable", word: null, evidence: null, rows: [] });
      continue;
    }
    const seen = new Set<number>();
    for (const criterion of issue.report.criteria) {
      if (seen.has(criterion.number)) continue;
      seen.add(criterion.number);
      const named = byKey.get(key(issue, criterion.number)) ?? [];
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
  for (const entry of criteria) {
    coverageCounts[entry.coverage] += 1;
    if (entry.word !== null) words[entry.word] += 1;
    const where = `${entry.issue}/${entry.id ?? "-"}`;
    if (BLOCKING_COVERAGE.has(entry.coverage)) blocking.push(`${where}: ${entry.coverage}`);
    else if (entry.word !== null && BLOCKING_WORDS.has(entry.word)) blocking.push(`${where}: ${entry.word}`);
  }
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
