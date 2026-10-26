// The criterion id grammar (zheref/nen#519): an epic-scoped `AC-{epic}-{nnn}`
// row is a criterion with its FULL id across `issue criteria`, `issue
// body-check` and `pr converge`, and when a catalogue is given the id shape is
// the one its acceptance row pattern declares, never the binary's.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Command } from "../cli/command.js";
import { prCommand } from "../pr/command.js";
import { issueCommand } from "./command.js";
import { converge, extractCriteria, readVerifyRows, type ClosingIssue } from "./criteria.js";
import { checkIssueBody, IssueShapeError, parseCatalogue } from "./shape.js";

async function run(
  command: Command,
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  options: { repoFlag?: string | null; json?: boolean } = {},
): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const code = await runFamily(command, argv, options.repoFlag ?? null, options.json ?? false, io, new ScriptedSeams(script));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

const EPIC_BODY = "## Acceptance criteria\n\n- AC-12-001: first\n- AC-12-002: second\n";

/** A `hatsu.issue-sections/v1` catalogue whose acceptance pattern declares the id shape in its first group. */
function catalogueWith(acceptancePattern: string): ReturnType<typeof parseCatalogue> {
  return parseCatalogue({
    contract: "test.issue-sections/v1",
    sections: { acceptance: { heading: "Acceptance criteria", rows: "acceptance" }, success: { heading: "Success criteria", rows: "success" } },
    common: ["acceptance"],
    kinds: { k: { required: ["acceptance"], optional: ["success"] } },
    rows: {
      acceptance: { pattern: acceptancePattern, prefix: "^- AC-" },
      success: { pattern: "^- SC-([0-9]+): (.+)$", prefix: "^- SC-" },
    },
  });
}

/** Akatsuki's shape, as a fixture: its own catalogue is not reachable from this repository. */
const EPIC_CATALOGUE = (): ReturnType<typeof parseCatalogue> => catalogueWith("^- AC-([0-9]+-[0-9]{3}): .+$");
/** Hatsu's shape (contracts/issue-sections.json): `AC-{n}` only. */
const HATSU_CATALOGUE = (): ReturnType<typeof parseCatalogue> => catalogueWith("^- AC-([0-9]+): .+$");

function issue(body: string, number = 519, target = "zheref/nen", catalogue: ReturnType<typeof parseCatalogue> | null = null): ClosingIssue {
  return { target, number, report: extractCriteria(body, catalogue) };
}

