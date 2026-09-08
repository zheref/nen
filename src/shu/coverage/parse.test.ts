// src/shu/coverage/parse.test.ts -- the five parsers, against real report
// fixtures, plus the detection that chooses between them.
//
// EVERY HAPPY FIXTURE STATES THE SAME COVERAGE -- 14 of 17 lines, and 3 of 4
// branches where the format measures them -- and that is the point of this file
// rather than a convenience: the claim `nen shu coverage` makes is that five
// formats land on ONE shape, and a suite whose fixtures each stated something
// different could not tell a parser that reads its format correctly from one
// that happens to produce plausible numbers.
//
// THE PARSERS ARE CALLED ON TEXT, not on paths, which is what makes them
// testable at all: ../coverage/parse.ts owns the single read, and the four cases
// that involve the filesystem (missing, unreadable, unrecognised, end to end)
// are proved against it rather than five times over.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { coverageReport } from "../fixtures/paths.js";
import { COBERTURA } from "./formats/cobertura.js";
import { ISTANBUL } from "./formats/istanbul.js";
import { JACOCO } from "./formats/jacoco.js";
import { LCOV } from "./formats/lcov.js";
import { XCCOV } from "./formats/xccov.js";
import { decodeEntities, parentOf, scanXml } from "./formats/xml.js";
import {
  detectFormat,
  fileNameOf,
  FORMATS,
  formatNamedBy,
  readReport,
  recognisedByName,
  supportedFormats,
} from "./parse.js";
import { counts, CoverageReportError, percentOf, sum, type CoverageFormat } from "./shape.js";

function fixture(name: string): string {
  return readFileSync(coverageReport(name), "utf8");
}

/** The line figure every happy fixture states, as this suite's one constant. */
const TOTAL_LINES = { covered: 14, total: 17, percent: 82.35 };
const TOTAL_BRANCHES = { covered: 3, total: 4, percent: 75 };

interface Case {
  readonly format: CoverageFormat;
  readonly file: string;
  readonly branches: boolean;
  /** The row names, in the order the parser must return them: sorted. */
  readonly targets: readonly string[];
  /** The bigger row's line counts, so a swapped ratio cannot pass. */
  readonly first: { readonly covered: number; readonly total: number };
}

const CASES: readonly Case[] = [
  {
    format: ISTANBUL,
    file: "coverage-summary.json",
    branches: true,
    targets: ["packages/app/src/main.ts", "packages/core/src/index.ts"],
    first: { covered: 3, total: 4 },
  },
  {
    format: XCCOV,
    file: "xccov-report.json",
    branches: false,
    targets: ["PlaceholderApp.app", "PlaceholderCore.framework"],
    first: { covered: 11, total: 13 },
  },
  {
    format: COBERTURA,
    file: "coverage.cobertura.xml",
    branches: true,
    targets: ["Placeholder.App", "Placeholder.Core"],
    first: { covered: 3, total: 4 },
  },
  {
    format: JACOCO,
    file: "jacocoTestReport.xml",
    branches: true,
    targets: ["io/placeholder/app", "io/placeholder/core"],
    first: { covered: 3, total: 4 },
  },
  {
    format: LCOV,
    file: "lcov.info",
    branches: true,
    targets: ["packages/app/src/main.ts", "packages/core/src/index.ts"],
    first: { covered: 3, total: 4 },
  },
];

