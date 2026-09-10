// src/shu/test-report/formats/junit.ts -- the XML shape almost every test
// runner on earth can be asked to write. Pure: text in, one shape out.
//
// ONE FORMAT, THREE HABITS. There is no specification for this file: there is
// an Ant task from 2001 and twenty years of runners writing something close to
// it. The three habits this reader is written against are the ones the
// declarations in the field actually produce -- a single `<testsuite>` root, a
// `<testsuites>` wrapper around several, and a DIRECTORY holding one file per
// suite (which ../parse.ts merges; this module never sees more than one file's
// text). Everything below reads what all three agree on and nothing else.
//
// A CASE IS PASSED UNTIL A CHILD SAYS OTHERWISE, which is the format's own
// rule rather than a lenient reading: a passing test is written as a
// `<testcase>` with no children at all, so "no outcome element" is the outcome.
// `<failure>` and `<error>` are both failures (../shape.ts's header argues
// why), `<skipped>` is a skip, and everything else inside a `<testcase>` --
// `<system-out>`, `<properties>`, a runner's own extension -- is ignored,
// because a reader that refused an element it did not know would refuse a file
// that is telling it exactly what it asked for.
//
// THE COUNTS ARE THE ROWS', NOT THE `tests=` ATTRIBUTE'S. Every dialect writes
// those attributes and they disagree with the rows more often than anyone
// expects -- a rerun plugin counts an attempt, an aggregator sums a subtree
// twice. The rows are what a caller can go and read, so they are what nen
// counts; ../shape.ts's `tally` is the whole of it.

import {
  numberAttribute,
  parentOf,
  scanXml,
  type XmlElement,
  // THE XML READER LIVES UNDER `coverage/` AND IS NOT ABOUT COVERAGE. It is a
  // 140-line scanner that turns text into start tags with their ancestry, with
  // no report format anywhere in it; two of the coverage formats happened to
  // need it first. A second hand-rolled XML scanner in one binary is exactly
  // the thing this repository should not have, so this imports that one rather
  // than copying it, and the module stays where its own tests already reach it.
} from "../../coverage/formats/xml.js";
import {
  requireName,
  tally,
  worse,
  millisecondsFromSeconds,
  optionalName,
  type ParsedTests,
  type TestCase,
  type TestReportFormat,
  type TestStatus,
} from "../shape.js";

const CASE = "testcase";
const SUITE = "testsuite";

/** The child elements that change a case's outcome, and what each means. */
const OUTCOMES: Readonly<Record<string, TestStatus>> = {
  failure: "failed",
  error: "failed",
  skipped: "skipped",
};

/**
 * The suite name enclosing a case, by the depth the `<testsuite>` sits at.
 *
 * ../../coverage/formats/xml.ts hands each element its ancestors as NAMES, not
 * as elements, so the enclosing suite's `name` attribute is not on the case.
 * Reading it back out is one map keyed by depth: elements arrive in document
 * order, so the last `<testsuite>` recorded at the depth just above a case is
 * the one that encloses it.
 */
function suiteNames(elements: readonly XmlElement[]): Map<number, string> {
  const names = new Map<number, string>();
  for (const element of elements) {
    if (element.name !== SUITE) continue;
    const name = optionalName(element.attributes["name"]);
    if (name !== null) names.set(element.ancestors.length, name);
  }
  return names;
}

/**
 * The suite a case belongs to: its own `classname`, else the tag around it.
 *
 * `classname` FIRST BECAUSE IT IS THE MORE SPECIFIC ANSWER. A runner that
 * writes one file per class states the class on every case and repeats it on
 * the suite; one that groups several classes under a suite states the class
 * only on the case. Preferring the attribute is right in both.
 */
function suiteOf(element: XmlElement, enclosing: Map<number, string>): string | null {
  return (
    optionalName(element.attributes["classname"]) ??
    enclosing.get(element.ancestors.length - 1) ??
    null
  );
}

export const JUNIT: TestReportFormat = {
  id: "junit",
  label: "JUnit XML",
  writtenAs: "*.xml -- one file, or a DIRECTORY of them (name the directory and nen reads every *.xml under it)",

  namedBy(fileName: string): boolean {
    return fileName.toLowerCase().endsWith(".xml");
  },

  sniff(text: string): boolean {
    // A START TAG, NOT THE WORD. `<testsuite` also opens `<testsuites`, and the
    // trailing character class is what keeps it from matching a `<testsuiteXyz>`
    // some other schema invented.
    return /<testsuites?[\s/>]/.test(text);
  },

  parse(text: string, path: string): ParsedTests {
    const elements = scanXml(text);
    const enclosing = suiteNames(elements);
    const tests: TestCase[] = [];
    let current: number | null = null;
    for (const element of elements) {
      if (element.name === CASE) {
        tests.push({
          name: requireName(
            element.attributes["name"],
            path,
            `the 'name' of <testcase> number ${tests.length + 1}`,
          ),
          suite: suiteOf(element, enclosing),
          status: "passed",
          // `time` IS SECONDS IN THIS FORMAT, on every dialect that writes it.
          durationMs: millisecondsFromSeconds(numberAttribute(element, "time")),
        });
        current = tests.length - 1;
        continue;
      }
      const outcome = OUTCOMES[element.name];
      if (outcome === undefined || parentOf(element) !== CASE || current === null) continue;
      const row = tests[current];
      /* c8 ignore next -- `current` is an index this loop just pushed */
      if (row === undefined) continue;
      tests[current] = { ...row, status: worse(row.status, outcome) };
    }
    return { tests, counts: tally(tests) };
  },
};