describe("AC-1: an epic-scoped row is a criterion with its full id", () => {
  it("reads '- AC-12-001:' rows with no catalogue, none unrecognised and none truncated", () => {
    const report = extractCriteria("- AC-12-001: first\n- AC-12-002: second\n");
    expect(report.verifiable).toBe(true);
    expect(report.unrecognised).toEqual([]);
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-12-001", "AC-12-002"]);
    expect(report.criteria.map((row) => row.text)).toEqual(["first", "second"]);
  });

  it("keeps the bold, checkbox and numbered spellings, and the plain AC-{n} reading unchanged", () => {
    const report = extractCriteria(["- **AC-12-003**: bold", "- [x] AC-12-004: ticked", "1. AC-7: plain", "- AC-01: leading zero", "- AC-12-005 no colon"].join("\n"));
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-12-003", "AC-12-004", "AC-7", "AC-1"]);
    expect(report.unrecognised.map((row) => row.line)).toEqual([5]);
  });

  it("counts AC-12-001 and AC-12 as two ids, and two AC-12-001 rows as a duplicate", () => {
    const report = extractCriteria("- AC-12-001: a\n- AC-12: b\n- AC-12-001: c\n");
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-12-001", "AC-12", "AC-12-001"]);
    expect(report.duplicates).toEqual([{ id: "AC-12-001", lines: [1, 3] }]);
  });

  it("'nen issue criteria --body-file' lists the rows with their full ids", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-519-"));
    writeFileSync(join(dir, "ak.md"), "- AC-12-001: first\n- AC-12-002: second\n");
    const result = await run(issueCommand, ["issue", "criteria", "--body-file", "ak.md"], [], { repoFlag: dir });
    expect(result.code).toBe(0);
    expect(result.out.split("\n")).toEqual([expect.stringMatching(/^2 AC row\(s\), 0 duplicate number\(s\) -- '/), "AC-12-001 line 1: first", "AC-12-002 line 2: second"]);
  });
});

describe("AC-2: a verify row naming <CODE>#<N>/AC-12-001 matches that criterion in pr converge", () => {
  it("reads the full id off qualified and bare cells", () => {
    const rows = readVerifyRows("| NN#519/AC-12-001 | satisfied | x |\n| AC-12-002 | partial | y |\n| zheref/nen#519/AC-12-003 | satisfied | z |\n");
    expect(rows.map((row) => row.criterion)).toEqual([
      { kind: "qualified", prefix: "NN", issue: 519, id: "AC-12-001" },
      { kind: "id", id: "AC-12-002" },
      { kind: "qualified", prefix: "zheref/nen", issue: 519, id: "AC-12-003" },
    ]);
  });

  it("covers each epic criterion from its own row, and never matches AC-12 to AC-12-001", () => {
    const covered = converge([issue(EPIC_BODY)], "| NN#519/AC-12-001 | satisfied | t1 |\n| AC-12-002 | satisfied | t2 |\n");
    expect(covered.blocking).toEqual([]);
    expect(covered.criteria.map((row) => [row.id, row.coverage])).toEqual([
      ["AC-12-001", "covered-with-evidence"],
      ["AC-12-002", "covered-with-evidence"],
    ]);
    const truncated = converge([issue(EPIC_BODY)], "| NN#519/AC-12 | satisfied | t1 |\n| AC-12-002 | satisfied | t2 |\n");
    expect(truncated.criteria.map((row) => [row.id, row.coverage])).toEqual([
      ["AC-12-001", "missing-row"],
      ["AC-12-002", "covered-with-evidence"],
    ]);
    expect(truncated.unmatched.map((row) => row.cell)).toEqual(["NN#519/AC-12"]);
  });

  it("'nen pr converge' reports the epic criteria covered at exit 0", async () => {
    const VIEW = "gh pr view 5 --repo zheref/nen --json number,url,headRefOid,baseRefName,body,closingIssuesReferences";
    const body = "## Verify\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n| NN#519/AC-12-001 | satisfied | a.test.ts |\n| NN#519/AC-12-002 | partial | b.test.ts |\n";
    const closing = [{ number: 519, url: "https://github.com/zheref/nen/issues/519", repository: { name: "nen", owner: { login: "zheref" } } }];
    const result = await run(prCommand, ["pr", "converge", "--target", "zheref/nen", "--pr", "5"], [
      { match: VIEW, result: { stdout: JSON.stringify({ number: 5, url: "u", headRefOid: "abc1234", baseRefName: "main", body, closingIssuesReferences: closing }) } },
      { match: "gh api repos/zheref/nen/issues/519", result: { stdout: JSON.stringify({ number: 519, title: "t", state: "open", labels: [], body: EPIC_BODY }) } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.split("\n").slice(1)).toEqual(["COVERED-WITH-EVIDENCE  zheref/nen#519/AC-12-001 satisfied (line 5)", "COVERED-WITH-EVIDENCE  zheref/nen#519/AC-12-002 partial (line 6)"]);
  });
});

describe("AC-2 on pr body-check: a --criteria list and its verify rows read the same whole ids", () => {
  it("covers AC-12-001 from its row, refuses an AC-12 row for it, and refuses an AC-0 id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-519-body-"));
    writeFileSync(join(dir, "req.json"), JSON.stringify([{ name: "verify", pattern: "^## How to verify$" }]));
    const table = (rows: string): string => `## How to verify\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n${rows}`;
    writeFileSync(join(dir, "ok.md"), table("| AC-12-001 | satisfied | a.test.ts |\n| AC-12-002 | satisfied | b.test.ts |\n"));
    writeFileSync(join(dir, "short.md"), table("| AC-12 | satisfied | a.test.ts |\n| AC-12-002 | satisfied | b.test.ts |\n"));
    const argv = (body: string, ids: string): string[] => ["pr", "body-check", "--body-from", body, "--requirements-from", "req.json", "--criteria", ids];
    expect((await run(prCommand, argv("ok.md", "AC-12-001,AC-12-002"), [], { repoFlag: dir })).code).toBe(0);
    const short = await run(prCommand, argv("short.md", "AC-12-001,AC-12-002"), [], { repoFlag: dir });
    expect(short.code).toBe(1);
    expect(short.out).toContain("BLOCKING --criteria/AC-12-001: missing-row (no verify row names AC-12-001)");
    expect((await run(prCommand, argv("ok.md", "AC-0"), [], { repoFlag: dir })).code).toBe(2);
  });
});

describe("AC-3: with a catalogue, the id shape is its acceptance row pattern's", () => {
  it("an epic-shaped catalogue admits AC-12-001 and refuses AC-1", () => {
    const report = extractCriteria("## Acceptance criteria\n\n- AC-12-001: first\n- AC-1: plain\n", EPIC_CATALOGUE());
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-12-001"]);
    expect(report.unrecognised.map((row) => row.text)).toEqual(["- AC-1: plain"]);
  });

  it("an AC-{n} catalogue (Hatsu's shape) refuses AC-12-001 rather than reading a binary default", () => {
    const report = extractCriteria(EPIC_BODY, HATSU_CATALOGUE());
    expect(report.criteria).toEqual([]);
    expect(report.verifiable).toBe(false);
    expect(report.unrecognised.map((row) => row.text)).toEqual(["- AC-12-001: first", "- AC-12-002: second"]);
  });

  it("issue body-check reads the rows by the catalogue's id shape, with their full ids and in-order numbering", () => {
    const epic = checkIssueBody(EPIC_BODY, EPIC_CATALOGUE(), "k");
    expect(epic.misses).toEqual([]);
    expect(epic.rows.map((row) => row.id)).toEqual(["AC-12-001", "AC-12-002"]);
    const hatsu = checkIssueBody(EPIC_BODY, HATSU_CATALOGUE(), "k");
    expect(hatsu.misses.map((miss) => miss.kind)).toEqual(["row-shape", "row-shape", "no-rows"]);
  });

  it("pr converge with the catalogue matches only rows in its id shape", () => {
    const catalogue = EPIC_CATALOGUE();
    const report = converge([issue(EPIC_BODY, 519, "zheref/nen", catalogue)], "| NN#519/AC-12-001 | satisfied | t |\n| NN#519/AC-12-002 | satisfied | t |\n", undefined, catalogue);
    expect(report.blocking).toEqual([]);
  });

  it("a catalogue whose acceptance pattern declares no id group after the prefix is refused, naming the field", () => {
    expect(() => catalogueWith("^- AC-[0-9]+: .+$")).toThrow(IssueShapeError);
    expect(() => catalogueWith("^- AC-[0-9]+: .+$")).toThrow(/rows\.acceptance\.pattern/);
  });

  it("leaves SC rows untouched: an epic-shaped SC id is still a row-shape miss", () => {
    const report = checkIssueBody(`${EPIC_BODY}\n## Success criteria\n\n- SC-12-001: 90% of rows\n`, EPIC_CATALOGUE(), "k");
    expect(report.misses.map((miss) => [miss.section, miss.kind])).toEqual([["success", "row-shape"], ["success", "no-rows"]]);
  });
});
