// src/issue/command.ts -- `nen issue …`, the issue-shaped verbs.
//
// One verb name, several subcommands, because they are one choreography: search
// the backlog, guard the candidates that carry work in flight, and only then
// file. The order is the point -- "a skill that files first and reconciles
// afterwards has already created the duplicate" -- so they live together and the
// help text states the order.
//
// EVERY MUTATING SUBCOMMAND HAS `--dry-run`, and it is not a courtesy: the
// runbook this serves says every provisioning verb is idempotent and dry-run
// first. A dry run prints the exact call it would have made, so the thing the
// caller approves is the thing that runs.

import { assertRepoRoot } from "../repo/root.js";
import { decomposeLabelName, loadLabelTaxonomy, type LabelTaxonomy } from "../schema/labels.js";
import { commaList } from "../cli/comma.js";
import { readJsonFile, readTextFile } from "../cli/inputs.js";
import { parseTarget, type Target } from "../github/target.js";
import type { FlagSpec } from "../cli/args.js";
import {
  GLOBAL_FLAGS,
  requireRepoFlag,
  requireSubcommand,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import {
  closedSince,
  findCanonical,
  runSearch,
  type RecipeResult,
} from "./search.js";
import {
  createArgv,
  fileIssue,
  openPrCheck,
  validateFiling,
  type FileRequest,
} from "./file.js";
import {
  consolidateClose,
  attachSub,
  planConsolidation,
  unknownPlaceholders,
  unmatchedBraces,
  CLOSE_COMMENT_PLACEHOLDERS,
  type CloseComments,
} from "./subissue.js";
import { commentArgv, postComment, type CommentRequest } from "./comment.js";
import { chainPosition, NotAnIssueError, parseRoleMap, terminus } from "./chain.js";

export function numberList(value: string | undefined): readonly number[] {
  return commaList(value)
    .map((item): number => Number(item.replace(/^#/, "")))
    .filter((item): boolean => Number.isInteger(item) && item > 0);
}

/**
 * WHAT EACH SUBCOMMAND ACTUALLY CONSUMES -- the ONE declaration both the
 * parser's flag spec and the foreign-flag refusal are derived from.
 *
 * WHY THE GUARD EXISTS AT ALL. A family shares one flag spec
 * (../cli/command.ts), so every flag any subcommand declares parses cleanly for
 * ALL of them -- which is exactly the silent-acceptance failure ../cli/args.ts's
 * strictness prevents one level up. Before `comment` existed, `nen issue file
 * --body x` was `unknown option` (exit 2); adding `--body` to the family
 * downgrades that to "accepted and ignored", and the ignored thing is the text
 * the caller wrote.
 *
 * WHY OWNERSHIP IS DERIVED AND NOT WRITTEN DOWN (the round-two review finding,
 * and the second time this guard's SHAPE was the bug). Version one was a call
 * per confusable pair; version two was a hand-maintained `flag -> one owner`
 * table, which fixed the pairs a human had missed and then re-created the same
 * hole one type-level up. `Record<string, string>` holds ONE owner per flag, so
 * a flag with TWO owners could not be written down at all -- and `--body-file`
 * has two (`file` and `comment`) while being foreign to the other five. It was
 * therefore left out of the table entirely, under a docblock asserting that "a
 * shared flag has no sibling to be foreign to", which is simply false:
 * `consolidate-close --body-file <path>` parsed, was ignored, closed the
 * children with the DEFAULT comment and exited 0 -- the exact hazard the table
 * was added to refuse, wearing the one shape the table could not express. The
 * same gap silently covered every flag nobody had thought to enumerate:
 * `chain-position --title`, `file --severity-family`, `search --dry-run`.
 *
 * So the ownership is no longer STATED. Each subcommand declares the flags it
 * reads, once, here; ISSUE_FLAGS below is the UNION of these (which is what the
 * parser gets, so a flag cannot exist without an owner), and a flag parsed but
 * absent from the executing subcommand's own spec is foreign BY CONSTRUCTION.
 * Adding a flag to a subcommand adds it to the parser and to every sibling's
 * refusal in one edit; adding a subcommand gets its refusals for free. The only
 * per-pair judgement left is the WORDING (FOREIGN_FLAG_ADVICE below).
 *
 * THE GLOBAL FLAGS ARE NOT LISTED and are never foreign: `--repo`, `--json` and
 * `--help` are ../cli/command.ts's, merged into every family's spec by
 * mergeFlags, and answering "which issue subcommand owns --json" is a question
 * about the wrong table.
 */
export const ISSUE_SUBCOMMAND_FLAGS: Readonly<Record<string, FlagSpec>> = {
  search: { values: ["target", "subject", "files", "rule-ids", "lane-labels"] },
  "open-pr-check": { values: ["target", "issues"] },
  file: {
    values: ["target", "title", "body-file", "label", "assignee", "forbid-family"],
    booleans: ["dry-run"],
  },
  comment: { values: ["target", "issue", "body", "body-file"], booleans: ["dry-run"] },
  "attach-sub": { values: ["target", "parent", "children"], booleans: ["dry-run"] },
  "consolidate-close": {
    values: ["target", "parent", "children", "severity-family", "close-comment", "close-comment-map"],
    booleans: ["dry-run", "allow-open-pr"],
  },
  "chain-position": { values: ["target", "issue", "chain-labels"] },
  terminus: { values: ["target", "issue", "chain-labels", "integration-prefix", "trunk"] },
};

/**
 * The subcommand names, read off the table above rather than written twice --
 * so `requireSubcommand`'s "Known: ..." list and the ownership derivation can
 * never name different sets.
 */
export const ISSUE_SUBCOMMANDS: readonly string[] = Object.keys(ISSUE_SUBCOMMAND_FLAGS);

/** Whether one subcommand's own spec declares this flag, in either half. */
function declares(spec: FlagSpec, flag: string): boolean {
  return (spec.values ?? []).includes(flag) || (spec.booleans ?? []).includes(flag);
}

/**
 * The family's flag spec: the UNION of every subcommand's, sorted so the
 * `unknown option` listing ../cli/args.ts prints stays stable across edits.
 *
 * Derived rather than typed out a second time, because a hand-kept union is
 * precisely how a flag ends up parsed with no owner -- accepted by the parser,
 * invisible to the guard, ignored by the verb.
 */
function unionFlags(specs: readonly FlagSpec[]): FlagSpec {
  const values = new Set<string>();
  const booleans = new Set<string>();
  for (const spec of specs) {
    for (const flag of spec.values ?? []) values.add(flag);
    for (const flag of spec.booleans ?? []) booleans.add(flag);
  }
  return { values: [...values].sort(), booleans: [...booleans].sort() };
}

export const ISSUE_FLAGS: FlagSpec = unionFlags(Object.values(ISSUE_SUBCOMMAND_FLAGS));

/** The globals every family also accepts -- never any subcommand's to own. */
const GLOBAL_FLAG_NAMES: ReadonlySet<string> = new Set([
  ...(GLOBAL_FLAGS.values ?? []),
  ...(GLOBAL_FLAGS.booleans ?? []),
]);

/** Which subcommands declare this flag, in the table's own order. */
function ownersOf(flag: string): readonly string[] {
  return Object.entries(ISSUE_SUBCOMMAND_FLAGS)
    .filter(([, spec]): boolean => declares(spec, flag))
    .map(([name]): string => name);
}

/**
 * `a`, `a and b`, `a, b and c` -- a real conjunction rather than a `join(" and
 * ")`, because `--dry-run` has FOUR owners and "'issue file' and 'issue
 * comment' and 'issue attach-sub' and 'issue consolidate-close'" reads as a
 * machine that has never seen a sentence. The whole value of these refusals is
 * that a caller believes and acts on them.
 */
function conjoin(items: readonly string[]): string {
  if (items.length <= 1) return items[0] ?? "";
  return `${items.slice(0, -1).join(", ")} and ${items[items.length - 1] ?? ""}`;
}

const ATTACH_POSTS_NOTHING =
  "'issue attach-sub' posts no comment: an attach-time comment is a claim about a consolidation that a failed attach stops before completing. Use 'issue consolidate-close' for the close comment, or 'issue comment' to post one yourself.";

const CLOSE_COMMENT_IS_THE_CHANNEL =
  "'issue consolidate-close' does post a comment, but it is the CLOSE comment, and its flags are --close-comment <template> for one text across every child or --close-comment-map <path> for one text per child.";

// ROUND THREE, MINOR 4. Deriving ownership from the real per-subcommand specs
// (ISSUE_SUBCOMMAND_FLAGS above) changed --dry-run's behaviour on the four
// subcommands that never declared it: `search`, `open-pr-check`,
// `chain-position` and `terminus` used to ACCEPT it and silently ignore it
// (exit 0, nothing previewed, because there was never a write to preview), and
// the derived guard now REFUSES it (exit 2) like any other foreign flag. The
// direction is right -- a caller who types --dry-run at a read-only verb
// believes it changed something, and it never did -- but the GENERIC advice
// (`ownersOf` + `conjoin` below) only names --dry-run's four WRITING owners,
// which reads as "you probably meant one of those", not as "this verb never
// wrote anything, with or without the flag". So each read-only verb gets its
// own line saying exactly that, in front of the same owners sentence the
// generic arm would have printed -- naming what --dry-run DOES belong to is
// still useful, it is just not the whole answer here.
const DRY_RUN_OWNERS_SENTENCE = `It belongs to ${conjoin(
  ownersOf("dry-run").map((owner): string => `'issue ${owner}'`),
)}.`;

function readOnlyDryRunAdvice(subcommand: string): string {
  return `${DRY_RUN_OWNERS_SENTENCE} 'issue ${subcommand}' itself never writes anything -- it only reads and reports -- so --dry-run never changed what it ran here, accepted or refused. It used to be accepted and silently ignored (exit 0); it is refused now (exit 2) so a caller can see that immediately, and nothing about 'issue ${subcommand}' itself has changed.`;
}

/**
 * What to type instead, where the generic answer is not the useful one.
 *
 * Keyed subcommand -> flag. A pair with no entry falls back to naming the
 * flag's owners and nothing else, which is all a caller who typed `--title` at
 * `issue terminus` needs; the entries below are the pairs where the caller
 * plausibly meant something this family CAN do, and the refusal should say
 * which spelling does it.
 */
const FOREIGN_FLAG_ADVICE: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  search: { "dry-run": readOnlyDryRunAdvice("search") },
  "open-pr-check": { "dry-run": readOnlyDryRunAdvice("open-pr-check") },
  "chain-position": { "dry-run": readOnlyDryRunAdvice("chain-position") },
  terminus: { "dry-run": readOnlyDryRunAdvice("terminus") },
  file: {
    body: "'issue file' takes --body-file <path>: a body typed on the command line is a body nobody reviewed. --body belongs to 'issue comment'.",
  },
  "attach-sub": {
    "close-comment": ATTACH_POSTS_NOTHING,
    "close-comment-map": ATTACH_POSTS_NOTHING,
    body: ATTACH_POSTS_NOTHING,
    "body-file": ATTACH_POSTS_NOTHING,
  },
  "consolidate-close": {
    body: `${CLOSE_COMMENT_IS_THE_CHANNEL} --body belongs to 'issue comment'; accepted and ignored here it would have closed the children with the default text while the caller believed theirs went out.`,
    // The pair the previous, hand-maintained ownership table could not express
    // at all -- see ISSUE_SUBCOMMAND_FLAGS above. `--body-file` is real on two
    // siblings, so it parsed here, was dropped, and the children were closed
    // with the default comment at exit 0.
    "body-file": `${CLOSE_COMMENT_IS_THE_CHANNEL} --body-file is the opening body of 'issue file' and the payload of 'issue comment'; accepted and ignored here it would have closed the children with the default text while the caller believed the file's contents went out.`,
  },
  comment: {
    "close-comment":
      "'issue comment' posts one comment and closes nothing; its text is --body <text> or --body-file <path>. --close-comment is the close text of 'issue consolidate-close'.",
    "close-comment-map":
      "'issue comment' posts ONE comment on ONE issue, so there is no per-child map to give it; its text is --body <text> or --body-file <path>. --close-comment-map is the close text of 'issue consolidate-close'.",
  },
};

/**
 * Refuse every flag of this invocation that the executing subcommand does not
 * declare.
 *
 * Called once, for every subcommand, before the subcommand runs -- so a flag
 * that names something this verb does not do is refused at exit 2 the way a
 * misspelled flag always was, ahead of any read and any write.
 *
 * ALL of them are named at once, on the same "report the whole problem" idiom
 * ../cli/command.ts's splitIntegerList and readCloseComments below follow: a
 * caller fixing one flag per round trip is the cost this repository designs
 * against everywhere else.
 *
 * THE FALLBACK ADVICE NAMES THE OWNERS AND NOTHING ELSE, as this docblock's
 * previous version promised and its code did not: it used to end "'issue
 * <sub>' posts no comment", a claim about COMMENTING baked into the generic
 * arm, which was false the moment the guard covered a flag that has nothing to
 * do with comments (`issue file --trunk main` is not about posting anything).
 * A refusal that asserts something untrue about the verb is a refusal a caller
 * stops believing.
 */
function refuseForeignFlags(context: CommandContext, subcommand: string): void {
  const spec = ISSUE_SUBCOMMAND_FLAGS[subcommand];
  // Unreachable: requireSubcommand has already refused anything not keyed
  // here (both lists come from ISSUE_SUBCOMMAND_FLAGS). Stated rather than asserted
  // so a future caller that skips that step fails closed-ish rather than
  // reading `undefined` as "declares everything".
  if (spec === undefined) {
    throw new VerbUsageError(`'issue ${subcommand}' declares no flags of its own.`);
  }
  const given = [...Object.keys(context.args.values), ...context.args.booleans];
  const foreign = [...new Set(given)]
    .filter((flag): boolean => !GLOBAL_FLAG_NAMES.has(flag) && !declares(spec, flag))
    .sort();
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    foreign
      .map((flag): string => {
        const owners = ownersOf(flag);
        // Never empty while ISSUE_FLAGS is the union of these same specs -- a
        // flag with no owner is not in the parser's spec, so args.ts refuses it
        // as an `unknown option` and it never reaches here. The branch is kept
        // because the derivation, not the type system, is what makes that true.
        const generic =
          owners.length === 0
            ? "No 'issue' subcommand declares it."
            : `It belongs to ${conjoin(owners.map((owner): string => `'issue ${owner}'`))}.`;
        const advice = FOREIGN_FLAG_ADVICE[subcommand]?.[flag] ?? generic;
        return `--${flag} is not a flag of this subcommand. ${advice}`;
      })
      .join(" "),
  );
}

function requireTarget(context: CommandContext): Target {
  const raw = context.args.values["target"];
  if (raw === undefined) {
    throw new Error(
      "--target owner/name is required. It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.",
    );
  }
  return parseTarget(raw);
}

const USAGE = `nen issue -- reconcile the backlog, then file into it.

usage:
  nen issue search --target <owner/name> --subject <text>
                   [--files a,b] [--rule-ids X-1,X-2] [--lane-labels l1,l2]
      The four duplicate searches, run in order and reported with what each
      pass was for: subject/open, subject/recently-closed, files+rule-ids,
      lane. Exits 1 when any pass could not run -- "found nothing" and "could
      not look" must never read the same.

  nen issue open-pr-check --target <owner/name> --issues 12,34
      Which candidates carry an OPEN pull request. Closing one of those orphans
      work in flight, so this is the guard that runs before any close.

  nen issue file --target <owner/name> --repo <path> --title <t>
                 --body-file <path> --label a,b --assignee <user>
                 [--forbid-family ns:family] [--dry-run]
      Creates the issue with its labels and assignee IN THE CREATE CALL. Every
      label must exist in the target repository's taxonomy.

  nen issue comment --target <owner/name> --issue <n>
                    (--body-file <path> | --body <text>) [--dry-run]
      Posts ONE caller-supplied comment on ONE issue -- the general primitive
      every other verb here lacked, so a mechanized choreography no longer has
      to drop back to a hand-run 'gh issue comment' for the one step written in
      a human's own words. Exactly one of --body-file/--body: two spellings of
      one input, and the report names which carried it. An empty or
      whitespace-only body is refused (exit 2), as is a --body-file that cannot
      be read. A body that BEGINS WITH '-' must be spelled --body=<text>: a
      following token starting with '-' is a flag to the parser, never a value,
      so --body '-1 on this' is refused rather than silently swallowing the
      next flag. --dry-run prints the exact 'gh' call AND the exact bytes it
      would send, and writes nothing. A number that names a PULL REQUEST is
      accepted, deliberately -- ./comment.ts records why, and why that is not
      the same decision chain-position/terminus made.

  nen issue attach-sub --target <owner/name> --parent <n> --children 1,2
                       [--dry-run]
      Attaches children as sub-issues, resolving each child's ID (the API takes
      an id, not a number) before writing. It posts NO comment, and takes no
      close-comment channel: a comment at attach time is a claim about a
      consolidation that a failed attach STOPS before completing. Compose
      'nen issue comment' with it when one is wanted.

  nen issue consolidate-close --target <owner/name> --parent <n>
                              --children 1,2 --repo <path>
                              [--severity-family <ns>:<family>]
                              [--close-comment <template>]
                              [--close-comment-map <path>]
                              [--dry-run] [--allow-open-pr]
      The whole choreography in its load-bearing order: file (already done by
      the caller) -> attach -> close, with the label union and severity maximum
      computed and reported. --severity-family names the ONE label family that
      is reduced to its single strongest label instead of unioned (ordering:
      the target repository's own taxonomy); exactly one severity belongs on
      the consolidated issue, and unioning them would leave the parent carrying
      several at once. Omitted, the verb REFUSES whenever the union would do
      exactly that -- put two or more labels from one family on the parent --
      rather than defeating the reduction silently. Runs the SAME open-PR
      guard 'open-pr-check' does over every child that would be closed FIRST,
      and refuses the whole close (listing the blocking PRs) when any of them
      has one -- an issue with an open PR is never quietly closed, because
      closing it orphans work already in flight. --allow-open-pr overrides
      the refusal.
      THE CLOSE COMMENT. With neither flag below, every child is closed with
      the fixed 'Consolidated into #<parent>.' this verb has always posted --
      byte for byte, and pinned by test. --close-comment <template> replaces it
      for EVERY child; --close-comment-map <path> takes a JSON object
      '{"<child>": "<text>", ...}' and gives each child its OWN text, which is
      what a caller closing each absorbed member with the name of the section
      that absorbed it actually needs. The two are one input: give at most one.
      Both are templates over two placeholders, ${CLOSE_COMMENT_PLACEHOLDERS.map((name): string => `{${name}}`).join(" and ")} -- and
      nothing else. They substitute the BARE numbers: write the '#'
      yourself, so a cross-repository form like 'owner/name#{parent}'
      stays spellable. Any OTHER run of braces is a usage error, and so is
      a brace with no partner, never passed through, because an
      unrecognised placeholder would be posted literally onto a public
      timeline by a verb that closes issues -- '#{{parent}}',
      '{ parent }' and the dropped-brace '#{parent' included. A map whose keys are not
      exactly --children is refused before any call: a missing key silently
      falls back to the default for that child, and an extra key silently
      drops text the caller wrote.

  nen issue chain-position --target <owner/name> --issue <n> [--repo <path>]
                           [--chain-labels role=label,...]
  nen issue terminus --target <owner/name> --issue <n>
                     [--chain-labels role=label,...]
                     [--integration-prefix <prefix>] [--trunk main]
      Where an issue sits on its delivery chain, and which object is the
      terminus that ends the run. --chain-labels roles: idea, researched,
      approved-team, approved-direct, building, in-review, epic, chore. An
      unparseable --chain-labels entry (no '=', an unknown role, an empty
      label) exits 2 rather than being silently dropped. Exits 1 when the
      answer is 'undecidable' -- that is a refusal, not a result; 0 otherwise.
      Both verbs also REFUSE (exit 1) when --issue <n> turns out to name a
      pull request: GitHub numbers issues and PRs in one sequence and serves
      both from issues/{n}, and a delivery-chain position is defined only for
      issues -- classifying a PR's labels answers something plausible and
      silently wrong. Ask the 'nen pr' family about a pull request.`;

export const issueCommand: Command = {
  name: "issue",
  summary: "Search, guard, file, attach and classify issues.",
  usage: USAGE,
  // The UNION of every subcommand's own spec (ISSUE_SUBCOMMAND_FLAGS above), never a
  // second hand-kept list: a flag the parser accepts but no subcommand
  // declares is a flag the foreign-flag guard cannot see and the verb ignores.
  flags: ISSUE_FLAGS,
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("issue", context.args, ISSUE_SUBCOMMANDS);
    // BEFORE the subcommand, so a flag this verb does not declare is refused at
    // exit 2 ahead of any `gh` read and any write -- see ISSUE_SUBCOMMAND_FLAGS above
    // for why ownership is derived from each subcommand's own spec rather than
    // written down once and kept in step by hand.
    refuseForeignFlags(context, subcommand);
    switch (subcommand) {
      case "search":
        return search(context);
      case "open-pr-check":
        return openPr(context);
      case "file":
        return file(context);
      case "comment":
        return comment(context);
      case "attach-sub":
        return attach(context);
      case "consolidate-close":
        return consolidate(context);
      case "chain-position":
        return position(context);
      default:
        return chainTerminus(context);
    }
  },
};

function search(context: CommandContext): number {
  const target = requireTarget(context);
  const subject = context.args.values["subject"] ?? "";
  const results = runSearch(context.seams, target, {
    subject,
    files: commaList(context.args.values["files"]),
    ruleIds: commaList(context.args.values["rule-ids"]),
    laneLabels: commaList(context.args.values["lane-labels"]),
    closedSince: closedSince(context.seams.now()),
  });

  // The normalized-title exact match, computed over the OPEN subject pass --
  // the absorbed `dedupe_handbook_questions.sh`. It is reported as its own
  // field rather than folded into the candidate list, because "identical title"
  // is a much stronger claim than "the search found it".
  const openPass = results.find((entry): boolean => entry.recipe.id === "subject-open");
  const exact =
    openPass === undefined
      ? []
      : openPass.issues.filter(
          (issue): boolean =>
            findCanonical(Number.MAX_SAFE_INTEGER, subject, [
              { number: issue.number, title: issue.title },
            ]) === issue.number,
        );

  const failed = results.filter((entry): boolean => entry.error !== null);
  if (context.json) {
    context.io.out(
      JSON.stringify(
        {
          target: target.slug,
          passes: results.map((entry): unknown => ({
            id: entry.recipe.id,
            query: entry.recipe.query,
            argv: entry.recipe.argv,
            skipped: entry.skipped,
            truncated: entry.truncated,
            error: entry.error,
            issues: entry.issues,
          })),
          exactTitleMatches: exact.map((issue): number => issue.number),
          ok: failed.length === 0,
        },
        null,
        2,
      ),
    );
    return failed.length === 0 ? 0 : 1;
  }

  context.io.out(`repository: ${target.slug}`);
  for (const entry of results) printPass(context, entry);
  if (exact.length > 0) {
    context.io.out("");
    context.io.out(
      `exact title match (normalized): ${exact.map((issue): string => `#${issue.number}`).join(", ")}`,
    );
  }
  if (failed.length > 0) {
    context.io.err(
      `nen: ${failed.length} of ${results.length} passes could not run. This search found nothing where it could not look, which is not the same finding.`,
    );
    return 1;
  }
  return 0;
}

function printPass(context: CommandContext, entry: RecipeResult): void {
  context.io.out("");
  context.io.out(`[${entry.recipe.id}] ${entry.recipe.rationale}`);
  if (entry.skipped) {
    context.io.out("  skipped -- this pass had no terms to search with");
    return;
  }
  context.io.out(`  query: ${entry.recipe.query}`);
  if (entry.error !== null) {
    context.io.out(`  FAILED: ${entry.error}`);
    return;
  }
  if (entry.issues.length === 0) {
    context.io.out("  no candidates");
  }
  for (const issue of entry.issues) {
    context.io.out(`  #${issue.number}  ${issue.state}  ${issue.title}`);
  }
  if (entry.truncated) {
    context.io.out(
      `  WARNING: the page came back full (${entry.issues.length}); a duplicate beyond it was not seen`,
    );
  }
}

function openPr(context: CommandContext): number {
  const target = requireTarget(context);
  const issues = numberList(context.args.values["issues"]);
  if (issues.length === 0) {
    throw new VerbUsageError("--issues takes a comma-separated list of issue numbers.");
  }
  const report = openPrCheck(context.seams, target, issues);
  if (context.json) {
    context.io.out(JSON.stringify({ target: target.slug, ...report }, null, 2));
    return report.findings.some((finding): boolean => finding.blocked) ? 1 : 0;
  }
  context.io.out(`open pull requests scanned: ${report.scanned}`);
  if (report.truncated) {
    context.io.out(
      `WARNING: the scan came back full (${report.scanned}); a PR beyond it was not seen, so a 'no open PR' answer here is not conclusive`,
    );
  }
  for (const finding of report.findings) {
    if (!finding.blocked) {
      context.io.out(`  #${finding.issue}: no open PR`);
      continue;
    }
    const refs = finding.pullRequests
      .map((pull): string => `#${pull.number}${pull.isDraft ? " (draft)" : ""}`)
      .join(", ");
    context.io.out(`  #${finding.issue}: OPEN PR ${refs} -- closing this orphans work in flight`);
  }
  // A blocked candidate is a NON-ZERO exit, so a caller that pipes this into a
  // close loop stops rather than continuing past the guard it just ran.
  return report.findings.some((finding): boolean => finding.blocked) ? 1 : 0;
}

function file(context: CommandContext): number {
  const target = requireTarget(context);
  // `--body` is `comment`'s flag, and filing keeps its own rule (see the
  // --body-file refusal below). The refusal itself falls out of ISSUE_SUBCOMMAND_FLAGS
  // above -- `file` does not declare `--body` -- and fires with
  // FOREIGN_FLAG_ADVICE's wording before this function is entered.
  //
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2,
  // never silently read as "validate against whatever taxonomy the cwd
  // happens to hold" (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose schemas/labels.json validates every label in the filing."),
  });
  const taxonomy = loadLabelTaxonomy(root);
  const request: FileRequest = {
    title: context.args.values["title"] ?? "",
    bodyFile: context.args.values["body-file"] ?? "",
    labels: commaList(context.args.values["label"]),
    assignee: context.args.values["assignee"] ?? "",
    forbiddenFamilies: commaList(context.args.values["forbid-family"]),
  };
  if (request.bodyFile === "") {
    throw new VerbUsageError("--body-file <path> is required; a body typed on the command line is a body nobody reviewed.");
  }
  const refusals = validateFiling(request, taxonomy);
  if (refusals.length > 0) {
    for (const refusal of refusals) context.io.err(`nen: ${refusal.reason}`);
    return 1;
  }
  if (context.args.booleans.has("dry-run")) {
    const argv = createArgv(target, request);
    if (context.json) {
      context.io.out(JSON.stringify({ dryRun: true, argv }, null, 2));
      return 0;
    }
    context.io.out(`would run: gh ${argv.join(" ")}`);
    return 0;
  }
  const result = fileIssue(context.seams, target, request);
  if (context.json) {
    context.io.out(JSON.stringify({ ...result, labels: request.labels }, null, 2));
    return 0;
  }
  context.io.out(`filed #${result.number} ${result.url}`);
  return 0;
}

