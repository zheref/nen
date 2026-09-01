// src/dev/verb.ts -- `nen dev test|lint|replay`, D16's "one command" surface,
// now including the local corpus-slice regression replay.

import { join } from "node:path";
import { assertRepoRoot } from "../repo/root.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { runDevTest } from "./test.js";
import { runDevLint } from "./lint.js";
import { replayDedupeSlice, ReplayFixtureError } from "./replay.js";

const USAGE = `nen dev -- this repository's own harness: test, lint, and the corpus-slice replay.

usage:
  nen dev test [-- <args>]     bun run test -> vitest, this repo's own suite.
  nen dev lint [-- <args>]     bun run lint -> eslint, this repo's own linter.
  nen dev replay [--slice-dir <path>]
      Replays the imported corpus slice
      (tests/fixtures/dualrun-slice/, §7 P1 evidence's "local corpus slice
      replays green") against nen's own equivalent logic -- currently
      src/issue/search.ts's normalizeTitle/findCanonical, absorbed from
      dedupe_handbook_questions.sh. See tests/fixtures/dualrun-slice/
      MANIFEST.json for exactly which fixtures were imported and why every
      excluded one has no nen equivalent to replay against. Exits 1 on any
      fixture whose verdict disagrees with nen's own, and ALSO exits 1 (never
      a silent 0/0 pass) when --slice-dir names an existing but empty
      directory. Exits 2 when --slice-dir does not exist at all.

Each of these is a DEV verb: it runs this checkout's own tooling and needs a
checkout to run it in -- a compiled binary has no harness, no linter and no
corpus slice to replay.`;

export const devVerb: Verb = {
  name: "dev",
  summary: "This repository's own harness: test, lint, and the corpus-slice replay.",
  usage: USAGE,
  flags: { values: ["slice-dir"], booleans: [] },
  run(context: VerbContext): number {
    const [subcommand] = context.args;
    switch (subcommand) {
      case "test": {
        const result = runDevTest({ repoFlag: context.repoFlag, passthrough: context.passthrough });
        if (result.message !== null) context.io.err(`nen: ${result.message}`);
        return result.code;
      }
      case "lint": {
        const result = runDevLint({ repoFlag: context.repoFlag, passthrough: context.passthrough });
        if (result.message !== null) context.io.err(`nen: ${result.message}`);
        return result.code;
      }
      case "replay":
        return replay(context);
      default:
        return usage(context.io, `unknown 'dev' subcommand '${subcommand ?? "(none)"}'. Try 'test', 'lint' or 'replay'.`);
    }
  },
};

function replay(context: VerbContext): number {
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const sliceDir = context.values["slice-dir"] ?? join(root, "tests", "fixtures", "dualrun-slice", "dedupe");
  let report;
  try {
    report = replayDedupeSlice(sliceDir);
  } catch (error) {
    // A missing --slice-dir is a checkout/usage problem, the same class dev
    // test/lint report as code 2 for "no package.json here" -- not a failed
    // regression run (which is code 1, below).
    if (error instanceof ReplayFixtureError) {
      context.io.err(`nen: ${error.message}`);
      return 2;
    }
    throw error;
  }

  if (context.json) {
    context.io.out(JSON.stringify(report, null, 2));
    return report.error !== null || report.failed.length > 0 ? 1 : 0;
  }
  if (report.error !== null) {
    context.io.err(`nen: ${report.error}`);
    return 1;
  }
  context.io.out(`replayed ${report.total} fixture(s): ${report.passed.length} passed, ${report.failed.length} failed`);
  for (const failure of report.failed) {
    context.io.out(`  FAIL ${failure.id}: expected ${failure.expected ?? "(canonical)"}, got ${failure.actual ?? "(canonical)"}`);
  }
  if (report.failed.length > 0) {
    context.io.err(`nen: ${report.failed.length} fixture(s) disagreed with nen's own logic.`);
    return 1;
  }
  return 0;
}
