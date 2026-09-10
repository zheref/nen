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
//
// AND ONE VERB IS DRY BY DEFAULT: `deploy` (./render.ts's TARGETED_VERBS) acts
// only when the caller also typed `--run`. Every other verb here spawns
// something inside a directory the caller is standing in and can be undone by
// running it again; a deploy puts bytes on somebody else's infrastructure,
// where "run it again" is not a repair. So it is gated the way this CLI's other
// two irreversible verbs are (`nen label apply --run`, `nen wake fire --run`,
// CON-38's dry-run-first convention), and the two flags are independent:
// `--target` says WHERE, `--run` says NOW, and `--run --dry-run` is refused
// rather than resolved in either direction.

import { lstatSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { containedPath, realContainment } from "../repo/contain.js";
import { PORT_PROBE_TIMEOUT_MS, type Seams } from "../seam/exec.js";
import { EXIT_TOOL_NOT_INSTALLED, ShuRefusal } from "./exit.js";
import { openDeclaration } from "./declaration.js";
import {
  ASSERTABLE_KINDS,
  isLaunchTarget,
  LAUNCHING_VERBS,
  renderArgv,
  renderInvocation,
  resolveLaunch,
  resolveTarget,
  TARGETED_VERBS,
  type HostVerdict,
  type RenderedInvocation,
  type RenderedPrecondition,
  type RenderedStep,
  type ResolvedLaunch,
  type ResolvedTarget,
} from "./render.js";
import { ARTIFACT_TOKEN, DEVICE_ID_TOKEN, findDevice, substituteSteps, tokensUsed } from "./launch.js";

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
  readonly value: string | number | readonly string[];
  /**
   * Which way round a `port` row was asserted, null on every other kind.
   *
   * IN THE DOCUMENT BECAUSE THE VERDICT IS MEANINGLESS WITHOUT IT. `port 3000
   * -- FAIL` says nothing on its own: a reader has to know whether nen wanted
   * something listening there or wanted it clear, and a `--json` consumer that
   * had to go back to the declaration to find out would be reading half a
   * report.
   */
  readonly expect: string | null;
  /** true, false, or null for "nen cannot assert this kind". */
  readonly satisfied: boolean | null;
}

