// src/shu/run.ts -- the executor: assert what the declaration says must already
// be true, then run what it says to run, in order, and report both.
//
// ZERO TOOLCHAIN NAMES, ENFORCED (./purity.test.ts). Everything spawned here
// comes out of the target repository's `nen/contract.json`. This file does not
// know what a package manager, a build system, a linter or a test runner is
// called, and the moment it does, the claim that `nen shu` follows a
// repository's own declaration stops being true for whichever stack it learned.
//
// PRECONDITIONS ARE ASSERTED AND NEVER PERFORMED. This is the family's sharpest
// line and it is worth stating where the code is: a declaration saying
// `{"kind": "path", "value": "node_modules"}` is telling nen that a dependency
// install has already happened. nen CHECKS that and refuses when it has not. It
// does not run the install -- a dependency install executes the project's own
// postinstall scripts, which is arbitrary code nen would be running on a
// developer's machine because a JSON file asked it to. The same rule covers
// every other precondition shape: no simulator boot, no submodule update, no
// sibling clone.
//
// A KIND NEN CANNOT ASSERT IS A REFUSAL, NOT A PASS. `preconditions[].kind` is
// deliberately open in the schema -- it is the repository's own word for what
// must be true -- so a declaration may state a kind this release cannot check.
// Reporting that as satisfied would be the exact failure `nen warmup` was fixed
// for (zheref/nen#83): "a check that could not be performed must never render as
// one that came back clean". So it reports `satisfied: null`, says "cannot
// assert", and exits 2.
//
// `--dry-run` PRINTS AND RUNS NOTHING, and the argv it prints is the argv the
// real run spawns -- the same rendering function, from the same rendered plan.
// ./run.test.ts pins that from both sides: the `would run:` lines of a dry run
// equal the calls a scripted seam records for the same invocation.

import { lstatSync } from "node:fs";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { containedPath } from "../repo/contain.js";
import type { Seams } from "../seam/exec.js";
import { EXIT_TOOL_NOT_INSTALLED, ShuRefusal } from "./exit.js";
import { openDeclaration } from "./declaration.js";
import {
  ASSERTABLE_KINDS,
  renderArgv,
  renderInvocation,
  resolveTarget,
  TARGETED_VERBS,
  type HostVerdict,
  type RenderedInvocation,
  type ResolvedTarget,
} from "./render.js";

/**
 * The two long-running verbs. They go through the interactive seam -- stdio
 * inherited, nothing captured -- because a dev server that never exits would
 * otherwise print nothing until it was killed. §2.9 of zheref/nen#91's design:
 * `dev` starts a debug build for local iteration, `run` starts a production or
 * staging build locally; the distinguishing property is the build
 * configuration, and both are long-running.
 */
export const INTERACTIVE_VERBS: readonly string[] = ["dev", "run"];

// The precondition kinds this release can assert now live in ./render.ts --
// the pure half -- because ./detect.ts has to say the same two words and must
// not acquire an import edge to this module to do it. See that constant's own
// comment; ../profiles/inertness.test.ts is what the move is for. `deploy`'s
// TARGETED_VERBS is there for exactly the same reason and arrived the same way.

export interface AssertedPrecondition {
  readonly kind: string;
  readonly value: string | readonly string[];
  /** true, false, or null for "nen cannot assert this kind". */
  readonly satisfied: boolean | null;
}

export interface ShuStepReport {
  readonly exe: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /** The TOOL's own exit code, verbatim. `null` when nothing was run. */
  readonly exitCode: number | null;
  readonly durationMs: number | null;
}

export interface ShuLogReport {
  readonly mode: "dry-run" | "streamed" | "interactive";
  readonly captured: boolean;
  readonly path: string | null;
  readonly why: string;
}

export interface ShuArtifactReport {
  readonly kind: "path";
  readonly value: string;
  readonly exists: boolean;
}