// NOTE ON `--repo`: this subcommand's usage line above lists NO --repo, and
// that is a decision rather than an omission. zheref/nen#28's rule is that a
// verb whose usage promises the flag unbracketed must refuse its absence by
// name -- `file` and `consolidate-close` do, because both validate against the
// target checkout's schemas/labels.json. Commenting reads no taxonomy at all,
// so requiring a checkout would be asking for a path this verb has nothing to
// do with; --target alone addresses the API, exactly as its own help text says.
function comment(context: CommandContext): number {
  const target = requireTarget(context);
  // `--issue`, READ WITH THE HOUSE `/^\d+$/` GUARD rather than this family's
  // `Number(...)` idiom -- the rule ../cli/command.ts's readInteger and
  // splitIntegerList exist to provide, and whose docblock names this exact
  // finding. `Number("1e3")` is 1000 and `Number("0x0c")` is 12: both integers,
  // both positive, so a lenient read accepts them and this verb posts the
  // caller's text on a DIFFERENT, perfectly valid issue -- a mistyped flag
  // silently retargeting a public write, with exit 0 and a URL that looks fine
  // until someone reads which number it names.
  //
  // The sibling `Number(...)` reads (attach-sub/consolidate-close's --parent,
  // chain-position/terminus's --issue) are left as they are ON PURPOSE: they
  // predate this verb and changing their refusals is not this change. The
  // inconsistency is recorded here rather than left to be inferred, because the
  // one verb that had to be fixed first is the one that WRITES.
  const rawIssue = context.args.values["issue"];
  if (rawIssue === undefined) {
    throw new VerbUsageError("comment takes --issue <n>.");
  }
  if (!/^\d+$/.test(rawIssue) || Number.parseInt(rawIssue, 10) <= 0) {
    throw new VerbUsageError(
      `comment takes --issue <n>: a positive whole number, digits only -- got '${rawIssue}'. A looser read would accept '1e3' as 1000 and '0x0c' as 12 and post this comment on an issue nobody named.`,
    );
  }
  const issue = Number.parseInt(rawIssue, 10);

  const inline = context.args.values["body"];
  const bodyFile = context.args.values["body-file"];
  // EXACTLY ONE SPELLING -- ../cli/inputs.ts's own rule for a multi-spelled
  // input, applied here because the two disagree silently rather than loudly:
  // with both given, whichever the code happened to read first would be posted
  // and the other would vanish without a word.
  if (inline !== undefined && bodyFile !== undefined) {
    throw new VerbUsageError(
      "--body and --body-file are two spellings of ONE input; give exactly one, so the report names where the posted text came from.",
    );
  }
  if (inline === undefined && bodyFile === undefined) {
    throw new VerbUsageError(
      "the comment body is required: give --body-file <path> or --body <text>. A comment is the one thing this verb posts, so an absent body is never read as an empty one.",
    );
  }

  // READ AND CHECKED BEFORE ANYTHING IS POSTED, whichever spelling carried it:
  // --dry-run's promise is that the bytes it prints are the bytes that would be
  // sent, which is only true if they have been read by the time it prints.
  // readTextFile's refusal names the resolved path and the errno -- the
  // actionable form a caller who mistyped a path needs (exit 2, like every
  // other mistyped flag) -- but its DEFAULT rationale is written for the
  // changed-file verbs it was built for ("would report a clean verdict for a
  // check it never ran"), and this verb runs no check and renders no verdict.
  // So it is handed its own why: the file here is not an input to a judgement,
  // it is the payload.
  //
  // `raw: true` -- ROUND THREE, MINOR 2. `gh` is handed `--body-file bodyFile`
  // below, the ORIGINAL path, untouched, so it reads whatever is on disk. If
  // this read normalized `\r\n` to `\n` first (readTextFile's default, correct
  // for the changed-file readers it exists for), the dry-run transcript and
  // `--json`'s `body` field would show different bytes than a CRLF file's
  // caller was ever going to have posted -- "the bytes it prints are the bytes
  // that would be sent" would be a claim about a file this process rewrote in
  // memory, not the one on disk. Reading it as-is keeps both sides looking at
  // the same bytes without moving either one.
  const body =
    bodyFile === undefined
      ? (inline ?? "")
      : readTextFile(
          bodyFile,
          process.cwd(),
          "--body-file names the bytes this verb posts, so an unreadable one is refused rather than sent as an empty comment.",
          true,
        );
  if (body.trim() === "") {
    throw new VerbUsageError(
      bodyFile === undefined
        ? "--body is empty. A comment with no text is a timeline event that says nothing, and is never what a caller meant to post."
        : `--body-file '${bodyFile}' holds nothing but whitespace. A comment with no text is a timeline event that says nothing; posting it would be reported as success.`,
    );
  }

  const request: CommentRequest =
    bodyFile === undefined
      ? { issue, body, source: "inline" }
      : { issue, body, source: "file", bodyFile };
  const argv = commentArgv(target, request);

  if (context.args.booleans.has("dry-run")) {
    if (context.json) {
      context.io.out(
        JSON.stringify({ dryRun: true, target: target.slug, issue, source: request.source, argv, body }, null, 2),
      );
      return 0;
    }
    context.io.out(`would run: gh ${argv.join(" ")}`);
    // THE ARGV ALONE IS NOT THE DRY RUN when the body rode in a file: it names
    // a path, and the path's contents are the thing that becomes public. So the
    // bytes are printed too, fenced, exactly as they would be posted.
    context.io.out("--- body as it would be posted ---");
    for (const line of body.split("\n")) context.io.out(line);
    // THE FINAL BYTE IS STATED RATHER THAN DRAWN. A line-oriented transcript can
    // only show a trailing newline as a blank line before the closing fence --
    // and a trailing blank line is exactly what a terminal's scrollback, a
    // copy-paste, a chat client and most diff viewers silently eat, so the one
    // byte a reader is least able to see is the one this rendering conveys most
    // weakly. --dry-run's whole promise is that the bytes printed are the bytes
    // sent, so the fence says outright which it is instead of asking the reader
    // to notice something's absence. (--json needs no such note: it carries
    // `body` verbatim, trailing newline and all.)
    context.io.out(
      body.endsWith("\n") ? "--- end of body ---" : "--- end of body (no trailing newline) ---",
    );
    return 0;
  }

  const result = postComment(context.seams, target, request);
  if (context.json) {
    context.io.out(
      JSON.stringify({ dryRun: false, target: target.slug, issue, source: request.source, argv, body, url: result.url }, null, 2),
    );
    return 0;
  }
  // The URL is reported when `gh` printed one and its ABSENCE is stated rather
  // than papered over -- see ./comment.ts: a posted comment whose URL could not
  // be read is still posted, and a caller must not re-post it.
  context.io.out(
    result.url === null
      ? `commented on ${target.slug}#${issue} (gh printed no comment URL, so there is none to report -- the comment was posted)`
      : `commented on ${target.slug}#${issue} ${result.url}`,
  );
  return 0;
}

