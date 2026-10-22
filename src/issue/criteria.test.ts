// The pure half of acceptance-criterion coverage (./criteria.ts): the AC rows
// of an issue body, the verify rows of a PR body, and their comparison.

import { describe, expect, it } from "vitest";
import { converge, extractCriteria, hasEvidence, readVerifyRows, type ClosingIssue } from "./criteria.js";

const ISSUE = [
  "## Acceptance criteria",
  "",
  "- AC-1: the verb lists every row",
  "- AC-2: an unread issue exits 2 with `nen pr converge`",
  "",
  "```md",
  "- AC-9: inside a fence, an example",
  "```",
  "<!-- - AC-8: inside a comment -->",
  "Paragraph naming AC-7 is prose.",
].join("\n");

function issue(body: string, number = 12, target = "o/n"): ClosingIssue {
  return { target, number, report: extractCriteria(body) };
}

describe("extractCriteria", () => {
  it("reads '- AC-{n}: text' list rows outside fences and comments, keeping inline code", () => {
    const report = extractCriteria(ISSUE);
    expect(report.verifiable).toBe(true);
    expect(report.criteria).toEqual([
      { id: "AC-1", number: 1, text: "the verb lists every row", line: 3 },
      { id: "AC-2", number: 2, text: "an unread issue exits 2 with `nen pr converge`", line: 4 },
    ]);
    expect(report.duplicates).toEqual([]);
  });

  it("reports a body with no AC row as not verifiable, and a repeated number as a duplicate", () => {
    expect(extractCriteria("## Problem\n\nNo criteria here.\n")).toEqual({ verifiable: false, criteria: [], duplicates: [], unrecognised: [] });
    const twice = extractCriteria("- AC-1: a\n* AC-1: b\n");
    expect(twice.criteria).toHaveLength(2);
    expect(twice.duplicates).toEqual([{ id: "AC-1", lines: [1, 2] }]);
  });
});

describe("readVerifyRows", () => {
  it("reads the three-cell rows, every criterion spelling, and flags what it cannot read", () => {
    const rows = readVerifyRows(
      [
        "| Criterion | Coverage | Evidence |",
        "|---|---|---|",
        "| AC-1 | satisfied | `src/a.test.ts` 'lists rows' |",
        "| NN#12/AC-2 | **Partial** | a \\| b |",
        "| o/n#12/AC-3 | done | x |",
        "| #12/AC-4 | missing |",
        "| none | unrequested | refactor |",
        "| AC-1, AC-2 | satisfied | x |",
        "| <CODE>#<N>/AC-<k> | <satisfied · partial> | <evidence> |",
        "<!-- | AC-5 | satisfied | commented out | -->",
      ].join("\n"),
    );
    expect(rows.map((row) => [row.line, row.criterion?.kind ?? null, row.word, row.evidence, row.problem === null])).toEqual([
      [3, "id", "satisfied", "`src/a.test.ts` 'lists rows'", true],
      [4, "qualified", "partial", "a | b", true],
      [5, "qualified", null, "x", false],
      [6, "qualified", null, "", false],
      [7, "none", "unrequested", "refactor", true],
      [8, null, null, "", false],
      // A template placeholder left in the body is listed, never silently skipped.
      [9, null, null, "", false],
    ]);
  });

  it("holds evidence to saying something: empty, a dash or a placeholder is none", () => {
    expect(hasEvidence("src/x.test.ts:12")).toBe(true);
    for (const empty of ["", "  ", "-", "—", "<test name, path:line or scenario>"]) expect(hasEvidence(empty)).toBe(false);
  });
});

