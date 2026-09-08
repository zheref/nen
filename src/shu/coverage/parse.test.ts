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
import { coverageReport } from "../fixtures/paths.js";
import { COBERTURA } from "./formats/cobertura.js";
import { ISTANBUL } from "./formats/istanbul.js";
import { JACOCO } from "./formats/jacoco.js";
import { LCOV } from "./formats/lcov.js";
import { XCCOV } from "./formats/xccov.js";
import { decodeEntities, parentOf, scanXml } from "./formats/xml.js";
import { detectFormat, FORMATS, formatNamedBy, readReport, recognisedByName } from "./parse.js";
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
    [LCOV, "malformed.info", /no complete 'SF:' record/],
  ];
  for (const [format, file, message] of bad) {
    it(`${format.id}: ${file}`, () => {
      expect(() => format.parse(fixture(file), file)).toThrow(CoverageReportError);
      expect(() => format.parse(fixture(file), file)).toThrow(message);
    });
  }

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
    const parsed = COBERTURA.parse(fixture("coverage.cobertura.xml"), "x");
    expect(parsed.total.lines).toEqual(TOTAL_LINES);
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

  it("jacoco: drops a package with no LINE counter rather than showing it at 0/0", () => {
    const text = '<report name="x"><package name="empty" /><counter type="LINE" missed="1" covered="1"/></report>';
    expect(JACOCO.parse(text, "x").targets).toEqual([]);
  });

  it("lcov: a branch stated as never reached counts against the denominator", () => {
    const text = ["SF:a.ts", "DA:1,1", "BRDA:1,0,0,2", "BRDA:1,0,1,-", "end_of_record"].join("\n");
    expect(LCOV.parse(text, "x").total.branches).toEqual({ covered: 1, total: 2, percent: 50 });
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
