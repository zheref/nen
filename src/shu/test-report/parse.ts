// src/shu/test-report/parse.ts -- which format a report is in, and the one read
// that turns a declared path into a parsed shape.
//
// THREE FORMATS, ONE REGISTRY, NO RUNNER NAMES. A parser is chosen by what the
// file IS, never by which stack the lane declares: the XML shape below is
// written by runners on every stack this family knows, and keying the choice on
// the stack id would mean a repository that switched runners got a refusal
// about its stack instead of a report. ../test-report.ts never passes a stack
// down here, and there is no parameter for one.
//
// NAME FIRST, CONTENT DECIDES -- ../coverage/parse.ts's rule, and it matters
// more here: two of the three formats are `.json`, so a name match only puts a
// format at the front of the queue and the bytes settle it.
//
// AND ONE ARTIFACT IS A DIRECTORY. A runner that writes one XML file per suite
// declares the DIRECTORY it writes them into, which is what its own
// documentation tells a maintainer to collect -- so a path that is a directory
// on disk is read as a tree of `*.xml` and merged into one report. That is
// decided by `statSync`, not by the name, so a `.xml` path that turns out to be
// a directory and an extension-less path that turns out to be a file are each
// read as what they are. The NAME still decides which artifact is CHOSEN
// (../test-report.ts's `chooseArtifact`), because a dry run has to be able to
// say what a real run would parse and has nothing on disk to look at.
//
// THE READ LIVES HERE AND NOT IN THE PARSERS. Each format module takes TEXT and
// returns a shape, which is what makes it unit-testable on a string and what
// keeps three copies of the same "no such file" sentence from existing. There
// is exactly one place in this family that opens a test report, and this is it.

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
// ONE PATH-SPLITTING RULE FOR BOTH VERBS. `fileNameOf` cuts on both separators
// on every platform, for the reason its own comment gives -- a declaration is a
// file in somebody else's repository and may state a backslash -- and a second
// copy of that decision here is a second place for it to drift.
import { fileNameOf } from "../coverage/parse.js";
import { mergeParsed, TestReportError, type ParsedTests, type TestReportFormat } from "./shape.js";
import { ASSERTION_RESULTS } from "./formats/assertion-results.js";
import { JUNIT } from "./formats/junit.js";
import { XCRESULT_SUMMARY } from "./formats/xcresult.js";

/**
 * Every format this release reads, in the order a refusal lists them.
 *
 * THE ORDER IS ALSO THE SNIFF ORDER for a file whose name says nothing. The XML
 * one is first because its sniff is a start tag rather than a parse; the two
 * JSON sniffs are disjoint (one wants a `testResults` array, the other a
 * `totalTestCount` number), so their order between themselves decides nothing.
 */
export const FORMATS: readonly TestReportFormat[] = [JUNIT, ASSERTION_RESULTS, XCRESULT_SUMMARY];

/** `junit -- JUnit XML, *.xml ...` -- for a refusal. */
export function supportedFormats(): string {
  return FORMATS.map(
    (format): string => `${format.id} -- ${format.label}, written as ${format.writtenAs}`,
  ).join("; ");
}

/**
 * Does this path's NAME look like a report nen can read?
 *
 * USED TO CHOOSE AMONG DECLARED ARTIFACTS, and only there. A `test` verb
 * routinely names several outputs -- an HTML tree, a coverage report, the
 * machine-readable results -- and nen picks by name rather than reading each
 * one to find out, because a dry run has no bytes to read and must still be
 * able to say which artifact the real run would parse.
 */
export function recognisedByName(path: string): boolean {
  return formatNamedBy(path) !== null;
}

/** The first format whose name rule claims this path, or null. */
export function formatNamedBy(path: string): TestReportFormat | null {
  const name = fileNameOf(path);
  return FORMATS.find((format): boolean => format.namedBy(name)) ?? null;
}

/**
 * Does this path's last segment look like a DIRECTORY rather than a file?
 *
 * A SECOND, WEAKER RULE, TRIED ONLY AFTER EVERY NAMED ARTIFACT HAS BEEN. A
 * directory has no extension to recognise, so the only name-shaped thing to go
 * on is the absence of one -- which is a hint, not a fact, and would happily
 * claim a compiled binary at `build/libs/app`. So it is never allowed to shadow
 * an artifact whose name states a format nen reads (../test-report.ts chooses
 * in two passes for exactly this reason), and what it CLAIMS is still settled
 * by `statSync` and by the bytes of the files inside.
 *
 * A TRAILING SEPARATOR COUNTS TOO: `build/test-results/test/` has an empty last
 * segment, which is a directory as plainly as a name with no dot in it.
 */
