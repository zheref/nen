// src/run/command.ts -- `nen run rerun-failed`.

import { parseTarget } from "../github/target.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { rerunFailed } from "./rerun.js";

const USAGE = `nen run rerun-failed -- re-run a workflow run's failed jobs, senkei's dead-reviewer recovery.

usage:
  nen run rerun-failed --target <owner/name> --run-id <n>

'gh run rerun <n> --failed', exactly. senkei's own instruction: re-run the
failed job when a reviewer job dies mid-run, NEVER re-label to force a
re-vote -- this verb only ever runs the rerun.`;

export const runCommand: Command = {
  name: "run",
  summary: "Re-run a workflow run's failed jobs.",
  usage: USAGE,
  flags: { values: ["target", "run-id"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("run", context.args, ["rerun-failed"]);
    const targetRaw = context.args.values["target"];
    if (targetRaw === undefined) throw new VerbUsageError("--target owner/name is required.");
    const runIdRaw = context.args.values["run-id"];
    const runId = Number(runIdRaw ?? "");
    if (runIdRaw === undefined || !Number.isInteger(runId) || runId <= 0) {
      throw new VerbUsageError("--run-id <n> is required.");
    }

    let target;
    try {
      target = parseTarget(targetRaw);
    } catch (error) {
      context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }
    const result = rerunFailed(context.seams, target, runId);
    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.ok ? 0 : 1;
    }
    context.io.out(result.message);
    return result.ok ? 0 : 1;
  },
};
