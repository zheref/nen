// src/shu/warmup.ts -- `nen shu warmup`: the first verb in this family that
// MUTATES git state, and the only one that does.
//
// WHAT IT IS FOR. The two halves of "get me ready to work on this" already
// exist in this CLI and nothing joins them: ../wc/classify.ts and
// ../stage/triage.ts read a working copy, and ./run.ts runs whatever the target
// repository declared. A developer starting a piece of work does both, in a
// fixed order, every time -- clean, fetch, fast-forward the trunk, cut the
// branch, prove the project still builds -- and does it by hand, which is where
// the two mistakes come from: a branch cut from a stale trunk, and a "it was
// broken before I started" nobody can prove.
//
// EVERY STEP REFUSES RATHER THAN GUESSING, and the list of refusals is the
// design. A dirty tree is not cleaned, a diverged trunk is not fast-forwarded
// over, an existing branch is not reused, an absent remote is not invented and
// a branch name is never repaired into one git will accept. Each of those is
// exit 2 with the evidence, because every one of them is a decision that
// belongs to the developer and to nobody else.
//
// EVERY CHECK THAT NEEDS NO MUTATION RUNS BEFORE THE ONE MUTATION THAT
// DESTROYS SOMETHING. `--discard` throws a developer's uncommitted work away,
// so a run that is going to refuse for a reason it could have known up front --
// there is no `origin`, `--from` names no local branch, git will not accept
// `--branch`, that name is already a local branch -- must refuse BEFORE the
// discard and not after it. A mistyped branch name is the cheapest mistake
// there is and it must not cost anybody their afternoon. The only question that
// genuinely cannot be answered before the fetch is "does this name already
// exist on the remote", and a fetch destroys nothing.
//
// AND WHAT RAN IS NOT WHAT HAPPENED. `git clean -fd` exiting 0 does not mean
// the tree is clean: it skips a nested repository by design, and neither it nor
// `git reset --hard` touches a dirty submodule. So the discard RE-READS the
// status afterwards and refuses at 2 listing whatever survived -- the same
// distinction `shu tools --install` draws when it re-probes what it installed.
// An exit code is a statement about a command; only a fresh read is a statement
// about the tree.
//
// NOTHING IS ROLLED BACK. A step that fails leaves the tree exactly where it
// got to and says so. The alternative -- undoing the fetch, deleting the
// branch, restoring the files -- is a second mutation performed on a working
// copy whose state nen has just discovered it does not understand, and the
// class of incident that produces is worse than the one it prevents. What
// follows from that: ONCE THIS RUN HAS CHANGED SOMETHING, EVEN A REFUSAL CARRIES
// THE REPORT. A refusal that mutated nothing prints evidence on stderr and no
// document at all, which is this CLI's rule everywhere; a refusal reached after
// this run has already discarded work, COMPLETED A FETCH or moved a ref prints
// the list of what changed it, for `failedStep`'s reason -- the caller now has a
// repository in a state they did not ask for, and that list is the only thing
// that says which state.
//
// THE ONE EXECUTABLE IS `git`, which is the one this CLI already names
// (../seam/exec.ts's GIT). Everything on the toolchain side comes from the
// TARGET repository's own declaration and is run by ./run.ts, in this process;
// ./purity.test.ts sweeps this file like every other module on the execution
// path, so it cannot learn a build system's name.
//
// IT DELEGATES RATHER THAN RE-IMPLEMENTS. The build/test verification is
// `runVerb` -- the same function `nen shu build` is -- called in this process
// with a capturing sink, never a `spawnSync` of nen calling itself. The capture
// is what keeps `--json` one document AND gives this report the delegate's own
// per-step argv, exit code and duration: ../cli/command.ts's `emit` is the
// reporting seam every verb goes through, so reading it back is reading the
// contract rather than guessing at it. A refusal the delegate raises for a fact
// about the repository (3, 4, 5) is passed through as that same code, per
// zheref/nen#91's §2.13; its 2 is NOT, and ./warmup.test.ts pins why.
//
// A REPOSITORY WITH NO DECLARATION IS NOT A FAILURE. The git half is useful on
// its own -- that was v3's argument for a top-level `prepare`, and it survives
// as behaviour rather than as placement -- so a repository with no `project`
// block gets the branch it asked for, a line saying verification was skipped,
// and exit 0.

import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import type { Io } from "../index.js";
import { GIT, outputLines, ToolError, type CommandResult } from "../seam/exec.js";
import { parseStatusPorcelain, triageStage, type FlagReason, type StatusEntry } from "../stage/triage.js";
import { PROGRAM } from "../version.js";
import { openDeclaration, type OpenedDeclaration } from "./declaration.js";
import { ShuRefusal } from "./exit.js";
import { renderArgv, resolveLane } from "./render.js";
import { runVerb, type ShuReport } from "./run.js";

/** The one versioned contract string this verb publishes. */
export const WARMUP_CONTRACT = "nen.shu.warmup/v0.1";

/**
 * The ONE remote this verb knows, deliberately.
 *
 * A `--remote` flag would have to answer "and what does it mean when the trunk
 * exists on two of them" the day somebody uses it, and the honest answer is
 * that a warm-up is not where that question gets settled. A repository whose
 * upstream is not called `origin` is refused by name, with what `git remote`
 * actually listed, which is a sentence a developer can act on in one step.
 */
export const WARMUP_REMOTE = "origin";

/**
 * The trunk assumed when `--from` is absent, and the ONLY one assumed.
 *
 * It is verified to exist as a local branch before anything is fetched: an
 * assumption that is checked and refused is a default; one that is checked and
 * repaired is a guess.
 */
export const DEFAULT_TRUNK = "main";

/**
 * The three pseudo-refs that mean "git is half-way through something".
 *
 * A working copy in the middle of a merge, a rebase or a cherry-pick is not an
 * ordinary dirty tree: `git checkout -- .` answers "path is unmerged" on it,
 * `git switch -c` refuses or carries the operation onto the new branch, and the
 * way out is that operation's own `--abort` rather than anything this verb does.
 */
export const IN_PROGRESS_REFS: readonly string[] = ["MERGE_HEAD", "REBASE_HEAD", "CHERRY_PICK_HEAD"];

/** The `git <op> --abort` that ends each of them. */
const ABORT_FOR: Readonly<Record<string, string>> = {
  MERGE_HEAD: "git merge --abort",
  REBASE_HEAD: "git rebase --abort",
  CHERRY_PICK_HEAD: "git cherry-pick --abort",
};

export type WarmupStepKind = "git" | "build" | "test";

/**
 * One command this run performed, or would perform.
 *
 * `exitCode` and `durationMs` are `null` EXACTLY when nothing was run -- a dry
 * run, a step the run never reached, or a delegated verb the executor refused
 * before it rendered a single command (whose row then carries an empty `argv`
 * and the executor's own sentence as its note). A `git` that could not be
 * STARTED at all is not recorded as a step with nulls in it: it raises
 * ../seam/exec.ts's own ToolError instead, so "null means not run" stays a rule
 * with no exceptions in any document this verb emits.
 */
