// src/shu/command.ts -- `nen shu ...`, the stack-aware developer verbs.
//
// THIRTEEN VERBS FROM DAY ONE, AND ONLY SOME OF THEM DO SOMETHING. That looks
// like the thing ../cli/registry.ts's header forbids ("a family is not listed
// until it does something"), and it is the opposite of it: the family DOES
// something -- `detect` proposes a declaration, and ten verbs execute one -- and
// the two that do not (`tools`, `warmup`) refuse by name with the release they
// arrive in. The alternative is worse in the exact way the registry rule is
// about: a verb that is absent today and appears later changes `nen shu --help`
// underneath every skill that read it, while a verb that refuses with a reason
// is a contract a caller can already write against.
//
// WHAT THE FAMILY IS. Every verb below runs what the TARGET REPOSITORY declares
// in its own `nen/contract.json`, under `project`. Nen carries no build system,
// no package manager, no test runner and no knowledge of any: ./run.ts and
// ./render.ts contain zero toolchain names and ./purity.test.ts fails the build
// if that ever stops being true. `detect` is the one verb that reads the
// filesystem for markers, and it PROPOSES -- it never writes without `--write`
// and never overwrites a declaration at all.
//
// EACH SUBCOMMAND OWNS ITS FLAGS, derived from one table, on ../issue/command.ts's
// pattern and for its reason: a family shares one flag spec, so `nen shu build
// --write` would otherwise parse cleanly and be silently ignored -- and `--write`
// is the ONE flag in this family that decides whether anything is written.

