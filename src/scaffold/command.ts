// src/scaffold/command.ts -- `nen scaffold init` and `nen scaffold new`.
//
// WHY THE JOIN IS HERE. ./templates.ts reads the profiles pack and spawns
// nothing; the closing toolchain check spawns the version probes the target
// repository declares. ../profiles/inertness.test.ts computes its rule from the
// SEAM, so the two halves cannot be one module -- and the join has to live in a
// module that imports no seam of its own. This file is that module: it holds
// `Command` objects and calls them, exactly as ../shu/command.ts joins
// ../shu/detect.ts (which reads the pack) with ../shu/run.ts (which spawns).
//
// THE CHECK IS `nen shu tools` ITSELF, NOT A SECOND OPINION ABOUT IT. It runs
// that verb in-process with `--json`, then renders the document it produced
// with that verb's own renderer. A scaffold that re-derived the table would be
// a second implementation of a host verdict, free to disagree with the one the
// caller gets from running `shu tools` directly -- and it would disagree
// silently, because both would look right.

import { assertRepoRoot } from "../repo/root.js";
import { commaList } from "../cli/comma.js";
import {
  emit,
  requireRepoFlag,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { mergeFlags } from "../cli/command.js";
import { parseArgs } from "../cli/args.js";
import type { Io } from "../index.js";
import { shuCommand } from "../shu/command.js";
import { renderToolsReport, type ToolsReport } from "../shu/tools.js";
import { PROGRAM } from "../version.js";
import { scaffoldInit, type ScaffoldInitResult, type ToolsOutcome } from "./init.js";
import { scaffoldNew, type ScaffoldNewResult } from "./new.js";
import { resolveStackId } from "./templates.js";

// A trailer key is interpolated into the hook both as an ERE inside a
// single-quoted shell string and inside a double-quoted echo string (see
// ../scaffold/hook.ts). Anything outside a git trailer key's own legal
// charset either changes what the hook matches (a regex metacharacter) or
// breaks out of the quoting (a quote character) -- refusing it here is both
// safer and more honest than trying to escape a key that was never a valid
// trailer key to begin with.
const TRAILER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MARKER_ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

const USAGE = `nen scaffold -- stand a repository up: the taxonomy layer, the stack layer, and the CI file.

usage:
  nen scaffold init --repo <path>
                    --agent-trailer <key> --run-trailer <key> --marker-env <VAR>
                    [--directories src,tests,docs]
                    (--stack <id> | --accept-detected)
                    [--hook-path .git/hooks/commit-msg] [--force]
                    [--canon-values-path .claude/canon-values.yml] [--scenario <name>]
                    [--install-tools] [--dry-run] [--json]

  nen scaffold new --stack <id> --name <project> --dir <path>
                   [--agent-trailer <key> --run-trailer <key> --marker-env <VAR>]
                   [--dry-run] [--json]

'init' works on an EXISTING repository. It creates every --directories entry
that does not exist, installs the trailer-enforcing commit-msg hook (a NEW
mechanism -- see ../scaffold/hook.ts), writes a canon-values.yml template when
--canon-values-path is given and nothing is there yet, COPIES any of the four
taxonomy files still under 'schemas/' into 'nen/' (never a move, never a
delete -- the removal command is printed), writes nen/contract.json's project
block into absence, adds the stack's CI workflow, appends '.nen/' to
.gitignore, and ends by running 'nen shu tools' in CHECK mode -- printing what
this host is missing and the --install command, rather than installing
anything. --install-tools is the explicit flag that runs the install.

'new' works on a FRESH tree: an empty or nonexistent --dir, never merged into.
It writes the stack template's files with {{name}} substituted, the CI
workflow, .gitignore, the hook when a trailer convention is stated, and
nen/contract.json -- proposed by 'nen shu detect' off the marker it just
wrote, so a scaffolded project and a declared one cannot disagree. EVERY
post-step (git init, a dependency install, a native prebuild) is PRINTED and
none is run. It sits BESIDE a full project scaffolder rather than replacing
one: it ports the toolchain/CI/declaration slice only.

NEN NEVER GUESSES A STACK. 'init' takes --stack <id> or --accept-detected (the
caller confirming the proposal 'nen shu detect' prints, seats and notes and
all); with neither it refuses at exit 2 naming both. 'new' requires --stack.

--agent-trailer/--run-trailer/--marker-env are caller data: which trailer pair
and which environment variable mark an automated commit is this system's own
convention, never a literal shipped here. Each must be a legal git trailer key
/ shell identifier (--agent-trailer, --run-trailer: [A-Za-z0-9][A-Za-z0-9-]*;
--marker-env: [A-Za-z_][A-Za-z0-9_]*) -- refused otherwise, since either is
interpolated into the generated hook script. They are required on 'init' and
optional on 'new', where omitting them makes the hook a printed post-step.

--hook-path defaults to .git/hooks/commit-msg. When a DIFFERENT hook already
exists there, init REFUSES rather than overwriting it silently; pass --force
to replace it (the existing hook is backed up to '<path>.bak' first). A hook
with identical generated content is left alone either way (idempotent). The
same refuse-rather-than-overwrite rule covers the CI workflow, the declaration
and a conflicting migration -- all at exit 1, with no --force for any of them.

--dry-run prints every write, every migration and every post-step, and
performs none. It spawns NOTHING, probes included: the toolchain check is
reported as "would check" rather than run.

SCOPE: scenario-specific project GENERATION (a framework's own source tree) is
still not ported. What is here is the slice every project needs whatever its
stack: the declaration, the hook, the CI file and the taxonomy layer.`;

/**
 * Run `nen shu tools` in-process and hand back its own document and table.
 *
 * `--json` IS HOW THE DOCUMENT COMES BACK, because that verb emits exactly one
 * JSON document on stdout and that is a published contract. The table is then
 * rendered from the parsed document by that verb's own renderer, so the two
 * surfaces this file prints are the two surfaces `shu tools` prints -- and a
 * field that verb drops goes missing here too, loudly, rather than being
 * re-derived into existence.
 */
function toolsChecker(context: CommandContext, repoRoot: string): (install: boolean) => ToolsOutcome {
  return (install: boolean): ToolsOutcome => {
    const captured: string[] = [];
    const failures: string[] = [];
    const io: Io = {
      out: (line): void => {
        captured.push(line);
      },
      err: (line): void => {
        failures.push(line);
      },
    };
    const argv = install ? ["shu", "tools", "--install"] : ["shu", "tools"];
    const invocation = `${PROGRAM} ${argv.slice(1).join(" ")} --repo ${repoRoot}`;
    let report: ToolsReport | null = null;
    try {
      // The verb's OWN dispatcher, parsed through the same argv reader the
      // top-level one uses -- not a hand-built context, which would be a second
      // place this repository decides what `--repo` and `--json` mean.
      //
      // `Command.run` is typed `number | Promise<number>` for the ONE verb in
      // this CLI that reads the network. `shu tools` is synchronous under the
      // hood (spawnSync, readFileSync), so the value is a number and the guard
      // below is a fact this file checks rather than one it assumes.
      const outcome = shuCommand.run({
        args: parseArgs(argv, mergeFlags(shuCommand.flags)),
        repoFlag: repoRoot,
        json: true,
        io,
        seams: context.seams,
      });
      if (typeof outcome !== "number") throw new Error("shu tools answered asynchronously");
      report = JSON.parse(captured.join("\n")) as ToolsReport;
    } catch (error) {
      failures.push(`nen shu: ${error instanceof Error ? error.message : String(error)}`);
      report = null;
    }
    if (report === null) {
      return {
        report: null,
        lines: [
          `toolchain: not checked. '${invocation}' could not report -- most often because this repository declares no project.toolchain yet. Run it yourself to see why.`,
          ...failures,
        ],
      };
    }
    // `failures` IS THAT VERB'S OWN ADVICE, not an error dump: `shu tools`
    // writes its table to stdout and, when the check did not pass, the two
    // lines that fix it to stderr -- including the `--install` command this
    // verb names and never runs. Both surfaces land in `lines`, in that order,
    // so the caller reads exactly what `shu tools` would have shown them.
    return { report, lines: [...renderToolsReport(report), ...failures] };
  };
}

/**
 * Everything the text form prints that the `--json` document has no field for.
 *
 * IN `--json` MODE IT GOES TO STDERR, so stdout stays exactly one JSON
 * document -- the contract every machine reader of this CLI depends on -- while
 * the part a human still needs is on screen. It is ../shu/run.ts's own rule for
 * a child's output, applied to the same problem: the two published shapes carry
 * `writes`, `migrated`, `tools` and `exitCode`, and detect's open questions and
 * the printed post-steps are prose that would have to become a field to
 * survive. Dropping them silently is the option this exists to avoid.
 */
function relayProse(context: CommandContext, lines: readonly string[]): void {
  if (!context.json) return;
  for (const line of lines) context.io.err(line);
}

function renderInit(result: ScaffoldInitResult): readonly string[] {
  const lines: string[] = [];
  // The first three lines are v0.2.0's output, byte for byte, so a caller that
  // greps them keeps working across this change.
  lines.push(`created directories: ${result.createdDirectories.join(", ") || "(none -- all already existed)"}`);
  lines.push(`hook: ${result.hookOutcome} (${result.hookWritten})`);
  if (result.canonValuesWritten !== null) lines.push(`canon-values: ${result.canonValuesWritten}`);
  lines.push(`stack: ${result.stack ?? "(several -- see the lanes below)"}`);
  for (const entry of result.migrated) {
    lines.push(`migrated: ${entry.from} -> ${entry.to}  (${entry.action}) -- ${entry.why}`);
  }
  for (const write of result.writes) {
    lines.push(`${write.action}: ${write.path} -- ${write.why}`);
  }
  for (const note of result.notes) lines.push(note);
  if (result.tools !== null) lines.push(...result.tools.lines);
  return lines;
}

function renderNew(result: ScaffoldNewResult): readonly string[] {
  const lines: string[] = [];
  lines.push(`stack: ${result.stack}   name: ${result.name}   dir: ${result.dir}`);
  for (const write of result.writes) {
    lines.push(`${write.action}: ${write.path} -- ${write.why}`);
  }
  for (const note of result.notes) lines.push(note);
  lines.push("post-steps (nen does NOT run these):");
  result.postSteps.forEach((step, index): void => {
    lines.push(`  ${index + 1}. ${step}`);
  });
  return lines;
}

/** The trailer convention, validated. Required on `init`, optional on `new`. */
function readHookSpec(
  context: CommandContext,
  required: boolean,
): { agentTrailer: string; runTrailer: string; markerEnvVar: string } | undefined {
  const agentTrailer = context.args.values["agent-trailer"];
  const runTrailer = context.args.values["run-trailer"];
  const markerEnv = context.args.values["marker-env"];
  const given = [agentTrailer, runTrailer, markerEnv].filter((value): boolean => value !== undefined);
  if (given.length === 0 && !required) return undefined;
  if (agentTrailer === undefined || runTrailer === undefined || markerEnv === undefined) {
    throw new VerbUsageError(
      required
        ? "scaffold init takes --agent-trailer, --run-trailer and --marker-env."
        : "--agent-trailer, --run-trailer and --marker-env are one convention and are given together or not at all. Omit all three and the hook becomes a printed post-step.",
    );
  }
  if (!TRAILER_KEY.test(agentTrailer)) {
    throw new VerbUsageError(`--agent-trailer '${agentTrailer}' is not a legal trailer key ([A-Za-z0-9][A-Za-z0-9-]*).`);
  }
  if (!TRAILER_KEY.test(runTrailer)) {
    throw new VerbUsageError(`--run-trailer '${runTrailer}' is not a legal trailer key ([A-Za-z0-9][A-Za-z0-9-]*).`);
  }
  if (!MARKER_ENV_VAR.test(markerEnv)) {
    throw new VerbUsageError(`--marker-env '${markerEnv}' is not a legal shell identifier ([A-Za-z_][A-Za-z0-9_]*).`);
  }
  return { agentTrailer, runTrailer, markerEnvVar: markerEnv };
}

function runInit(context: CommandContext): number {
  const hook = readHookSpec(context, true);
  if (hook === undefined) {
    throw new VerbUsageError("scaffold init takes --agent-trailer, --run-trailer and --marker-env.");
  }
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2
  // -- a scaffold that defaulted to the cwd would write directories and a
  // commit-msg hook into whatever repository the process was standing in
  // (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the repository being scaffolded."),
  });
  const stackFlag = context.args.values["stack"];
  const dryRun = context.args.booleans.has("dry-run");
  const installTools = context.args.booleans.has("install-tools");
  if (dryRun && installTools) {
    throw new VerbUsageError(
      "--dry-run and --install-tools contradict each other: one says nothing happens, the other changes the HOST. Pass one.",
    );
  }

  const result = scaffoldInit({
    root,
    directories: commaList(context.args.values["directories"]),
    hook,
    hookPath: context.args.values["hook-path"],
    force: context.args.booleans.has("force"),
    canonValuesPath: context.args.values["canon-values-path"],
    scenario: context.args.values["scenario"],
    stack: stackFlag === undefined ? undefined : resolveStackId(stackFlag),
    acceptDetected: context.args.booleans.has("accept-detected"),
    dryRun,
    installTools,
    tools: toolsChecker(context, root),
  });

  emit(
    context.io,
    context.json,
    {
      contract: result.contract,
      writes: result.writes,
      migrated: result.migrated,
      tools: result.tools?.report ?? null,
      exitCode: result.exitCode,
    },
    renderInit(result),
  );
  relayProse(context, [...result.notes, ...(result.tools?.lines ?? [])]);
  if (result.exitCode !== 0) {
    context.io.err(`nen: ${result.hookError ?? "a write was refused -- see the report above"}`);
  }
  return result.exitCode;
}

