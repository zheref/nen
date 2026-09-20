// src/commit/command.ts -- `nen commit format`, `nen commit check` and --
// zheref/nen#227 -- `nen commit write` (./write.ts).
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
import { emit, requireRepoFlag, requireSubcommand, requireValue, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { SchemaError } from "../schema/errors.js";
import { attributionRefusalMessages, loadWorkflow, WORKFLOW_FILE } from "../schema/workflow.js";
import { PROGRAM } from "../version.js";
import { proofRelativePath } from "../shu/proof.js";
import { readTextFile } from "../cli/inputs.js";
import { runCheck } from "./check.js";
import { COMMIT_MESSAGE_PATH, write, WRITE_CONTRACT } from "./write.js";
import {
  COMMIT_TYPES,
  formatCommitMessage,
  validateCommitMessage,
  type CommitMessageInput,
  type CommitType,
  type Trailer,
} from "./format.js";

function parseTrailers(values: readonly string[] | undefined): readonly Trailer[] {
  // `--trailer` IS A LIST FLAG NOW (zheref/nen#227, for `commit write`'s
  // `Key: value` form); `format` keeps its comma-joined `key=value` spelling
  // on every occurrence, so `--trailer a=1,b=2` and `--trailer a=1 --trailer
  // b=2` are the same two trailers.
  const value = (values ?? []).join(",");
  if (value.trim() === "") return [];
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
  nen commit write  --repo <path> --message-file <path> [--trailer <Key: value>]...
                    [--require-proof <lane>] [--dry-run] [--json]

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
working copy's, computed the same way (a scratch index, never yours: git add -A,
then git rm --cached for .nen/, then git write-tree).

  exit 0  the proof is there, it is for that lane, and its tree is this tree
  exit 1  one of the three differences, named: there is no proof, it records a
          different lane, or the tree has moved since the build
  exit 2  --require-proof or --repo missing, or a lane that escapes the tree

It READS AND DECIDES NOTHING ELSE: no commit is refused, no file is written, no
ref moves. Read the code and decide, as with 'shu coverage --threshold'.

'write' COMMITS THE INDEX with a message file, validated whole under the SAME
rules 'format' applies (the Conventional Commits shape, and this repository's
attribution-trailer policy -- one validator, never a second copy of it).

  --message-file <path>   the message; relative paths resolve against --repo.
  --trailer <Key: value>  appended to the message's trailer block, in order;
                          repeatable. 'Key: value' exactly -- a key of letters,
                          digits and '-', a colon, one space, the value.
  --require-proof <lane>  refuse at exit 1 unless 'commit check' would say OK
                          for this lane: the proof is there, for that lane, and
                          its tree is this tree.
  --dry-run               print the message and the git line; commit nothing.
  There is NO --sign-off: 'Signed-off-by' is an attribution-shaped trailer
  this repository's policy forbids; where a policy admits it, pass it as
  --trailer "Signed-off-by: Name <email>" like any other trailer.

Refused, in this order: the message or a --trailer failing the shape (exit 2,
every reason named); the proof, when required (exit 1); an empty index (exit
1, 'nothing staged'). Then 'git commit -F ${COMMIT_MESSAGE_PATH}' -- the
composed message is written there and removed afterwards. --json's contract is
'${WRITE_CONTRACT}': { contract, sha (null on a dry run), subject, trailers:
[{ key, value }], dryRun }.`;

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

/**
 * WHAT EACH SUBCOMMAND CONSUMES, on ../shu/command.ts's pattern and for its
 * reason: a family shares one flag spec, so `nen commit check --breaking` would
 * otherwise parse cleanly and be silently ignored -- and the ignored thing is
 * the instruction somebody gave.
 */
const COMMIT_SUBCOMMAND_FLAGS: Readonly<Record<string, readonly string[]>> = {
  format: ["type", "scope", "subject", "body", "trailer", "breaking"],
  check: ["require-proof"],
  write: ["message-file", "trailer", "require-proof", "dry-run"],
};

const COMMIT_FLAGS = {
  values: ["type", "scope", "subject", "body", "require-proof", "message-file"],
  lists: ["trailer"],
  booleans: ["breaking", "dry-run"],
};

function refuseForeignFlags(subcommand: string, context: CommandContext): void {
  const mine = COMMIT_SUBCOMMAND_FLAGS[subcommand] ?? [];
  const all = [...COMMIT_FLAGS.values, ...COMMIT_FLAGS.lists, ...COMMIT_FLAGS.booleans];
  const foreign = [...Object.keys(context.args.values), ...Object.keys(context.args.lists), ...context.args.booleans].filter(
    (flag): boolean => all.includes(flag) && !mine.includes(flag),
  );
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    `--${foreign.sort().join(", --")} ${foreign.length === 1 ? "is" : "are"} not read by 'commit ${subcommand}'. A flag accepted and ignored is worse than one refused: the ignored thing is the instruction you gave.`,
  );
}

function runWrite(context: CommandContext): number {
  // --repo unbracketed: this verb COMMITS whatever index it is pointed at
  // (zheref/nen#28's rule).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the repository whose index is committed."),
  });
  const messageFilePath = requireValue(context.args, "message-file", "The file holding the commit's whole message.");
  const messageText = readTextFile(messageFilePath, root, "It is the message this commit will carry -- 'commit write' reads no other source for it.");
  let outcome;
  try {
    outcome = write(context.seams, root, {
      messageText,
      trailerFlags: context.args.lists["trailer"] ?? [],
      requireProof: context.args.values["require-proof"] ?? null,
      dryRun: context.args.booleans.has("dry-run"),
    });
  } catch (error) {
    // A POLICY THAT WILL NOT LOAD IS EXIT 1, NOT 2, exactly as `format`'s own
    // trailer-policy read: a message shaped under a policy nen could not read
    // is a message nobody actually checked.
    if (!(error instanceof SchemaError)) throw error;
    context.io.err(`nen: ${error.message}. This repository's ${WORKFLOW_FILE} states which attribution trailers a commit may carry, and nen will not commit under a policy it could not read. Run 'nen schema check' for the whole file's verdict.`);
    return 1;
  }
  if (outcome.kind === "usage") {
    throw new VerbUsageError(
      [`the message does not have the shape 'nen commit format' enforces:`, ...outcome.reasons.map((reason): string => `  - ${reason}`)].join("\n"),
    );
  }
  if (outcome.kind === "refused") {
    context.io.err(`nen commit write: ${outcome.reason}`);
    return 1;
  }
  emit(context.io, context.json, outcome.report, outcome.lines);
  return 0;
}

export const commitCommand: Command = {
  name: "commit",
  subcommands: ["format", "check", "write"],
  summary: "Format a Conventional Commits message; check a lane's build proof; write a validated commit.",
  usage: USAGE,
  flags: COMMIT_FLAGS,
  hints: {
    "--sign-off": `there is no --sign-off (zheref/nen#227 dropped it deliberately): 'Signed-off-by' is an attribution-shaped trailer this repository's ${WORKFLOW_FILE} policy forbids. Where a policy admits it, pass it as --trailer "Signed-off-by: Name <email>" like any other trailer.`,
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("commit", context.args, ["format", "check", "write"]);
    refuseForeignFlags(subcommand, context);
    if (subcommand === "check") return runCheck(context);
    if (subcommand === "write") return runWrite(context);
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
      trailers: parseTrailers(context.args.lists["trailer"]),
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
