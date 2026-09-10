// src/commit/command.ts -- `nen commit format`.
//
// THE ONE THING THIS VERB READS FROM A REPOSITORY, AND WHY IT IS NOT A LITERAL.
// ./format.ts's header is explicit that a trailer KEY is the caller's data and
// never a name baked in here. That rule is unchanged; what is added is the
// other half of it -- a repository may now say which ATTRIBUTION trailers it
// admits, in its own `nen/workflow.json`, and this verb refuses the ones it
// does not. The list is still never nen's: `commits.allowedAttributionTrailers`
// is the repository's, and the shape "attribution trailer" is an enumeration a
// reader can audit in ../schema/workflow.ts rather than a pattern nobody can
// check.
//
// A REPOSITORY WITH NO POLICY FILE IS UNCHANGED. No workflow file, no refusal:
// every trailer the shape validator accepts still formats exactly as it did.
// That matters because this verb's whole surface is "shape, never content", and
// a guard that fired without the repository having asked for it would be this
// module deciding somebody's commit convention for them.

import { assertRepoRoot } from "../repo/root.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { SchemaError } from "../schema/errors.js";
import { attributionRefusalMessages, loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
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
                    [--trailer key=value,key2=value2] [--repo <path>]

  --type      one of ${COMMIT_TYPES.join(", ")}
  --body      one paragraph. Repeat --body is not supported by this parser
              (see cli/args.ts's header); pass one paragraph and add more with
              blank lines inside it if your shell allows a multi-line value.
  --trailer   comma-separated key=value pairs, e.g. 'Closes=#12'. Trailer KEYS
              are the caller's data, never a literal baked in here -- see
              src/commit/format.ts's header for why.
  --repo      the repository whose ${WORKFLOW_FILE} states the trailer policy.
              Defaults to the current directory, and is read only when this
              invocation carries at least one --trailer.

Validates shape (a declared type, a non-empty subject under 72 characters, no
trailing punctuation) -- never content. What changed and why stays yours to
write. Exits 2 on a shape violation.

TRAILER POLICY, WHEN THE REPOSITORY STATES ONE. If ${WORKFLOW_FILE} is present
under --repo, a --trailer whose key is ATTRIBUTION-shaped and is not listed in
its 'commits.allowedAttributionTrailers' is refused at exit 2, naming the
trailer and the file. Attribution-shaped means one of the keys
src/schema/workflow.ts enumerates -- the ones that say who or what produced a
commit -- plus every key the file's own 'commits.forbiddenTrailers' adds.
Matching ignores case, because every tool that reads the finished commit does.
With NO workflow file, nothing is refused and this verb behaves exactly as it
always has. A workflow file that is present and MALFORMED is exit 1, naming the
pointer: nen will not shape a message under a policy it could not read.`;

/**
 * Every trailer this invocation carries that the repository's policy refuses.
 *
 * IT IS A LIST, NOT THE FIRST ONE. The rest of this CLI reports every problem
 * it can see in one pass (../cli/command.ts's `splitIntegerList` states the
 * argument), and a caller fixing one refused trailer at a time is exactly the
 * round trip that costs a session.
 *
 * THE WORDING ITSELF LIVES IN ../schema/workflow.ts's attributionRefusalMessages
 * NOW, shared with `nen wc squash` -- the other caller that shapes a whole
 * commit message under this same policy -- so the two verbs cannot drift into
 * two different sentences for the same refusal. This function's own job is
 * unchanged: decide WHETHER to look (no trailers, no read at all) and load
 * the policy the caller's --repo points at.
 */
function policyRefusals(context: CommandContext, trailers: readonly Trailer[]): readonly string[] {
  // NO WORK AT ALL WHEN THERE ARE NO TRAILERS, and that is not an optimisation:
  // it keeps `nen commit format --type chore --subject x` from touching the
  // filesystem -- or failing on somebody's malformed policy -- over a message
  // that could not have violated one.
  if (trailers.length === 0) return [];
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const loaded = loadWorkflow(root);
  return attributionRefusalMessages(
    loaded,
    trailers.map((trailer): string => trailer.key),
  );
}

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

    // SHAPE FIRST, POLICY SECOND, AND BOTH ARE REPORTED TOGETHER when both have
    // something to say: a message with a 90-character header AND a refused
    // trailer is one invocation with two problems, and naming one of them is
    // the round trip this CLI reports whole runs to avoid.
    const refusals = [...validateCommitMessage(input)];
    let policyFailure: SchemaError | null = null;
    try {
      refusals.push(...policyRefusals(context, input.trailers));
    } catch (error) {
      // A POLICY THAT WILL NOT LOAD IS EXIT 1, NOT 2. The invocation was
      // correct; the repository's own file is not, which is "the thing you
      // asked for did not work" (../index.ts's header). It is also not
      // something this verb may format AROUND -- a message shaped under a
      // policy nen could not read is a message nobody checked.
      if (!(error instanceof SchemaError)) throw error;
      policyFailure = error;
    }
    if (policyFailure !== null) {
      context.io.err(
        `nen: ${policyFailure.message}. This repository's ${WORKFLOW_FILE} states which attribution trailers a commit may carry, and nen will not shape a message under a policy it could not read. Run 'nen schema check' for the whole file's verdict.`,
      );
      return 1;
    }
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