describe("five formats, one shape", () => {
  for (const entry of CASES) {
    describe(`${entry.format.id} (${entry.file})`, () => {
      const parsed = entry.format.parse(fixture(entry.file), entry.file);

      it("states the same total as every other format's fixture", () => {
        expect(parsed.total.lines).toEqual(TOTAL_LINES);
      });

      it(entry.branches ? "carries the branch figure" : "omits branches rather than zeroing them", () => {
        if (entry.branches) {
          expect(parsed.total.branches).toEqual(TOTAL_BRANCHES);
        } else {
          // The KEY is absent, not merely undefined: `0 of 0 branches` reads as
          // "nothing is covered" to a caller that does not already know the
          // tool has no branch figure at all.
          expect(Object.keys(parsed.total)).toEqual(["lines"]);
        }
      });

      it("returns its rows sorted by name", () => {
        expect(parsed.targets.map((row): string => row.name)).toEqual(entry.targets);
      });

      it("reports each row's own counts, in the row's own order", () => {
        expect(parsed.targets[0]?.lines.covered).toBe(entry.first.covered);
        expect(parsed.targets[0]?.lines.total).toBe(entry.first.total);
      });

      it("adds up to the total it states", () => {
        // Four of the five formats state a total of their own and this suite
        // reads it rather than deriving it -- so this is the cross-check that
        // the rows and the total are about the same run.
        expect(sum(parsed.targets).lines).toEqual(parsed.total.lines);
      });

      it("computes percent from covered/total, in that order", () => {
        // THE SWAPPED-RATIO MUTANT. 14/17 is 82.35 and 17/14 is 121.43; a
        // parser with the arguments the wrong way round produces a plausible
        // number for a plausible-looking report, and only a fixture whose two
        // figures differ can tell them apart.
        expect(parsed.total.lines.percent).toBe(82.35);
        expect(parsed.total.lines.percent).not.toBe(121.43);
      });
    });
  }
});

describe("a report about no code has no percentage", () => {
  const empties: readonly (readonly [CoverageFormat, string])[] = [
    [ISTANBUL, "empty-coverage-summary.json"],
    [XCCOV, "xccov-empty.json"],
    [COBERTURA, "empty.cobertura.xml"],
    [JACOCO, "jacoco-empty.xml"],
    [LCOV, "empty.info"],
  ];
  for (const [format, file] of empties) {
    it(`${format.id}: 0 of 0 is null, not 100% and not 0%`, () => {
      const parsed = format.parse(fixture(file), file);
      expect(parsed.total.lines).toEqual({ covered: 0, total: 0, percent: null });
    });
  }

  it("ignores the percentage the file itself states", () => {
    // The Istanbul empty fixture says `"pct": 100`, which is what that reporter
    // writes for a report about nothing. Reading it would make nen agree that
    // no code is fully covered.
    expect(fixture("empty-coverage-summary.json")).toContain('"pct": 100');
    expect(ISTANBUL.parse(fixture("empty-coverage-summary.json"), "x").total.lines.percent).toBeNull();
  });
});

