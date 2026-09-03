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
import { parseTarget, type Target } from "../github/target.js";
import { requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
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
import { consolidateClose, attachSub, planConsolidation } from "./subissue.js";
import { chainPosition, NotAnIssueError, parseRoleMap, terminus } from "./chain.js";

export function numberList(value: string | undefined): readonly number[] {
  return commaList(value)
    .map((item): number => Number(item.replace(/^#/, "")))
    .filter((item): boolean => Number.isInteger(item) && item > 0);
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

  nen issue attach-sub --target <owner/name> --parent <n> --children 1,2
                       [--dry-run]
      Attaches children as sub-issues, resolving each child's ID (the API takes
      an id, not a number) before writing.

  nen issue consolidate-close --target <owner/name> --parent <n>
                              --children 1,2 --repo <path>
                              [--severity-family <ns>:<family>]
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
  flags: {
    values: [
      "target",
      "subject",
      "files",
      "rule-ids",
      "lane-labels",
      "title",
      "body-file",
      "label",
      "assignee",
      "forbid-family",
      "issues",
      "parent",
      "children",
      "issue",
      "severity-family",
      "chain-labels",
      "integration-prefix",
      "trunk",
    ],
    booleans: ["dry-run", "allow-open-pr"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("issue", context.args, [
      "search",
      "open-pr-check",
      "file",
      "attach-sub",
      "consolidate-close",
      "chain-position",
      "terminus",
    ]);
    switch (subcommand) {
      case "search":
        return search(context);
      case "open-pr-check":
        return openPr(context);
      case "file":
        return file(context);
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
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
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

function attach(context: CommandContext): number {
  const target = requireTarget(context);
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

function consolidate(context: CommandContext): number {
  const target = requireTarget(context);
  const parent = Number(context.args.values["parent"] ?? "");
  const children = numberList(context.args.values["children"]);
  if (!Number.isInteger(parent) || parent <= 0 || children.length === 0) {
    throw new VerbUsageError("consolidate-close takes --parent <n> and --children <n,n>.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadLabelTaxonomy(root);
  const severityFamily = readSeverityFamily(context, taxonomy);
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

  const report = consolidateClose(context.seams, target, plan, context.args.booleans.has("dry-run"));
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
