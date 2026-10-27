// src/tests/map.test.ts -- `nen tests map`'s join (zheref/nen#552). Each test
// carries the criterion token it proves, so this file is mapped by the verb it
// tests.
import { describe, expect, it } from "vitest";
import { extractCriteria } from "../issue/criteria.js";
import type { TestCase } from "../shu/test-report/shape.js";
import { issueRefsIn, mapTests, renderMap, tokensIn, unreadableMap, type MapInput } from "./map.js";

const BODY = ["## Acceptance criteria", "", "- AC-1: one", "- AC-2: two", "- AC-3: three", ""].join("\n");
const t = (name: string, status: TestCase["status"] = "passed", suite: string | null = "src/x.test.ts"): TestCase => ({ name, suite, status, durationMs: null });

function input(tests: TestCase[], extra: Partial<MapInput> = {}): MapInput {
  return {
    mode: "after",
    issueBody: "issue.md",
    issue: null,
    issueLabel: null,
    criteria: extractCriteria(BODY),
    prefix: "AC",
    testReports: ["report.json"],
    tests,
    beforeReports: null,
    before: null,
    ...extra,
  };
}

describe("tokensIn", () => {
  it("reads bare and qualified tokens and refuses near-misses (zheref/nen#552/AC-1)", () => {
    expect(tokensIn("does it AC-3: x").map((token) => token.number)).toEqual([3]);
    expect(tokensIn("zheref/nen#552/AC-1 and NN#552/AC-2 and #552/AC-4 and (AC-5)").map((token) => [token.qualifier, token.issue, token.number])).toEqual([
      ["zheref/nen", 552, 1],
      ["NN", 552, 2],
      [null, 552, 4],
      [null, null, 5],
    ]);
    for (const miss of ["AC-30x", "XAC-3", "AC-3a", "AC-3-001", "x.AC-3", "AC-", "ac-3"]) expect(tokensIn(miss)).toEqual([]);
    expect(tokensIn("AC-30").map((token) => token.number)).toEqual([30]);
    expect(tokensIn("SC-2 then AC-2", "SC").map((token) => token.token)).toEqual(["SC-2"]);
  });

  it("reads '/' as a separator between bare tokens, never inside a qualified one (zheref/nen#552/AC-2)", () => {
    expect(tokensIn("AC-1/AC-2 c").map((token) => [token.issue, token.number])).toEqual([
      [null, 1],
      [null, 2],
    ]);
    expect(tokensIn("covers #552/AC-3").map((token) => [token.issue, token.number])).toEqual([[552, 3]]);
    expect(tokensIn("src/AC-4").map((token) => token.number)).toEqual([4]);
  });

  it("reads every issue reference, qualified tokens included", () => {
    expect(issueRefsIn("one effort-id grammar (zheref/nen#509) > AC-1 and NN#7/AC-2 and #12").map((ref) => [ref.qualifier, ref.issue])).toEqual([
      ["zheref/nen", 509],
      ["NN", 7],
      [null, 12],
    ]);
  });
});

