// src/shu/test-report/formats/assertion-results.ts -- the JSON a JavaScript
// test runner writes when it is asked for its JSON reporter. Pure: text in, one
// shape out.
//
// NAMED FOR ITS SHAPE AND NOT FOR ITS RUNNER, and that is not squeamishness
// about a name: this document is `{ testResults: [ { name, assertionResults: [
// { fullName, status, duration } ] } ] }`, and at least four runners in the
// JavaScript ecosystem emit exactly it -- the shape outlived the tool that
// invented it. Keying the format id on one of those runners would mean a
// repository that switched to another got a refusal about a program rather
// than a report about its tests, and it would put a toolchain name in a module
// on the execution path, which ../../purity.test.ts fails the build for.
//
// THE ROWS ARE ASSERTIONS AND THE FILES ARE SUITES. `testResults[]` is one
// entry per test FILE and carries that file's path; `assertionResults[]` is one
// entry per test inside it. So `suite` is the file and `name` is the test,
// which is the same division `<testcase classname=...>` makes in the XML
// format beside this one -- one vocabulary out of two spellings.
//
// FIVE WORDS FOR "IT DID NOT RUN". `pending`, `todo`, `disabled` and `skipped`
// all mean nothing was proved, and ../shape.ts's three statuses collapse them.
// A word this map does not carry is REFUSED rather than guessed at: a status
// nen has not seen before is as likely to be a failure as a skip, and a report
// that quietly counted one as the other would be wrong in the direction that
// makes a red suite look green.

import {
  milliseconds,
  optionalName,
  requireName,
  tally,
  TestReportError,
  type ParsedTests,
  type TestCase,
  type TestReportFormat,
  type TestStatus,
} from "../shape.js";

/** Every outcome word this shape is written with, and what each means. */
const STATUS: Readonly<Record<string, TestStatus>> = {
  passed: "passed",
  failed: "failed",
  pending: "skipped",
  skipped: "skipped",
  todo: "skipped",
  disabled: "skipped",
};

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
      `${path}: is not readable as JSON (${error instanceof Error ? error.message : String(error)}). This file was read as a JSON test reporter document because of its name or its first bytes.`,
    );
  }
  const record = asRecord(parsed);
  if (record === null) {
    throw new TestReportError(
      `${path}: is JSON, but not an object. This format is an object carrying a "testResults" array.`,
    );
  }
  return record;
}

function requireArray(value: unknown, path: string, pointer: string): readonly unknown[] {
  if (!Array.isArray(value)) {
    throw new TestReportError(
      `${path}: ${pointer} is ${value === undefined ? "absent" : "not an array"}. This format states one entry per test file under "testResults", and one entry per test under each file's "assertionResults".`,
    );
  }
  return value;
}

/**
 * The status word, mapped, or a refusal naming the word and the ones nen reads.
 *
 * IT NAMES WHAT IT KNOWS. A refusal that said only "unknown status" would send
 * a reader to this file to find out what the alternatives were; listing them
 * costs one join and answers the question the refusal produces.
 */
function statusOf(value: unknown, path: string, pointer: string): TestStatus {
  const mapped = typeof value === "string" ? STATUS[value] : undefined;
  if (mapped === undefined) {
    throw new TestReportError(
      `${path}: ${pointer} is ${JSON.stringify(value)}, which is not an outcome nen reads. It reads: ${Object.keys(STATUS).join(", ")}. nen will not guess which of passed, failed or skipped an unfamiliar word meant -- guessing wrong in one direction makes a red suite look green.`,
    );
  }
  return mapped;
}

/** `duration` IS MILLISECONDS IN THIS FORMAT, unlike the XML format's seconds. */
function durationOf(value: unknown): number | null {
  return typeof value === "number" ? milliseconds(value) : null;
}

export const ASSERTION_RESULTS: TestReportFormat = {
  id: "assertion-results",
  label: "the testResults[].assertionResults[] JSON a JavaScript test runner writes with its JSON reporter",
  writtenAs: "any *.json path the reporter is pointed at (commonly test-results.json)",

  namedBy(fileName: string): boolean {
    return fileName.toLowerCase().endsWith(".json");
  },

  sniff(text: string): boolean {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("{")) return false;
    try {
      const record = asRecord(JSON.parse(text));
      // THE KEY IS THE WHOLE SNIFF, and deliberately not the shape beneath it.
      // An empty `testResults` still claims the file -- a run that matched no
      // test file writes `{"testResults": []}` -- and so does a DAMAGED one,
      // whose rows are missing or mistyped. A sniff that checked each row would
      // send both to the generic "not a test report in any format nen reads",
      // which is a true sentence that tells a maintainer nothing: the document
      // is plainly meant to be this format, and `parse` below can say exactly
      // which pointer is wrong. Accuracy is not lost by it -- no other format
      // here carries a `testResults` key, and the sibling JSON format's sniff
      // is a `totalTestCount` number, so the two stay disjoint.
      return record !== null && Array.isArray(record["testResults"]);
    } catch {
      return false;
    }
  },

  parse(text: string, path: string): ParsedTests {
    const record = readJson(text, path);
    const files = requireArray(record["testResults"], path, "testResults");
    const tests: TestCase[] = [];
    files.forEach((entry, fileIndex): void => {
      const file = asRecord(entry);
      if (file === null) {
        throw new TestReportError(
          `${path}: testResults[${fileIndex}] is not an object. Each entry is one test FILE, carrying its path under "name" and its tests under "assertionResults".`,
        );
      }
      const suite = optionalName(file["name"]);
      const rows = requireArray(
        file["assertionResults"],
        path,
        `testResults[${fileIndex}].assertionResults`,
      );
      rows.forEach((row, rowIndex): void => {
        const pointer = `testResults[${fileIndex}].assertionResults[${rowIndex}]`;
        const assertion = asRecord(row);
        if (assertion === null) {
          throw new TestReportError(
            `${path}: ${pointer} is not an object. Each entry is one test, carrying "fullName", "status" and usually "duration".`,
          );
        }
        tests.push({
          // `fullName` IS THE ONE A READER CAN LOOK UP -- it carries the
          // enclosing describe blocks -- and `title` is the leaf on its own.
          // A runner that writes only the leaf is still readable, so the
          // fallback is taken before the refusal rather than instead of it.
          name: requireName(
            assertion["fullName"] ?? assertion["title"],
            path,
            `${pointer}.fullName`,
          ),
          suite,
          status: statusOf(assertion["status"], path, `${pointer}.status`),
          durationMs: durationOf(assertion["duration"]),
        });
      });
    });
    return { tests, counts: tally(tests) };
  },
};
