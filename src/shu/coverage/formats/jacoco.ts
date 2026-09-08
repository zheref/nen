// src/shu/coverage/formats/jacoco.ts -- the JaCoCo XML report (also what a
// Kover run writes in its JaCoCo-compatible form). Pure: text in, one shape out.
//
// THE WHOLE FORMAT IS `<counter type="..." missed="n" covered="n"/>`, REPEATED
// AT FOUR NESTING LEVELS -- method, class/sourcefile, package, report -- and the
// only thing that says which level a counter belongs to is the element it is
// written inside. So this parser reads the PARENT of each counter and nothing
// else: `report` is the total, `package` is a row, and the two deeper levels are
// skipped because their numbers are already inside the package's.
//
// That is also why ./xml.ts returns an ancestor chain rather than a tree: the
// question this format asks of an element is "who is your parent", once, for
// every counter in the file.
//
// `INSTRUCTION`, `COMPLEXITY`, `METHOD` AND `CLASS` COUNTERS ARE IGNORED. This
// report's contract is lines and branches; an instruction figure is a different
// measurement with a different meaning, and reporting it as either would make
// this stack's number incomparable with the other four formats'.

import {
  counts,
  CoverageReportError,
  measure,
  target,
  type CoverageCounts,
  type CoverageFormat,
  type CoverageTarget,
  type ParsedCoverage,
} from "../shape.js";
import { numberAttribute, parentOf, scanXml, type XmlElement } from "./xml.js";

const LINE = "LINE";
const BRANCH = "BRANCH";

interface Tally {
  lines: CoverageCounts | null;
  branches: CoverageCounts | null;
}

function countsOf(element: XmlElement): CoverageCounts | null {
  const missed = numberAttribute(element, "missed");
  const covered = numberAttribute(element, "covered");
  if (missed === null || covered === null) return null;
  return counts(covered, missed + covered);
}

function record(tally: Tally, element: XmlElement): void {
  const type = element.attributes["type"];
  if (type !== LINE && type !== BRANCH) return;
  const value = countsOf(element);
  if (value === null) return;
  if (type === LINE) tally.lines = value;
  else tally.branches = value;
}

export const JACOCO: CoverageFormat = {
  id: "jacoco",
  label: "JaCoCo XML",
  writtenAs: "jacocoTestReport.xml (the path is the plugin's; declare it)",

  namedBy(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower.endsWith(".xml") && (lower.includes("jacoco") || lower.includes("kover"));
  },

  sniff(text: string): boolean {
    const elements = scanXml(text);
    return (
      elements[0]?.name === "report" &&
      elements.some(
        (element): boolean =>
          element.name === "counter" && (element.attributes["type"] === LINE || element.attributes["type"] === BRANCH),
      )
    );
  },

  parse(text: string, path: string): ParsedCoverage {
    const elements = scanXml(text);
    if (elements[0]?.name !== "report") {
      throw new CoverageReportError(
        `${path}: has no <report> root element. This file was read as JaCoCo XML because of its name or its first bytes.`,
      );
    }

    const whole: Tally = { lines: null, branches: null };
    const rows = new Map<string, Tally>();
    let current: Tally | null = null;
    for (const element of elements) {
      if (element.name === "package") {
        const name = element.attributes["name"] ?? "(unnamed)";
        const existing = rows.get(name);
        current = existing ?? { lines: null, branches: null };
        rows.set(name, current);
        continue;
      }
      if (element.name !== "counter") continue;
      const parent = parentOf(element);
      if (parent === "report") record(whole, element);
      else if (parent === "package" && current !== null) record(current, element);
    }

    if (whole.lines === null) {
      throw new CoverageReportError(
        `${path}: carries no <counter type="LINE"> directly under <report>. Line coverage is the one figure nen compares across formats, and a report stating only instruction or complexity counters has not measured it.`,
      );
    }

    const targets: readonly CoverageTarget[] = [...rows.entries()]
      .filter(([, tally]): boolean => tally.lines !== null)
      .map(([name, tally]): CoverageTarget =>
        // The filter above guarantees the non-null; a row whose package
        // declared no LINE counter is dropped rather than shown as 0/0, which
        // would read as "this package is uncovered".
        target(name, tally.lines ?? counts(0, 0), tally.branches),
      )
      .sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    return { total: measure(whole.lines, whole.branches), targets };
  },
};
