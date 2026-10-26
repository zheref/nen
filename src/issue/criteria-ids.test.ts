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
import { checkIssueBody, criterionId, IssueShapeError, parseCatalogue } from "./shape.js";
import { convergeInputFromView, criteriaConjunct } from "../pr/converge.js";

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
    expect(result.out.split("\n")).toEqual([expect.stringMatching(/^2 AC row\(s\), 0 duplicate id\(s\) -- '/), "AC-12-001 line 1: first", "AC-12-002 line 2: second"]);
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

describe("hanten round 1 on #519", () => {
  it("F1: an id stated twice blocks converge, so one verify row never clears two criteria", () => {
    const report = converge([issue("- AC-1: login works\n- AC-01: logout revokes the token\n")], "| AC-1 | satisfied | test x |\n");
    expect(report.blocking).toEqual(["zheref/nen#519: duplicate criterion id AC-1 at lines 1, 2"]);
    expect(converge([issue("- AC-12-001: a\n- AC-12-001: b\n")], "| AC-12-001 | satisfied | t |\n").blocking).toEqual(["zheref/nen#519: duplicate criterion id AC-12-001 at lines 1, 2"]);
  });

  it("F2: a long digit run is a string, never a rounded number", () => {
    expect(criterionId("AC", "9007199254740993")).toBe("AC-9007199254740993");
    expect(criterionId("AC", "9007199254740993")).not.toBe(criterionId("AC", "9007199254740992"));
    expect(criterionId("AC", "0007")).toBe("AC-7");
    const rows = readVerifyRows("| AC-12345678901234567890 | satisfied | a |\n| AC-12345678901234567891 | satisfied | b |\n", { prefix: "AC", tail: "[0-9]+" });
    expect(rows.map((row) => (row.criterion?.kind === "id" ? row.criterion.id : null))).toEqual(["AC-12345678901234567890", "AC-12345678901234567891"]);
    // Under an unbounded catalogue shape, a run past nine digits is unrecognised: it is never ordered by a rounded number.
    const hatsu = extractCriteria("## Acceptance criteria\n\n- AC-9007199254740993: a\n- AC-9007199254740992: b\n", HATSU_CATALOGUE());
    expect(hatsu.criteria).toEqual([]);
    expect(hatsu.unrecognised.map((row) => row.line)).toEqual([3, 4]);
    // Two 20-digit epic ids stay two ids.
    const epic = extractCriteria("## Acceptance criteria\n\n- AC-12345678901234567890-001: a\n- AC-12345678901234567891-001: b\n", EPIC_CATALOGUE());
    expect(epic.criteria.map((row) => row.id)).toEqual(["AC-12345678901234567890-001", "AC-12345678901234567891-001"]);
    expect(epic.duplicates).toEqual([]);
  });

  it("F2: an escaped hyphen before the id group reads the same shape", () => {
    expect(catalogueWith("^- AC\\-([0-9]+): .+$").criteriaIdTail).toBe("[0-9]+");
  });

  it("F3: a catastrophically backtracking id group is refused, and a verify cell is bounded", () => {
    for (const bad of ["^- AC-((?:[0-9]+)+): .+$", "^- AC-((?:[0-9]|[0-9][0-9])+): .+$", "^- AC-([0-9]{1,}): .+$", "^- AC-(.+): .+$"]) {
      expect(() => catalogueWith(bad)).toThrow(/rows\.acceptance\.pattern/);
    }
    expect(catalogueWith("^- AC-([0-9]{1,9}(?:-[0-9]{1,9})*): .+$").criteriaIdTail).toBe("[0-9]{1,9}(?:-[0-9]{1,9})*");
    // Timed under the WIDEST admitted shape, on a cell built to backtrack it (N10).
    const widest = catalogueWith("^- AC-([0-9]{1,9}(?:-[0-9]{1,9})*): .+$");
    const cell = `AC-${"1-".repeat(30)}x`;
    expect(cell).toHaveLength(64);
    const started = performance.now();
    const rows = readVerifyRows(`| ${cell} | satisfied | e |\n`, { prefix: "AC", tail: widest.criteriaIdTail });
    expect(performance.now() - started).toBeLessThan(50);
    expect(rows[0]?.criterion).toBeNull();
    const long = readVerifyRows(`| AC-${"1-".repeat(40)}1 | satisfied | e |\n`);
    expect(long[0]?.problem).toMatch(/at most 64 characters/);
  });

  it("F4: a named group or a backreference in the id group is refused at parse time, never thrown later", () => {
    expect(() => catalogueWith("^- AC-((?<nenCellId>[0-9]+)): .+$")).toThrow(IssueShapeError);
    expect(() => catalogueWith("^- AC-(([0-9])\\2): .+$")).toThrow(/rows\.acceptance\.pattern/);
  });

  it("N1: order is kept within an epic, two epics each start at 001, and a miss names the expected id in the shape", () => {
    expect(checkIssueBody("## Acceptance criteria\n\n- AC-1-001: a\n- AC-1-002: b\n- AC-2-001: c\n", EPIC_CATALOGUE(), "k").misses).toEqual([]);
    const continued = checkIssueBody("## Acceptance criteria\n\n- AC-12-003: a\n- AC-12-004: b\n", EPIC_CATALOGUE(), "k");
    expect(continued.misses.map((miss) => miss.detail)).toEqual([
      "AC-12-003 is row 1 of AC-12-*; expected AC-12-001: rows are numbered AC-12-001 to AC-12-002 in order",
      "AC-12-004 is row 2 of AC-12-*; expected AC-12-002: rows are numbered AC-12-001 to AC-12-002 in order",
    ]);
    const repeated = checkIssueBody("## Acceptance criteria\n\n- AC-12-001: a\n- AC-12-001: b\n", EPIC_CATALOGUE(), "k");
    expect(repeated.misses.map((miss) => miss.detail)).toEqual(["AC-12-001 repeats an earlier row's id"]);
  });

  it("N2 and N6: under another prefix a cell naming the default AC- is malformed, and the problem names the shape", () => {
    const cr = parseCatalogue({
      sections: { acceptance: { heading: "Acceptance criteria", rows: "acceptance" } },
      kinds: { k: { required: ["acceptance"] } },
      rows: { acceptance: { pattern: "^- CR-([0-9]+-[0-9]{3}): .+$", prefix: "^- CR-" } },
    });
    const report = converge([issue("## Acceptance criteria\n\n- CR-1-001: a\n", 519, "zheref/nen", cr)], "| AC-1 | satisfied | x |\n", undefined, cr);
    expect(report.malformed).toEqual([{ line: 1, cell: "AC-1", reason: "'AC-1' is not a criterion: write CR-<id>, <CODE>#<N>/CR-<id>, <owner/name>#<N>/CR-<id> or none (<id> in the shape '[0-9]+-[0-9]{3}')" }]);
  });

  it("N3: the merge and composite path reads verify rows in the catalogue's grammar", () => {
    const cr = parseCatalogue({
      sections: { acceptance: { heading: "Acceptance criteria", rows: "acceptance" } },
      kinds: { k: { required: ["acceptance"] } },
      rows: { acceptance: { pattern: "^- CR-([0-9]+): .+$", prefix: "^- CR-" } },
    });
    const seams = new ScriptedSeams([{ match: "gh api repos/o/n/issues/7", result: { stdout: JSON.stringify({ number: 7, title: "t", state: "open", labels: [], body: "## Acceptance criteria\n\n- CR-1: one\n" }) } }]);
    const parsed = {
      number: 5,
      url: "u",
      headRefOid: "abc1234",
      baseRefName: "main",
      body: "Closes #7\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n| NN#7/CR-1 | satisfied | a.test.ts |\n",
      closingIssuesReferences: [{ number: 7, url: "https://github.com/o/n/issues/7", repository: { name: "n", owner: { login: "o" } } }],
    };
    const input = convergeInputFromView(seams, { owner: "o", repo: "n", slug: "o/n" }, 5, parsed, cr, "main");
    expect(criteriaConjunct(input).ok).toBe(true);
    const unthreaded = criteriaConjunct({ ...input, catalogue: null });
    expect(unthreaded.ok).toBe(false);
    expect(unthreaded.blocking).toEqual(["o/n#7/CR-1: missing-row (no verify row names CR-1)"]);
  });

  it("F5 and N9: two digit runs that meet with no dash between them are refused", () => {
    for (const bad of ["^- AC-([0-9]+-?[0-9]+): .+$", "^- AC-([0-9]+[0-9]+): .+$", "^- AC-([0-9]+[0-9]{3}): .+$", "^- AC-([0-9]+(?:-[0-9]+)?[0-9]+): .+$", "^- AC-([0-9]+(?:[0-9]-)?): .+$"]) {
      expect(() => catalogueWith(bad)).toThrow(/rows\.acceptance\.pattern.*two digit runs meet/);
    }
    expect(catalogueWith("^- AC-([0-9]+-[0-9]{3}): .+$").criteriaIdTail).toBe("[0-9]+-[0-9]{3}");
  });

  it("F5: an issue row whose id runs past the cap is unrecognised in bounded time, so converge blocks", () => {
    const row = `- AC-${"1".repeat(64000)}x: a`;
    for (const catalogue of [HATSU_CATALOGUE(), EPIC_CATALOGUE(), null]) {
      const started = performance.now();
      const report = extractCriteria(`## Acceptance criteria\n\n${row}\n`, catalogue);
      expect(performance.now() - started).toBeLessThan(100);
      expect(report.criteria).toEqual([]);
      expect(report.unrecognised.map((entry) => entry.line)).toEqual([3]);
    }
    const blocked = converge([issue(`## Acceptance criteria\n\n- AC-1: a\n${row}\n`)], "| AC-1 | satisfied | e |\n");
    expect(blocked.blocking).toEqual(["zheref/nen#519: unrecognised criterion row at line 4"]);
    // A 64-character id is still read; a 65-character one is not.
    expect(extractCriteria(`- AC-${"1-".repeat(31)}12: a\n`).criteria).toHaveLength(1);
    expect(extractCriteria(`- AC-${"1-".repeat(32)}1: a\n`).unrecognised).toHaveLength(1);
  });

  it("N12: an id group matching the empty id is refused with one message", () => {
    let message = "";
    try {
      catalogueWith("^- AC-([0-9]*): .+$");
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/matches an empty id/);
    expect(message).not.toMatch(/does not compile/);
    expect(message.match(/declares no usable criterion id shape/g)).toHaveLength(1);
  });

  it("N13: a quantified group ending with a dash is admitted, and reads an optional epic", () => {
    const optional = catalogueWith("^- AC-((?:[0-9]+-)?[0-9]{3}): .+$");
    expect(optional.criteriaIdTail).toBe("(?:[0-9]+-)?[0-9]{3}");
    const report = extractCriteria("## Acceptance criteria\n\n- AC-12-001: a\n- AC-002: b\n", optional);
    expect(report.criteria.map((row) => row.id)).toEqual(["AC-12-001", "AC-2"]);
    expect(() => catalogueWith("^- AC-((?:[0-9]+-[0-9])+): .+$")).toThrow(/starts with a literal '-'.*or ends with one/);
  });

  it("N14: a --criteria list stating one id twice blocks, naming list positions", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-519-dup-"));
    writeFileSync(join(dir, "req.json"), JSON.stringify([{ name: "verify", pattern: "^## How to verify$" }]));
    writeFileSync(join(dir, "body.md"), "## How to verify\n\n| Criterion | Coverage | Evidence |\n|---|---|---|\n| AC-1 | satisfied | a.test.ts |\n");
    const result = await run(prCommand, ["pr", "body-check", "--body-from", "body.md", "--requirements-from", "req.json", "--criteria", "AC-1,AC-01"], [], { repoFlag: dir });
    expect(result.code).toBe(1);
    expect(result.out).toContain("BLOCKING --criteria: duplicate criterion id AC-1 at positions 1, 2");
  });

  it("the cap counts the id, never a long owner/name qualifier", () => {
    const owner = "o".repeat(39);
    const name = "n".repeat(100);
    const cell = `${owner}/${name}#519/AC-12-001`;
    const rows = readVerifyRows(`| ${cell} | satisfied | e |\n`);
    expect(rows[0]?.criterion).toEqual({ kind: "qualified", prefix: `${owner}/${name}`, issue: 519, id: "AC-12-001" });
    const report = converge([issue(EPIC_BODY, 519, `${owner}/${name}`)], `| ${cell} | satisfied | e |\n| ${owner}/${name}#519/AC-12-002 | satisfied | e |\n`);
    expect(report.blocking).toEqual([]);
  });
});
