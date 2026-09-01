// src/effort/command.ts -- `nen effort classify`.

import { readFileSync } from "node:fs";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { classifyEffort, type EffortInput } from "./classify.js";

const USAGE = `nen effort classify -- senkei §3's five-class taxonomy, mechanical half.

usage:
  nen effort classify --input <path.json>

The input file is a JSON array of:
  {"kind":"epic"|"child","issueState":"open"|"closed","stageLabels":[...],
   "modeLabelPresent":bool,"hasPr":bool,"prOpen":bool,"prIsDelivery":bool,
   "integrationBranchAlive":bool,"reviewerVerdictMissing":bool}

Classifies each entry as delivering, building, stalled, queued, idle, or
state-machine-violation (two stage labels at once -- flagged, never resolved
by guessing). 'stalled''s live-signal half (a reviewer job that died mid-run,
a builder that burned its cap) is read from --input's optional
reviewerVerdictMissing rather than fetched here; the mechanical rule
(released, no branch, no PR) still reaches 'stalled' without it.`;

export const effortCommand: Command = {
  name: "effort",
  summary: "Classify an effort against senkei's five-class taxonomy.",
  usage: USAGE,
  flags: { values: ["input"], booleans: [] },
  run(context: CommandContext): number {
    requireSubcommand("effort", context.args, ["classify"]);
    const path = context.args.values["input"];
    if (path === undefined) throw new VerbUsageError("--input <path.json> is required.");

    let inputs: EffortInput[];
    try {
      const parsed: unknown = JSON.parse(readFileSync(path, "utf8").replace(/\r\n/g, "\n"));
      if (!Array.isArray(parsed)) throw new Error("expected a JSON array");
      inputs = parsed as EffortInput[];
    } catch (error) {
      context.io.err(`nen: could not read --input '${path}': ${String(error)}`);
      return 1;
    }

    const results = inputs.map((input): { input: EffortInput; classification: ReturnType<typeof classifyEffort> } => ({
      input,
      classification: classifyEffort(input),
    }));

    if (context.json) {
      context.io.out(JSON.stringify(results.map((r): unknown => ({ ...r.input, ...r.classification })), null, 2));
      return 0;
    }
    for (const { classification } of results) {
      context.io.out(classification.effortClass);
      for (const line of classification.evidence) context.io.out(`  ${line}`);
    }
    return 0;
  },
};
