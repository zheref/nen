// src/idea/command.ts -- `nen idea file`.

import { readFileSync } from "node:fs";
import { assertRepoRoot } from "../repo/root.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { commaList } from "../cli/comma.js";
import { parseTarget, type Target } from "../github/target.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import type { FileRequest } from "../issue/file.js";
import { fileIdea } from "./file.js";

const USAGE = `nen idea file -- file an idea issue, then READ IT BACK to verify GitHub stored it as sent.

usage:
  nen idea file --target <owner/name> --repo <path> --title <t>
               --body-file <path> --label a,b --assignee <user>

Reuses 'nen issue file's own choreography (labels and assignee IN the create
call), then reads the created issue back over the API and compares title,
body and label set against what was submitted. Exits 1 and names every
mismatch on a read-back disagreement -- the create call's own exit code only
confirms the REQUEST succeeded, not that the STORED record matches it.`;

export const ideaCommand: Command = {
  name: "idea",
  summary: "File an idea issue and verify it read back exactly as submitted.",
  usage: USAGE,
  flags: {
    values: ["target", "title", "body-file", "label", "assignee", "forbid-family"],
    booleans: [],
  },
  run(context: CommandContext): number {
    requireSubcommand("idea", context.args, ["file"]);

    const targetRaw = context.args.values["target"];
    if (targetRaw === undefined) throw new VerbUsageError("--target owner/name is required.");
    let target: Target;
    try {
      target = parseTarget(targetRaw);
    } catch (error) {
      context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    const bodyFile = context.args.values["body-file"];
    if (bodyFile === undefined) {
      throw new VerbUsageError("--body-file <path> is required; a body typed on the command line is a body nobody reviewed.");
    }
    let submittedBody: string;
    try {
      submittedBody = readFileSync(bodyFile, "utf8");
    } catch (error) {
      context.io.err(`nen: could not read --body-file '${bodyFile}': ${String(error)}`);
      return 1;
    }

    const request: FileRequest = {
      title: context.args.values["title"] ?? "",
      bodyFile,
      labels: commaList(context.args.values["label"]),
      assignee: context.args.values["assignee"] ?? "",
      forbiddenFamilies: commaList(context.args.values["forbid-family"]),
    };

    const root = assertRepoRoot({ repoFlag: context.repoFlag });
    const taxonomy = loadLabelTaxonomy(root);
    const result = fileIdea(context.seams, target, request, submittedBody, taxonomy);

    if ("refusals" in result) {
      for (const refusal of result.refusals) context.io.err(`nen: ${refusal.reason}`);
      return 1;
    }

    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.mismatches.length === 0 ? 0 : 1;
    }
    context.io.out(`filed #${result.filed.number} ${result.filed.url}`);
    if (result.mismatches.length === 0) {
      context.io.out("read-back OK -- title, body and labels match what was submitted.");
      return 0;
    }
    context.io.err(`nen: read-back found ${result.mismatches.length} mismatch(es):`);
    for (const mismatch of result.mismatches) {
      context.io.err(`  ${mismatch.field}: expected '${mismatch.expected}', got '${mismatch.actual}'`);
    }
    return 1;
  },
};