describe("converge", () => {
  it("covers every criterion with a readable row and exits clean (no blocking)", () => {
    const report = converge([issue(ISSUE)], "| AC-1 | satisfied | t1 |\n| AC-2 | partial | |\n");
    expect(report.verifiable).toBe(true);
    expect(report.criteria.map((entry) => [entry.id, entry.coverage, entry.word, entry.rows])).toEqual([
      ["AC-1", "covered-with-evidence", "satisfied", [1]],
      ["AC-2", "covered-without-evidence", "partial", [2]],
    ]);
    // Evidence is required by default (Hatsu's rule): the empty cell blocks.
    expect(report.blocking).toEqual(["o/n#12/AC-2: no evidence"]);
    expect(converge([issue(ISSUE)], "| AC-1 | satisfied | t1 |\n| AC-2 | partial | |\n", { blocking: ["missing", "contradicts"], noneWord: "unrequested", evidenceRequired: false }).blocking).toEqual([]);
    expect(report.counts.words.partial).toBe(1);
  });

  it("blocks on a missing row, a malformed row, duplicate rows, and the words missing and contradicts", () => {
    const body = "- AC-1: a\n- AC-2: b\n- AC-3: c\n- AC-4: d\n- AC-5: e\n";
    const report = converge(
      [issue(body)],
      "| AC-2 | done | x |\n| AC-3 | satisfied | x |\n| AC-3 | partial | y |\n| AC-4 | missing | x |\n| AC-5 | contradicts | x |\n",
    );
    expect(report.blocking).toEqual([
      "o/n#12/AC-1: missing-row",
      "o/n#12/AC-2: malformed-row",
      "o/n#12/AC-3: duplicate-rows",
      "o/n#12/AC-4: missing",
      "o/n#12/AC-5: contradicts",
    ]);
    expect(report.criteria.find((entry) => entry.id === "AC-3")?.rows).toEqual([2, 3]);
  });

  it("yields a not-verifiable row for an issue with no criterion, never a pass, and is not verifiable with no closing issue", () => {
    const report = converge([issue("No criteria.", 13)], "");
    expect(report.criteria).toEqual([{ issue: "o/n#13", id: null, text: null, coverage: "not-verifiable", word: null, evidence: null, rows: [] }]);
    expect(report.verifiable).toBe(false);
    expect(report.blocking).toEqual(["o/n#13/-: not-verifiable (the issue states no criterion)"]);
    expect(converge([], "| AC-1 | satisfied | x |").verifiable).toBe(false);
  });

  it("matches a qualified row to its issue, and refuses to pick for a bare id two issues state", () => {
    const issues = [issue("- AC-1: a\n", 12), issue("- AC-1: b\n", 14, "o/other")];
    const bare = converge(issues, "| AC-1 | satisfied | x |\n");
    expect(bare.unmatched).toEqual([{ line: 1, cell: "AC-1", reason: "ambiguous: o/n#12 and o/other#14 each state AC-1; write <CODE>#<N>/AC-<n>" }]);
    expect(bare.blocking).toEqual([
      "o/n#12/AC-1: missing-row",
      "o/other#14/AC-1: missing-row",
      "row line 1 'AC-1': unmatched -- ambiguous: o/n#12 and o/other#14 each state AC-1; write <CODE>#<N>/AC-<n>",
    ]);
    const qualified = converge(issues, "| NN#12/AC-1 | satisfied | x |\n| o/other#14/AC-1 | satisfied | y |\n| o/n#14/AC-1 | satisfied | z |\n");
    expect(qualified.blocking).toEqual(["row line 3 'o/n#14/AC-1': unmatched -- no closing issue states this criterion"]);
    expect(qualified.unmatched).toEqual([{ line: 3, cell: "o/n#14/AC-1", reason: "no closing issue states this criterion" }]);
  });

  it("lists unrequested rows, rows naming no stated criterion, and malformed first cells", () => {
    const report = converge([issue("- AC-1: a\n")], "| AC-1 | satisfied | x |\n| none | unrequested | tidy |\n| AC-9 | satisfied | x |\n| AC-x | satisfied | x |\n| none | satisfied | y |\n");
    expect(report.unrequested).toEqual([
      { line: 2, word: "unrequested", evidence: "tidy", problem: null },
      { line: 5, word: "satisfied", evidence: "y", problem: "a none row says unrequested, not 'satisfied': it names no criterion to be satisfied" },
    ]);
    expect(report.unmatched.map((row) => row.cell)).toEqual(["AC-9"]);
    expect(report.malformed.map((row) => row.line)).toEqual([4]);
    expect(report.blocking).toEqual([
      "none row line 5: a none row says unrequested, not 'satisfied': it names no criterion to be satisfied",
      "row line 3 'AC-9': unmatched -- no closing issue states this criterion",
      "row line 4: malformed -- 'AC-x' is not a criterion: write AC-<n>, <CODE>#<N>/AC-<n>, <owner/name>#<N>/AC-<n> or none",
    ]);
  });
});

describe("the one AC row grammar (delivery round on #498, readings 2 and 21)", () => {
  it("admits checkbox, numbered, starred and bold rows, and lists a row naming AC-n in no admitted shape as unrecognised", () => {
    const report = extractCriteria(["- [ ] AC-1: a", "- [x] AC-2: b", "1. AC-3: c", "* **AC-4**: d", "- AC-5 no colon", "> - AC-6: quoted"].join("\n"));
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-1", "AC-2", "AC-3", "AC-4"]);
    expect(report.unrecognised.map((row) => row.line)).toEqual([5, 6]);
  });

  it("reads criteria inside the catalogue's acceptance section only, with the catalogue's prefix", async () => {
    const { parseCatalogue } = await import("./shape.js");
    const catalogue = parseCatalogue({
      sections: { acceptance: { heading: "Acceptance criteria", rows: "acceptance" }, notes: { heading: "Plan notes" } },
      kinds: { k: { required: ["acceptance"], optional: ["notes"] } },
      rows: { acceptance: { pattern: "^- CR-([0-9]+): .+$", prefix: "^- CR-" } },
    });
    const body = "## Acceptance criteria\n\n- CR-1: one\n\n## Plan notes\n\n- CR-2: not a criterion here\n- AC-1: nor this\n";
    const report = extractCriteria(body, catalogue);
    expect(report.criteria.map((row) => row.id)).toEqual(["CR-1"]);
  });
});
