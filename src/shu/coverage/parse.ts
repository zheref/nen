// src/shu/coverage/parse.ts -- which format a report is in, and the one read
// that turns a path into a parsed shape.
//
// FIVE FORMATS, ONE REGISTRY, NO STACK NAMES. A parser is chosen by what the
// file IS, never by which stack the lane declares: the summary format two of
// the seven reference stacks write is the same format anything else can be
// asked for, and keying the choice on the stack id would mean a repository
// that switched reporters got a refusal about its stack instead of a report.
// ../coverage.ts never passes a stack down here, and there is no parameter for
// one.
//
// NAME FIRST, CONTENT DECIDES. The file name is a hint a repository chose --
// `coverage.xml` is written by at least two of these tools, and one of the five
// has no conventional name at all -- so a name match only puts a format at the
// front of the queue; every candidate is confirmed against the bytes before it
// parses them, and a file no format claims is a refusal that lists what nen
// reads rather than a wrong answer from whichever parser was asked first.
//
// THE READ LIVES HERE AND NOT IN THE PARSERS. Each format module takes TEXT and
// returns a shape, which is what makes it unit-testable on a string and what
// keeps five copies of the same "no such file" sentence from existing. There is
// exactly one place in this family that opens a coverage report, and this is it.

import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { CoverageReportError, type CoverageFormat, type ParsedCoverage } from "./shape.js";
import { COBERTURA } from "./formats/cobertura.js";
import { ISTANBUL } from "./formats/istanbul.js";
import { JACOCO } from "./formats/jacoco.js";
import { LCOV } from "./formats/lcov.js";
import { XCCOV } from "./formats/xccov.js";

/**
 * Every format this release reads, in the order a refusal lists them.
 *
 * THE ORDER IS ALSO THE SNIFF ORDER for a file whose name says nothing, and the
 * two JSON formats are first because their sniffs are exact (a `total.lines`
 * object; a `targets` array beside two line counts) rather than structural.
 */
export const FORMATS: readonly CoverageFormat[] = [ISTANBUL, XCCOV, COBERTURA, JACOCO, LCOV];

/** `istanbul-summary (coverage-summary.json), ...` -- for a refusal. */
export function supportedFormats(): string {
  return FORMATS.map((format): string => `${format.id} -- ${format.label}, ${format.writtenAs}`).join("; ");
}

/**
 * Does this path's NAME look like a report nen can read?
 *
 * USED TO CHOOSE AMONG DECLARED ARTIFACTS, and only there. A `coverage` verb
 * routinely names several outputs -- an HTML tree, a JUnit XML, the machine
 * report -- and nen picks the first whose name it recognises rather than
 * reading each one to find out. That choice must not depend on the bytes,
 * because a dry run has no bytes to read and must still be able to say which
 * artifact the real run would parse.
 */
export function recognisedByName(path: string): boolean {
  return formatNamedBy(path) !== null;
}

/** The first format whose name rule claims this path, or null. */
export function formatNamedBy(path: string): CoverageFormat | null {
  const name = basename(path);
  return FORMATS.find((format): boolean => format.namedBy(name)) ?? null;
}

/**
 * The format this text is in: a name match confirmed by the content, else the
 * first format whose sniff claims it, else null.
 */
export function detectFormat(path: string, text: string): CoverageFormat | null {
  const name = basename(path);
  const named = FORMATS.filter((format): boolean => format.namedBy(name));
  for (const format of named) {
    if (format.sniff(text)) return format;
  }
  return FORMATS.find((format): boolean => format.sniff(text)) ?? null;
}

export interface ParsedReport {
  readonly format: CoverageFormat;
  readonly coverage: ParsedCoverage;
}

/**
 * Read one report and parse it, or throw a `CoverageReportError` saying why not.
 *
 * `display` IS THE PATH AS THE DECLARATION WROTE IT -- repo-relative -- and it
 * is what every message quotes, because that is the string the caller has to go
 * and edit. The absolute path is what is opened and never what is printed:
 * a refusal naming a temporary directory teaches nobody anything.
 */
export function readReport(absolute: string, display: string): ParsedReport {
  let text: string;
  try {
    text = readFileSync(absolute, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new CoverageReportError(
      code === "ENOENT"
        ? `no coverage report at ${display}. The lane's 'coverage' verb ran and exited 0, and this file is not there: the declaration names it under this verb's 'artifacts', so either the tool writes it somewhere else -- correct the path -- or the run produced no report at all.`
        : `${display} could not be read (${code ?? (error instanceof Error ? error.message : String(error))}).`,
    );
  }
  const format = detectFormat(display, text);
  if (format === null) {
    throw new CoverageReportError(
      `${display} is not a coverage report in any format nen reads. Supported: ${supportedFormats()}. The file name is a hint and the content decides, so a report in one of these formats under an unfamiliar name is still read -- this file matched none of them either way.`,
    );
  }
  return { format, coverage: format.parse(text, display) };
}