function runNew(context: CommandContext): number {
  const stack = resolveStackId(
    requireValue(context.args, "stack", "'scaffold new' writes one stack's tree, and nen never guesses one."),
  );
  const name = requireValue(context.args, "name", "It is written into this tree's own manifest.");
  const dir = requireValue(context.args, "dir", "It is the directory the fresh tree is written into.");
  const result = scaffoldNew({
    stack,
    name,
    dir,
    hook: readHookSpec(context, false),
    dryRun: context.args.booleans.has("dry-run"),
  });
  emit(
    context.io,
    context.json,
    {
      contract: result.contract,
      writes: result.writes,
      migrated: result.migrated,
      tools: result.tools,
      exitCode: result.exitCode,
    },
    renderNew(result),
  );
  relayProse(context, [
    ...result.notes,
    "post-steps (nen does NOT run these):",
    ...result.postSteps.map((step, index): string => `  ${index + 1}. ${step}`),
  ]);
  if (result.exitCode !== 0) {
    context.io.err("nen: a write was refused -- see the report above");
  }
  return result.exitCode;
}

export const scaffoldCommand: Command = {
  name: "scaffold",
  summary: "Stand a repository up: taxonomy layer, declaration, CI file -- existing tree or fresh.",
  usage: USAGE,
  flags: {
    values: [
      "directories",
      "agent-trailer",
      "run-trailer",
      "marker-env",
      "hook-path",
      "canon-values-path",
      "scenario",
      "stack",
      "name",
      "dir",
    ],
    booleans: ["force", "accept-detected", "install-tools", "dry-run"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("scaffold", context.args, ["init", "new"]);
    return subcommand === "init" ? runInit(context) : runNew(context);
  },
};