/**
 * The one value both renderings come from (../cli/command.ts's `emit`).
 *
 * KEY ORDER IS PART OF THE CONTRACT and ./run.test.ts pins it, so a field
 * inserted in the middle is a visible decision rather than a silent reshuffle of
 * somebody's golden file.
 *
 * A DRY RUN IS TOLD BY `steps[].exitCode === null` AND BY `log.mode`. There is
 * deliberately no top-level `dryRun` boolean: the fact a machine reader needs is
 * "was anything executed", and two fields that could disagree about it is one
 * field too many.
 */
export interface ShuReport {
  readonly contract: string;
  readonly lane: string;
  readonly stack: string;
  readonly verb: string;
  /**
   * The destination, on a verb that takes one; `null` on every other verb.
   *
   * IT IS IN EVERY VERB'S REPORT, not only `deploy`'s, because one family has
   * one document shape: a reader that had to know which verbs carry the key
   * would be reading a different contract per verb. And it is in the report at
   * all because this is the one verb whose blast radius is other people's
   * users -- a deploy report that did not say WHERE it deployed is a report
   * nobody can audit afterwards.
   */
  readonly target: ResolvedTarget | null;
  readonly steps: readonly ShuStepReport[];
  readonly cwd: string;
  /**
   * Environment variable NAMES this verb adds, sorted. Never values: a
   * declaration's env value can be a token, and a token in a log or a `--json`
   * blob is a leaked token.
   */
  readonly env: readonly string[];
  readonly host: HostVerdict;
  readonly preconditions: readonly AssertedPrecondition[];
  /** NEN's exit code, not the tool's. `null` on an interactive pre-flight. */
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly artifacts: readonly ShuArtifactReport[];
  readonly log: ShuLogReport;
}

/** `nen.shu.<verb>/v0.1` -- one versioned contract string per verb. */
export function contractName(verb: string): string {
  return `nen.shu.${verb}/v0.1`;
}

// "Is something there?" -- `lstatSync`, not `existsSync`, and not `statSync`.
// The reasons are ../schema/source.ts's, and they apply here for the same
// reason: an EACCES on a parent directory is not an absence, and a DANGLING
// symlink at a declared precondition path is a repository problem that must be
// reported as present-and-broken rather than silently as "not built yet".
function entryExists(path: string): boolean {
  try {
    return lstatSync(path, { throwIfNoEntry: false }) !== undefined;
  } catch {
    return true;
  }
}

/**
 * A repo-relative path resolved against the root, refusing one that escapes it.
 *
 * A declaration is the repository's own file, so this is not a trust boundary in
 * the usual sense -- but a `cwd` or a precondition path of `../../etc` is a
 * mistake whose only symptom would otherwise be a verb quietly running
 * somewhere else, and a refusal that names the path costs nothing.
 *
 * THE RULE ITSELF LIVES IN ../repo/contain.ts and is shared with
 * `nen scaffold init`, which asks the same question of a path a FLAG states.
 * Only the refusal is written here, because a message that named neither a
 * declaration pointer nor a flag would name nothing a caller can act on.
 */
export function insideRepo(repoRoot: string, value: string, pointer: string): string {
  const absolute = containedPath(repoRoot, value);
  if (absolute === null) {
    throw new VerbUsageError(
      `${pointer} names '${value}', which resolves outside the repository at ${repoRoot}. Every path a declaration states is relative to the repository root, and nen will not step outside the tree --repo pointed it at.`,
    );
  }
  return absolute;
}

/**
 * Assert every precondition the lane declares. Nothing is performed.
 *
 * `path` is repo-root-relative, NOT lane-relative, and that is what the
 * declarations in the field already assume: a lane whose `cwd` is a
 * subdirectory states its build wrapper with that subdirectory in front of it,
 * because a precondition is a fact about the repository rather than about the
 * directory a verb happens to run in.
 */
