// src/shu/test-report/formats/xcresult.ts -- the JSON test summary an Apple
// result bundle is read out into by a step the DECLARATION states. Pure: text
// in, one shape out.
//
// NEN NEVER PRODUCES THIS FILE, and that is the point of the format rather than
// a limitation of it. A result bundle is a DIRECTORY in a proprietary layout;
// the only supported way to read one is the vendor's own extraction tool, and
// running it would mean this family knowing the name of a program nobody
// declared -- the one thing `nen shu` does not do (../../purity.test.ts fails
// the build over it). So the declaration adds that extraction as a STEP of its
// own `test` invocation, redirects the JSON it prints into a file, and names
// that file under the verb's `artifacts`. nen reads the file. The repository
// chose the program; nen chose nothing.
//
// IT STATES ITS TOTALS AND LISTS ONLY ITS FAILURES, which is what makes this
// the one format here whose counts come from ../shape.ts's `statedCounts`
// rather than from its rows. That is not a shortcoming: a summary is what a
// caller deciding "did this suite pass" needs, and the failures are the rows
// they then read. Where the SAME document also carries the per-test list --
// some extractions emit `testNodes` beside the summary -- every row is read and
// `tests[]` is the whole suite; the four counts still come from the summary,
// because they are what the report itself asserts about the run.
//
// AN EXPECTED FAILURE IS A PASS. The vendor's word for a test annotated as
// expected-to-fail that duly failed is `Expected Failure`, and it means the
// suite did what it said it would -- reporting it as a failure would put a red
// row in front of a reader for a test that behaved.

import {
  milliseconds,
  millisecondsFromSeconds,
  optionalName,
  requireCount,
  requireName,
  statedCounts,
  TestReportError,
  type ParsedTests,
  type TestCase,
  type TestReportFormat,
  type TestStatus,
} from "../shape.js";

/** The per-test outcome words this extraction writes, and what each means. */
const RESULT: Readonly<Record<string, TestStatus>> = {
  Passed: "passed",
  Failed: "failed",
  Skipped: "skipped",
  "Expected Failure": "passed",
};

/** The node kind that IS a test. Everything else in the tree encloses one. */
const TEST_CASE = "Test Case";

/** The node kind that names a suite. A bundle names one too, less specifically. */
const TEST_SUITE = "Test Suite";

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function readJson(text: string, path: string): Readonly<Record<string, unknown>> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new TestReportError(
      `${path}: is not readable as JSON (${error instanceof Error ? error.message : String(error)}). This file was read as a result-bundle test summary because of its name or its first bytes.`,
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new TestReportError(
      `${path}: is JSON, but not an object. This format is an object carrying "totalTestCount", the three per-outcome counts, and "testFailures".`,
    );
  }
  return record;
}

/**
 * `0.023s`, `1m 3s`, or a plain number of seconds.
 *
 * THE UNITS ARE IN THE STRING, SO THEY ARE READ FROM IT. This extraction writes
 * a human duration rather than a number, and a reader that took `Number("1m
 * 3s")` would get `NaN` and report every test as untimed. A string carrying no
 * recognisable unit is an ABSENCE (null), not a refusal: ../shape.ts's rule for
 * a duration is that it is the optional field, and a report is not damaged for
 * spelling one in a way nen has not met.
 */
function durationOf(value: unknown): number | null {
  if (typeof value === "number") return millisecondsFromSeconds(value);
  if (typeof value !== "string") return null;
  const units: Readonly<Record<string, number>> = { ms: 1, s: 1000, m: 60000, h: 3600000 };
  let total: number | null = null;
  for (const match of value.matchAll(/(\d+(?:\.\d+)?)\s*(ms|s|m|h)/g)) {
    const scale = units[match[2] as string];
    /* c8 ignore next -- the alternation cannot match a unit the map lacks */
    if (scale === undefined) continue;
    total = (total ?? 0) + Number(match[1]) * scale;
  }
  return milliseconds(total);
}

