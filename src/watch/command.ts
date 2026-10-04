// src/watch/command.ts -- `nen watch until`: izanami's loop, wired to a real
// command and a real (or injected) clock.
//
// THE COMMAND IS CLASSIFIED BEFORE THE FIRST OBSERVATION, using the same
// ../parse/izanami.ts table a `nen parse izanami` call would. A watch that
// happened to be handed a mutating command would otherwise repeat it every
// interval, which is izanagi's shape wearing izanami's name -- so this verb
// refuses, by name, exactly as the skill's §2 requires.
//
// AND IT SPAWNS EXACTLY THE ARGV THAT WAS CLASSIFIED (zheref/nen#288). Through
// v0.17.0 this file split the line on `\s+` itself, AFTER the classifier had
// read it another way -- so a `|` inside a quoted `--jq` refused at the
// classifier's joined-line scan, and a `--jq '.number'` the classifier
// certified reached jq with its quotes still on. classifyWatchCommand now
// tokenises once, with ../parse/command-line.ts, and hands back the argv its
// verdict is about; there is no split in this file to disagree with it.
//
// `--pr <ref> --until <predicate>` IS THE OTHER OBSERVATION (zheref/nen#264):
// no command at all, but nen's own in-process `pr ready` read, polled with the
// same pacing, bound, streak and exit codes. ./pr.ts says why it is native and
// what each predicate reads.

import { classifyWatchCommand } from "../parse/izanami.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import type { CommandResult } from "../seam/exec.js";
import { watchUntil, watchUntilAsync, type WatchResult } from "./until.js";
import { observePr, parsePrPredicate, type PrPredicate } from "./pr.js";
import { defaultDeps, PR_READY_FLAGS, readReady, renderDeclaredExclusions, type PrReadyDeps, type ReadyRead, type ReadyReport } from "../verbs/pr_ready.js";
import { plainLine } from "../cli/plain.js";
import { loadWorkflow } from "../schema/workflow.js";
import { resolveRepoRoot } from "../repo/root.js";
import { PROGRAM } from "../version.js";

