// src/shu/coverage/formats/cobertura.ts -- the Cobertura XML a coverlet run
// writes (`coverage.cobertura.xml`), and the same schema wherever else it is
// produced. Pure: text in, one shape out.
//
// THE ROOT'S OWN COUNTS ARE PREFERRED, AND SUMMING IS THE FALLBACK. A writer
// that states `lines-covered`/`lines-valid` on `<coverage>` has already done
// the arithmetic over its own model of the tree, and re-deriving it here would
// make nen's total disagree with the tool's own summary for any file whose
// rows nen walks differently. Where those attributes are absent -- the older
// writers state only `line-rate` -- the packages are summed instead, which is
// the only honest answer available and is reported the same way.
//
// A `<line>` INSIDE A `<method>` IS THE SAME LINE AGAIN. This format nests the
// per-line list twice: once under `<class><lines>` and once per method under
// `<method><lines>`. Counting every `<line>` element in the document
// double-counts every covered line in the file and produces a total larger than
// the file has lines in it. So the walk takes only the lines that are NOT
// inside a method, which is the class-level list.

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
import { numberAttribute, scanXml, type XmlElement } from "./xml.js";

/** `50% (1/2)` -- the branch figure this format hangs off a line. */
const CONDITION = /\((\d+)\/(\d+)\)/;

interface Tally {
  linesCovered: number;
  linesTotal: number;
  branchesCovered: number;
  branchesTotal: number;
  sawBranches: boolean;
}

function empty(): Tally {
  return { linesCovered: 0, linesTotal: 0, branchesCovered: 0, branchesTotal: 0, sawBranches: false };
}

function addLine(tally: Tally, element: XmlElement): void {
  tally.linesTotal += 1;
  if ((numberAttribute(element, "hits") ?? 0) > 0) tally.linesCovered += 1;
  const condition = element.attributes["condition-coverage"];
  if (condition === undefined) return;
  const match = CONDITION.exec(condition);
  if (match === null) return;
  const covered = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(covered) || !Number.isFinite(total)) return;
  tally.sawBranches = true;
  tally.branchesCovered += covered;
  tally.branchesTotal += total;
}

function branchesOf(tally: Tally): CoverageCounts | null {
  return tally.sawBranches ? counts(tally.branchesCovered, tally.branchesTotal) : null;
}

export const COBERTURA: CoverageFormat = {
  id: "cobertura",
  label: "Cobertura XML",
  writtenAs: "coverage.cobertura.xml",

  namedBy(fileName: string): boolean {
    const lower = fileName.toLowerCase();
    return lower.endsWith("cobertura.xml") || lower === "coverage.xml";
  },

  sniff(text: string): boolean {
    const elements = scanXml(text);
    const root = elements[0];
    return root?.name === "coverage" && root.attributes["line-rate"] !== undefined;
  },

  parse(text: string, path: string): ParsedCoverage {
    const elements = scanXml(text);
    const root = elements[0];
    if (root === undefined || root.name !== "coverage") {
      throw new CoverageReportError(
        `${path}: has no <coverage> root element. This file was read as Cobertura XML because of its name or its first bytes.`,
      );
    }

    // One pass, in document order: a `<package>` opens a row, and every
    // class-level `<line>` after it belongs to that row until the next one.
    const rows = new Map<string, Tally>();
    const whole = empty();
    let current: Tally | null = null;
    for (const element of elements) {
      if (element.name === "package") {
        const name = element.attributes["name"] ?? "(unnamed)";
        const existing = rows.get(name);
        // A NAME SEEN TWICE IS ONE ROW, NOT TWO. Some writers split one package
        // across several elements; two rows with the same name in the output
        // would read as two packages, and the reader could not tell which was
        // which.
        current = existing ?? empty();
        rows.set(name, current);
        continue;
      }
      if (element.name !== "line" || element.ancestors.includes("method")) continue;
      addLine(whole, element);
      if (current !== null) addLine(current, element);
    }

    const targets: readonly CoverageTarget[] = [...rows.entries()]
      .map(([name, tally]): CoverageTarget =>
        target(name, counts(tally.linesCovered, tally.linesTotal), branchesOf(tally)),
      )
      .sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    const statedCovered = numberAttribute(root, "lines-covered");
    const statedValid = numberAttribute(root, "lines-valid");
    const statedBranchCovered = numberAttribute(root, "branches-covered");
    const statedBranchValid = numberAttribute(root, "branches-valid");
    if (statedValid === null && whole.linesTotal === 0) {
      throw new CoverageReportError(
        `${path}: states neither a 'lines-valid' attribute on <coverage> nor a single <line> element. There is no line figure in this file to report.`,
      );
    }
    return {
      total: measure(
        statedCovered !== null && statedValid !== null
          ? counts(statedCovered, statedValid)
          : counts(whole.linesCovered, whole.linesTotal),
        statedBranchCovered !== null && statedBranchValid !== null
          ? counts(statedBranchCovered, statedBranchValid)
          : branchesOf(whole),
      ),
      targets,
    };
  },
};