describe("mapTests", () => {
  it("lists each criterion with the tests naming it and their outcome, and each with none (zheref/nen#552/AC-1)", () => {
    const report = mapTests(input([t("AC-1 works"), t("AC-1 also", "failed"), t("AC-2 holds"), t("names nothing")]));
    expect(report.criteria.map((row) => [row.id, row.status, row.count, row.outcome, row.met])).toEqual([
      ["AC-1", "mapped", 2, "failing", false],
      ["AC-2", "mapped", 1, "passing", true],
      ["AC-3", "unmapped", 0, "untested", false],
    ]);
    expect(report.criteria[0]?.tests.map((test) => [test.name, test.status, test.before])).toEqual([
      ["AC-1 works", "passed", null],
      ["AC-1 also", "failed", null],
    ]);
    expect(report.verdict).toBe("unmet");
    expect(report.counts).toEqual({ criteria: 3, mapped: 2, unmapped: 1, met: 1, unrequested: 0, foreign: 0, tests: 4 });
    expect(report.blocking).toEqual(["AC-1: failing", "AC-3: unmapped (no test names it)"]);
  });

  it("is met when every criterion has a passing test, and reads the suite too (zheref/nen#552/AC-1)", () => {
    const report = mapTests(input([t("one", "passed", "AC-1 block"), t("AC-2"), t("AC-3 x"), t("AC-3 y", "skipped")]));
    expect(report.verdict).toBe("met");
    expect(report.blocking).toEqual([]);
    expect(mapTests(input([t("AC-1"), t("AC-2"), t("AC-3", "skipped")])).criteria[2]?.outcome).toBe("skipped");
  });

  it("reports a test naming an id the issue does not carry as unrequested, by name (zheref/nen#552/AC-2)", () => {
    const report = mapTests(input([t("AC-1"), t("AC-2"), t("AC-3"), t("AC-9 extra and AC-1")]));
    expect(report.unrequested).toEqual([{ id: "AC-9", token: "AC-9", name: "AC-9 extra and AC-1", suite: "src/x.test.ts", status: "passed" }]);
    expect(report.criteria[0]?.count).toBe(2);
    expect(report.verdict).toBe("unmet");
    expect(report.blocking).toEqual(["AC-9 unrequested: 'AC-9 extra and AC-1' names a criterion the issue does not carry"]);
    expect(renderMap(report).some((line) => line.includes("UNREQUESTED AC-9"))).toBe(true);
  });

  it("anchors qualified tokens to --issue and lists the others as foreign (zheref/nen#552/AC-2)", () => {
    const anchored = input([t("#552/AC-1"), t("#7/AC-2"), t("zheref/other#552/AC-3"), t("NN#552/AC-2"), t("zheref/nen#552/AC-3")], { issue: { prefix: "zheref/nen", number: 552 }, issueLabel: "zheref/nen#552" });
    const report = mapTests(anchored);
    expect(report.foreign.map((test) => test.token)).toEqual(["#7/AC-2", "zheref/other#552/AC-3"]);
    expect(report.criteria.map((row) => row.count)).toEqual([1, 1, 1]);
    expect(report.verdict).toBe("met");
    expect(mapTests({ ...anchored, issue: null }).criteria.map((row) => row.count)).toEqual([1, 2, 2]);
  });

  it("reads a bare token as foreign when the test names another issue and not the anchor (zheref/nen#552/AC-2)", () => {
    const suite = "src/ledger/effort.test.ts";
    const tests = [
      t("one effort-id grammar (zheref/nen#509) > AC-1: exactly one EFFORT_ID declaration", "passed", suite),
      t("tests map (zheref/nen#552) > AC-2 holds", "passed", "src/tests/map.test.ts"),
      t("AC-3 with no reference at all"),
      t("AC-1 for #509 and NN#552"),
    ];
    const report = mapTests(input(tests, { issue: { prefix: "zheref/nen", number: 552 }, issueLabel: "zheref/nen#552" }));
    expect(report.foreign.map((test) => [test.token, test.name])).toEqual([["AC-1", tests[0]?.name]]);
    expect(report.criteria.map((row) => row.count)).toEqual([1, 1, 1]);
    expect(mapTests(input(tests)).criteria[0]?.count).toBe(2);
  });

  it("reads red-first, green-only, failing or untested over a before and an after run (zheref/nen#552/AC-3)", () => {
    const before = [t("AC-1 a", "failed"), t("AC-2 b", "passed")];
    const after = [t("AC-1 a"), t("AC-2 b"), t("AC-2 new")];
    const report = mapTests(input(after, { mode: "before-after", beforeReports: ["red.json"], before }));
    expect(report.criteria.map((row) => [row.id, row.checkpoint, row.met])).toEqual([
      ["AC-1", "red-first", true],
      ["AC-2", "green-only", false],
      ["AC-3", "untested", false],
    ]);
    expect(report.criteria[1]?.tests.map((test) => test.before)).toEqual(["passed", "absent"]);
    const failing = mapTests(input([t("AC-1 a", "failed"), t("AC-2 b"), t("AC-3", "skipped")], { mode: "before-after", beforeReports: ["red.json"], before: [...before, t("AC-3", "failed")] }));
    expect(failing.criteria.map((row) => row.checkpoint)).toEqual(["failing", "green-only", "untested"]);
    const allRed = mapTests(input([t("AC-1"), t("AC-2"), t("AC-3")], { mode: "before-after", beforeReports: ["red.json"], before: [t("AC-1", "failed"), t("AC-2", "failed"), t("AC-3", "failed"), t("AC-3", "passed")] }));
    expect(allRed.verdict).toBe("met");
  });

  it("attributes a file that failed to load in the red run to every after test of that suite (zheref/nen#552/AC-3)", () => {
    const loadFailure = t("src/x.test.ts", "failed", "src/x.test.ts");
    const report = mapTests(input([t("AC-1 a"), t("AC-2 b"), t("AC-3 c", "passed", "src/other.test.ts")], { mode: "before-after", beforeReports: ["red.xml"], before: [loadFailure] }));
    expect(report.criteria.map((row) => [row.checkpoint, row.tests[0]?.before])).toEqual([
      ["red-first", "load-failed"],
      ["red-first", "load-failed"],
      ["green-only", "absent"],
    ]);
    expect(report.loadFailures).toEqual(["src/x.test.ts"]);
    expect(renderMap(report)).toContain("  LOAD-FAILED src/x.test.ts (the red run names the file, not its tests)");
  });

  it("applies one red bar in both red modes: every test naming the criterion failed (zheref/nen#552/AC-3)", () => {
    const red = [t("AC-1 a", "failed"), t("AC-1 b", "passed"), t("AC-2 a", "failed"), t("AC-2 b", "failed")];
    const green = [t("AC-1 a"), t("AC-1 b"), t("AC-2 a"), t("AC-2 b")];
    const requireRed = mapTests(input(red, { mode: "require-red" }));
    const beforeAfter = mapTests(input(green, { mode: "before-after", beforeReports: ["red.json"], before: red }));
    expect(requireRed.criteria.slice(0, 2).map((row) => [row.checkpoint, row.met])).toEqual([
      ["not-red", false],
      ["red", true],
    ]);
    expect(beforeAfter.criteria.slice(0, 2).map((row) => [row.checkpoint, row.met])).toEqual([
      ["green-only", false],
      ["red-first", true],
    ]);
  });

  it("reads --require-red: met only when every test naming a criterion failed (zheref/nen#552/AC-3)", () => {
    const report = mapTests(input([t("AC-1", "failed"), t("AC-2", "failed"), t("AC-2 b", "passed")], { mode: "require-red" }));
    expect(report.criteria.map((row) => [row.checkpoint, row.met])).toEqual([
      ["red", true],
      ["not-red", false],
      ["untested", false],
    ]);
    expect(report.verdict).toBe("unmet");
  });

  it("is not-verifiable when the body states no criterion, never all mapped (zheref/nen#552/AC-4)", () => {
    const report = mapTests(input([t("AC-1")], { criteria: extractCriteria("no criteria here") }));
    expect(report.verdict).toBe("not-verifiable");
    expect(report.criteria).toEqual([]);
    expect(report.unrequested.map((test) => test.id)).toEqual(["AC-1"]);
  });

  it("blocks on a duplicate or unrecognised criterion row (zheref/nen#552/AC-1)", () => {
    const report = mapTests(input([t("AC-1"), t("AC-2"), t("AC-3")], { criteria: extractCriteria(`${BODY}- AC-2: again\n`) }));
    expect(report.criteria).toHaveLength(3);
    expect(report.blocking).toEqual(["AC-2 stated twice (lines 4, 6)"]);
  });

  it("is could-not-read with the reason, never an empty map (zheref/nen#552/AC-4)", () => {
    const report = unreadableMap({ mode: "after", issueBody: "issue.md", issueLabel: null, testReports: ["r.json"], beforeReports: null }, "no test report at r.json");
    expect(report.verdict).toBe("could-not-read");
    expect(report.reason).toBe("no test report at r.json");
    expect(renderMap(report)).toEqual(["could-not-read: no test report at r.json"]);
  });
});
