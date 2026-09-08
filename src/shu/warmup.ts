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
// NOTHING IS ROLLED BACK. A step that fails leaves the tree exactly where it
// got to and says so. The alternative -- undoing the fetch, deleting the
// branch, restoring the files -- is a second mutation performed on a working
// copy whose state nen has just discovered it does not understand, and the
// class of incident that produces is worse than the one it prevents.
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
// contract rather than guessing at it. A refusal the delegate raises (3, 4, 5)
// is passed through as that same code, per zheref/nen#91's §2.13.
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

export type WarmupStepKind = "git" | "build" | "test";

/**
 * One command this run performed, or would perform.
 *
 * `exitCode` and `durationMs` are `null` EXACTLY when nothing was run -- a dry
 * run, or a step the run never reached. A `git` that could not be STARTED at
 * all is not recorded as a step with nulls in it: it raises ../seam/exec.ts's
 * own ToolError instead, so "null means not run" stays a rule with no
 * exceptions in any document this verb emits.
 */
export interface WarmupStep {
  readonly kind: WarmupStepKind;
  /** The whole command line, executable first. */
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
    const argv = renderArgv({ exe: step.argv[0] ?? "", argv: step.argv.slice(1) });
    // Three shapes, and only one of them is a failure -- ./run.ts's own rule.
    // A dry run and an unreached step print the bare argv; a step that ran
    // prints its code and duration.
    const detail =
      step.exitCode !== null
        ? `${argv}  -- exit ${step.exitCode} in ${step.durationMs}ms`
        : ran
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
    return `${entry.indexStatus}${entry.worktreeStatus} ${entry.path}${
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
  readonly code: number;
  /** The delegate's own refusal sentence, or null when it did not refuse. */
  readonly refusal: string | null;
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
    code = runVerb(sub, repoRoot, { verb, lane, dryRun, target: null });
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

  if (captured.length === 0) return { rows: [], code, refusal };
  const report = JSON.parse(captured.join("\n")) as ShuReport;
  const rows = report.steps.map(
    (step, index): WarmupStep => ({
      kind: verb,
      argv: [step.exe, ...step.argv],
      exitCode: step.exitCode,
      durationMs: step.durationMs,
      note:
        index === 0
          ? `the lane's declared '${verb}', run through the executor in this process -- ${PROGRAM} never spawns itself`
          : null,
    }),
  );
  return { rows, code, refusal };
}

// ── refusals ────────────────────────────────────────────────────────────────