const USAGE = `nen watch until -- izanami's loop: fetch, evaluate, report one line, pace, stop.

usage:
  nen watch until --command "<bin> <args...>" [--true-pattern <regex>]
                  [--interval-ms 5000] [--max-iterations <n>] [--cwd <path>]
                  [--error-exit-threshold <n>] [--repo <path>]
  nen watch until --pr <ref> --until checks-settled|review-posted|ready|settled-and-reviewed
                  [--interval-ms 5000] [--max-iterations <n>] [--repo <path>]
                  [<every 'nen pr ready' flag: --gh-repo --reviewers --approvers
                   --round-policy --exclude-run --exclude-check --gates
                   --token-env --require-head>]

  --command       the observation to repeat, e.g. "gh pr checks 42 --json state".
                  Classified against izanami's read-only table before the FIRST
                  run; a mutating command is refused with 'nen parse izanagi'
                  named instead. The observation is spawned DIRECTLY -- no
                  shell -- so <bin> must be a real executable on PATH: a
                  shell builtin ('type', or 'cat'/'test' outside Git Bash's
                  own bin directory) fails at spawn on every observation and
                  the watch stops on the error streak instead of watching.
                  The line is split into arguments with a POSIX shell's
                  QUOTING -- '...' literal, "..." with \\ escaping $ \` " \\,
                  a bare \\ escaping one character -- and nothing expands,
                  and the classifier decides about exactly the arguments that
                  are spawned. So a pipe INSIDE one argument does not refuse
                  by itself: gh pr view 1 --jq '.a[]|.b' and gh api <path>
                  --jq "[.a[]|select(.b)]" are reads. A read whose verdict
                  scans every argument (git log/diff/show/fetch/branch/remote,
                  nen's gated verbs) still refuses an argument carrying one.
                  A | ; & < > ( ) or backtick a shell would ACT on (unquoted),
                  a backtick or $( inside "...", a %, a newline, a NUL byte,
                  an unclosed quote or a trailing \\ refuses, exit 2. ON
                  WINDOWS a metacharacter still refuses wherever it sits,
                  quoted or not, as before: a .cmd/.bat target is re-parsed by
                  cmd.exe, and whether the spawn can resolve one has not been
                  verified there.
  --true-pattern  a regex tested against the command's stdout. Omit to treat
                  exit code 0 as true (the default a check-style command uses).
                  WHEN GIVEN, a non-zero exit is treated as an OBSERVATION
                  ERROR, not a false reading -- the pattern decides truth, the
                  exit code only decides whether the command's run itself
                  succeeded.
  --repo <path>   the checkout whose nen/workflow.json 'monitor' block sets
                  the default pace and bound (below). Default: the current
                  directory.
  --error-exit-threshold  WHEN --true-pattern is NOT given (exit-code-as-
                  truth mode), an exit code at or above this is an
                  OBSERVATION ERROR rather than a false reading -- codes 0/1
                  are the ordinary true/false pair most CLIs use; 2 and above
                  usually mean the command itself broke (bad usage, a fatal
                  git error, an unauthenticated gh call), not "not yet".
                  Default 2. Set higher for a command whose own false/pending
                  exit codes exceed 1.
  --interval-ms   pace between observations. Default: the target repository's
                  nen/workflow.json 'monitor.pollSeconds' (x1000) when that
                  file is present, else 5000 -- CI checks move on the order of
                  minutes; a tighter interval just spends quota.
  --max-iterations  a SAFETY bound, not izanagi's mandatory cap (izanami needs
                  none -- it can compound no mistake). Default: the target's
                  'monitor.maxCycles' when declared (a declared 0 means the
                  watch never runs: exit 1 with nothing observed), else
                  unbounded; three consecutive observation ERRORS stop the run
                  regardless.

  --pr <ref>      INSTEAD of --command (zheref/nen#264): watch one pull request
                  through the SAME in-process read 'nen pr ready <ref>' makes --
                  its ref grammar, its token, its identity resolution, its
                  exclusions and its gate -- so the two never disagree about one
                  snapshot. Every 'pr ready' flag above is read exactly as
                  'pr ready' reads it, and only with --pr. --true-pattern,
                  --error-exit-threshold and --cwd belong to --command and are
                  refused beside --pr (exit 2).
  --until         what --pr waits for, one of:
                    checks-settled  every latest check (after the same
                                    exclusions CON-32(a) applies) has a
                                    verdict -- RED INCLUDED; an empty rollup is
                                    never settled
                    checks-settled  every REPORTED latest check (after the
                                    same exclusions CON-32(a) applies) has a
                                    verdict -- RED INCLUDED; an empty rollup is
                                    never settled. A check that registers only
                                    AFTER the others settle is not waited for:
                                    the rollup cannot name what has not
                                    reported yet
                    review-posted   a CONFIGURED reviewer's round is posted at
                                    the current head -- the gate's own
                                    reviewer set and identities: a review by
                                    its login (on the --reviewers path the
                                    WHOLE login, never a substring), its
                                    definitive round-check run, or on a CON-40
                                    delivery PR its holistic-pass review plus
                                    a green review check at head (as CON-32(b)
                                    reads it). A review from anyone outside
                                    the set wakes nothing; a pending
                                    re-request means not posted yet
                    ready           'pr ready' would answer ready
                    settled-and-reviewed
                                    checks-settled AND (review-posted OR ready)
                  ONLY 'ready' IS A MERGE SIGNAL. checks-settled, review-posted
                  and settled-and-reviewed are WAKES: the caller looks again,
                  and asks 'nen pr ready' (or watches --until ready) before
                  calling anything ready. --json's 'readyAtWake' says what the
                  final read's verdict was, and is not a go either way.
                  A read that could not see -- an unevaluated verdict, an
                  unreadable rollup or reviews array the predicate needs (for
                  'ready', either one on a not-ready read), a --require-head
                  GitHub's head does not match -- is an OBSERVATION ERROR
                  (three in a row stop the watch), never a "not yet". A usage
                  refusal from the read (a malformed ref, no identity source)
                  stops the watch at exit 2 on the first poll. The read's
                  warnings, notes and declared exclusions go to stderr on the
                  first poll and again whenever they change.
                  PACING: --interval-ms is at least 30000 here (lower refuses,
                  exit 2) -- every poll is several GitHub API calls; a
                  monitor.pollSeconds under 30 is raised to 30 and says so.
                  With no --max-iterations and no monitor.maxCycles the watch
                  is bounded at 2 hours' worth of polls, never unbounded.
                  This wakes the caller; it rings nothing -- notification rungs
                  stay the host's.
                  --json adds 'until', 'pr', 'readyAtWake' and 'last' (the
                  final read's verdict, gateLine, judgedHead, warnings, notes,
                  declaredExclusions and settlement: checksSettled,
                  pendingChecks, roundsAtHead [{reviewer, via}]) to the result.

Exits 0 when the condition became true, 1 on an error streak or a bound
reached -- a caller piping this into further automation stops rather than
reading a watch that gave up as success. 2 on a usage error.`;

