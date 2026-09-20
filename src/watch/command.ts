// src/watch/command.ts -- `nen watch until`: izanami's loop, wired to a real
// command and a real (or injected) clock.
//
// THE COMMAND IS CLASSIFIED BEFORE THE FIRST OBSERVATION, using the same
// ../parse/izanami.ts table a `nen parse izanami` call would. A watch that
// happened to be handed a mutating command would otherwise repeat it every
// interval, which is izanagi's shape wearing izanami's name -- so this verb
// refuses, by name, exactly as the skill's §2 requires.

import { classifyCommand } from "../parse/izanami.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import type { CommandResult } from "../seam/exec.js";
import { watchUntil, type WatchResult } from "./until.js";
import { loadWorkflow } from "../schema/workflow.js";
import { resolveRepoRoot } from "../repo/root.js";

const USAGE = `nen watch until -- izanami's loop: fetch, evaluate, report one line, pace, stop.

usage:
  nen watch until --command "<bin> <args...>" [--true-pattern <regex>]
                  [--interval-ms 5000] [--max-iterations <n>] [--cwd <path>]
                  [--error-exit-threshold <n>] [--repo <path>]

  --command       the observation to repeat, e.g. "gh pr checks 42 --json state".
                  Classified against izanami's read-only table before the FIRST
                  run; a mutating command is refused with 'nen parse izanagi'
                  named instead. The observation is spawned DIRECTLY -- no
                  shell -- so <bin> must be a real executable on PATH: a
                  shell builtin ('type', or 'cat'/'test' outside Git Bash's
                  own bin directory) fails at spawn on every observation and
                  the watch stops on the error streak instead of watching.
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
                  'monitor.maxCycles' when declared and non-zero, else
                  unbounded; three consecutive observation ERRORS stop the run
                  regardless.

Exits 0 when the condition became true, 1 on an error streak or a bound
reached -- a caller piping this into further automation stops rather than
reading a watch that gave up as success.`;

export const watchCommand: Command = {
  name: "watch",
  summary: "Poll a read-only command until its condition holds.",
  usage: USAGE,
  subcommands: ["until"],
  flags: {
    values: ["command", "true-pattern", "interval-ms", "max-iterations", "cwd", "error-exit-threshold"],
    booleans: [],
  },
  run(context: CommandContext): number {
    requireSubcommand("watch", context.args, ["until"]);

    const commandText = context.args.values["command"];
    if (commandText === undefined || commandText.trim() === "") {
      throw new VerbUsageError("--command '<bin> <args...>' is required.");
    }

    const classification = classifyCommand(commandText);
    if (classification.classification !== "read-only") {
      context.io.err(
        `nen: '${commandText}' classifies as ${classification.classification} (${classification.reason}). izanami watches only; a command that writes needs 'nen parse izanagi <task> until <condition> up to <N>' instead.`,
      );
      return 2;
    }

    const parts = commandText.trim().split(/\s+/);
    const bin = parts[0];
    if (bin === undefined) throw new VerbUsageError("--command is empty.");
    const args = parts.slice(1);

    const truePattern = context.args.values["true-pattern"];
    const regex = truePattern === undefined ? null : new RegExp(truePattern);

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
      maxRaw === undefined
        ? monitor === null || monitor.maxCycles === null || monitor.maxCycles === 0
          ? undefined
          : monitor.maxCycles
        : Number(maxRaw);
    if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0)) {
      throw new VerbUsageError("--max-iterations must be a positive integer.");
    }

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
  },
};

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
