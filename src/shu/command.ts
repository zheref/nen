// src/shu/command.ts -- `nen shu ...`, the stack-aware developer verbs.
//
// FIFTEEN VERBS, AND ALL FIFTEEN DO SOMETHING NOW. The family was declared
// whole from day one -- `detect` proposing a declaration, ten verbs executing
// one, and `tools` and `warmup` refusing by name with the release they arrived
// in -- for ../cli/registry.ts's reason: a verb that is absent today and
// appears later changes `nen shu --help` underneath every skill that read it,
// while a verb that refuses with a reason is a contract a caller can already
// write against. Both of those two have since landed, and the mechanism they
// needed is gone rather than left standing empty.
//
// `evidence` IS THE ONE THAT FITS NEITHER SHAPE: it does not run a per-lane
// invocation the way the eleven executing verbs do, and it does not read the
// filesystem for markers the way `detect` does. It reads `project.evidence` --
// a project-level declaration, like `targets` -- and `git diff` through the
// seam, and reports which of the changed files match the declared globs,
// grouped suite -> scene. Nothing it does writes anything, anywhere, ever: it
// has no `--dry-run` because there is nothing a dry run would need to skip.
//
// ONE OF THE FIFTEEN MUTATES GIT STATE, and it is the only one: `warmup`
// (./warmup.ts). Every other verb here either reads, or spawns what the target
// repository declared inside a directory. That asymmetry is why `warmup` alone
// requires `--repo` rather than defaulting to the caller's directory.
//
// WHAT THE FAMILY IS. Most of the verbs below run what the TARGET REPOSITORY
// declares in its own `nen/contract.json`, under `project`. Nen carries no
// build system, no package manager, no test runner and no knowledge of any:
// ./run.ts and ./render.ts contain zero toolchain names and ./purity.test.ts
// fails the build if that ever stops being true. `detect` is the one verb that
// reads the filesystem for markers, and it PROPOSES -- it never writes without
// `--write` and never overwrites a declaration at all. `evidence` is the one
// verb that reads `project` but spawns no DECLARED invocation at all -- only
// `git diff`, a command nen chose, never the repository's own argv.
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
import { coverageAdvisories } from "./coverage-defaults.js";
import { runCoverage } from "./coverage.js";
import { detect, renderDetect, writeProposal } from "./detect.js";
import { readChangedFiles } from "./evidence/diff.js";
import { buildEvidenceReport, renderEvidence } from "./evidence/report.js";
import { ENABLED_INSTALLERS } from "./install.js";
import { probeTool, runInstallSteps } from "./probe.js";
import { declaredHostsFor } from "./render.js";
import { runTestReport } from "./test-report.js";
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
  // `--target` ON THESE TWO NAMES A DEVICE, NOT A DESTINATION: a key of
  // `project.launch` rather than of `project.targets`, and OPTIONAL rather than
  // required. `--run` stays `deploy`'s alone -- these two have always spawned
  // without it, and a gate arriving with a flag would break every script.
  dev: { values: ["lane", "target"], booleans: ["dry-run"] },
  run: { values: ["lane", "target"], booleans: ["dry-run"] },
  deploy: { values: ["lane", "target"], booleans: ["dry-run", "run"] },
  coverage: { values: ["lane", "threshold"], booleans: ["dry-run"] },
  "test-report": { values: ["lane"], booleans: ["dry-run", "from-artifacts"] },
  tools: { values: ["lane", "only"], booleans: ["install", "dry-run"] },
  warmup: { values: ["lane", "branch", "from"], booleans: ["discard", "tests", "dry-run"] },
  // NO --lane, AND NO --dry-run. `project.evidence` is a project-level block,
  // not a per-lane one (like `targets`), and this verb spawns nothing a dry
  // run would need to skip -- `git diff` runs unconditionally, exactly as
  // `nen wc classify`'s own git reads do.
  evidence: { values: ["base"] },
};

/** The fifteen, in the order the design lists them (not alphabetical). */
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
  "test-report",
  "evidence",
  "tools",
  "warmup",
];