/** What the `--pr` form reads through; injected so a test never reaches GitHub or sleeps. */
export interface WatchDeps {
  readonly prReady: PrReadyDeps;
  readonly sleep?: (ms: number) => void | Promise<void>;
}

/** The flags that belong to the `--pr` form only -- `pr ready`'s own surface plus `--until`. */
const PR_ONLY_VALUES: readonly string[] = ["until", ...PR_READY_FLAGS.values];
const PR_ONLY_LISTS: readonly string[] = [...PR_READY_FLAGS.lists];
/** The flags that belong to the `--command` form only. */
const COMMAND_ONLY_VALUES: readonly string[] = ["true-pattern", "error-exit-threshold", "cwd"];

export function createWatchCommand(deps: WatchDeps = { prReady: defaultDeps }): Command {
  return {
    name: "watch",
    summary: "Poll a read-only command, or a pull request's readiness facts, until a condition holds.",
    usage: USAGE,
    subcommands: ["until"],
    flags: {
      values: ["command", "true-pattern", "interval-ms", "max-iterations", "cwd", "error-exit-threshold", "pr", ...PR_ONLY_VALUES],
      lists: PR_ONLY_LISTS,
      booleans: [],
    },
    run(context: CommandContext): number | Promise<number> {
      requireSubcommand("watch", context.args, ["until"]);
      if (context.args.values["pr"] !== undefined) return runPr(context, deps);
      return runCommand(context);
    },
  };
}

export const watchCommand: Command = createWatchCommand();