describe("a malformed report is refused by name, never guessed at", () => {
  const bad: readonly (readonly [CoverageFormat, string, RegExp])[] = [
    [ISTANBUL, "malformed-coverage-summary.json", /is not readable as JSON/],
    [XCCOV, "xccov-malformed.json", /targets\[0\]\.name is absent/],
    [COBERTURA, "malformed.cobertura.xml", /neither a 'lines-valid' attribute/],
    [JACOCO, "jacoco-malformed.xml", /no <counter type="LINE"> directly under <report>/],
    [LCOV, "malformed.info", /ends mid-record/],
  ];
  for (const [format, file, message] of bad) {
    it(`${format.id}: ${file}`, () => {
      expect(() => format.parse(fixture(file), file)).toThrow(CoverageReportError);
      expect(() => format.parse(fixture(file), file)).toThrow(message);
    });
  }

  it("lcov: names the record it stopped inside", () => {
    // The `SF:` is the whole diagnosis: it is the file the writer was on when
    // it stopped, which is where a truncated tracefile is investigated from.
    expect(() => LCOV.parse(fixture("malformed.info"), "x")).toThrow(
      "packages/core/src/index.ts",
    );
  });

  it("lcov: a truncated record after a COMPLETE one is still a refusal", () => {
    // THE MUTANT THIS EXISTS FOR: flush what arrived and carry on. One
    // complete 13-line record beside a truncated 100-line one then reports
    // 100% for a project that is nowhere near it -- and nothing in the output
    // says a row went missing, because this format's total IS the sum of its
    // rows. `malformed.info` cannot catch that: it has no complete record, so
    // the older "no complete 'SF:' record" refusal fires either way.
    const text = [
      "SF:a.ts",
      "DA:1,1",
      "LF:1",
      "LH:1",
      "end_of_record",
      "SF:b.ts",
      "DA:1,0",
      "LF:100",
    ].join("\n");
    expect(() => LCOV.parse(text, "cov/lcov.info")).toThrow(CoverageReportError);
    expect(() => LCOV.parse(text, "cov/lcov.info")).toThrow(/ends mid-record at 'SF:b\.ts'/);
  });

  it("lcov: a file with no 'SF:' at all is the other refusal", () => {
    expect(() => LCOV.parse("TN:\n", "x")).toThrow(/contains no complete 'SF:' record/);
  });

  it("refuses more covered than there is to cover, naming both counts", () => {
    // `percentOf(20, 17)` is 117.65, which is not a coverage percentage; the
    // two numbers came from different places and saying so beats printing it.
    const text = JSON.stringify({ total: { lines: { total: 17, covered: 20 } } });
    expect(() => ISTANBUL.parse(text, "x")).toThrow(CoverageReportError);
    expect(() => ISTANBUL.parse(text, "x")).toThrow(/states 20 of 17 covered/);
    // The same guard on the XML side, where the two numbers are attributes on
    // the root and nothing else in the file has to agree with them.
    const xml =
      '<coverage line-rate="1" lines-covered="100" lines-valid="10"><packages /></coverage>';
    expect(() => COBERTURA.parse(xml, "x")).toThrow(/states 100 of 10 covered/);
  });

  it("quotes a count JSON cannot spell, rather than calling it null", () => {
    // `JSON.parse('{"covered": 1e400}')` is `Infinity`, and
    // `JSON.stringify(Infinity)` is the string "null" -- so the refusal used to
    // tell a reader whose number overflowed that their count was absent.
    expect(() => ISTANBUL.parse('{"total":{"lines":{"covered":1e400,"total":17}}}', "x")).toThrow(
      /total\.lines\.covered is Infinity/,
    );
  });

  it("names the file in the refusal, so a reader knows which one to open", () => {
    expect(() => ISTANBUL.parse("{", "coverage/report.json")).toThrow(/^coverage\/report\.json: /);
  });

  it("refuses a count that is not a number rather than coercing it", () => {
    const text = JSON.stringify({ total: { lines: { total: "17", covered: 14 } } });
    expect(() => ISTANBUL.parse(text, "x")).toThrow(/is "17", and a coverage count is a non-negative number/);
  });
});

