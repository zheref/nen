#!/usr/bin/env bun
// src/index.ts -- the CLI entry point.
//
// THREE CONSUMERS, ONE SURFACE (§1): a human reading the terminal, a Claude Code
// skill, and CI. Human-readable output is the default; `--json` is a stable
// contract. That is why `run()` takes its argv and its output sinks as ARGUMENTS
// and returns an exit code, instead of reading `process.argv` and calling
// `process.exit()`: a CLI that can only be exercised by spawning itself is a CLI
// whose output contract is tested by nobody, and the `--json` shape is the half
// that other programs depend on.
//
// P1 SHIPS THE SUPPLY AND DEV VERBS ONLY. `nen --version` and `nen bootstrap`
// are what zheref/hatsu#1's D10 minimum-version contract needs; `nen dev test`
// is D16's one-command harness; `nen schema check` exists because "taxonomy
// behavior demonstrably follows the target repo's schema files" has to be
// demonstrable from the command line and not only from a test. The readiness,
// backlog and wake verbs are #2/#3/#4 and are deliberately absent -- an empty
// verb that printed "not implemented" would be a surface other repositories
// could start depending on before it means anything.
//
// EXIT CODES. 0 success, 1 a verb's own failure, 2 a usage error, and whatever
// the bootstrap script returned for `nen bootstrap` (its codes are a published
// contract -- see ../supply/bootstrap.ts). A usage error is deliberately
// distinct from a failure: "you typed it wrong" and "the thing you asked for did
// not work" want different reactions from a caller.

import { parseArgs, UsageError } from "./cli/args.js";
import { runDevTest } from "./dev/test.js";
import { checkTaxonomy } from "./schema/taxonomy.js";
import { BootstrapExit, runBootstrap } from "./supply/bootstrap.js";
import { PROGRAM, VERSION } from "./version.js";

