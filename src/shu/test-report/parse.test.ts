// src/shu/test-report/parse.test.ts -- the three parsers and the one read, on
// text and on committed fixture files. No seam, no dispatch, no repository:
// ../test-report.test.ts is what drives the verb.
//
// EVERY HAPPY FIXTURE STATES THE SAME SUITE -- 5 tests, 3 passed, 1 failed, 1
// skipped -- and this file leans on that: three formats that disagree about
// every spelling and about nothing else means a parser that read one of them
// wrong produces a total that differs from its two siblings' rather than a
// plausible number nobody checks. `../fixtures/test-report/README.md` is the
// table of what each file is for.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { testReport, TEST_REPORTS } from "../fixtures/paths.js";
import {
  detectFormat,
  directoryShaped,
  FORMATS,
  formatNamedBy,
  fsRefusal,
  readTestReport,
  recognisedByName,
  supportedFormats,
} from "./parse.js";
import { TestReportError, type ParsedTests, type TestCase } from "./shape.js";

function text(name: string): string {
  return readFileSync(testReport(name), "utf8");
}

/** One committed fixture, read the way the verb reads a declared artifact. */
function read(name: string): ParsedTests {
  return readTestReport(testReport(name), `reports/${name}`).parsed;
}

function refusal(run: () => unknown): string {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(TestReportError);
    return (error as Error).message;
  }
  throw new Error("expected a TestReportError and nothing was thrown");
}

/** `name|suite|status|durationMs`, which is a diff a human can read. */
function rows(parsed: ParsedTests): readonly string[] {
  return parsed.tests.map(
    (test: TestCase): string => `${test.suite ?? "-"} | ${test.name} | ${test.status} | ${test.durationMs ?? "-"}`,
  );
}

describe("the registry", () => {
  it("carries three formats, each with an id, a label and a written-as", () => {
    expect(FORMATS.map((format): string => format.id)).toEqual([
      "junit",
      "assertion-results",
      "xcresult-summary",
    ]);
    for (const format of FORMATS) {
      expect(format.label.length, format.id).toBeGreaterThan(0);
      expect(format.writtenAs.length, format.id).toBeGreaterThan(0);
    }
  });

  it("names every format in the sentence a refusal quotes", () => {
    for (const format of FORMATS) expect(supportedFormats()).toContain(format.id);
  });

  it("recognises a name by its extension, on either separator", () => {
    expect(recognisedByName("reports/results.xml")).toBe(true);
    expect(recognisedByName("reports\\results.JSON")).toBe(true);
    expect(recognisedByName("reports/notes.md")).toBe(false);
    // A DIRECTORY IS NOT RECOGNISED BY NAME, and must not be: the whole point
    // of the second, weaker pass in ../test-report.ts is that this one is a
    // hint about a path with no format in its name.
    expect(recognisedByName("build/test-results/test")).toBe(false);
    expect(directoryShaped("build/test-results/test")).toBe(true);
    expect(directoryShaped("build/test-results/test/")).toBe(true);
    expect(directoryShaped("reports/results.xml")).toBe(false);
  });

  it("says which format a name claims, for the dry run that has no bytes", () => {
    expect(formatNamedBy("reports/results.xml")?.id).toBe("junit");
    // Both JSON formats claim a `.json` name; the CONTENT is what separates
    // them, which is why a dry run reports the first and a real run re-states
    // whatever actually parsed the file.
    expect(formatNamedBy("reports/summary.json")?.id).toBe("assertion-results");
    expect(formatNamedBy("reports/notes.md")).toBe(null);
  });
});