describe("the traps each format sets", () => {
  it("cobertura: does not count a <line> twice because a <method> repeats it", () => {
    // The fixture repeats two of the class's thirteen lines inside a <method>.
    // A reader that counts every <line> element reports 15 lines for a file
    // that has 13 -- and a total larger than the file.
    const parsed = COBERTURA.parse(fixture("coverage.cobertura.xml"), "x");
    const core = parsed.targets.find((row): boolean => row.name === "Placeholder.Core");
    expect(core?.lines).toEqual({ covered: 11, total: 13, percent: 84.62 });
    expect(fixture("coverage.cobertura.xml")).toContain("<method");
  });

  it("cobertura: prefers the root's own counts over its own sum of the rows", () => {
    // ON A FIXTURE WHERE THE TWO DISAGREE, or the assertion cannot fail: the
    // happy fixture's rows sum exactly to its root, so a parser that summed
    // instead would pass it. Here the root states 14/17 and the rows nen can
    // see account for 11/13, because one package is present with an empty
    // <classes/>.
    const parsed = COBERTURA.parse(fixture("root-counts.cobertura.xml"), "x");
    expect(parsed.total.lines).toEqual(TOTAL_LINES);
    expect(sum(parsed.targets).lines).toEqual({ covered: 11, total: 13, percent: 84.62 });
    expect(parsed.total.branches).toEqual(TOTAL_BRANCHES);
  });

  it("cobertura: a package with no classes is a row at 0 of 0, not a dropped row", () => {
    // It was in the file, so it is in the table -- as `--`, which is what a
    // null percentage renders as. (JaCoCo's parser DROPS the equivalent row,
    // because a package there carries counters rather than a class list and a
    // package with no LINE counter has not been measured at all. The two
    // formats disagree about what the empty case means, and each reader
    // follows its own format.)
    const parsed = COBERTURA.parse(fixture("root-counts.cobertura.xml"), "x");
    const generated = parsed.targets.find((row): boolean => row.name === "Placeholder.Generated");
    expect(generated?.lines).toEqual({ covered: 0, total: 0, percent: null });
  });

  it("jacoco: reads the counters under <report> and <package>, not the deeper ones", () => {
    // The fixture states the same LINE counter at method, class, sourcefile,
    // package and report level. A parser that summed every counter it saw
    // would report several times the file's own total.
    const parsed = JACOCO.parse(fixture("jacocoTestReport.xml"), "x");
    expect(parsed.total.lines).toEqual(TOTAL_LINES);
    expect(parsed.targets.map((row): unknown => [row.name, row.lines.covered, row.lines.total])).toEqual([
      ["io/placeholder/app", 3, 4],
      ["io/placeholder/core", 11, 13],
    ]);
  });

  it("jacoco: adds up a package name that appears in two <group>s", () => {
    // THE AGGREGATE SHAPE, which is what a multi-module Gradle build writes and
    // what the single-module fixture above cannot exercise. `io/placeholder/
    // util` is compiled into both modules; a parser that ASSIGNED each counter
    // to the row would report the last group's lines (4/5) beside the first
    // group's branches (1/2), and the rows would stop adding up to the total.
    const parsed = JACOCO.parse(fixture("jacoco-aggregate.xml"), "x");
    const util = parsed.targets.find((row): boolean => row.name === "io/placeholder/util");
    expect(util?.lines).toEqual({ covered: 7, total: 9, percent: 77.78 });
    expect(util?.branches).toEqual({ covered: 3, total: 4, percent: 75 });
    expect(parsed.total.lines).toEqual({ covered: 12, total: 16, percent: 75 });
    // The cross-check that makes it one report rather than two halves.
    expect(sum(parsed.targets).lines).toEqual(parsed.total.lines);
    expect(sum(parsed.targets).branches).toEqual(parsed.total.branches);
  });

  it("jacoco: a package row is the PACKAGE counter, never the classes under it", () => {
    // The aggregate fixture states class counters for `io/placeholder/core`
    // that deliberately do not sum to its package counter (1/1 and 1/1 against
    // 5/7). A reader taking its row from the <class> level gets 2/2; one that
    // takes the last class gets 1/1. Neither is the row.
    const parsed = JACOCO.parse(fixture("jacoco-aggregate.xml"), "x");
    const core = parsed.targets.find((row): boolean => row.name === "io/placeholder/core");
    expect(core?.lines).toEqual({ covered: 5, total: 7, percent: 71.43 });
  });

  it("jacoco: drops a package with no LINE counter rather than showing it at 0/0", () => {
    const text = '<report name="x"><package name="empty" /><counter type="LINE" missed="1" covered="1"/></report>';
    expect(JACOCO.parse(text, "x").targets).toEqual([]);
  });

  it("lcov: a branch stated as never reached counts against the denominator", () => {
    const text = ["SF:a.ts", "DA:1,1", "BRDA:1,0,0,2", "BRDA:1,0,1,-", "end_of_record"].join("\n");
    expect(LCOV.parse(text, "x").total.branches).toEqual({ covered: 1, total: 2, percent: 50 });
  });

  it("lcov: counts the DA entries when the record states no LF/LH", () => {
    // SOME WRITERS OMIT THE SUMMARY LINES, and the entries are then the only
    // figure in the record. A fallback that answered 0/0 here would report a
    // whole file as "a report about no code" -- which reads as `--%`, not as a
    // mistake -- and every fixture in this suite states LF/LH, so nothing else
    // would notice.
    const text = ["SF:a.ts", "DA:1,1", "DA:2,3", "DA:3,0", "end_of_record"].join("\n");
    const parsed = LCOV.parse(text, "x");
    expect(parsed.total.lines).toEqual({ covered: 2, total: 3, percent: 66.67 });
    expect(parsed.targets[0]?.lines).toEqual({ covered: 2, total: 3, percent: 66.67 });
  });

  it("lcov: prefers LF/LH over counting DA entries", () => {
    // The two disagree on purpose here: a reporter that excludes a line from
    // its own totals has made a decision, and nen reports the tool's answer.
    const text = ["SF:a.ts", "DA:1,1", "DA:2,1", "DA:3,0", "LF:2", "LH:2", "end_of_record"].join("\n");
    expect(LCOV.parse(text, "x").total.lines).toEqual({ covered: 2, total: 2, percent: 100 });
  });

  it("xccov: reads the counts and never the fraction beside them", () => {
    // `lineCoverage` is 0.82, not 82. A reader that took it for a percentage
    // would report an 82%-covered app as under 1% covered.
    const text = JSON.stringify({
      coveredLines: 14,
      executableLines: 17,
      lineCoverage: 0.82,
      targets: [],
    });
    expect(XCCOV.parse(text, "x").total.lines.percent).toBe(82.35);
  });
});

