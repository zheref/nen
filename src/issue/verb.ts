// src/issue/verb.ts -- `nen issue …`, the issue-shaped verbs.
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
import { loadLabelTaxonomy } from "../schema/labels.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { parseTarget, type Target } from "../github/target.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
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
import { chainPosition, parseRoleMap, terminus } from "./chain.js";

export function commaList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}

export function numberList(value: string | undefined): readonly number[] {
  return commaList(value)
    .map((item): number => Number(item.replace(/^#/, "")))
    .filter((item): boolean => Number.isInteger(item) && item > 0);
}

function requireTarget(context: VerbContext): Target {
  const raw = context.values["target"];
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
                              [--dry-run] [--allow-open-pr]
      The whole choreography in its load-bearing order: file (already done by
      the caller) -> attach -> close, with the label union and severity maximum
      computed and reported. Runs the SAME open-PR guard 'open-pr-check' does
      over every child that would be closed FIRST, and refuses the whole
      close (listing the blocking PRs) when any of them has one -- an issue
      with an open PR is never quietly closed, because closing it orphans
      work already in flight. --allow-open-pr overrides the refusal.

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
      answer is 'undecidable' -- that is a refusal, not a result; 0 otherwise.`;

export const issueVerb: Verb = {
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
  run(context: VerbContext): number {
    return runIssue(context, defaultRunner);
  },
};

export function runIssue(context: VerbContext, runner: Runner, now = new Date()): number {
  const [subcommand] = context.args;
  try {
    switch (subcommand) {
      case "search":
        return search(context, runner, now);
      case "open-pr-check":
        return openPr(context, runner);
      case "file":
        return file(context, runner);
      case "attach-sub":
        return attach(context, runner);
      case "consolidate-close":
        return consolidate(context, runner);
      case "chain-position":
        return position(context, runner);
      case "terminus":
        return chainTerminus(context, runner);
      default:
        return usage(
          context.io,
          `unknown 'issue' subcommand '${subcommand ?? "(none)"}'. Run 'nen issue --help'.`,
        );
    }
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function search(context: VerbContext, runner: Runner, now: Date): number {
  const target = requireTarget(context);
  const subject = context.values["subject"] ?? "";
  const results = runSearch(runner, target, {
    subject,
    files: commaList(context.values["files"]),
    ruleIds: commaList(context.values["rule-ids"]),
    laneLabels: commaList(context.values["lane-labels"]),
    closedSince: closedSince(now),
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

function printPass(context: VerbContext, entry: RecipeResult): void {
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

function openPr(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const issues = numberList(context.values["issues"]);
  if (issues.length === 0) {
    return usage(context.io, "--issues takes a comma-separated list of issue numbers.");
  }
  const report = openPrCheck(runner, target, issues);
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

function file(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadLabelTaxonomy(root);
  const request: FileRequest = {
    title: context.values["title"] ?? "",
    bodyFile: context.values["body-file"] ?? "",
    labels: commaList(context.values["label"]),
    assignee: context.values["assignee"] ?? "",
    forbiddenFamilies: commaList(context.values["forbid-family"]),
  };
  if (request.bodyFile === "") {
    return usage(context.io, "--body-file <path> is required; a body typed on the command line is a body nobody reviewed.");
  }
  const refusals = validateFiling(request, taxonomy);
  if (refusals.length > 0) {
    for (const refusal of refusals) context.io.err(`nen: ${refusal.reason}`);
    return 1;
  }
  if (context.booleans.has("dry-run")) {
    const argv = createArgv(target, request);
    if (context.json) {
      context.io.out(JSON.stringify({ dryRun: true, argv }, null, 2));
      return 0;
    }
    context.io.out(`would run: gh ${argv.join(" ")}`);
    return 0;
  }
  const result = fileIssue(runner, target, request);
  if (context.json) {
    context.io.out(JSON.stringify({ ...result, labels: request.labels }, null, 2));
    return 0;
  }
  context.io.out(`filed #${result.number} ${result.url}`);
  return 0;
}

function attach(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const parent = Number(context.values["parent"] ?? "");
  const children = numberList(context.values["children"]);
  if (!Number.isInteger(parent) || parent <= 0 || children.length === 0) {
    return usage(context.io, "attach-sub takes --parent <n> and --children <n,n>.");
  }
  const report = attachSub(runner, target, parent, children, context.booleans.has("dry-run"));
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

function consolidate(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const parent = Number(context.values["parent"] ?? "");
  const children = numberList(context.values["children"]);
  if (!Number.isInteger(parent) || parent <= 0 || children.length === 0) {
    return usage(context.io, "consolidate-close takes --parent <n> and --children <n,n>.");
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadLabelTaxonomy(root);
  const severityFamily = context.values["severity-family"] ?? "";
  const plan = planConsolidation(runner, target, parent, children, taxonomy, severityFamily);

  // THE SAME GUARD 'open-pr-check' RUNS, applied to exactly the children this
  // plan would close -- see ./file.ts's header: "an issue with an OPEN PR is
  // never quietly closed, because closing it orphans work already in
  // flight." Without this, consolidate-close's own close loop had no PR
  // check at all, even though the guard already existed one verb over.
  const allowOpenPr = context.booleans.has("allow-open-pr");
  const openPrs = openPrCheck(runner, target, plan.toClose);
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

  const report = consolidateClose(runner, target, plan, context.booleans.has("dry-run"));
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

function position(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const issue = Number(context.values["issue"] ?? "");
  if (!Number.isInteger(issue) || issue <= 0) {
    return usage(context.io, "chain-position takes --issue <n>.");
  }
  const parsed = parseRoleMap(commaList(context.values["chain-labels"]));
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) context.io.err(`nen: --chain-labels: ${message}`);
    return 2;
  }
  const result = chainPosition(runner, target, issue, parsed.map);
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

function chainTerminus(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const issue = Number(context.values["issue"] ?? "");
  if (!Number.isInteger(issue) || issue <= 0) {
    return usage(context.io, "terminus takes --issue <n>.");
  }
  const parsed = parseRoleMap(commaList(context.values["chain-labels"]));
  if (parsed.errors.length > 0) {
    for (const message of parsed.errors) context.io.err(`nen: --chain-labels: ${message}`);
    return 2;
  }
  const result = terminus(
    runner,
    target,
    issue,
    parsed.map,
    context.values["integration-prefix"] ?? null,
    context.values["trunk"] ?? "main",
  );
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.kind === "undecidable" ? 1 : 0;
  }
  context.io.out(`terminus: ${result.kind}`);
  for (const reason of result.evidence) context.io.out(`  ${reason}`);
  // Same discipline as chain-position above: "undecidable" is a refusal.
  return result.kind === "undecidable" ? 1 : 0;
}
