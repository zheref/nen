// src/commit/verb.ts -- `nen commit format`.

import { usage, type Verb, type VerbContext } from "../cli/verb.js";
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

export const commitVerb: Verb = {
  name: "commit",
  summary: "Format and validate a Conventional Commits message.",
  usage: USAGE,
  flags: {
    values: ["type", "scope", "subject", "body", "trailer"],
    booleans: ["breaking"],
  },
  run(context: VerbContext): number {
    const [subcommand] = context.args;
    if (subcommand !== "format") {
      return usage(context.io, `unknown 'commit' subcommand '${subcommand ?? "(none)"}'. Try 'commit format'.`);
    }
    const type = context.values["type"] as CommitType | undefined;
    if (type === undefined) return usage(context.io, "--type is required.");
    const subject = context.values["subject"];
    if (subject === undefined) return usage(context.io, "--subject is required.");

    const input: CommitMessageInput = {
      type,
      scope: context.values["scope"] ?? null,
      breaking: context.booleans.has("breaking"),
      subject,
      body: context.values["body"] === undefined ? [] : [context.values["body"]],
      trailers: parseTrailers(context.values["trailer"]),
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
