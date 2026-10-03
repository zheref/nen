// src/commit/command.ts -- `nen commit format`, `nen commit check` and --
// zheref/nen#227 -- `nen commit write` (./write.ts).
//
// THE TWO THINGS THIS VERB READS FROM A REPOSITORY, AND WHY NEITHER IS A
// LITERAL. The first is the trailer policy, below. The second
// (zheref/nen#263) is the repository's own commitlint `subject-case` rule,
// read by ./commitlint.ts from where commitlint reads it -- or, where that
// config is code nen does not execute (or there is none), from the rule the
// repository DECLARES in nen/workflow.json's `commits.subjectCase`. Either
// way a subject the rule refuses is refused HERE, at the same exit as every
// other shape violation, before the commit exists; ./commitlint.ts's header
// states the precedence between the two. With neither, the verb is
// unchanged. The third (zheref/nen#290) is the same config's
// `body-max-line-length` and `footer-max-line-length` -- or the body width
// nen/workflow.json's `commits.bodyMaxLineLength` declares, under
// `subjectCase`'s precedence: --body is WRAPPED to that width (config-
// conventional's 100 where no readable rule or declaration states one), and
// a line the wrap cannot shorten is refused under a level-2 rule, the
// declared width, or the 100 assumed for a config nen cannot read (the
// maintainer's ruling), rather than left for the commit-msg hook.
// ./bodywidth.ts's header states how.
//
// nen/workflow.json IS THEREFORE READ ON EVERY INVOCATION, not only when a
// --trailer is carried: `commits.subjectCase` can refuse any subject, so no
// message is one that could not have violated the policy -- the argument that
// used to let a trailer-less run skip the file no longer holds for it.
//
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
import { attributionRefusalMessages, loadWorkflow, WORKFLOW_FILE, type LoadedWorkflow } from "../schema/workflow.js";
import { PROGRAM } from "../version.js";
import { proofRelativePath } from "../shu/proof.js";
import { readTextFile } from "../cli/inputs.js";
import { runCheck } from "./check.js";
import { CommitlintConfigError, declaredSubjectCase, readSubjectCaseRule, subjectCaseFindings } from "./commitlint.js";
import { declaredBodyWidth, lineLengthFindings, readLineLengthRules, wrapFormatBody } from "./bodywidth.js";
import { COMMIT_MESSAGE_PATH, write, WRITE_CONTRACT } from "./write.js";
import { injectedMessage } from "./readback.js";
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
              A line over the repository's commitlint line length is WRAPPED
              at spaces -- see BODY LINE LENGTH below.
  --trailer   comma-separated key=value pairs, e.g. 'Closes=#12'. Trailer KEYS
              are the caller's data, never a literal baked in here -- see
              src/commit/format.ts's header for why.
  --repo      the repository whose ${WORKFLOW_FILE} states the trailer policy
              and commits.subjectCase / commits.bodyMaxLineLength, and whose
              commitlint config states 'subject-case' and the line lengths --
              both read on every invocation. Defaults to the current
              directory.

Validates shape (a declared type, a non-empty subject under 72 characters, no
trailing punctuation) -- never content. What changed and why stays yours to
write. Exits 2 on a shape violation.