export function assertPreconditions(
  plan: RenderedInvocation,
  repoRoot: string,
  seams: Seams,
): readonly AssertedPrecondition[] {
  return plan.preconditions.map((entry, index): AssertedPrecondition => {
    const pointer = `project.preconditions.${plan.lane}[${index}].value`;
    if (!ASSERTABLE_KINDS.includes(entry.kind)) {
      return { kind: entry.kind, value: entry.value, satisfied: null };
    }
    if (Array.isArray(entry.value)) {
      // An assertable kind given the wrong value SHAPE is also "cannot assert":
      // a path is one string, and a list of them is a declaration nen cannot
      // read the intent of without guessing which element it meant.
      return { kind: entry.kind, value: entry.value, satisfied: null };
    }
    const value = entry.value as string;
    if (entry.kind === "path") {
      return { kind: entry.kind, value, satisfied: entryExists(insideRepo(repoRoot, value, pointer)) };
    }
    // `env`: the NAME is the value, and the variable's own value is never read,
    // compared or reported -- presence is the whole assertion.
    return { kind: entry.kind, value, satisfied: seams.env[value] !== undefined };
  });
}

// THE KIND COLUMN IS AS WIDE AS THIS REPORT NEEDS, not a fixed five. `kind` is
// the REPOSITORY's own word for what must be true -- the schema leaves it open
// on purpose -- so any constant here is a guess about somebody else's
// vocabulary, and the first declaration to write a longer one (`command`, seven
// characters) pushed its value out of the column and misaligned the row under
// the two nen can assert. Measuring the rows costs one pass and cannot be wrong.
function kindWidth(preconditions: readonly AssertedPrecondition[]): number {
  return preconditions.reduce((width, entry): number => Math.max(width, entry.kind.length), 4);
}

function describePrecondition(entry: AssertedPrecondition, width: number): string {
  const mark = entry.satisfied === true ? "ok  " : entry.satisfied === false ? "FAIL" : "????";
  const value = Array.isArray(entry.value) ? entry.value.join(" ") : String(entry.value);
  const tail =
    entry.satisfied === true
      ? ""
      : entry.satisfied === false
        ? entry.kind === "env"
          ? " -- not set in this environment"
          : " -- not present"
        : ` -- nen cannot assert a precondition of kind '${entry.kind}'${
            Array.isArray(entry.value) ? " stated as a LIST of values" : ""
          } in this release (it asserts: ${ASSERTABLE_KINDS.join(", ")}, each as one string). An unperformed check is never reported as a clean one`;
  return `  ${mark}  ${entry.kind.padEnd(width)} ${value}${tail}`;
}

const LABEL_WIDTH = 15;

