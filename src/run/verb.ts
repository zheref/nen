// src/run/verb.ts -- `nen run rerun-failed`.

import { defaultRunner, type Runner } from "../exec/seam.js";
import { parseTarget } from "../github/target.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { rerunFailed } from "./rerun.js";

const USAGE = `nen run rerun-failed -- re-run a workflow run's failed jobs, senkei's dead-reviewer recovery.

usage:
  nen run rerun-failed --target <owner/name> --run-id <n>

'gh run rerun <n> --failed', exactly. senkei's own instruction: re-run the
failed job when a reviewer job dies mid-run, NEVER re-label to force a
re-vote -- this verb only ever runs the rerun.`;

export const runVerb: Verb = {
  name: "run",
  summary: "Re-run a workflow run's failed jobs.",
  usage: USAGE,
  flags: { values: ["target", "run-id"], booleans: [] },
  run(context: VerbContext): number {
    return doRun(context, defaultRunner);
  },
};

export function doRun(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  if (subcommand !== "rerun-failed") {
    return usage(context.io, `unknown 'run' subcommand '${subcommand ?? "(none)"}'. Try 'run rerun-failed'.`);
  }
  const targetRaw = context.values["target"];
  if (targetRaw === undefined) return usage(context.io, "--target owner/name is required.");
  const runIdRaw = context.values["run-id"];
  const runId = Number(runIdRaw ?? "");
  if (runIdRaw === undefined || !Number.isInteger(runId) || runId <= 0) {
    return usage(context.io, "--run-id <n> is required.");
  }

  let target;
  try {
    target = parseTarget(targetRaw);
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
  const result = rerunFailed(runner, target, runId);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  context.io.out(result.message);
  return result.ok ? 0 : 1;
}