export interface Io {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const USAGE = `${PROGRAM} ${VERSION} -- the local dev CLI for repository-driven agentic delivery.

usage: ${PROGRAM} [--version] [--help] <command> [options]

commands:
  bootstrap --ref <tag>     Fetch, checksum-verify and cache a pinned ${PROGRAM} binary.
                            Refuses on any integrity gap; prints the verified
                            path on stdout and nothing else.
      --source <owner/name>   GitHub repository to fetch release assets from.
      --cache-dir <dir>       Cache root.
      --script <path>         The bootstrap script, when not under --repo.

  schema check              Load and validate the target repository's taxonomy
                            files and report each one's verdict.

  dev test [-- <args>]      Run this repository's own harness (bun + vitest).
                            A checkout verb: a compiled binary has no harness.

global options:
  --repo <path>             The TARGET repository's working-tree root. A PATH,
                            never an owner/name slug. Defaults to the current
                            directory -- resolved at the call site, never from
                            the location of this executable.
  --json                    Machine-readable output, where a command has one.
  --version, -v             Print the version and exit.
  --help, -h                Print this and exit.`;

const GLOBAL_FLAGS = {
  values: ["repo", "source", "cache-dir", "script", "ref"],
  booleans: ["json", "version", "help"],
  aliases: { v: "version", h: "help" },
} as const;

export function run(argv: readonly string[], io: Io): number {
  let parsed;
  try {
    parsed = parseArgs(argv, GLOBAL_FLAGS);
  } catch (error) {
    if (error instanceof UsageError) {
      io.err(`${PROGRAM}: ${error.message}`);
      io.err(`Run '${PROGRAM} --help'.`);
      return 2;
    }
    throw error;
  }

  // `--version` wins over everything, including a command, and prints the
  // version ALONE on stdout. zheref/hatsu#1's D10 gate parses this line: a
  // banner, a leading `v`, or a trailing note would each break a fail-closed
  // contract in the direction where it stops failing closed.
  if (parsed.booleans.has("version")) {
    io.out(VERSION);
    return 0;
  }
  if (parsed.booleans.has("help") || parsed.positionals.length === 0) {
    io.out(USAGE);
    return parsed.positionals.length === 0 && !parsed.booleans.has("help") ? 2 : 0;
  }

  const repoFlag = parsed.values["repo"] ?? null;
  const json = parsed.booleans.has("json");
  const [command, subcommand] = parsed.positionals;

  try {
    switch (command) {
      case "version":
        io.out(VERSION);
        return 0;

      case "bootstrap":
        return bootstrap(parsed.values, repoFlag, io);

      case "schema":
        if (subcommand !== "check") {
          io.err(`${PROGRAM}: unknown 'schema' subcommand '${subcommand ?? "(none)"}'. Try 'schema check'.`);
          return 2;
        }
        return schemaCheck(repoFlag, json, io);

      case "dev":
        if (subcommand !== "test") {
          io.err(`${PROGRAM}: unknown 'dev' subcommand '${subcommand ?? "(none)"}'. Try 'dev test'.`);
          return 2;
        }
        return devTest(repoFlag, parsed.passthrough, io);

      default:
        io.err(`${PROGRAM}: unknown command '${command}'.`);
        io.err(`Run '${PROGRAM} --help'.`);
        return 2;
    }
  } catch (error) {
    // A thrown error is reported as a FAILURE (1), never as a usage error, and
    // its message is printed whole. The schema loaders' messages are written to
    // be actionable on their own -- path, expectation, and how to point nen
    // somewhere else -- so truncating or re-wording them here would throw away
    // the thing that makes them useful.
    io.err(`${PROGRAM}: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function bootstrap(
  values: Readonly<Record<string, string>>,
  repoFlag: string | null,
  io: Io,
): number {
  const ref = values["ref"];
  if (ref === undefined) {
    io.err(
      `${PROGRAM}: 'bootstrap' requires --ref <tag>. There is deliberately no default and no 'latest': a bootstrap that picked the newest release would convert a source-pinned supply chain into an unpinned one.`,
    );
    return BootstrapExit.USAGE;
  }
  const result = runBootstrap({
    ref,
    repoFlag,
    source: values["source"],
    cacheDir: values["cache-dir"],
    script: values["script"],
  });
  // stderr first, so a failure's explanation is on screen before the (empty)
  // stdout line is not.
  for (const line of result.stderr.split("\n")) {
    if (line !== "") io.err(line);
  }
  if (result.code === BootstrapExit.OK && result.path !== "") io.out(result.path);
  return result.code;
}

function schemaCheck(repoFlag: string | null, json: boolean, io: Io): number {
  const report = checkTaxonomy({ repoFlag });
  if (json) {
    io.out(JSON.stringify(report, null, 2));
    return report.ok ? 0 : 1;
  }
  io.out(`repository: ${report.root}`);
  for (const check of report.checks) {
    const mark = check.ok ? "ok  " : check.required ? "FAIL" : "warn";
    io.out(`  ${mark}  ${check.file}  ${check.detail}`);
  }
  if (!report.ok) {
    io.err(
      `${PROGRAM}: this repository's taxonomy could not be read. Nen has no built-in copy to fall back on -- a binary that guessed the names would report a taxonomy this repository does not have.`,
    );
  }
  return report.ok ? 0 : 1;
}

function devTest(repoFlag: string | null, passthrough: readonly string[], io: Io): number {
  const result = runDevTest({ repoFlag, passthrough });
  if (result.message !== null) io.err(`${PROGRAM}: ${result.message}`);
  return result.code;
}

// The one place `process` is touched, and it is three lines. Everything above is
// a pure function of argv and two sinks.
//
// `import.meta.main` rather than a `BASH_SOURCE`-style guard: it is bun's own
// answer to "was this file the entry point", and it is TRUE in a compiled binary
// -- unlike `import.meta.url`, which resolves to a `/$bunfs/` path and is why
// this repository derives no root from it (§3).
if (import.meta.main) {
  process.exitCode = run(process.argv.slice(2), {
    out: (line): void => {
      process.stdout.write(`${line}\n`);
    },
    err: (line): void => {
      process.stderr.write(`${line}\n`);
    },
  });
}