function runCommand(context: CommandContext): number {
  const commandText = context.args.values["command"];
  if (commandText === undefined || commandText.trim() === "") {
    throw new VerbUsageError("--command '<bin> <args...>' or --pr <ref> --until <predicate> is required.");
  }
  refuseForeign(context, [...PR_ONLY_VALUES, ...PR_ONLY_LISTS], "--command");

  // The host that will spawn the argv decides how far the seam may trust a
  // quote -- see classifyWatchCommand's Windows paragraph.
  const verdict = classifyWatchCommand(commandText, context.seams.platform);
  if (verdict.argv === undefined) {
    const { classification } = verdict;
    context.io.err(
      `nen: '${commandText}' classifies as ${classification.classification} (${classification.reason}). izanami watches only; a command that writes needs 'nen parse izanagi <task> until <condition> up to <N>' instead.`,
    );
    return 2;
  }

  const [bin, ...args] = verdict.argv;
  if (bin === undefined) throw new VerbUsageError("--command is empty.");

  const truePattern = context.args.values["true-pattern"];
  const regex = truePattern === undefined ? null : new RegExp(truePattern);

  const pace = readPace(context);
  if (pace === null) return 1;
  const { intervalMs, maxIterations } = pace;

  const thresholdRaw = context.args.values["error-exit-threshold"];
  const errorExitThreshold = thresholdRaw === undefined ? 2 : Number(thresholdRaw);
  if (!Number.isInteger(errorExitThreshold) || errorExitThreshold < 1) {
    throw new VerbUsageError("--error-exit-threshold must be a positive integer.");
  }

  // A permanently-broken observation must never masquerade as "not yet true"
  // (until.ts's own header) -- until.ts's own default isError only catches a
  // missing binary, and this verb is the caller until.ts's header says must
  // supply its own. See the usage text above for the reasoning behind each
  // branch below.
  const isError = (observed: CommandResult): boolean => {
    if (observed.spawnFailed) return true;
    return regex === null ? observed.code >= errorExitThreshold : observed.code !== 0;
  };

  const result = watchUntil(context.seams, {
    request: { command: bin, args, options: { cwd: context.args.values["cwd"] } },
    isTrue: (observed): boolean => (regex === null ? observed.code === 0 : regex.test(observed.stdout)),
    isError,
    intervalMs,
    maxIterations,
    onIteration: context.json
      ? undefined
      : (iteration): void => {
          context.io.out(`[${iteration.iteration}] ${iteration.message}`);
        },
  });

  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
  } else {
    printOutcome(context, result);
  }
  return result.outcome === "condition-true" ? 0 : 1;
}

/** The `--pr` form's pacing floor: every poll is several GitHub API calls (F4 on zheref/nen#264). */
export const PR_MIN_INTERVAL_MS = 30_000;
/** The `--pr` form's bound when neither a flag nor a monitor policy states one (N6). */
export const PR_DEFAULT_BOUND_MS = 2 * 60 * 60 * 1000;

/**
 * `--pr <ref> --until <predicate>` (zheref/nen#264). One `readReady` per
 * observation -- the same function `nen pr ready` prints -- decided by
 * ./pr.ts, paced and bounded as the `--command` form is, with a floor on the
 * pace and a default bound of its own.
 */