describe("name first, content decides", () => {
  it("confirms a named format against the bytes", () => {
    expect(detectFormat("reports/results.xml", text("junit-suites.xml"))?.id).toBe("junit");
    expect(detectFormat("reports/r.json", text("assertion-results.json"))?.id).toBe("assertion-results");
    expect(detectFormat("reports/r.json", text("xcresult-summary.json"))?.id).toBe("xcresult-summary");
  });

  it("reads a report under a name that says nothing", () => {
    // The two JSON sniffs are disjoint -- one wants a `testResults` array, the
    // other a `totalTestCount` number -- so an unfamiliar name still lands on
    // the right parser rather than on whichever was asked first.
    expect(detectFormat("out/anything", text("xcresult-summary.json"))?.id).toBe("xcresult-summary");
    expect(detectFormat("out/anything", text("assertion-results.json"))?.id).toBe("assertion-results");
    expect(detectFormat("out/anything", text("junit-suites.xml"))?.id).toBe("junit");
  });

  it("claims nothing for a file that is in no format it reads", () => {
    expect(detectFormat("reports/other.xml", text("junit-not-a-report.xml"))).toBe(null);
    expect(detectFormat("reports/results.json", text("not-json.json"))).toBe(null);
  });
});

describe("JUnit XML", () => {
  it("reads two suites, five cases and the three outcomes", () => {
    const parsed = read("junit-suites.xml");
    expect(parsed.counts).toEqual({ passed: 3, failed: 1, skipped: 1, total: 5 });
    expect(rows(parsed)).toEqual([
      "placeholder.CartTest | addsOneItem | passed | 12",
      "placeholder.CartTest | addsTwoItems | passed | 21",
      "placeholder.CartTest | refusesANegativeQuantity | failed | 12",
      "placeholder.TotalsTest | sumsAnEmptyCart | passed | 30",
      "placeholder.TotalsTest | appliesADiscount | skipped | -",
    ]);
  });

  it("reads `time` as SECONDS, which is what this format states", () => {
    // The mutant this kills: `time="0.012"` reported as 0.012ms, which makes
    // every suite in the world look instantaneous.
    expect(read("junit-suites.xml").tests[0]?.durationMs).toBe(12);
  });

  it("takes the suite off the enclosing tag when no case states a classname", () => {
    const parsed = read("junit-single.xml");
    expect(parsed.tests.every((test): boolean => test.suite === "placeholder.SessionTest")).toBe(true);
  });

  it("counts an <error> as a failure and ignores a child it does not know", () => {
    const parsed = read("junit-single.xml");
    expect(parsed.tests[1]).toEqual({
      name: "closesASession",
      suite: "placeholder.SessionTest",
      status: "failed",
      durationMs: 4,
    });
  });

  it("takes the WORSE of two outcome children, not the last one", () => {
    // A runner that skipped a test after a failing setup writes both. Reading
    // the last child would report a failure as a skip on a file whose elements
    // happen to be in the other order.
    expect(read("junit-single.xml").tests[2]?.status).toBe("failed");
  });

  it("reads an empty run as a report about no tests, not as a refusal", () => {
    const parsed = read("junit-empty.xml");
    expect(parsed.tests).toEqual([]);
    expect(parsed.counts).toEqual({ passed: 0, failed: 0, skipped: 0, total: 0 });
  });

  it("counts the ROWS and never the tests= attribute", () => {
    // `junit-single.xml` states tests="3" and errors="1"; the rows say three
    // cases, two of them failures. A reader of the attributes would report one.
    expect(read("junit-single.xml").counts).toEqual({
      passed: 1,
      failed: 2,
      skipped: 0,
      total: 3,
    });
  });

  it("refuses a case with no name, and names the file", () => {
    const message = refusal((): unknown => read("junit-unnamed.xml"));
    expect(message).toContain("reports/junit-unnamed.xml");
    expect(message).toContain("<testcase> number 1");
    expect(message).toContain("not a finding");
  });
});

