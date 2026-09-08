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

export type Invocation =
  | {
      readonly kind: "command";
      readonly exe: string;
      readonly argv: readonly string[];
      readonly why: string | null;
      readonly raw: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "steps";
      readonly steps: readonly { readonly exe: string; readonly argv: readonly string[] }[];
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
  /** A path, or an argv list -- whichever the kind means. */
  readonly value: string | readonly string[];
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
  /** Per-verb allowlist of `process.platform` values; `*` means every verb. */
  readonly hosts: Readonly<Record<string, readonly string[]>>;
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
      steps: steps.map((step, index): { exe: string; argv: readonly string[] } => {
        const at = `${pointer}.steps[${index}]`;
        const record = requireRecord(path, at, step);
        return {
          exe: requireString(path, `${at}.exe`, record["exe"]),
          argv: requireArgv(path, `${at}.argv`, record["argv"]),
        };
      }),
      why,
      raw,
    };
  }
  return {
    kind: "command",
    exe: requireString(path, `${pointer}.exe`, raw["exe"]),
    argv: requireArgv(path, `${pointer}.argv`, raw["argv"]),
    why,
    raw,
  };
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
      // does not yet act on preconditions, and closing an enum nobody has
      // declared would refuse a repository for stating a true fact about
      // itself. What IS checked is that a value is a path or an argv list --
      // the two shapes any future assertion can be written against.
      const parsedValue: string | readonly string[] = Array.isArray(rawValue)
        ? requireArgv(path, `${at}.value`, rawValue)
        : requireString(path, `${at}.value`, rawValue);
      return {
        kind: requireString(path, `${at}.kind`, raw["kind"]),
        value: parsedValue,
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

/**
 * `project.targets` -- the deploy destinations, PARSED rather than preserved.
 *
 * IT USED TO BE AN OPAQUE RECORD, and everything nen did with it was ask
 * whether a key existed. That was honest while nothing read the values; the
 * moment a target contributes arguments to a spawned argv and environment
 * NAMES to an assertion, an unparsed map means a typo (`"arg"`, `"requireEnv"`,
 * a string where a list belongs) reaches a deploy as SILENCE -- the flag was
 * accepted, the destination's arguments were not appended, and the command that
 * ran is a different command. So the shapes are refused here, at load, by
 * pointer, exactly as every other block in this file is.
 *
 * `$`-prefixed keys are metadata and are skipped, as everywhere in this schema;
 * every other key preserves its whole entry on `raw`.
 */
function parseTargets(path: string, value: unknown): Record<string, DeployTarget> {
  if (value === undefined || value === null) return {};
  const record = requireRecord(path, "project.targets", value);
  const targets: Record<string, DeployTarget> = {};
  for (const [name, entry] of Object.entries(record)) {
    if (name.startsWith("$")) continue;
    const pointer = `project.targets.${name}`;
    const raw = requireRecord(path, pointer, entry);
    const unsupported = optionalString(path, `${pointer}.unsupported`, raw["unsupported"]);
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
      requiresEnv: optionalStrings(path, `${pointer}.requiresEnv`, raw["requiresEnv"]),
      unsupported,
      why: optionalString(path, `${pointer}.why`, raw["why"]),
      raw,
    };
  }
  return targets;
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
    hosts:
      raw["hosts"] === undefined || raw["hosts"] === null
        ? {}
        : parseHosts(path, "project.hosts", raw["hosts"]),
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