async function runPr(context: CommandContext, deps: WatchDeps): Promise<number> {
  const typedRef = context.args.values["pr"] ?? "";
  if (typedRef.trim() === "") throw new VerbUsageError("--pr needs a pull-request reference, e.g. --pr <CODE>#<N> or --pr <N> --gh-repo owner/name.");
  if (context.args.values["command"] !== undefined) {
    throw new VerbUsageError("--pr and --command are two different observations; give one.");
  }
  refuseForeign(context, COMMAND_ONLY_VALUES, "--pr");
  const predicate: PrPredicate = parsePrPredicate(context.args.values["until"]);

  const pace = readPace(context);
  if (pace === null) return 1;
  let intervalMs = pace.intervalMs;
  if (intervalMs < PR_MIN_INTERVAL_MS) {
    if (pace.intervalSource === "flag") {
      throw new VerbUsageError(
        `--interval-ms ${intervalMs} is under the --pr floor of ${PR_MIN_INTERVAL_MS} ms: every poll is several GitHub API calls.`,
      );
    }
    context.io.err(
      `${PROGRAM} watch until: ${pace.intervalSource === "policy" ? "nen/workflow.json's monitor.pollSeconds" : "the default interval"} (${intervalMs} ms) is under the --pr floor; polling every ${PR_MIN_INTERVAL_MS} ms instead.`,
    );
    intervalMs = PR_MIN_INTERVAL_MS;
  }
  // NEVER UNBOUNDED (N6): a flag or the policy states the bound; otherwise two
  // hours' worth of polls at this pace.
  const maxIterations = pace.maxIterations ?? Math.max(1, Math.ceil(PR_DEFAULT_BOUND_MS / intervalMs));

  // `pr ready`'s own input, built from the SAME parsed flags -- the values
  // and repeatable lists it reads pass through untouched, and nothing else
  // does. `json` is deliberately absent: the read is never printed.
  const input = {
    positionals: ["pr", "ready", typedRef],
    values: context.args.values,
    booleans: new Set<string>(),
    lists: context.args.lists,
    repoFlag: context.repoFlag,
  };
  // The final read, for --json's `last`. A box rather than a bare `let`, so
  // the narrowing after the loop is not lost to the closure that assigns it.
  const last: { read: ReadyRead | null } = { read: null };
  // What the read said beside its verdict -- warnings, notes, declared
  // exclusions -- printed on the first poll and whenever it changes (F3).
  let printedContext: string | null = null;
  const result = await watchUntilAsync({
    observe: async () => {
      last.read = await readReady(typedRef, input, deps.prReady);
      if (last.read.kind === "verdict") {
        const lines = contextLines(last.read.report);
        const key = JSON.stringify(lines);
        if (key !== printedContext) {
          printedContext = key;
          for (const line of lines) context.io.err(plainLine(line));
        }
      }
      return observePr(last.read, predicate);
    },
    intervalMs,
    maxIterations,
    ...(deps.sleep === undefined ? {} : { sleep: deps.sleep }),
    onIteration: context.json
      ? undefined
      : (iteration): void => {
          // GitHub-sourced text (check names, the gate line, a head SHA) is
          // plain at the human seam; --json keeps the bytes (F2).
          context.io.out(plainLine(`[${iteration.iteration}] ${iteration.message}`));
        },
  });

  if (context.json) {
    const { read } = last;
    const verdict = read !== null && read.kind === "verdict" ? read : null;
    context.io.out(
      JSON.stringify(
        {
          ...result,
          until: predicate,
          pr: typedRef,
          // What the final read's verdict was when the watch stopped -- NOT a
          // merge signal on its own (F5): only `--until ready` or a fresh
          // `nen pr ready` is. `null` when that read decided no verdict.
          readyAtWake: verdict === null || verdict.report.verdict === "unevaluated" ? null : verdict.report.verdict === "ready",
          last:
            verdict === null
              ? null
              : {
                  verdict: verdict.report.verdict,
                  gateLine: verdict.report.gateLine,
                  judgedHead: verdict.report.judgedHead,
                  warnings: verdict.report.meta.warnings,
                  notes: verdict.report.meta.notes,
                  declaredExclusions: verdict.report.meta.declaredExclusions,
                  settlement: verdict.settlement,
                },
        },
        null,
        2,
      ),
    );
  } else {
    printOutcome(context, result);
  }
  return result.outcome === "condition-true" ? 0 : 1;
}

/** The read's non-verdict context, as `pr ready`'s own renderers word it. */
function contextLines(report: ReadyReport): string[] {
  return [
    ...report.meta.warnings.map((warning): string => `${PROGRAM} watch until: warning: ${warning}`),
    ...report.meta.notes.map((note): string => `${PROGRAM} watch until: note: ${note}`),
    ...renderDeclaredExclusions(report).map((line): string => `${PROGRAM} watch until:${line}`),
  ];
}

/** Refuse, at exit 2, a flag that belongs to the OTHER observation form. */
function refuseForeign(context: CommandContext, names: readonly string[], form: string): void {
  const given = names.filter(
    (name): boolean => context.args.values[name] !== undefined || (context.args.lists[name]?.length ?? 0) > 0,
  );
  if (given.length > 0) {
    throw new VerbUsageError(`${given.map((name): string => `--${name}`).join(", ")} ${given.length === 1 ? "is" : "are"} not read by the ${form} form of 'watch until'.`);
  }
}

/**
 * The pace and the bound, one rule for both forms: a typed flag wins, else the
 * target's declared `monitor` policy, else 5000 ms and unbounded. `null` means
 * a declared `maxCycles: 0` -- the watch never runs, already reported (exit 1).
 */