/**
 * Every exit-2 refusal, printed as lines on STDERR with an empty stdout.
 *
 * A REFUSAL PRINTS NO DOCUMENT, the same rule `shu tools` publishes: a `--json`
 * reader must never have to tell a report from an error object on one stream.
 * It is printed here rather than thrown as a VerbUsageError because the evidence
 * a caller needs -- the uncommitted paths, the remotes that DO exist -- is a
 * list, and a list folded into one exception message is a list nobody reads.
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
 * A DRY RUN READS NO GIT STATE AT ALL, which is why two of the lines below
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
    ["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"],
    options.discard
      ? "the working-copy check. --discard was given, so whatever this lists is destroyed by the two commands below rather than refused"
      : "the working-copy check. A dirty tree refuses at exit 2 listing what would be lost, unless --discard is given",
  );
  if (options.discard) {
    plan(["checkout", "--", "."], "restores every tracked file, discarding staged and unstaged changes alike");
    plan(
      ["clean", "-fd"],
      "removes untracked files and directories. NEVER -x: an ignored file is this developer's cache, and warmup does not delete it",
    );
  }
  plan(["remote"], `refuses at exit 2 when '${WARMUP_REMOTE}' is not among the remotes this repository knows`);
  plan(
    ["show-ref", "--verify", "--quiet", `refs/heads/${trunk}`],
    options.from === null
      ? `--from was not given, so the trunk is assumed to be '${DEFAULT_TRUNK}'; a real run refuses at exit 2 naming --from when there is no such local branch`
      : "--from names the LOCAL branch this warm-up fast-forwards, and it must already exist",
  );
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
    ["check-ref-format", "--branch", options.branch],
    "git's own name validation. The branch name is the caller's: nen never repairs one into something git will accept",
  );
  plan(
    ["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`],
    "refuses at exit 2 when that name is already a local branch",
  );
  plan(
    ["ls-remote", "--heads", WARMUP_REMOTE, options.branch],
    `refuses at exit 2 when that name is already a branch on ${WARMUP_REMOTE}`,
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
        exitCode = delegated.code;
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
  lane: string | null,
): number {
  const git = gitRunner(context, repoRoot);
  const steps = git.steps;

  const failedStep = (what: string, result: CommandResult, advice: string): number => {
    const report = assemble(repoRoot, options, trunk, lane, steps, 1);
    // THE DOCUMENT IS STILL EMITTED on a failed step, unlike on a refusal: the
    // caller now has a working copy in a state they did not ask for, and the
    // list of what did run is the only thing that says which state that is.
    emit(context.io, context.json, report, renderWarmup(report));
    context.io.err(
      `${PROGRAM} shu warmup: ${what} failed -- ${why(result)}. Nothing is rolled back: the working copy is left exactly as this run reached it, and the report above is the list of what did run. ${advice}`,
    );
    return 1;
  };

  // ── 1. the working copy, on ../wc/classify.ts's fail-closed discipline ────
  const head = git.run(["branch", "--show-current"], null);
  if (head.code !== 0) {
    return refuse(context, [
      `could not read the current branch of ${repoRoot} ('git branch --show-current' answered ${why(head)}).`,
      `--repo must name the working tree of a git repository; warmup fetches into it and cuts a branch in it.`,
    ]);
  }
  const current = head.stdout.trim();
  git.annotate(
    current === ""
      ? "HEAD is DETACHED -- reported, not an error. Warmup cuts its branch from the trunk's fresh tip, so where HEAD sits now decides only how the trunk itself is fast-forwarded"
      : `on '${current}'`,
  );

  const status = git.run(["-c", "core.quotePath=false", "status", "--porcelain=v1", "-z", "-uall"], null);
  if (status.code !== 0) {
    return refuse(context, [
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
    return refuse(context, [
      `the working copy at ${repoRoot} carries ${entries.length} uncommitted path(s), and warmup destroys nothing nobody asked it to.`,
      ...evidence.map((line): string => `  ${line}`),
      `Commit them, stash them, or pass --discard to throw them away -- that runs 'git checkout -- .' and then 'git clean -fd', in that order, printing this same list first.`,
      `Ignored files are NEVER touched: 'git clean' is run without -x, because an ignored file is this developer's cache and not this verb's to delete.`,
    ]);
  }

  // ── 2. --discard, and only on something there is something to discard ────
  if (options.discard && entries.length > 0) {
    const restored = git.run(
      ["checkout", "--", "."],
      `discarding ${entries.length} uncommitted path(s):\n${evidence.map((line): string => `  ${line}`).join("\n")}`,
    );
    if (restored.code !== 0) {
      return failedStep("git checkout -- .", restored, "Nothing was cleaned: the untracked half of the discard runs only after the tracked half succeeds.");
    }
    const cleaned = git.run(
      ["clean", "-fd"],
      "untracked files and directories only. -x is never passed: an ignored file is this developer's cache, and warmup does not delete it",
    );
    if (cleaned.code !== 0) {
      return failedStep("git clean -fd", cleaned, "Tracked files were already restored by the step above it.");
    }
  }

  // ── 3. the remote, named rather than chosen ──────────────────────────────
  const remotes = git.run(["remote"], null);
  if (remotes.code !== 0) {
    return refuse(context, [
      `could not list this repository's remotes ('git remote' answered ${why(remotes)}).`,
      `A remote that could not be looked up is never treated as an absent one, nor as a present one.`,
    ]);
  }
  const known = outputLines(remotes.stdout);
  git.annotate(known.length === 0 ? "no remotes at all" : `remotes: ${known.join(", ")}`);
  if (!known.includes(WARMUP_REMOTE)) {
    return refuse(context, [
      `this repository has no remote named '${WARMUP_REMOTE}', and '${WARMUP_REMOTE}' is the only one warmup fetches from.`,
      known.length === 0 ? `  'git remote' listed none at all.` : `  it knows: ${known.join(", ")}.`,
      `Add it, or point --repo at a checkout that has it. Warmup does not pick a remote for you: which upstream a branch is cut from is a decision, and a warm-up is not where a decision gets made.`,
    ]);
  }

  // ── 4. the trunk, verified before anything is fetched ────────────────────
  const trunkRef = git.run(["show-ref", "--verify", "--quiet", `refs/heads/${trunk}`], null);
  // `show-ref --verify --quiet` reports its verdict AS the exit code: 0 found,
  // 1 not found. Anything above 1 is git failing to answer, and reading that as
  // "not found" would refuse a repository whose trunk is right there.
  if (trunkRef.code > 1) {
    return refuse(context, [
      `could not determine whether '${trunk}' is a local branch ('git show-ref' answered ${why(trunkRef)}).`,
    ]);
  }
  if (trunkRef.code !== 0) {
    return refuse(
      context,
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

  const fetched = git.run(["fetch", WARMUP_REMOTE], null);
  if (fetched.code !== 0) {
    return failedStep(`git fetch ${WARMUP_REMOTE}`, fetched, "Nothing local has changed yet.");
  }

  // ── 5. the fast-forward, refused on a divergence ─────────────────────────
  //
  // Reused from ../release/target.ts, which tests reachability the same way and
  // for the same reason: `merge-base --is-ancestor` reports its verdict AS the
  // exit code (0 ancestor, 1 not) and never on stderr, so a code above 1 is git
  // failing to answer -- an unknown ref, a shallow clone missing history -- and
  // must not be read as "diverged".
  const ancestor = git.run(["merge-base", "--is-ancestor", trunk, `${WARMUP_REMOTE}/${trunk}`], null);
  if (ancestor.code > 1) {
    return refuse(context, [
      `could not test whether the local '${trunk}' is behind ${WARMUP_REMOTE}/${trunk} (${why(ancestor)}).`,
      `This usually means ${WARMUP_REMOTE}/${trunk} does not exist -- the fetch above succeeded, so the branch is not on that remote under that name.`,
    ]);
  }
  if (ancestor.code === 1) {
    return refuse(context, [
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
  if (ff.code !== 0) {
    return failedStep(
      onTrunk ? `git merge --ff-only ${WARMUP_REMOTE}/${trunk}` : `git branch --force ${trunk} ${WARMUP_REMOTE}/${trunk}`,
      ff,
      `${WARMUP_REMOTE}/${trunk} was fetched and is current; the local '${trunk}' is not.`,
    );
  }

  // ── 6. the branch, whose name is the caller's ────────────────────────────
  const nameOk = git.run(["check-ref-format", "--branch", options.branch], null);
  if (nameOk.code !== 0) {
    return refuse(context, [
      `'${options.branch}' is not a branch name git will accept ('git check-ref-format --branch' answered ${why(nameOk)}).`,
      `The name is yours and nen never repairs one -- a branch name is a decision, and a warm-up that silently renamed it would be making that decision for you. The trunk has already been fast-forwarded; re-run with a name git accepts.`,
    ]);
  }

  const existsLocal = git.run(["show-ref", "--verify", "--quiet", `refs/heads/${options.branch}`], null);
  if (existsLocal.code > 1) {
    return refuse(context, [
      `could not determine whether '${options.branch}' already exists locally (${why(existsLocal)}) -- a branch is never created on an unverified name.`,
    ]);
  }
  git.annotate(
    existsLocal.code === 0
      ? `'${options.branch}' is ALREADY a local branch`
      : `no local branch '${options.branch}' -- exit 1 here is the ANSWER, not a failure: 'show-ref --verify --quiet' reports an absent ref as code 1`,
  );
  if (existsLocal.code === 0) {
    return refuse(context, [
      `'${options.branch}' is already a local branch here.`,
      `Warmup creates a branch; it never reuses, resets or force-moves one. Check it out yourself if it is the one you meant, or pass a name that is free.`,
    ]);
  }

  // "Does not exist" is a claim that must be VERIFIED, never assumed from a
  // failed check -- ../tag/cut.ts draws the same line for the same reason: an
  // unreachable remote, an expired credential or a flaky proxy makes this fail
  // without answering the question.
  const existsRemote = git.run(["ls-remote", "--heads", WARMUP_REMOTE, options.branch], null);
  if (existsRemote.code !== 0) {
    return refuse(context, [
      `could not determine whether '${options.branch}' already exists on ${WARMUP_REMOTE} (${why(existsRemote)}) -- a branch is never created on an unverified name.`,
    ]);
  }
  if (existsRemote.stdout.trim() !== "") {
    return refuse(context, [
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

  // ── 7. the verification, delegated ───────────────────────────────────────
  if (lane === null) {
    const report = assemble(repoRoot, options, trunk, lane, steps, 0);
    emit(context.io, context.json, report, renderWarmup(report));
    context.io.err(skippedVerification(repoRoot, options.branch, false));
    return 0;
  }

  for (const verb of verificationVerbs(options.tests)) {
    const delegated = delegate(context, repoRoot, verb, lane, false);
    steps.push(...delegated.rows);
    if (delegated.refusal !== null) {
      context.io.err(`${PROGRAM} shu warmup: the declared '${verb}' verification refused: ${delegated.refusal}`);
    }
    if (delegated.code !== 0) {
      const report = assemble(repoRoot, options, trunk, lane, steps, delegated.code);
      emit(context.io, context.json, report, renderWarmup(report));
      context.io.err(
        `${PROGRAM} shu warmup: the declared '${verb}' did not pass on lane '${lane}'. The git half is done and nothing is rolled back: '${options.branch}' is checked out, cut from a current ${WARMUP_REMOTE}/${trunk}. Fix it and re-run '${PROGRAM} shu ${verb} --repo ${repoRoot} --lane ${lane}' on its own -- warmup has nothing left to do here.`,
      );
      return delegated.code;
    }
  }

  const report = assemble(repoRoot, options, trunk, lane, steps, 0);
  emit(context.io, context.json, report, renderWarmup(report));
  return 0;
}
