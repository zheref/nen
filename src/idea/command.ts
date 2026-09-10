// src/idea/command.ts -- `nen idea file`.

import { readFileSync } from "node:fs";
import { assertRepoRoot } from "../repo/root.js";
import { resolveAgainstRepo } from "../cli/inputs.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { commaList } from "../cli/comma.js";
import { parseTarget, TargetError, type Target } from "../github/target.js";
import {
  parseCallerToken,
  requireRepoFlag,
  requireSubcommand,
  requireTargetFlag,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import type { FileRequest } from "../issue/file.js";
import { fileIdea } from "./file.js";

const USAGE = `nen idea file -- file an idea issue, then READ IT BACK to verify GitHub stored it as sent.

usage:
  nen idea file --target <owner/name> --repo <path> --title <t>
               --body-file <path> --label a,b --assignee <user>
               [--forbid-family ns:family]

  --forbid-family ns:family
      Label families this invocation declares off-limits, comma-separated.
      Works exactly as 'nen issue file's does -- it is forwarded into the same
      FileRequest -- and refuses (never creates) a label whose family the
      caller declared out of bounds, alongside the taxonomy check every label
      already gets. Caller data: nen carries no repository's own convention
      about which family means what.

Reuses 'nen issue file's own choreography (labels and assignee IN the create
call), then reads the created issue back over the API and compares title,
body and label set against what was submitted. Exits 1 and names every
mismatch on a read-back disagreement -- the create call's own exit code only
confirms the REQUEST succeeded, not that the STORED record matches it.

The read-back also checks WHICH CLASS OF OBJECT answered. Issues and pull
requests share one number sequence and one issues/{n} endpoint, so a
read-back that comes back as a pull request has reached a different object
than the one just filed -- and a comparison against it would report either a
mismatch about a record nobody filed or a false 'read-back OK'. That fails
loudly (exit 1, the issue named), like any other read-back that could not
confirm what it read.`;

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

    // THE SAME REFUSAL THE OTHER FOUR FAMILIES GIVE (zheref/nen#93). This
    // family kept a fifth, differently-shaped copy: a missing --target threw a
    // VerbUsageError already, but a MALFORMED one printed and returned 1 --
    // "the thing you asked for did not work" for what is a typo in a flag. #93
    // settled that for `repo`, `labels`, `pr` and `issue` through
    // `requireTargetFlag` + `parseCallerToken`; leaving this one behind would
    // have made `nen idea file --target not-a-slug` the single verb answering
    // differently from every other verb that takes the flag.
    const target: Target = parseCallerToken(
      (): Target =>
        parseTarget(
          requireTargetFlag(
            context,
            "It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.",
          ),
        ),
      (error: unknown): boolean => error instanceof TargetError,
    );

    // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
    // never silently read as "validate against whatever taxonomy the cwd
    // happens to hold" (zheref/nen#28). Checked with the other required flags,
    // BEFORE the body file is read -- a flag refusal must not wait on I/O.
    const repoFlag = requireRepoFlag(
      context,
      "It is the checkout whose nen/labels.json validates every label in the filing.",
    );

    const bodyFile = context.args.values["body-file"];
    if (bodyFile === undefined) {
      throw new VerbUsageError("--body-file <path> is required; a body typed on the command line is a body nobody reviewed.");
    }
    const root = assertRepoRoot({ repoFlag });
    let submittedBody: string;
    try {
      // Resolved against --repo's root, one base for every path flag
      // (zheref/nen#100). Read RAW: the read-back compares bytes, so
      // normalising here would
      // make nen disagree with itself about what it sent.
      submittedBody = readFileSync(resolveAgainstRepo(root, bodyFile), "utf8");
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