export interface WarmupStep {
  readonly kind: WarmupStepKind;
  /** The whole command line, executable first. Empty when nothing was rendered. */
  readonly argv: readonly string[];
  readonly exitCode: number | null;
  readonly durationMs: number | null;
  /** Why this step is here, or what it found. May carry newlines. */
  readonly note: string | null;
}

/**
 * The one value both renderings come from. KEY ORDER IS PART OF THE CONTRACT
 * and ./warmup.test.ts pins it, so a field inserted in the middle is a visible
 * decision rather than a silent reshuffle of somebody's golden file.
 *
 * There is deliberately no `dryRun` boolean, for ./run.ts's reason: the fact a
 * machine reader needs is "was anything executed", and `steps[].exitCode` is
 * already it. Two fields that could disagree about that is one field too many.
 */
export interface WarmupReport {
  readonly contract: string;
  readonly repo: string;
  readonly trunk: string;
  readonly remote: string;
  readonly branch: string;
  readonly discard: boolean;
  readonly steps: readonly WarmupStep[];
  /** The lane the build/test verification ran on, or null when there is no declaration. */
  readonly lane: string | null;
  /** NEN's own exit code, never a tool's. */
  readonly exitCode: number;
}

export interface WarmupOptions {
  readonly branch: string;
  /** The LOCAL trunk to fast-forward, or null for the assumed default. */
  readonly from: string | null;
  readonly discard: boolean;
  readonly tests: boolean;
  readonly lane: string | null;
  readonly dryRun: boolean;
}

// ── rendering ───────────────────────────────────────────────────────────────

const LABEL_WIDTH = 15;

function labelled(label: string, value: string): string {
  return `${`${label}:`.padEnd(LABEL_WIDTH)}${value}`;
}

/**
 * The human rendering, derived from the same report `--json` prints, using
 * ./run.ts's own `would run:` / `ran:` convention and its `renderArgv` quoting.
 *
 * WHICH PREFIX APPLIES IS READ OFF THE DOCUMENT, not passed in beside it. A
 * real run always records the working-copy read with a real exit code before it
 * reaches anything else, and a dry run records nothing with one -- so "did any
 * step actually run" is a property of the steps, and the table cannot come
 * apart from the object it was rendered from.
 */
export function renderWarmup(report: WarmupReport): readonly string[] {
  const ran = report.steps.some((step): boolean => step.exitCode !== null);
  const lines: string[] = [
    labelled("repo", report.repo),
    labelled("remote", report.remote),
    labelled("trunk", report.trunk),
    labelled("branch", report.branch),
    labelled(
      "discard",
      report.discard
        ? "yes -- uncommitted work is thrown away. Ignored files are not touched"
        : "no -- a dirty working copy refuses",
    ),
    labelled("lane", report.lane ?? "(none -- no declaration, so build/test verification was skipped)"),
  ];
  for (const step of report.steps) {
    // FOUR SHAPES, and only one of them is a failure -- ./run.ts's own rule. A
    // dry run and an unreached step print the bare argv; a step that ran prints
    // its code and duration; and a row with NO argv is a delegated verb the
    // executor refused before it rendered a command, which has no command line
    // to print and says so rather than printing an empty one.
    const argv =
      step.argv.length === 0
        ? "(nothing was rendered, so nothing was run)"
        : renderArgv({ exe: step.argv[0] ?? "", argv: step.argv.slice(1) });
    const detail =
      step.exitCode !== null
        ? `${argv}  -- exit ${step.exitCode} in ${step.durationMs}ms`
        : ran && step.argv.length > 0
          ? `${argv}  -- not reached`
          : argv;
    lines.push(labelled(ran ? "ran" : "would run", detail));
    if (step.note !== null) {
      for (const noteLine of step.note.split("\n")) lines.push(`${" ".repeat(LABEL_WIDTH)}${noteLine}`);
    }
  }
  return lines;
}

// ── the working copy, on ../wc/classify.ts's discipline ─────────────────────

/**
 * Flag reasons ../stage/triage.ts produces that mean nothing HERE, dropped
 * rather than printed.
 *
 * `unmentioned-deletion` compares a deleted path against a commit message
 * draft, and this verb has none -- so every deletion would carry it, which is
 * noise on the one list a developer has to read carefully. `out-of-scope`
 * needs declared scope prefixes and there are none. What survives is the half
 * that matters when work is about to be destroyed: a filename shaped like a
 * secret, and a binary.
 */
const IRRELEVANT_HERE: ReadonlySet<FlagReason> = new Set<FlagReason>([
  "unmentioned-deletion",
  "out-of-scope",
]);

/**
 * A path as ONE line, whatever bytes it carries.
 *
 * `core.quotePath=false` plus `-z` is what lets nen read a path with a non-ASCII
 * byte in it without decoding git's own octal escaping -- but it also means a
 * path may contain a NEWLINE, and this list is read line by line by a developer
 * about to lose the files on it. A path printed across two lines reads as two
 * paths, and the second of them is a file that does not exist. So the three
 * whitespace characters that break a line are escaped the way a source file
 * escapes them, and a backslash is escaped first so the rendering is reversible.
 */
export function renderPath(path: string): string {
  return path
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t");
}

/** One line per uncommitted path, with the triage flags that apply. */
export function describeUncommitted(entries: readonly StatusEntry[]): readonly string[] {
  const flagged = new Map(
    triageStage(entries).flagged.map((file): [string, readonly FlagReason[]] => [
      file.path,
      file.reasons.filter((reason): boolean => !IRRELEVANT_HERE.has(reason)),
    ]),
  );
  return entries.map((entry): string => {
    const reasons = flagged.get(entry.path) ?? [];
    return `${entry.indexStatus}${entry.worktreeStatus} ${renderPath(entry.path)}${
      reasons.length === 0 ? "" : `  [${reasons.join(", ")}]`
    }`;
  });
}

// ── the git seam, one place ─────────────────────────────────────────────────

interface Runner {
  readonly steps: WarmupStep[];
  run(argv: readonly string[], note: string | null): CommandResult;
  annotate(note: string): void;
}

function gitRunner(context: CommandContext, cwd: string): Runner {
  const steps: WarmupStep[] = [];
  return {
    steps,
    run(argv, note): CommandResult {
      const started = context.seams.now().getTime();
      const result = context.seams.run(GIT, argv, { cwd });
      const durationMs = context.seams.now().getTime() - started;
      // A git that never started is not a step with nulls in it. `result.code`
      // is meaningless on a spawn failure (../seam/exec.ts's own words), and
      // recording it would break this report's single rule about null. The
      // seam's own error already says the useful sentence -- install it, or put
      // it on PATH -- and ../index.ts turns it into exit 1 with no document.
      if (result.spawnFailed) throw new ToolError(GIT, argv, result);
      steps.push({ kind: "git", argv: [GIT, ...argv], exitCode: result.code, durationMs, note });
      return result;
    },
    annotate(note): void {
      const last = steps[steps.length - 1];
      /* c8 ignore next -- annotate() is only ever called straight after run() */
      if (last === undefined) return;
      steps[steps.length - 1] = { ...last, note: last.note === null ? note : `${last.note}\n${note}` };
    },
  };
}

