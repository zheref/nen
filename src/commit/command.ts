// src/commit/command.ts -- `nen commit format`.

import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import {
  COMMIT_TYPES,
  formatCommitMessage,
  validateCommitMessage,
  type CommitMessageInput,
  type CommitType,
  type Trailer,
} from "./format.js";

function parseTrailers(value: string | undefined): readonly Trailer[] {
  if (value === undefined || value.trim() === "") return [];
  return value.split(",").map((entry): Trailer => {
    const index = entry.indexOf("=");
    if (index === -1) return { key: entry.trim(), value: "" };
    return { key: entry.slice(0, index).trim(), value: entry.slice(index + 1).trim() };
  });
}

const USAGE = `nen commit format -- Conventional Commits formatting, tensho §4.

usage:
  nen commit format --type feat --subject "a short imperative subject"
                    [--scope <scope>] [--breaking] [--body "paragraph one"]
                    [--trailer key=value,key2=value2]

  --type      one of ${COMMIT_TYPES.join(", ")}
  --body      one paragraph. Repeat --body is not supported by this parser
              (see cli/args.ts's header); pass one paragraph and add more with
              blank lines inside it if your shell allows a multi-line value.
  --trailer   comma-separated key=value pairs, e.g. 'Closes=#12'. Trailer KEYS
              are the caller's data, never a literal baked in here -- see
              src/commit/format.ts's header for why.

Validates shape (a declared type, a non-empty subject under 72 characters, no
trailing punctuation) -- never content. What changed and why stays yours to
write. Exits 2 on a shape violation.`;

export const commitCommand: Command = {
  name: "commit",
  summary: "Format and validate a Conventional Commits message.",
  usage: USAGE,
  flags: {
    values: ["type", "scope", "subject", "body", "trailer"],
    booleans: ["breaking"],
  },
  run(context: CommandContext): number {
    requireSubcommand("commit", context.args, ["format"]);
    const type = context.args.values["type"] as CommitType | undefined;
    if (type === undefined) throw new VerbUsageError("--type is required.");
    const subject = context.args.values["subject"];
    if (subject === undefined) throw new VerbUsageError("--subject is required.");

    const input: CommitMessageInput = {
      type,
      scope: context.args.values["scope"] ?? null,
      breaking: context.args.booleans.has("breaking"),
      subject,
      body: context.args.values["body"] === undefined ? [] : [context.args.values["body"]],
      trailers: parseTrailers(context.args.values["trailer"]),
    };

    const refusals = validateCommitMessage(input);
    if (refusals.length > 0) {
      for (const refusal of refusals) context.io.err(`nen: ${refusal}`);
      return 2;
    }
    const message = formatCommitMessage(input);
    if (context.json) {
      context.io.out(JSON.stringify({ message }, null, 2));
      return 0;
    }
    context.io.out(message);
    return 0;
  },
};
