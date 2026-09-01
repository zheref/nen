// src/watch/verb.ts -- `nen watch until`: izanami's loop, wired to a real
// command and a real (or injected) clock.
//
// THE COMMAND IS CLASSIFIED BEFORE THE FIRST OBSERVATION, using the same
// ../parse/izanami.ts table a `nen parse izanami` call would. A watch that
// happened to be handed a mutating command would otherwise repeat it every
// interval, which is izanagi's shape wearing izanami's name -- so this verb
// refuses, by name, exactly as the skill's §2 requires.

import { defaultRunner, type Runner } from "../exec/seam.js";
import { classifyCommand } from "../parse/izanami.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { watchUntil, type WatchResult } from "./until.js";

const USAGE = `nen watch until -- izanami's loop: fetch, evaluate, report one line, pace, stop.

usage:
  nen watch until --command "<bin> <args...>" [--true-pattern <regex>]
                  [--interval-ms 5000] [--max-iterations <n>] [--cwd <path>]

  --command       the observation to repeat, e.g. "gh pr checks 42 --json state".
                  Classified against izanami's read-only table before the FIRST
                  run; a mutating command is refused with 'nen parse izanagi'
                  named instead.
  --true-pattern  a regex tested against the command's stdout. Omit to treat
                  exit code 0 as true (the default a check-style command uses).
  --interval-ms   pace between observations. Default 5000 -- CI checks move on
                  the order of minutes; a tighter interval just spends quota.
  --max-iterations  a SAFETY bound, not izanagi's mandatory cap (izanami needs
                  none -- it can compound no mistake). Omit for an unbounded
                  watch; three consecutive observation ERRORS stop the run
                  regardless.

Exits 0 when the condition became true, 1 on an error streak or a bound
reached -- a caller piping this into further automation stops rather than
reading a watch that gave up as success.`;

export const watchVerb: Verb = {
  name: "watch",
  summary: "Poll a read-only command until its condition holds.",
  usage: USAGE,
  flags: {
    values: ["command", "true-pattern", "interval-ms", "max-iterations", "cwd"],
    booleans: [],
  },
  run(context: VerbContext): number {
    return runWatch(context, defaultRunner);
  },
};

export function runWatch(context: VerbContext, runner: Runner, sleep?: (ms: number) => void): number {
  const [subcommand] = context.args;
  if (subcommand !== "until") {
    return usage(context.io, `unknown 'watch' subcommand '${subcommand ?? "(none)"}'. Try 'watch until'.`);
  }

  const commandText = context.values["command"];
  if (commandText === undefined || commandText.trim() === "") {
    return usage(context.io, "--command '<bin> <args...>' is required.");
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
  if (bin === undefined) return usage(context.io, "--command is empty.");
  const args = parts.slice(1);

  const truePattern = context.values["true-pattern"];
  const regex = truePattern === undefined ? null : new RegExp(truePattern);

  const intervalRaw = context.values["interval-ms"];
  const intervalMs = intervalRaw === undefined ? 5000 : Number(intervalRaw);
  if (!Number.isInteger(intervalMs) || intervalMs < 0) {
    return usage(context.io, "--interval-ms must be a non-negative integer.");
  }
  const maxRaw = context.values["max-iterations"];
  const maxIterations = maxRaw === undefined ? undefined : Number(maxRaw);
  if (maxIterations !== undefined && (!Number.isInteger(maxIterations) || maxIterations <= 0)) {
    return usage(context.io, "--max-iterations must be a positive integer.");
  }

  const result = watchUntil(runner, {
    request: { bin, args, cwd: context.values["cwd"] },
    isTrue: (observed): boolean => (regex === null ? observed.code === 0 : regex.test(observed.stdout)),
    intervalMs,
    maxIterations,
    sleep,
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

function printOutcome(context: VerbContext, result: WatchResult): void {
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