/** The stderr of a git call that answered, folded to one line. */
function why(result: CommandResult): string {
  return outputLines(result.stderr).join(" ") || `exit ${result.code}`;
}

/** Everything a git call said, on either stream, as lines. */
function said(result: CommandResult): readonly string[] {
  return [...outputLines(result.stdout), ...outputLines(result.stderr)];
}

// ── delegation into the executor ────────────────────────────────────────────

/**
 * Which declared verbs the verification runs, in order.
 *
 * `build` ALWAYS, `test` only on --tests, and never the other way round: a
 * repository whose build is broken has nothing a test run could tell it that
 * the build has not already, and the failing step should be the first one.
 */
function verificationVerbs(tests: boolean): readonly ("build" | "test")[] {
  return tests ? ["build", "test"] : ["build"];
}

interface Delegated {
  readonly rows: readonly WarmupStep[];
  /** WARMUP's code for what the delegate did -- see `mapDelegated`. */
  readonly code: number;
  /** The delegate's own refusal sentence, or null when it did not refuse. */
  readonly refusal: string | null;
}

/**
 * The delegate's exit code, as WARMUP's.
 *
 * 3, 4 and 5 PASS THROUGH UNCHANGED, per zheref/nen#91 §2.13: each of them is a
 * fact about the repository or the host that this verb has no better answer to
 * than the executor's own.
 *
 * 2 DOES NOT. The executor's 2 is "this verb could not be performed as
 * declared" -- an unmet precondition, a declared `cwd` outside the tree, an
 * invocation it will not honour -- and warmup's 2 means something else and
 * incompatible: "nen refused, and changed nothing". Two things go wrong if the
 * code is passed through. The caller's contract breaks -- every 2 in this CLI
 * prints its evidence on stderr and NO document on stdout, and warmup by then
 * has a document it must print, because it has already fast-forwarded a trunk
 * and checked out a branch. And the sentence is false: the invocation WAS
 * right, and re-reading the command line for the mistake finds nothing. From
 * warmup's side this is a verification step that ran and did not pass, which is
 * exactly what 1 means here and everywhere else in the family. The executor's
 * own evidence is on stderr, unchanged, and its code is in the row's note.
 */
export function mapDelegated(code: number): number {
  return code === 2 ? 1 : code;
}

/**
 * Run the lane's declared `build` (or `test`) through ./run.ts, in this
 * process, and read its own report back.
 *
 * THE SINK IS THE POINT. `runVerb` emits through ../cli/command.ts's `emit`,
 * which is the one place every verb in this CLI produces its report -- so a
 * capturing `io.out` plus `json: true` hands back the delegate's exact
 * document: which steps it rendered, what each one exited, how long each took.
 * Re-rendering the invocation here to guess at those would be a second copy of
 * a rendering that is allowed to change, and the two would eventually disagree.
 *
 * ITS STDERR IS NOT CAPTURED. A failing build's own output is the thing a
 * developer needs on screen, and ./run.ts already relays a step's output to
 * stderr under `--json` for exactly this reason: stdout stays one document.
 *
 * A DELEGATE THAT RENDERED NOTHING STILL GETS A ROW. `--tests` against a lane
 * whose declaration seats `test` as unsupported raises before a single command
 * is rendered, and a report whose last row is a SUCCESSFUL build beside an exit
 * code of 4 reads as "the build failed with 4". So the row is synthesised, with
 * an empty argv (nothing was rendered), null code and duration (nothing ran)
 * and the executor's own sentence as its note.
 */
function delegate(
  context: CommandContext,
  repoRoot: string,
  verb: "build" | "test",
  lane: string,
  dryRun: boolean,
): Delegated {
  const captured: string[] = [];
  const sink: Io = { out: (line): void => void captured.push(line), err: context.io.err };
  const sub: CommandContext = {
    args: context.args,
    repoFlag: context.repoFlag,
    json: true,
    io: sink,
    seams: context.seams,
  };

  let code: number;
  let refusal: string | null = null;
  try {
    // `target`/`run` are `deploy`'s and this verb delegates only 'build' and
    // 'test': a warm-up verifies a working copy and never sends one anywhere.
    code = runVerb(sub, repoRoot, { verb, lane, dryRun, target: null, run: false });
  } catch (error) {
    // The family's own codes come back as themselves; a usage refusal is 2, as
    // it is everywhere else. Anything else -- a malformed declaration, say --
    // is not this function's to relabel, and propagates as the failure it is.
    if (error instanceof ShuRefusal) {
      code = error.code;
      refusal = error.message;
    } else if (error instanceof VerbUsageError) {
      code = 2;
      refusal = error.message;
    } else {
      throw error;
    }
  }

  const answered =
    code === 0
      ? null
      : `the executor answered ${code}${
          code === 2
            ? `, which warmup reports as ${mapDelegated(code)}: the declared '${verb}' could not be performed as this repository declares it, which is a step that did not pass rather than a mistake in the command line`
            : ""
        }.${refusal === null ? "" : ` ${refusal}`}`;

  if (captured.length === 0) {
    return {
      rows: [
        {
          kind: verb,
          argv: [],
          exitCode: null,
          durationMs: null,
          note: `the lane's declared '${verb}' -- the executor refused before it rendered a single command, so there is no argv here and nothing ran. ${
            answered ?? ""
          }`.trimEnd(),
        },
      ],
      code,
      refusal,
    };
  }

  const report = JSON.parse(captured.join("\n")) as ShuReport;
  const last = report.steps.length - 1;
  const rows = report.steps.map(
    (step, index): WarmupStep => ({
      kind: verb,
      argv: [step.exe, ...step.argv],
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      note:
        index === 0
          ? `the lane's declared '${verb}', run through the executor in this process -- ${PROGRAM} never spawns itself${
              index === last && answered !== null ? `\n${answered}` : ""
            }`
          : index === last && answered !== null
            ? answered
            : null,
    }),
  );
  return { rows, code, refusal };
}

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * Every exit-2 refusal, printed as lines on STDERR.
 *
 * A REFUSAL THAT CHANGED NOTHING PRINTS NO DOCUMENT, the same rule `shu tools`
 * publishes: a `--json` reader must never have to tell a report from an error
 * object on one stream. It is printed here rather than thrown as a
 * VerbUsageError because the evidence a caller needs -- the uncommitted paths,
 * the remotes that DO exist -- is a list, and a list folded into one exception
 * message is a list nobody reads.
 *
 * A REFUSAL THAT ALREADY CHANGED SOMETHING PRINTS THE REPORT FIRST, which is
 * `failedStep`'s argument and not a second one: stdout still carries exactly
 * one document of the published shape and never an error object, and the caller
 * now holds a working copy in a state they did not ask for. Which state that is
 * lives in `steps`, and nowhere else.
 */