function labelled(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/** The human rendering, derived from the same report `--json` prints. */
export function renderReport(report: ShuReport): readonly string[] {
  const lines: string[] = [];
  lines.push(labelled("lane", `${report.lane}  (${report.stack})`));
  lines.push(labelled("verb", report.verb));
  // THE DESTINATION, ON THE VERB THAT HAS ONE, and printed high -- above the
  // argv, because it is the fact a reader is checking before they let the argv
  // run. `args` is what this target APPENDED, so a reader can see which part of
  // the line below came from the destination rather than from the lane. Only
  // NAMES appear for the environment, here as everywhere.
  if (report.target !== null) {
    lines.push(
      labelled(
        "target",
        `${report.target.name}${
          report.target.args.length === 0
            ? "  (appends no argument)"
            : `  (appends: ${report.target.args.join(" ")})`
        }${
          report.target.requiresEnv.length === 0
            ? ""
            : `  requires env: ${report.target.requiresEnv.join(", ")}`
        }`,
      ),
    );
  }
  lines.push(
    labelled(
      "host",
      `${report.host.platform} -- ${report.host.supported ? "supported" : "UNSUPPORTED"}${
        report.host.declared === null
          ? " (the declaration constrains no platform)"
          : ` (declared: ${report.host.declared.join(", ")})`
      }`,
    ),
  );
  lines.push(
    report.preconditions.length === 0
      ? labelled("preconditions", "(none declared)")
      : "preconditions:",
  );
  const width = kindWidth(report.preconditions);
  for (const entry of report.preconditions) lines.push(describePrecondition(entry, width));
  const verbPrefix = report.log.mode === "dry-run" ? "would run" : "ran";
  for (const step of report.steps) {
    const argv = renderArgv({ exe: step.exe, argv: step.argv });
    // Three shapes for a null exitCode, and only one of them is a failure: a dry
    // run and the interactive pre-flight never ran anything YET (bare argv, the
    // same rendering `--dry-run` always had), while a captured step left null
    // because it could not be SPAWNED at all -- "exit null in nullms" would
    // claim a code that was never produced, so a streamed step says plainly
    // that it did not start instead.
    const detail =
      step.exitCode !== null
        ? `${argv}  -- exit ${step.exitCode} in ${step.durationMs}ms`
        : report.log.mode === "streamed"
          ? `${argv}  -- did not start`
          : argv;
    lines.push(labelled(verbPrefix, detail));
  }
  lines.push(labelled("cwd", report.cwd));
  lines.push(labelled("env", report.env.length === 0 ? "(none added)" : report.env.join(", ")));
  lines.push(
    report.artifacts.length === 0
      ? labelled("artifacts", "(none declared)")
      : labelled(
          "artifacts",
          report.artifacts
            .map((entry): string => `${entry.value}${entry.exists ? "" : " (absent)"}`)
            .join(", "),
        ),
  );
  lines.push(labelled("log", report.log.why));
  return lines;
}

const LOG: Readonly<Record<ShuLogReport["mode"], string>> = {
  "dry-run":
    "dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.",
  streamed:
    "not captured to a file -- each step's own stdout and stderr were relayed as it finished. A .nen/logs/ transcript is not in this release (zheref/nen#91).",
  interactive:
    "not captured -- an interactive verb hands this terminal to the child, so nen never sees its output. This is the pre-flight, printed as TEXT before the handover: --json is refused on a long-running verb because stdout then belongs to the child, and '--dry-run --json' is the machine-readable form of this same report.",
};

function logReport(mode: ShuLogReport["mode"]): ShuLogReport {
  return { mode, captured: false, path: null, why: LOG[mode] };
}

function artifactReports(
  plan: RenderedInvocation,
  repoRoot: string,
): readonly ShuArtifactReport[] {
  return plan.artifacts.map((value, index): ShuArtifactReport => {
    const absolute = insideRepo(repoRoot, value, `project.verbs.${plan.lane}.${plan.verb}.artifacts[${index}]`);
    return { kind: "path", value, exists: entryExists(absolute) };
  });
}

function assemble(
  plan: RenderedInvocation,
  cwd: string,
  repoRoot: string,
  preconditions: readonly AssertedPrecondition[],
  steps: readonly ShuStepReport[],
  exitCode: number | null,
  durationMs: number | null,
  mode: ShuLogReport["mode"],
): ShuReport {
  return {
    contract: contractName(plan.verb),
    lane: plan.lane,
    stack: plan.stack,
    verb: plan.verb,
    target: plan.target,
    steps,
    cwd,
    env: Object.keys(plan.env).sort(),
    host: plan.host,
    preconditions,
    exitCode,
    durationMs,
    artifacts: artifactReports(plan, repoRoot),
    log: logReport(mode),
  };
}

/** Where a run's report goes when it is not going straight to the terminal. */
export type ReportSink = (report: ShuReport) => void;

export interface RunOptions {
  readonly verb: string;
  readonly lane: string | null;
  readonly dryRun: boolean;
  /** `deploy`'s mandatory `--target`. Null for every other verb. */
  readonly target: string | null;
  /**
   * A SINK FOR THE REPORT INSTEAD OF PRINTING IT. Absent -- every verb but one
   * -- and the report is emitted here, as text or as the one JSON document on
   * stdout, exactly as it always was.
   *
   * `coverage` PASSES ONE, AND IT IS THE ONLY CALLER THAT DOES. That verb runs
   * through this executor like any other and then does a SECOND thing: it parses
   * the report the run produced. Its `--json` answer therefore has to be one
   * document carrying both halves, and an executor that had already printed a
   * document of its own would make `nen shu coverage --json | jq .` two objects
   * on one stream -- which is not a document, and is the exact contract
   * `refuseImpossibleFlags` above refuses `dev --json` to protect.
   *
   * WHAT IT IS NOT: a way to run a verb quietly. Nothing here changes -- the
   * same refusals fire in the same order, the same steps spawn, the same exit
   * code comes back, and a step's own stdout is still relayed as it finishes.
   * Only the assembled REPORT is handed to the caller rather than printed, and
   * ./coverage.ts prints it (through the same `renderReport`) as the first half
   * of its own output.
   */
  readonly sink?: ReportSink;
}

/**
 * `--json` ON A LONG-RUNNING VERB, WITHOUT `--dry-run`, IS REFUSED.
 *
 * An interactive verb hands this terminal to the child: the child's stdout IS
 * nen's stdout, unbuffered and unparsed, for as long as it runs. So a `--json`
 * report printed before the handover lands on the same stream the child is
 * about to write to, and `nen shu dev --json | jq .` reads one JSON document
 * followed by a dev server's log lines -- which is not a JSON document. The
 * contract every machine reader of this CLI depends on is "stdout is exactly
 * one object", and it cannot be honoured here.
 *
 * REFUSED RATHER THAN MOVED TO STDERR, which was the other candidate. Putting
 * the report on stderr would keep stdout clean and make `--json` mean somewhere
 * different for two verbs than for the other nine -- a caller redirecting
 * stdout would get an empty file and no error. A refusal that names the
 * alternative in the same sentence costs one run and teaches the rule.
 */
function refuseImpossibleFlags(context: CommandContext, options: RunOptions): void {
  if (!context.json || options.dryRun || !INTERACTIVE_VERBS.includes(options.verb)) return;
  throw new VerbUsageError(
    `'${options.verb}' is long-running: nen inherits this terminal and hands it to the child, so stdout belongs to that child and a --json report would be one object followed by however much the child then writes. Pass --dry-run for the same pre-flight as one JSON document (it starts nothing), or drop --json and read the pre-flight as text. The two long-running verbs are: ${INTERACTIVE_VERBS.join(", ")}.`,
  );
}

/**
 * One verb, from declaration to exit code.
 *
 * The refusals it can raise, and their codes, are ./exit.ts's subject; this
 * function's own contribution is the ORDER, which is:
 *
 *   0. the FLAGS must be a combination nen can honour -- before anything is
 *      read, because it is a fact about the command line and not about the
 *      repository, and a caller who typed an impossible pair should not have
 *      to have a valid declaration to be told so;
 *   1. the declaration must exist;
 *   2. then the lane, then the verb, then the host, then the placeholders --
 *      ./render.ts's own order, every step of it a fact about the repository or
 *      the machine;
 *   3. THEN the destination, on a verb that takes one (./render.ts's
 *      `resolveTarget`, which carries the argument for this position). It was
 *      once step 2, checked before the lane and the verb were read, and that
 *      made a written `deploy` SEAT unreachable: a lane that will never deploy
 *      answered "no targets declared" and sent its maintainer to write a
 *      `targets` block that could not have helped;
 *   4. then the preconditions -- including the environment NAMES the resolved
 *      target requires -- and only then does anything spawn.
 */
export function runVerb(context: CommandContext, repoRoot: string, options: RunOptions): number {
  refuseImpossibleFlags(context, options);
  const { project } = openDeclaration(repoRoot);
  const rendered = renderInvocation(project, {
    lane: options.lane,
    verb: options.verb,
    platform: context.seams.platform,
  });
  const plan = TARGETED_VERBS.includes(options.verb)
    ? resolveTarget(project, rendered, options.target)
    : rendered;
  const cwd = insideRepo(repoRoot, plan.cwdRelative, `project.lanes.${plan.lane}.cwd`);
  const preconditions = assertPreconditions(plan, repoRoot, context.seams);

  const unmet = preconditions.filter((entry): boolean => entry.satisfied !== true);
  if (unmet.length > 0) {
    // THE REPORT IS STILL EMITTED, with the failing rows in it. A caller
    // debugging "why will this not run" needs the table more here than
    // anywhere, and a refusal that printed only prose would make `--json`
    // useless in the one case it is most wanted.
    const steps = plan.steps.map(
      (step): ShuStepReport => ({ exe: step.exe, argv: step.argv, cwd, exitCode: null, durationMs: null }),
    );
    emitReport(context, options.sink, assemble(plan, cwd, repoRoot, preconditions, steps, 2, 0, "dry-run"));
    const cannot = unmet.filter((entry): boolean => entry.satisfied === null);
    context.io.err(
      `${unmet.length} precondition${unmet.length === 1 ? "" : "s"} on lane '${plan.lane}' ${unmet.length === 1 ? "is" : "are"} not satisfied${
        cannot.length === 0 ? "" : ` (${cannot.length} nen cannot assert)`
      }. nen ASSERTS a precondition and never performs it: satisfy ${unmet.length === 1 ? "it" : "them"} with this repository's own tooling, then run this again.`,
    );
    return 2;
  }

  if (options.dryRun) {
    const steps = plan.steps.map(
      (step): ShuStepReport => ({ exe: step.exe, argv: step.argv, cwd, exitCode: null, durationMs: null }),
    );
    emitReport(context, options.sink, assemble(plan, cwd, repoRoot, preconditions, steps, 0, 0, "dry-run"));
    return 0;
  }

  if (INTERACTIVE_VERBS.includes(plan.verb)) {
    return runInteractively(context, plan, cwd, repoRoot, preconditions, options.sink);
  }
  return runCaptured(context, plan, cwd, repoRoot, preconditions, options.sink);
}

function emitReport(context: CommandContext, sink: ReportSink | undefined, report: ShuReport): void {
  // ONE PLACE DECIDES, so a verb with a sink cannot print a document from one
  // arm of this file and hand it over from another -- which is how a caller
  // ends up with two JSON objects on one stream in exactly the failure mode
  // nobody tests for (a precondition refusal, a spawn failure).
  if (sink !== undefined) {
    sink(report);
    return;
  }
  emit(context.io, context.json, report, renderReport(report));
}

/**
 * Relay a step's own output.
 *
 * IN `--json` MODE IT GOES TO STDERR, so stdout stays exactly one JSON document
 * -- the contract every machine reader of this CLI depends on -- while the
 * diagnostic a failing build actually needs is still on screen.
 */
function relay(context: CommandContext, stdout: string, stderr: string): void {
  for (const line of stdout.split("\n")) {
    if (line !== "") (context.json ? context.io.err : context.io.out)(line);
  }
  for (const line of stderr.split("\n")) {
    if (line !== "") context.io.err(line);
  }
}

function runCaptured(
  context: CommandContext,
  plan: RenderedInvocation,
  cwd: string,
  repoRoot: string,
  preconditions: readonly AssertedPrecondition[],
  sink: ReportSink | undefined,
): number {
  const started = context.seams.now().getTime();
  const steps: ShuStepReport[] = [];
  for (const [index, step] of plan.steps.entries()) {
    const stepStarted = context.seams.now().getTime();
    const result = context.seams.run(step.exe, step.argv, {
      cwd,
      ...(Object.keys(plan.env).length === 0 ? {} : { env: plan.env }),
    });
    const durationMs = context.seams.now().getTime() - stepStarted;
    relay(context, result.stdout, result.stderr);
    // `result.code` is MEANINGLESS on a spawn failure (../seam/exec.ts's own
    // words for it) -- typically -1, a value with no exit-code meaning at all --
    // and `durationMs` measured nothing since the process never started. Both
    // are reported `null`, the same value this report already uses everywhere
    // else for "nothing ran" (a dry run, an unreached step): one caller-visible
    // rule instead of a spawn-failure special case that leaks a sentinel number.
    steps.push({
      exe: step.exe,
      argv: step.argv,
      cwd,
      exitCode: result.spawnFailed ? null : result.code,
      durationMs: result.spawnFailed ? null : durationMs,
    });

    if (result.spawnFailed) {
      // NOT exit 1. "the tool is not installed" and "the tool ran and said no"
      // want different reactions, and ../seam/exec.ts keeps them apart
      // precisely so a caller here does not have to guess.
      emitReport(
        context,
        sink,
        assemble(plan, cwd, repoRoot, preconditions, steps, EXIT_TOOL_NOT_INSTALLED, context.seams.now().getTime() - started, "streamed"),
      );
      throw new ShuRefusal(
        EXIT_TOOL_NOT_INSTALLED,
        `step ${index + 1} of ${plan.steps.length} could not be started: '${step.exe}'. This repository's declaration names it for '${plan.verb}' on lane '${plan.lane}'; install it, or put it on PATH. nen never installs a toolchain on a repository's say-so.`,
      );
    }
    if (result.code !== 0) {
      emitReport(
        context,
        sink,
        assemble(plan, cwd, repoRoot, preconditions, steps, 1, context.seams.now().getTime() - started, "streamed"),
      );
      context.io.err(
        `step ${index + 1} of ${plan.steps.length} failed: ${renderArgv(step)} -- exited ${result.code}. nen exits 1 whatever the tool's own code was; the tool's code is in the report above.`,
      );
      return 1;
    }
  }
  emitReport(
    context,
    sink,
    assemble(plan, cwd, repoRoot, preconditions, steps, 0, context.seams.now().getTime() - started, "streamed"),
  );
  return 0;
}

/**
 * A long-running verb: print the pre-flight, then hand over the terminal.
 *
 * THE REPORT COMES FIRST AND CARRIES NULLS, because there is no honest way to
 * report an exit code for a process that has not started and may not stop for
 * hours. A caller that wants the argv without the handover has `--dry-run`.
 */
function runInteractively(
  context: CommandContext,
  plan: RenderedInvocation,
  cwd: string,
  repoRoot: string,
  preconditions: readonly AssertedPrecondition[],
  sink: ReportSink | undefined,
): number {
  const steps = plan.steps.map(
    (step): ShuStepReport => ({ exe: step.exe, argv: step.argv, cwd, exitCode: null, durationMs: null }),
  );
  emitReport(context, sink, assemble(plan, cwd, repoRoot, preconditions, steps, null, null, "interactive"));

  let code = 0;
  for (const [index, step] of plan.steps.entries()) {
    const result = context.seams.runInteractive(step.exe, step.argv, {
      cwd,
      ...(Object.keys(plan.env).length === 0 ? {} : { env: plan.env }),
    });
    if (result.spawnFailed) {
      throw new ShuRefusal(
        EXIT_TOOL_NOT_INSTALLED,
        `step ${index + 1} of ${plan.steps.length} could not be started: '${step.exe}'. This repository's declaration names it for '${plan.verb}' on lane '${plan.lane}'; install it, or put it on PATH.`,
      );
    }
    if (result.code !== 0) {
      context.io.err(
        `${renderArgv(step)} exited ${result.code}${result.signal === null ? "" : ` (${result.signal})`}.`,
      );
      code = 1;
      break;
    }
  }
  return code;
}