describe("the XML reader", () => {
  it("gives every element its ancestors, so a counter knows its parent", () => {
    const elements = scanXml('<a><b><c x="1"/></b></a>');
    const c = elements.find((element): boolean => element.name === "c");
    expect(c?.ancestors).toEqual(["a", "b"]);
    expect(parentOf(c!)).toBe("b");
    expect(c?.attributes).toEqual({ x: "1" });
  });

  it("skips a comment, a processing instruction, a DOCTYPE and a CDATA block", () => {
    const elements = scanXml(
      '<?xml version="1.0"?><!DOCTYPE r><!-- <fake x="1"/> --><r><![CDATA[<also x="2"/>]]><real /></r>',
    );
    expect(elements.map((element): string => element.name)).toEqual(["r", "real"]);
  });

  it("reads single-quoted attributes and decodes the five entities", () => {
    const elements = scanXml("<a name='A &amp; B' other=\"&lt;x&gt;\" />");
    expect(elements[0]?.attributes).toEqual({ name: "A & B", other: "<x>" });
    expect(decodeEntities("&#65;&#x42;&unknown;")).toBe("AB&unknown;");
  });

  it("decodes decimal and hex numeric entities by their own digit sets, and leaves the rest alone", () => {
    // A single shared `#x?[0-9a-fA-F]+` pattern let a decimal reference like
    // `&#1a;` match too -- `Number.parseInt("1a", 10)` silently returns 1,
    // decoding to U+0001 instead of being left alone as the comment above
    // `decodeEntities` promises. Splitting decimal and hex into their own
    // digit sets closes that: `&#1a;` matches neither alternative, so
    // `replace` never touches it.
    expect(decodeEntities("&#1a;")).toBe("&#1a;");
    expect(decodeEntities("&#65;")).toBe("A");
    expect(decodeEntities("&#x41;")).toBe("A");
    expect(decodeEntities("&#X41;")).toBe("A");
    // A lone surrogate and NUL are not valid Unicode scalar values on their
    // own -- `String.fromCodePoint` would still hand one back for either --
    // so both are left alone rather than "decoded" into something no reader
    // downstream wants to see.
    expect(decodeEntities("&#xD800;")).toBe("&#xD800;");
    expect(decodeEntities("&#0;")).toBe("&#0;");
    // An unrecognised named entity is left alone, same as a malformed
    // numeric one: this reader expands five names and nothing else.
    expect(decodeEntities("&nbsp;")).toBe("&nbsp;");
    // Exactly one decoding pass runs over the original text, so the `&lt;`
    // produced by decoding `&amp;` is not itself re-scanned and decoded a
    // second time into `<`.
    expect(decodeEntities("&amp;lt;")).toBe("&lt;");
  });

  it("ignores an unbalanced close tag rather than losing the rest of the file", () => {
    const elements = scanXml("<a><b/></c><d/></a>");
    expect(elements.map((element): string => element.name)).toEqual(["a", "b", "d"]);
  });
});