function refuse(context: CommandContext, lines: readonly string[]): number {
  const [first, ...rest] = lines;
  context.io.err(`${PROGRAM} shu warmup: ${first ?? ""}`);
  for (const line of rest) context.io.err(line);
  return 2;
}

/** A branch or trunk name that git would read as an OPTION, refused before it can. */
function guardName(flag: string, value: string): void {
  if (!value.startsWith("-")) return;
  throw new VerbUsageError(
    `${flag} '${value}' starts with '-', which git reads as an option rather than as a ref. Nen passes a caller's ref straight to git with no shell in between, and it will not strip, quote or rename one to make it parse.`,
  );
}

// ── the verb ────────────────────────────────────────────────────────────────

function assemble(
  repoRoot: string,
  options: WarmupOptions,
  trunk: string,
  lane: string | null,
  steps: readonly WarmupStep[],
  exitCode: number,
): WarmupReport {
  return {
    contract: WARMUP_CONTRACT,
    repo: repoRoot,
    trunk,
    remote: WARMUP_REMOTE,
    branch: options.branch,
    discard: options.discard,
    steps,
    lane,
    exitCode,
  };
}

/**
 * The declaration, or null when this repository carries none.
 *
 * `openDeclaration` refuses BOTH absences with a VerbUsageError -- no file, and
 * a file with no `project` block -- and for this verb both are the same
 * reportable fact rather than a failure. A declaration that is PRESENT and
 * malformed raises something else entirely and is not caught here: that is a
 * repository defect, it is exit 1 everywhere else in this CLI, and warming a
 * working copy against a file nen cannot read would be doing half a job
 * silently.
 */
function openProject(repoRoot: string): OpenedDeclaration | null {
  try {
    return openDeclaration(repoRoot);
  } catch (error) {
    if (error instanceof VerbUsageError) return null;
    throw error;
  }
}

export function runWarmup(context: CommandContext, repoRoot: string, options: WarmupOptions): number {
  // THE FLAGS FIRST, BEFORE ANYTHING IS READ OR WRITTEN -- ./run.ts's own
  // ordering rule, and it matters more here than there: a caller who mistyped
  // `--lane` must not have their working copy cleaned before being told so.
  guardName("--branch", options.branch);
  if (options.from !== null) guardName("--from", options.from);

  // THIS READ VALIDATES `--lane` AND NOTHING ELSE. It happens against the tree
  // as it stands BEFORE the fetch, which is not the tree the verification will
  // run in -- the declaration on the trunk's fresh tip is, and `performWarmup`
  // re-opens it there. What a pre-fetch read CAN honestly answer is "is this
  // lane a name this repository has ever declared", and a caller who mistyped
  // one is owed that answer before a single git call rather than after a
  // discard.
  const opened = openProject(repoRoot);
  if (opened === null && options.lane !== null) {
    throw new VerbUsageError(
      `--lane '${options.lane}' was given, but ${repoRoot} declares no lanes at all: it carries no nen/contract.json "project" block. Drop --lane to warm the working copy without a build verification, or run '${PROGRAM} shu detect --repo ${repoRoot}' to see a project block proposed from the markers on disk.`,
    );
  }
  const lane = opened === null ? null : resolveLane(opened.project, options.lane);
  const trunk = options.from ?? DEFAULT_TRUNK;

  return options.dryRun
    ? planWarmup(context, repoRoot, options, trunk, lane)
    : performWarmup(context, repoRoot, options, trunk, lane);
}

/**
 * `--dry-run`: print every command, in order, and run NOTHING -- not even the
 * fetch, and not a single probe.
 *
 * A DRY RUN READS NO GIT STATE AT ALL, which is why three of the lines below
 * carry a note saying what a real run would do differently. The alternative --
 * reading HEAD, or the remotes, to print a more precise plan -- would make the
 * flag's guarantee "runs nothing except the harmless things", and there is no
 * such thing as a list of harmless things somebody else will not eventually add
 * to. ./warmup.test.ts asserts the seam records zero calls for this path.
 */