describe("the assertionResults JSON", () => {
  it("reads five assertions across two files, with the file as the suite", () => {
    const parsed = read("assertion-results.json");
    expect(parsed.counts).toEqual({ passed: 3, failed: 1, skipped: 1, total: 5 });
    expect(rows(parsed)).toEqual([
      "/home/placeholder/checkout/src/cart.test.ts | cart > adds one item | passed | 12",
      "/home/placeholder/checkout/src/cart.test.ts | cart > adds two items | passed | 21",
      "/home/placeholder/checkout/src/cart.test.ts | cart > refuses a negative quantity | failed | 12.35",
      "/home/placeholder/checkout/src/totals.test.ts | totals > sums an empty cart | passed | 30",
      "/home/placeholder/checkout/src/totals.test.ts | applies a discount | skipped | -",
    ]);
  });

  it("reads `duration` as MILLISECONDS, to two decimals", () => {
    // The mirror of the XML unit test above, and the other half of the mutant:
    // 12.345 stays 12.35 rather than becoming 12345.
    expect(read("assertion-results.json").tests[2]?.durationMs).toBe(12.35);
  });

  it("falls back to `title` where a row states no fullName", () => {
    expect(read("assertion-results.json").tests[4]?.name).toBe("applies a discount");
  });

  it("reads a run that matched no file as a zero rather than as no format", () => {
    const parsed = read("assertion-results-empty.json");
    expect(parsed.tests).toEqual([]);
    expect(parsed.counts.total).toBe(0);
  });

  it("claims a DAMAGED document, so the refusal names the pointer", () => {
    // The sniff is the `testResults` key and not the shape beneath it. A file
    // entry with no rows would otherwise fall through to "not a test report in
    // any format nen reads" -- true, and useless about a document that is
    // plainly meant to be this one.
    expect(detectFormat("reports/r.json", text("assertion-results-no-rows.json"))?.id).toBe(
      "assertion-results",
    );
    const message = refusal((): unknown => read("assertion-results-no-rows.json"));
    expect(message).toContain("testResults[0].assertionResults is absent");
  });

  it("refuses a row with no name at all", () => {
    const message = refusal((): unknown => read("assertion-results-nameless.json"));
    expect(message).toContain("testResults[0].assertionResults[0].fullName");
  });

  it("refuses a status word it has not met, listing the ones it reads", () => {
    const message = refusal((): unknown => read("assertion-results-unknown-status.json"));
    expect(message).toContain('"flaky"');
    expect(message).toContain("passed, failed, pending, skipped, todo, disabled");
    expect(message).toContain("makes a red suite look green");
  });
});

describe("the result-bundle summary", () => {
  it("reads the counts it STATES and lists only its failures", () => {
    const parsed = read("xcresult-summary.json");
    expect(parsed.counts).toEqual({ passed: 3, failed: 1, skipped: 1, total: 5 });
    // ONE ROW UNDER A TOTAL OF FIVE, and that is correct: `tests.length` is not
    // another spelling of `total` on this format, which is why the document
    // carries both and the rendering says so.
    expect(rows(parsed)).toEqual([
      "PlaceholderTests | refusesANegativeQuantity() | failed | -",
    ]);
  });

  it("walks the per-test list where the same document carries one", () => {
    const parsed = read("xcresult-nodes.json");
    expect(parsed.counts).toEqual({ passed: 3, failed: 1, skipped: 1, total: 5 });
    expect(rows(parsed)).toEqual([
      "CartTests | addsOneItem() | passed | 12",
      "CartTests | addsTwoItems() | passed | 21",
      "CartTests | refusesANegativeQuantity() | failed | 63000",
      "TotalsTests | sumsAnEmptyCart() | passed | 30",
      // Hanging off the bundle rather than a suite, so the bundle names it.
      "PlaceholderTests | appliesADiscount() | skipped | -",
    ]);
  });

  it("reads a duration whose units are in the string", () => {
    // `Number("1m 3s")` is NaN, and a reader that used it would report every
    // test in the suite as untimed.
    expect(read("xcresult-nodes.json").tests[2]?.durationMs).toBe(63000);
  });

  it("counts an expected failure as a pass", () => {
    expect(read("xcresult-nodes.json").tests[3]?.status).toBe("passed");
  });

  it("refuses counts that account for more tests than the run had", () => {
    const message = refusal((): unknown => read("xcresult-impossible.json"));
    expect(message).toContain("reports/xcresult-impossible.json");
    expect(message).toContain("more tests than it says it ran");
  });

  it("refuses a count that is not a number rather than coercing it", () => {
    const message = refusal((): unknown => read("xcresult-malformed.json"));
    expect(message).toContain("passedTests is \"3\"");
    expect(message).toContain("never coerces a count");
  });
});