/**
 * The eleven that execute a lane's declared invocation in this release.
 *
 * `test-report` IS ON THE LIST THOUGH IT DECLARES NOTHING OF ITS OWN. It runs
 * `project.verbs.<lane>.test` through the same executor and then parses what
 * that run wrote, exactly as `coverage` runs its own row and parses that -- so
 * it spawns the target repository's argv, which is the property this list is
 * read for (../parse/izanami.ts's automation-policy rows, ./command.test.ts's
 * split). Its one read-only form, `--from-artifacts`, spawns nothing at all.
 */
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
  "test-report",
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

--repo is bracketed there because fourteen of the fifteen verbs default it to the
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
              terminal and hands it to the child. With --target <name> it
              launches a declared DEVICE instead: the probe, the verb, then
              the target's after-steps. Bare, it is exactly what it always was.
  run         Start the lane's PRODUCTION build, locally. Also long-running,
              and it takes the same optional --target.
  deploy      Send a build to a declared, NAMED target: --target <name> [--run].
              --target is required and has no default, not even when exactly
              one target exists. Bare, this is a safe, exit-0 plan -- the
              destination substituted into the argv, every precondition
              asserted, nothing sent -- and --run is what acts.
  coverage    Run the lane's coverage command, then PARSE the report it
              produced into one shape: a total, a row per target, and -- with
              --threshold -- whether the number cleared a bar. The report is
              the first path under this verb's 'artifacts' whose format nen
              reads; a lane that names none is exit 1 saying so.
  test-report Run the lane's declared 'test', then PARSE the results file
              that run produced: a row per test, and the four counts. The
              report is the first path under the TEST verb's 'artifacts' nen
              recognises -- there is no 'test-report' row to declare, because a
              repository that has said how its tests run has said enough. A
              path with no extension in its last segment is read as a
              DIRECTORY of XML, one file per suite. --from-artifacts reads
              that file and runs nothing at all. A failing suite is still
              parsed, and its failures never move the exit code: that is the
              run's.
  evidence    Match 'git diff --name-status <base>...HEAD' against this
              repository's project.evidence.globs, deriving each survivor's
              suite and scene, and report the survivors grouped suite ->
              scene. Reads git through the seam ONLY -- no declared lane, no
              invocation, nothing spawned that this repository chose. No
              'project.evidence' block is exit 2 naming it; no changed file
              matching a glob is exit 0 with an empty set, never an error.
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
  project.targets       { "<name>": { args, requiresEnv, unsupported, why } },
                        the deploy destinations. --target must name a key of
                        it. A --target that names none is exit 2 listing what
                        IS declared -- accepting the flag's mere presence would
                        make it a formality satisfied by any word. The COMMAND
                        stays in project.verbs.<lane>.deploy, where every other
                        verb's command is; a target says where that command
                        sends it:
                          args         appended to that argv, in order. Refused
                                       on a multi-step row: which step reaches
                                       the destination is a guess.
                          requiresEnv  variable NAMES that must be SET,
                                       asserted exactly as a precondition of
                                       kind 'env' is -- the value is never
                                       read, compared, logged or printed. A
                                       credential belongs in the environment;
                                       one written here would be in git.
                          unsupported  this destination has no command line at
                                       all (a provider's git integration, a CI
                                       action). Exit 4, in the repo's words.
  project.launch        { "<name>": { verb, args, device, after, unsupported,
                        why } }, the LAUNCH targets 'dev' and 'run' take. A
                        different block from project.targets and a different
                        vocabulary: that one says where a build is SENT, this
                        one says which DEVICE a local run lands on. --target is
                        OPTIONAL here -- a bare 'dev' runs the lane's declared
                        'dev', as it always has -- and a name this block does
                        not carry is exit 2 listing the ones it does:
                          verb         'dev' or 'run': which long-running verb
                                       this target launches through. Required.
                                       Naming it on the other one is exit 2 --
                                       they are different builds.
                          args         appended to that verb's argv, in order.
                                       Refused on a multi-step row, as a deploy
                                       target's are.
                          device       { name, kind, resolve }. 'name' is
                                       matched EXACTLY against what the probe
                                       printed; nen never picks a device, not
                                       even when there is one. 'resolve' is a
                                       declared { exe, argv } probe whose output
                                       nen searches -- JSON (a 'name' property,
                                       with identifier/id/udid/serial from the
                                       same object, one of its direct children,
                                       or up to two enclosing objects) or plain
                                       lines (the line carrying the name, and
                                       its first token of six-plus characters
                                       that carries a digit). A device the probe
                                       did not name is exit 5 listing what it
                                       DID offer, and a name TWO id-bearing
                                       candidates carry is exit 5 naming both:
                                       plain output has no field boundaries, so
                                       a name that is the beginning of a longer
                                       one matches both rows, and nen picks
                                       neither. 'kind': "simulator" with no
                                       probe resolves the id to the name itself
                                       and spawns nothing; any other device with
                                       no probe is exit 2.
                          after        [{ exe, argv }] run once the verb exits 0,
                                       in order, with {device.id} and {artifact}
                                       substituted -- {artifact} being the FIRST
                                       entry of the verb's own 'artifacts'.
                                       Naming {artifact} on a verb that declares
                                       none, or {device.id} with no device, is
                                       exit 2: a token nothing can fill must not
                                       reach a command line as itself.
                          unsupported  this target has no command line at all.
                                       Exit 4, in the repo's words.

  project.evidence      { globs, mechanism, scene, suiteSuffix } -- what
                        'evidence' matches a changed file against, project-
                        level like 'targets' rather than per-lane. 'globs'
                        (required, at least one) is a list of '*'/'**'/'?'
                        patterns; 'mechanism' (required) is one of
                        public-mirror | files-changed | embedded, the
                        repository's own answer to "how does a survivor reach
                        a human" -- 'evidence' never mirrors, embeds or lists
                        files itself, it only reports which mechanism a later
                        step should use. 'scene' (default "{suite}-{scene}")
                        and 'suiteSuffix' (default "SnapshotTests") are read by
                        a later mirroring step, not by this release of
                        'evidence' itself, which reports 'suite' and 'scene'
                        as separate fields. Absent block: exit 2 naming it.

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
                   NOT READ AT ALL on 'evidence' -- project.evidence is a
                   project-level block, and giving --lane there is refused as
                   a flag this subcommand does not read.
  --base <ref>     'evidence' only, and REQUIRED. The other end of
                   'git diff --name-status <base>...HEAD' -- HEAD is always
                   the checkout's own current commit, never a flag.
  --dry-run        Print every step's exact argv, cwd and env NAMES, and run
                   nothing at all. The argv printed is the argv that would be
                   spawned, from the same rendering -- the thing you approve is
                   the thing that runs. On 'tools' this covers the version
                   PROBES too: a dry run of that verb spawns nothing whatever,
                   which is what makes it the one form of it a watcher can
                   certify read-only. On 'deploy' it is the EXPLICIT spelling
                   of what that verb does anyway without --run, and giving both
                   --run and --dry-run is exit 2. On 'warmup' it prints every git command
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
  --threshold <n>  'coverage' only. A percentage, 0-100. nen compares it
                   against the report's own line coverage and REPORTS
                   'met: true|false'. IT NEVER CHANGES THE EXIT CODE, in
                   either direction: nen does not decide whether a number is
                   good enough. Read 'met' and decide.
  --from-artifacts 'test-report' only. Do not run anything: read the results
                   file the lane's 'test' verb declares under 'artifacts' and
                   parse whatever is on disk. The lane, the verb and the host
                   are resolved exactly as a real run resolves them -- a lane
                   with no declared 'test' is still exit 4 -- because the
                   artifact list is a property of that invocation. nen cannot
                   tell how old the file is, and says so. Giving this together
                   with --dry-run is exit 2: both start nothing and they answer
                   different questions.
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
  --target <name>  On 'dev' and 'run', a key of project.launch: WHICH DEVICE
                   this local run lands on. OPTIONAL there, with no default
                   ever -- a bare 'dev' runs the lane's declared 'dev' exactly
                   as it always has, so a repository declaring its first launch
                   target changes nothing about the line anyone ran yesterday.
                   Given, the verb becomes three things in order: the declared
                   device probe (captured, so nen can read it), the lane's own
                   verb (interactive, as ever, with the target's 'args'
                   appended), and the target's 'after' steps with {device.id}
                   and {artifact} substituted. --dry-run prints all three as
                   'would run:' with the tokens UNFILLED and one 'substitutes:'
                   line saying what each stands for -- nothing is spawned, the
                   probe included, so there is no id for nen to have printed.
                   A verb that never exits never reaches its after-steps; that
                   is what the declaration asked for, and nen backgrounds
                   nothing.
                   On 'deploy' it must name a key of project.targets. Required,
                   with no default ever -- not even when there is exactly one.
                   It is resolved AFTER the lane, the verb, the host and the
                   placeholders, and before the preconditions: a lane whose
                   'deploy' the declaration seats as unsupported answers exit 4
                   with its own reason whatever --target says, because that is
                   true however the line is retyped, while a missing or unknown
                   target is exit 2 naming what IS declared. A target may add
                   'args' (appended to the lane's declared deploy argv, and
                   refused on a multi-step row -- nen will not guess which step
                   reaches the destination), 'requiresEnv' (variable NAMES nen
                   asserts are SET, never reading or printing a value) and
                   'unsupported' (a destination with no command line at all --
                   a provider's git integration, a CI action -- which is exit 4
                   in the repository's own words).
                   IT DOES NOT MEAN "SEND IT": see --run.
  --run            'deploy' only, and REQUIRED before anything is sent. Without
                   it the verb prints the fully resolved plan -- the
                   destination substituted into the argv, the preconditions
                   asserted, every step as 'would run:' -- and starts nothing,
                   at exit 0, exactly as --dry-run does. This is the same
                   dry-run-first gate '${PROGRAM} label apply --run' and
                   '${PROGRAM} wake fire --run' carry, on the one verb in this
                   family whose blast radius is other people's users: every
                   other verb here spawns something inside a directory and can
                   be undone by running it again, and a deploy cannot.
                   --target and --run are INDEPENDENT and both required to act:
                   one says where, the other says now. Giving --run and
                   --dry-run together is exit 2 rather than a guess about which
                   of two contradicting instructions was meant.
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
                   { contract, lane, stack, verb, target, steps, cwd, env,
                     host, preconditions, exitCode, durationMs, artifacts,
                     log }. 'target' is null unless a destination or a device
                   was resolved. On 'deploy' it is { name, args, requiresEnv }
                   -- the destination, what it appended to the argv, and the
                   variable NAMES it requires. Never a value of one. On 'dev'
                   and 'run' with --target it is
                   { name, verb, args, device, probe, after }, where 'device'
                   is { name, kind, id } and 'id' is null exactly when nothing
                   was probed (every dry run), and 'after' carries the steps
                   as they would spawn -- tokens unfilled on a dry run,
                   substituted on a real one. The two shapes are told apart by
                   their own fields ('requiresEnv' against 'device'), with
                   'verb' two keys up saying which to expect. 'steps' on a
                   launch is all three thirds in order: the probe, the verb,
                   the after-steps.
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
                   On 'coverage' it is a FOURTH contract
                   ('nen.shu.coverage/v0.1'), keys in order:
                   { contract, lane, stack, total, targets, threshold, report,
                     exitCode }, where 'total' is
                   { lines: { covered, total, percent } } plus a 'branches'
                   block in the same shape when the tool measures them, and each
                   targets[] row is { name, lines, branches }. 'percent' is
                   COMPUTED from the counts, to two decimals, and is null for a
                   report about no lines -- 0 of 0 is neither 100% nor 0%.
                   'threshold' is { value, met } or null, and 'met' is null when
                   there was no number to compare it with. 'report' is
                   { format, path }: the declared artifact nen actually parsed,
                   or null. A DRY RUN IS TOLD BY exitCode 0 WITH total null --
                   nothing else produces that pair, which is why there is no
                   'dryRun' boolean here either. The EXECUTOR's own report for
                   this verb is rendered to stderr under --json, so stdout stays
                   exactly one document and nothing it produced is lost.
                   On 'test-report' it is a FIFTH contract
                   ('nen.shu.test-report/v0.1'), keys in order:
                   { contract, lane, stack, report, tests, passed, failed,
                     skipped, total, exitCode }, where each tests[] row is
                   { name, suite, status, durationMs } and 'status' is
                   passed | failed | skipped -- three answers, whatever the
                   eight words the formats spell between them. 'suite' is the
                   class, file or target the test is written in, or null;
                   'durationMs' is null where the report states no time.
                   'tests' is in the REPORT's own order (the table prints
                   failures first) and is not always the whole suite: one
                   format states its totals and lists only its failures, so
                   'tests.length' is not another spelling of 'total'. The four
                   counts are null exactly when nothing was parsed. 'report' is
                   { format, path }: the declared artifact nen actually parsed,
                   or null. THE FAILURES NEVER MOVE 'exitCode': it is the run's,
                   and under --from-artifacts, where nothing ran, it is about
                   the READ -- 0 for a report that parsed, however red it was.
                   Read 'failed' and decide.
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
                   On 'evidence' it is a FIFTH contract entirely
                   ('nen.shu.evidence/v0.1'), keys in order:
                   { contract, base, mechanism, rows, suites }. There is no
                   'lane', 'stack', 'steps', 'cwd', 'env' or 'host' -- this verb
                   runs no declared invocation, so none of those questions
                   apply. Each rows[] entry is
                   { suite, scene, path, status }, where 'status' is one of
                   added | modified | deleted | renamed (git's own finer
                   R###/C###/T codes are folded into this set: a copy reports
                   as added, a rename at its NEW path). Each suites[] entry is
                   { suite, scenes }, 'scenes' being the unique scene names
                   under that suite in first-seen order. An empty rows/suites
                   pair is a SUCCESSFUL, exit-0 document -- a branch that
                   changed no evidence, not an error.

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
     target, --run given together with --dry-run, --json on a long-running verb
     without --dry-run, a path that resolves outside the repository, or a
     PRECONDITION that is not satisfied.
     On 'tools' also: an --only naming a tool the declaration does not carry, a
     'version' in a form nen cannot evaluate, and -- under --install -- a pin
     this release will not act on (a range where the installer activates one
     exact version, or a pin the lane's own manifest contradicts). Every one of
     those is refused BEFORE anything is installed.
     On 'evidence' also: a missing "project.evidence" block, naming it -- this
     is the ONE usage refusal that verb has, since it takes no lane and spawns
     no declared invocation for a placeholder or a precondition to apply to.
     No changed file matching a glob is NOT this: it is exit 0 with an empty
     rows/suites set, never an error -- a branch that changed no evidence is
     an ordinary, successful answer to the question this verb asks.
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
     ON A LAUNCH IT IS ALSO THE DEVICE: a --target whose declared device the
     probe did not name (the refusal lists what it DID offer), or named with no
     id nen recognises. Same code for the same reason -- the thing nen was told
     to reach is not on this host, the command line was correct, and the fix is
     to connect, wake or rename something rather than to retype the line.
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

// ── `evidence`: reads git and this repository's own declaration, spawns nothing ──
//
// THE ONE USAGE REFUSAL THIS VERB HAS is a missing "project.evidence" block --
// no lane, no target, no placeholder, so none of ../declaration.ts's other
// refusals apply. A REPOSITORY WITH NO "project" BLOCK AT ALL still refuses at
// ./declaration.ts's own exit 2, naming the file, which is what every other
// verb in this family does too.
function runEvidence(context: CommandContext, repoRoot: string, base: string): number {
  const opened = openDeclaration(repoRoot);
  const evidence = opened.project.evidence;
  if (evidence === null) {
    throw new VerbUsageError(
      `${opened.path} has no "project.evidence" block. 'shu evidence' matches 'git diff --name-status ${base}...HEAD' against globs a repository declares under project.evidence -- globs (at least one), mechanism (public-mirror | files-changed | embedded), and optionally scene/suiteSuffix. Add one, or run this against a repository that declares one.`,
    );
  }
  const changed = readChangedFiles(context.seams, repoRoot, base);
  const document = buildEvidenceReport(evidence, base, changed);
  emit(context.io, context.json, document, renderEvidence(document));
  return 0;
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
  // NOT AN `async` FUNCTION, AND THAT IS DELIBERATE. Three of the fifteen verbs
  // -- `detect`, `tools`, `evidence` -- spawn nothing that has to be WATCHED and
  // stay synchronous under the hood, and one of them is called from another
  // family: ../scaffold/command.ts runs `shu tools` through this very
  // dispatcher and checks that what comes back is a number. Making the whole
  // method async would have turned that check into a permanent failure for a
  // verb whose behaviour did not change. So the synchronous verbs return
  // numbers and the executing ones return the promise ../shu/run.ts now
  // answers with (../cli/command.ts's `run` is typed for exactly this), with
  // one refusal mapping shared by both paths.
  run(context: CommandContext): number | Promise<number> {
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

      if (subcommand === "evidence") {
        return runEvidence(
          context,
          repoRoot,
          requireValue(
            context.args,
            "base",
            "'shu evidence' matches 'git diff --name-status <base>...HEAD' against project.evidence.globs; nen never invents a base to diff against.",
          ),
        );
      }

      if (subcommand === "coverage") {
        // THE JOIN, exactly as `tools` above and for the same rule: the
        // advisory catalogue values are read HERE -- this file imports no seam
        // -- and handed across as strings that can only land in a message.
        // ../profiles/inertness.test.ts is what keeps that a property of the
        // program rather than a sentence in a header.
        return refusalCode(context, subcommand, runCoverage(context, repoRoot, {
          lane: context.args.values["lane"] ?? null,
          dryRun: context.args.booleans.has("dry-run"),
          threshold: context.args.values["threshold"] ?? null,
          advisories: coverageAdvisories(),
        }));
      }

      if (subcommand === "test-report") {
        return refusalCode(context, subcommand, runTestReport(context, repoRoot, {
          lane: context.args.values["lane"] ?? null,
          dryRun: context.args.booleans.has("dry-run"),
          fromArtifacts: context.args.booleans.has("from-artifacts"),
        }));
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
        return refusalCode(context, subcommand, runWarmup(
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
        ));
      }

      // NEVER A DEFAULT TARGET, not even when there is exactly one -- a deploy
      // that picks its own destination is the one mistake in this family whose
      // blast radius is other people's users. THE REQUIREMENT IS NOT CHECKED
      // HERE, though it used to be: a usage gate in front of the declaration
      // made a written `deploy` seat unreachable, because a lane that will
      // never deploy answered "--target is required" instead of its own reason.
      // ./run.ts's `runVerb` header carries the order and the argument.
      return refusalCode(context, subcommand, runVerb(context, repoRoot, {
        verb: subcommand,
        lane: context.args.values["lane"] ?? null,
        dryRun: context.args.booleans.has("dry-run"),
        target: context.args.values["target"] ?? null,
        // AND NEVER AN IMPLIED --run. `refuseForeignFlags` above has already
        // refused this flag on every verb but 'deploy', so reading it
        // unconditionally here cannot turn another verb's line into an action.
        run: context.args.booleans.has("run"),
      }));
    } catch (error) {
      return shuRefusalCode(context, subcommand, error);
    }
  },
};

/**
 * This family's own codes (3/4/5) are RETURNED, not thrown past ../index.ts's
 * `runFamily` -- which maps every error it does not know to 1 or 2, correctly,
 * for every family that has only those.
 *
 * ONE MAPPING FOR BOTH PATHS. A verb that answers synchronously raises through
 * the `try` above; one that answers with a promise REJECTS it, and a `catch`
 * block cannot see that. `refusalCode` below attaches the same mapping to the
 * promise, so a `ShuRefusal` means the same thing whichever half of this
 * dispatcher produced it -- which it did not, for one release, on every
 * executing verb.
 */
function shuRefusalCode(context: CommandContext, subcommand: string, error: unknown): number {
  if (error instanceof ShuRefusal) {
    context.io.err(`${PROGRAM} shu ${subcommand}: ${error.message}`);
    return error.code;
  }
  throw error;
}

/** The same mapping, on the promise an executing verb answers with. */
function refusalCode(
  context: CommandContext,
  subcommand: string,
  pending: Promise<number>,
): Promise<number> {
  return pending.catch((error: unknown): number => shuRefusalCode(context, subcommand, error));
}
