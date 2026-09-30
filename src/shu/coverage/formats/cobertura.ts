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
//
// A SECOND VIEW RIDES ALONG IN THE SAME PASS, FOR `--touched` ONLY
// (zheref/nen#296). The rows above are packages, and a plain run keeps them;
// but `--touched` asks about FILES, and every `<class>` names one. So the walk
// also collects, per distinct `filename` (backslashes read as `/`), the UNION
// of the class-level lines every entry naming it states -- ../shape.ts's
// `unionLine` is the rule and says why a sum would be wrong (one C# file is
// several `<class>` entries: partial, nested, compiler-generated) -- and the
// `<sources><source>` roots those names are relative to. Nothing here decides
// which root a name belongs to: that needs the tree, and ../files.ts has it.
// A report whose classes state no `filename` at all carries no such view,
// which is the one case `--touched` still matches by package.

import {
  counts,
  CoverageReportError,
  measure,
  target,
  impossibleConditions,
  unionLine,
  type CoverageCounts,
  type CoverageFormat,
  type CoverageTarget,
  type LineFact,
  type ParsedCoverage,
  type SourceFile,
  type SourceFiles,
} from "../shape.js";
import { numberAttribute, parentOf, scanXml, type XmlElement } from "./xml.js";

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

/** A line's `condition-coverage` figure, or null when it states none this reader can use. */
function conditionOf(element: XmlElement): { readonly covered: number; readonly total: number } | null {
  const condition = element.attributes["condition-coverage"];
  if (condition === undefined) return null;
  const match = CONDITION.exec(condition);
  if (match === null) return null;
  const covered = Number(match[1]);
  const total = Number(match[2]);
  return Number.isFinite(covered) && Number.isFinite(total) ? { covered, total } : null;
}

function addLine(tally: Tally, element: XmlElement): void {
  tally.linesTotal += 1;
  if ((numberAttribute(element, "hits") ?? 0) > 0) tally.linesCovered += 1;
  const figure = conditionOf(element);
  if (figure === null) return;
  tally.sawBranches = true;
  tally.branchesCovered += figure.covered;
  tally.branchesTotal += figure.total;
}

function branchesOf(tally: Tally): CoverageCounts | null {
  return tally.sawBranches ? counts(tally.branchesCovered, tally.branchesTotal) : null;
}

/** One `<line>` as a fact about its file: did it run, and its condition figure. */
function factOf(element: XmlElement): LineFact {
  return { hit: (numberAttribute(element, "hits") ?? 0) > 0, branches: conditionOf(element) };
}

/**
 * A class's `filename`, `/`-separated, or null when it states none.
 *
 * BACKSLASHES ARE SEPARATORS HERE, ON EVERY PLATFORM: coverlet on Windows
 * writes `Core\Models\A.cs`, and the same report read on a mac must name
 * the same file. Nothing else is rewritten -- a space is part of a path.
 */
function classFileName(element: XmlElement): string | null {
  const raw = element.attributes["filename"];
  if (raw === undefined || raw.trim() === "") return null;
  return raw.replace(/\\/g, "/");
}

/** The per-file view, or undefined when no class named a file. */
function sourceFilesOf(
  roots: readonly string[],
  files: ReadonlyMap<string, Map<number, LineFact>>,
  entryCounts: ReadonlyMap<string, number>,
): SourceFiles | undefined {
  if (files.size === 0) return undefined;
  const entries: SourceFile[] = [...files.entries()]
    .map(([name, lines]): SourceFile => ({ name, lines, entries: entryCounts.get(name) ?? 1 }))
    .sort((left, right): number => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));
  return { roots, files: entries };
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
    // The per-file view (see the header): each file's lines keyed by line
    // number, and the roots `<sources>` states.
    const roots: string[] = [];
    const files = new Map<string, Map<number, LineFact>>();
    // How many <class> entries named each file -- ./shape.ts's
    // `SourceFile.entries` says why resolution needs it.
    const entryCounts = new Map<string, number>();
    // Which file (or class) the lines being read belong to, for a refusal.
    let owner = "a line outside any class";
    let file: Map<number, LineFact> | null = null;
    // A `<line>` with no readable `number` cannot be told apart from another,
    // so it is never merged: each one is its own line, under a key no real
    // line number takes.
    let unnumbered = 0;
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
        file = null;
        continue;
      }
      if (element.name === "source" && parentOf(element) === "sources") {
        const root = element.text.trim();
        if (root !== "") roots.push(root);
        continue;
      }
      if (element.name === "class") {
        // A CLASS WITH NO `filename` CONTRIBUTES NO FILE: its lines still count
        // in the total and in its package's row, but there is no file to credit
        // them to, and inventing one would be the package fallback by another
        // name.
        const name = classFileName(element);
        owner = name ?? `class '${element.attributes["name"] ?? "(unnamed)"}'`;
        if (name === null) {
          file = null;
          continue;
        }
        file = files.get(name) ?? new Map<number, LineFact>();
        files.set(name, file);
        entryCounts.set(name, (entryCounts.get(name) ?? 0) + 1);
        continue;
      }
      if (element.name !== "line" || element.ancestors.includes("method")) continue;
      // ONE LINE, ONE REFUSAL, ON EVERY PATH (zheref/nen#296, review round 3).
      // The tallies below add a line's condition figure into a package and a
      // total, and `counts` checks only those SUMS -- so `(5/2)` beside
      // `(0/4)` came out as a plausible 5 of 6 on a plain run while
      // `--touched` refused the very same report. Checked here, per line,
      // before anything is added up.
      const figure = conditionOf(element);
      if (figure !== null && figure.covered > figure.total) {
        throw impossibleConditions(`${path}: ${owner}`, numberAttribute(element, "number"), figure.covered, figure.total);
      }
      addLine(whole, element);
      if (current !== null) addLine(current, element);
      if (file !== null && element.ancestors.includes("class")) {
        const number = numberAttribute(element, "number");
        const key = number === null ? -(++unnumbered) : number;
        file.set(key, unionLine(file.get(key), factOf(element)));
      }
    }
    const perFile = sourceFilesOf(roots, files, entryCounts);

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
      ...(perFile === undefined ? {} : { files: perFile }),
    };
  },
};