function attach(context: CommandContext): number {
  const target = requireTarget(context);
  // zheref/nen#29 asked for the close-comment channel on consolidate-close
  // "and/or" attach-sub, and ./subissue.ts's header records why attach is the
  // wrong half to hang one on. A caller who tries anyway is TOLD that, rather
  // than having the flag accepted and ignored -- which would read as "the
  // comment was posted". The wording is ATTACH_POSTS_NOTHING above; the refusal
  // fires before this function is entered.
  const parent = Number(context.args.values["parent"] ?? "");
  const children = numberList(context.args.values["children"]);
  if (!Number.isInteger(parent) || parent <= 0 || children.length === 0) {
    throw new VerbUsageError("attach-sub takes --parent <n> and --children <n,n>.");
  }
  const report = attachSub(context.seams, target, parent, children, context.args.booleans.has("dry-run"));
  if (context.json) {
    context.io.out(JSON.stringify(report, null, 2));
    return report.failed.length === 0 ? 0 : 1;
  }
  for (const line of report.log) context.io.out(line);
  if (report.failed.length > 0) {
    context.io.err(`nen: ${report.failed.length} child/children could not be attached.`);
    return 1;
  }
  return 0;
}

// `--severity-family`, TRIMMED AND VALIDATED before it reaches the planner.
// planConsolidation treats `""` as "no family named" and matches everything
// else by EXACT string comparison against each label's `<ns>:<family>` prefix.
// So a value that is padded with whitespace, missing its colon, carrying a
// `/<leaf>`, or a typo the taxonomy does not declare would match NOTHING: it
// skips the omitted-flag refusal (the flag WAS given) and then reduces nothing,
// silently unioning the very labels the caller asked to reduce -- issue #22
// back through a side door. A malformed shape is a usage error (exit 2, like
// every other mistyped flag); a well-formed family the target taxonomy does not
// declare is a refusal (exit 1, the same discipline as 'file' refusing a label
// the taxonomy does not know) that lists the families the taxonomy DOES
// declare, so the caller's next invocation can be right.
function readSeverityFamily(context: CommandContext, taxonomy: LabelTaxonomy): string {
  const raw = context.args.values["severity-family"];
  if (raw === undefined) return "";
  const value = raw.trim();
  const parts = decomposeLabelName(value);
  if (value === "" || parts.namespace === null || parts.namespace === "" || parts.family === null) {
    throw new VerbUsageError(
      `--severity-family takes '<ns>:<family>' -- the family whose labels reduce to their single strongest -- got '${raw}'.`,
    );
  }
  if (parts.leaf !== null) {
    throw new VerbUsageError(
      `--severity-family takes the FAMILY '${parts.namespace}:${parts.family}', not one of its labels -- got '${raw}'. Drop the '/${parts.leaf}'; the reduction picks the leaf itself.`,
    );
  }
  if (taxonomy.inFamily(parts.namespace, parts.family).length === 0) {
    // Structural, like everything else here: the families ARE the distinct
    // `<ns>:<family>` prefixes of the taxonomy's `<ns>:<family>/<leaf>` names.
    const declared = [
      ...new Set(
        taxonomy
          .names()
          .map((name): ReturnType<typeof decomposeLabelName> => decomposeLabelName(name))
          .filter(
            (name): boolean => name.namespace !== null && name.family !== null && name.leaf !== null,
          )
          .map((name): string => `${name.namespace}:${name.family}`),
      ),
    ].sort();
    throw new Error(
      `--severity-family '${value}' names no '<ns>:<family>/<leaf>' label in ${taxonomy.path}. The reduction matches that string exactly, so an unknown family would reduce nothing and silently union the labels it was named to reduce. Families the taxonomy declares: ${declared.join(", ") || "(none)"}.`,
    );
  }
  return value;
}

