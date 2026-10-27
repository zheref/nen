// src/tests/command.ts -- the `tests` family: `nen tests map` (zheref/nen#552).
//
// READ-ONLY OVER LOCAL FILES. An issue body and one or more test reports in,
// a map out; nothing is run, fetched or written. Running the tests that
// produce a report is the repository's declared `test` verb (`nen shu test`),
// and the red checkpoint a build records before its change is Hatsu's
// authoring-phase prose, which cites this verb -- neither is here.
//
// PATHS RESOLVE AGAINST --repo'S ROOT, as every own-path flag has since v0.7.

import { isUtf8 } from "node:buffer";
import { readFileSync } from "node:fs";
import { emit, refuseExtraPositionals, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { commaList } from "../cli/comma.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { plainLine } from "../cli/plain.js";
import { extractCriteria } from "../issue/criteria.js";
import { DEFAULT_CRITERIA_PREFIX, IssueShapeError, parseCatalogue, type IssueSectionsCatalogue } from "../issue/shape.js";
import { resolveRepoRoot } from "../repo/root.js";
import { readTestReport } from "../shu/test-report/parse.js";
import { TestReportError, type TestCase } from "../shu/test-report/shape.js";
import { mapTests, renderMap, TESTS_MAP_CONTRACT, unreadableMap, type IssueAnchor, type MapMode } from "./map.js";

const SUBCOMMANDS = ["map"] as const;

const USAGE = `nen tests map --issue-body <file> --test-report <file>[,<file>...]
              [--before-report <file>[,<file>...] | --require-red]
              [--issue <owner/name>#<N> | <CODE>#<N> | #<N> | <N>]
              [--requirements-from <catalogue.json>] [--repo <path>] [--json]

Read-only. Each acceptance criterion of an issue body with the tests whose
names carry its id, and each criterion with none (zheref/nen#552). The
criteria are read exactly as 'nen issue criteria' reads them ('- AC-{n}:'
rows outside fenced code and comments; --requirements-from takes the row
prefix and the acceptance section from the catalogue). The tests are read
from each --test-report through 'shu test-report's parsers -- JUnit XML (a
file or a directory of *.xml), a JSON assertion-results document, an
xcresult summary -- so no runner is named and nothing is run.

A test names a criterion by carrying its id as a token in its name or its
suite: AC-3, #552/AC-3, NN#552/AC-3 or zheref/nen#552/AC-3; 'AC-1/AC-2'
is two tokens. AC-30, XAC-3, AC-3a and AC-3-001 are not AC-3. With --issue,
a qualified token naming another issue (or another owner/name) is foreign
and maps to nothing, and so is a BARE token in a test whose name or suite
carries issue references none of which is --issue (a bare AC-1 under a
suite titled for #509 is #509's). A CODE prefix is echoed, never resolved.
Without --issue every token maps by its criterion number alone.

Three modes, and ONE red bar for both red readings: a criterion was red when
EVERY test naming it failed in the red run.
  (default)        --test-report is the run AFTER the change: a criterion is
                   met when a test names it and none of its tests failed and
                   at least one passed.
  --require-red    --test-report is the checkpoint run BEFORE the change: a
                   criterion is met ('red') when it clears the red bar; a
                   pass or a skip among its tests is 'not-red'.
  --before-report  both runs: each criterion reads red-first (it clears the
                   red bar before and passes now), green-only (it passes now
                   and does not), failing (a test of it fails now) or
                   untested (no test, or every test skipped). Only red-first
                   is met. A test is matched across the two runs by suite
                   and name; one absent before reads 'absent'.

A red run whose test FILE failed to load (the module under test does not
exist yet) names the file, not its tests: a failed row whose name is its
suite (JUnit name = classname; a failed assertion-results file with no
assertions). Under --before-report it is attributed to every after test of
that suite, read as 'load-failed', which is red. Such suites are listed in
loadFailures. Under --require-red there are no test names to attribute it
to, so those criteria read untested (zheref/nen#559): use --before-report
for a red run of that kind.

Every criterion appears with its test count, 0 included. A test naming an id
the issue does not carry is unrequested, by name. A body with no criterion
row is not-verifiable; an unreadable body or report is could-not-read with
the reason, never an empty map.

Exits: 0 every criterion met in the mode, nothing unrequested, no duplicate
or unrecognised criterion row; 1 otherwise, and on not-verifiable or
could-not-read; 2 usage (a missing flag, both --before-report and
--require-red, a malformed --issue or catalogue).

--json shape (key order as listed):
  { contract: "${TESTS_MAP_CONTRACT}", verdict, mode, issueBody, issue,
    testReports, beforeReports, criteria: [{ id, number, text, line, status,
    count, outcome, checkpoint, met, tests: [{ name, suite, status, before }] }],
    (before: passed | failed | skipped | load-failed | absent | null)
    unrequested: [{ id, token, name, suite, status }], foreign: [{ token, name,
    suite }], loadFailures, duplicates, unrecognised, counts: { criteria, mapped, unmapped,
    met, unrequested, foreign, tests }, blocking, reason }
  verdict: met | unmet | not-verifiable | could-not-read
  mode: after | require-red | before-after
  outcome: passing | failing | skipped | untested
  checkpoint: null (after) | red | not-red | untested (require-red) |
              red-first | green-only | failing | untested (before-after)`;

const ISSUE_ANCHOR = /^(?:([^\s#]+)#|#)?([0-9]{1,9})$/;

function parseAnchor(value: string | undefined): IssueAnchor | null {
  if (value === undefined) return null;
  const match = ISSUE_ANCHOR.exec(value.trim());
  const number = match === null ? NaN : Number(match[2]);
  if (match === null || !Number.isSafeInteger(number) || number <= 0) {
    throw new VerbUsageError(`--issue '${value}' is not an issue reference. Write <owner/name>#<N>, <CODE>#<N>, #<N> or <N>.`);
  }
  const prefix = match[1] ?? null;
  if (prefix !== null && !prefix.includes("/") && !/^[A-Za-z][A-Za-z0-9]*$/.test(prefix)) {
    throw new VerbUsageError(`--issue '${value}': '${prefix}' is neither a product code (a letter, then letters and digits) nor an owner/name slug.`);
  }
  if (prefix !== null && prefix.includes("/") && !/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(prefix)) {
    throw new VerbUsageError(`--issue '${value}': '${prefix}' is not an owner/name slug.`);
  }
  return { prefix, number };
}

function catalogueOf(root: string, from: string | undefined): IssueSectionsCatalogue | null {
  if (from === undefined) return null;
  if (from === "") throw new VerbUsageError("--requirements-from names the issue-sections catalogue; it cannot be empty.");
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(resolveAgainstRepo(root, from), "utf8"));
  } catch (error) {
    throw new VerbUsageError(`--requirements-from '${from}' could not be read as JSON (${error instanceof Error ? error.message : String(error)}).`);
  }
  try {
    return parseCatalogue(raw);
  } catch (error) {
    if (error instanceof IssueShapeError) throw new VerbUsageError(plainLine(`'${from}': ${error.message}`));
    throw error;
  }
}

/** The body as text, or the reason it could not be read. */
function readBody(path: string, display: string): { body: string } | { reason: string } {
  let bytes: Buffer;
  try {
    bytes = readFileSync(path);
  } catch (error) {
    return { reason: `--issue-body '${display}' could not be read (${error instanceof Error ? error.message : String(error)})` };
  }
  if (!isUtf8(bytes)) return { reason: `--issue-body '${display}' is not valid UTF-8 text` };
  return { body: bytes.toString("utf8").replace(/\r\n?/g, "\n") };
}

/** Every test of every report, or the first reason one could not be read. */
function readReports(root: string, files: readonly string[]): { tests: TestCase[] } | { reason: string } {
  const tests: TestCase[] = [];
  for (const file of files) {
    try {
      tests.push(...readTestReport(resolveAgainstRepo(root, file), file).parsed.tests);
    } catch (error) {
      if (error instanceof TestReportError) return { reason: error.message };
      throw error;
    }
  }
  return { tests };
}

function runMap(context: CommandContext): number {
  refuseExtraPositionals(context.args, 2);
  const issueBody = context.args.values["issue-body"];
  if (issueBody === undefined || issueBody === "") throw new VerbUsageError("--issue-body <file> is required: it names the issue body whose criteria are mapped.");
  const testReports = commaList(context.args.values["test-report"]);
  if (testReports.length === 0) throw new VerbUsageError("--test-report <file>[,<file>...] is required: it names the run the criteria are mapped against.");
  const beforeFlag = context.args.values["before-report"];
  const beforeReports = beforeFlag === undefined ? null : commaList(beforeFlag);
  if (beforeReports !== null && beforeReports.length === 0) throw new VerbUsageError("--before-report names no file.");
  const requireRed = context.args.booleans.has("require-red");
  if (requireRed && beforeReports !== null) {
    throw new VerbUsageError("--require-red reads --test-report as the run before the change; --before-report names that run separately. Give one, never both.");
  }
  const mode: MapMode = requireRed ? "require-red" : beforeReports !== null ? "before-after" : "after";
  const issueFlag = context.args.values["issue"];
  const anchor = parseAnchor(issueFlag);
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const catalogue = catalogueOf(root, context.args.values["requirements-from"]);
  const names = { mode, issueBody, issueLabel: issueFlag?.trim() ?? null, testReports, beforeReports };

  const finish = (report: ReturnType<typeof mapTests>): number => {
    emit(context.io, context.json, report, renderMap(report).map(plainLine));
    return report.verdict === "met" ? 0 : 1;
  };
  const body = readBody(resolveAgainstRepo(root, issueBody), issueBody);
  if ("reason" in body) return finish(unreadableMap(names, body.reason));
  const after = readReports(root, testReports);
  if ("reason" in after) return finish(unreadableMap(names, after.reason));
  const before = beforeReports === null ? null : readReports(root, beforeReports);
  if (before !== null && "reason" in before) return finish(unreadableMap(names, before.reason));
  return finish(
    mapTests({
      mode,
      issueBody,
      issue: anchor,
      issueLabel: names.issueLabel,
      criteria: extractCriteria(body.body, catalogue),
      prefix: catalogue?.criteriaPrefix ?? DEFAULT_CRITERIA_PREFIX,
      testReports,
      tests: after.tests,
      beforeReports,
      before: before === null ? null : before.tests,
    }),
  );
}

export const testsCommand: Command = {
  name: "tests",
  subcommands: SUBCOMMANDS,
  summary: "Map an issue's acceptance criteria to the tests that name them, and read a red-first checkpoint.",
  usage: USAGE,
  flags: {
    values: ["issue-body", "test-report", "before-report", "issue", "requirements-from"],
    booleans: ["require-red"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("tests", context.args, SUBCOMMANDS);
    if (subcommand === "map") return runMap(context);
    throw new VerbUsageError(`'tests ${subcommand}' is not a verb. Try: tests map.`);
  },
};