import { resolveRepoRoot } from "../repo/root.js";
import { emit, requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import type { FlagSpec } from "../cli/args.js";
import { PROGRAM } from "../version.js";
import { EXIT_UNSUPPORTED_VERB, ShuRefusal } from "./exit.js";
import { detect, renderDetect, writeProposal } from "./detect.js";
import { runVerb } from "./run.js";

/**
 * WHAT EACH SUBCOMMAND CONSUMES -- the one declaration both the parser's spec
 * and the foreign-flag refusal are derived from, so a flag cannot exist without
 * an owner and a subcommand cannot silently accept a sibling's flag.
 */
export const SHU_SUBCOMMAND_FLAGS: Readonly<Record<string, FlagSpec>> = {
  detect: { booleans: ["write"] },
  build: { values: ["lane"], booleans: ["dry-run"] },
  test: { values: ["lane"], booleans: ["dry-run"] },
  "ui-test": { values: ["lane"], booleans: ["dry-run"] },
  lint: { values: ["lane"], booleans: ["dry-run"] },
  archive: { values: ["lane"], booleans: ["dry-run"] },
  release: { values: ["lane"], booleans: ["dry-run"] },
  dev: { values: ["lane"], booleans: ["dry-run"] },
  run: { values: ["lane"], booleans: ["dry-run"] },
  deploy: { values: ["lane", "target"], booleans: ["dry-run"] },
  coverage: { values: ["lane"], booleans: ["dry-run"] },
  tools: { values: ["lane"], booleans: ["install"] },
  warmup: { values: ["lane"], booleans: ["dry-run"] },
};

/** The thirteen, in the order the design lists them (not alphabetical). */
export const SHU_SUBCOMMANDS: readonly string[] = [
  "detect",
  "build",
  "test",
  "ui-test",
  "lint",
  "archive",
  "release",
  "dev",
  "run",
  "deploy",
  "coverage",
  "tools",
  "warmup",
];

/** The ten that execute a lane's declared invocation in this release. */
export const EXECUTING_VERBS: readonly string[] = [
  "build",
  "test",
  "ui-test",
  "lint",
  "archive",
  "release",
  "dev",
  "run",
  "deploy",
  "coverage",
];

/**
 * The two that are declared, documented and not yet implemented, with the issue
 * that brings each one.
 *
 * THEY REFUSE WITH 4, the same code an undeclared verb gets, and the message
 * says which of the two facts is true. Inventing a sixth code for "nen has not
 * built this yet" would put a transient state into a published contract.
 */
const NOT_YET: Readonly<Record<string, string>> = {
  tools: "checks and installs the HOST toolchain a declaration pins. It is not implemented yet in this release: it is the one verb in this family whose blast radius is the developer's machine rather than a repository, and it ships on its own (zheref/nen#91's PR4) so its installer surface is settled while there is exactly one stack to get wrong.",
  warmup: "brings a working copy to a known state and then verifies it. It is not implemented yet in this release (zheref/nen#91's PR12).",
};

const USAGE = `${PROGRAM} shu <verb> [--repo <path>] [--lane <name>] [--dry-run] [--json]

Stack-aware developer verbs. Every one of them runs what the TARGET REPOSITORY
declares in nen/contract.json under "project" -- its lanes, its per-verb argv,
its preconditions, its platforms. Nen carries no build system, no package
manager and no test runner, and knows the name of none: a verb this repository
has is a verb this repository states.

verbs:
  detect      Read the markers on disk and PROPOSE a project block. Writes
              nothing without --write, and never overwrites a declaration.
  build       Compile or assemble the lane.
  test        Run the lane's test suite.
  ui-test     Run the lane's UI/E2E suite.
  lint        Run the lane's linter and format check.
  archive     Produce the lane's distributable artifact.
  release     Publish it, where the lane declares a publication step.
  dev         Start the lane's DEBUG build. Long-running: nen inherits this
              terminal and hands it to the child.
  run         Start the lane's PRODUCTION build, locally. Also long-running.
  deploy      Send a build to a declared, NAMED target. --target is required
              and has no default, not even when exactly one target exists.
  coverage    Run the lane's coverage command.
  tools       (not implemented yet -- zheref/nen#91's PR4) Check, and with
              --install install, the host toolchain a declaration pins.
  warmup      (not implemented yet -- zheref/nen#91's PR12) Bring a working
              copy to a known state, then verify it.

the declaration:
  <repo>/nen/contract.json, "project" block. Absent, or present with no
  "project" block, is exit 2 naming the file -- 'nen shu detect' proposes one.
  Present but MALFORMED is exit 1, not 2; see the exit codes below.

  project.lanes         { "<lane>": { "stack": "<id>", "cwd": "<repo-relative>" } }
                        A stack is a PER-LANE property: one repository is
                        routinely several builds.
  project.defaultLane   Which lane --lane defaults to. null is legal and means
                        --lane is required.
  project.verbs         { "<lane>": { "<verb>": <invocation> } }, where an
                        invocation is { exe, argv } or { steps: [...] } or
                        { unsupported: "<why>" }. argv is a LIST, never a
                        string: there is no shell, no expansion, no 'sh -c'.
                        An invocation may also carry:
                          env       { "<NAME>": "<value>" }, passed to the
                                    child. Only the NAMES are ever reported --
                                    a declared value can be a token, and a
                                    token in a log or a --json blob is a
                                    leaked token.
                          artifacts ["<repo-relative path>", ...], the outputs
                                    this verb produces. Nen REPORTS whether
                                    each exists and never creates one.
  project.preconditions { "<lane>": [ { kind, value, why } ] }. Nen ASSERTS
                        these and NEVER performs them. It asserts kind 'path'
                        (repo-root-relative) and kind 'env' (the variable is
                        set; its value is never read or printed), each stated
                        as ONE string. A kind it cannot assert -- including an
                        assertable kind given a LIST of values -- is reported
                        as such and refused: an unperformed check is never
                        rendered as a clean one.
  project.hosts         { "<verb>|*": ["darwin","linux","win32"] }, compared
                        against this host. An exact verb key wins over "*", and
                        a declaration with no hosts block constrains nothing.
  project.targets       { "<name>": ... }, the deploy destinations. --target
                        must name a key of it. A --target that names none is
                        exit 2 listing what IS declared -- accepting the flag's
                        mere presence would make it a formality satisfied by
                        any word.

flags:
  --lane <name>    Which lane to run in. Defaults to project.defaultLane.
  --dry-run        Print every step's exact argv, cwd and env NAMES, and run
                   nothing at all. The argv printed is the argv that would be
                   spawned, from the same rendering -- the thing you approve is
                   the thing that runs.
  --target <name>  'deploy' only. Must name a key of project.targets. Required,
                   with no default ever -- not even when there is exactly one.
                   It is checked BEFORE the lane and the verb, so a line that
                   gets both wrong is told about the target first.
  --write          'detect' only. Writes nen/contract.json when there is none.
                   There is no --force and no merge.
  --install        'tools' only, and not implemented yet. It is the one flag in
                   that verb that would change the host.
  --json           The report as one object. Its keys, in order:
                   { contract, lane, stack, verb, steps, cwd, env, host,
                     preconditions, exitCode, durationMs, artifacts, log }.
                   'env' is variable NAMES only, never values. 'steps[].exitCode'
                   is the TOOL's code and is null when nothing was run, which is
                   how a --json reader tells a dry run from a real one;
                   'exitCode' is nen's own. Under --json a step's own output
                   goes to STDERR, so stdout stays exactly one document.
                   REFUSED on 'dev' and 'run' unless --dry-run is also given:
                   those two hand this terminal to the child, so stdout is the
                   child's and one object followed by a server's log lines is
                   not a document. '--dry-run --json' is their machine-readable
                   pre-flight.

exit codes:
  0  the tool ran and succeeded, or a dry run rendered
  1  the tool ran and failed. Nen exits 1 whatever the tool's own code was.
     A nen/contract.json that is PRESENT and MALFORMED is also 1: the file is
     there and says something nen cannot read, which is a repository defect
     rather than a mistyped invocation, and it is the code every family in this
     CLI answers an unreadable schema file with. The refusal names the file,
     the pointer and the expectation
  2  usage: no declaration, no "project" block, an unknown --lane, a
     placeholder nen cannot substitute, a --target that names no declared
     target, --json on a long-running verb without --dry-run, a path that
     resolves outside the repository, or a PRECONDITION that is not satisfied
  3  unsupported host -- the verb is real, this machine cannot run it
  4  unsupported verb for THIS LANE -- the declaration says so, in its own
     words. The invocation was correct; the answer is a fact about the repo.
     'tools' and 'warmup' also answer 4 in this release, saying they are not
     implemented yet and naming the PR each arrives in
  5  the declared program could not be started at all

  Codes 3, 4 and 5 extend this CLI's published 0/1/2 (zheref/nen#91).

placeholders:
  Only the reference pack's own tokens are refused -- {pm}, {scheme},
  {destination} and the rest of the closed set docs/STACK-MATRIX.md publishes.
  Every OTHER braced argument is passed to the child exactly as written, so a
  declaration may state --define={"a":1} without nen having an opinion about it.

An argv is printed with any element containing whitespace quoted. Those quotes
are information: '-destination platform=iOS Simulator,name=...' is ONE argv
element, and a reader who re-splits the line on spaces gets a different command.`;

function declaresFlag(spec: FlagSpec, flag: string): boolean {
  return (spec.values ?? []).includes(flag) || (spec.booleans ?? []).includes(flag);
}

/** The union of every subcommand's flags, derived rather than typed out twice. */
const SHU_FLAGS: FlagSpec = {
  values: [
    ...new Set(Object.values(SHU_SUBCOMMAND_FLAGS).flatMap((spec): readonly string[] => spec.values ?? [])),
  ].sort(),
  booleans: [
    ...new Set(Object.values(SHU_SUBCOMMAND_FLAGS).flatMap((spec): readonly string[] => spec.booleans ?? [])),
  ].sort(),
};

/**
 * A flag the parser accepted for the FAMILY but this subcommand does not read.
 *
 * Refused rather than ignored, because the ignored thing is load-bearing:
 * `nen shu build --write` would otherwise look like it had been given a write
 * gate, and `nen shu detect --dry-run` like it had been given a preview it does
 * not have (detect writes nothing without --write, so --dry-run is a flag whose
 * absence a caller might read as danger).
 */
function refuseForeignFlags(subcommand: string, context: CommandContext): void {
  const spec = SHU_SUBCOMMAND_FLAGS[subcommand];
  /* c8 ignore next -- requireSubcommand already refused an unknown name */
  if (spec === undefined) return;
  const given = [...Object.keys(context.args.values), ...context.args.booleans];
  const foreign = given.filter(
    (flag): boolean =>
      !["repo", "json", "help"].includes(flag) &&
      declaresFlag(SHU_FLAGS, flag) &&
      !declaresFlag(spec, flag),
  );
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    `--${foreign.sort().join(", --")} ${foreign.length === 1 ? "is" : "are"} not read by 'shu ${subcommand}'. A flag accepted and ignored is worse than one refused: the ignored thing is the instruction you gave.`,
  );
}

