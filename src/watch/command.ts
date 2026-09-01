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

const USAGE = `nen watch until -- izanami's loop: fetch, evaluate, report one line, pace, stop.

usage:
  nen watch until --command "<bin> <args...>" [--true-pattern <regex>]
                  [--interval-ms 5000] [--max-iterations <n>] [--cwd <path>]
                  [--error-exit-threshold <n>]

  --command       the observation to repeat, e.g. "gh pr checks 42 --json state".
                  Classified against izanami's read-only table before the FIRST
                  run; a mutating command is refused with 'nen parse izanagi'
                  named instead.
  --true-pattern  a regex tested against the command's stdout. Omit to treat
                  exit code 0 as true (the default a check-style command uses).
                  WHEN GIVEN, a non-zero exit is treated as an OBSERVATION
                  ERROR, not a false reading -- the pattern decides truth, the
                  exit code only decides whether the command's run itself
                  succeeded.
  --error-exit-threshold  WHEN --true-pattern is NOT given (exit-code-as-
                  truth mode), an exit code at or above this is an
                  OBSERVATION ERROR rather than a false reading -- codes 0/1
                  are the ordinary true/false pair most CLIs use; 2 and above
                  usually mean the command itself broke (bad usage, a fatal
                  git error, an unauthenticated gh call), not "not yet".
                  Default 2. Set higher for a command whose own false/pending
                  exit codes exceed 1.
  --interval-ms   pace between observations. Default 5000 -- CI checks move on
                  the order of minutes; a tighter interval just spends quota.
  --max-iterations  a SAFETY bound, not izanagi's mandatory cap (izanami needs
                  none -- it can compound no mistake). Omit for an unbounded
                  watch; three consecutive observation ERRORS stop the run
                  regardless.

Exits 0 when the condition became true, 1 on an error streak or a bound
reached -- a caller piping this into further automation stops rather than
reading a watch that gave up as success.`;

export const watchCommand: Command = {
  name: "watch",
  summary: "Poll a read-only command until its condition holds.",
  usage: USAGE,
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

    const intervalRaw = context.args.values["interval-ms"];
    const intervalMs = intervalRaw === undefined ? 5000 : Number(intervalRaw);
    if (!Number.isInteger(intervalMs) || intervalMs < 0) {
      throw new VerbUsageError("--interval-ms must be a non-negative integer.");
    }
    const maxRaw = context.args.values["max-iterations"];
    const maxIterations = maxRaw === undefined ? undefined : Number(maxRaw);
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