export function directoryShaped(path: string): boolean {
  const name = fileNameOf(path);
  return !name.includes(".");
}

/**
 * The format this text is in: a name match confirmed by the content, else the
 * first format whose sniff claims it, else null.
 */
export function detectFormat(path: string, text: string): TestReportFormat | null {
  const name = fileNameOf(path);
  const named = FORMATS.filter((format): boolean => format.namedBy(name));
  for (const format of named) {
    if (format.sniff(text)) return format;
  }
  return FORMATS.find((format): boolean => format.sniff(text)) ?? null;
}

export interface ParsedReport {
  readonly format: TestReportFormat;
  readonly parsed: ParsedTests;
  /** How many files were read. More than one only for a directory artifact. */
  readonly files: number;
}

/**
 * Read one declared artifact and parse it, or throw a `TestReportError`.
 *
 * `display` IS THE PATH AS THE DECLARATION WROTE IT -- repo-relative -- and it
 * is what every message quotes, because that is the string the caller has to go
 * and edit. The absolute path is what is opened and never what is printed: a
 * refusal naming a temporary directory teaches nobody anything.
 */
export function readTestReport(absolute: string, display: string): ParsedReport {
  // `throwIfNoEntry: false` SUPPRESSES ONLY ENOENT. Every other filesystem
  // answer -- a permission this account has not got, a path whose parent is a
  // file, a mount that went away -- still throws, and a raw Node error escaping
  // here would leave ../test-report.ts's catch (which knows one class) and crash
  // the process instead of refusing at 1. Every fs call in this file goes
  // through `fsRefusal` for that reason.
  let stats: ReturnType<typeof statSync>;
  try {
    stats = statSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    throw fsRefusal(error, display, "looked at");
  }
  if (stats === undefined) {
    throw new TestReportError(
      `no test report at ${display}. The declaration names it under the lane's 'test' verb 'artifacts' and it is not there: either the runner writes its report somewhere else -- correct the path -- or no run has produced one.${globNote(display)}`,
    );
  }
  if (stats.isDirectory()) return readDirectory(absolute, display);
  return readFile(absolute, display);
}

function readFile(absolute: string, display: string): ParsedReport {
  const text = readText(absolute, display);
  const format = detectFormat(display, text);
  if (format === null) {
    throw new TestReportError(
      `${display} is not a test report in any format nen reads. Supported: ${supportedFormats()}. The file name is a hint and the content decides, so a report in one of these formats under an unfamiliar name is still read -- this file matched none of them either way.`,
    );
  }
  return { format, parsed: parseWith(format, text, display), files: 1 };
}

/**
 * A directory artifact: every `*.xml` under it, merged into one report.
 *
 * EVERY FILE IS CONFIRMED, AND ONE THAT IS NOT A TEST REPORT IS A REFUSAL
 * RATHER THAN A SKIP. A declared artifact directory is the runner's own output
 * directory; an XML file in it that is not a test report means the declaration
 * names a directory ABOVE the one the runner writes to, and quietly reading the
 * half of the tree nen understood would report a total for a run whose other
 * half it silently dropped. The refusal names the file, which is the thing a
 * maintainer has to look at.
 *
 * A FILE THAT IS NOT XML IS SIMPLY NOT COLLECTED. Runners write their own
 * binary caches, properties files and HTML beside the XML; those are not
 * candidates and never were, so passing over them is not a decision about a
 * report.
 */
function readDirectory(absolute: string, display: string): ParsedReport {
  let files: readonly Found[];
  try {
    files = xmlFilesUnder(absolute);
  } catch (error) {
    // The walk reads directories nen was never told the names of -- a
    // subdirectory of a declared artifact -- so this is where an unreadable one
    // becomes a refusal that names the artifact the CALLER declared rather than
    // a stack trace naming a path they never wrote.
    throw fsRefusal(error, display, "listed");
  }
  if (files.length === 0) {
    throw new TestReportError(
      `${display} is a directory with no *.xml file anywhere under it. nen reads a directory artifact as a tree of ${JUNIT.label} -- which is what a runner that writes one file per suite produces -- so either the run wrote nothing, or this names a directory above (or beside) the one it writes into.`,
    );
  }
  const parts = files.map((file): ParsedTests => {
    const shown = `${display}/${file.relative}`;
    const text = readText(file.absolute, shown);
    if (!JUNIT.sniff(text)) {
      throw new TestReportError(
        `${shown} is an XML file that is not ${JUNIT.label}. Every *.xml under a directory artifact is read as a test report and this one carries no <testsuite> element: name the directory the runner writes its results into rather than one that also holds other XML, or name the single file to parse.`,
      );
    }
    return parseWith(JUNIT, text, shown);
  });
  return { format: JUNIT, parsed: mergeParsed(parts), files: files.length };
}

