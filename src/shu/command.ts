// src/shu/command.ts -- `nen shu ...`, the stack-aware developer verbs.
//
// THIRTEEN VERBS, AND ALL THIRTEEN DO SOMETHING NOW. The family was declared
// whole from day one -- `detect` proposing a declaration, ten verbs executing
// one, and `tools` and `warmup` refusing by name with the release they arrived
// in -- for ../cli/registry.ts's reason: a verb that is absent today and
// appears later changes `nen shu --help` underneath every skill that read it,
// while a verb that refuses with a reason is a contract a caller can already
// write against. Both of those two have since landed, and the mechanism they
// needed is gone rather than left standing empty.
//
// ONE OF THE THIRTEEN MUTATES GIT STATE, and it is the only one: `warmup`
// (./warmup.ts). Every other verb here either reads, or spawns what the target
// repository declared inside a directory. That asymmetry is why `warmup` alone
// requires `--repo` rather than defaulting to the caller's directory.
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

import { assertRepoRoot, resolveRepoRoot } from "../repo/root.js";
import { emit, requireRepoFlag, requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import type { FlagSpec } from "../cli/args.js";
import { commaList } from "../cli/comma.js";
import { INSTALLERS, VERSION_FROM, type ProjectBlock } from "../schema/contract.js";
import { PROGRAM } from "../version.js";
import { openDeclaration } from "./declaration.js";
import { EXIT_UNSUPPORTED_HOST, ShuRefusal } from "./exit.js";
import { detect, renderDetect, writeProposal } from "./detect.js";
import { ENABLED_INSTALLERS } from "./install.js";
import { probeTool, runInstallSteps } from "./probe.js";
import { declaredHostsFor } from "./render.js";
import { insideRepo, runVerb } from "./run.js";
import { DEFAULT_TRUNK, runWarmup, WARMUP_CONTRACT, WARMUP_REMOTE } from "./warmup.js";
import { assess, type Observation } from "./toolchain.js";
import {
  actionable,
  assembleToolsReport,
  buildPlans,
  narrowTo,
  packMinimums,
  refuseUnactionableNarrowing,
  refusedInstalls,
  renderAdvice,
  renderToolsReport,
  toolsExitCode,
  type AssessedTool,
  type ToolPlan,
  type ToolsMode,
} from "./tools.js";

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
  tools: { values: ["lane", "only"], booleans: ["install", "dry-run"] },
  warmup: { values: ["lane", "branch", "from"], booleans: ["discard", "tests", "dry-run"] },
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
 * The installer ids `--install` acts on, INTERPOLATED rather than typed out.
 *
 * ./purity.test.ts forbids a toolchain name anywhere on the execution path, and
 * this file is on it. The one installer nen implements is named in ./install.ts
 * -- the single module that sweep excludes, by name and by argument -- so the
 * help text reads the list from there instead of restating it, which also means
 * a second enabled installer cannot arrive with a --help that still says one.
 */
const ENABLED_INSTALLER_IDS = ENABLED_INSTALLERS.join(", ");

const USAGE = `${PROGRAM} shu <verb> [--repo <path>] [--lane <name>] [--dry-run] [--json]

--repo is bracketed there because twelve of the thirteen verbs default it to the
directory you are standing in. It is REQUIRED on 'warmup', the one verb here
that mutates git state: a verb that fetches into a repository, force-moves a
branch ref and checks out a new branch must never do it to wherever this process
happens to be. The refusal says so by name.

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
  tools       Check the HOST toolchain this repository pins under
              project.toolchain (and, from a dependency block, nen itself).
              Read-only by default: it runs each declared version probe and
              reports. Exit 5 when anything is missing or is not the pinned
              version, naming per tool the exact command that fixes it.
              --install acts, and only through the installer ids listed under
              --install below; every other declared installer is verify-only in
              this release. --dry-run prints every command -- probes included
              -- and runs NOTHING.
  warmup      Warm a WORKING COPY for iteration, in this order: check it is
              clean, fetch, fast-forward the trunk, cut the branch you name
              from its fresh tip, then verify the declared build (and, with
              --tests, the declared tests). THE ONLY VERB IN THIS FAMILY THAT
              MUTATES GIT STATE, so --repo is required and every step refuses
              rather than guessing: a dirty tree, an operation half-finished, a
              detached HEAD carrying commits nothing else reaches, an absent
              '${WARMUP_REMOTE}', a diverged trunk, a name that already exists or that
              git will not accept are each exit 2 with the evidence. EVERY
              CHECK THAT NEEDS NO MUTATION RUNS BEFORE --discard DESTROYS
              ANYTHING, so a mistyped --branch costs nothing. Nothing is rolled
              back. NOT '${PROGRAM} warmup', which sweeps a REGISTRY for stale pins
              and unanswered handbook questions and reads only.

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

  project.toolchain     { "<tool>": { version, probe, versionFrom, installer,
                        why } } -- the HOST tools 'tools' checks. 'version' is
                        required and is either an exact pin ("9.15.9") or a
                        floor (">=20.19.0"): nen never certifies or installs
                        "latest". 'probe' is argv. 'versionFrom' is one of
                        ${VERSION_FROM.join(", ")} -- a closed set, deliberately
                        not a regex, because a caller-supplied pattern is a
                        caller-supplied program. The two 'first-semver' members
                        read the first version-shaped token (one dot or more) on
                        that stream, preferring a THREE-component one when the
                        line offers several -- so a banner leading with a build
                        date '2024.01' does not beat the '1.2.3' beside it. A
                        probe whose line leads with an unrelated dotted number
                        and carries no three-component version reads that first
                        number: state a probe that prints the version alone.
                        'installer' is one of
                        ${INSTALLERS.join(", ")}; only ${ENABLED_INSTALLER_IDS} runs
                        in this release and the rest are reported for a human.

flags:
  --lane <name>    Which lane to run in. Defaults to project.defaultLane.
                   OPTIONAL on 'tools', where a lane supplies only the probe's
                   directory and the stack whose tested minimums are shown:
                   project.toolchain hangs off the project, not off a lane.
  --dry-run        Print every step's exact argv, cwd and env NAMES, and run
                   nothing at all. The argv printed is the argv that would be
                   spawned, from the same rendering -- the thing you approve is
                   the thing that runs. On 'tools' this covers the version
                   PROBES too: a dry run of that verb spawns nothing whatever,
                   which is what makes it the one form of it a watcher can
                   certify read-only. On 'warmup' it prints every git command
                   AND every delegated toolchain command, in order, and runs
                   none of them -- not even the fetch. That form still
                   classifies MUTATING in izanami's table, unlike the other
                   verbs' dry runs, and deliberately: a warm-up is not a thing
                   anyone watches, so the fail-closed answer costs nothing.
                   Because it reads no git state, three of its lines say what a
                   real run would do differently -- which fast-forward shape
                   applies, that '${DEFAULT_TRUNK}' is an assumption, and that the
                   orphan-commit count is asked only on a detached HEAD.
  --only <t[,t]>   'tools' only. Check (and install) just these tools, by the
                   name the declaration gives them. A name it does not declare
                   is exit 2 listing the ones it does -- an empty report is not
                   an answer to a mistyped tool.
  --branch <name>  'warmup' only. The branch to cut from the freshly-fetched
                   trunk. REQUIRED, with no default: nen never invents a branch
                   name. It is validated with git's own 'check-ref-format
                   --branch' and refused at 2 if it already exists locally or on
                   ${WARMUP_REMOTE} -- never reused, reset or force-moved.
  --from <trunk>   'warmup' only. The LOCAL trunk to fast-forward, and what
                   --branch is cut from (as ${WARMUP_REMOTE}/<trunk>). Defaults to
                   '${DEFAULT_TRUNK}' WHEN THAT LOCAL BRANCH EXISTS, and refuses at 2
                   naming this flag when it does not -- nen infers a trunk from
                   no remote HEAD and from no lone branch.
  --discard        'warmup' only. Throw away uncommitted work instead of
                   refusing it: 'git reset --hard' then 'git clean -fd', in
                   that order, with the exact list printed first. 'reset --hard'
                   and not 'checkout -- .', because the latter restores the tree
                   FROM THE INDEX and a staged change would survive it in both.
                   NEVER 'git clean -x': an ignored file is the developer's own
                   cache, and this verb does not delete one. NEVER a second -f
                   either: that deletes a NESTED REPOSITORY, which may carry
                   commits that exist nowhere else.
                   THE TREE IS THEN READ AGAIN. Those two commands exiting 0 is
                   a statement about the commands, not about the tree: neither
                   removes a nested repository, and neither reaches into a
                   submodule. Anything still uncommitted afterwards is exit 2
                   naming it -- with the report, because by then this run has
                   destroyed something and the report is what says what.
  --tests          'warmup' only. Also run the lane's declared 'test' after the
                   build, through the same executor. Off by default, because a
                   test suite is the slow half and a warm-up is the fast one.
  --target <name>  'deploy' only. Must name a key of project.targets. Required,
                   with no default ever -- not even when there is exactly one.
                   It is checked BEFORE the lane and the verb, so a line that
                   gets both wrong is told about the target first.
  --write          'detect' only. Writes nen/contract.json when there is none.
                   There is no --force and no merge.
  --install        'tools' only. THE ONE FLAG IN THIS FAMILY THAT CHANGES THE
                   HOST rather than a repository. It acts only for entries whose
                   declared installer is enabled in this release (${ENABLED_INSTALLER_IDS})
                   and nothing else, and only at the version the declaration
                   itself pins. Never sudo, never an elevation, never a
                   PATH or shell-profile edit, never a URL nen invented, never
                   a project's own dependency install (that is a precondition
                   nen asserts and never performs). Every other declared
                   installer is reported as work for a human, with the pin.
                   What it installed is RE-PROBED afterwards: an installer that
                   exited 0 has not said the tool is on this PATH.
                   ON win32 THE ENABLED INSTALLER IS REFUSED, with the exact
                   commands to run by hand: there it is a batch shim, and this
                   binary's one subprocess seam never uses a shell -- a runtime
                   that refuses to start a batch file without one fails, and a
                   runtime that starts it anyway starts it through the command
                   interpreter, which re-parses the argv nen assembled. nen will
                   not guess which; the CHECK is unaffected on every host.
                   WITH --only IT REFUSES AT 2 when the narrowed set has no
                   installer nen runs -- before any probe, quoting each row's
                   own way out: that line would otherwise exit 0 having done
                   nothing it was asked to. A FULL --install still exits 0 when
                   everything nen could install passes, and the report's
                   summary.notInstallable (plus a footer) says how many tools
                   are still missing that nen will not install.
  --json           On every verb that executes one, the report as one object,
                   keys in order:
                   { contract, lane, stack, verb, steps, cwd, env, host,
                     preconditions, exitCode, durationMs, artifacts, log }.
                   On 'warmup' it is a different contract again
                   ('${WARMUP_CONTRACT}'), keys in order:
                   { contract, repo, trunk, remote, branch, discard, steps,
                     lane, exitCode }, where each steps[] row is
                   { kind, argv, exitCode, durationMs, note } and 'kind' is
                   git | build | test. 'argv' is the WHOLE command line,
                   executable first, and is EMPTY on the row of a delegated
                   verb the executor refused before it rendered one. 'exitCode'
                   and 'durationMs' are null exactly when nothing was run -- a
                   dry run, a step the run never reached, or that same
                   unrendered row -- and 'lane' is null when the repository
                   carries no declaration, which is reported and is not a
                   failure. 'lane' is resolved from the declaration on the
                   BRANCH this verb cut, re-read after the checkout, because
                   the tree the run started in is not the tree the build runs
                   in. A git that could not be STARTED is not a row of
                   nulls: it is the exit-1 'install it, or put it on PATH'
                   refusal, with no document at all.
                   On 'tools' it is a different contract
                   ('nen.shu.tools/v0.1'), keys in order:
                   { contract, lane, stack, mode, summary, tools, exitCode },
                   where summary is
                   { checked, satisfied, missing, wrong, notProbed, installed,
                     refused, notInstallable }
                   and each tools[] row is
                   { name, required, packMinimum, pinned, versionFrom, probe,
                     found, probeOutput, satisfied, state, installer,
                     installCommand, remedy, install, why }.
                   IT CARRIES EVERY VALUE THE TABLE PRINTS: the table is
                   rendered FROM this object, so the two cannot come apart.
                   'state' is present-and-matching | present-but-wrong-version
                   | missing | not-probed -- the last only under --dry-run,
                   where nothing was looked at and 'satisfied' is null.
                   'packMinimum' is ADVISORY: the version nen has been tested
                   against, from the bundled profiles pack. It never moves the
                   exit code. 'installCommand' is non-null only for an
                   installer nen runs and only when there is something to do;
                   'remedy' is the way out IN WORDS for a row with no command,
                   and exactly one of the two is non-null on a row that needs
                   one. 'probeOutput' is the first line an unreadable probe
                   printed, and null on every row whose version WAS read.
                   'install' is what --install ran here -- steps, outcome
                   (installed | failed | skipped) and failure -- and null in
                   every mode that installs nothing; it describes the
                   INSTALLER, never the host, which is why a row can read
                   'installed' and 'missing' at once. A REFUSAL PRINTS NO
                   DOCUMENT: as everywhere else in this CLI, exit 2 is a line
                   on stderr and an empty stdout, so a --json reader never has
                   to tell a report from an error object on one stream.
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
     the pointer and the expectation. On 'warmup', a git step that RAN and
     failed is 1 too, naming it -- and nothing is rolled back: the working copy
     is left exactly as that run reached it, and the report says what did run.
     A DELEGATED 2 IS ALSO 1 THERE, and only there: the executor's 2 means "this
     verb could not be performed as declared" (an unmet precondition, an
     invocation it will not honour), which from warmup's side is a verification
     step that ran and did not pass. Passing it through would say "nen refused
     and changed nothing" of a run that has already fast-forwarded a trunk and
     checked out a branch. The executor's own code is in the report row's note
     and in the sentence on stderr
  2  usage: no declaration, no "project" block, an unknown --lane, a
     placeholder nen cannot substitute, a --target that names no declared
     target, --json on a long-running verb without --dry-run, a path that
     resolves outside the repository, or a PRECONDITION that is not satisfied.
     On 'tools' also: an --only naming a tool the declaration does not carry, a
     'version' in a form nen cannot evaluate, and -- under --install -- a pin
     this release will not act on (a range where the installer activates one
     exact version, or a pin the lane's own manifest contradicts). Every one of
     those is refused BEFORE anything is installed.
     On 'warmup' also: a dirty working copy without --discard (listing every
     path that would be lost), a merge/rebase/cherry-pick still in progress, a
     DETACHED HEAD carrying commits no branch and no remote-tracking ref
     reaches, no '${WARMUP_REMOTE}' remote, a --from that is not a local branch, a
     local trunk that has DIVERGED from ${WARMUP_REMOTE}'s, a --branch that git will
     not accept, a --branch that already exists locally or on ${WARMUP_REMOTE}, and a
     --discard that ran and left the tree still not clean (a nested repository,
     a dirty submodule). Every one of them prints its evidence on stderr.
     THE DOCUMENT FOLLOWS THE MUTATION, not the code: a refusal reached before
     this verb changed anything prints NO document on stdout, as everywhere
     else in this CLI; one reached after it has already discarded work,
     COMPLETED A FETCH or moved a ref prints the report of what it changed, for
     the reason a failed step does -- the caller now holds a repository in a
     state they did not ask for, and 'steps' is the only thing that says which.
     A COMPLETED 'git fetch ${WARMUP_REMOTE}' COUNTS, because it writes objects and
     moves remote-tracking refs -- even though it leaves the working copy, the
     index and every local branch alone, so it is nothing a caller has to
     repair. A diverged trunk, a --branch already on ${WARMUP_REMOTE} and a look-up
     that could not answer are therefore each refused WITH the report; every
     refusal made before the fetch still prints none, except the --discard
     re-read, which already carried one for a destruction of its own. stdout is
     still either empty or exactly one document of the published shape, and
     never an error object
  3  unsupported host -- the verb is real, this machine cannot run it
  4  unsupported verb for THIS LANE -- the declaration says so, in its own
     words. The invocation was correct; the answer is a fact about the repo.
     'warmup' passes this through from the build (or test) it delegates
  5  the declared program could not be started at all -- and, on 'tools', the
     CHECK verdict for a host where anything is missing or is not the pinned
     version. Never 1: a missing tool is not a failed build, and a caller that
     retried a 1 would retry forever on a machine that is simply not set up.
     Under --install the code is 0 when everything nen COULD install now
     passes, even if verify-only tools are still absent -- otherwise the
     install form is permanently red on a machine nen can never fix, and the
     question "is this host ready" is what the CHECK and its 5 are for

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
  const report = detect(repoRoot, context.seams.platform);
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

// ── `tools`: the join between the catalogue side and the host side ──────────
//
// WHY THE JOIN IS HERE, IN THE DISPATCHER, AND NOT IN EITHER HALF. `shu tools`
// is split in two because of decision (e2): ./tools.ts reads the profiles pack
// for one advisory column and spawns nothing, while ./probe.ts spawns and
// cannot see the pack. ../profiles/inertness.test.ts computes the rule from the
// SEAM -- a module that imports the runner must reach the pack at no depth --
// so the half that spawns can never be the half that assembles the report, and
// the join has to live in a module that imports no seam.
//
// This file is that module, and it already was one before this verb existed: it
// joins ./detect.ts (which reads the pack) with ./run.ts (which spawns), and
// has done since the family shipped. Putting the join anywhere else would add a
// NEW module that reaches both halves and would have to be argued against the
// same rule from scratch, to buy nothing. What crosses the seam here is a
// STRING that lands in a report column and a `{exe, argv}` built from the
// DECLARATION -- never the other way round: there is no parameter on any
// function in ./probe.ts through which a catalogue value could reach an argv.

interface ToolsOptions {
  readonly lane: string | null;
  readonly only: readonly string[];
  readonly install: boolean;
  readonly dryRun: boolean;
}

/**
 * The host allowlist for `tools`, checked BEFORE the first probe.
 *
 * A verb the declaration restricts to one platform must refuse on the others
 * without spawning anything -- otherwise a Windows-only toolchain check on
 * macOS reports a screenful of missing tools that were never expected to be
 * there, which is a false finding rather than a refusal.
 */
function refuseUnsupportedHost(project: ProjectBlock, platform: string): void {
  const declared = declaredHostsFor(project, "tools");
  if (declared === null || declared.includes(platform)) return;
  throw new ShuRefusal(
    EXIT_UNSUPPORTED_HOST,
    `the declaration restricts this verb to ${declared.join(", ")}; this host is ${platform}. The host is checked BEFORE any probe runs, so nothing was spawned. nen/contract.json states the platforms under project.hosts.`,
  );
}

/**
 * The lane, or null.
 *
 * UNLIKE EVERY OTHER VERB IN THIS FAMILY, A LANE IS OPTIONAL HERE, and that is
 * a property of what `toolchain` is: it hangs off `project`, not off a lane, so
 * a repository with three unrelated builds still has ONE set of host tools. The
 * lane contributes two things and neither is the subject -- the directory the
 * probes run in, and the stack whose tested minimums are shown -- so refusing
 * to answer "is this machine set up" until a caller picks one of three builds
 * would be a refusal with nothing behind it. A named lane must still exist.
 */
function resolveToolsLane(project: ProjectBlock, requested: string | null): string | null {
  if (requested === null) return project.defaultLane;
  if (!Object.prototype.hasOwnProperty.call(project.lanes, requested)) {
    throw new VerbUsageError(
      `--lane '${requested}' is not a lane this repository declares. Declared: ${Object.keys(project.lanes).join(", ")}.`,
    );
  }
  return requested;
}

/** Probe every row, or -- on a dry run -- probe none of them. */
function assessAll(
  context: CommandContext,
  plans: readonly ToolPlan[],
  cwd: string,
  mode: ToolsMode,
  minimums: Readonly<Record<string, string | null>>,
): readonly AssessedTool[] {
  return plans.map((plan): AssessedTool => {
    // A DRY RUN SPAWNS NOTHING AT ALL -- not even a probe. That is this
    // family's own rule for the flag (./run.ts's header) and it is what makes
    // `--dry-run` the one form of this verb ../parse/izanami.ts can certify
    // read-only: the probe argv comes from the target's declaration, so a form
    // that runs it is a form nen cannot vouch for, however harmless a
    // `--version` query looks.
    const observation: Observation =
      mode === "dry-run"
        ? { kind: "not-probed" }
        : probeTool(context.seams, plan.probe, cwd, plan.versionFrom);
    return {
      plan,
      assessment: assess(observation, plan.versionFrom, plan.satisfiedBy),
      packMinimum: minimums[plan.name] ?? null,
      install: null,
    };
  });
}

/**
 * Run what `--install` is allowed to run, then look again.
 *
 * IT RE-PROBES WHAT IT INSTALLED. An installer that exited 0 has said its own
 * step worked; it has not said the tool is on this PATH at the pinned version,
 * and reporting `ok` on the strength of an exit code would be certifying a
 * check nobody made. So the row a caller reads after an install is the row a
 * fresh CHECK would have produced.
 */
function performInstalls(
  context: CommandContext,
  assessed: readonly AssessedTool[],
  cwd: string,
): readonly AssessedTool[] {
  // EVERY REFUSAL FIRES BEFORE THE FIRST INSTALL RUNS. A declaration nen will
  // not act on stops the whole run rather than the tail of it: a host left
  // half-installed is worse than one left alone, and the caller can fix the
  // declaration and run the same line again.
  const refused = refusedInstalls(assessed);
  if (refused.length > 0) {
    throw new VerbUsageError(
      `nothing was installed. ${refused
        .map((entry): string => `${entry.plan.name}: ${entry.plan.install.kind === "refused" ? entry.plan.install.why : ""}`)
        .join(" ")}`,
    );
  }
  const acting = new Set(actionable(assessed));
  return assessed.map((entry): AssessedTool => {
    if (!acting.has(entry) || entry.plan.install.kind !== "runnable") return entry;
    const outcome = runInstallSteps(context.seams, entry.plan.install.steps, cwd);
    if (!outcome.ok) return { ...entry, install: outcome };
    const observation = probeTool(context.seams, entry.plan.probe, cwd, entry.plan.versionFrom);
    return {
      ...entry,
      assessment: assess(observation, entry.plan.versionFrom, entry.plan.satisfiedBy),
      install: outcome,
    };
  });
}

function runTools(context: CommandContext, repoRoot: string, options: ToolsOptions): number {
  const opened = openDeclaration(repoRoot);
  refuseUnsupportedHost(opened.project, context.seams.platform);

  const lane = resolveToolsLane(opened.project, options.lane);
  const declaredLane = lane === null ? undefined : opened.project.lanes[lane];
  const stack = declaredLane?.stack ?? null;
  const cwd =
    declaredLane === undefined
      ? repoRoot
      : insideRepo(repoRoot, declaredLane.cwd, `project.lanes.${lane}.cwd`);

  const plans = narrowTo(
    // THE HOST IS AN ARGUMENT, from the seam, exactly as the allowlist check
    // above takes it: one installer's plan depends on the platform, and a plan
    // read out of `process.platform` could only ever be proved on the platform
    // the suite runs on.
    buildPlans(opened.contract, opened.project, cwd, context.seams.platform),
    options.only,
  );
  const mode: ToolsMode = options.dryRun ? "dry-run" : options.install ? "install" : "check";
  // BEFORE THE FIRST PROBE: a narrowed install that can install nothing is a
  // line whose claim is wrong, and nothing about that depends on the host.
  if (mode === "install") refuseUnactionableNarrowing(plans, options.only);

  if (plans.length === 0) {
    const empty = assembleToolsReport([], lane, stack, mode, 0);
    emit(context.io, context.json, empty, renderToolsReport(empty));
    context.io.err(
      `nothing to check: ${opened.path} declares no project.toolchain and no dependency block, so this repository has not said which host tools it needs. Run '${PROGRAM} shu detect --repo ${repoRoot}' to see what is on disk, then write the toolchain entries by hand -- nen reports a pin a repository states and never invents one.`,
    );
    return 0;
  }

  const minimums = packMinimums(stack);
  const checked = assessAll(context, plans, cwd, mode, minimums);
  const assessed = mode === "install" ? performInstalls(context, checked, cwd) : checked;
  const exitCode = toolsExitCode(assessed, mode);
  // ONE VALUE, BOTH SURFACES. The table is rendered FROM the document rather
  // than beside it, so `--json` cannot quietly become the weaker of the two.
  const report = assembleToolsReport(assessed, lane, stack, mode, exitCode);
  emit(context.io, context.json, report, renderToolsReport(report));
  if (exitCode !== 0) {
    const invocation = `${PROGRAM} shu tools --repo ${repoRoot}${lane === null ? "" : ` --lane ${lane}`}`;
    for (const line of renderAdvice(report, invocation)) context.io.err(line);
  }
  return exitCode;
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
      if (subcommand === "tools") {
        return runTools(context, repoRoot, {
          lane: context.args.values["lane"] ?? null,
          only: commaList(context.args.values["only"]),
          install: context.args.booleans.has("install"),
          dryRun: context.args.booleans.has("dry-run"),
        });
      }

      if (subcommand === "warmup") {
        // `--repo` IS REQUIRED HERE AND NOWHERE ELSE IN THIS FAMILY, because
        // this is the one verb that mutates git state. Every other `shu` verb
        // spawns something inside a directory and can honestly default to the
        // one the caller is standing in; this one fetches into a repository,
        // moves a branch ref and checks out a new branch, and a verb that does
        // that to "wherever this process happens to be" is a verb that will
        // eventually do it to the wrong checkout (zheref/nen#28's rule, applied
        // where the blast radius is largest).
        return runWarmup(
          context,
          assertRepoRoot({
            repoFlag: requireRepoFlag(
              context,
              "It names the working copy this verb cleans, fetches into and cuts a branch in. There is no default: the one verb in this family that mutates git state never picks a repository for you.",
            ),
          }),
          {
            branch: requireValue(
              context.args,
              "branch",
              "'shu warmup' cuts the branch YOU name, from the trunk's fresh tip. Nen never invents a branch name.",
            ),
            from: context.args.values["from"] ?? null,
            discard: context.args.booleans.has("discard"),
            tests: context.args.booleans.has("tests"),
            lane: context.args.values["lane"] ?? null,
            dryRun: context.args.booleans.has("dry-run"),
          },
        );
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