/** The rows a summary's `testFailures` list states: one per failed test. */
function failureRows(value: unknown, path: string): readonly TestCase[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new TestReportError(
      `${path}: testFailures is not an array. A summary lists one entry per failed test there, each carrying "testName" and usually "targetName".`,
    );
  }
  return value.map((entry, index): TestCase => {
    const row = asRecord(entry);
    if (row === null) {
      throw new TestReportError(
        `${path}: testFailures[${index}] is not an object. Each entry is one failed test.`,
      );
    }
    return {
      name: requireName(row["testName"], path, `testFailures[${index}].testName`),
      suite: optionalName(row["targetName"]),
      status: "failed",
      // A SUMMARY'S FAILURE LIST CARRIES NO TIMES, and inventing a zero for
      // one would read as a test that took no time rather than one whose
      // duration this report never stated.
      durationMs: null,
    };
  });
}

/**
 * Every `Test Case` leaf of a `testNodes` tree, with the suite around it.
 *
 * THE SUITE IS INHERITED DOWNWARD rather than looked up afterwards, because the
 * tree nests -- plan, bundle, suite, case -- and the answer a reader wants is
 * the INNERMOST enclosing name. Carrying it down means the innermost one
 * naturally wins, with the bundle standing in for a run whose cases are not
 * grouped into suites at all.
 */
function nodeRows(
  nodes: readonly unknown[],
  path: string,
  pointer: string,
  suite: string | null,
  into: TestCase[],
): void {
  nodes.forEach((entry, index): void => {
    const node = asRecord(entry);
    const at = `${pointer}[${index}]`;
    if (node === null) {
      throw new TestReportError(
        `${path}: ${at} is not an object. Each node carries "name", "nodeType" and, where it encloses others, "children".`,
      );
    }
    const kind = typeof node["nodeType"] === "string" ? (node["nodeType"] as string) : "";
    const name = optionalName(node["name"]);
    if (kind === TEST_CASE) {
      into.push({
        name: requireName(node["name"], path, `${at}.name`),
        suite,
        status: resultOf(node["result"], path, `${at}.result`),
        durationMs: durationOf(node["duration"]),
      });
      return;
    }
    const children = node["children"];
    if (children === undefined || children === null) return;
    if (!Array.isArray(children)) {
      throw new TestReportError(
        `${path}: ${at}.children is not an array. A node that encloses others states them there.`,
      );
    }
    const named = kind === TEST_SUITE || kind.toLowerCase().endsWith("bundle") ? name : null;
    nodeRows(children, path, `${at}.children`, named ?? suite, into);
  });
}

function resultOf(value: unknown, path: string, pointer: string): TestStatus {
  const mapped = typeof value === "string" ? RESULT[value] : undefined;
  if (mapped === undefined) {
    throw new TestReportError(
      `${path}: ${pointer} is ${JSON.stringify(value)}, which is not an outcome nen reads. It reads: ${Object.keys(RESULT).join(", ")}. nen will not guess which of passed, failed or skipped an unfamiliar word meant -- guessing wrong in one direction makes a red suite look green.`,
    );
  }
  return mapped;
}

export const XCRESULT_SUMMARY: TestReportFormat = {
  id: "xcresult-summary",
  label: "the JSON test summary a DECLARED result-bundle extraction step writes (nen runs no extraction of its own)",
  writtenAs: "any *.json path that step's output is redirected into (commonly test-summary.json)",

  namedBy(fileName: string): boolean {
    return fileName.toLowerCase().endsWith(".json");
  },

  sniff(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{")) return false;
    try {
      const record = asRecord(JSON.parse(text));
      // `totalTestCount` IS THE KEY THAT IS ONLY EVER THIS. It is the one field
      // no other format here carries, which is what makes the two JSON
      // formats' sniffs disjoint rather than ordered.
      return record !== null && typeof record["totalTestCount"] === "number";
    } catch {
      return false;
    }
  },

  parse(text: string, path: string): ParsedTests {
    const record = readJson(text, path);
    const counts = statedCounts(
      requireCount(record["passedTests"], path, "passedTests"),
      requireCount(record["failedTests"], path, "failedTests"),
      requireCount(record["skippedTests"], path, "skippedTests"),
      requireCount(record["totalTestCount"], path, "totalTestCount"),
      path,
    );
    const nodes = record["testNodes"];
    if (nodes === undefined || nodes === null) {
      return { tests: failureRows(record["testFailures"], path), counts };
    }
    if (!Array.isArray(nodes)) {
      throw new TestReportError(
        `${path}: testNodes is not an array. Where an extraction emits the per-test list beside the summary, it states it there as a tree of nodes.`,
      );
    }
    const tests: TestCase[] = [];
    nodeRows(nodes, path, "testNodes", null, tests);
    return { tests, counts };
  },
};