function readPace(
  context: CommandContext,
): { intervalMs: number; intervalSource: "flag" | "policy" | "default"; maxIterations: number | undefined } | null {
  // THE TARGET'S OWN `monitor` POLICY IS THE DEFAULT PACE (zheref/nen#216).
  // `nen/workflow.json` declares `monitor.pollSeconds` and `monitor.maxCycles`,
  // and through v0.10.0 this verb parsed neither: the file said 300 s and
  // the watch polled every 5 s. A flag still wins -- a caller who types
  // --interval-ms meant it -- and an absent policy keeps the old 5000.
  const monitor = readMonitor(context);
  const intervalRaw = context.args.values["interval-ms"];
  const intervalMs =
    intervalRaw === undefined ? (monitor === null || monitor.pollSeconds === null ? 5000 : monitor.pollSeconds * 1000) : Number(intervalRaw);
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    throw new VerbUsageError("--interval-ms must be a non-negative integer.");
  }
  const maxRaw = context.args.values["max-iterations"];
  const maxIterations =
    maxRaw === undefined ? (monitor === null || monitor.maxCycles === null ? undefined : monitor.maxCycles) : Number(maxRaw);
  if (maxRaw !== undefined && (!Number.isInteger(maxIterations) || (maxIterations as number) <= 0)) {
    throw new VerbUsageError("--max-iterations must be a positive integer.");
  }
  // A DECLARED ZERO IS A LOOP THAT NEVER RUNS -- workflow.ts admits it for
  // exactly that meaning, and reading it as "absent" would make the watch
  // UNBOUNDED, the opposite of what the file says (Copilot review on
  // zheref/nen#217). Nothing is observed; the bound is reported reached.
  if (maxIterations === 0) {
    context.io.err(`${PROGRAM} watch until: nen/workflow.json declares monitor.maxCycles 0 -- the watch never runs. Type --max-iterations to watch anyway.`);
    return null;
  }

  const intervalSource = intervalRaw !== undefined ? "flag" : monitor !== null && monitor.pollSeconds !== null ? "policy" : "default";
  return { intervalMs, intervalSource, maxIterations };
}

/**
 * The target's `monitor` block, or null when the checkout declares no policy
 * file. A present-but-malformed policy throws, exactly as every other reader
 * of that file lets it: a watch paced by a file it could not read is a watch
 * paced by a guess.
 */
function readMonitor(context: CommandContext): { pollSeconds: number | null; maxCycles: number | null } | null {
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const loaded = loadWorkflow(root);
  if (!loaded.present) return null;
  // ONLY WHAT THE FILE DECLARES, KEY BY KEY. `loadWorkflow` fills an absent
  // block with nen's own defaults (300 s, 20 cycles); a watch that read those
  // as the repository's policy would turn a 5-second unbounded watch into a
  // 300-second one that exits after 20 observations, in a repository that
  // said nothing (review finding on zheref/nen#216).
  const raw = loaded.workflow.monitor.raw;
  const declared = (key: "pollSeconds" | "maxCycles"): number | null =>
    typeof raw[key] === "number" ? loaded.workflow.monitor[key] : null;
  const pollSeconds = declared("pollSeconds");
  const maxCycles = declared("maxCycles");
  if (pollSeconds === null && maxCycles === null) return null;
  return { pollSeconds, maxCycles };
}

function printOutcome(context: CommandContext, result: WatchResult): void {
  switch (result.outcome) {
    case "condition-true":
      context.io.out(`condition became true after ${result.iterations.length} observation(s)`);
      return;
    case "error-streak":
      context.io.err("nen: stopped after 3 consecutive observation errors -- a loop that cannot see is not watching");
      return;
    case "max-iterations":
      context.io.err(`nen: stopped at the --max-iterations bound (${result.iterations.length}) without the condition becoming true`);
      return;
  }
}