// `--close-comment` / `--close-comment-map`, VALIDATED WHOLE BEFORE THE FIRST
// `gh` CALL.
//
// Every refusal below is a mistake that is invisible AFTERWARDS, on a verb that
// closes issues and posts to public timelines: an unrecognised `{placeholder}`
// is posted literally; a map key that no --children entry names is text the
// caller wrote and nobody ever sees; a --children entry the map does not name
// is silently closed with the default string while its siblings get bespoke
// text -- the half-mechanized state this channel exists to remove. So the whole
// shape is checked up front and the caller is told everything wrong with it at
// once, rather than one round trip at a time.
//
// ROUND THREE, MINOR 1: "at once" used to stop being true the moment a map had
// TWO bad entries. `reject()` used to THROW from inside the loop below, so
// entry '13' was never even inspected once entry '5' failed the check -- the
// caller fixed '5', re-ran, and only THEN heard about '13'. That directly
// contradicted this docblock's own promise, so entry faults are now gathered
// across the WHOLE map and thrown once, after every entry has been checked --
// the same shape the missing/extra --children check two paragraphs down
// already used.
//
// ROUND THREE, MAJOR: `root` is the checkout `consolidate()` already computed
// with `assertRepoRoot()` before calling this. Every other file-reading flag in
// this binary -- `pr body-check --body-from`, `backlog order --from`,
// board/changelog/release/label/gate's own reads -- resolves a relative path
// against that root with zero exceptions; this map path used to be the one
// exception, resolved against `process.cwd()` instead, so `--close-comment-map
// closes.json --repo ../other-checkout` read a file next to the SHELL rather
// than next to the checkout the caller named.
//
// `null` means "no channel supplied", which is the ONLY value that reaches the
// byte-frozen default in ./subissue.ts.
function readCloseComments(
  context: CommandContext,
  children: readonly number[],
  root: string,
): CloseComments | null {
  const template = context.args.values["close-comment"];
  const mapPath = context.args.values["close-comment-map"];
  if (template !== undefined && mapPath !== undefined) {
    throw new VerbUsageError(
      "--close-comment and --close-comment-map are two spellings of ONE input -- one text for every child, or one text per child. Give at most one.",
    );
  }

  const vocabulary = CLOSE_COMMENT_PLACEHOLDERS.map((name): string => `{${name}}`).join(", ");
  // The fault in ONE piece of template text, or `null` when it is clean --
  // RETURNS rather than throws, so each caller below decides WHEN to report
  // it. The single-template path (--close-comment) reports the fault the
  // moment it is found, because there is only one string that can be wrong;
  // the per-entry map loop further down instead collects one of these per
  // entry and reports all of them together -- the round-three fix (MINOR 1)
  // for the "first fault only" bug a throwing `reject()` used to have.
  const describeFault = (text: string): string | null => {
    if (text.trim() === "") {
      return "is empty. Omit the flag to keep the default close comment; an empty one would close the child saying nothing.";
    }
    // BOTH BRACE FAULTS, IN ONE REFUSAL. An unknown placeholder and an
    // unmatched brace are different mistakes -- a word the vocabulary does not
    // have, versus a brace the caller forgot to close -- but they have the same
    // consequence (template bytes posted as prose by a verb that closes issues)
    // and the same fix round trip, so a template carrying one of each is told
    // about both at once. The unmatched half was the round-two finding: the
    // brace-run scan required braces on BOTH sides, so a dropped closing brace
    // ('#{parent') matched nothing and went out literally on a REAL close.
    const parts: string[] = [];
    const unmatched = unmatchedBraces(text);
    if (unmatched.length > 0) {
      parts.push(
        `${unmatched.length === 1 ? "an unmatched brace" : "unmatched braces"} ${unmatched.map((run): string => `'${run}'`).join(", ")} (a placeholder is substituted only when both of its braces are there, so this would be posted as typed)`,
      );
    }
    const unknown = unknownPlaceholders(text);
    if (unknown.length > 0) {
      parts.push(
        `${unknown.length === 1 ? "an unknown placeholder" : "unknown placeholders"} ${unknown.join(", ")}`,
      );
    }
    if (parts.length === 0) return null;
    return `carries ${parts.join(", and ")}. The vocabulary is ${vocabulary}; anything else would be posted literally onto a public timeline by a verb that closes issues.`;
  };

  if (template !== undefined) {
    const fault = describeFault(template);
    if (fault !== null) throw new VerbUsageError(`--close-comment ${fault}`);
    return { template, perChild: new Map() };
  }
  // NOT `mapPath ?? ""` (ROUND THREE, MINOR 3 -- the exact anti-pattern
  // ./comment.ts's CommentRequest docblock condemns in this very diff). The
  // state "neither flag was given" is real, and it is handled here as
  // `return null`, symmetrically with the `template !== undefined` branch
  // above, rather than defaulted into an empty path that would be resolved,
  // read, and reported as a missing file nobody named. TypeScript narrows
  // `mapPath` to `string` for the rest of this function on its own past this
  // check, so there is no unreachable state left to paper over with `??`.
  if (mapPath === undefined) return null;

  // Its own rationale, for the same reason comment()'s --body-file read has
  // one: this map is the text that gets posted, not an input to a verdict.
  // Resolved against `root`, not `process.cwd()` -- see the MAJOR finding in
  // this function's header.
  const raw = readJsonFile<unknown>(
    mapPath,
    root,
    "--close-comment-map names the text each child is closed with, so an unreadable one is refused rather than silently falling back to the default comment.",
  );
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new VerbUsageError(
      `--close-comment-map '${mapPath}' must hold a JSON OBJECT mapping each child's number to its own comment text, e.g. {"12": "Absorbed by ...", "13": "..."}.`,
    );
  }

  // EVERY ENTRY IS INSPECTED, AND EVERY FAULT IS KEPT. A bad key, a non-string
  // value and a bad template are three different mistakes, but the ROUND-THREE
  // FINDING (MINOR 1) is that a map carrying two of them only ever surfaced
  // the first: this loop used to `throw` on the first non-string value or the
  // first `reject()` failure, so an entry after it was never even read. Bad
  // keys were already collected into `badKeys` and reported together below;
  // the other two fault kinds now join them in `entryFaults`, collected the
  // same way, so a caller sees the whole map's problems in one round trip.
  const perChild = new Map<number, string>();
  const badKeys: string[] = [];
  const entryFaults: string[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!/^\d+$/.test(key) || Number.parseInt(key, 10) <= 0) {
      badKeys.push(`'${key}'`);
      continue;
    }
    if (typeof value !== "string") {
      entryFaults.push(
        `--close-comment-map entry '${key}' is not a string. Each value is the comment text posted when that child is closed.`,
      );
      continue;
    }
    const fault = describeFault(value);
    if (fault !== null) {
      entryFaults.push(`--close-comment-map entry '${key}' ${fault}`);
      continue;
    }
    perChild.set(Number.parseInt(key, 10), value);
  }
  if (badKeys.length > 0 || entryFaults.length > 0) {
    const messages: string[] = [];
    if (badKeys.length > 0) {
      messages.push(
        `--close-comment-map keys are child issue NUMBERS; ${badKeys.join(", ")} ${badKeys.length === 1 ? "is not one" : "are not"}.`,
      );
    }
    messages.push(...entryFaults);
    throw new VerbUsageError(messages.join(" "));
  }

  // THE KEY SET MUST EQUAL --children, both directions -- see this function's
  // header for why each direction is a silent loss rather than an
  // inconvenience. Checked against the REQUESTED children rather than the ones
  // the plan would close, so it fires before a single read.
  const requested = new Set(children);
  const missing = children.filter((child): boolean => !perChild.has(child));
  const extra = [...perChild.keys()].filter((child): boolean => !requested.has(child));
  if (missing.length > 0 || extra.length > 0) {
    const parts: string[] = [];
    if (missing.length > 0) {
      parts.push(
        `no entry for ${missing.map((child): string => `#${child}`).join(", ")} (which would be closed with the default text while their siblings get yours)`,
      );
    }
    if (extra.length > 0) {
      parts.push(
        `an entry for ${extra.map((child): string => `#${child}`).join(", ")}, which --children does not name (that text would never be posted)`,
      );
    }
    throw new VerbUsageError(
      `--close-comment-map must name exactly the --children of this run; it has ${parts.join(", and ")}.`,
    );
  }

  return { template: null, perChild };
}