function runDetect(context: CommandContext, repoRoot: string): number {
  const report = detect(repoRoot);
  let written = report;
  if (context.args.booleans.has("write")) {
    try {
      written = writeProposal(repoRoot, report);
    } catch (error) {
      // THE PROPOSAL IS PRINTED BEFORE THE REFUSAL, because the refusal's own
      // advice is "the block to merge is printed above" -- and a message that
      // points at output nobody produced is worse than no advice at all. The
      // caller asked to write and cannot; the block is the thing they now need.
      emit(context.io, context.json, report, renderDetect(report));
      throw error;
    }
  }
  emit(context.io, context.json, written, renderDetect(written));
  if (written.exitCode !== 0) {
    context.io.err(
      `no lane was detected under ${repoRoot}. Nen proposes from a marker it can see and never from a guess; write the project block by hand if this repository has a build it should know about.`,
    );
  }
  return written.exitCode;
}

export const shuCommand: Command = {
  name: "shu",
  summary: "Stack-aware developer verbs, from the target repo's own declaration.",
  usage: USAGE,
  flags: SHU_FLAGS,
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("shu", context.args, SHU_SUBCOMMANDS);
    refuseForeignFlags(subcommand, context);
    const repoRoot = resolveRepoRoot({ repoFlag: context.repoFlag });

    try {
      if (subcommand === "detect") return runDetect(context, repoRoot);

      const notYet = NOT_YET[subcommand];
      if (notYet !== undefined) {
        throw new ShuRefusal(EXIT_UNSUPPORTED_VERB, `'${subcommand}' ${notYet}`);
      }

      if (subcommand === "deploy") {
        // NEVER A DEFAULT TARGET, not even when there is exactly one. A deploy
        // that picks its own destination is the one mistake in this family
        // whose blast radius is other people's users.
        requireValue(
          context.args,
          "target",
          "'shu deploy' sends a build to a NAMED target from project.targets, and there is no default -- one entry does not make it one.",
        );
      }

      return runVerb(context, repoRoot, {
        verb: subcommand,
        lane: context.args.values["lane"] ?? null,
        dryRun: context.args.booleans.has("dry-run"),
        target: context.args.values["target"] ?? null,
      });
    } catch (error) {
      // This family's own codes (3/4/5) are returned, not thrown past
      // ../index.ts's runFamily -- which maps every error it does not know to 1
      // or 2, correctly, for every family that has only those.
      if (error instanceof ShuRefusal) {
        context.io.err(`${PROGRAM} shu ${subcommand}: ${error.message}`);
        return error.code;
      }
      throw error;
    }
  },
};