COMMITLINT'S 'subject-case', WHEN THE REPOSITORY CONFIGURES IT. The config
commitlint itself would load from --repo's root -- the first of package.json
('commitlint' key), package.yaml, .commitlintrc, .commitlintrc.json/.yaml/.yml,
then the .js/.cjs/.mjs/.ts/.cts/.mts forms -- is read for its 'subject-case'
rule: an explicit rules['subject-case'], or @commitlint/config-conventional's
default ('never' sentence-, start-, pascal-, upper-case) when it is extended.
The subject commitlint's parser would find in the header gets commitlint's
own verdict (quoted and backticked spans are not checked): a break at level 2
is refused at exit 2 with the rest; level 1 is a 'warning:' line at exit 0;
level 0 and no config change nothing. A '!' header under a config with no
parserPreset gets no verdict (commitlint's default parser does not read it),
said in a warning. A .commitlintrc that is present and malformed is exit 1:
nen will not judge a subject under a rule it could not read. Parent
directories, commitlint's global config and a hook's --config are not read.

A JavaScript or TypeScript commitlint config is NEVER executed, so the rule
can also be DECLARED as data in ${WORKFLOW_FILE}: 'commits.subjectCase' is
either "config-conventional" or a commitlint rule [level, "always"|"never",
cases]. PRECEDENCE: a commitlint config nen can read as data wins -- it is the
gate commitlint runs -- and a declaration beside it is reported as not
applied. The declaration is BINDING where the commitlint config is code, where
nen cannot otherwise read the rule from it (an unresolvable preset, '$import',
a package 'commitlint' key that will not parse), and where there is none:
level 2 refuses at exit 2, and a 'note:' line (or the refusal itself) says the
rule came from ${WORKFLOW_FILE}. With neither -- code and no declaration -- nen
only warns that the rule was NOT checked, with config-conventional's verdict
for reference, at exit 0, and commitlint can still refuse AFTER the commit
exists. With no config, nothing declared, and no .git entry under --repo, a
warning says so and names --repo.

BODY LINE LENGTH (zheref/nen#290). The same commitlint config is read for
'body-max-line-length' and 'footer-max-line-length': an explicit rule, or
config-conventional's [2, "always", 100] when it is extended. Its width is
read as commitlint reads it ("100" is 100; none is 0) and never refused; only
a tuple of the wrong shape is exit 1. The BODY width can also be DECLARED in
${WORKFLOW_FILE}'s 'commits.bodyMaxLineLength' (a whole number >= 1), with
commits.subjectCase's precedence: a readable data config decides and the key
beside it is reported as not applied; the key binds where the config is code
or unreadable, or absent. With neither, an unreadable config means 100,
ASSUMED AND BINDING (the maintainer's ruling) -- on every line before the
trailer block, prose commitlint reads as footer included. The trailer block
has no declared form: under an unreadable config it is judged against 100
for reference only.

'format' WRAPS every --body line the rule would refuse to that width -- 100
where no readable rule or declaration states one, and not at all under a rule
turned off -- breaking only at spaces and tabs: never inside a word or URL,
keeping the whitespace between words on one line, each line's own terminator,
blank-line paragraphs, a list item's marker (continuations hang under its
text) and preformatted lines (four spaces or a tab) as they are. It never
changes how commitlint reads the message: no line it makes starts with '#',
'gpg:', a footer token or a note, and a line that opens the footer still
does. A --trailer is never wrapped. Each rewrapped line is named in a 'note:'.
A message within its limits is emitted byte for byte. Then the whole message
is judged as commitlint splits it (body, then footer from the first footer
token on; a line holding an http(s) URL is exempt): a line over a level-2
rule, the declared width or the assumed 100 is refused at exit 2, naming it;
level 1 is a 'warning:'. With no config and nothing declared, no such rule,
or the rule off, nothing is judged; a line 'format' could not wrap is a
'warning:'. A malformed commits.bodyMaxLineLength is exit 1, by pointer.

TRAILER POLICY, WHEN THE REPOSITORY STATES ONE. If ${WORKFLOW_FILE} is present
under --repo, a --trailer whose key is ATTRIBUTION-shaped and is not listed in
its 'commits.allowedAttributionTrailers' is refused at exit 2, naming the
trailer and the file. Attribution-shaped means one of the keys
src/schema/workflow.ts enumerates -- the ones that say who or what produced a
commit -- plus every key the file's own 'commits.forbiddenTrailers' adds.
Matching ignores case, because every tool that reads the finished commit does.
With NO workflow file, nothing is refused and this verb behaves exactly as it
always has. A workflow file that is present and MALFORMED is exit 1, naming the
pointer, with or without a --trailer: nen will not shape a message under a
policy it could not read.

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
rules 'format' applies (the Conventional Commits shape, this repository's
attribution-trailer policy, and its 'subject-case' rule -- commitlint's own or
the one commits.subjectCase declares, under the same precedence -- and its
body/footer line lengths; one validator, never a second copy of it). 'write'
does NOT wrap: an over-long line is refused (level 2) or warned about, and
the file is committed as written or not at all.

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

Refused, in this order: a ${WORKFLOW_FILE} or .commitlintrc nen cannot read
(exit 1, every broken file named, then any shape fault the message still has
-- exactly as 'format' reports them); the message or a --trailer failing the
shape (exit 2, every reason named); the proof, when required (exit 1); an
empty index (exit 1, 'nothing staged'). Then 'git commit -F ${COMMIT_MESSAGE_PATH}' -- the
composed message is written there and removed afterwards.

THEN THE COMMIT IS READ BACK (zheref/nen#273): 'git log -1
--format=%(trailers:only,unfold) <sha>'. A trailer on the written commit that
the message nen wrote did not carry was added by a hook inside 'git commit'
(prepare-commit-msg, commit-msg, a harness's own). One this repository's
policy refuses is INJECTED: exit 3, every such key named, the commit LEFT IN
PLACE -- never amended; drop it yourself ('git reset --soft HEAD~1'). One the
policy admits or never restricts is a 'note:' line, exit unchanged. With no
${WORKFLOW_FILE} nothing is refused here, as nothing is refused before the
write. A read-back git could not answer is exit 1: the commit exists, the
check did not happen.

Exits: 0 committed (and nothing refused was added); 1 a broken config, a
refused proof, an empty index, a failed git; 2 the shape; 3 committed, and a
hook injected a refused trailer. --json's contract is '${WRITE_CONTRACT}': {
contract, sha (null on a dry run), subject, trailers: [{ key, value }] (READ
BACK from the written commit; the composed message's on a dry run), injected:
[key, ...] (null on a dry run -- not checked), dryRun }.`;

/**
 * The exit-1 line for a nen/workflow.json that will not load, shared by
 * `format` and `write`. Exit 1 and not 2: the invocation was correct; the
 * repository's own file is not, which is "the thing you asked for did not
 * work" (../index.ts's header). It is also not something either verb may
 * work AROUND -- a message shaped under a policy nen could not read is a
 * message nobody checked, whether the policy's say was a trailer or the
 * subject's case.
 */
function policyFailure(error: SchemaError, act: "shape a message" | "commit"): string {
  return `nen: ${error.message}. This repository's ${WORKFLOW_FILE} states the commit policy -- which attribution trailers a commit may carry, commits.subjectCase and commits.bodyMaxLineLength -- and nen will not ${act} under a policy it could not read. Run 'nen schema check' for the whole file's verdict.`;
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

/**
 * The exit-1 line for a commitlint config nen could not read the rule from,
 * shared by `format` and `write` so the two say the same thing. Exit 1 and not
 * 2 on the trailer policy's own argument: the invocation was correct, the
 * repository's file is not, and a subject judged under a rule nen could not
 * read is a subject nobody judged. It names the file and the fault and claims
 * nothing more about it -- ./commitlint.ts decides which files can raise it.
 */
function commitlintFailure(error: CommitlintConfigError): string {
  const what = error.rule === "subject-case" ? "a subject" : "a message";
  return `nen: ${error.message}. nen will not call ${what} well-formed under a ${error.rule} rule it could not read: fix the file, then run this again.`;
}

function runWrite(context: CommandContext): number {
  // --repo unbracketed: this verb COMMITS whatever index it is pointed at
  // (zheref/nen#28's rule).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the repository whose index is committed."),
  });
  const messageFilePath = requireValue(context.args, "message-file", "The file holding the commit's whole message.");
  const messageText = readTextFile(messageFilePath, root, "It is the message this commit will carry -- 'commit write' reads no other source for it.");
  const outcome = write(context.seams, root, {
    messageText,
    trailerFlags: context.args.lists["trailer"] ?? [],
    requireProof: context.args.values["require-proof"] ?? null,
    dryRun: context.args.booleans.has("dry-run"),
    warn: (warning): void => context.io.err(`nen: warning: ${warning}`),
    note: (note): void => context.io.err(`nen: note: ${note}`),
  });
  if (outcome.kind === "broken") {
    // A CONFIG THAT WILL NOT LOAD IS EXIT 1, NOT 2, and reported exactly as
    // `format` reports it: every broken file first, then whatever the
    // message's own shape still said.
    for (const failure of outcome.failures) {
      context.io.err(failure instanceof CommitlintConfigError ? commitlintFailure(failure) : policyFailure(failure, "commit"));
    }
    for (const reason of outcome.reasons) context.io.err(`nen: ${reason}`);
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
  // EXIT 3 (zheref/nen#273): the commit was written, and a hook put a trailer
  // on it this repository's policy refuses. Not 1 -- nothing failed to run,
  // and the commit exists -- and not 2 -- the invocation was right. The report
  // above still names the sha; the commit is left for the caller to drop.
  const injected = outcome.report.injected ?? [];
  if (injected.length > 0 && outcome.report.sha !== null) {
    context.io.err(`nen commit write: ${injectedMessage(outcome.report.sha, injected, outcome.policyPath, "'git reset --soft HEAD~1' keeps the change staged")}`);
    return 3;
  }
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

    // SHAPE FIRST, POLICY SECOND, SUBJECT-CASE THIRD, LINE LENGTH FOURTH,
    // AND ALL ARE REPORTED TOGETHER when more than one has something to say:
    // a message with a 90-character header AND a refused trailer AND a
    // capitalized subject is one invocation with three problems, and naming
    // one of them is the round trip this CLI reports whole runs to avoid.
    const refusals = [...validateCommitMessage(input)];
    const failures: string[] = [];
    // An --repo that does not exist is a RepoRootError, exit 2: both reads
    // below need the directory.
    const root = assertRepoRoot({ repoFlag: context.repoFlag });
    // THE POLICY FILE, READ ONCE, ON EVERY RUN -- its trailer policy AND its
    // commits.subjectCase (this module's header says why no run skips it).
    // Every refused trailer is named, not the first: the rest of this CLI
    // reports every problem it can see in one pass, and the wording is
    // ../schema/workflow.ts's attributionRefusalMessages, shared with `nen wc
    // squash` so the two verbs cannot drift into two sentences for one
    // refusal.
    let loaded: LoadedWorkflow | null = null;
    try {
      loaded = loadWorkflow(root);
      refusals.push(...attributionRefusalMessages(loaded, input.trailers.map((trailer): string => trailer.key)));
    } catch (error) {
      if (!(error instanceof SchemaError)) throw error;
      failures.push(policyFailure(error, "shape a message"));
    }
    let message = formatCommitMessage(input);
    try {
      if (loaded === null) {
        // The declaration could not be read, so no verdict is given -- but a
        // broken commitlint config is still named beside the broken policy,
        // two problems in one pass.
        readSubjectCaseRule(root);
        readLineLengthRules(root, null);
      } else {
        // The header exactly as it will be committed -- the first line of the
        // formatted message -- because commitlint's parser finds the subject
        // in the header, not in the flag.
        const header = message.split("\n")[0] ?? "";
        const found = subjectCaseFindings(root, header, declaredSubjectCase(loaded));
        refusals.push(...found.refusals);
        // Warnings and notes print whatever else happens: they are facts about
        // the subject and its rule, not about whether this run succeeded.
        for (const warning of found.warnings) context.io.err(`nen: warning: ${warning}`);
        for (const note of found.notes) context.io.err(`nen: note: ${note}`);
        // THE BODY, WRAPPED TO THE WIDTH commitlint WILL HOLD IT TO, then the
        // whole message judged as it will be committed (zheref/nen#290): a
        // line the wrap could not shorten -- one unbroken word, preformatted
        // text -- or a --trailer over the footer's width is named here, never
        // left for the commit-msg hook. ./bodywidth.ts's header has the rules.
        const rules = readLineLengthRules(root, declaredBodyWidth(loaded));
        const wrapped = wrapFormatBody(input.body, rules);
        message = formatCommitMessage({ ...input, body: wrapped.body });
        const width = lineLengthFindings(message, rules);
        refusals.push(...width.refusals);
        for (const warning of [...width.warnings, ...wrapped.warnings]) context.io.err(`nen: warning: ${warning}`);
        for (const note of [...wrapped.notes, ...width.notes]) context.io.err(`nen: note: ${note}`);
      }
    } catch (error) {
      if (!(error instanceof CommitlintConfigError)) throw error;
      failures.push(commitlintFailure(error));
    }
    // A BROKEN CONFIG IS REPORTED FIRST, AND THE EXIT IS 1: the repository's
    // files are what is wrong. The shape refusals this run could still
    // establish are printed after them rather than dropped -- one pass, every
    // problem -- exactly as `write` reports the same failures.
    if (failures.length > 0) {
      for (const failure of failures) context.io.err(failure);
      for (const refusal of refusals) context.io.err(`nen: ${refusal}`);
      return 1;
    }
    if (refusals.length > 0) {
      for (const refusal of refusals) context.io.err(`nen: ${refusal}`);
      return 2;
    }
    if (context.json) {
      context.io.out(JSON.stringify({ message }, null, 2));
      return 0;
    }
    context.io.out(message);
    return 0;
  },
};