function consolidate(context: CommandContext): number {
  const target = requireTarget(context);
  const parent = Number(context.args.values["parent"] ?? "");
  const children = numberList(context.args.values["children"]);
  if (!Number.isInteger(parent) || parent <= 0 || children.length === 0) {
    throw new VerbUsageError("consolidate-close takes --parent <n> and --children <n,n>.");
  }
  // Same requiredness as file() above: this subcommand's usage line also lists
  // --repo unbracketed (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose schemas/labels.json computes the label union and severity maximum."),
  });
  const taxonomy = loadLabelTaxonomy(root);
  const severityFamily = readSeverityFamily(context, taxonomy);
  // Read BEFORE the plan, so a malformed close-comment channel is refused
  // without a single `gh` call -- the same discipline readSeverityFamily's
  // shape check follows one line up.
  const closeComments = readCloseComments(context, children, root);
  const plan = planConsolidation(context.seams, target, parent, children, taxonomy, severityFamily);

  // WITH NO --severity-family, planConsolidation's severity-max reduction is
  // unreachable and every severity-shaped label falls into the union -- the
  // exact several-severities-at-once state the reduction exists to prevent,
  // produced SILENTLY on a mutating verb (issue #22). The plan reports which
  // families would collide; a non-empty report is a refusal, not a warning,
  // because the caller who omitted the flag is exactly the caller who does not
  // know the flag exists. Children with no colliding family labels proceed
  // without it, as they always did.
  if (plan.unreducedFamilies.length > 0) {
    if (context.json) {
      context.io.out(JSON.stringify({ plan, refused: true }, null, 2));
      return 1;
    }
    context.io.err(
      "nen: refusing to consolidate -- no --severity-family was named, and the plain union would put SEVERAL labels from one family on the parent at once:",
    );
    for (const entry of plan.unreducedFamilies) {
      context.io.err(`  ${entry.family}: ${entry.labels.join(", ")}`);
    }
    // The detection above is STRUCTURAL -- any `<ns>:<family>/<leaf>` prefix
    // contributing two-plus labels -- and whether such a family is single-select
    // is the TARGET repository's convention, which nen does not know (§3). So
    // this message must not assert "exactly one always belongs": it says only
    // that the reduction the flag exists for did not run, and how to run it.
    context.io.err(
      `Whether a family is single-select (the way a severity family is) is the target repository's own convention -- nen reads families only structurally and cannot rule that carrying several is wrong, only that no reduction ran. If one of these is such a family, name it -- e.g. --severity-family ${plan.unreducedFamilies[0]?.family ?? "<ns>:<family>"} -- and its labels reduce to the single strongest by the target repository's own taxonomy, while every other family unions as before.`,
    );
    return 1;
  }

  // THE SAME GUARD 'open-pr-check' RUNS, applied to exactly the children this
  // plan would close -- see ./file.ts's header: "an issue with an OPEN PR is
  // never quietly closed, because closing it orphans work already in
  // flight." Without this, consolidate-close's own close loop had no PR
  // check at all, even though the guard already existed one verb over.
  const allowOpenPr = context.args.booleans.has("allow-open-pr");
  const openPrs = openPrCheck(context.seams, target, plan.toClose);
  const blocked = openPrs.findings.filter((finding): boolean => finding.blocked);
  if (blocked.length > 0 && !allowOpenPr) {
    if (context.json) {
      context.io.out(JSON.stringify({ plan, openPrs, refused: true }, null, 2));
      return 1;
    }
    context.io.err("nen: refusing to close -- the following children have an open PR in flight (pass --allow-open-pr to override):");
    for (const finding of blocked) {
      for (const pr of finding.pullRequests) {
        context.io.err(`  #${finding.issue}: blocked by #${pr.number} ${pr.title} (${pr.url})`);
      }
    }
    return 1;
  }

  const report = consolidateClose(
    context.seams,
    target,
    plan,
    context.args.booleans.has("dry-run"),
    closeComments,
  );
  if (context.json) {
    context.io.out(JSON.stringify({ plan, openPrs, report }, null, 2));
    return report.failed.length === 0 ? 0 : 1;
  }
  for (const line of report.log) context.io.out(line);
  if (report.failed.length > 0) {
    context.io.err(`nen: ${report.failed.length} step(s) failed. The order was file -> attach -> close; nothing after a failure ran.`);
    return 1;
  }
  return 0;
}