export interface ShuStepReport {
  readonly exe: string;
  readonly argv: readonly string[];
  readonly cwd: string;
  /**
   * The repo-relative file this step's stdout was (or would be) written to, or
   * null. Declared under `project.verbs.<lane>.<verb>.stdoutTo`, or on one
   * entry of that verb's `steps`.
   */
  readonly stdoutTo: string | null;
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
   *
   * ON `dev` AND `run` IT IS THE LAUNCH TARGET (`ResolvedLaunch`), when one was
   * named -- the device, its resolved id, and the steps that run after the verb
   * exits. Two shapes under one key, told apart by their own fields
   * (`requiresEnv` against `device`), with the verb two fields up saying which
   * to expect. A `--target` nobody typed leaves this null, exactly as it is on
   * every other verb.
   */
  readonly target: ResolvedTarget | ResolvedLaunch | null;
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
export async function assertPreconditions(
  plan: RenderedInvocation,
  repoRoot: string,
  seams: Seams,
): Promise<readonly AssertedPrecondition[]> {
  const asserted: AssertedPrecondition[] = [];
  // IN ORDER, ONE AT A TIME, rather than `Promise.all`. The rows are printed in
  // declaration order and a `port` row opens a socket; asserting them
  // concurrently would open every declared port at once for no gain a reader
  // can see, and would make the order the probes happened depend on the event
  // loop rather than on the file.
  for (const entry of plan.preconditions) {
    asserted.push(await assertOne(entry, repoRoot, seams));
  }
  return asserted;
}

/**
 * One row, asserted. See `assertPreconditions` above for what that means.
 *
 * THE ROW'S OWN ADDRESS COMES FROM ./render.ts rather than from an index here.
 * Two blocks contribute rows to one list -- the lane's `preconditions`, and the
 * variable NAMES a resolved `deploy` target requires -- so an index into the
 * MERGED list addressed the wrong file position for every row of the second
 * kind, naming a `project.preconditions.<lane>[i]` that does not exist.
 *
 * IT IS USED VERBATIM, WITH NOTHING APPENDED. `RenderedPrecondition.pointer` is
 * ALWAYS the pointer to the value being asserted -- a lane row's own pointer
 * already carries `.value` (../render.ts's `lanePreconditions`), and a target's
 * `requiresEnv` row already names its leaf directly (no `.value` to append: the
 * array element IS the string).
 */
async function assertOne(
  entry: RenderedPrecondition,
  repoRoot: string,
  seams: Seams,
): Promise<AssertedPrecondition> {
  const unassertable: AssertedPrecondition = {
    kind: entry.kind,
    value: entry.value,
    expect: entry.expect,
    satisfied: null,
  };
  if (!ASSERTABLE_KINDS.includes(entry.kind)) return unassertable;
  if (Array.isArray(entry.value)) {
    // An assertable kind given the wrong value SHAPE is also "cannot assert":
    // a path is one string, and a list of them is a declaration nen cannot
    // read the intent of without guessing which element it meant.
    return unassertable;
  }
  if (entry.kind === "port") {
    // THE ONE ROW THAT REACHES THE NETWORK, and it reaches loopback only: nen
    // opens a TCP connection to 127.0.0.1 on the declared port and destroys it.
    // Nothing is read, nothing is written, and no other host can be named.
    //
    // A TIMEOUT IS `null`, NOT `false`. "Nothing answered in time" is the
    // absence of a fact, and reporting it as "the port is free" would be the
    // same lie as reporting an unperformed check as a clean one -- so it lands
    // where every other unassertable row lands, at exit 2, saying so.
    const verdict = await seams.probePort(entry.value as number);
    return {
      ...unassertable,
      satisfied:
        verdict === "timeout" ? null : entry.expect === "free" ? verdict === "refused" : verdict === "open",
    };
  }
  const value = entry.value as string;
  if (entry.kind === "path") {
    return {
      ...unassertable,
      value,
      satisfied: entryExists(insideRepo(repoRoot, value, entry.pointer)),
    };
  }
  // `env`: the NAME is the value, and the variable's own value is never read,
  // compared or reported -- presence is the whole assertion.
  return { ...unassertable, value, satisfied: seams.env[value] !== undefined };
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
  // THE DIRECTION IS PRINTED BESIDE THE VALUE, not only in the failure tail: a
  // row reading `ok   port 3000` says nothing about which state was wanted, and
  // a reader checking a table before they let a build run is checking exactly
  // that.
  const asked = entry.expect === null ? "" : ` (expect ${entry.expect})`;
  const tail =
    entry.satisfied === true
      ? ""
      : entry.satisfied === false
        ? entry.kind === "env"
          ? " -- not set in this environment"
          : entry.kind === "port"
            ? entry.expect === "free"
              ? " -- something is listening on it"
              : " -- the connection was refused; nothing is listening"
            : " -- not present"
        : entry.kind === "port" && !Array.isArray(entry.value)
          ? // THE PROBE RAN AND ANSWERED NOTHING, which is neither state: a
            // dropped SYN, a loaded host, a listener that accepted and went
            // quiet. Reported where every other unassertable row is reported.
            ` -- the connection to 127.0.0.1:${String(entry.value)} neither completed nor was refused within ${PORT_PROBE_TIMEOUT_MS}ms, so nen cannot say whether it is ${entry.expect === "free" ? "free" : "listening"}. An unperformed check is never reported as a clean one`
          : ` -- nen cannot assert a precondition of kind '${entry.kind}'${
              Array.isArray(entry.value) ? " stated as a LIST of values" : ""
            } in this release (it asserts: ${ASSERTABLE_KINDS.join(", ")} -- 'path' and 'env' as one string, 'port' as one number). An unperformed check is never reported as a clean one`;
  return `  ${mark}  ${entry.kind.padEnd(width)} ${value}${asked}${tail}`;
}

/**
 * The `substitutes:` line of a launch dry run, or nothing.
 *
 * IT IS DERIVED FROM THE REPORT, like every other line here, so `--json` and
 * the text rendering cannot disagree about what a run would fill in: the tokens
 * come from the after-steps the document carries, the device name from
 * `target.device`, the artifact from `artifacts[0]`.
 */
function substitutionNotes(report: ShuReport): readonly string[] {
  const target = report.target;
  if (!isLaunchTarget(target)) return [];
  const used = tokensUsed(target.after);
  if (used.length === 0) return [];
  const artifact = report.artifacts[0];
  const notes = used.map((token): string => {
    if (token === DEVICE_ID_TOKEN) {
      const device = target.device;
      /* c8 ignore next -- `resolveLaunch` refuses this token with no device */
      const name = device === null ? "" : device.name;
      // A SIMULATED DEVICE HAS NO PROBE AND NEEDS NONE: its name IS its id, so
      // the note says that rather than pointing at a line that is not there.
      return target.probe === null
        ? `${DEVICE_ID_TOKEN} <- '${name}' itself -- a simulated device is addressed by its name, so nothing is probed`
        : `${DEVICE_ID_TOKEN} <- the id of device '${name}', read from the probe above`;
    }
    /* c8 ignore next -- `tokensUsed` returns only this family's two tokens */
    return `${ARTIFACT_TOKEN} <- ${artifact === undefined ? "(the verb declares none)" : artifact.value}`;
  });
  return [labelled("substitutes", notes.join("; "))];
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
  if (isLaunchTarget(report.target)) {
    // THE LAUNCH TARGET, and it is printed high for the deploy target's reason:
    // it is the fact a reader checks before they let the argv run. A device
    // whose id is still null is a device nothing has probed yet -- a dry run --
    // and it says so rather than showing an empty column.
    const launch = report.target;
    const device = launch.device;
    lines.push(
      labelled(
        "target",
        `${launch.name}${
          launch.args.length === 0
            ? "  (appends no argument)"
            : `  (appends: ${renderArgv({ exe: launch.args[0] as string, argv: launch.args.slice(1) })})`
        }`,
      ),
    );
    if (device !== null) {
      lines.push(
        labelled(
          "device",
          `${device.name}${device.kind === null ? "" : ` (${device.kind})`}${
            device.id === null ? "  -- id not resolved (nothing was probed)" : `  id ${device.id}`
          }`,
        ),
      );
    }
  } else if (report.target !== null) {
    const target = report.target;
    // QUOTED THE SAME WAY THE `would run:` LINE QUOTES ITS OWN ARGV --
    // `renderArgv` implements the project's one quoting rule, and a target's
    // appended args are argv tokens like any other. `join(" ")` here would
    // silently un-quote a token that carries whitespace or a quote (an `--env
    // 'staging east'` destination becomes `--env staging east`, which reads as
    // TWO elements instead of one), so this reuses `renderArgv` rather than
    // growing a second, looser rendering of the same tokens. `exe` takes the
    // first token because `renderArgv` quotes it exactly as it quotes every
    // `argv` element -- there is no seam here for a real executable to reach.
    const [firstArg, ...restArgs] = target.args;
    lines.push(
      labelled(
        "target",
        `${target.name}${
          firstArg === undefined
            ? "  (appends no argument)"
            : `  (appends: ${renderArgv({ exe: firstArg, argv: restArgs })})`
        }${
          target.requiresEnv.length === 0 ? "" : `  requires env: ${target.requiresEnv.join(", ")}`
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
    // WHERE THIS STEP'S OUTPUT GOES, ON THE STEP'S OWN LINE. A dry run is a
    // promise that what it prints is what runs, and a file appearing on disk
    // that no `would run:` line mentioned would break it. It is printed on a
    // REAL run too, for the same reason `artifacts` is: the line that says what
    // ran should say what it wrote.
    const redirect = step.stdoutTo === null ? "" : `  stdout -> ${step.stdoutTo}`;
    const detail =
      step.exitCode !== null
        ? `${argv}${redirect}  -- exit ${step.exitCode} in ${step.durationMs}ms`
        : report.log.mode === "streamed"
          ? `${argv}${redirect}  -- did not start`
          : `${argv}${redirect}`;
    lines.push(labelled(verbPrefix, detail));
  }
  // WHAT A REAL RUN WOULD PUT WHERE, printed only where the steps above still
  // carry the tokens unfilled. A dry run spawns nothing -- the device probe
  // included -- so `{device.id}` is shown as itself and this line is the whole
  // of what a reader would otherwise have to infer: which token stands for
  // what, and which value the substitution reads. A run that HAS probed prints
  // the filled-in argv instead, and needs no line.
  for (const line of substitutionNotes(report)) lines.push(line);
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
  // BESIDE `artifacts`, AND IT IS THE OTHER HALF OF THE SAME QUESTION. Both
  // lines answer "which files does this run put on disk": `artifacts` names the
  // ones the TOOL writes and nen only reports, this one names the ones NEN
  // writes -- a step's own stdout, redirected by the declaration. Printed even
  // when empty, exactly as `artifacts` is, so the absence is a stated fact
  // rather than a line a reader has to notice is missing.
  const redirects = stdoutTargets(report.steps);
  lines.push(
    labelled("stdout to", redirects.length === 0 ? "(none declared)" : redirects.join(", ")),
  );
  lines.push(labelled("log", report.log.why));
  return lines;
}

/** The files this run's steps redirect their stdout to, in step order. */
function stdoutTargets(steps: readonly ShuStepReport[]): readonly string[] {
  return steps.flatMap((step): readonly string[] => (step.stdoutTo === null ? [] : [step.stdoutTo]));
}

const LOG: Readonly<Record<ShuLogReport["mode"], string>> = {
  "dry-run":
    "dry run -- nothing was executed, so there is no output to capture and no tool exit code to report.",
  streamed:
    "not captured to a file -- each step's own stdout and stderr were relayed as it finished. A .nen/logs/ transcript is not in this release (zheref/nen#91).",
  interactive:
    "not captured -- an interactive verb hands this terminal to the child, so nen never sees its output. This is the pre-flight, printed as TEXT before the handover: --json is refused on a long-running verb because stdout then belongs to the child, and '--dry-run --json' is the machine-readable form of this same report.",
};

/**
 * `log` describes NEN's OWN TRANSCRIPT of the run, and `stdoutTo` does not
 * change it: `captured` and `path` stay false and null because nen still keeps
 * no transcript of its own, and there is no single file to name when several
 * steps each redirect somewhere different.
 *
 * WHAT IT DOES CHANGE IS THE SENTENCE. "each step's own stdout and stderr were
 * relayed as it finished" stops being true the moment one of them went to a
 * file instead, and a `log.why` that says something a reader can see is false
 * is worse than one that says less. So the clause is appended, naming the
 * files, and only when there are any -- every run without `stdoutTo` reads
 * exactly as it always did.
 */
function logReport(mode: ShuLogReport["mode"], redirected: readonly string[] = []): ShuLogReport {
  // THE TENSE FOLLOWS THE MODE, because this line is read beside `would run:`
  // as often as beside `ran:` -- and a dry run reporting that a file "was
  // written" would be claiming the one thing a dry run promises not to do.
  const written = mode === "dry-run" ? "would be written" : "was written";
  const why =
    redirected.length === 0
      ? LOG[mode]
      : `${LOG[mode]} ${redirected.length} step${redirected.length === 1 ? "" : "s"} declared 'stdoutTo', so ${redirected.length === 1 ? "its" : "their"} stdout ${written} to a file instead of the terminal: ${redirected.join(", ")}.`;
  return { mode, captured: false, path: null, why };
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
    log: logReport(mode, stdoutTargets(steps)),
  };
}

/** A step that has not run: the argv, where its stdout goes, and two nulls. */
function unrun(step: RenderedStep, cwd: string): ShuStepReport {
  return {
    exe: step.exe,
    argv: step.argv,
    cwd,
    stdoutTo: step.stdoutTo?.path ?? null,
    exitCode: null,
    durationMs: null,
  };
}

/** Where a run's report goes when it is not going straight to the terminal. */
export type ReportSink = (report: ShuReport) => void;

export interface RunOptions {
  readonly verb: string;
  readonly lane: string | null;
  readonly dryRun: boolean;
  /**
   * `deploy`'s MANDATORY destination, or `dev`/`run`'s OPTIONAL device. Null on
   * every other verb, which do not read it -- ./command.ts's per-subcommand
   * flag table refuses it there.
   *
   * ONE FLAG, TWO BLOCKS, AND THE VERB SAYS WHICH. On `deploy` it names a key
   * of `project.targets` and is required with no default ever; on `dev` and
   * `run` it names a key of `project.launch` and is optional -- bare, those two
   * verbs run the lane's declared argv exactly as they always have, which is
   * why a repository declaring its first launch target breaks no script that
   * ran `nen shu dev` yesterday.
   */
  readonly target: string | null;
  /**
   * `deploy`'s mandatory `--run`. False for every other verb, which do not
   * read it -- ./command.ts's per-subcommand flag table refuses it there.
   *
   * WITHOUT IT THE VERB REPORTS AND ACTS ON NOTHING, which is `nen label
   * apply --run`'s and `nen wake fire --run`'s shape (CON-38's dry-run-first
   * convention) applied to the one verb in this family whose blast radius is
   * other people's users. `--target` says WHERE and `--run` says NOW, and
   * neither implies the other: a caller who has typed the destination
   * correctly has not thereby said "send it".
   */
  readonly run: boolean;
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
  // `--run --dry-run` IS REFUSED RATHER THAN RESOLVED IN EITHER DIRECTION.
  // One says "send it" and the other says "send nothing", and a caller who has
  // typed both has not said which they meant. Honouring `--dry-run` would be
  // the safe reading and is still the wrong one: it exits 0 having deployed
  // nothing, which a script reads as a deploy that worked. Honouring `--run`
  // is unthinkable on this verb. So neither -- and because it is a fact about
  // the command line, it answers before the declaration is even opened.
  if (options.run && options.dryRun) {
    throw new VerbUsageError(
      `'${options.verb}' was given both --run and --dry-run. --run sends the build; --dry-run sends nothing and prints what would have been sent. Nen will not pick one of two contradicting instructions on the one verb whose blast radius is other people's users. Drop --run to see the plan (that is what this verb does without it, and --dry-run is its explicit spelling), or drop --dry-run to send it.`,
    );
  }
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
 *      target requires;
 *   5. and only then, on a verb with a destination, does `--run` decide whether
 *      anything spawns at all. Without it the resolved plan is printed and
 *      nothing is started, at exit 0.
 */
export async function runVerb(
  context: CommandContext,
  repoRoot: string,
  options: RunOptions,
): Promise<number> {
  refuseImpossibleFlags(context, options);
  const { project } = openDeclaration(repoRoot);
  const rendered = renderInvocation(project, {
    lane: options.lane,
    verb: options.verb,
    platform: context.seams.platform,
  });
  // TWO BLOCKS BEHIND ONE FLAG, AND THE VERB PICKS. `deploy` always resolves a
  // destination (the flag is required there, and `resolveTarget` is what
  // refuses its absence); `dev` and `run` resolve a DEVICE only when one was
  // named, because a bare `nen shu dev` is the ordinary local iteration this
  // verb has always been and a repository declaring its first launch target
  // must not change what that line does.
  const plan = TARGETED_VERBS.includes(options.verb)
    ? resolveTarget(project, rendered, options.target)
    : LAUNCHING_VERBS.includes(options.verb) && options.target !== null
      ? resolveLaunch(project, rendered, options.target)
      : rendered;
  const cwd = insideRepo(repoRoot, plan.cwdRelative, `project.lanes.${plan.lane}.cwd`);
  const preconditions = await assertPreconditions(plan, repoRoot, context.seams);

  const unmet = preconditions.filter((entry): boolean => entry.satisfied !== true);
  if (unmet.length > 0) {
    // THE REPORT IS STILL EMITTED, with the failing rows in it. A caller
    // debugging "why will this not run" needs the table more here than
    // anywhere, and a refusal that printed only prose would make `--json`
    // useless in the one case it is most wanted.
    const steps = plannedSteps(plan).map(
      (step): ShuStepReport => unrun(step, cwd),
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

  // THE GATE, AND IT IS THE LAST THING BEFORE ANYTHING SPAWNS. A verb with a
  // destination acts only when the caller said `--run`; without it this is the
  // same report `--dry-run` prints -- the fully resolved argv, the destination
  // substituted, every precondition asserted -- and nothing is started.
  //
  // WHY IT IS EXIT 0 AND A REPORT RATHER THAN "add --run" AT EXIT 2. The shape
  // is `nen label apply` and `nen wake fire`'s, verbatim: those print what they
  // WOULD do and exit 0, and the sentence on stderr says the run wrote nothing.
  // A refusal instead would make the safe form of this verb the one that
  // fails, so a caller checking the plan reads a non-zero code for having done
  // the careful thing -- and every wrapper script would learn to ignore it.
  const gated = TARGETED_VERBS.includes(options.verb) && !options.run;
  if (options.dryRun || gated) {
    const steps = plannedSteps(plan).map(
      (step): ShuStepReport => unrun(step, cwd),
    );
    emitReport(context, options.sink, assemble(plan, cwd, repoRoot, preconditions, steps, 0, 0, "dry-run"));
    // ON STDERR, NOT IN THE DOCUMENT, so `--json` stdout stays exactly one
    // object of the published shape -- the same place every other advisory
    // sentence in this family goes.
    if (gated && !options.dryRun) {
      context.io.err(
        `nothing was sent: '${options.verb}' acts only with --run. The plan above is fully resolved -- the destination substituted into the argv, every precondition asserted -- and no process was started. Re-run the same line with --run to send it.`,
      );
    }
    return 0;
  }

  // THE LAST THING CHECKED BEFORE THE FIRST SPAWN, and checked for EVERY step
  // at once rather than one at a time as each is reached. A run whose third
  // step cannot write its file is a run that should not have started its
  // first: the tool has already spent its minutes by then, and the refusal
  // arrives after the work rather than instead of it.
  //
  // NOT ON A DRY RUN, deliberately. A dry run touches nothing and asks the
  // filesystem nothing it does not have to; the containment rule that could be
  // decided from the text alone was already decided when the file LOADED, and
  // "is something already sitting at this path" is a fact about the moment of
  // the run rather than about the declaration.
  for (const step of plan.steps) refuseUnwritableRedirect(step, repoRoot);

  const launch = launchOf(plan);
  if (launch !== null) {
    return runLaunch(context, plan, launch, cwd, repoRoot, preconditions, options.sink);
  }
  if (INTERACTIVE_VERBS.includes(plan.verb)) {
    return runInteractively(context, plan, cwd, repoRoot, preconditions, options.sink);
  }
  return runCaptured(context, plan, cwd, repoRoot, preconditions, options.sink);
}

/**
 * Refuse a `stdoutTo` nen could not honestly write to, before anything spawns.
 *
 * THE LOADER ALREADY REFUSED THE SHAPES IT COULD SEE -- an absolute path, a
 * `..` segment, a glob -- and this is the half only a filesystem can answer:
 *
 *   * A DIRECTORY AT THE PATH. `writeFileSync` on one throws EISDIR mid-run,
 *     after the tool has finished, and the caller would meet it as a crash
 *     rather than as a refusal naming the declaration.
 *   * A SYMLINK THAT LEAVES THE TREE. `nen/reports` linked to `/tmp/elsewhere`
 *     makes `nen/reports/coverage.json` land outside the repository while every
 *     line nen printed still said `nen/reports/coverage.json`. ../repo/contain
 *     .ts's `realContainment` is the same check `nen scaffold init` makes
 *     before it writes, and for the same reason: nen writes what its report
 *     says it writes.
 */
function refuseUnwritableRedirect(step: RenderedStep, repoRoot: string): void {
  if (step.stdoutTo === null) return;
  // THE POINTER IS THE STEP'S OWN, carried from ../shu/render.ts, because a
  // `{steps}` row states this key at `…steps[<i>].stdoutTo` and a `{exe, argv}`
  // row states it at `…stdoutTo` -- and a refusal naming a file position that
  // does not exist is a refusal a reader cannot act on.
  const { path: declared, pointer } = step.stdoutTo;
  const absolute = insideRepo(repoRoot, declared, pointer);
  const containment = realContainment(repoRoot, absolute);
  if (!containment.contained) {
    throw new VerbUsageError(
      `${pointer} names '${declared}', which would be written to '${containment.real}', outside the repository at ${repoRoot}: '${containment.link ?? absolute}' is a symlink pointing at '${containment.target ?? containment.real}'. nen writes what its report says it writes, so this write is refused rather than followed.`,
    );
  }
  // `throwIfNoEntry: false` COVERS ONLY ENOENT, which is the ordinary case here
  // -- the file has not been written yet. Everything else still throws: an
  // EACCES on a parent, or an ENOTDIR because an ancestor of this path is a
  // FILE. Both are certain to fail the write a few steps later, and letting
  // them escape would end the verb as a stack trace rather than as this
  // family's exit 2 -- so the errno is caught and named here, where the
  // declaration that asked for it can be named beside it.
  let entry;
  try {
    entry = lstatSync(absolute, { throwIfNoEntry: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unknown error";
    throw new VerbUsageError(
      `${pointer} names '${declared}', and nen cannot tell what is at that path: ${code}. This step's stdout is written there as a file, so a path nen cannot even inspect is one it will not promise to write -- most often an ancestor directory that is really a file (ENOTDIR), or one this user cannot read (EACCES). Fix the path, or the permissions on it.`,
    );
  }
  if (entry !== undefined && entry.isDirectory()) {
    throw new VerbUsageError(
      `${pointer} names '${declared}', and a DIRECTORY is already there. nen writes this step's stdout to that path as a file; it will not remove a directory to make room for one, and discovering this after the tool had run would mean spending the whole build to learn it. Name a file, or move what is in the way.`,
    );
  }
}

/**
 * The launch target on a plan, or null -- the one place the two shapes of
 * `RenderedInvocation.target` are told apart, so no other reader has to.
 */
export function launchOf(plan: RenderedInvocation): ResolvedLaunch | null {
  return isLaunchTarget(plan.target) ? plan.target : null;
}

/**
 * Every step this plan would spawn, in the order it would spawn them.
 *
 * A LAUNCH IS THREE THINGS AND THE REPORT SAYS SO: the device probe, then the
 * lane's own verb, then the after-steps. `--dry-run` prints exactly this list
 * as `would run:` lines, which is what makes "the thing you approve is the
 * thing that runs" true for a launch as it already is for every other verb --
 * a plan that printed only the middle third would be approving a third of it.
 */
export function plannedSteps(plan: RenderedInvocation): readonly RenderedStep[] {
  const launch = launchOf(plan);
  if (launch === null) return plan.steps;
  return [...(launch.probe === null ? [] : [launch.probe]), ...plan.steps, ...launch.after];
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

/**
 * Write one step's captured stdout to the file its declaration named.
 *
 * NO SHELL, NO REDIRECTION OPERATOR, NO SECOND PROCESS. ../seam/exec.ts already
 * captures a child's stdout -- that is what `run` is -- so this is the ordinary
 * `writeFileSync` those bytes were always one line away from. `sh -c 'cmd >
 * file'` would have been the other way to get here, and it is the way this
 * family exists to refuse: an argv is a list, and a string form is one `sh -c`
 * away from a shell.
 *
 * PARENT DIRECTORIES ARE CREATED, and only the ones under the repository root
 * -- `refuseUnwritableRedirect` has already proved the path stays in the tree
 * with its symlinks resolved. A declaration naming `nen/reports/coverage.json`
 * on a fresh clone should not have to also declare a step that makes the
 * directory: nen is writing the file, so nen makes room for it.
 *
 * THE BYTES ARE THE CHILD'S, with the seam's one normalisation already applied
 * (CRLF -> LF, ../seam/exec.ts). Nothing is trimmed, re-encoded or parsed: a
 * later reader -- `nen shu coverage`, most likely -- opens the file and decides
 * for itself, exactly as it would if a shell had written it.
 */
function writeRedirect(step: RenderedStep, stdout: string, repoRoot: string): void {
  if (step.stdoutTo === null) return;
  const absolute = insideRepo(repoRoot, step.stdoutTo.path, step.stdoutTo.pointer);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, stdout, "utf8");
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
    // A REDIRECTED STEP'S STDOUT DOES NOT ALSO GO TO THE TERMINAL. That is what
    // a redirect MEANS everywhere a developer has met one, and printing the
    // bytes twice would bury the report under the very document the declaration
    // asked nen to file away. Its STDERR is relayed as it always was, because
    // that is where a tool says what went wrong -- and a tool that failed with
    // its output in a file is exactly when a reader needs the diagnostic.
    relay(context, step.stdoutTo === null ? result.stdout : "", result.stderr);
    // WRITTEN WHATEVER THE TOOL EXITED, and written before the exit code is
    // read below. A tool that printed half a report and then failed leaves that
    // half on disk, which is what a redirect does and what a reader debugging
    // the failure wants; a step that never STARTED wrote nothing to write.
    if (!result.spawnFailed) writeRedirect(step, result.stdout, repoRoot);
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
      stdoutTo: step.stdoutTo?.path ?? null,
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
    (step): ShuStepReport => unrun(step, cwd),
  );
  emitReport(context, sink, assemble(plan, cwd, repoRoot, preconditions, steps, null, null, "interactive"));
  return handOver(context, plan, cwd);
}

/**
 * The handover itself, split out from the report so a LAUNCH can do the same
 * thing between a probe and a set of after-steps.
 *
 * Nothing about it changed in the split: the same steps, the same env, the same
 * two refusals, and the same "stop at the first one that did not exit 0".
 */
function handOver(context: CommandContext, plan: RenderedInvocation, cwd: string): number {
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

/**
 * `dev`/`run` WITH `--target`: probe the device, hand over the terminal, then
 * run the declared after-steps against the id the probe reported.
 *
 * THE ORDER IS THE WHOLE VERB, and each third is refused in its own way:
 *
 *   1. THE PROBE, through the CAPTURED seam -- nen has to read its output, so
 *      this one step of a long-running verb is not interactive. It could not be
 *      started -> 5; it ran and failed -> 1; it ran and did not name the device
 *      -> 5, listing what it DID offer.
 *   2. THE PRE-FLIGHT REPORT, carrying the resolved id and the substituted
 *      after-steps. It is printed BEFORE the handover for `runInteractively`'s
 *      reason: once the child owns this terminal, nen's own output is
 *      interleaved with a build's.
 *   3. THE VERB, interactively, exactly as a bare `dev` runs it.
 *   4. THE AFTER-STEPS, captured and relayed, in order, stopping at the first
 *      one that did not exit 0. They run only if the verb exited 0 -- installing
 *      a build that failed to build is not a thing to attempt.
 *
 * A VERB THAT NEVER EXITS NEVER REACHES ITS AFTER-STEPS, and that is a property
 * of what was declared rather than a limitation here: a launch target whose
 * `verb` starts a watcher is a target whose after-steps run when the developer
 * stops it. The docs say so; nen does not background anything.
 */
function runLaunch(
  context: CommandContext,
  plan: RenderedInvocation,
  launch: ResolvedLaunch,
  cwd: string,
  repoRoot: string,
  preconditions: readonly AssertedPrecondition[],
  sink: ReportSink | undefined,
): number {
  // THE VERB'S DECLARED `env` REACHES ALL THREE THIRDS, and that is a decision
  // rather than a fall-through. A launch is ONE lane operation -- probe the
  // device this build is for, build it, put it there -- and an installer that
  // could not see the variables the build was given would be a second
  // environment nobody declared. Only the NAMES are ever reported, here as
  // everywhere: `ShuReport.env` is `Object.keys`.
  const env = Object.keys(plan.env).length === 0 ? {} : { env: plan.env };
  const steps: ShuStepReport[] = [];
  let deviceId: string | null = null;

  if (launch.device !== null && launch.probe !== null) {
    const probe = launch.probe;
    const startedAt = context.seams.now().getTime();
    const result = context.seams.run(probe.exe, probe.argv, { cwd, ...env });
    const durationMs = context.seams.now().getTime() - startedAt;
    // THE PROBE'S STDOUT IS DATA, NOT OUTPUT. It is the document nen is about
    // to search, and relaying a device list to the terminal every time somebody
    // launches would bury the report under it. Its STDERR is relayed, because
    // that is where a probe says what went wrong.
    relay(context, "", result.stderr);
    steps.push({
      exe: probe.exe,
      argv: probe.argv,
      cwd,
      // A PROBE NEVER REDIRECTS. Its stdout is the document nen searches for a
      // device id -- an input, not an output -- and the loader gives a device's
      // `resolve` step no `stdoutTo` key to state.
      stdoutTo: null,
      exitCode: result.spawnFailed ? null : result.code,
      durationMs: result.spawnFailed ? null : durationMs,
    });
    if (result.spawnFailed) {
      throw new ShuRefusal(
        EXIT_TOOL_NOT_INSTALLED,
        `the device probe could not be started: '${probe.exe}'. This repository's declaration names it under project.launch.${launch.name}.device.resolve; install it, or put it on PATH. nen never installs a toolchain on a repository's say-so.`,
      );
    }
    if (result.code !== 0) {
      emitReport(
        context,
        sink,
        assemble(plan, cwd, repoRoot, preconditions, steps, 1, durationMs, "streamed"),
      );
      context.io.err(
        `the device probe failed: ${renderArgv(probe)} -- exited ${result.code}. nen exits 1 whatever the tool's own code was. Nothing was launched: the device for '${launch.name}' was never resolved.`,
      );
      return 1;
    }
    deviceId = resolvedId(launch, result.stdout);
  } else if (launch.device !== null) {
    // NO PROBE, AND `resolveLaunch` HAS ALREADY PROVED THIS IS A SIMULATED
    // DEVICE: its name IS its id, so nothing is spawned to learn one.
    deviceId = launch.device.name;
  }

  const artifact = plan.artifacts[0] ?? null;
  const after = substituteSteps(launch.after, { deviceId, artifact });
  const resolved: RenderedInvocation = {
    ...plan,
    target: {
      ...launch,
      device: launch.device === null ? null : { ...launch.device, id: deviceId },
      after,
    },
  };
  emitReport(
    context,
    sink,
    assemble(
      resolved,
      cwd,
      repoRoot,
      preconditions,
      [
        ...steps,
        ...plan.steps.map(
          (step): ShuStepReport => unrun(step, cwd),
        ),
        ...after.map(
          (step): ShuStepReport => unrun(step, cwd),
        ),
      ],
      null,
      null,
      "interactive",
    ),
  );

  const code = handOver(context, plan, cwd);
  if (code !== 0) {
    context.io.err(
      `'${plan.verb}' did not exit 0, so the ${after.length} after-step${after.length === 1 ? "" : "s"} of launch target '${launch.name}' ${after.length === 1 ? "was" : "were"} not run.`,
    );
    return code;
  }
  return runAfter(context, after, cwd, env, launch.name);
}

/**
 * The id the probe's output gives for this target's device, or a refusal.
 *
 * EXIT 5 FOR BOTH ABSENCES, and 5 is the right code rather than a convenient
 * one: it is this family's "the thing nen was told to reach is not on this
 * host", which is exactly what a disconnected, asleep or renamed device is. Not
 * 1, because nothing failed -- the probe ran and answered; not 2, because the
 * command line was correct and the fix is to plug something in.
 */
function resolvedId(launch: ResolvedLaunch, stdout: string): string {
  /* c8 ignore next -- runLaunch only calls this with a device declared */
  const device = launch.device;
  /* c8 ignore next */
  if (device === null) throw new ShuRefusal(EXIT_TOOL_NOT_INSTALLED, "no device declared.");
  const lookup = findDevice(device.name, stdout);
  if (!lookup.found) {
    throw new ShuRefusal(
      EXIT_TOOL_NOT_INSTALLED,
      `the device '${device.name}' is not among ${
        lookup.sawKind === "names"
          ? `the devices the probe reported (${lookup.saw.length === 0 ? "it reported none" : lookup.saw.map((name): string => `'${name}'`).join(", ")})`
          : `the probe's output (${lookup.saw.length === 0 ? "it printed nothing" : `it printed: ${lookup.saw.join(" | ")}`})`
      }. project.launch.${launch.name}.device.name is matched exactly, as the repository writes it -- nen never picks a device for you, not even when there is only one. Connect it, wake it, or fix the name.`,
    );
  }
  if (lookup.ambiguous.length > 0) {
    // NEN PICKS NEITHER, and this is the case a plain-text match cannot tell
    // apart on its own: `Handset` is carried by the `Handset Pro` row exactly
    // as it is by the `Handset` row, and taking the first would put the build
    // on somebody else's phone at exit 0. Refused with both candidates, so the
    // fix -- a fuller name, or a probe that prints one device per line -- is
    // visible in the refusal itself.
    throw new ShuRefusal(
      EXIT_TOOL_NOT_INSTALLED,
      `the name '${device.name}' matches ${lookup.ambiguous.length} ${
        lookup.sawKind === "names" ? "devices the probe reported" : "of the probe's own lines"
      }, and nen will not pick one of them: ${lookup.ambiguous.map((entry): string => `'${entry}'`).join(", ")}. project.launch.${launch.name}.device.name is the whole match, so a name that is the beginning of a longer one matches both. Write the fuller name, or declare a probe that prints one device per line.`,
    );
  }
  if (lookup.id === null) {
    throw new ShuRefusal(
      EXIT_TOOL_NOT_INSTALLED,
      `the probe named the device '${device.name}' and gave nen no id for it. nen reads an id from one of identifier, id, udid or serial in JSON output, or -- in plain output -- from the first token on the device's own line that is at least six characters of letters, digits, '.', '_', ':' or '-' and carries a digit. Declare a probe whose output carries one of those, or write the id this target needs literally into its after-steps.`,
    );
  }
  return lookup.id;
}

/** The after-steps, captured and relayed, stopping at the first non-zero. */
function runAfter(
  context: CommandContext,
  after: readonly RenderedStep[],
  cwd: string,
  env: { readonly env?: Readonly<Record<string, string>> },
  target: string,
): number {
  for (const [index, step] of after.entries()) {
    const result = context.seams.run(step.exe, step.argv, { cwd, ...env });
    relay(context, result.stdout, result.stderr);
    if (result.spawnFailed) {
      throw new ShuRefusal(
        EXIT_TOOL_NOT_INSTALLED,
        `after-step ${index + 1} of ${after.length} could not be started: '${step.exe}'. This repository's declaration names it under project.launch.${target}.after; install it, or put it on PATH.`,
      );
    }
    if (result.code !== 0) {
      context.io.err(
        `after-step ${index + 1} of ${after.length} failed: ${renderArgv(step)} -- exited ${result.code}. The build ran; getting it onto the device did not. nen exits 1 whatever the tool's own code was.`,
      );
      return 1;
    }
  }
  return 0;
}
