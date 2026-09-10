// src/schema/contract.ts -- `nen/contract.json`: what a repository needs FROM
// nen, and what nen needs to know ABOUT the repository.
//
// ONE FILE, TWO INDEPENDENT BLOCKS, and the reason they share a file is that
// "everything nen-related lives under `nen/`" is only a rule if it is true:
//
//   * `dependency` -- the pin. Which nen version this repository requires, the
//     ref its bootstrap installs, how to probe the installed one. zheref/hatsu
//     already ships this object, near enough, at its repository root -- but
//     "near enough" is not "verbatim", and the difference is the migration:
//     hatsu's root `nen.contract.json` ALREADY HAS a top-level `dependency`
//     key, with `bootstrap`, `install_paths`, `halt`, `no_improvised_fallback`
//     and `no_jq` sitting BESIDE it rather than inside it, and writes
//     `version_probe` as the string "nen --version". Moving that file here
//     unchanged is refused at `dependency.version_probe` (argv is a list here)
//     and then at `dependency.bootstrap` (absent, because it is a sibling).
//     The move is: keep the `dependency` key, pull `bootstrap` and its fellow
//     siblings INSIDE it -- where they are preserved verbatim as unknown keys
//     -- and write the probe as ["nen", "--version"].
//   * `project` -- the stack declaration. Lanes, per-lane verbs, the host
//     toolchain, preconditions nen ASSERTS and never performs.
//
// BOTH BLOCKS ARE OPTIONAL AND INDEPENDENT. A plugin repository carries
// `dependency` alone; a product repository that pins no nen version carries
// `project` alone. A verb that needs a block it does not find refuses by name --
// that refusal belongs to the verb, not to this loader.
//
// NOTHING IN NEN ACTS ON EITHER BLOCK YET (zheref/nen#108). This file parses and
// validates; no verb reads `project`, and nen never re-pins itself from
// `dependency` -- it never fetches a bootstrap, never compares its own version
// against the block, never exits on it. That stays the consumer's warm-up job,
// reading the file's literal values directly.
//
// A FILE WITH NEITHER BLOCK IS REFUSED, and that is a decision rather than an
// oversight. "Both blocks are optional" makes an EMPTY object formally legal and
// operationally useless -- no verb can ever read it -- while the shape that
// produces one in practice is a migration typo: a consumer moving a root
// contract here and forgetting to wrap the object in `dependency`, whose every
// key then lands at the top level, gets preserved as an unknown key, and
// validates silently. Refusing costs a repository nothing (delete the file, or
// add a block) and catches the one mistake that would otherwise ship a contract
// nen reads as blank.
//
// THIS GUARD IS NOT THE ONE THAT CATCHES HATSU. A document that already carries
// a `dependency` key sails past it and is caught, loudly and by pointer, inside
// the block instead -- which is the better refusal of the two, because it names
// the field. The empty-block guard is for the shape with no `dependency` key at
// all; both refusals exist because a contract nen cannot read is worse than no
// contract, whichever way it got that way.
//
// UNKNOWN KEYS ARE PRESERVED, NEVER REJECTED. `dependency` carries prose keys
// (`authority`, `zero_major_caveat`, `install_paths`, `halt`, `no_jq`) that are
// the consumer's own contract with its own agents; `verbs` carries whatever
// verbs an ecosystem already uses (`analyze`, `publish`, `codegen`, `tokens`,
// `storybook`, ...). A loader that rejected them would make this file nen's
// rather than the repository's. Every block therefore also carries its `raw`
// record, exactly as the file states it.
//
// A `$`-PREFIXED KEY IS METADATA (`$schema`, `$comment`), read by nobody and
// preserved by `raw` -- the same convention every loader in this family follows.

import {
  describeValue,
  optionalString,
  requireArray,
  requireRecord,
  requireString,
  SchemaError,
} from "./errors.js";
import { CONTRACT_FILE, readSchemaJson, type SchemaLocation } from "./source.js";

// ── the closed sets ─────────────────────────────────────────────────────────

/**
 * How `nen shu tools` will read a version out of a probe's output.
 *
 * DELIBERATELY NOT A REGEX. A caller-supplied regular expression is a
 * caller-supplied program: it is a ReDoS surface (the one ../schema/pattern.ts
 * exists to guard), and this family's whole discipline is that data stays data.
 * A declaration picks one of these four; an unknown value is refused here,
 * naming all four, rather than silently reading no version at all.
 */
export const VERSION_FROM = [
  "first-semver-on-stdout",
  "first-semver-on-stderr",
  "whole-line-stdout",
  "path-exists",
] as const;

export type VersionFrom = (typeof VERSION_FROM)[number];

/**
 * The installers nen implements, plus `verify-only` for every tool nen probes
 * and reports but will not install on someone's behalf.
 *
 * CLOSED, because an unknown id is a declaration asking for an install that
 * will never happen -- and a tool a repository believes nen manages, which nen
 * silently skips, is the failure mode this whole family is written against.
 */
export const INSTALLERS = [
  "verify-only",
  "corepack",
  "wrapper",
  "npx",
  "sdkmanager",
  "dotnet-install",
  "winget",
] as const;

export type Installer = (typeof INSTALLERS)[number];

/**
 * How `nen shu evidence` gets a changed snapshot in front of a human once it
 * has found one, in the repository's own words -- CLOSED for the same reason
 * `VERSION_FROM` is: an unknown mechanism is a declaration nothing downstream
 * has been built to honour, and refusing it here, by name, beats a skill
 * discovering that three steps further on.
 *
 *   * `public-mirror`  -- the KroApple convention (`ci_scripts/pr_screenshots.sh`):
 *     this repository is private, so the PNGs are pushed to a public sibling
 *     and referenced by a SHA-pinned raw URL. `nen shu evidence` never pushes
 *     anything itself -- it reports the rows a mirroring step would need.
 *   * `files-changed`  -- the repository is already public (or the images are
 *     not meant to render inline at all): the changed-file list IS the
 *     evidence, with no host to push to.
 *   * `embedded`       -- the PNGs are small enough to carry as data URIs
 *     directly in a generated report, with no external host at all.
 */
export const EVIDENCE_MECHANISMS = ["public-mirror", "files-changed", "embedded"] as const;

export type EvidenceMechanism = (typeof EVIDENCE_MECHANISMS)[number];

/**
 * What a `port` precondition says about the port -- CLOSED, and REQUIRED on
 * every row of that kind.
 *
 * THERE IS NO DEFAULT DIRECTION, and that is why this is a declared field
 * rather than an inference. Both facts are preconditions of real builds: an
 * end-to-end suite needs the app's server ALREADY LISTENING, and a dev server
 * needs its port FREE or it will not bind. Guessing which one a declaration
 * meant would let nen refuse a machine that is in exactly the state the
 * repository asked for.
 */
export const PORT_EXPECTATIONS = ["listening", "free"] as const;

export type PortExpectation = (typeof PORT_EXPECTATIONS)[number];

/** The highest port number there is. A declaration outside 1..this is refused. */
const MAX_PORT = 65_535;

// ── the two blocks ──────────────────────────────────────────────────────────