describe("choosing a parser", () => {
  it("recognises each happy fixture by name alone", () => {
    for (const entry of CASES) {
      expect(recognisedByName(`coverage/${entry.file}`), entry.file).toBe(true);
      expect(formatNamedBy(entry.file)?.id).toBe(entry.format.id);
    }
  });

  it("does not recognise a file that is not a report", () => {
    expect(recognisedByName("coverage/notes.md")).toBe(false);
    expect(recognisedByName("coverage")).toBe(false);
    expect(formatNamedBy("coverage/index.html")).toBeNull();
  });

  it("cuts the file name on BOTH separators, on whichever platform this is", () => {
    // `node:path`'s `basename` is platform-dependent, so a declaration written
    // with Windows separators was recognised on win32 and refused on the other
    // two -- the same file, the same declaration, three answers. `fileNameOf`
    // is the platform-independent cut, and this is stated with `join` for the
    // native shape and a literal for the foreign one, so it holds either way.
    expect(fileNameOf(join("coverage", "lcov.info"))).toBe("lcov.info");
    expect(fileNameOf("coverage\\lcov.info")).toBe("lcov.info");
    expect(fileNameOf("coverage/lcov.info")).toBe("lcov.info");
    expect(fileNameOf("lcov.info")).toBe("lcov.info");
    for (const path of ["coverage\\lcov.info", "coverage/lcov.info", "a\\b/c\\lcov.info"]) {
      expect(recognisedByName(path), path).toBe(true);
      expect(formatNamedBy(path)?.id, path).toBe("lcov");
    }
  });

  it("names coverage-final.json as the file that is NOT one of the formats", () => {
    // The likeliest first mistake: it is what a v8/Istanbul run writes by
    // default, it sits beside the summary, and it is a per-statement map. A
    // refusal that listed five formats without mentioning it left a reader
    // staring at a filename the list did not explain.
    expect(recognisedByName("coverage/coverage-final.json")).toBe(false);
    expect(supportedFormats()).toContain("coverage-final.json");
    expect(supportedFormats()).toContain("json-summary");
  });

  it("lets the CONTENT overrule a name that says something else", () => {
    // A repository is free to call its report whatever it likes. The name puts
    // a parser at the front of the queue; the bytes decide.
    const cobertura = fixture("coverage.cobertura.xml");
    expect(detectFormat("lcov.info", cobertura)?.id).toBe(COBERTURA.id);
    expect(detectFormat("nothing-familiar.txt", fixture("lcov.info"))?.id).toBe(LCOV.id);
  });

  it("claims nothing it cannot read", () => {
    expect(detectFormat("notes.md", fixture("notes.md"))).toBeNull();
    expect(detectFormat("coverage.json", "{}")).toBeNull();
    expect(detectFormat("coverage.xml", "<other/>")).toBeNull();
  });

  it("keeps the two JSON formats apart", () => {
    expect(detectFormat("report.json", fixture("xccov-report.json"))?.id).toBe(XCCOV.id);
    expect(detectFormat("report.json", fixture("coverage-summary.json"))?.id).toBe(ISTANBUL.id);
  });

  it("carries five formats, each with an id, a label and a name rule", () => {
    expect(FORMATS.map((format): string => format.id)).toEqual([
      "istanbul-summary",
      "xccov-report",
      "cobertura",
      "jacoco",
      "lcov",
    ]);
    expect(new Set(FORMATS.map((format): string => format.id)).size).toBe(FORMATS.length);
    for (const format of FORMATS) expect(format.writtenAs).not.toBe("");
  });
});

