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

import { lstatSync, mkdirSync, writeFileSync, type Stats } from "node:fs";
import { dirname, relative, sep } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { containedPath, realContainment } from "../repo/contain.js";
import {
  DEFAULT_POLL_MS,
  PORT_PROBE_TIMEOUT_MS,
  ToolError,
  normalizeEol,
  type OutputWindow,
  type Seams,
  type StreamedChunk,
  type WatchVerdict,
} from "../seam/exec.js";
import type { DeviceReadiness, StallGuard } from "../schema/contract.js";
import { PROOF_VERB, proofRelativePath, removeProof, writeProof, type BuildProof } from "./proof.js";
import { EXIT_TOOL_NOT_INSTALLED, ShuRefusal } from "./exit.js";
import { openDeclaration } from "./declaration.js";
import {
  ASSERTABLE_KINDS,
  isLaunchTarget,
  LAUNCHING_VERBS,
  launchLane,
  refuseCrossVerbTarget,
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

/**
 * The stall guard on one step: what was declared, and what happened.
 *
 * BOTH HALVES IN ONE OBJECT, because the text rendering is derived from this
 * report (this file's rule) and a `--dry-run` prints the BUDGETS while a real
 * run prints the STRIKES. Two fields that could disagree about which guard was
 * in force is one field too many.
 *
 * `at[]` IS MILLISECONDS INTO THE STEP, not a wall clock: a strike is a fact
 * about how far into this run the build went quiet, and a timestamp would make
 * two runs of the same build incomparable.
 *
 * `stalled` IS THE VERDICT AND IT IS SEPARATE FROM `strikes`. Spending every
 * strike and recovering is the guard WORKING -- the remedy unwedged the build
 * and it went on to finish -- while `stalled` means the budgets were breached
 * again with no remedy left. A reader cannot tell those apart from a count.
 */
export interface ShuStallReport {
  readonly elapsedMs: number;
  readonly quietMs: number;
  readonly maxStrikes: number;
  /**
   * The declared remedy, as it would be spawned.
   *
   * `{exe, argv}` AND NOT A WHOLE `RenderedStep`: a remedy is not a step of the
   * invocation and carries none of a step's other declarations -- no guard of
   * its own (a guard on a guard is a loop) and no `stdoutTo` (nen relays what
   * the remedy said; a kill that matched nothing is a report, not a document to
   * file away).
   */
  readonly onStall: { readonly exe: string; readonly argv: readonly string[] };
  readonly strikes: number;
  /** Milliseconds into the step at which each remedy ran. */
  readonly at: readonly number[];
  readonly stalled: boolean;
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
  /** This step's stall guard, or null when it declares none. */
  readonly stall: ShuStallReport | null;
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
  /**
   * The build proof this run WROTE, or null.
   *
   * IT IS ON EVERY VERB'S REPORT, not only `build`'s, for the reason `target`
   * is: one family, one document shape, and a reader that had to know which
   * verbs carry the key would be reading a different contract per verb. Only
   * `build` ever fills it -- see ./proof.ts -- and it is null on a dry run, on
   * a red build, and on a green build whose proof could not be written (which
   * is a line on stderr, never a failed build).
   */
  readonly proof: BuildProof | null;
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
 *
 * BOTH OF THAT MODULE'S QUESTIONS ARE ASKED, AND THE SECOND IS THE ONE A TEXT
 * CANNOT ANSWER (zheref/nen#157). `containedPath` is lexical, so `build/payload`
 * passed it while `<root>/build` was a symlink to somewhere else entirely and
 * every line nen printed still said `build/payload` -- a check reporting clean
 * about a property it never tested, which is the failure mode this repository
 * refuses everywhere else. `realContainment` resolves the deepest EXISTING
 * ancestor through every link and compares the result against the REAL root, so
 * the answer is about the path the kernel would reach rather than about the
 * spelling. Asking it here settles every caller at once -- a lane's `cwd`, a
 * `path` precondition, a verb's `artifacts[i]`, a launch target's `artifact`, a
 * step's `stdoutTo`, the coverage and test reports read back after a run --
 * which is the shared-rather-than-copied posture the comment above argues for.
 *
 * IT IS A RUN-TIME CHECK, AND ONLY A RUN-TIME ONE. ../schema/contract.ts
 * contains no path when the declaration LOADS, by design: the loader has no
 * filesystem, so the only question it could answer is the lexical one it would
 * then have to answer again here, against a tree that may have changed since.
 * Pointers are checked at load; paths are checked at the moment of use.
 */
export function insideRepo(repoRoot: string, value: string, pointer: string): string {
  const absolute = containedPath(repoRoot, value);
  if (absolute === null) {
    throw new VerbUsageError(
      `${pointer} names '${value}', which resolves outside the repository at ${repoRoot}. Every path a declaration states is relative to the repository root, and nen will not step outside the tree --repo pointed it at.`,
    );
  }
  const containment = realContainment(repoRoot, absolute);
  if (!containment.contained) {
    // THE LINK IS NAMED, NOT JUST THE VERDICT. "outside the repository" about a
    // path that reads as plainly inside it is a sentence nobody can act on; the
    // ancestor that redirected it and where it points are the two facts that
    // turn the refusal into a fix. `?? absolute` is a belt only -- a lexically
    // contained path that fails the real test always has a link -- and it keeps
    // the sentence well-formed rather than printing `null`.
    throw new VerbUsageError(
      `${pointer} names '${value}', which really resolves to '${containment.real}', outside the repository at ${repoRoot}: '${containment.link ?? absolute}' is a symlink pointing at '${containment.target ?? containment.real}'. nen touches only what its report says it touches, so this path is refused rather than followed.`,
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
 * WHERE a readiness rule reads its value from, as one phrase.
 *
 * IT IS IN THE REFUSAL AND IN THE DRY RUN, which is the same sentence asked at
 * two moments: before the launch ("this is the state your device will have to
 * be in, and this is where nen will look for it") and at the refusal ("here is
 * what stood there instead"). A rule whose position the probe's output has no
 * shape for -- a `field` against a JSON document, a `path` against plain lines
 * -- reads nothing, and the phrase is what makes that legible rather than
 * mysterious: a reader who is told nen looked at "field 2 of the device's own
 * row" against output they can see is JSON has the whole diagnosis.
 */
function readWhere(rule: DeviceReadiness): string {
  // ASKED OF `path` RATHER THAN OF `field`, so the arm that reads a value is
  // the arm that proved it non-null. The loader admits exactly one of the two
  // (../schema/contract.ts's `parseReadyWhen`), so this is a fact rather than a
  // preference -- but a `?? ""` on the other side would be a fallback nothing
  // can reach, which is a branch no test can ever be written for.
  return rule.path !== null
    ? `'${rule.path}' on the device's own object`
    : `field ${rule.field} of the device's own row (counting from 1)`;
}

/**
 * WHICH OF THE PROBE'S TWO OUTPUT SHAPES the rule was written for.
 *
 * IN THE REFUSAL AND NOT IN THE DRY-RUN LINE, because it is the half a reader
 * only needs once something has gone wrong: a `path` rule against output they
 * can see is a list of lines reads nothing, and nen saying which shape it was
 * looking for is the whole diagnosis of a rule that never fires.
 */
function readShape(rule: DeviceReadiness): string {
  return rule.path === null ? "LINES" : "JSON";
}

/**
 * The `readiness:` line of a launch report, or nothing.
 *
 * PRINTED WHEREVER THE RULE EXISTS -- a dry run and a real one alike -- and
 * nowhere else, exactly as `proof` is. It is the DECLARATION's rule rather than
 * a reading, so it is knowable with no device connected at all, which is what
 * makes it worth printing beside a probe that has not run yet: the caller
 * approving a `--dry-run` can see which state the launch is going to insist on.
 */
function readinessNote(target: ResolvedLaunch): readonly string[] {
  const rule = target.device?.readyWhen ?? null;
  if (rule === null) return [];
  return [
    labelled(
      "readiness",
      `${readWhere(rule)} must be one of: ${rule.in.join(", ")}  (project.launch.${target.name}.device.readyWhen)`,
    ),
  ];
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
    // THE VALUE IS THE ONE A REAL RUN PASSES, not the one the file writes, and
    // on a lane whose `cwd` is not the repository root those are two different
    // strings. Both are printed when they differ: `<- ../build/App.app` answers
    // "what does the child receive", `(declared build/App.app ...)` answers
    // "which line of my file is this", and a reader needs to be able to get
    // from either to the other. They are the SAME string on a lane at the root,
    // and this line is then exactly what it has always been.
    /* c8 ignore next 2 -- `resolveLaunch` refuses {artifact} when the verb declares none AND the target overrides none, so each of these has a value here */
    const declared = target.artifact ?? artifact?.value ?? "(the verb declares none)";
    const passed = target.artifactAs ?? declared;
    // THE OVERRIDE IS NAMED AS AN OVERRIDE, not just printed. A reader checking
    // this line already knows the rule is "the verb's first artifact"; a path
    // that is not that one, printed with no explanation, reads as nen having
    // taken the wrong entry rather than as the declaration having said so.
    const notes = [
      ...(target.artifact === null
        ? []
        : [`project.launch.${target.name}.artifact, not the verb's own`]),
      ...(passed === declared
        ? []
        : [
            `declared ${declared}, as the after-steps' own directory sees it -- lane '${report.lane}' does not sit at the repository root`,
          ]),
    ];
    return `${ARTIFACT_TOKEN} <- ${passed}${notes.length === 0 ? "" : `  (${notes.join("; ")})`}`;
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
        }${
          // THE LANE, ONLY WHEN THE TARGET CHOSE IT. `lane:` two lines up
          // already carries the name; what it cannot say is whose decision it
          // was, and a cross-lane launch that looked like the caller's own
          // `--lane` is the one thing a reader of this report would misread.
          launch.lane === null ? "" : `  -- on lane '${launch.lane}', which this target declares`
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
      // DIRECTLY UNDER THE DEVICE IT QUALIFIES, because the two lines are one
      // fact split in two: the name is what nen looks for, the rule is what nen
      // requires of the row it finds. A reader who sees only the first would
      // read a green dry run as "this device will do", which is precisely the
      // reading the key exists to stop being available.
      for (const line of readinessNote(launch)) lines.push(line);
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
          ? step.stall?.stalled === true
            ? `${argv}${redirect}  -- STALLED, still running (nen stopped waiting)`
            : `${argv}${redirect}  -- did not start`
          : `${argv}${redirect}`;
    lines.push(labelled(verbPrefix, detail));
    // THE GUARD, UNDER THE STEP IT GUARDS, so a reader approving a `--dry-run`
    // sees the remedy beside the command it would be fired at rather than in a
    // block of its own further down.
    const stall = step.stall;
    if (stall !== null) {
      lines.push(
        labelled(
          "on stall",
          `after ${stall.elapsedMs}ms elapsed AND ${stall.quietMs}ms with no output: ${renderArgv(
            stall.onStall,
          )}  (up to ${stall.maxStrikes} time${stall.maxStrikes === 1 ? "" : "s"}${
            stall.strikes === 0
              ? ""
              : `; ran ${stall.strikes} at ${stall.at.map((at): string => `${at}ms`).join(", ")}`
          }${stall.stalled ? "; STALLED -- every remedy spent" : ""})`,
        ),
      );
    }
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
  // PRINTED ONLY WHERE THERE IS ONE, unlike every line above it. Ten of the
  // eleven executing verbs can never write a proof, and a `proof: (none)` row
  // on all of them would be a line about a thing that verb does not do.
  if (report.proof !== null) {
    lines.push(
      labelled(
        "proof",
        `${proofRelativePath(report.proof.lane)}  tree ${report.proof.treeHash} at ${report.proof.at}`,
      ),
    );
  }
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
  proof: BuildProof | null = null,
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
    proof,
  };
}

/**
 * A step nothing has run yet: where its stdout would go, the declared guard,
 * no strikes.
 *
 * ONE BUILDER FOR EVERY "nothing ran" PATH -- a dry run, the `deploy` gate, an
 * unmet precondition, the pre-flight before an interactive handover -- so a
 * `--dry-run` and a real run cannot render either of them differently.
 */
function plannedStep(step: RenderedStep, cwd: string): ShuStepReport {
  return {
    exe: step.exe,
    argv: step.argv,
    cwd,
    stdoutTo: step.stdoutTo?.path ?? null,
    exitCode: null,
    durationMs: null,
    stall: declaredStall(step),
  };
}

/** The guard a step declares, as a report with nothing having happened yet. */
function declaredStall(step: RenderedStep): ShuStallReport | null {
  const guard = step.stall ?? null;
  if (guard === null) return null;
  return {
    elapsedMs: guard.elapsedMs,
    quietMs: guard.quietMs,
    maxStrikes: guard.maxStrikes,
    onStall: guard.onStall,
    strikes: 0,
    at: [],
    stalled: false,
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
  // A TARGET DECLARED FOR THE OTHER LONG-RUNNING VERB IS REFUSED BEFORE THE
  // LANE'S OWN ROW IS EVEN READ, and the order is the fix rather than a
  // preference. `dev` and `run` are different builds and a target belongs to
  // one of them -- a fact about the declaration, true on every lane -- while a
  // seat is a fact about one row. Rendered first, the seat answered on any lane
  // where the other verb is `unsupported` or simply undeclared, so a caller who
  // named a `dev` target on `run` was told `'run' is unsupported on lane '<x>'`
  // (exit 4, and a dead end) while nen already held the sentence that ends it.
  // Everything else this function's contract says stays where it was: the seat
  // keeps exit 4 whenever the target's verb DOES match.
  if (LAUNCHING_VERBS.includes(options.verb)) {
    refuseCrossVerbTarget(project, options.verb, options.target);
  }
  // THE TARGET'S LANE IS READ BEFORE ANYTHING IS RENDERED, and that ordering is
  // the whole point of the key. Rendered on the invocation's lane first, a
  // target whose OWN lane is the only one declaring the verb was refused by the
  // lane it had explicitly overridden -- `lane 'web' declares no 'dev'`, exit 4,
  // sending the maintainer to fix a row the declaration had already routed
  // around, and leaving `--lane device` (the flag this key exists to make
  // unnecessary) as the only way through. `launchLane` answers null for every
  // case whose refusal must come first -- an undeclared target, a seated one,
  // one belonging to the other verb -- so those still speak in ./render.ts's own
  // words, on the lane the caller named.
  const declaredLane = LAUNCHING_VERBS.includes(options.verb)
    ? launchLane(project, options.verb, options.target)
    : null;
  const rendered = renderInvocation(project, {
    lane: declaredLane ?? options.lane,
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
      ? resolveLaunch(project, rendered, options.target, options.lane)
      : rendered;
  const cwd = insideRepo(repoRoot, plan.cwdRelative, `project.lanes.${plan.lane}.cwd`);
  // THE TARGET'S OWN ARTIFACT IS A PATH, SO IT IS HELD TO EVERY OTHER DECLARED
  // PATH'S RULE -- and it is checked HERE, before the dry-run report is emitted,
  // because a `--dry-run` that printed `install ../../etc/passwd` as the thing
  // it would run has already told a caller the declaration is fine. The rule
  // itself is ../repo/contain.ts's, shared rather than copied: a second
  // containment test is a second rule the day either one is widened.
  const declaredArtifact = launchOf(plan);
  if (declaredArtifact !== null && declaredArtifact.artifact !== null) {
    insideRepo(
      repoRoot,
      declaredArtifact.artifact,
      `project.launch.${declaredArtifact.name}.artifact`,
    );
  }
  const preconditions = await assertPreconditions(plan, repoRoot, context.seams);

  const unmet = preconditions.filter((entry): boolean => entry.satisfied !== true);
  if (unmet.length > 0) {
    // THE REPORT IS STILL EMITTED, with the failing rows in it. A caller
    // debugging "why will this not run" needs the table more here than
    // anywhere, and a refusal that printed only prose would make `--json`
    // useless in the one case it is most wanted.
    const steps = plannedSteps(plan).map(
      (step): ShuStepReport => plannedStep(step, cwd),
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
      (step): ShuStepReport => plannedStep(step, cwd),
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
  return await runCaptured(context, plan, cwd, repoRoot, preconditions, options.sink);
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
 *     line nen printed still said `nen/reports/coverage.json`. That half is no
 *     longer asked here: `insideRepo` above asks ../repo/contain.ts's
 *     `realContainment` for EVERY declared path (zheref/nen#157), so a second
 *     copy of the test in this function would be the copy that drifts the day
 *     either one is widened -- the exact argument its own comment makes.
 */
function refuseUnwritableRedirect(step: RenderedStep, repoRoot: string): void {
  if (step.stdoutTo === null) return;
  // THE POINTER IS THE STEP'S OWN, carried from ../shu/render.ts, because a
  // `{steps}` row states this key at `…steps[<i>].stdoutTo` and a `{exe, argv}`
  // row states it at `…stdoutTo` -- and a refusal naming a file position that
  // does not exist is a refusal a reader cannot act on.
  const { path: declared, pointer } = step.stdoutTo;
  const absolute = insideRepo(repoRoot, declared, pointer);
  // THE WALK IS UP THE PATH, NOT ONE `lstat` ON IT, and the reason is a
  // platform difference that a single stat cannot see. An ancestor directory
  // that is really a FILE makes this write certain to fail -- POSIX says so
  // loudly (`lstat` throws ENOTDIR), and Windows says the path is simply not
  // there (ENOENT, which `throwIfNoEntry: false` folds into "nothing here
  // yet"). Asking each ancestor in turn gives the same refusal on both, which
  // is the whole reason this repository's CI runs three of them.
  let probe = absolute;
  for (;;) {
    const entry = inspect(probe, declared, pointer);
    if (entry === undefined) {
      const parent = dirname(probe);
      /* c8 ignore next -- `insideRepo` has already proved this is under a root */
      if (parent === probe) return;
      probe = parent;
      continue;
    }
    if (probe === absolute) {
      if (!entry.isDirectory()) return;
      throw new VerbUsageError(
        `${pointer} names '${declared}', and a DIRECTORY is already there. nen writes this step's stdout to that path as a file; it will not remove a directory to make room for one, and discovering this after the tool had run would mean spending the whole build to learn it. Name a file, or move what is in the way.`,
      );
    }
    if (entry.isDirectory()) return;
    throw new VerbUsageError(
      `${pointer} names '${declared}', and '${relative(repoRoot, probe).split(sep).join("/")}' -- an ancestor of it -- is a FILE rather than a directory. nen creates the parent directories of the file it writes, and it cannot create one inside a file, so this write is refused before the tool runs rather than after it. Name a path whose ancestors are all directories, or move what is in the way.`,
    );
  }
}

/**
 * `lstat`, with "nothing there" as a value and every other errno as a refusal.
 *
 * TWO ERRNOS ARE AN ABSENCE, and the second is the one that matters here --
 * ../repo/contain.ts's own walk draws the same line for the same reason.
 * `throwIfNoEntry: false` folds ENOENT into `undefined` by itself; ENOTDIR is
 * folded in beside it, because it says an ANCESTOR of this path is a file,
 * which means this path is not there and the walk above must keep going up
 * until it reaches the ancestor that IS. Answering "cannot inspect" to that
 * would report the correct exit code with the wrong sentence -- and would say a
 * different sentence on Windows, where the same tree answers ENOENT.
 *
 * Everything else -- an EACCES on a parent, most often -- is certain to fail
 * the write a few steps later, and letting it escape would end the verb as a
 * stack trace rather than as this family's exit 2.
 */
function inspect(path: string, declared: string, pointer: string): Stats | undefined {
  try {
    return lstatSync(path, { throwIfNoEntry: false });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code ?? "an unknown error";
    if (code === "ENOTDIR" || code === "ENOENT") return undefined;
    /* c8 ignore next 4 -- an errno no test can produce on all three CI lanes */
    throw new VerbUsageError(
      `${pointer} names '${declared}', and nen cannot tell what is at '${path}': ${code}. This step's stdout is written there as a file, so a path nen cannot even inspect is one it will not promise to write to. Fix the path, or the permissions on it.`,
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
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, stdout, "utf8");
  } catch (error) {
    /* c8 ignore next 6 -- the pre-flight above refuses every shape it can see */
    // THE LAST RESORT, and it should be unreachable: `refuseUnwritableRedirect`
    // asked every question a filesystem can answer before the tool started. What
    // is left is a race -- something created a directory at this path while the
    // tool ran -- or a permission that changed under us, and either is worth a
    // sentence naming the declaration rather than a stack trace.
    const code = (error as NodeJS.ErrnoException).code ?? "an unknown error";
    throw new VerbUsageError(
      `${step.stdoutTo.pointer} names '${step.stdoutTo.path}', and writing this step's stdout there failed: ${code}. The tool ran and its output is lost. nen checked this path before starting it, so something changed on disk in between.`,
    );
  }
}

/**
 * Assemble whole LINES out of a watched child's chunks and relay them.
 *
 * A CHUNK IS NOT A LINE (../seam/exec.ts's `StreamedChunk`), so relaying each
 * one as it arrives would break a build's output across the terminal at
 * whatever byte the kernel happened to hand over. The remainder is flushed at
 * the end, because a tool whose last line carries no newline still said it.
 * EOL normalisation happens on the assembled text rather than per chunk, for
 * the reason the seam states: a `\r\n` can straddle two of them.
 */
function lineRelay(context: CommandContext): {
  chunk: (chunk: StreamedChunk) => void;
  flush: () => void;
} {
  const held: Record<StreamedChunk["stream"], string> = { stdout: "", stderr: "" };
  const write = (stream: StreamedChunk["stream"], line: string): void => {
    if (line === "") return;
    if (stream === "stderr") context.io.err(line);
    else (context.json ? context.io.err : context.io.out)(line);
  };
  return {
    chunk: (chunk): void => {
      const text = `${held[chunk.stream]}${chunk.text}`.replace(/\r\n/g, "\n");
      const lines = text.split("\n");
      held[chunk.stream] = lines.pop() ?? "";
      for (const line of lines) write(chunk.stream, line);
    },
    flush: (): void => {
      for (const stream of ["stdout", "stderr"] as const) {
        write(stream, held[stream]);
        held[stream] = "";
      }
    },
  };
}

/**
 * How often to look, derived from what the declaration asked for.
 *
 * A FIXED INTERVAL IS WRONG AT BOTH ENDS. The seam's default is five seconds,
 * which is right for a three-minute budget and useless for a one-second one --
 * a guard declared in hundreds of milliseconds would fire five seconds late, or
 * not at all on a step that finished in between. Half the SMALLER budget is the
 * coarsest interval that can still notice either of them crossing, and the
 * clamp keeps a tiny declaration from turning into a busy loop and a huge one
 * from being checked once an hour.
 */
function pollFor(guard: StallGuard): number {
  const half = Math.floor(Math.min(guard.quietMs, guard.elapsedMs) / 2);
  return Math.max(MIN_POLL_MS, Math.min(DEFAULT_POLL_MS, half));
}

/** Never busier than this, whatever a declaration asks for. */
const MIN_POLL_MS = 100;

/** What running one step answered, whichever seam it went through. */
interface StepOutcome {
  /** The tool's own code, or null when it never started or was abandoned. */
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  readonly spawnFailed: boolean;
  readonly stall: ShuStallReport | null;
}

/**
 * One WATCHED step: the streaming seam, with this repository's declared remedy
 * fired at the budgets it declared.
 *
 * THE RULE, AND IT IS THE OPERATIONAL CANON THIS EXISTS FOR, UNCHANGED: act
 * only when BOTH budgets are past -- total elapsed AND a quiet window -- because
 * a compile can legitimately go quiet early and the elapsed gate is the only
 * thing that tells a hung one from a healthy one. Each firing resets the quiet
 * window (the remedy needs a chance to take effect) and costs a strike.
 *
 * WHAT NEN DOES NOT DO, AT ANY STRIKE COUNT, is signal the child it started.
 * The declared remedy kills whatever the repository says to kill -- a wedged
 * grandchild -- and the build respawns it and carries on; killing the build
 * itself would throw away every object it has compiled so far, which is the one
 * thing the canon this implements says never to do. When every strike is spent
 * and the step is STILL silent, nen stops watching and stops WAITING (the seam's
 * `abandon`): the child is left running, untouched, the terminal comes back to
 * the caller, and the report says exactly that. Waiting instead would hang the
 * caller on the one path where hanging is what they came to be rescued from.
 */
async function runWatchedStep(
  context: CommandContext,
  step: RenderedStep,
  guard: StallGuard,
  cwd: string,
  env: { readonly env?: Readonly<Record<string, string>> },
  label: string,
  repoRoot: string,
): Promise<StepOutcome> {
  const relayer = lineRelay(context);
  const at: number[] = [];
  let stalled = false;
  // A REDIRECTED STEP'S STDOUT IS HELD, NOT RELAYED, and it is held as the RAW
  // chunks rather than as the lines the relayer would assemble: the file gets
  // the child's own bytes, with the one normalisation the captured seam already
  // applies (CRLF -> LF, over the joined text, because a `\r\n` can straddle two
  // chunks). Its stderr goes through the relayer as it always does -- that is
  // where a tool says what went wrong, and a watched step is exactly when a
  // reader is watching for it.
  const held: string[] = [];

  const onWindow = (window: OutputWindow): WatchVerdict => {
    if (window.elapsedMs < guard.elapsedMs || window.quietMs < guard.quietMs) return "watch";
    if (at.length >= guard.maxStrikes) {
      stalled = true;
      context.io.err(
        `${label} is STALLED: ${at.length} of ${guard.maxStrikes} declared remedies have run and it has still produced nothing for ${window.quietMs}ms (${window.elapsedMs}ms in). nen does not kill what it started, and will not wait on it either -- the process is STILL RUNNING and is yours to stop. What nen ran is this repository's own project.verbs declaration, nothing nen chose.`,
      );
      return "abandon";
    }
    at.push(window.elapsedMs);
    context.io.err(
      `${label} has produced no output for ${window.quietMs}ms and has been running ${window.elapsedMs}ms -- past this repository's declared budget (elapsedMs ${guard.elapsedMs}, quietMs ${guard.quietMs}). Running its declared remedy, strike ${at.length} of ${guard.maxStrikes}: ${renderArgv(guard.onStall)}`,
    );
    const remedy = context.seams.run(guard.onStall.exe, guard.onStall.argv, { cwd, ...env });
    if (remedy.spawnFailed) {
      // SAID LOUDLY AND NOT FATAL. The build is still running and may still
      // recover on its own; what has failed is the repository's own remedy,
      // which is a fact its maintainer needs and not a reason for nen to give
      // up on a process that has not failed.
      context.io.err(
        `the declared remedy could not be started: '${guard.onStall.exe}'. It is named under this repository's own stall block; install it, or put it on PATH. The step is still running and nen has changed nothing about it.`,
      );
    } else {
      // A NON-ZERO REMEDY IS NOT A FAILURE. The canonical remedy is a targeted
      // kill, and a kill that matched nothing exits non-zero -- which is the
      // ordinary answer when the wedged process is already gone. It is reported
      // and never acted on.
      relay(context, remedy.stdout, remedy.stderr);
    }
    return "reset";
  };

  const result = await context.seams.runStreamed(step.exe, step.argv, {
    cwd,
    ...env,
    onOutput: (chunk): void => {
      if (step.stdoutTo !== null && chunk.stream === "stdout") {
        held.push(chunk.text);
        return;
      }
      relayer.chunk(chunk);
    },
    onWindow,
    pollMs: pollFor(guard),
  });
  relayer.flush();
  // WRITTEN WHATEVER HAPPENED NEXT, exactly as the captured path writes it: a
  // step that was abandoned mid-flight still produced the bytes nen saw, and a
  // step that never STARTED produced none to write.
  if (!result.spawnFailed) writeRedirect(step, normalizeEol(held.join("")), repoRoot);

  const ran = !result.spawnFailed && !result.abandoned;
  return {
    exitCode: ran ? result.code : null,
    durationMs: ran ? result.durationMs : null,
    spawnFailed: result.spawnFailed,
    stall: {
      elapsedMs: guard.elapsedMs,
      quietMs: guard.quietMs,
      maxStrikes: guard.maxStrikes,
      onStall: guard.onStall,
      strikes: at.length,
      at,
      stalled,
    },
  };
}

/** One ORDINARY step: captured, as every step in this family always was. */
function runCapturedStep(
  context: CommandContext,
  step: RenderedStep,
  cwd: string,
  env: { readonly env?: Readonly<Record<string, string>> },
  repoRoot: string,
): StepOutcome {
  const stepStarted = context.seams.now().getTime();
  const result = context.seams.run(step.exe, step.argv, { cwd, ...env });
  const durationMs = context.seams.now().getTime() - stepStarted;
  // A REDIRECTED STEP'S STDOUT DOES NOT ALSO GO TO THE TERMINAL. That is what a
  // redirect MEANS everywhere a developer has met one, and printing the bytes
  // twice would bury the report under the very document the declaration asked
  // nen to file away. Its STDERR is relayed as it always was.
  relay(context, step.stdoutTo === null ? result.stdout : "", result.stderr);
  // WRITTEN WHATEVER THE TOOL EXITED, and before the exit code is read: a tool
  // that printed half a report and then failed leaves that half on disk, which
  // is what a redirect does and what a reader debugging the failure wants. A
  // step that never STARTED wrote nothing to write.
  if (!result.spawnFailed) writeRedirect(step, result.stdout, repoRoot);
  // `result.code` is MEANINGLESS on a spawn failure (../seam/exec.ts's own
  // words for it) -- typically -1, a value with no exit-code meaning at all --
  // and `durationMs` measured nothing since the process never started. Both
  // are reported `null`, the same value this report already uses everywhere
  // else for "nothing ran" (a dry run, an unreached step): one caller-visible
  // rule instead of a spawn-failure special case that leaks a sentinel number.
  return {
    exitCode: result.spawnFailed ? null : result.code,
    durationMs: result.spawnFailed ? null : durationMs,
    spawnFailed: result.spawnFailed,
    stall: null,
  };
}

async function runCaptured(
  context: CommandContext,
  plan: RenderedInvocation,
  cwd: string,
  repoRoot: string,
  preconditions: readonly AssertedPrecondition[],
  sink: ReportSink | undefined,
): Promise<number> {
  const started = context.seams.now().getTime();
  const steps: ShuStepReport[] = [];
  const env = Object.keys(plan.env).length === 0 ? {} : { env: plan.env };
  for (const [index, step] of plan.steps.entries()) {
    const label = `step ${index + 1} of ${plan.steps.length}`;
    const guard = step.stall ?? null;
    // TWO SEAMS, AND THE DECLARATION PICKS. A step with no guard goes through
    // the captured seam exactly as it always has -- same call, same buffering,
    // same output -- because watching a step nobody asked to have watched would
    // change the behaviour of every verb in this family to buy nothing.
    const outcome =
      guard === null
        ? runCapturedStep(context, step, cwd, env, repoRoot)
        : await runWatchedStep(context, step, guard, cwd, env, label, repoRoot);
    steps.push({
      exe: step.exe,
      argv: step.argv,
      cwd,
      stdoutTo: step.stdoutTo?.path ?? null,
      exitCode: outcome.exitCode,
      durationMs: outcome.durationMs,
      stall: outcome.stall,
    });

    if (outcome.spawnFailed) {
      // NOT exit 1. "the tool is not installed" and "the tool ran and said no"
      // want different reactions, and ../seam/exec.ts keeps them apart
      // precisely so a caller here does not have to guess.
      redBuild(context, plan, repoRoot);
      emitReport(
        context,
        sink,
        assemble(plan, cwd, repoRoot, preconditions, steps, EXIT_TOOL_NOT_INSTALLED, context.seams.now().getTime() - started, "streamed"),
      );
      throw new ShuRefusal(
        EXIT_TOOL_NOT_INSTALLED,
        `${label} could not be started: '${step.exe}'. This repository's declaration names it for '${plan.verb}' on lane '${plan.lane}'; install it, or put it on PATH. nen never installs a toolchain on a repository's say-so.`,
      );
    }
    if (outcome.stall?.stalled === true) {
      // A STALLED STEP IS EXIT 1, and it is not the child's verdict -- the child
      // has not given one and may never. The report carries the strikes, the
      // budgets and the fact that the process was left running; the sentence
      // that says so was printed by the watcher as it happened, because a
      // caller staring at a silent terminal needed it then rather than now.
      redBuild(context, plan, repoRoot);
      emitReport(
        context,
        sink,
        assemble(plan, cwd, repoRoot, preconditions, steps, 1, context.seams.now().getTime() - started, "streamed"),
      );
      context.io.err(
        `${label} stalled: ${renderArgv(step)} -- every one of the ${outcome.stall.maxStrikes} declared remedies ran and it went quiet again. nen exits 1; the step itself was never killed and has no exit code to report.`,
      );
      return 1;
    }
    if (outcome.exitCode !== 0) {
      redBuild(context, plan, repoRoot);
      emitReport(
        context,
        sink,
        assemble(plan, cwd, repoRoot, preconditions, steps, 1, context.seams.now().getTime() - started, "streamed"),
      );
      context.io.err(
        `${label} failed: ${renderArgv(step)} -- exited ${outcome.exitCode}. nen exits 1 whatever the tool's own code was; the tool's code is in the report above.`,
      );
      return 1;
    }
  }
  emitReport(
    context,
    sink,
    assemble(
      plan,
      cwd,
      repoRoot,
      preconditions,
      steps,
      0,
      context.seams.now().getTime() - started,
      "streamed",
      greenBuild(context, plan, repoRoot),
    ),
  );
  return 0;
}

/**
 * A green `build` writes its proof; every other verb writes nothing.
 *
 * A PROOF THAT COULD NOT BE WRITTEN IS A LINE ON STDERR AND NOT A FAILED BUILD.
 * The build IS green -- that is a fact about the build, and a read-only
 * filesystem, a git that will not start or a `.nen/` somebody made a file is a
 * fact about the machine. Turning the second into the first would make a
 * marker file able to fail a compile, which is exactly the trade
 * ../report/data.ts refuses in the other direction.
 */
function greenBuild(
  context: CommandContext,
  plan: RenderedInvocation,
  repoRoot: string,
): BuildProof | null {
  if (plan.verb !== PROOF_VERB) return null;
  try {
    return writeProof(context.seams, repoRoot, plan.lane);
  } catch (error) {
    context.io.err(
      `the build was green and its proof could not be written to ${proofRelativePath(plan.lane)}: ${
        error instanceof ToolError || error instanceof Error ? error.message : String(error)
      }. The build itself is unaffected; 'nen commit check --require-proof ${plan.lane}' will report that there is no proof.`,
    );
    return null;
  }
}

/**
 * A `build` that did NOT come out green removes any proof there was.
 *
 * A STALE PROOF IS WORSE THAN NONE. It is a green answer, in a file, to a
 * question that has since been asked again and answered red -- and every reader
 * of it (`nen commit check`, `nen report data`) would go on quoting yesterday's
 * verdict about a tree that no longer builds. Removing it is the only way the
 * file can keep meaning what it says.
 *
 * ONLY A BUILD THAT RAN. An unmet precondition or a refused flag never reaches
 * here: nothing was executed, so nothing was learned about this tree in either
 * direction, and an earlier proof is still exactly as true as it was.
 */
function redBuild(context: CommandContext, plan: RenderedInvocation, repoRoot: string): void {
  if (plan.verb !== PROOF_VERB) return;
  try {
    removeProof(repoRoot, plan.lane);
  } catch (error) {
    /* c8 ignore next 4 -- rmSync(force) raises only on a permission problem */
    context.io.err(
      `this lane's build proof could not be removed after a red build (${proofRelativePath(plan.lane)}): ${error instanceof Error ? error.message : String(error)}. Delete it by hand -- it now claims a green build for a tree that did not build.`,
    );
  }
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
    (step): ShuStepReport => plannedStep(step, cwd),
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
      // A DEVICE PROBE IS NEVER WATCHED. It belongs to a launch, and a launch
      // hangs off the two verbs ./render.ts's `STALL_GUARDED_VERBS` excludes.
      stall: null,
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

  // WHICH PATH, AND FROM WHERE, WERE BOTH DECIDED IN `resolveLaunch`. The
  // target's own artifact wins over the verb's first one -- "the first entry"
  // is the right answer for the thing a lane BUILDS and the wrong one for the
  // thing a device INSTALLS -- and whichever won is already expressed relative
  // to the directory these steps are about to be spawned in, which is the lane's
  // and not the repository root the declaration writes its paths against.
  // Substituting the declared string here handed the installer a path that
  // resolved against the wrong root on every lane whose `cwd` is not `.`.
  const after = substituteSteps(launch.after, { deviceId, artifact: launch.artifactAs });
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
          (step): ShuStepReport => plannedStep(step, cwd),
        ),
        ...after.map(
          (step): ShuStepReport => plannedStep(step, cwd),
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
  const lookup = findDevice(device.name, stdout, device.readyWhen);
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
  // PRESENT IS NOT READY, AND THIS IS WHERE THE TWO STOP BEING THE SAME ANSWER.
  // It comes BEFORE the missing-id refusal deliberately: a device whose state is
  // the reason it is unusable routinely prints a row carrying no id at all, and
  // "the probe gave nen no id" is then a true sentence that sends the reader to
  // look at the probe's output format when what they need is to answer the
  // prompt on the device's own screen.
  const rule = device.readyWhen;
  if (rule !== null && (lookup.readiness === null || !rule.in.includes(lookup.readiness))) {
    throw new ShuRefusal(
      EXIT_TOOL_NOT_INSTALLED,
      `the device '${device.name}' is ${
        lookup.readiness === null
          ? `on the probe's list and nen read no state for it: project.launch.${launch.name}.device.readyWhen looks at ${readWhere(rule)}, and nothing there carried a value`
          : `on the probe's list and its state is '${lookup.readiness}', which is not one project.launch.${launch.name}.device.readyWhen accepts`
      }. Accepted: ${rule.in.map((state): string => `'${state}'`).join(", ")} -- read from ${readWhere(rule)}, which is how nen reads a probe that prints ${readShape(rule)}. A device that is PRESENT is not a device that is READY: every step this launch would run next addresses it by id, and nen will not report the probe green and let each of them fail one at a time. ${
        // NO "IT SAW NOTHING" ARM HERE, unlike the absence refusal above: this
        // one is reached only when the probe DID name the device, so there is
        // always at least this device's own row to list.
        lookup.sawKind === "names"
          ? `The probe reported: ${lookup.saw.map((name): string => `'${name}'`).join(", ")}`
          : `The probe printed: ${lookup.saw.join(" | ")}`
      }. Get the device into one of the accepted states -- unlock it, answer its pairing prompt, wait for it to finish starting -- or, if this state IS usable here, add it to readyWhen.in.`,
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