export interface BootstrapPin {
  /** Where the bootstrap script is fetched from. */
  readonly url: string;
  /** Where that same script lives inside nen's own source tree. */
  readonly scriptPathInSource: string;
  /** The object exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface DependencyBlock {
  /** `MAJOR.MINOR`. What the range means is the repository's own prose. */
  readonly minimum: string;
  /** The ref the bootstrap installs when the contract is unsatisfied. */
  readonly pinnedRef: string;
  /** Argv, never a string -- a string form is one `sh -c` away from a shell. */
  readonly versionProbe: readonly string[];
  readonly bootstrap: BootstrapPin;
  readonly name: string | null;
  readonly source: string | null;
  readonly repository: string | null;
  /** The block exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface Lane {
  readonly name: string;
  readonly stack: string;
  /** Repo-relative working directory for every verb in this lane. */
  readonly cwd: string;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * `stall` -- what nen does about a step that stops making progress, in the
 * repository's own words.
 *
 * NEN NEVER KNOWS WHAT TO KILL, AND THIS BLOCK IS WHY IT DOES NOT HAVE TO.
 * Some toolchains hang: a compiler process wedges, the build stops emitting
 * anything and never finishes, and the fix is to kill the wedged GRANDCHILD and
 * let the build respawn it. Which process that is, and how it is named, is
 * knowledge about a toolchain -- exactly the knowledge ../shu/run.ts and
 * ../shu/render.ts are forbidden to carry. So the repository declares the
 * remedy as an ordinary argv (`onStall`), nen runs it through the same seam
 * every other declared step goes through, and nen's own contribution is the two
 * numbers that decide WHEN.
 *
 * BOTH BUDGETS, NEVER ONE, and that is the whole discipline of the thing: a
 * guard that acted on silence alone would fire at a healthy build that
 * legitimately went quiet early on. `elapsedMs` is how long the step has been
 * running; `quietMs` is how long it has produced no output; the remedy runs only
 * once BOTH are past. Both are required and both are positive integers -- a
 * default for either would be nen deciding what "too long" means for somebody
 * else's build.
 *
 * `maxStrikes` IS HOW MANY TIMES THE REMEDY MAY RUN, defaulting to 2, because a
 * guard with no ceiling is a loop. Nen never kills the child it started, at any
 * strike count: see ../shu/run.ts.
 */
export interface StallGuard {
  readonly elapsedMs: number;
  readonly quietMs: number;
  /** The repository's own remedy. Argv, never a string: there is no shell. */
  readonly onStall: { readonly exe: string; readonly argv: readonly string[] };
  readonly maxStrikes: number;
  readonly raw: Readonly<Record<string, unknown>>;
}

/** One step of a `steps` invocation, with its own optional stall guard. */
export interface InvocationStep {
  readonly exe: string;
  readonly argv: readonly string[];
  /** This step's own guard, or null -- the invocation's applies otherwise. */
  readonly stall: StallGuard | null;
  /**
   * Where this step's stdout goes, or null.
   *
   * `stdoutTo` IS THE ANSWER TO A SHELL THIS FAMILY DOES NOT HAVE. There is no
   * `sh -c` anywhere on this path -- an argv is a list, always -- so a tool that
   * PRINTS the thing nen needs to read had, until this key, nowhere to put it:
   * the bundled Apple profile's own coverage row extracts a JSON report to
   * stdout, and `nen shu coverage` parses a FILE. A declaration naming
   * `stdoutTo` says "write this step's stdout there", and nen writes the bytes
   * itself. No shell, no redirection operator, no second process: the seam
   * already captures the child's stdout, and this is where those bytes land.
   *
   * `null` IS THE ORDINARY CASE and means what it always meant -- the step's
   * output is relayed to the terminal as it finishes.
   */
  readonly stdoutTo: string | null;
}

export type Invocation =
  | {
      readonly kind: "command";
      readonly exe: string;
      readonly argv: readonly string[];
      readonly stall: StallGuard | null;
      /** Repo-relative file this invocation's stdout is written to, or null. */
      readonly stdoutTo: string | null;
      readonly why: string | null;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "steps";
      readonly steps: readonly InvocationStep[];
      /** The guard every step of this invocation runs under, or null. */
      readonly stall: StallGuard | null;
      readonly why: string | null;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "unsupported";
      /** The repository's own sentence saying why. Never nen's. */
      readonly reason: string;
      readonly raw: Readonly<Record<string, unknown>>;
    };

export interface ToolchainEntry {
  readonly tool: string;
  /** The pin. Required: nen never installs "latest". */
  readonly version: string;
  readonly probe: readonly string[];
  readonly versionFrom: VersionFrom;
  readonly installer: Installer;
  readonly why: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface Precondition {
  /** The repository's own word for what is being asserted. Not a closed set. */
  readonly kind: string;
  /** A path, a port NUMBER, or an argv list -- whichever the kind means. */
  readonly value: string | number | readonly string[];
  /**
   * Which way round a `port` row is asserted, or null on every other kind.
   *
   * IT LIVES ON THE ROW RATHER THAN IN THE KIND (`port-free`, `port-listening`)
   * so that one kind reads one value: a reader asking "which port" finds
   * `value` whichever direction the row wanted, and a later kind that needs a
   * direction of its own has a field to use rather than a naming convention to
   * copy.
   */
  readonly expect: PortExpectation | null;
  readonly why: string | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * One DEPLOY DESTINATION, by the name `--target` takes.
 *
 * WHY THIS IS THE SMALLEST SHAPE, AND WHY IT IS NOT AN INVOCATION. The command
 * a deploy runs lives where every other verb's command lives --
 * `project.verbs.<lane>.deploy` -- and this map says WHERE that command sends
 * it. A second invocation here would be a second place a deploy argv can come
 * from, and a lane row that is silently ignored for one target and honoured for
 * another is the failure mode this family least wants: the one verb whose blast
 * radius is other people's users must have exactly one command, in one place,
 * that a reader can find.
 *
 * So a target contributes three things and nothing else:
 *
 *   * `args` -- appended to the lane's declared `deploy` argv, in order. This
 *     is the whole of what "which destination" means on a command line for the
 *     shapes the inventory found (a `--prod` flag; a branch name), and it is
 *     APPEND-ONLY because nen composes nothing it cannot print: the resolved
 *     argv is one concatenation a `--dry-run` shows in full. A row with more
 *     than one step plus a target that appends is refused at the executor
 *     rather than resolved here -- "which step reaches the destination" is a
 *     guess, and nen does not make one.
 *   * `requiresEnv` -- variable NAMES this destination needs SET. nen asserts
 *     them exactly as it asserts a `preconditions` entry of kind `env`: the
 *     name is checked, the VALUE is never read, compared, logged or printed.
 *     A credential belongs in the environment; a declaration that carried one
 *     would put it in git.
 *   * `unsupported` -- the destination that has no command line at all. Two of
 *     the seven repositories the inventory read deploy through a hosting
 *     provider's git integration or a CI action, and the honest rendering of
 *     that is a sentence, not an invented command. It refuses at exit 4 with
 *     the repository's own words, exactly as an `unsupported` verb row does.
 */
export interface DeployTarget {
  readonly name: string;
  /** Appended to the lane's declared `deploy` argv, in order. Never an exe. */
  readonly args: readonly string[];
  /** Variable NAMES that must be SET. Values are never read or printed. */
  readonly requiresEnv: readonly string[];
  /** This destination has no command line at all, in the repo's own words. */
  readonly unsupported: string | null;
  readonly why: string | null;
  /** The entry exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * `project.evidence` -- what `nen shu evidence` filters a changed-file set
 * against, and how a later step gets one of the survivors in front of a human.
 *
 * A PROJECT-LEVEL BLOCK, NOT A PER-LANE ONE, on the same reasoning `targets`
 * already carries: a snapshot test suite is not scoped to a lane's own build
 * the way `verbs` and `preconditions` are, and a repository whose iOS lane and
 * Android lane both record snapshots wants one glob set matched against the
 * WHOLE diff, not two lanes each asking half the question.
 */
export interface EvidenceBlock {
  /**
   * The glob patterns a changed path is matched against (`*`, `**`, `?` --
   * ../shu/evidence/glob.ts). REQUIRED, and non-empty: a block that named no
   * glob would match nothing on every run and report an always-empty result,
   * which is a repository that meant to declare evidence and typed nothing --
   * refused rather than let stand as an evidence gate that is quietly always
   * satisfied.
   */
  readonly globs: readonly string[];
  readonly mechanism: EvidenceMechanism;
  /**
   * The template a later, mirroring step renders `{suite}` and `{scene}`
   * into to name one surviving row -- the KroApple convention's own
   * `scene_of()` returns exactly this, joined. `nen shu evidence` itself
   * reports `suite` and `scene` SEPARATELY (its `rows[]` shape), so this
   * template is read by nobody in THIS release; it is validated and carried
   * on `raw` for the mirroring step this design defers.
   */
  readonly scene: string;
  /** The suffix stripped off an ancestor directory's name to name a suite. */
  readonly suiteSuffix: string;
  /** The block exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * The two verbs a launch target may hang off. CLOSED, and the same list
 * ../shu/render.ts's `LAUNCH_VERBS` re-exports for the executor.
 *
 * A launch target says "start THIS lane's long-running verb, on THIS device,
 * and then do these things". The only two long-running verbs are `dev` and
 * `run` (../shu/run.ts's `INTERACTIVE_VERBS`), and a target naming any other
 * one is a declaration nen could honour only by inventing what "launch a lint"
 * would mean. Refused here, by pointer, naming both.
 */
export const LAUNCH_VERBS = ["dev", "run"] as const;

export type LaunchVerb = (typeof LAUNCH_VERBS)[number];

/**
 * The DEVICE a launch target puts the build on, and how nen finds its id.
 *
 * `name` IS THE WHOLE MATCH, and it is the repository's own string: the name a
 * developer reads in their own device list. Nen never guesses a device, so
 * there is no "the only one connected" fallback and no prefix matching -- a
 * name the probe's output does not carry is a refusal listing what the probe
 * DID see, which is the one answer a reader can act on.
 *
 * `resolve` IS AN ORDINARY DECLARED STEP -- `{exe, argv}`, spawned through the
 * same seam every other step goes through. Nen does not know what a device
 * probe is called on any platform, and ../shu/purity.test.ts is what keeps
 * that true: the probe is the repository's argv, never nen's.
 *
 * `kind` IS THE REPOSITORY'S OWN WORD and is not a closed set, with exactly one
 * value nen reads: `simulator`. A simulated device has no id to look up -- its
 * NAME is how the toolchain addresses it -- so `{"name": "...", "kind":
 * "simulator"}` with no probe resolves to the name itself and spawns nothing.
 * Every other kind without a probe is refused: nen will not invent an id.
 *
 * `readyWhen` IS THE DIFFERENCE BETWEEN PRESENT AND READY. See DeviceReadiness.
 */
export interface LaunchDevice {
  readonly name: string;
  /** The repository's own word. `simulator` is the one value nen reads. */
  readonly kind: string | null;
  /** The declared probe whose output carries the id, or null. */
  readonly resolve: { readonly exe: string; readonly argv: readonly string[] } | null;
  /** Which of the probe's own states count as ready, or null for "any". */
  readonly readyWhen: DeviceReadiness | null;
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * WHICH OF A PROBE'S OWN STATES COUNT AS READY -- the one fact a name match
 * cannot carry, and the one that decides whether every later step addresses a
 * device that will answer it.
 *
 * A DEVICE LIST IS NOT A LIST OF USABLE DEVICES. The same row that says a
 * handset is attached also says whether the pairing prompt on its screen has
 * been accepted, whether it is locked, whether it is still booting. Matching the
 * NAME answers "is it plugged in"; the state beside the name answers "will it
 * take a build". Without this key nen read the first and reported it as the
 * second, so a launch resolved an id, printed exit 0 at the probe, and every
 * command after it failed against a device that was never going to answer.
 *
 * TWO SHAPES, BECAUSE A PROBE'S OUTPUT IS ONE OF TWO SHAPES (../shu/launch.ts):
 *
 *   * `{"field": <n>, "in": [...]}` for a probe that prints LINES. `field` is a
 *     whitespace-separated position on the device's own row, counted FROM ONE
 *     the way every column-oriented tool on a terminal counts them -- field 1 is
 *     the first token, which on the ordinary two-column device listing is the
 *     name itself and on a wider one is whatever the row leads with.
 *   * `{"path": "<key>", "in": [...]}` for a probe that prints JSON. `path` is
 *     read off the object whose own `name` matched, dotted for a nested one
 *     (`connection.state`), and -- exactly as the ID is -- off an enclosing
 *     object when the matched one does not carry it, because the shape the
 *     larger toolchains print puts the name in one sub-object and the state in
 *     its sibling.
 *
 * EXACTLY ONE OF THE TWO, and `in` is required beside it: a rule naming both
 * positions would have nen choose which to read from a document it has not seen
 * yet, and a rule naming neither, or accepting nothing, is a key with no effect
 * dressed as a safety check. All four refusals are at LOAD, by pointer.
 *
 * THE VALUES ARE COMPARED AS STRINGS, verbatim -- no case fold, no trimming
 * beyond the whitespace split -- for `device.name`'s reason: the state words are
 * the probe's own vocabulary, and nen deciding that two spellings mean the same
 * thing is nen guessing about somebody else's device. A JSON `true` or `3` at
 * the named path is rendered and compared as `"true"` and `"3"`, so a boolean
 * readiness flag is declarable without a second shape.
 */
export interface DeviceReadiness {
  /** A whitespace-separated position on the matched line, counted from 1. */
  readonly field: number | null;
  /** A dotted key path read off the matched JSON object. */
  readonly path: string | null;
  /** The states that count as ready. Non-empty; compared as whole strings. */
  readonly in: readonly string[];
  readonly raw: Readonly<Record<string, unknown>>;
}

/**
 * One LAUNCH TARGET, by the name `nen shu dev|run --target` takes.
 *
 * WHY THIS IS A SEPARATE BLOCK FROM `targets`. A deploy target says WHERE a
 * build goes; a launch target says WHICH DEVICE a local run lands on, and what
 * has to happen once the build exists to get it there. They share neither
 * their keys nor their verbs, and folding them into one map would mean
 * `--target production` on `dev` resolving to something -- a destination on a
 * verb that sends nothing. Two blocks, two vocabularies, and a `--target` that
 * names the wrong one is refused listing the right one.
 *
 * WHAT A TARGET CONTRIBUTES, AND NOTHING ELSE:
 *
 *   * `verb` -- which of the two long-running verbs this target launches
 *     through. REQUIRED, because `dev` and `run` are different builds (debug
 *     against production) and a target that did not say which would leave nen
 *     guessing what the developer is holding.
 *   * `lane` -- which lane that verb is read from, when it is not the one the
 *     invocation already resolved. OPTIONAL, and absent means the lane
 *     `--lane` named or, with no flag, `project.defaultLane`. It exists because
 *     A DEVICE BUILD IS ROUTINELY A DIFFERENT LANE FROM THE ONE A DEVELOPER
 *     ITERATES IN: the simulator build and the device-destination build are two
 *     declared rows with two argvs and two artifact sets, and a launch target
 *     that could not say which lane it belongs to would install whatever the
 *     default lane happened to produce. Refused here when it names no declared
 *     lane, by pointer -- the same rule `project.defaultLane` gets.
 *   * `args` -- appended to that verb's declared argv, in order, exactly as a
 *     deploy target's `args` are, and refused on a multi-step row for the same
 *     reason: which step reaches the device is not nen's guess.
 *   * `artifact` -- the repo-relative path `{artifact}` stands for, INSTEAD OF
 *     the first entry of the verb's own `artifacts`. OPTIONAL, and absent
 *     leaves that rule exactly as it was. It exists because "the first
 *     artifact" is the right answer for the thing a lane BUILDS and the wrong
 *     one for the thing a device INSTALLS -- a build routinely produces both,
 *     in that order -- and the alternative is writing the path literally into
 *     every after-step, where it stops being a fact the declaration states
 *     once. It is a path, so it is refused outside the tree (../shu/run.ts's
 *     `insideRepo`, which is where a repository root exists to compare it
 *     against), and the shape refusals -- a non-string, an empty string -- are
 *     here.
 *   * `device` -- the device, and how to find its id. See LaunchDevice.
 *   * `after` -- the steps that run once the verb exits, each an ordinary
 *     `{exe, argv}` in which `{device.id}` and `{artifact}` are substituted.
 *     They are the repository's own commands: nen knows no install command and
 *     no launch command for any platform.
 *   * `unsupported` -- this target has no command line at all, in the
 *     repository's own sentence, answered at exit 4 exactly as an unsupported
 *     verb row is.
 */
export interface LaunchTarget {
  readonly name: string;
  /** Which long-running verb this target launches through. */
  readonly verb: LaunchVerb | null;
  /**
   * The lane that verb is read from, or null for "the one already resolved".
   * A declared lane, always -- `parseLaunch` refuses one that is not.
   */
  readonly lane: string | null;
  /** Appended to that verb's declared argv, in order. Never an exe. */
  readonly args: readonly string[];
  /**
   * What `{artifact}` stands for, repo-relative, or null for the verb's own
   * first `artifacts` entry.
   */
  readonly artifact: string | null;
  readonly device: LaunchDevice | null;
  /** Steps run after the verb exits. `{device.id}`/`{artifact}` substituted. */
  readonly after: readonly { readonly exe: string; readonly argv: readonly string[] }[];
  /** This target has no command line at all, in the repo's own words. */
  readonly unsupported: string | null;
  readonly why: string | null;
  /** The entry exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface ProjectBlock {
  /** The review stack recorded for this repo, for cross-checking the registry. */
  readonly scenario: string | null;
  readonly lanes: Readonly<Record<string, Lane>>;
  /** `null` is legal and means `--lane` is required. */
  readonly defaultLane: string | null;
  readonly verbs: Readonly<Record<string, Readonly<Record<string, Invocation>>>>;
  readonly toolchain: Readonly<Record<string, ToolchainEntry>>;
  readonly preconditions: Readonly<Record<string, readonly Precondition[]>>;
  /** Shapes nen does not yet read, preserved verbatim. */
  readonly profiles: Readonly<Record<string, unknown>>;
  /** The deploy destinations `--target` names. No default, ever. */
  readonly targets: Readonly<Record<string, DeployTarget>>;
  /**
   * The launch targets `dev`/`run`'s own `--target` names. No default, ever --
   * and, unlike `deploy`'s, no REQUIREMENT either: `nen shu dev` with no
   * `--target` runs the lane's declared `dev` exactly as it always has. An
   * empty map is the ordinary state of a repository that has not declared any.
   */
  readonly launch: Readonly<Record<string, LaunchTarget>>;
  /** Per-verb allowlist of `process.platform` values; `*` means every verb. */
  readonly hosts: Readonly<Record<string, readonly string[]>>;
  /** `nen shu evidence`'s glob/mechanism declaration. `null` when absent. */
  readonly evidence: EvidenceBlock | null;
  /** The block exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

export interface RepositoryContract {
  /** Absolute path of the file this was read from. */
  readonly path: string;
  /**
   * Which of `nen/` and `schemas/` answered. Always `nen` for this file: the
   * contract has no legacy location, because no released nen ever read one.
   */
  readonly location: SchemaLocation;
  readonly schema: string | null;
  readonly dependency: DependencyBlock | null;
  readonly project: ProjectBlock | null;
  /** The document exactly as the file states it, every key preserved. */
  readonly raw: Readonly<Record<string, unknown>>;
}

// ── readers ─────────────────────────────────────────────────────────────────

// An argv list, with the two ways it is usually got wrong named separately: a
// string (the shell form this family refuses) and an empty list (a probe that
// runs nothing and reports no version).
//
// EXPORTED FOR THE PROFILES PACK (zheref/nen#111), and the three readers below
// -- `requireArgv`, `requireEnum` and `parseInvocation` -- are exported for the
// same one reason: the bundled pack states the SAME shapes this file validates,
// in a different file, and a second copy of these rules is a second set of rules.
// The pack's loader imports them rather than restating them, so a shape this
// loader tightens tightens there too. Nothing else changed: the callers inside
// this file are unaffected, and the pack passes its OWN path and pointers.
export function requireArgv(path: string, pointer: string, value: unknown): readonly string[] {
  if (typeof value === "string") {
    throw new SchemaError(
      path,
      pointer,
      `expected an argv ARRAY, got the string ${JSON.stringify(value)}. Argv is a list everywhere in this family -- ["nen", "--version"], not "nen --version" -- because a string form is one 'sh -c' away from a shell`,
    );
  }
  if (!Array.isArray(value)) {
    throw new SchemaError(
      path,
      pointer,
      `expected an argv array, got ${describeValue(value)}`,
    );
  }
  if (value.length === 0) {
    throw new SchemaError(path, pointer, "expected an argv array with at least the program name, got an empty array");
  }
  return value.map((item, index): string => requireString(path, `${pointer}[${index}]`, item));
}

/**
 * A path that would be read as a GLOB by something downstream, or as a step
 * OUTSIDE the tree. `stdoutTo` is refused for either at LOAD.
 *
 * WHY AT LOAD AND NOT AT THE WRITE. A `stdoutTo` of `../../etc/hosts` or of
 * `reports/*.json` is not a run that fails; it is a declaration that can never
 * be honoured, and the run that discovers it is the run that has already
 * spawned the tool whose output was going there. The two shapes checked here
 * are the two a reader cannot see:
 *
 *   * an ESCAPE -- an absolute path, or one with a `..` segment in it. This is
 *     the lexical half of ../repo/contain.ts's question, asked where there is
 *     no repository root to resolve against; ../shu/run.ts asks the REAL half
 *     (symlinks resolved) again before it writes, because a `nen/` symlinked
 *     out of the tree makes a perfectly innocent-looking path land elsewhere.
 *   * a GLOB -- `*`, `?` or a `[...]` class. nen expands nothing: the path is
 *     used verbatim, so `reports/*.json` would create a file with a literal
 *     asterisk in its name and every later reader would look for the expansion
 *     instead. `project.evidence.globs` is where a pattern belongs.
 */
const STDOUT_TO_GLOB = /[*?[\]]/;

/** An absolute path, in either family's spelling, plus the Windows drive form. */
const ABSOLUTE_PATH = /^(?:[\\/]|[A-Za-z]:[\\/])/;

/**
 * One `stdoutTo` value, checked. Exported for the profiles pack's own loader,
 * which states the same key in a different file: a second copy of this rule
 * would be a second rule.
 */
export function requireStdoutTo(path: string, pointer: string, value: unknown): string {
  const text = requireString(path, pointer, value);
  if (text.trim() === "") {
    throw new SchemaError(
      path,
      pointer,
      "is empty. It names the repo-relative FILE this step's stdout is written to; a step that wanted its output on the terminal states no 'stdoutTo' at all",
    );
  }
  if (ABSOLUTE_PATH.test(text)) {
    throw new SchemaError(
      path,
      pointer,
      `names '${text}', which is an ABSOLUTE path. Every path a declaration states is relative to the repository root, and nen will not write outside the tree '--repo' pointed it at -- least of all on a path a repository could change without the person running the verb seeing it`,
    );
  }
  if (text.split(/[\\/]/).includes("..")) {
    throw new SchemaError(
      path,
      pointer,
      `names '${text}', which climbs out of the repository with '..'. Every path a declaration states is relative to the repository root, and nen will not write outside the tree '--repo' pointed it at`,
    );
  }
  if (STDOUT_TO_GLOB.test(text)) {
    throw new SchemaError(
      path,
      pointer,
      `names '${text}', which carries a glob character ('*', '?' or a '[...]' class). nen expands nothing here: the path is used verbatim, so this would create one file with that character literally in its name and every later reader would go looking for the expansion. State the one file this step's stdout goes to`,
    );
  }
  return text;
}

export function requireEnum<T extends string>(
  path: string,
  pointer: string,
  value: unknown,
  allowed: readonly T[],
): T {
  const text = requireString(path, pointer, value);
  if (!(allowed as readonly string[]).includes(text)) {
    throw new SchemaError(
      path,
      pointer,
      `'${text}' is not one nen implements. It is one of a CLOSED set: ${allowed.join(", ")}`,
    );
  }
  return text as T;
}

/**
 * THE SHAPE A TOOL NAME MAY TAKE, and why a KEY is validated at all.
 *
 * Every other rule in this loader is about a value; this one is about a map
 * key, because this particular key does not stay in the file. `nen shu tools
 * --install` renders `<tool>@<version>` into the one argv it is allowed to
 * spawn, and `--only <name>` matches against it. A key of `--all` therefore
 * becomes an ARGUMENT to the installer rather than a package to prepare, and a
 * key carrying whitespace or an `@` splits into something the installer reads
 * as two things. There is no shell anywhere on that path -- an argv is a list,
 * always -- so this is not an injection into a command line; it is an injection
 * into the ARGUMENT LIST, which is the one nen builds itself.
 *
 * REFUSED AT LOAD, in the loader, rather than at the point of use. The pin
 * belongs to the declaration and so does its name, and a repository whose
 * `project.toolchain` cannot be acted on should hear so when the file is read
 * -- once, by pointer -- rather than from whichever verb happens to reach it
 * first. It is also the only way a name reaches the pack's loader under the
 * same rule: `nen shu detect` copies a pack entry into a proposed declaration,
 * and a name THIS loader would refuse would make that proposal unreadable by
 * the very program that wrote it.
 *
 * THE SHAPE IS npm's, WIDENED FOR CASE and NARROWED AT THE FIRST CHARACTER: an
 * optional `@scope/`, then a name of letters, digits, `.`, `_`, `~` and `-`
 * that may not START with `-`, `.` or `_`. That refuses a flag, a path
 * traversal, a bare `@`, a space and every shell metacharacter, and accepts
 * every real toolchain name in the bundled pack (`dotnet-sdk`, `expo-cli`,
 * `visual-studio`, `placeholder-jdk`) plus the scoped form a package manager
 * pins.
 */
const TOOL_NAME = /^(?:@[A-Za-z0-9~][A-Za-z0-9._~-]*\/)?[A-Za-z0-9~][A-Za-z0-9._~-]*$/;

/**
 * What an environment variable NAME may be, and the one place the rule lives.
 *
 * IT IS A SHELL IDENTIFIER, WHICH IS WHAT `process.env` KEYS ACTUALLY ARE: a
 * letter or `_`, then letters, digits and `_`. Two blocks in this schema name
 * variables nen then asserts are SET -- `project.preconditions.<lane>[]` of
 * kind `env`, and `project.targets.<name>.requiresEnv` -- and neither has any
 * way to be satisfied by a name a shell could not export. `path=evil`,
 * `--flag`, `A B`, `1ABC` and `lower-case` are each a row that is guaranteed to
 * report FAIL for as long as the declaration says it, which is a refusal
 * disguised as a check: nen would tell a maintainer their environment is wrong
 * about a variable no environment could ever carry.
 *
 * SHARED WITH `nen scaffold init`, whose `--marker-env` asks the same question
 * of a name a FLAG states (../scaffold/command.ts). One rule, one regex: a
 * second copy is a second rule, and the two would drift the first time either
 * is widened.
 */
export const ENV_VAR_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** One environment variable NAME a declaration states, checked. */
function requireEnvName(path: string, pointer: string, name: string): string {
  if (ENV_VAR_NAME.test(name)) return name;
  throw new SchemaError(
    path,
    pointer,
    `'${name}' is not a name an environment variable can have. nen asserts that this NAME is set -- it never reads, compares or prints the value -- and a name outside a shell identifier ([A-Za-z_][A-Za-z0-9_]*) can never be set at all, so the row could only ever report FAIL. State the variable's name alone: not 'NAME=value', not a flag, not a path`,
  );
}

/**
 * One `toolchain` key, checked. Exported for the profiles pack's own loader,
 * which states the same block in a different file: a second copy of this rule
 * would be a second rule.
 */
export function requireToolName(path: string, block: string, name: string): string {
  if (TOOL_NAME.test(name)) return name;
  throw new SchemaError(
    path,
    `${block}.${name}`,
    `'${name}' is not a tool name nen can act on. A name becomes part of the argument list an installer is given ('<tool>@<version>'), so it is held to npm's package-name shape: an optional '@scope/', then letters, digits, '.', '_', '~' or '-', not starting with '-', '.' or '_'. A leading dash would be read as a FLAG by the program nen spawns, and whitespace or a second '@' splits one argument into something else`,
  );
}

function parseBootstrap(path: string, value: unknown): BootstrapPin {
  const raw = requireRecord(path, "dependency.bootstrap", value);
  return {
    url: requireString(path, "dependency.bootstrap.url", raw["url"]),
    scriptPathInSource: requireString(
      path,
      "dependency.bootstrap.script_path_in_source",
      raw["script_path_in_source"],
    ),
    raw,
  };
}

export function parseDependencyBlock(path: string, value: unknown): DependencyBlock {
  const raw = requireRecord(path, "dependency", value);
  return {
    minimum: requireString(path, "dependency.minimum", raw["minimum"]),
    pinnedRef: requireString(path, "dependency.pinned_ref", raw["pinned_ref"]),
    versionProbe: requireArgv(path, "dependency.version_probe", raw["version_probe"]),
    bootstrap: parseBootstrap(path, raw["bootstrap"]),
    name: optionalString(path, "dependency.name", raw["name"]),
    source: optionalString(path, "dependency.source", raw["source"]),
    repository: optionalString(path, "dependency.repository", raw["repository"]),
    raw,
  };
}

function parseLanes(path: string, value: unknown): Record<string, Lane> {
  const record = requireRecord(path, "project.lanes", value);
  const lanes: Record<string, Lane> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const pointer = `project.lanes.${name}`;
    const raw = requireRecord(path, pointer, entry);
    lanes[name] = {
      name,
      stack: requireString(path, `${pointer}.stack`, raw["stack"]),
      cwd: requireString(path, `${pointer}.cwd`, raw["cwd"]),
      raw,
    };
  }
  if (Object.keys(lanes).length === 0) {
    throw new SchemaError(
      path,
      "project.lanes",
      "declares no lane. A project block exists to say which lanes this repository has; an empty map says nothing any verb can run against",
    );
  }
  return lanes;
}

// A lane a block names must be a lane the block DECLARED. A `verbs` key or a
// `defaultLane` naming a lane that does not exist is a typo whose only symptom
// would otherwise be a verb that is silently unavailable -- the same class of
// hole as gates.json's approver naming an undeclared reviewer.
function requireDeclaredLane(
  path: string,
  pointer: string,
  lane: string,
  lanes: Readonly<Record<string, Lane>>,
): void {
  if (Object.prototype.hasOwnProperty.call(lanes, lane)) return;
  throw new SchemaError(
    path,
    pointer,
    `names lane '${lane}', which is not declared under project.lanes (declared: ${
      Object.keys(lanes).join(", ") || "(none)"
    })`,
  );
}

/** The keys a `stall` block reads. Everything else there is a near-miss risk. */
const STALL_KEYS: readonly string[] = ["elapsedMs", "quietMs", "onStall", "maxStrikes"];

/** How many times a declared remedy may run when the declaration says nothing. */
export const DEFAULT_MAX_STRIKES = 2;

/**
 * A positive whole number of milliseconds, or a refusal by pointer.
 *
 * ZERO IS REFUSED ALONG WITH THE NEGATIVES, and it is the one worth stating: a
 * `quietMs` of 0 is a guard that fires on the first tick of every build, and a
 * `elapsedMs` of 0 removes the half of the rule that tells a hung compile apart
 * from a quiet one. A budget that cannot mean what it says is a defect in the
 * declaration, not a number to round up.
 */
function requirePositiveInteger(
  path: string,
  pointer: string,
  value: unknown,
  unit: string,
  // THE SUBJECT IS THE CALLER'S, for `refuseNearMissKey`'s reason: the rule is
  // one rule, and a message about a "stall budget" read by somebody debugging a
  // device readiness rule names a block their file does not carry.
  subject = "A stall budget",
): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new SchemaError(
      path,
      pointer,
      `expected a POSITIVE whole number of ${unit}, got ${describeValue(value)}. ${subject} nen could not act on -- zero, a fraction, a negative, a string -- is a declaration nen refuses rather than rounds`,
    );
  }
  return value;
}

/**
 * `stall`, wherever an invocation or one of its steps declares one.
 *
 * VALIDATED AT LOAD, BY POINTER, rather than where it is acted on: a budget
 * this loader let through is a budget nen would discover it could not read
 * halfway into somebody's build, with a child already running.
 */
export function parseStall(path: string, pointer: string, value: unknown): StallGuard | null {
  if (value === undefined || value === null) return null;
  const raw = requireRecord(path, pointer, value);
  refuseNearMissKey(
    path,
    pointer,
    raw,
    STALL_KEYS,
    "A stall guard",
    (meant): string => `the step would run with '${meant}' silently unset`,
  );
  return {
    elapsedMs: requirePositiveInteger(path, `${pointer}.elapsedMs`, raw["elapsedMs"], "milliseconds"),
    quietMs: requirePositiveInteger(path, `${pointer}.quietMs`, raw["quietMs"], "milliseconds"),
    // AN ARGV INVOCATION, EXACTLY LIKE EVERY OTHER DECLARED STEP -- `{exe,
    // argv}`, parsed by the same reader, so a remedy written as a string
    // ("pkill -9 …") is refused with the same sentence a verb's argv would get.
    // Nen has no shell to hand it to.
    onStall: parseStep(path, `${pointer}.onStall`, raw["onStall"]),
    maxStrikes:
      raw["maxStrikes"] === undefined || raw["maxStrikes"] === null
        ? DEFAULT_MAX_STRIKES
        : requirePositiveInteger(path, `${pointer}.maxStrikes`, raw["maxStrikes"], "runs"),
    raw,
  };
}

export function parseInvocation(path: string, pointer: string, value: unknown): Invocation {
  const raw = requireRecord(path, pointer, value);
  const hasUnsupported = raw["unsupported"] !== undefined;
  const hasSteps = raw["steps"] !== undefined;
  const hasExe = raw["exe"] !== undefined;
  const declared = [hasUnsupported, hasSteps, hasExe].filter(Boolean).length;
  if (declared === 0) {
    throw new SchemaError(
      path,
      pointer,
      `expected one of 'exe' (with 'argv'), 'steps', or 'unsupported', got ${describeValue(value)}`,
    );
  }
  if (declared > 1) {
    throw new SchemaError(
      path,
      pointer,
      "declares more than one of 'exe', 'steps' and 'unsupported'. A verb has exactly one form, and guessing which one wins is not this loader's to do",
    );
  }
  const why = optionalString(path, `${pointer}.why`, raw["why"]);
  if (hasUnsupported) {
    return {
      kind: "unsupported",
      // The SENTENCE is required, not just the flag: "unsupported" without a
      // reason is a refusal a reader cannot act on, and the reason is always
      // the repository's own, never nen's.
      reason: requireString(path, `${pointer}.unsupported`, raw["unsupported"]),
      raw,
    };
  }
  if (hasSteps) {
    const steps = raw["steps"];
    if (!Array.isArray(steps)) {
      throw new SchemaError(path, `${pointer}.steps`, `expected an array, got ${describeValue(steps)}`);
    }
    if (steps.length === 0) {
      throw new SchemaError(path, `${pointer}.steps`, "expected at least one step, got an empty array");
    }
    return {
      kind: "steps",
      steps: steps.map((step, index): InvocationStep => {
        const at = `${pointer}.steps[${index}]`;
        const record = requireRecord(path, at, step);
        return {
          exe: requireString(path, `${at}.exe`, record["exe"]),
          argv: requireArgv(path, `${at}.argv`, record["argv"]),
          // A STEP MAY CARRY ITS OWN GUARD, and the invocation's applies to the
          // ones that do not. A multi-step row is routinely one slow compile
          // and three fast bookkeeping commands, and giving the fast ones the
          // compile's budget would be declaring a guard that can never fire.
          stall: parseStall(path, `${at}.stall`, record["stall"]),
          stdoutTo: optionalStdoutTo(path, `${at}.stdoutTo`, record["stdoutTo"]),
        };
      }),
      stall: parseStall(path, `${pointer}.stall`, raw["stall"]),
      why,
      raw,
    };
  }
  return {
    kind: "command",
    exe: requireString(path, `${pointer}.exe`, raw["exe"]),
    argv: requireArgv(path, `${pointer}.argv`, raw["argv"]),
    stall: parseStall(path, `${pointer}.stall`, raw["stall"]),
    stdoutTo: optionalStdoutTo(path, `${pointer}.stdoutTo`, raw["stdoutTo"]),
    why,
    raw,
  };
}

/** `stdoutTo` where the key is optional: absent and `null` both mean "no file". */
function optionalStdoutTo(path: string, pointer: string, value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requireStdoutTo(path, pointer, value);
}

function parseVerbs(
  path: string,
  value: unknown,
  lanes: Readonly<Record<string, Lane>>,
): Record<string, Record<string, Invocation>> {
  const record = requireRecord(path, "project.verbs", value);
  const verbs: Record<string, Record<string, Invocation>> = {};
  for (const [lane, entry] of Object.entries(record)) {
    if (lane.startsWith("$")) continue;
    const pointer = `project.verbs.${lane}`;
    requireDeclaredLane(path, pointer, lane, lanes);
    const perLane = requireRecord(path, pointer, entry);
    const parsed: Record<string, Invocation> = {};
    for (const [verb, invocation] of Object.entries(perLane)) {
      if (verb.startsWith("$")) continue;
      // UNKNOWN VERB NAMES ARE PRESERVED, NOT REJECTED. The ecosystem already
      // uses `analyze`, `publish`, `codegen`, `tokens`, `storybook`,
      // `resume:pdf`; a closed verb list here would make this file nen's.
      parsed[verb] = parseInvocation(path, `${pointer}.${verb}`, invocation);
    }
    // EMPTY IS REFUSED AT BOTH LEVELS, exactly as `project.lanes` refuses it,
    // and for the same reason: `$`-prefixed metadata is skipped above, so a map
    // holding only a `$comment` is empty here even though the file looks
    // populated -- and `{}` after the filter is a declaration that says nothing.
    // `parseProjectBlock` already refuses an ABSENT `verbs` with a sentence
    // about a stack nothing can be run against; `{}` and `{"web": {}}` are that
    // same file with the same consequence, and were passing.
    if (Object.keys(parsed).length === 0) {
      throw new SchemaError(
        path,
        pointer,
        `declares no verb for lane '${lane}'. A lane listed under project.verbs is a lane something can be run in; state its verbs, using {"unsupported": "<why>"} for the ones it genuinely has none of, or drop the lane from project.verbs entirely`,
      );
    }
    verbs[lane] = parsed;
  }
  if (Object.keys(verbs).length === 0) {
    throw new SchemaError(
      path,
      "project.verbs",
      'declares no lane. A project block exists to say what this repository can be asked to run; an empty verb map declares a stack nothing can be run against. State the verbs per lane, using {"unsupported": "<why>"} for the ones this repository genuinely has none of',
    );
  }
  return verbs;
}

function parseToolchain(path: string, value: unknown): Record<string, ToolchainEntry> {
  const record = requireRecord(path, "project.toolchain", value);
  const toolchain: Record<string, ToolchainEntry> = {};
  for (const [tool, entry] of Object.entries(record)) {
    if (tool.startsWith("$")) continue;
    requireToolName(path, "project.toolchain", tool);
    const pointer = `project.toolchain.${tool}`;
    const raw = requireRecord(path, pointer, entry);
    // `version` IS REQUIRED, and its absence is a refusal rather than a
    // defaulted "latest": an unpinned install is how a pinned toolchain stops
    // being one, and an entry that cannot say what it wants is an entry nen
    // must not act on.
    if (raw["version"] === undefined) {
      throw new SchemaError(
        path,
        `${pointer}.version`,
        `expected a version pin, got nothing (the field is absent). Every toolchain entry states its version: nen never installs or certifies "latest", because an unpinned toolchain is the thing a pin exists to prevent. Use "verify-only" as the installer if nen should only report what is on the host`,
      );
    }
    toolchain[tool] = {
      tool,
      version: requireString(path, `${pointer}.version`, raw["version"]),
      probe: requireArgv(path, `${pointer}.probe`, raw["probe"]),
      versionFrom: requireEnum(path, `${pointer}.versionFrom`, raw["versionFrom"], VERSION_FROM),
      installer: requireEnum(path, `${pointer}.installer`, raw["installer"], INSTALLERS),
      why: optionalString(path, `${pointer}.why`, raw["why"]),
      raw,
    };
  }
  return toolchain;
}

/**
 * One `port` precondition's value: a whole number in 1..65535, as a NUMBER.
 *
 * A STRING IS REFUSED RATHER THAN COERCED, and the refusal names the fix. A
 * port is a number in every other file a developer writes it in, `"3000"` and
 * `3000` are two different JSON values, and a loader that quietly read the
 * first as the second would be guessing on behalf of a declaration that could
 * just as easily have meant a service name. `0` is refused with the rest:
 * connecting to port 0 is not a question about a port at all.
 */
function requirePort(path: string, pointer: string, value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1 || value > MAX_PORT) {
    throw new SchemaError(
      path,
      pointer,
      `expected a port NUMBER between 1 and ${MAX_PORT}, got ${describeValue(value)}. Write it as a JSON number -- 3000, not "3000" -- because nen opens a TCP connection to 127.0.0.1 on it and a value it has to guess at is a check that could never honestly pass`,
    );
  }
  return value;
}

/** `expect` -- required on a `port` row, refused on every other kind. */
function parseExpect(
  path: string,
  at: string,
  kind: string,
  value: unknown,
): PortExpectation | null {
  if (kind !== "port") {
    if (value === undefined || value === null) return null;
    throw new SchemaError(
      path,
      `${at}.expect`,
      `is stated on a precondition of kind '${kind}', and nen reads 'expect' on 'port' rows alone (${PORT_EXPECTATIONS.join(", ")}). Preserved as an unknown key it would be read by nobody, so this row would assert something other than what it plainly says. Drop the key, or state the kind that uses it`,
    );
  }
  if (value === undefined || value === null) {
    throw new SchemaError(
      path,
      `${at}.expect`,
      `expected one of ${PORT_EXPECTATIONS.join(", ")}, got nothing (the field is absent). A port precondition says which way round it is asserted, and nen will not pick: 'listening' is satisfied when the connection is accepted, 'free' when it is refused, and both are real preconditions of real builds`,
    );
  }
  return requireEnum(path, `${at}.expect`, value, PORT_EXPECTATIONS);
}

function parsePreconditions(
  path: string,
  value: unknown,
  lanes: Readonly<Record<string, Lane>>,
): Record<string, readonly Precondition[]> {
  const record = requireRecord(path, "project.preconditions", value);
  const out: Record<string, readonly Precondition[]> = {};
  for (const [lane, entry] of Object.entries(record)) {
    if (lane.startsWith("$")) continue;
    const pointer = `project.preconditions.${lane}`;
    requireDeclaredLane(path, pointer, lane, lanes);
    if (!Array.isArray(entry)) {
      throw new SchemaError(path, pointer, `expected an array, got ${describeValue(entry)}`);
    }
    out[lane] = entry.map((item, index): Precondition => {
      const at = `${pointer}[${index}]`;
      const raw = requireRecord(path, at, item);
      const rawValue = raw["value"];
      // `kind` is the repository's own word and is NOT a closed set here: nen
      // acts on three of them and a declaration may state a fourth this release
      // reports as "cannot assert", and closing the enum would refuse a
      // repository for stating a true fact about itself. What IS checked is the
      // SHAPE of the value -- a path, a port number, or an argv list -- which
      // is read from the kind, because those are the shapes an assertion can be
      // written against.
      const kind = requireString(path, `${at}.kind`, raw["kind"]);
      const parsedValue: string | number | readonly string[] = Array.isArray(rawValue)
        ? requireArgv(path, `${at}.value`, rawValue)
        : kind === "port"
          ? requirePort(path, `${at}.value`, rawValue)
          : requireString(path, `${at}.value`, rawValue);
      // THE TWO KINDS WHOSE VALUE THIS LOADER CAN CHECK, and it checks them
      // here rather than at the assertion for the reason every other shape in
      // this file is refused at load: a `{"kind": "env", "value": "PATH=evil"}`
      // row is not a check that fails, it is a check that CANNOT pass, and a
      // repository learns that on the run that loads the file rather than on
      // the run that was about to deploy. A LIST value is left alone -- the
      // executor already reports an assertable kind given a list as "cannot
      // assert" rather than guessing which element was meant.
      if (kind === "env" && typeof parsedValue === "string") {
        requireEnvName(path, `${at}.value`, parsedValue);
      }
      return {
        kind,
        value: parsedValue,
        // `expect` IS REQUIRED ON A `port` ROW AND REFUSED ON EVERY OTHER,
        // rather than merely ignored elsewhere: a key nen reads on one kind and
        // silently drops on another is a key a maintainer will eventually write
        // on the wrong row and never hear about. A LIST-valued port row is
        // still held to it -- the executor reports that row as "cannot assert",
        // and a row that cannot say which direction it meant is a second thing
        // wrong with it rather than a reason to stop asking.
        expect: parseExpect(path, at, kind, raw["expect"]),
        why: optionalString(path, `${at}.why`, raw["why"]),
        raw,
      };
    });
  }
  return out;
}

/**
 * The platform names a `hosts` allowlist may contain: `process.platform`'s
 * values for the three targets `bun build --compile` publishes a binary for.
 *
 * CLOSED, AND THAT IS THE POINT. `hosts` is an ALLOWLIST -- a verb runs when
 * `process.platform` is in it -- so a typo does not fail loudly, it silently
 * removes the verb from every host on earth. `"macos"`, `"windows"` and
 * `"osx"` are all things a person writes and none of them is a value
 * `process.platform` ever returns. Refusing them at the seam is the only place
 * the mistake is visible; a run that "correctly" skipped a verb is not.
 */
export const HOST_PLATFORMS = ["darwin", "linux", "win32"] as const;

/**
 * Read a per-verb `hosts` allowlist. ONE IMPLEMENTATION, TWO CALLERS: the
 * declaration's `project.hosts` and the profiles pack's `hosts` (src/profiles/
 * pack.ts) state the same shape, and a second copy of these rules would be a
 * second set of rules that drift toward whichever file was edited last. The
 * pointer PREFIX is the only difference, so it is the only parameter.
 *
 * The pack wraps this to add the two refusals a CATALOGUE needs and a
 * declaration does not (an empty list, an empty map); both are stated there,
 * next to the reason they are catalogue rules.
 */
export function parseHosts(
  path: string,
  pointer: string,
  value: unknown,
): Record<string, readonly string[]> {
  const record = requireRecord(path, pointer, value);
  const hosts: Record<string, readonly string[]> = {};
  for (const [verb, entry] of Object.entries(record)) {
    if (verb.startsWith("$")) continue;
    const at = `${pointer}.${verb}`;
    if (!Array.isArray(entry)) {
      throw new SchemaError(path, at, `expected an array of platform names, got ${describeValue(entry)}`);
    }
    hosts[verb] = entry.map((item, index): string =>
      requireEnum(path, `${at}[${index}]`, item, HOST_PLATFORMS),
    );
  }
  return hosts;
}

function optionalRecord(
  path: string,
  pointer: string,
  value: unknown,
): Readonly<Record<string, unknown>> {
  if (value === undefined || value === null) return {};
  return requireRecord(path, pointer, value);
}

/** A list of strings, or an empty list when the key is absent. */
function optionalStrings(path: string, pointer: string, value: unknown): readonly string[] {
  if (value === undefined || value === null) return [];
  return requireArray(path, pointer, value).map((item, index): string =>
    requireString(path, `${pointer}[${index}]`, item),
  );
}

/** The four keys `project.targets.<name>` is made of. Nen's, not the repo's. */
const TARGET_KEYS: readonly string[] = ["args", "requiresEnv", "unsupported", "why"];

/**
 * The eight keys `project.launch.<name>` is made of.
 *
 * `lane` AND `artifact` JOINING THE SET IS WHAT MAKES `lanes` AND `artifacts`
 * REFUSALS, and that is the point of adding them here rather than reading them
 * off `raw`: an English plural is exactly the misspelling `refuseNearMissKey`
 * exists for, and a `"artifacts": ["..."]` on a launch target would otherwise be
 * preserved, read by nobody, and install the verb's first artifact while the
 * file plainly names another one.
 */
const LAUNCH_KEYS: readonly string[] = [
  "verb",
  "lane",
  "args",
  "artifact",
  "device",
  "after",
  "unsupported",
  "why",
];

/** The four keys `project.launch.<name>.device` is made of. */
const DEVICE_KEYS: readonly string[] = ["name", "kind", "resolve", "readyWhen"];

/** The three keys a `readyWhen` rule is made of. Two positions and a set. */
const READY_KEYS: readonly string[] = ["field", "path", "in"];

/**
 * True when one insertion, deletion or substitution turns `a` into `b`.
 *
 * BOUNDED AT ONE ON PURPOSE, rather than a full edit distance with a threshold.
 * Distance 1 is the typo a human makes and a reader does not see -- a dropped
 * letter (`arg`, `requireEnv`), a doubled one, a case slip (`Args`), an
 * adjacent-key slip (`whx`) -- and it is short enough that no real, deliberate
 * key falls inside it: `host`, `region`, `branch`, `url` and every other field
 * a repository might legitimately park here are three or more edits away from
 * all four names. Widening the radius would start refusing keys somebody meant.
 *
 * EXPORTED FOR ./workflow.ts, which applies the same rule to the closed key
 * sets `nen/workflow.json`'s blocks are made of. The RULE is shared, for the
 * reason `requireArgv` and `parseHosts` are shared: a second copy is a second
 * rule the day either is widened. Each file keeps its OWN refusal SENTENCE,
 * because a message naming the wrong block is a message a reader cannot act on.
 */
export function withinOneEdit(a: string, b: string): boolean {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1) return false;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  let i = 0;
  let j = 0;
  let edited = false;
  while (i < shorter.length && j < longer.length) {
    if (shorter[i] === longer[j]) {
      i += 1;
      j += 1;
      continue;
    }
    if (edited) return false;
    edited = true;
    // Same length: the mismatch is a substitution, so both walk on. Different
    // lengths: it is an insertion in the longer string, so only that one does.
    if (shorter.length === longer.length) i += 1;
    j += 1;
  }
  return true;
}

/**
 * How `key` misspells `known`, IN WORDS, or null when it does not.
 *
 * IT RETURNS THE SENTENCE RATHER THAN A BOOLEAN, and that is the whole reason
 * this function is shaped the way it is. The rule catches three shapes, and a
 * refusal that described all three as "one letter away" would be WRONG about
 * two of them -- a maintainer told that `WHY` is one letter from `why`, or that
 * `launches` is one letter from `launch`, is being handed a false clue about
 * their own file while they are trying to fix it. So the phrase is decided
 * where the match is decided, and there is no way to add a fourth shape without
 * writing the words for it.
 *
 * THE THREE SHAPES, AND EACH ONE IS A TYPO A REVIEWER'S EYE SLIDES OVER:
 *
 *   * a CASE SLIP of any width -- `WHY`, `Launch`, `Device`. Checked FIRST,
 *     because it is the strongest claim: the key is the same word. Three
 *     substitutions is outside the distance radius below and is still the same
 *     word, and a JSON key is case-sensitive everywhere in this family;
 *   * distance 1 -- `arg`, `requireEnv`, `Args`, `resolver`, `verbs`. Checked
 *     SECOND, so a one-letter plural (`verbs`, `devices`) is reported as the
 *     letter it is rather than as a grammatical form nobody was thinking about;
 *   * an ENGLISH PLURAL two letters out -- `launches`. That is the one key this
 *     whole block is about and the distance rule alone let it through: a
 *     `"launches": { … }` block would be preserved verbatim, read by nobody,
 *     and `--target` would answer "this repository declares no launch targets"
 *     about a file that plainly declares four.
 */
function nearMissOf(key: string, known: string): string | null {
  const lower = key.toLowerCase();
  const target = known.toLowerCase();
  if (lower === target) return `differs from '${known}' only in case`;
  if (withinOneEdit(key, known)) return `is one letter away from '${known}'`;
  if (lower.replace(/(?:es|s)$/, "") === target.replace(/(?:es|s)$/, "")) {
    return `is '${known}' with an English plural on it`;
  }
  return null;
}

/**
 * A key that is one typo away from a KNOWN set, refused by the name it meant.
 *
 * THIS IS THE HALF THAT WAS MISSING, and the header below promised it. Refusing
 * a wrong TYPE catches `"args": "--prod"`; it does not catch `"arg": ["--prod"]`,
 * which is a perfectly-shaped list under a key nothing reads -- so the flag was
 * accepted, the destination's arguments were not appended, and a DIFFERENT
 * command deployed while nen printed exit 0. That is the exact silence this
 * block was parsed to prevent, and a key nobody reads cannot produce it loudly.
 *
 * UNKNOWN KEYS ARE STILL PRESERVED, which is this schema's convention
 * everywhere and is not in tension with the above: `{"host": "a"}`,
 * `{"region": "eu"}` and `{"$note": "..."}` are keys a repository MEANT, kept
 * verbatim on `raw` for a later release to read. The line between the two is
 * `nearMissOf` above -- close enough that no reader would spot the difference,
 * far enough that nothing deliberate lands there.
 *
 * GENERALISED OVER THE KNOWN SET rather than hard-coded to `project.targets`'
 * four, because FOUR blocks now have keys nen acts on: a deploy target's four,
 * a launch target's six, a launch device's three, and `project.evidence`'s
 * four. One rule, four call sites; a second copy would be a second rule that
 * drifts the first time any one of them widens.
 *
 * `describeConsequence` is the one thing that legitimately differs between the
 * callers -- what a silently-dropped key actually BREAKS -- so it is the
 * caller's own sentence rather than a guess this function makes about a block
 * it does not otherwise know. It DEFAULTS to the sentence that is true of any
 * entry whose keys are read straight into an invocation, which is what both
 * launch blocks want and what this function said before it took callers that
 * break differently.
 */
function refuseNearMissKey(
  path: string,
  pointer: string,
  raw: Readonly<Record<string, unknown>>,
  knownKeys: readonly string[],
  subject: string,
  describeConsequence: (meant: string) => string = (meant): string =>
    `this entry would run with '${meant}' silently unset`,
): void {
  for (const key of Object.keys(raw)) {
    if (key.startsWith("$") || knownKeys.includes(key)) continue;
    const meant = knownKeys.find((known): boolean => nearMissOf(key, known) !== null);
    if (meant === undefined) continue;
    throw new SchemaError(
      path,
      `${pointer}.${key}`,
      `${nearMissOf(key, meant) ?? ""}, which IS a key nen reads, and is not itself one. ${subject}'s keys are ${knownKeys.join(
        ", ",
      )}; every OTHER key is preserved verbatim for a later release, and that is exactly why this one cannot be: '${key}' would be kept, read by nobody, and ${describeConsequence(meant)}. Fix the spelling, or rename the key to something that is not a near-miss of one of ${subject}'s keys`,
    );
  }
}

/**
 * `project.targets` -- the deploy destinations, PARSED rather than preserved.
 *
 * IT USED TO BE AN OPAQUE RECORD, and everything nen did with it was ask
 * whether a key existed. That was honest while nothing read the values; the
 * moment a target contributes arguments to a spawned argv and environment
 * NAMES to an assertion, an unparsed map means a typo reaches a deploy as
 * SILENCE -- the flag was accepted, the destination's arguments were not
 * appended, and the command that ran is a different command.
 *
 * TWO SHAPES OF TYPO, AND BOTH ARE REFUSED HERE, at load, by pointer:
 *
 *   * a wrong TYPE under a right key (`"args": "--prod"`, a string where the
 *     list belongs) -- the readers below;
 *   * a right type under a WRONG key one letter out (`"arg"`, `"requireEnv"`)
 *     -- `refuseNearMissKey` above, which names the key it was one edit from.
 *
 * `$`-prefixed keys are metadata and are skipped, as everywhere in this schema;
 * every other key -- every key that is not one of the four and not a near-miss
 * of one -- preserves its whole entry on `raw`.
 */
function parseTargets(path: string, value: unknown): Record<string, DeployTarget> {
  if (value === undefined || value === null) return {};
  const record = requireRecord(path, "project.targets", value);
  // `Object.create(null)`, NOT `{}`, AND THE REASON IS A TARGET NAMED
  // `__proto__`. Assigning that key on an ordinary object literal sets the
  // prototype instead of adding an own property: the target vanishes from the
  // map AND from `Object.keys`, so `--target __proto__` is refused as
  // undeclared and the refusal LISTS a set that does not include it -- nen
  // telling a maintainer their own file does not say what it plainly says. A
  // prototype-less map has no such key to hit, and every reader of this map
  // already goes through `Object.keys` or `hasOwnProperty`.
  const targets: Record<string, DeployTarget> = Object.create(null) as Record<string, DeployTarget>;
  for (const [name, entry] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const pointer = `project.targets.${name}`;
    const raw = requireRecord(path, pointer, entry);
    refuseNearMissKey(
      path,
      pointer,
      raw,
      TARGET_KEYS,
      "A target",
      (meant): string => `this destination would deploy with '${meant}' silently unset`,
    );
    const unsupported =
      raw["unsupported"] === undefined || raw["unsupported"] === null
        ? null
        : // THE SENTENCE IS REQUIRED, NOT JUST THE KEY -- the same rule
          // `parseInvocation` applies to an `unsupported` VERB row, in the same
          // words, because this key answers at the same exit code. `""` read as
          // a reason gave a caller `exit 4` with nothing after the colon; `""`
          // read as "not unsupported" would be worse still, running a
          // destination the declaration was trying to close.
          requireString(path, `${pointer}.unsupported`, raw["unsupported"]);
    const args = optionalStrings(path, `${pointer}.args`, raw["args"]);
    if (unsupported !== null && args.length > 0) {
      // A DESTINATION IS EITHER REACHABLE BY A COMMAND OR IT IS NOT. Both keys
      // at once says "there is no command line for this, and here are its
      // arguments" -- and whichever half this loader chose to honour would be a
      // choice about somebody else's infrastructure.
      throw new SchemaError(
        path,
        pointer,
        "declares both 'unsupported' and 'args'. A destination that has no command line has no arguments either; state one or the other",
      );
    }
    targets[name] = {
      name,
      args,
      requiresEnv: optionalStrings(path, `${pointer}.requiresEnv`, raw["requiresEnv"]).map(
        (variable, index): string =>
          requireEnvName(path, `${pointer}.requiresEnv[${index}]`, variable),
      ),
      unsupported,
      why: optionalString(path, `${pointer}.why`, raw["why"]),
      raw,
    };
  }
  return targets;
}

/** The four keys `project.evidence` is made of. Nen's, not the repo's. */
const EVIDENCE_KEYS: readonly string[] = ["globs", "mechanism", "scene", "suiteSuffix"];

/** `{suite}-{scene}` -- the KroApple convention's own joined form. */
const DEFAULT_EVIDENCE_SCENE = "{suite}-{scene}";

/** The suffix `pr_screenshots.sh`'s `scene_of()` strips off a `*SnapshotTests` directory. */
const DEFAULT_EVIDENCE_SUITE_SUFFIX = "SnapshotTests";

/**
 * `project.evidence` -- parsed rather than preserved, for the same reason
 * `project.targets` is: the moment a value here decides what `nen shu
 * evidence` matches and reports, an unparsed map means a typo reaches that
 * verb as SILENCE -- a mistyped 'glob' key preserved on `raw`, read by
 * nobody, and every run reporting no evidence changed on a branch that
 * changed plenty.
 */
function parseEvidence(path: string, value: unknown): EvidenceBlock {
  const raw = requireRecord(path, "project.evidence", value);
  refuseNearMissKey(
    path,
    "project.evidence",
    raw,
    EVIDENCE_KEYS,
    "project.evidence",
    (meant): string =>
      meant === "globs"
        ? "'nen shu evidence' would match the changed-file set against nothing and report an empty result on every run, indistinguishable from a branch that genuinely changed no evidence"
        : meant === "mechanism"
          ? "a later step would not know how this repository wants a survivor put in front of a human"
          : meant === "scene"
            ? "a later mirroring step would name its destination with the default template rather than this repository's own"
            : "a suite name would be derived by stripping the default suffix rather than this repository's own",
  );
  if (raw["globs"] === undefined) {
    throw new SchemaError(
      path,
      "project.evidence.globs",
      "expected the glob list, got nothing (the field is absent). 'nen shu evidence' matches the changed-file set against these patterns ('*', '**' and '?'); a block naming none would match nothing on every run, which is the same silent always-empty result a mistyped key produces",
    );
  }
  const globs = requireArray(path, "project.evidence.globs", raw["globs"]).map(
    (item, index): string => requireString(path, `project.evidence.globs[${index}]`, item),
  );
  if (globs.length === 0) {
    throw new SchemaError(
      path,
      "project.evidence.globs",
      "is an empty array. At least one glob is required, for the same reason an absent list is refused above: a block that matches nothing is a block indistinguishable from one that was never declared",
    );
  }
  if (raw["mechanism"] === undefined) {
    throw new SchemaError(
      path,
      "project.evidence.mechanism",
      `expected one of ${EVIDENCE_MECHANISMS.join(", ")}, got nothing (the field is absent). This is how a later step gets a changed snapshot in front of a human, and nen will not guess it`,
    );
  }
  const mechanism = requireEnum(
    path,
    "project.evidence.mechanism",
    raw["mechanism"],
    EVIDENCE_MECHANISMS,
  );
  const scene =
    raw["scene"] === undefined
      ? DEFAULT_EVIDENCE_SCENE
      : requireString(path, "project.evidence.scene", raw["scene"]);
  const suiteSuffix =
    raw["suiteSuffix"] === undefined
      ? DEFAULT_EVIDENCE_SUITE_SUFFIX
      : requireString(path, "project.evidence.suiteSuffix", raw["suiteSuffix"]);
  return { globs, mechanism, scene, suiteSuffix, raw };
}

/**
 * One `{exe, argv}` pair, wherever a declaration states a bare step.
 *
 * NO `stdoutTo` HERE, DELIBERATELY. This reader serves a launch target's device
 * `resolve` probe and its `after` steps, and neither is a place a file could
 * honestly be written: a probe's stdout is the document nen SEARCHES for a
 * device id -- it is an input, not an output -- and an after-step runs once a
 * long-running verb has already had this terminal. `stdoutTo` lives on the
 * lane's own invocation, where the executor captures output at all.
 */
function parseStep(
  path: string,
  pointer: string,
  value: unknown,
): { exe: string; argv: readonly string[] } {
  const raw = requireRecord(path, pointer, value);
  return {
    exe: requireString(path, `${pointer}.exe`, raw["exe"]),
    argv: requireArgv(path, `${pointer}.argv`, raw["argv"]),
  };
}

/**
 * `project.launch.<name>.device.readyWhen`, or null when the device declares no
 * readiness rule at all -- which is every declaration written before the key
 * existed, and means exactly what it meant then: a row that carries the name is
 * taken as the device.
 *
 * REFUSED AT LOAD, BY POINTER, FOR ALL FOUR SHAPES A RULE CAN BE WRONG IN, and
 * the reason is the reason every other launch key is validated here rather than
 * at the run: a rule this loader let through is a rule nen would discover it
 * could not read with somebody's phone in their hand, at the one moment they
 * are least able to go and read a schema.
 */
function parseReadyWhen(path: string, pointer: string, value: unknown): DeviceReadiness | null {
  if (value === undefined || value === null) return null;
  const raw = requireRecord(path, pointer, value);
  refuseNearMissKey(
    path,
    pointer,
    raw,
    READY_KEYS,
    "A readiness rule",
    (meant): string => `the device would be taken as ready with '${meant}' silently unset`,
  );
  const hasField = raw["field"] !== undefined && raw["field"] !== null;
  const hasPath = raw["path"] !== undefined && raw["path"] !== null;
  if (hasField === hasPath) {
    throw new SchemaError(
      path,
      pointer,
      `states ${hasField ? "BOTH 'field' and 'path'" : "neither 'field' nor 'path'"}, and a readiness rule is exactly one of the two. 'field' reads a whitespace-separated position on the device's own LINE, counted from 1; 'path' reads a dotted key off the device's own JSON OBJECT. Which of the two applies is decided by what the probe printed, not by the declaration, so a rule naming both would leave nen choosing between them against a document it has not seen yet${hasField ? "" : " -- and a rule naming neither says where to look nowhere at all"}`,
    );
  }
  const accepted = requireArray(path, `${pointer}.in`, raw["in"]).map(
    (entry, index): string => requireString(path, `${pointer}.in[${index}]`, entry),
  );
  if (accepted.length === 0) {
    throw new SchemaError(
      path,
      `${pointer}.in`,
      "is empty, so no state this probe can report would ever count as ready and every launch through this target would refuse. A readiness rule states which of the probe's OWN words mean 'this device will take a build'; if every one of them does, drop 'readyWhen' rather than listing none",
    );
  }
  return {
    field: hasField
      ? requirePositiveInteger(
          path,
          `${pointer}.field`,
          raw["field"],
          "fields, counting the row's first token as 1",
          "A field position",
        )
      : null,
    path: hasPath ? requireString(path, `${pointer}.path`, raw["path"]) : null,
    in: accepted,
    raw,
  };
}

/** `project.launch.<name>.device`, or null when the target names no device. */
function parseLaunchDevice(path: string, pointer: string, value: unknown): LaunchDevice | null {
  if (value === undefined || value === null) return null;
  const raw = requireRecord(path, pointer, value);
  refuseNearMissKey(path, pointer, raw, DEVICE_KEYS, "A device");
  const readyWhen = parseReadyWhen(path, `${pointer}.readyWhen`, raw["readyWhen"]);
  if (readyWhen !== null && (raw["resolve"] === undefined || raw["resolve"] === null)) {
    // A KEY WITH NOTHING TO READ IS REFUSED, exactly as a launch target's
    // `artifact` with no `{artifact}` token is. `readyWhen` is a rule about a
    // PROBE'S OUTPUT, and a device with no probe produces none: its name is its
    // id and nothing is spawned, so the rule would sit in the file looking like
    // a safety check while never being consulted -- which is worse than absent.
    throw new SchemaError(
      path,
      `${pointer}.readyWhen`,
      "is declared on a device with no 'resolve' probe. A readiness rule reads a state out of the PROBE'S output, and a device with no probe is resolved from its own name with nothing spawned -- so this rule would never be read, while reading in the file exactly like a check that is protecting the launch. Give the device a 'resolve' probe whose output carries the state, or drop 'readyWhen'",
    );
  }
  return {
    // REQUIRED, AND IT IS THE WHOLE MATCH. A device block with no name is a
    // block that says nothing nen can look for -- there is no "the only device
    // connected" here, because "the only one" is a fact about a moment rather
    // than about the declaration.
    name: requireString(path, `${pointer}.name`, raw["name"]),
    kind: optionalString(path, `${pointer}.kind`, raw["kind"]),
    resolve:
      raw["resolve"] === undefined || raw["resolve"] === null
        ? null
        : parseStep(path, `${pointer}.resolve`, raw["resolve"]),
    readyWhen,
    raw,
  };
}

/**
 * `project.launch` -- the launch targets, PARSED rather than preserved.
 *
 * SAME THREE REFUSALS `project.targets` GETS, for the same reasons, and one
 * more that is this block's own:
 *
 *   * a wrong TYPE under a right key (`"after": {}`) -- the readers below;
 *   * a right type under a WRONG key one spelling out (`"arg"`, `"resolver"`,
 *     `"Device"`) -- `refuseNearMissKey`, which names the key it meant;
 *   * `unsupported` beside anything that would be RUN. A target with no command
 *     line has no verb, no arguments, no device and no after-steps either, and
 *     whichever half this loader chose to honour would be a choice about
 *     somebody else's machine.
 *   * `verb` IS REQUIRED on every target that is not `unsupported`, out of a
 *     closed two-member set. `dev` and `run` are different BUILDS, and a target
 *     that did not say which one it launches through would leave nen picking
 *     between a debug binary and a production one.
 *   * `lane` NAMES A DECLARED LANE OR IT IS REFUSED, by pointer, listing the
 *     ones that are -- `project.defaultLane`'s own rule, applied here for the
 *     same reason. A lane resolved at RUN time instead would put the refusal
 *     behind `--target`, so a repository whose launch block names a lane it
 *     renamed last week would load clean and refuse only when somebody tried to
 *     launch. This block is loaded by `nen schema check`; that is where the
 *     mistake is cheap.
 *   * `artifact` IS A NON-EMPTY STRING. The containment check lives in
 *     ../shu/run.ts, which has a repository root to compare a path against;
 *     what is refused here is the shape, and an EMPTY string specifically --
 *     `""` would substitute into an after-step as nothing at all, turning
 *     `install <path>` into `install` and leaving a caller with a tool's own
 *     usage message instead of nen's.
 *
 * `$`-prefixed keys are metadata and are skipped; every other key preserves its
 * whole entry on `raw`, as everywhere in this schema.
 */
function parseLaunch(
  path: string,
  value: unknown,
  lanes: Readonly<Record<string, Lane>>,
): Record<string, LaunchTarget> {
  if (value === undefined || value === null) return {};
  const record = requireRecord(path, "project.launch", value);
  // `Object.create(null)` for `parseTargets`'s reason, verbatim: a target named
  // `__proto__` on an ordinary object literal sets the prototype instead of
  // adding an own property, so it would vanish from the map AND from the
  // listing every refusal prints.
  const launch: Record<string, LaunchTarget> = Object.create(null) as Record<string, LaunchTarget>;
  for (const [name, entry] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const pointer = `project.launch.${name}`;
    const raw = requireRecord(path, pointer, entry);
    refuseNearMissKey(path, pointer, raw, LAUNCH_KEYS, "A launch target");
    const unsupported =
      raw["unsupported"] === undefined || raw["unsupported"] === null
        ? null
        : // THE SENTENCE IS REQUIRED, NOT JUST THE KEY -- `parseInvocation`'s
          // rule and `parseTargets`'s, in the same words, because this key
          // answers at the same exit code.
          requireString(path, `${pointer}.unsupported`, raw["unsupported"]);
    if (unsupported !== null) {
      const runnable = ["verb", "lane", "args", "artifact", "device", "after"].filter(
        (key): boolean => raw[key] !== undefined && raw[key] !== null,
      );
      if (runnable.length > 0) {
        throw new SchemaError(
          path,
          pointer,
          `declares 'unsupported' and also ${runnable.map((key): string => `'${key}'`).join(", ")}. A launch target that has no command line at all has no verb, lane, arguments, artifact, device or after-steps either; state one or the other`,
        );
      }
      launch[name] = {
        name,
        verb: null,
        lane: null,
        args: [],
        artifact: null,
        device: null,
        after: [],
        unsupported,
        why: optionalString(path, `${pointer}.why`, raw["why"]),
        raw,
      };
      continue;
    }
    const after = raw["after"];
    const lane = optionalString(path, `${pointer}.lane`, raw["lane"]);
    if (lane !== null) requireDeclaredLane(path, `${pointer}.lane`, lane, lanes);
    const artifact = optionalString(path, `${pointer}.artifact`, raw["artifact"]);
    if (artifact === "") {
      throw new SchemaError(
        path,
        `${pointer}.artifact`,
        "is an empty string. It is the repo-relative path {artifact} stands for, and an empty one would substitute into an after-step as nothing at all -- leaving the installer a shorter command line and the caller a tool's own usage message instead of a refusal from nen. Write the path, or drop the key and let {artifact} be the verb's first declared artifact",
      );
    }
    launch[name] = {
      name,
      verb: requireEnum(path, `${pointer}.verb`, raw["verb"], LAUNCH_VERBS),
      lane,
      args: optionalStrings(path, `${pointer}.args`, raw["args"]),
      artifact,
      device: parseLaunchDevice(path, `${pointer}.device`, raw["device"]),
      after:
        after === undefined || after === null
          ? []
          : requireArray(path, `${pointer}.after`, after).map(
              (step, index): { exe: string; argv: readonly string[] } =>
                parseStep(path, `${pointer}.after[${index}]`, step),
            ),
      unsupported: null,
      why: optionalString(path, `${pointer}.why`, raw["why"]),
      raw,
    };
  }
  return launch;
}

/**
 * The project-level BLOCK keys whose own name is guarded against a near-miss,
 * each with what a silently-preserved misspelling of it would cost.
 *
 * TWO OF ELEVEN, AND THAT IS A SCOPE RATHER THAN AN INCONSISTENCY. Both are
 * OPTIONAL blocks whose ABSENCE MEANS `{}` or `null`, so `"launches": { … }`,
 * `"Launch": { … }`, `"evidences": { … }` or `"Evidence": { … }` is preserved
 * verbatim, read by nobody, and the verb that wanted it answers "this
 * repository declares none" about a file that plainly declares plenty. Both are
 * also NEW enough that nothing in the field can already be relying on a
 * misspelling of them.
 *
 * `targets`, `hosts`, `toolchain` and `profiles` have the identical hole and
 * are still deliberately NOT swept: widening this to them would refuse
 * declarations already written against 0.3.0 -- a parked `"host"` or `"target"`
 * key is a near-miss of a real one -- and that is a change with its own blast
 * radius rather than a rider on this one. `targets` keeps the guard it has,
 * which is the PER-ENTRY one (`refuseNearMissKey` on each target's four keys).
 */
const GUARDED_BLOCK_KEYS: readonly { readonly key: string; readonly cost: string }[] = [
  {
    key: "launch",
    cost:
      "the block nen reads for 'nen shu dev|run --target'. Preserved as an unknown key it would be read by nobody, and every --target this repository declares would be refused as undeclared",
  },
  {
    key: "evidence",
    cost:
      "the block nen reads for 'nen shu evidence'. Preserved as an unknown key it would be read by nobody, and that verb would refuse at exit 2 saying this repository declares no evidence block -- about a file that plainly declares one",
  },
];

/** A project-level block key one typo from a guarded one, refused by name. */
function refuseNearMissBlockKey(path: string, raw: Readonly<Record<string, unknown>>): void {
  for (const key of Object.keys(raw)) {
    if (key.startsWith("$")) continue;
    for (const { key: known, cost } of GUARDED_BLOCK_KEYS) {
      if (key === known) continue;
      const how = nearMissOf(key, known);
      if (how === null) continue;
      throw new SchemaError(
        path,
        `project.${key}`,
        `${how}, ${cost}. Spell it '${known}'`,
      );
    }
  }
}

export function parseProjectBlock(path: string, value: unknown): ProjectBlock {
  const raw = requireRecord(path, "project", value);
  if (raw["lanes"] === undefined) {
    throw new SchemaError(
      path,
      "project.lanes",
      "expected the lane map, got nothing (the field is absent). A stack is a PER-LANE property in this schema -- one repository is routinely several builds -- so there is no lane-free shorthand to fall back on",
    );
  }
  if (raw["verbs"] === undefined) {
    throw new SchemaError(
      path,
      "project.verbs",
      "expected the per-lane verb map, got nothing (the field is absent). A project block with no verbs declares a stack nothing can be run against; state the verbs, using {\"unsupported\": \"<why>\"} for the ones this repository genuinely has none of",
    );
  }
  refuseNearMissBlockKey(path, raw);
  const lanes = parseLanes(path, raw["lanes"]);
  const defaultLaneRaw = raw["defaultLane"];
  const defaultLane = optionalString(path, "project.defaultLane", defaultLaneRaw);
  if (defaultLane !== null) requireDeclaredLane(path, "project.defaultLane", defaultLane, lanes);
  return {
    scenario: optionalString(path, "project.scenario", raw["scenario"]),
    lanes,
    defaultLane,
    verbs: parseVerbs(path, raw["verbs"], lanes),
    toolchain:
      raw["toolchain"] === undefined || raw["toolchain"] === null
        ? {}
        : parseToolchain(path, raw["toolchain"]),
    preconditions:
      raw["preconditions"] === undefined || raw["preconditions"] === null
        ? {}
        : parsePreconditions(path, raw["preconditions"], lanes),
    profiles: optionalRecord(path, "project.profiles", raw["profiles"]),
    targets: parseTargets(path, raw["targets"]),
    launch: parseLaunch(path, raw["launch"], lanes),
    hosts:
      raw["hosts"] === undefined || raw["hosts"] === null
        ? {}
        : parseHosts(path, "project.hosts", raw["hosts"]),
    evidence:
      raw["evidence"] === undefined || raw["evidence"] === null
        ? null
        : parseEvidence(path, raw["evidence"]),
    raw,
  };
}

export function parseContract(
  path: string,
  location: SchemaLocation,
  value: unknown,
): RepositoryContract {
  const raw = requireRecord(path, "(root)", value);
  const hasDependency = raw["dependency"] !== undefined && raw["dependency"] !== null;
  const hasProject = raw["project"] !== undefined && raw["project"] !== null;
  if (!hasDependency && !hasProject) {
    const stray = Object.keys(raw).filter((key): boolean => !key.startsWith("$"));
    throw new SchemaError(
      path,
      "(root)",
      `declares neither a "dependency" block (what this repository needs FROM nen) nor a "project" block (what nen needs to know ABOUT it), so nothing can ever read it. ${
        stray.length === 0
          ? "The file is empty of both; delete it, or add the block you meant."
          : `Its top-level keys are [${stray.join(", ")}] -- if this file was moved here from a root 'nen.contract.json', wrap that object in a "dependency" key.`
      }`,
    );
  }
  return {
    path,
    location,
    // `$schema` IS A `$`-KEY LIKE EVERY OTHER, and this loader's header says
    // those are "read by nobody". Requiring it to be a STRING made it the one
    // `$`-key that could FAIL a document -- a repository whose `$schema` is an
    // object (a JSON Schema written inline, a `{"id": …, "version": …}` pair)
    // would be refused over a field nen does not use. It is surfaced when it
    // happens to be a string, ignored otherwise, and preserved either way by
    // `raw`, which is what every other `$`-key already gets.
    schema: typeof raw["$schema"] === "string" && raw["$schema"] !== "" ? raw["$schema"] : null,
    dependency: hasDependency ? parseDependencyBlock(path, raw["dependency"]) : null,
    project: hasProject ? parseProjectBlock(path, raw["project"]) : null,
    raw,
  };
}

/**
 * Read and validate `nen/contract.json`.
 *
 * OPTIONAL LIKE `gates.json`: an absent file is not an error here. The caller
 * decides -- `nen schema check` reports it as absent, and a verb that needs a
 * block refuses by name. `readSchemaJson`'s own ENOENT sentence is what
 * `checkTaxonomy` branches on, so it is passed through untouched.
 */
export function loadContract(repoRoot: string): RepositoryContract {
  const { path, value, location } = readSchemaJson(repoRoot, CONTRACT_FILE);
  return parseContract(path, location, value);
}

/** A one-line `nen schema check` summary of what the file declares. */
export function describeContract(contract: RepositoryContract): string {
  const blocks: string[] = [];
  if (contract.dependency !== null) {
    blocks.push(
      `dependency (nen >= ${contract.dependency.minimum}, pinned ${contract.dependency.pinnedRef})`,
    );
  }
  if (contract.project !== null) {
    const lanes = Object.keys(contract.project.lanes);
    const verbs = Object.values(contract.project.verbs).reduce(
      (sum, perLane): number => sum + Object.keys(perLane).length,
      0,
    );
    const tools = Object.keys(contract.project.toolchain).length;
    blocks.push(
      `project (${lanes.length} ${lanes.length === 1 ? "lane" : "lanes"}: ${lanes.join(", ")}; ${verbs} ${verbs === 1 ? "verb" : "verbs"}; ${tools} toolchain ${tools === 1 ? "entry" : "entries"})`,
    );
  }
  return blocks.join(", ");
}
