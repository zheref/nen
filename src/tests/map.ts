// src/tests/map.ts -- `nen tests map`: each acceptance criterion of an issue
// body with the tests whose names carry its id (zheref/nen#552; Hatsu's
// assessment finding D8, scorecard SDD-19 "tests first").
//
// TWO LISTS, ONE JOIN, READ-ONLY. The issue's `- AC-{n}: ...` rows are read
// in `nen issue criteria`'s grammar (../issue/criteria.ts, `extractCriteria`),
// never a second reading of them. The tests are read from one or more test
// reports through `shu test-report`'s parsers (../shu/test-report/parse.ts),
// so every format that family reads -- JUnit XML, a JSON assertion-results
// document, an xcresult summary -- is mapped the same way and no runner is
// named here. A test NAMES a criterion by carrying its id as a token in its
// name or its suite: `AC-3`, `#552/AC-3`, `NN#552/AC-3` or
// `zheref/nen#552/AC-3` (the verify-row key HR-11 uses). Nothing is run.
//
// THREE MODES, ONE MAP. With `--test-report` alone the run is read as the one
// AFTER the change: a criterion is met when it has a test and every test of it
// that ran passed. With `--require-red` the same report is read as the
// checkpoint BEFORE the change: a criterion is met when every test naming it
// failed there. With `--before-report` both runs are read and each criterion is
// red-first (a test of it failed before and passes after), green-only (it
// passes after and none of its passing tests was red before), failing (a test
// of it fails after) or untested.
//
// WHAT IS NEVER A PASS. A body with no AC row is `not-verifiable`; a report or
// body nen cannot read is `could-not-read` with the reason, never an empty
// map; a test naming an id the issue does not carry is `unrequested` by name.

import type { CriteriaReport, Criterion } from "../issue/criteria.js";
import type { TestCase, TestStatus } from "../shu/test-report/shape.js";

/** The `--json` contract of `nen tests map`. */
export const TESTS_MAP_CONTRACT = "nen.tests.map/v0.1";

export type MapMode = "after" | "require-red" | "before-after";
export type MapVerdict = "met" | "unmet" | "not-verifiable" | "could-not-read";
/** A criterion against its mapped tests in the one report read as the run. */
export type Outcome = "passing" | "failing" | "skipped" | "untested";
export type Checkpoint = "red-first" | "green-only" | "failing" | "untested" | "red" | "not-red";

/** Which issue the map is for, when `--issue` names it: anchors qualified tokens. */
export interface IssueAnchor {
  /** `owner/name` or a product code as written; null for `#<N>`/`<N>`. */
  readonly prefix: string | null;
  readonly number: number;
}

export interface MappedTest {
  readonly name: string;
  readonly suite: string | null;
  readonly status: TestStatus;
  /** The same test's status in `--before-report`: "absent" when it did not run there; null with no before report. */
  readonly before: TestStatus | "absent" | null;
}

export interface CriterionMap {
  readonly id: string;
  readonly number: number;
  readonly text: string;
  readonly line: number;
  readonly status: "mapped" | "unmapped";
  /** Tests naming this criterion, 0 included (SC-1). */
  readonly count: number;
  readonly outcome: Outcome;
  /** Null in the `after` mode; the mode's own word otherwise. */
  readonly checkpoint: Checkpoint | null;
  readonly met: boolean;
  readonly tests: readonly MappedTest[];
}

export interface UnrequestedTest {
  readonly id: string;
  readonly token: string;
  readonly name: string;
  readonly suite: string | null;
  readonly status: TestStatus;
}

