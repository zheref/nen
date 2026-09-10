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
import { loadWorkflow, trailerRefusal, WORKFLOW_FILE } from "../schema/workflow.js";
import { PROGRAM } from "../version.js";
import { proofRelativePath } from "../shu/proof.js";
import { runCheck } from "./check.js";
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

const USAGE = `nen commit -- Conventional Commits formatting (tensho §4), and the
build-proof check that says whether this tree is the one a build proved.

usage:
  nen commit format --type feat --subject "a short imperative subject"
                    [--scope <scope>] [--breaking] [--body "paragraph one"]
                    [--trailer key=value,key2=value2] [--repo <path>]
  nen commit check  --repo <path> --require-proof <lane> [--json]

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
pointer: nen will not shape a message under a policy it could not read.

'check' ANSWERS ONE QUESTION: is this working copy the one a green build proved?
'${PROGRAM} shu build' records ${proofRelativePath("<lane>")} when every step
exits 0 -- the lane, the moment, and the git TREE it built -- and removes it when
the build comes out red, so a proof never outlives the tree it proved.
--require-proof <lane> reads that file and compares its tree against this
working copy's, computed the same way (a scratch index, never yours: git add -A
then git write-tree, with .nen/ excluded).

  exit 0  the proof is there, it is for that lane, and its tree is this tree
  exit 1  one of the three differences, named: there is no proof, it records a
          different lane, or the tree has moved since the build
  exit 2  --require-proof or --repo missing, or a lane that escapes the tree

It READS AND DECIDES NOTHING ELSE: no commit is refused, no file is written, no
ref moves. Read the code and decide, as with 'shu coverage --threshold'.`;

/**
 * Every trailer this invocation carries that the repository's policy refuses.
 *
 * IT IS A LIST, NOT THE FIRST ONE. The rest of this CLI reports every problem
 * it can see in one pass (../cli/command.ts's `splitIntegerList` states the
 * argument), and a caller fixing one refused trailer at a time is exactly the
 * round trip that costs a session.
 */
function policyRefusals(context: CommandContext, trailers: readonly Trailer[]): readonly string[] {
  // NO WORK AT ALL WHEN THERE ARE NO TRAILERS, and that is not an optimisation:
  // it keeps `nen commit format --type chore --subject x` from touching the
  // filesystem -- or failing on somebody's malformed policy -- over a message
  // that could not have violated one.
  if (trailers.length === 0) return [];
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const loaded = loadWorkflow(root);
  if (!loaded.present) return [];
  const allowed = loaded.workflow.commits.allowedAttributionTrailers;
  const refusals: string[] = [];
  for (const trailer of trailers) {
    const refused = trailerRefusal(loaded.workflow.commits, trailer.key);
    if (refused === null) continue;
    // TWO WHOLE SENTENCES, NOT ONE WITH A HOLE IN IT. An empty allow-list and a
    // populated one are different facts about the repository and read as
    // different sentences; splicing a clause into a shared frame produced
    // "lists no allowed attribution trailer at all, and 'X' is not among them"
    // -- among WHAT -- which is the one line of this refusal a reader has to
    // parse twice.
    refusals.push(
      allowed.length === 0
        ? `trailer key '${trailer.key}' is an attribution trailer this repository refuses. '${loaded.path}' admits none at all: its commits.allowedAttributionTrailers is empty. Drop the trailer, or add '${refused}' to that list`
        : `trailer key '${trailer.key}' is an attribution trailer this repository refuses. '${loaded.path}' admits ${allowed
            .map((key): string => `'${key}'`)
            .join(", ")} under commits.allowedAttributionTrailers, and '${refused}' is not one of them. Drop the trailer, or add its key to that list`,
    );
  }
  return refusals;
}

/**
 * WHAT EACH SUBCOMMAND CONSUMES, on ../shu/command.ts's pattern and for its
 * reason: a family shares one flag spec, so `nen commit check --breaking` would
 * otherwise parse cleanly and be silently ignored -- and the ignored thing is
 * the instruction somebody gave.
 */
const COMMIT_SUBCOMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  format: ["type", "scope", "subject", "body", "trailer", "breaking"],
  check: ["require-proof"],
};

const COMMIT_FLAGS = {
  values: ["type", "scope", "subject", "body", "trailer", "require-proof"],
  booleans: ["breaking"],
};

function refuseForeignFlags(subcommand: string, context: CommandContext): void {
  const mine = COMMIT_SUBCOMMAND_FLAGS[subcommand] ?? [];
  const all = [...COMMIT_FLAGS.values, ...COMMIT_FLAGS.booleans];
  const foreign = [...Object.keys(context.args.values), ...context.args.booleans].filter(
    (flag): boolean => all.includes(flag) && !mine.includes(flag),
  );
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    `--${foreign.sort().join(", --")} ${foreign.length === 1 ? "is" : "are"} not read by 'commit ${subcommand}'. A flag accepted and ignored is worse than one refused: the ignored thing is the instruction you gave.`,
  );
}

export const commitCommand: Command = {
  name: "commit",
  summary: "Format a Conventional Commits message; check a lane's build proof.",
  usage: USAGE,
  flags: COMMIT_FLAGS,
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("commit", context.args, ["format", "check"]);
    refuseForeignFlags(subcommand, context);
    if (subcommand === "check") return runCheck(context);
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