function planWarmup(
  context: CommandContext,
  repoRoot: string,
  options: WarmupOptions,
  trunk: string,
  lane: string | null,
): number {
  const steps: WarmupStep[] = [];
  const plan = (argv: readonly string[], note: string | null): void =>
    void steps.push({ kind: "git", argv: [GIT, ...argv], exitCode: null, durationMs: null, note });

  plan(
    ["branch", "--show-current"],
    "which branch the checkout is on. Empty output means a detached HEAD, which is reported and is not an error",
  );
  plan(
    ["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"],
    "ONLY on a detached HEAD, which the line above is what tells a real run. It counts commits reachable from HEAD and from no branch and no remote-tracking ref: a non-zero count refuses at exit 2, because 'git switch -c' would orphan exactly those commits and the only record of them left would be the reflog",
  );
  plan(
    ["rev-list", "--ignore-missing", "-1", ...IN_PROGRESS_REFS],
    `is git half-way through something? Any output means a merge, a rebase or a cherry-pick is in progress, and that refuses at exit 2 naming its own --abort: such a tree is not an ordinary dirty one${options.discard ? ", and --discard does not end one" : ""}`,
  );
  plan(
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"],
    options.discard
      ? "the working-copy check. --discard was given, so whatever this lists is destroyed by the two commands below rather than refused"
      : "the working-copy check. A dirty tree refuses at exit 2 listing what would be lost, unless --discard is given",
  );
  plan(["remote"], `refuses at exit 2 when '${WARMUP_REMOTE}' is not among the remotes this repository knows`);
  plan(
    ["show-ref", "--verify", "--quiet", `refs/heads/${trunk}`],
    options.from === null
      ? `--from was not given, so the trunk is assumed to be '${DEFAULT_TRUNK}'; a real run refuses at exit 2 naming --from when there is no such local branch`
      : "--from names the LOCAL branch this warm-up fast-forwards, and it must already exist",
  );
  plan(
    ["check-ref-format", "--branch", options.branch],
    "git's own name validation. The branch name is the caller's: nen never repairs one into something git will accept. It runs HERE, before anything is discarded or fetched, because a mistyped branch name must not cost a caller their uncommitted work",
  );
  plan(
    ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`],
    "refuses at exit 2 when that name is already a local branch -- also before the discard, and for the same reason",
  );
  if (options.discard) {
    plan(
      ["reset", "--hard"],
      "the tracked half of --discard: the index AND the working tree go back to HEAD, so a STAGED change is destroyed too rather than surviving to be carried onto the new branch. HEAD itself is never moved",
    );
    plan(
      ["clean", "-fd"],
      "the untracked half. NEVER -x: an ignored file is this developer's cache, and warmup does not delete it. NEVER a second -f either: that would delete a nested repository, which may carry commits that exist nowhere else",
    );
    plan(
      ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"],
      "the working copy is READ AGAIN. The two commands above exiting 0 is a statement about those commands, not about this tree: neither of them removes a nested repository or a dirty submodule. Anything still listed here refuses at exit 2, naming it",
    );
  }
  plan(["fetch", WARMUP_REMOTE], null);
  plan(
    ["merge-base", "--is-ancestor", trunk, `${WARMUP_REMOTE}/${trunk}`],
    "the divergence test. A local trunk carrying commits the remote one does not refuses at exit 2 rather than being fast-forwarded over",
  );
  plan(
    ["branch", "--force", trunk, `${WARMUP_REMOTE}/${trunk}`],
    `the fast-forward, in the form for a checkout that is NOT on '${trunk}'. On one that is, a real run does 'git merge --ff-only ${WARMUP_REMOTE}/${trunk}' instead -- a dry run reads no git state, so it cannot know which`,
  );
  plan(
    ["ls-remote", "--heads", WARMUP_REMOTE, `refs/heads/${options.branch}`],
    `refuses at exit 2 when that name is already a branch on ${WARMUP_REMOTE}. The ref is spelled in full because ls-remote matches a bare name against the TAIL of every ref on slash boundaries, so '${options.branch}' alone would also match a 'feat/${options.branch}' that is already there`,
  );
  plan(["switch", "-c", options.branch, `${WARMUP_REMOTE}/${trunk}`], null);

  let exitCode = 0;
  if (lane !== null) {
    for (const verb of verificationVerbs(options.tests)) {
      const delegated = delegate(context, repoRoot, verb, lane, true);
      steps.push(...delegated.rows);
      if (delegated.refusal !== null) {
        context.io.err(`${PROGRAM} shu warmup: the declared '${verb}' verification refused: ${delegated.refusal}`);
      }
      if (delegated.code !== 0) {
        // THE PLAN IS STILL PRINTED, and the code is the delegate's mapped one.
        // A dry run whose declared build could not even be RENDERED -- an unmet
        // precondition, an unsupported host -- has found something real, and
        // the caller wants both halves: the commands the git side would run,
        // and the reason the verification half would not.
        exitCode = mapDelegated(delegated.code);
        context.io.err(
          `${PROGRAM} shu warmup: nothing ran, and the declared '${verb}' would not pass on lane '${lane}' as this repository stands (the executor answered ${delegated.code}, reported above; warmup exits ${exitCode}). The git plan above is unaffected; fix that first, or run this without --dry-run once it is.`,
        );
        break;
      }
    }
  }

  const report = assemble(repoRoot, options, trunk, lane, steps, exitCode);
  emit(context.io, context.json, report, renderWarmup(report));
  if (lane === null) context.io.err(skippedVerification(repoRoot, options.branch, true));
  return exitCode;
}

function skippedVerification(repoRoot: string, branch: string, dryRun: boolean): string {
  return `no declaration -- build/test verification skipped. ${repoRoot} carries no nen/contract.json "project" block, so this repository has not said how it is built, and the git half above is the whole of what ${dryRun ? "would run" : "ran"}. That is not a failure: warming a working copy is useful on its own, and this exits 0. Run '${PROGRAM} shu detect --repo ${repoRoot}' to see a project block proposed from the markers on disk${dryRun ? "" : `; '${branch}' is checked out and current`}.`;
}

/** The real run. Every git call goes through one seam, in this order. */
function performWarmup(
  context: CommandContext,
  repoRoot: string,
  options: WarmupOptions,
  trunk: string,
  earlyLane: string | null,
): number {
  const git = gitRunner(context, repoRoot);
  const steps = git.steps;
  let lane = earlyLane;
  // HAS THIS RUN CHANGED THIS REPOSITORY YET? It decides one thing and one
  // only: whether a refusal carries the report. Every mutating step below sets
  // it immediately after the call that succeeded -- the discard, the COMPLETED
  // FETCH (which writes objects and moves remote-tracking refs, even though it
  // leaves the working copy alone) and the fast-forward.
  let mutated = false;

  const report = (exitCode: number): void => {
    const document = assemble(repoRoot, options, trunk, lane, steps, exitCode);
    emit(context.io, context.json, document, renderWarmup(document));
  };

  const failedStep = (what: string, result: CommandResult, advice: string): number => {
    // THE DOCUMENT IS STILL EMITTED on a failed step: the caller now has a
    // working copy in a state they did not ask for, and the list of what did
    // run is the only thing that says which state that is.
    report(1);
    context.io.err(
      `${PROGRAM} shu warmup: ${what} failed -- ${why(result)}. Nothing is rolled back: the working copy is left exactly as this run reached it, and the report above is the list of what did run. ${advice}`,
    );
    return 1;
  };

  /** A refusal, carrying the report exactly when this run has already changed something. */
  const refuseHere = (lines: readonly string[]): number => {
    if (mutated) report(2);
    return refuse(context, lines);
  };

  // ── 1. the working copy, on ../wc/classify.ts's fail-closed discipline ────
  const head = git.run(["branch", "--show-current"], null);
  if (head.code !== 0) {
    return refuseHere([
      `could not read the current branch of ${repoRoot} ('git branch --show-current' answered ${why(head)}).`,
      `--repo must name the working tree of a git repository; warmup fetches into it and cuts a branch in it.`,
    ]);
  }
  const current = head.stdout.trim();
  git.annotate(current === "" ? "HEAD is DETACHED" : `on '${current}'`);

  // A DETACHED HEAD IS REPORTED, BUT NOT UNCONDITIONALLY. `git switch -c` moves
  // away from wherever HEAD is standing, and commits reachable from HEAD and
  // from nothing else are orphaned by that move -- git says "leaving N commits
  // behind" and a caller who is reading nen's output rather than git's never
  // sees it. So the question is asked here, and a non-zero answer refuses.
  if (current === "") {
    const orphans = git.run(["rev-list", "--count", "HEAD", "--not", "--branches", "--remotes"], null);
    if (orphans.code !== 0) {
      return refuseHere([
        `HEAD is detached, and nen could not count the commits that only HEAD reaches ('git rev-list --count' answered ${why(orphans)}).`,
        `A detached HEAD is warmed only once that count is known to be zero: 'git switch -c' would orphan whatever it is, and an unasked question is never answered "none".`,
      ]);
    }
    const count = Number(orphans.stdout.trim());
    if (!Number.isFinite(count)) {
      return refuseHere([
        `HEAD is detached, and 'git rev-list --count' answered something that is not a number ('${orphans.stdout.trim()}').`,
        `A detached HEAD is warmed only once that count is known to be zero.`,
      ]);
    }
    if (count > 0) {
      return refuseHere([
        `HEAD is DETACHED and carries ${count} commit(s) that no branch and no remote-tracking ref reaches.`,
        `Cutting '${options.branch}' from ${WARMUP_REMOTE}/${trunk} moves HEAD away from ${count === 1 ? "that commit" : "those commits"}, and the only record of ${count === 1 ? "it" : "them"} afterwards is this repository's reflog -- which expires. Give ${count === 1 ? "it" : "them"} a branch first ('git branch <name>'), or throw ${count === 1 ? "it" : "them"} away deliberately; warmup will not do either for you.`,
        `A detached HEAD that reaches nothing of its own is warmed normally: where HEAD sits then decides only how the trunk is fast-forwarded.`,
      ]);
    }
    git.annotate(
      `HEAD is DETACHED and reaches no commit of its own -- reported, not an error. Warmup cuts its branch from the trunk's fresh tip, so where HEAD sits now decides only how the trunk itself is fast-forwarded`,
    );
  }

  // ── 1a. is git half-way through something? ───────────────────────────────
  const inProgress = git.run(["rev-list", "--ignore-missing", "-1", ...IN_PROGRESS_REFS], null);
  if (inProgress.code !== 0) {
    return refuseHere([
      `could not tell whether a merge, rebase or cherry-pick is in progress here ('git rev-list' answered ${why(inProgress)}).`,
      `Refusing to treat an unanswered question as a "no" -- warming a working copy in the middle of one of those is how a half-finished merge ends up on a new branch.`,
    ]);
  }
  if (inProgress.stdout.trim() !== "") {
    const which: string[] = [];
    for (const ref of IN_PROGRESS_REFS) {
      const probe = git.run(["rev-parse", "--verify", "--quiet", ref], null);
      if (probe.code === 0) which.push(ref);
    }
    return refuseHere([
      `this working copy is in the middle of an operation${which.length === 0 ? "" : ` (${which.join(", ")} ${which.length === 1 ? "exists" : "exist"})`}, and warmup does not finish or abandon one.`,
      ...which.map((ref): string => `  end it with '${ABORT_FOR[ref] ?? "git status"}', or complete it.`),
      which.length === 0 ? `  'git status' says which one it is.` : `  'git status' says where it got to.`,
      `This is not an ordinary dirty tree and --discard does not clear it: 'git reset --hard' would drop the conflict resolution without ending the operation, and the new branch would inherit it.`,
    ]);
  }

  const status = git.run(["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"], null);
  if (status.code !== 0) {
    return refuseHere([
      `could not read the working copy's status ('git status --porcelain=v1' answered ${why(status)}).`,
      `Refusing to treat an unreadable working copy as a clean one -- that is the reading that would destroy something.`,
    ]);
  }
  const entries = parseStatusPorcelain(status.stdout);
  const evidence = describeUncommitted(entries);
  git.annotate(
    entries.length === 0
      ? "clean -- nothing staged, modified or untracked"
      : `${entries.length} uncommitted path(s)`,
  );

  if (entries.length > 0 && !options.discard) {
    return refuseHere([
      `the working copy at ${repoRoot} carries ${entries.length} uncommitted path(s), and warmup destroys nothing nobody asked it to.`,
      ...evidence.map((line): string => `  ${line}`),
      `Commit them, stash them, or pass --discard to throw them away -- that runs 'git reset --hard' and then 'git clean -fd', in that order, printing this same list first and re-reading the tree afterwards.`,
      `Ignored files are NEVER touched: 'git clean' is run without -x, because an ignored file is this developer's cache and not this verb's to delete.`,
    ]);
  }

  // ── 2. every question that needs no mutation, BEFORE the one that does ───
  //
  // All four of these refuse at exit 2 and all four are answerable from the
  // tree as it stands. Asking them after `--discard` had run would mean a
  // mistyped `--branch` cost the caller their uncommitted work AND left the
  // trunk force-moved, for a refusal that could have been made for free.

  const remotes = git.run(["remote"], null);
  if (remotes.code !== 0) {
    return refuseHere([
      `could not list this repository's remotes ('git remote' answered ${why(remotes)}).`,
      `A remote that could not be looked up is never treated as an absent one, nor as a present one.`,
    ]);
  }
  const known = outputLines(remotes.stdout);
  git.annotate(known.length === 0 ? "no remotes at all" : `remotes: ${known.join(", ")}`);
  if (!known.includes(WARMUP_REMOTE)) {
    return refuseHere([
      `this repository has no remote named '${WARMUP_REMOTE}', and '${WARMUP_REMOTE}' is the only one warmup fetches from.`,
      known.length === 0 ? `  'git remote' listed none at all.` : `  it knows: ${known.join(", ")}.`,
      `Add it, or point --repo at a checkout that has it. Warmup does not pick a remote for you: which upstream a branch is cut from is a decision, and a warm-up is not where a decision gets made.`,
    ]);
  }

  const trunkRef = git.run(["show-ref", "--verify", "--quiet", `refs/heads/${trunk}`], null);
  // `show-ref --verify --quiet` reports its verdict AS the exit code: 0 found,
  // 1 not found. Anything above 1 is git failing to answer, and reading that as
  // "not found" would refuse a repository whose trunk is right there.
  if (trunkRef.code > 1) {
    return refuseHere([
      `could not determine whether '${trunk}' is a local branch ('git show-ref' answered ${why(trunkRef)}).`,
    ]);
  }
  if (trunkRef.code !== 0) {
    return refuseHere(
      options.from === null
        ? [
            `this repository has no local branch '${DEFAULT_TRUNK}', which is the only trunk warmup assumes.`,
            `Name the trunk with --from <branch>. Nen does not infer one from the remote's HEAD, from the branch that happens to be checked out, or from whatever single branch exists -- which trunk a piece of work is cut from is the caller's to state.`,
          ]
        : [
            `--from '${trunk}' is not a local branch of this repository.`,
            `--from names the LOCAL trunk this warm-up fast-forwards, not a remote-tracking ref: warmup updates that branch and then cuts --branch from ${WARMUP_REMOTE}/${trunk}.`,
          ],
    );
  }
  git.annotate(
    options.from === null
      ? `the trunk to fast-forward, assumed because --from was not given`
      : `the trunk to fast-forward, as --from named it`,
  );

  const nameOk = git.run(["check-ref-format", "--branch", options.branch], null);
  if (nameOk.code !== 0) {
    return refuseHere([
      `'${options.branch}' is not a branch name git will accept ('git check-ref-format --branch' answered ${why(nameOk)}).`,
      `The name is yours and nen never repairs one -- a branch name is a decision, and a warm-up that silently renamed it would be making that decision for you. Nothing has been discarded, fetched or moved; re-run with a name git accepts.`,
    ]);
  }

  const existsLocal = git.run(["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`], null);
  if (existsLocal.code > 1) {
    return refuseHere([
      `could not determine whether '${options.branch}' already exists locally (${why(existsLocal)}) -- a branch is never created on an unverified name.`,
    ]);
  }
  git.annotate(
    existsLocal.code === 0
      ? `'${options.branch}' is ALREADY a local branch`
      : `no local branch '${options.branch}' -- exit 1 here is the ANSWER, not a failure: 'show-ref --verify --quiet' reports an absent ref as code 1`,
  );
  if (existsLocal.code === 0) {
    return refuseHere([
      `'${options.branch}' is already a local branch here.`,
      `Warmup creates a branch; it never reuses, resets or force-moves one. Check it out yourself if it is the one you meant, or pass a name that is free. Nothing has been discarded, fetched or moved.`,
    ]);
  }

  // ── 3. --discard: the one destructive step, and it is CHECKED afterwards ─
  if (options.discard && entries.length > 0) {
    // `git reset --hard`, NOT `git checkout -- .`, and the difference is the
    // whole of blocker B1. `checkout -- .` restores the working tree FROM THE
    // INDEX, so a staged change survives in both -- the tree is still dirty and
    // the staged work is carried onto the new branch, silently, by a flag whose
    // entire promise was to destroy it. `reset --hard` puts the index and the
    // working tree back to HEAD in one step. It never moves HEAD (no commit
    // argument), never recurses into a submodule (no --recurse-submodules), and
    // leaves untracked and ignored files alone -- the untracked half is the
    // clean below, and stays there.
    const restored = git.run(
      ["reset", "--hard"],
      `discarding ${entries.length} uncommitted path(s):\n${evidence.map((line): string => `  ${line}`).join("\n")}`,
    );
    mutated = true;
    if (restored.code !== 0) {
      return failedStep("git reset --hard", restored, "Nothing was cleaned: the untracked half of the discard runs only after the tracked half succeeds.");
    }
    const cleaned = git.run(
      ["clean", "-fd"],
      "untracked files and directories only. -x is never passed: an ignored file is this developer's cache, and warmup does not delete it. A second -f is never passed either: that is what would delete a nested repository",
    );
    if (cleaned.code !== 0) {
      return failedStep("git clean -fd", cleaned, "Tracked files were already restored by the step above it.");
    }
    const cleanedSaid = said(cleaned);
    if (cleanedSaid.length > 0) git.annotate(cleanedSaid.map((line): string => `git said: ${line}`).join("\n"));

    // THE TREE IS READ AGAIN, because "the command exited 0" and "the tree is
    // clean" are different claims and only the second one is the promise
    // --discard made. `git clean -fd` skips a nested repository by design and
    // says so (or, in some versions, silently does not even offer it), and
    // neither command touches a dirty submodule.
    const after = git.run(["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"], null);
    if (after.code !== 0) {
      return refuseHere([
        `--discard ran, and the working copy could not be read again afterwards ('git status --porcelain=v1' answered ${why(after)}).`,
        `Refusing to treat an unreadable working copy as a clean one, especially this one: two destructive commands have just run in it and the report above says which.`,
      ]);
    }
    const survivors = parseStatusPorcelain(after.stdout);
    git.annotate(
      survivors.length === 0
        ? "clean -- the discard did what it said"
        : `${survivors.length} path(s) SURVIVED the discard`,
    );
    if (survivors.length > 0) {
      const nested = survivors.some((entry): boolean => entry.path.endsWith("/"));
      return refuseHere([
        `--discard ran and the working copy at ${repoRoot} is STILL not clean: ${survivors.length} path(s) survived it.`,
        ...describeUncommitted(survivors).map((line): string => `  ${line}`),
        ...(cleanedSaid.length === 0
          ? []
          : [`'git clean -fd' said, for its part:`, ...cleanedSaid.map((line): string => `  ${line}`)]),
        `Both commands exited 0, and neither of them destroys these:`,
        `  - a path ending in '/' is a directory git would not descend into, which under -uall means a NESTED REPOSITORY. 'git clean' will not delete one without a second -f, and nen never passes -ff: that directory is a repository and may carry commits that exist nowhere else.${nested ? "" : " (none here)"}`,
        `  - a modified path that is a SUBMODULE is its own repository with its own uncommitted work. 'git reset --hard' is run without --recurse-submodules deliberately: --discard is scoped to the repository --repo names, and never reaches into another one.`,
        `Deal with them yourself and run this again. Nothing has been fetched and no ref has moved -- the only thing this run changed is the tracked and untracked work the two commands above did destroy, which the report above lists.`,
      ]);
    }
  }

  const fetched = git.run(["fetch", WARMUP_REMOTE], null);
  if (fetched.code !== 0) {
    return failedStep(`git fetch ${WARMUP_REMOTE}`, fetched, "Nothing local has changed yet.");
  }
  // A COMPLETED FETCH IS A MUTATION, for the one purpose `mutated` serves. It
  // writes objects into `.git` and moves this repository's remote-tracking
  // refs, so `${WARMUP_REMOTE}/${trunk}` is not the ref it was a moment ago --
  // and every refusal below this line is therefore reached in a repository this
  // run has already changed. Those refusals carry the report for the same
  // reason a failed step does: `steps[]` is the only thing that says the fetch
  // ran. It is NOT a discard and nothing is undone by it -- the working copy,
  // the index and every local branch are untouched, which is what makes a fetch
  // safe to leave behind rather than something a caller must repair.
  mutated = true;

  // ── 4. the fast-forward, refused on a divergence ─────────────────────────
  //
  // Reused from ../release/target.ts, which tests reachability the same way and
  // for the same reason: `merge-base --is-ancestor` reports its verdict AS the
  // exit code (0 ancestor, 1 not) and never on stderr, so a code above 1 is git
  // failing to answer -- an unknown ref, a shallow clone missing history -- and
  // must not be read as "diverged".
  const ancestor = git.run(["merge-base", "--is-ancestor", trunk, `${WARMUP_REMOTE}/${trunk}`], null);
  if (ancestor.code > 1) {
    return refuseHere([
      `could not test whether the local '${trunk}' is behind ${WARMUP_REMOTE}/${trunk} (${why(ancestor)}).`,
      `This usually means ${WARMUP_REMOTE}/${trunk} does not exist -- the fetch above succeeded, so the branch is not on that remote under that name.`,
    ]);
  }
  if (ancestor.code === 1) {
    return refuseHere([
      `the local '${trunk}' has DIVERGED from ${WARMUP_REMOTE}/${trunk}: it carries commits the remote branch does not, so moving it would silently drop them.`,
      `Reconcile it yourself -- rebase it, merge it, or reset it once you have decided which of the two is right -- and run this again. Warmup fast-forwards and never resolves a divergence, because which side wins is not a question a warm-up gets to answer.`,
    ]);
  }
  git.annotate(
    `'${trunk}' is an ancestor of ${WARMUP_REMOTE}/${trunk} -- a fast-forward loses nothing. This step's exit code IS the verdict: 0 ancestor, 1 diverged, and anything above that is git failing to answer`,
  );

  // TWO SHAPES, BECAUSE GIT HAS TWO. A branch that is checked out cannot be
  // moved by `git branch --force`, and a branch that is not checked out cannot
  // be advanced by `git merge`. Which applies is read off the branch this run
  // already looked up, not guessed.
  const onTrunk = current === trunk;
  const ff = git.run(
    onTrunk ? ["merge", "--ff-only", `${WARMUP_REMOTE}/${trunk}`] : ["branch", "--force", trunk, `${WARMUP_REMOTE}/${trunk}`],
    onTrunk
      ? `the checkout is on '${trunk}', so the fast-forward happens in the working tree`
      : `the checkout is not on '${trunk}', so the ref is moved without touching the working tree`,
  );
  mutated = true;
  if (ff.code !== 0) {
    return failedStep(
      onTrunk ? `git merge --ff-only ${WARMUP_REMOTE}/${trunk}` : `git branch --force ${trunk} ${WARMUP_REMOTE}/${trunk}`,
      ff,
      `${WARMUP_REMOTE}/${trunk} was fetched and is current; the local '${trunk}' is not.`,
    );
  }

  // ── 5. the name, on the remote this run has just fetched ─────────────────
  //
  // "Does not exist" is a claim that must be VERIFIED, never assumed from a
  // failed check -- ../tag/cut.ts draws the same line for the same reason: an
  // unreachable remote, an expired credential or a flaky proxy makes this fail
  // without answering the question.
  //
  // THE REF IS SPELLED IN FULL. `ls-remote` matches a bare pattern against the
  // TAIL of each ref on slash boundaries, so `--branch x` against a remote that
  // already has `feat/x` would match `refs/heads/feat/x` and refuse a name that
  // is free. `refs/heads/x` matches only `refs/heads/x`. A pattern is not an
  // injection risk here either: `check-ref-format --branch` has already run,
  // above, and git rejects `*`, `?` and `[` in a branch name.
  const existsRemote = git.run(["ls-remote", "--heads", WARMUP_REMOTE, `refs/heads/${options.branch}`], null);
  if (existsRemote.code !== 0) {
    return refuseHere([
      `could not determine whether '${options.branch}' already exists on ${WARMUP_REMOTE} (${why(existsRemote)}) -- a branch is never created on an unverified name.`,
    ]);
  }
  if (existsRemote.stdout.trim() !== "") {
    return refuseHere([
      `'${options.branch}' already exists on ${WARMUP_REMOTE}.`,
      `Cutting a local branch of that name here would make a second, unrelated history under one name. Pick another, or fetch and check out the one that is already there.`,
    ]);
  }
  git.annotate(`no branch '${options.branch}' on ${WARMUP_REMOTE} either -- the name is free on both sides`);

  const created = git.run(
    ["switch", "-c", options.branch, `${WARMUP_REMOTE}/${trunk}`],
    `cut from ${WARMUP_REMOTE}/${trunk}, the tip this run just fetched`,
  );
  if (created.code !== 0) {
    return failedStep(
      `git switch -c ${options.branch} ${WARMUP_REMOTE}/${trunk}`,
      created,
      `The trunk is current; no branch was created.`,
    );
  }

  // ── 6. the declaration, re-read on the tree that now exists ──────────────
  //
  // THE DECLARATION THE VERIFICATION RUNS AGAINST IS THE ONE ON THIS BRANCH,
  // and this branch did not exist when this run started. Between the two reads
  // sits a fetch, a fast-forward and a checkout: a repository that gained a
  // `project` block on the trunk would otherwise be warmed and reported as
  // "no declaration -- verification skipped" while the block sits right there
  // in the tree, and a lane RENAMED on the trunk would be resolved to a name
  // this checkout no longer has. Both are silent wrong answers, and both are
  // free to avoid -- the file is on disk.
  const after = openProject(repoRoot);
  if (after === null) {
    if (earlyLane !== null) {
      context.io.err(
        `${PROGRAM} shu warmup: the tree this run started in declared a project block (lane '${earlyLane}'), and '${options.branch}' -- cut from ${WARMUP_REMOTE}/${trunk} -- does not. The declaration on the branch is the one that counts, so there is nothing to verify against here.`,
      );
    }
    lane = null;
    report(0);
    context.io.err(skippedVerification(repoRoot, options.branch, false));
    return 0;
  }

  try {
    lane = resolveLane(after.project, options.lane);
  } catch (error) {
    if (!(error instanceof VerbUsageError)) throw error;
    lane = null;
    return refuseHere([
      `the git half is done -- '${options.branch}' is checked out, cut from a current ${WARMUP_REMOTE}/${trunk} -- and the declaration on THAT branch cannot answer the lane: ${error.message}`,
      `The declaration is re-read after the checkout, deliberately: it is the branch's file that says how this repository is built, and the pre-fetch tree's copy of it may be a different file. Re-run '${PROGRAM} shu build --repo ${repoRoot} --lane <one it declares>' on its own -- warmup has nothing left to do here.`,
    ]);
  }
  if (earlyLane === null) {
    context.io.err(
      `${PROGRAM} shu warmup: the tree this run started in declared no project block and '${options.branch}' -- cut from ${WARMUP_REMOTE}/${trunk} -- does. Verifying on lane '${lane}', from the declaration that is on this branch.`,
    );
  } else if (earlyLane !== lane) {
    context.io.err(
      `${PROGRAM} shu warmup: the lane resolved before the fetch was '${earlyLane}' and the declaration on '${options.branch}' resolves '${lane}'. The branch's declaration wins, and the verification below ran on '${lane}'.`,
    );
  }

  // ── 7. the verification, delegated ───────────────────────────────────────
  for (const verb of verificationVerbs(options.tests)) {
    const delegated = delegate(context, repoRoot, verb, lane, false);
    steps.push(...delegated.rows);
    if (delegated.refusal !== null) {
      context.io.err(`${PROGRAM} shu warmup: the declared '${verb}' verification refused: ${delegated.refusal}`);
    }
    if (delegated.code !== 0) {
      const code = mapDelegated(delegated.code);
      report(code);
      context.io.err(
        `${PROGRAM} shu warmup: the declared '${verb}' did not pass on lane '${lane}' (the executor answered ${delegated.code}; warmup exits ${code}). The git half is done and nothing is rolled back: '${options.branch}' is checked out, cut from a current ${WARMUP_REMOTE}/${trunk}. Fix it and re-run '${PROGRAM} shu ${verb} --repo ${repoRoot} --lane ${lane}' on its own -- warmup has nothing left to do here.`,
      );
      return code;
    }
  }

  report(0);
  return 0;
}