export interface ForeignTest {
  readonly token: string;
  readonly name: string;
  readonly suite: string | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface TestsMapReport {
  readonly contract: typeof TESTS_MAP_CONTRACT;
  readonly verdict: MapVerdict;
  readonly mode: MapMode;
  readonly issueBody: string;
  readonly issue: string | null;
  readonly testReports: readonly string[];
  readonly beforeReports: readonly string[] | null;
  readonly criteria: readonly CriterionMap[];
  readonly unrequested: readonly UnrequestedTest[];
  readonly foreign: readonly ForeignTest[];
  readonly duplicates: readonly { readonly id: string; readonly lines: readonly number[] }[];
  readonly unrecognised: readonly { readonly line: number; readonly text: string }[];
  readonly counts: {
    readonly criteria: number;
    readonly mapped: number;
    readonly unmapped: number;
    readonly met: number;
    readonly unrequested: number;
    readonly foreign: number;
    readonly tests: number;
  };
  /** One line per fact that sets exit 1. */
  readonly blocking: readonly string[];
  readonly reason: string | null;
}

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** A criterion token in a test's text: the prefix, then optional `<qualifier>#<N>/`. */
export interface Token {
  readonly token: string;
  readonly qualifier: string | null;
  readonly issue: number | null;
  readonly number: number;
}

/**
 * Every criterion token in `text`. `AC-3` stands alone: a letter, digit, `_`
 * or `-` before it, or a digit, letter, `_` or `-<digit>` after it, and it is
 * not the token (`XAC-3`, `AC-30`, `AC-3a`, and `AC-3-001`, the
 * `AC-{epic}-{nnn}` form zheref/nen#519 has not landed yet). A qualified token
 * carries `<CODE>#<N>/`, `<owner/name>#<N>/` or `#<N>/` before it.
 */
export function tokensIn(text: string, prefix = "AC"): Token[] {
  const pattern = new RegExp(
    `(?<![A-Za-z0-9_./#-])(?:([A-Za-z][A-Za-z0-9]*|[A-Za-z0-9._-]+\\/[A-Za-z0-9._-]+)?#(\\d{1,9})\\/)?(?<![A-Za-z0-9_-])${escapeRegExp(prefix)}-(\\d{1,9})(?![A-Za-z0-9_]|-\\d)`,
    "g",
  );
  const out: Token[] = [];
  for (const match of text.matchAll(pattern)) {
    out.push({
      token: match[0],
      qualifier: match[1] ?? null,
      issue: match[2] === undefined ? null : Number(match[2]),
      number: Number(match[3]),
    });
  }
  return out;
}

/** Does a qualified token name the anchored issue? A bare token always does; a CODE prefix is echoed, never resolved. */
function namesAnchor(token: Token, anchor: IssueAnchor | null): boolean {
  if (token.issue === null || anchor === null) return true;
  if (token.issue !== anchor.number) return false;
  if (token.qualifier === null || !token.qualifier.includes("/")) return true;
  return anchor.prefix === null || !anchor.prefix.includes("/") || anchor.prefix.toLowerCase() === token.qualifier.toLowerCase();
}

const identity = (test: { name: string; suite: string | null }): string => `${test.suite ?? ""}\u0000${test.name}`;

function outcomeOf(tests: readonly MappedTest[]): Outcome {
  if (tests.length === 0) return "untested";
  if (tests.some((test): boolean => test.status === "failed")) return "failing";
  if (!tests.some((test): boolean => test.status === "passed")) return "skipped";
  return "passing";
}

function checkpointOf(mode: MapMode, outcome: Outcome, tests: readonly MappedTest[]): Checkpoint | null {
  if (mode === "after") return null;
  if (tests.length === 0) return "untested";
  if (mode === "require-red") return tests.every((test): boolean => test.status === "failed") ? "red" : "not-red";
  if (outcome === "failing") return "failing";
  if (outcome === "skipped") return "untested";
  return tests.some((test): boolean => test.status === "passed" && test.before === "failed") ? "red-first" : "green-only";
}

const MET: Readonly<Record<MapMode, (outcome: Outcome, checkpoint: Checkpoint | null) => boolean>> = {
  after: (outcome): boolean => outcome === "passing",
  "require-red": (_outcome, checkpoint): boolean => checkpoint === "red",
  "before-after": (_outcome, checkpoint): boolean => checkpoint === "red-first",
};

export interface MapInput {
  readonly mode: MapMode;
  readonly issueBody: string;
  readonly issue: IssueAnchor | null;
  readonly issueLabel: string | null;
  readonly criteria: CriteriaReport;
  readonly prefix: string;
  readonly testReports: readonly string[];
  readonly tests: readonly TestCase[];
  readonly beforeReports: readonly string[] | null;
  readonly before: readonly TestCase[] | null;
}

export function mapTests(input: MapInput): TestsMapReport {
  const before = new Map<string, TestStatus>();
  for (const test of input.before ?? []) {
    // A test that ran twice before is red when either run failed it: a later
    // pass in the same run does not unsay the failure.
    const seen = before.get(identity(test));
    if (seen !== "failed") before.set(identity(test), test.status);
  }
  const numbers = new Map<number, Criterion>();
  for (const criterion of input.criteria.criteria) if (!numbers.has(criterion.number)) numbers.set(criterion.number, criterion);
  const byNumber = new Map<number, MappedTest[]>();
  const unrequested: UnrequestedTest[] = [];
  const foreign: ForeignTest[] = [];
  for (const test of input.tests) {
    const text = test.suite === null ? test.name : `${test.suite} ${test.name}`;
    const numbered = new Set<number>();
    for (const token of tokensIn(text, input.prefix)) {
      if (!namesAnchor(token, input.issue)) {
        foreign.push({ token: token.token, name: test.name, suite: test.suite });
        continue;
      }
      if (numbered.has(token.number)) continue;
      numbered.add(token.number);
      if (!numbers.has(token.number)) {
        unrequested.push({ id: `${input.prefix}-${token.number}`, token: token.token, name: test.name, suite: test.suite, status: test.status });
        continue;
      }
      const entry: MappedTest = {
        name: test.name,
        suite: test.suite,
        status: test.status,
        before: input.before === null ? null : (before.get(identity(test)) ?? "absent"),
      };
      byNumber.set(token.number, [...(byNumber.get(token.number) ?? []), entry]);
    }
  }
  const criteria: CriterionMap[] = [...numbers.values()].map((criterion): CriterionMap => {
    const tests = byNumber.get(criterion.number) ?? [];
    const outcome = outcomeOf(tests);
    const checkpoint = checkpointOf(input.mode, outcome, tests);
    return {
      id: criterion.id,
      number: criterion.number,
      text: criterion.text,
      line: criterion.line,
      status: tests.length === 0 ? "unmapped" : "mapped",
      count: tests.length,
      outcome,
      checkpoint,
      met: MET[input.mode](outcome, checkpoint),
      tests,
    };
  });
  const blocking: string[] = [];
  if (!input.criteria.verifiable) blocking.push(`${input.issueBody} states no ${input.prefix}-{n} row: nothing to map, never "all mapped"`);
  for (const criterion of criteria) {
    if (criterion.met) continue;
    const word = criterion.checkpoint ?? criterion.outcome;
    blocking.push(`${criterion.id}: ${criterion.status === "unmapped" ? "unmapped (no test names it)" : word}`);
  }
  for (const test of unrequested) blocking.push(`${test.id} unrequested: '${test.name}' names a criterion the issue does not carry`);
  for (const duplicate of input.criteria.duplicates) blocking.push(`${duplicate.id} stated twice (lines ${duplicate.lines.join(", ")})`);
  for (const row of input.criteria.unrecognised) blocking.push(`unrecognised criterion row at line ${row.line}`);
  const mapped = criteria.filter((criterion): boolean => criterion.status === "mapped").length;
  return {
    contract: TESTS_MAP_CONTRACT,
    verdict: !input.criteria.verifiable ? "not-verifiable" : blocking.length === 0 ? "met" : "unmet",
    mode: input.mode,
    issueBody: input.issueBody,
    issue: input.issueLabel,
    testReports: input.testReports,
    beforeReports: input.beforeReports,
    criteria,
    unrequested,
    foreign,
    duplicates: input.criteria.duplicates,
    unrecognised: input.criteria.unrecognised,
    counts: {
      criteria: criteria.length,
      mapped,
      unmapped: criteria.length - mapped,
      met: criteria.filter((criterion): boolean => criterion.met).length,
      unrequested: unrequested.length,
      foreign: foreign.length,
      tests: input.tests.length,
    },
    blocking,
    reason: null,
  };
}

/** The report for an input nen could not read (AC-4): the reason, never an empty map. */
export function unreadableMap(input: { mode: MapMode; issueBody: string; issueLabel: string | null; testReports: readonly string[]; beforeReports: readonly string[] | null }, reason: string): TestsMapReport {
  return {
    contract: TESTS_MAP_CONTRACT,
    verdict: "could-not-read",
    mode: input.mode,
    issueBody: input.issueBody,
    issue: input.issueLabel,
    testReports: input.testReports,
    beforeReports: input.beforeReports,
    criteria: [],
    unrequested: [],
    foreign: [],
    duplicates: [],
    unrecognised: [],
    counts: { criteria: 0, mapped: 0, unmapped: 0, met: 0, unrequested: 0, foreign: 0, tests: 0 },
    blocking: [`could not read: ${reason}`],
    reason,
  };
}

const testLabel = (test: { name: string; suite: string | null }): string => (test.suite === null ? test.name : `${test.suite} > ${test.name}`);

export function renderMap(report: TestsMapReport): string[] {
  if (report.verdict === "could-not-read") return [`could-not-read: ${report.reason ?? ""}`];
  const lines = [
    `${report.verdict}: ${report.counts.met}/${report.counts.criteria} criteria met (${report.mode}) · ${report.counts.mapped} mapped · ${report.counts.unmapped} unmapped · ${report.counts.unrequested} unrequested · ${report.counts.tests} test(s) read`,
  ];
  for (const criterion of report.criteria) {
    lines.push(`  ${criterion.id} ${criterion.status} · ${criterion.count} test(s) · ${criterion.checkpoint ?? criterion.outcome}${criterion.met ? "" : " (unmet)"}`);
    for (const test of criterion.tests) lines.push(`    ${test.status}${test.before === null ? "" : ` (before: ${test.before})`}  ${testLabel(test)}`);
  }
  for (const test of report.unrequested) lines.push(`  UNREQUESTED ${test.id} ${test.status}  ${testLabel(test)}`);
  for (const test of report.foreign) lines.push(`  FOREIGN ${test.token}  ${testLabel(test)}`);
  for (const duplicate of report.duplicates) lines.push(`  DUPLICATE ${duplicate.id} lines ${duplicate.lines.join(", ")}`);
  for (const row of report.unrecognised) lines.push(`  UNRECOGNISED line ${row.line}: ${row.text}`);
  return lines;
}
