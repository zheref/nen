// src/tests/command.test.ts -- `nen tests map` end to end over files on disk
// (zheref/nen#552): the exits, the modes, the --json shape, could-not-read.
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { testsCommand } from "./command.js";

const scratch = mkdtempSync(join(tmpdir(), "nen-tests-map-"));
afterAll((): void => rmSync(scratch, { recursive: true, force: true }));
let n = 0;

const BODY = "## Acceptance criteria\n\n- AC-1: one\n- AC-2: two\n";
type Row = readonly [string, "passed" | "failed" | "pending"];
const vitest = (rows: readonly Row[]): string => JSON.stringify({ testResults: [{ name: "/abs/src/x.test.ts", assertionResults: rows.map(([fullName, status]) => ({ fullName, title: fullName, status })) }] });
const junit = (rows: readonly Row[]): string =>
  `<?xml version="1.0"?>\n<testsuites><testsuite name="s">${rows.map(([name, status]) => `<testcase classname="s" name="${name}">${status === "failed" ? "<failure/>" : status === "pending" ? "<skipped/>" : ""}</testcase>`).join("")}</testsuite></testsuites>\n`;

function repo(files: Readonly<Record<string, string | Buffer>>): string {
  const root = join(scratch, `r-${++n}`);
  mkdirSync(root, { recursive: true });
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  return root;
}

async function map(root: string, extra: readonly string[], json = false): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const code = await runFamily(testsCommand, ["tests", "map", ...extra], root, json, io, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("nen tests map", () => {
  it("exits 0 when every criterion has a passing test, reading paths against --repo (zheref/nen#552/AC-1)", async () => {
    const root = repo({ "issue.md": BODY, "report.json": vitest([["AC-1 works", "passed"], ["#552/AC-2 holds", "passed"]]) });
    const result = await map(root, ["--issue-body", "issue.md", "--test-report", "report.json", "--issue", "zheref/nen#552"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("met: 2/2 criteria met (after)");
    expect(result.out).toContain("AC-1 mapped · 1 test(s) · passing");
  });

  it("exits 1 naming an unmapped criterion with a count of 0, over two reports (zheref/nen#552/AC-1)", async () => {
    const root = repo({ "issue.md": BODY, "a.json": vitest([["AC-1 works", "passed"]]), "b.xml": junit([["other", "passed"]]) });
    const result = await map(root, ["--issue-body", "issue.md", "--test-report", "a.json,b.xml"], true);
    expect(result.code).toBe(1);
    const report = JSON.parse(result.out) as Record<string, unknown> & { criteria: { id: string; count: number; status: string }[]; counts: { tests: number } };
    expect(Object.keys(report)).toEqual(["contract", "verdict", "mode", "issueBody", "issue", "testReports", "beforeReports", "criteria", "unrequested", "foreign", "duplicates", "unrecognised", "counts", "blocking", "reason"]);
    expect(report.contract).toBe("nen.tests.map/v0.1");
    expect(report.criteria.map((row) => [row.id, row.status, row.count])).toEqual([
      ["AC-1", "mapped", 1],
      ["AC-2", "unmapped", 0],
    ]);
    expect(report.counts.tests).toBe(2);
  });

  it("exits 1 on a test naming an id the issue does not carry, listed by name (zheref/nen#552/AC-2)", async () => {
    const root = repo({ "issue.md": BODY, "report.json": vitest([["AC-1", "passed"], ["AC-2", "passed"], ["AC-7 stray", "passed"]]) });
    const result = await map(root, ["--issue-body", "issue.md", "--test-report", "report.json"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("UNREQUESTED AC-7 passed  /abs/src/x.test.ts > AC-7 stray");
  });

  it("reads a recorded red run and a green run as red-first or green-only (zheref/nen#552/AC-3)", async () => {
    const root = repo({ "issue.md": BODY, "red.xml": junit([["AC-1 a", "failed"], ["AC-2 b", "passed"]]), "green.xml": junit([["AC-1 a", "passed"], ["AC-2 b", "passed"]]) });
    const both = await map(root, ["--issue-body", "issue.md", "--test-report", "green.xml", "--before-report", "red.xml"]);
    expect(both.code).toBe(1);
    expect(both.out).toContain("AC-1 mapped · 1 test(s) · red-first");
    expect(both.out).toContain("AC-2 mapped · 1 test(s) · green-only (unmet)");
    expect(both.out).toContain("passed (before: failed)  s > AC-1 a");
    const red = await map(root, ["--issue-body", "issue.md", "--test-report", "red.xml", "--require-red"]);
    expect(red.code).toBe(1);
    expect(red.out).toContain("AC-1 mapped · 1 test(s) · red");
    expect(red.out).toContain("AC-2 mapped · 1 test(s) · not-red (unmet)");
    const allRed = repo({ "issue.md": BODY, "red.xml": junit([["AC-1 a", "failed"], ["AC-2 b", "failed"]]) });
    expect((await map(allRed, ["--issue-body", "issue.md", "--test-report", "red.xml", "--require-red"])).code).toBe(0);
  });

  it("is could-not-read at exit 1 for an unreadable body or report, never an empty map (zheref/nen#552/AC-4)", async () => {
    const root = repo({ "issue.md": BODY, "report.json": vitest([["AC-1", "passed"]]), "bad.json": "{not json", "latin.md": Buffer.from([0x2d, 0x20, 0x41, 0x43, 0x2d, 0x31, 0x3a, 0xff, 0xfe]) });
    for (const argv of [
      ["--issue-body", "missing.md", "--test-report", "report.json"],
      ["--issue-body", "latin.md", "--test-report", "report.json"],
      ["--issue-body", "issue.md", "--test-report", "absent.json"],
      ["--issue-body", "issue.md", "--test-report", "bad.json"],
      ["--issue-body", "issue.md", "--test-report", "report.json", "--before-report", "absent.xml"],
    ]) {
      const result = await map(root, argv, true);
      expect(result.code).toBe(1);
      const report = JSON.parse(result.out) as { verdict: string; criteria: unknown[]; reason: string | null };
      expect(report.verdict).toBe("could-not-read");
      expect(report.criteria).toEqual([]);
      expect(report.reason).not.toBeNull();
    }
    const none = repo({ "issue.md": "no rows\n", "report.json": vitest([["AC-1", "passed"]]) });
    const result = await map(none, ["--issue-body", "issue.md", "--test-report", "report.json"]);
    expect(result.code).toBe(1);
    expect(result.out).toContain("not-verifiable");
  });

  it("refuses usage at exit 2: a missing flag, both modes, a malformed --issue or catalogue", async () => {
    const root = repo({ "issue.md": BODY, "report.json": vitest([["AC-1", "passed"]]) });
    for (const argv of [
      ["--test-report", "report.json"],
      ["--issue-body", "issue.md"],
      ["--issue-body", "issue.md", "--test-report", "report.json", "--require-red", "--before-report", "report.json"],
      ["--issue-body", "issue.md", "--test-report", "report.json", "--issue", "not a ref"],
      ["--issue-body", "issue.md", "--test-report", "report.json", "--requirements-from", "absent.json"],
    ]) {
      expect((await map(root, argv)).code).toBe(2);
    }
  });
});