// The chain verbs' object-class refusal (issue #25), rendered once for both:
// exit 1 like every other refusal in this family, with the same stable
// `refused: true` --json shape consolidate-close's refusals use -- a caller
// that machine-reads these verbs must be able to tell "refused to classify"
// from "classified", not just from the exit code.
function refuseNotAnIssue(context: CommandContext, issue: number, error: NotAnIssueError): number {
  if (context.json) {
    context.io.out(JSON.stringify({ issue, refused: true, reason: error.message }, null, 2));
    return 1;
  }
  context.io.err(`nen: ${error.message}`);
  return 1;
}

function position(context: CommandContext): number {
  const target = requireTarget(context);
  const issue = Number(context.args.values["issue"] ?? "");
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new VerbUsageError("chain-position takes --issue <n>.");
  }
  const parsed = parseRoleMap(commaList(context.args.values["chain-labels"]));
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) context.io.err(`nen: --chain-labels: ${message}`);
    return 2;
  }
  let result;
  try {
    result = chainPosition(context.seams, target, issue, parsed.map);
  } catch (error) {
    if (error instanceof NotAnIssueError) return refuseNotAnIssue(context, issue, error);
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.position === "undecidable" ? 1 : 0;
  }
  context.io.out(`#${issue}: ${result.position}`);
  for (const reason of result.evidence) context.io.out(`  ${reason}`);
  // "undecidable" is a refusal, not an answer -- a shell caller (`if nen
  // issue chain-position ...; then`) or a CI step must see that in the exit
  // code, not just in the printed text.
  return result.position === "undecidable" ? 1 : 0;
}

function chainTerminus(context: CommandContext): number {
  const target = requireTarget(context);
  const issue = Number(context.args.values["issue"] ?? "");
  if (!Number.isInteger(issue) || issue <= 0) {
    throw new VerbUsageError("terminus takes --issue <n>.");
  }
  const parsed = parseRoleMap(commaList(context.args.values["chain-labels"]));
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) context.io.err(`nen: --chain-labels: ${message}`);
    return 2;
  }
  let result;
  try {
    result = terminus(
      context.seams,
      target,
      issue,
      parsed.map,
      context.args.values["integration-prefix"] ?? null,
      context.args.values["trunk"] ?? "main",
    );
  } catch (error) {
    if (error instanceof NotAnIssueError) return refuseNotAnIssue(context, issue, error);
    throw error;
  }
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.kind === "undecidable" ? 1 : 0;
  }
  context.io.out(`terminus: ${result.kind}`);
  for (const reason of result.evidence) context.io.out(`  ${reason}`);
  // Same discipline as chain-position above: "undecidable" is a refusal.
  return result.kind === "undecidable" ? 1 : 0;
}
