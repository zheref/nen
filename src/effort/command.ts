// src/effort/command.ts -- `nen effort classify`.

import { readFileSync } from "node:fs";
import { resolveRepoRoot } from "../repo/root.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { classifyEffort, EFFORT_CLASSES, TAXONOMY_CLASSES, type EffortInput } from "./classify.js";

const USAGE = `nen effort classify -- senkei §3's five-class taxonomy, mechanical half.

usage:
  nen effort classify --input <path.json>

The input file is a JSON array of:
  {"kind":"epic"|"child","issueState":"open"|"closed","stageLabels":[...],
   "modeLabelPresent":bool,"hasPr":bool,"prOpen":bool,"prIsDelivery":bool,
   "integrationBranchAlive":bool,"reviewerVerdictMissing":bool}

${EFFORT_CLASSES.length} VALUES ARE PRINTABLE, and the taxonomy has ${TAXONOMY_CLASSES.length} of them:
  ${TAXONOMY_CLASSES.join(", ")}.
The other ${EFFORT_CLASSES.length - TAXONOMY_CLASSES.length} are answers ABOUT the taxonomy rather than members of it,
and a caller switching on the class must handle every one:

  state-machine-violation  two stage labels at once -- flagged, never resolved
                           by guessing which is authoritative.
  undecidable              no stage label, no mode label, no PR and no live
                           integration branch: nothing here places the object
                           anywhere in the taxonomy. Reported, never guessed.

The live-signal half of 'stalled' (a reviewer job that died mid-run, a builder
that burned its cap) is read from --input's optional reviewerVerdictMissing
rather than fetched here; the mechanical rule (released, no branch, no PR)
still reaches 'stalled' without it.

Exit 0 whatever the classification, including every one above: a
classification is this verb's ANSWER, and an answer of "these labels contradict
each other" or "nothing places this" is as much an answer as any other.

  --repo <path>    The checkout that --input resolves against. Defaults to
                   the current directory, so a call made from anywhere
                   else needs it: since zheref/nen#100 every path flag on
                   this verb resolves against this root, never against the
                   process's own directory.`;

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
      // // Resolved against --repo's root, one base for every path flag (zheref/nen#100).
      const full = resolveAgainstRepo(resolveRepoRoot({ repoFlag: context.repoFlag }), path);
      const parsed: unknown = JSON.parse(readFileSync(full, "utf8").replace(/\r\n/g, "\n"));
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