describe("the read itself", () => {
  it("refuses a path that is not there, naming it as the declaration wrote it", () => {
    const message = refusal((): unknown =>
      readTestReport(testReport("nowhere.xml"), "reports/nowhere.xml"),
    );
    expect(message).toContain("no test report at reports/nowhere.xml");
    // The absolute path is what was opened and is never what is printed.
    expect(message).not.toContain(TEST_REPORTS);
  });

  it("tells a caller who declared a glob that nen expands none", () => {
    const message = refusal((): unknown =>
      readTestReport(testReport("nowhere/*.xml"), "reports/**/*.xml"),
    );
    expect(message).toContain("wildcard");
    expect(message).toContain("no shell anywhere in this program");
  });

  it("refuses a filesystem answer it cannot act on, in its own class", () => {
    // `throwIfNoEntry: false` suppresses ENOENT and nothing else. A path whose
    // parent is a FILE is the portable way to make `statSync` throw, and the
    // point of the assertion is the CLASS: everything this module throws must be
    // a TestReportError, or ../test-report.ts's catch is bypassed and a fact
    // about somebody's checkout reaches the top of the process as a stack trace.
    const message = refusal((): unknown =>
      readTestReport(join(testReport("junit-suites.xml"), "inside"), "reports/results.xml"),
    );
    expect(message).toContain("reports/results.xml");
  });

  it("names the artifact, not the errno's own path, when a read fails", () => {
    // The wrapper the three fs calls share, on an error no test can provoke
    // portably (a permission this account has not got, a mount that went away).
    const message = fsRefusal({ code: "EACCES" }, "reports/results", "listed").message;
    expect(message).toBe(
      "reports/results could not be listed (EACCES). nen reads the report a declaration NAMES; a path it cannot open is a fact about this checkout rather than a report it can parse.",
    );
  });

  it("refuses a file in no format it reads, listing what it does read", () => {
    const message = refusal((): unknown => read("junit-not-a-report.xml"));
    expect(message).toContain("is not a test report in any format nen reads");
    expect(message).toContain("junit");
    expect(message).toContain("the content decides");
  });
});

describe("a DIRECTORY artifact", () => {
  function tree(files: Readonly<Record<string, string>>): string {
    const root = mkdtempSync(join(tmpdir(), "nen-test-report-"));
    for (const [name, body] of Object.entries(files)) {
      const at = join(root, name);
      mkdirSync(join(at, ".."), { recursive: true });
      writeFileSync(at, body);
    }
    return root;
  }

  it("reads every *.xml under it, sorted, and merges them into one report", () => {
    const root = tree({
      "b/TotalsTest.xml": text("junit-suites.xml").replace(/CartTest/g, "TotalsTest"),
      "a/CartTest.xml": text("junit-single.xml"),
      "binary/output.bin": "not xml, and not a candidate",
    });
    try {
      const read = readTestReport(root, "reports/results");
      expect(read.format.id).toBe("junit");
      expect(read.files).toBe(2);
      // SORTED, so two machines produce the same document: `a/` before `b/`.
      expect(read.parsed.tests[0]?.name).toBe("opensASession");
      expect(read.parsed.counts).toEqual({ passed: 4, failed: 3, skipped: 1, total: 8 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses an XML file under it that is not a test report, by name", () => {
    const root = tree({
      "CartTest.xml": text("junit-single.xml"),
      "other.xml": text("junit-not-a-report.xml"),
    });
    try {
      const message = refusal((): unknown => readTestReport(root, "reports/results"));
      expect(message).toContain("reports/results/other.xml");
      expect(message).toContain("carries no <testsuite> element");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("refuses a directory with no XML anywhere under it", () => {
    const root = tree({ "README.md": "no xml here" });
    try {
      const message = refusal((): unknown => readTestReport(root, "reports/results"));
      expect(message).toContain("no *.xml file anywhere under it");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("reads a `.xml` NAME that is really a directory as the directory it is", () => {
    // The name is a hint and the filesystem is the fact -- the same rule the
    // content applies to a file.
    const root = tree({ "CartTest.xml": text("junit-single.xml") });
    try {
      expect(readTestReport(root, "reports/results.xml").files).toBe(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