describe("the one read", () => {
  it("parses a report end to end, format and all", () => {
    const parsed = readReport(coverageReport("lcov.info"), "coverage/lcov.info");
    expect(parsed.format.id).toBe("lcov");
    expect(parsed.coverage.total.lines).toEqual(TOTAL_LINES);
  });

  it("names the path a caller has to fix, never the absolute one it opened", () => {
    expect(() => readReport(coverageReport("nowhere.info"), "coverage/nowhere.info")).toThrow(
      /^no coverage report at coverage\/nowhere\.info\./,
    );
    expect(() => readReport(coverageReport("nowhere.info"), "coverage/nowhere.info")).toThrow(
      /names it under this verb's 'artifacts'/,
    );
  });

  it("lists the formats it reads when a file is in none of them", () => {
    expect(() => readReport(coverageReport("notes.md"), "coverage/notes.md")).toThrow(
      /is not a coverage report in any format nen reads/,
    );
    expect(() => readReport(coverageReport("notes.md"), "coverage/notes.md")).toThrow(/lcov/);
  });

  it("says an artifact is a literal path when the missing one has a wildcard", () => {
    // `coverage/*.info` is recognised BY NAME (it ends in `.info`), so nen goes
    // and opens a file called `*.info` and truthfully reports that it is not
    // there -- which is the least useful true sentence available. nen expands
    // nothing: there is no shell anywhere in this program.
    expect(() => readReport(coverageReport("*.info"), "coverage/*.info")).toThrow(
      /wildcard, and an artifact is a LITERAL path/,
    );
    // And the sentence is not bolted onto every missing file.
    expect(() => readReport(coverageReport("nowhere.info"), "coverage/nowhere.info")).not.toThrow(
      /wildcard/,
    );
  });

  it("names the file in a refusal the arithmetic raised, not only the parsers'", () => {
    // `../shape.ts` is handed two numbers and no path, so its refusal has no
    // file in it; the one read is what guarantees every message says which
    // file to open.
    expect(() => readReport(coverageReport("impossible-counts.json"), "coverage/impossible.json"))
      .toThrow(/^coverage\/impossible\.json: states 20 of 17 covered/);
  });

  it("distinguishes 'not there' from 'could not be read'", () => {
    // A directory is present and unreadable-as-a-file, which is a different
    // sentence from a missing report and a different thing to go and fix.
    expect(() => readReport(coverageReport(""), "coverage/")).toThrow(/could not be read \(EISDIR\)/);
  });
});

describe("the arithmetic", () => {
  it("rounds to two decimals and refuses to divide by nothing", () => {
    expect(percentOf(14, 17)).toBe(82.35);
    expect(percentOf(1, 3)).toBe(33.33);
    expect(percentOf(0, 0)).toBeNull();
    expect(percentOf(1, 1)).toBe(100);
  });

  it("keeps branches out of a sum where nothing measured them", () => {
    const rows = [{ lines: counts(1, 2) }, { lines: counts(1, 2) }];
    expect(Object.keys(sum(rows))).toEqual(["lines"]);
    expect(Object.keys(sum([...rows, { lines: counts(1, 1), branches: counts(0, 2) }]))).toEqual([
      "lines",
      "branches",
    ]);
  });
});