interface Found {
  readonly absolute: string;
  /** Forward-slashed and relative to the artifact, so a message reads the same everywhere. */
  readonly relative: string;
}

/**
 * Every `*.xml` under a directory, deepest path and all, in one fixed order.
 *
 * SORTED, BECAUSE THE ORDER IS PART OF THE DOCUMENT. `tests[]` is the order the
 * files were read in, and `readdirSync` returns whatever the filesystem hands
 * back -- so two runs of the same repository on two machines would produce two
 * different documents for one report. Sorting costs nothing and makes the
 * output diffable.
 *
 * IT RECURSES, because that is the shape these trees have: one directory per
 * task, one file per suite inside it.
 */
function xmlFilesUnder(root: string, prefix = "", found: Found[] = []): readonly Found[] {
  const at = prefix === "" ? root : join(root, prefix);
  for (const entry of readdirSync(at, { withFileTypes: true }).sort((left, right): number =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  )) {
    const relative = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
    // SYMLINKS ARE NOT FOLLOWED. A directory artifact is a tree a runner wrote;
    // a link in it points somewhere nen was not asked to read, and following
    // one is how a walk leaves the repository (or loops).
    if (entry.isDirectory()) {
      xmlFilesUnder(root, relative, found);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith(".xml")) {
      found.push({ absolute: join(root, relative), relative });
    }
  }
  return found;
}

function readText(absolute: string, display: string): string {
  try {
    return readFileSync(absolute, "utf8");
  } catch (error) {
    throw fsRefusal(error, display, "read");
  }
}

/**
 * A filesystem answer nen cannot act on, as a refusal that names the path.
 *
 * ONE HELPER FOR ALL THREE CALLS, and its whole job is the class: everything
 * this module throws must be a `TestReportError`, because that is the one class
 * ../test-report.ts catches and turns into an exit-1 refusal. A raw
 * `ENOTDIR`/`EACCES` escaping from `statSync`, `readdirSync` or `readFileSync`
 * would leave that catch and reach the top of the process as a stack trace --
 * for something that is a fact about this checkout (a permission, a mount, a
 * link) rather than a defect in nen.
 *
 * IT QUOTES THE CODE AND NOT THE MESSAGE where there is one: `EACCES` is the
 * same word on every platform, while the sentence around it is not.
 */
export function fsRefusal(error: unknown, display: string, doing: string): TestReportError {
  const code = (error as NodeJS.ErrnoException).code;
  return new TestReportError(
    `${display} could not be ${doing} (${code ?? (error instanceof Error ? error.message : String(error))}). nen reads the report a declaration NAMES; a path it cannot open is a fact about this checkout rather than a report it can parse.`,
  );
}

/**
 * One parse, with the file named on every refusal that comes out of it.
 *
 * EVERY REFUSAL FROM HERE NAMES THE FILE, and this is the one place that can
 * guarantee it -- ../coverage/parse.ts's rule, for its reason: a parser is
 * handed TEXT and knows the display path only because it is passed one, and
 * ./shape.ts's counting is handed neither, so a set of counts that cannot be
 * true refuses in a sentence with no path in it unless something prefixes one.
 */
function parseWith(format: TestReportFormat, text: string, display: string): ParsedTests {
  try {
    return format.parse(text, display);
  } catch (error) {
    if (error instanceof TestReportError && !error.message.startsWith(`${display}:`)) {
      throw new TestReportError(`${display}: ${error.message}`);
    }
    throw error;
  }
}

/**
 * The sentence a path with a `*` in it gets, and nothing else gets.
 *
 * A DECLARATION IS A LIST OF LITERAL PATHS. A doubled-star pattern under the
 * results directory is how a runner's own documentation writes the location, so
 * it is the first thing a maintainer pastes -- and nen expands nothing: a shell
 * would, and this
 * CLI's one subprocess seam never uses one. The directory form above is the
 * answer, and this sentence is where a reader meets it.
 */
function globNote(display: string): string {
  return /[*?[\]]/.test(display)
    ? " That path contains a wildcard, and an artifact is a LITERAL path: nen expands no globs -- there is no shell anywhere in this program -- so name the DIRECTORY the runner writes its XML into (nen reads every *.xml under it) or the single file to parse."
    : "";
}
