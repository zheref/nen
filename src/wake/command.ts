// src/wake/command.ts -- `nen wake fire` and `nen wake verify`.
//
// `nen wake verify` is the seam-driven half of the ../wake/detect.ts port: it
// fetches the inputs (open PRs, their workflow runs, their comments) over
// `gh api`, hands them to the pure decision engine, and executes what it
// decided (a redrive, a flag comment) -- but ONLY when `--run` is given.
// DRY-RUN IS THE DEFAULT (review finding): this verb reruns workflows and
// posts comments on GitHub, so despite its name reading as an inspection it
// follows the same CON-38 dry-run-first convention as `nen wake fire --run`
// and `nen label apply --run` rather than being the one write-by-default
// exception.
//
// A FAILED REDRIVE OR A FAILED COMMENT POST NEVER ABORTS THE SWEEP (ported
// from bankai-core#398 and PR #411, both of which this port had silently
// reverted before review): a failing `gh run rerun` falls back to posting a
// human flag instead, and a failing comment POST is a warning, not a thrown
// ToolError -- either would otherwise strand every PR after the failing one
// unscanned. See `postCommentBestEffort` below.
//
// FIDELITY GAP, DISCLOSED RATHER THAN SILENT: the source paginates every one
// of these three fetches with `gh api --paginate`, so a PR list, a run
// history or a comment thread longer than one page is followed in full. This
// port issues ONE page per fetch (`per_page=100` for PRs and comments,
// `per_page=50` for runs -- the source's own page size for runs). That covers
// the overwhelming majority of real invocations and keeps this command a
// single round trip per resource rather than an open-ended paginating loop
// this port has not built and tested; a repository whose open-PR count or
// comment history exceeds one page is under-scanned rather than mis-scanned
// -- the missing rows are simply not examined this tick, which is the same
// direction `MAX_PRS`/`MAX_RUNS_PER_PR` already bound the scan in.
//
// `nen wake fire` is the edge-trigger half the issue names separately: firing
// a wake ALONE on one object by removing and re-applying a label (the
// convention several skills use to re-fire a label-triggered workflow on a
// conflicted PR), then settling with a comment. It follows sync-labels.sh's
// dry-run-first convention (CON-38): nothing is written to GitHub unless
// `--run` is given.

import {
  emit,
  readInteger,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { GH, must, mustJson, type Seams } from "../seam/exec.js";
import {
  decideActions,
  flagBody,
  type PlannedAction,
  type StampedComment,
  type WorkflowRun,
} from "./detect.js";

const USAGE = `nen wake verify --repo-slug <owner/name> --now <ISO-8601> --author-pattern <regex> [--max-prs <n>] [--max-runs-per-pr <n>] [--flag-marker <text>] [--redrive-marker <text>] [--run]
nen wake fire --repo-slug <owner/name> --ref <object-ref> --label <name> [--comment <text>] [--run]

verify:
  Scans open pull requests whose author matches --author-pattern for a
  workflow run that concluded 'action_required' or 'startup_failure' and never
  executed -- and auto-redrives what can safely be redriven, at most once per
  run, falling back to a comment flag for a human
  otherwise. --now is the sweep's own instant (env NOW in the source), read
  once and never the live clock, so a replay is reproducible.
  --author-pattern <regex>  Which PR authors are in scope. Nen carries no
                            repository's agent-login list; this is a required
                            flag rather than a default.
  --flag-marker <text>      The full idempotency-stamp phrase a detect-only
                            flag comment is recognised by (default
                            nen-wake-guard). NOT interoperable at its default
                            with the shell sweep this was ported from -- a
                            migration caller running both against the same
                            repository should set this to that script's own
                            marker phrase (this module's own header comment
                            names it).
  --redrive-marker <text>   The full idempotency-stamp phrase a redrive
                            comment is recognised by (default
                            nen-wake-redrive). Same interoperability note as
                            --flag-marker.
  --max-prs <n>             Default 6. --max-runs-per-pr <n>  Default 3.
  --run                     Without it, nothing is written -- CON-38's
                            dry-run-first convention (scripts/sync-labels.sh);
                            this verb MUTATES GitHub (reruns workflows, posts
                            comments) and stays report-only until --run is
                            given, the same as every other mutating verb here.

fire:
  Fires a wake ALONE on one object by removing then re-applying a label (the
  edge-trigger convention several skills rely on to re-fire a label-triggered
  workflow), then posts a settle comment if --comment is given.
  --ref <object-ref>   <CODE>-<IS|PR>-#<N>; only the number is used against
                       --repo-slug's own numbering.
  --label <name>       The label to remove and re-apply.
  --comment <text>     A settle comment posted after the re-apply.
  --run                Without it, nothing is written -- CON-38's dry-run-first
                       convention (scripts/sync-labels.sh).`;

interface RawRun {
  readonly id: number;
  readonly conclusion: string | null;
  readonly html_url: string;
  readonly event: string;
  readonly created_at: string;
  readonly workflow_id: number;
  readonly status: string;
}

interface RawComment {
  readonly body?: string | null;
}

interface RawPr {
  readonly number: number;
  readonly draft: boolean;
  readonly user: { readonly login?: string | null } | null;
  readonly head: { readonly ref: string; readonly repo: { readonly id: number } | null };
  readonly base: { readonly repo: { readonly id: number } | null };
}

function toRun(raw: RawRun): WorkflowRun {
  return {
    id: String(raw.id),
    conclusion: raw.conclusion,
    htmlUrl: raw.html_url,
    event: raw.event,
    createdAt: raw.created_at,
    workflowId: String(raw.workflow_id),
    status: raw.status,
  };
}

function verify(context: CommandContext): number {
  const repo = requireValue(context.args, "repo-slug", "The owner/name this scan reads over gh api.");
  const now = requireValue(context.args, "now", "Read once per sweep, never the live clock -- so a replay is reproducible.");
  const authorPatternRaw = requireValue(
    context.args,
    "author-pattern",
    "Nen carries no repository's agent-login list.",
  );
  let authorPattern: RegExp;
  try {
    authorPattern = new RegExp(authorPatternRaw);
  } catch (error) {
    throw new VerbUsageError(
      `--author-pattern '${authorPatternRaw}' is not a valid regular expression (${error instanceof Error ? error.message : String(error)}).`,
    );
  }
  // TWO FULL MARKER PHRASES, not one marker with a kind word appended: the
  // source stamps a flag with `bankai swallowed-wake-guard` and a redrive
  // with `bankai swallowed-wake-redrive`, and no single shared value can
  // reproduce both (review finding). A migration caller running nen
  // alongside the still-scheduled shell sweep can set these to the source's
  // exact phrases so each recognises the other's stamps.
  const flagMarker = context.args.values["flag-marker"] ?? "nen-wake-guard";
  const redriveMarker = context.args.values["redrive-marker"] ?? "nen-wake-redrive";
  const maxPrs = readInteger(context.args, "max-prs", 6);
  const maxRunsPerPr = readInteger(context.args, "max-runs-per-pr", 3);
  // MUTATES GITHUB ONLY WHEN --run IS GIVEN. This is a scan that reruns
  // workflows and posts comments, not an inspection -- every other mutating
  // verb on this branch (`nen wake fire --run`, `nen label apply --run`) is
  // dry-run-first (CON-38, scripts/sync-labels.sh), and a verb whose name
  // reads as verification must not be the one exception that writes by
  // default (review finding).
  const write = context.args.booleans.has("run");
  const dryRun = !write;

  const prs = mustJson<RawPr[]>(context.seams, GH, [
    "api",
    `repos/${repo}/pulls?state=open&per_page=100`,
  ]);

  const scoped = prs.filter((pr): boolean => {
    if (pr.draft) return false;
    if (pr.head.repo === null || pr.base.repo === null || pr.head.repo.id !== pr.base.repo.id) return false;
    return authorPattern.test(pr.user?.login ?? "");
  });

  const results: {
    readonly prNumber: number;
    readonly actions: readonly PlannedAction[];
  }[] = [];
  const warnings: string[] = [];

  let scanned = 0;
  for (const pr of scoped) {
    if (scanned >= maxPrs) break;
    scanned += 1;

    const rawRuns = mustJson<{ workflow_runs?: readonly RawRun[] }>(context.seams, GH, [
      "api",
      `repos/${repo}/actions/runs?branch=${pr.head.ref}&per_page=50`,
    ]);
    const runs = (rawRuns.workflow_runs ?? []).map(toRun);
    if (pickSwallowedCount(runs) === 0) continue;

    const rawComments = mustJson<readonly RawComment[]>(context.seams, GH, [
      "api",
      `repos/${repo}/issues/${pr.number}/comments?per_page=100`,
    ]);
    const comments: StampedComment[] = rawComments.map((comment): StampedComment => ({
      body: comment.body ?? "",
    }));

    const actions = decideActions({ runs, comments, now, flagMarker, redriveMarker, maxRunsPerPr });
    results.push({ prNumber: pr.number, actions });

    if (!write) continue;
    // A FAILED REDRIVE OR A FAILED COMMENT POST MUST NEVER TAKE THE WHOLE
    // SWEEP DOWN (bankai-core#398/PR #411, ported behaviour): the source uses
    // `seams.run` here rather than `must`, warns, and moves on to the next PR
    // rather than throwing ToolError and stranding every PR after this one
    // unscanned.
    for (const action of actions) {
      if (action.kind === "redrive") {
        const rerun = context.seams.run(GH, ["run", "rerun", action.run.id, "--repo", repo]);
        if (rerun.spawnFailed || rerun.code !== 0) {
          warnings.push(`#${pr.number}: gh run rerun ${action.run.id} failed -- falling back to a human flag.`);
          postCommentBestEffort(
            context.seams,
            repo,
            pr.number,
            flagBody({
              flagMarker,
              runId: action.run.id,
              htmlUrl: action.run.htmlUrl,
              now,
              conclusion: action.run.conclusion ?? "",
              note: `Auto-redrive attempted 'gh run rerun ${action.run.id}' and it failed -- needs a human.`,
            }),
            warnings,
          );
          continue;
        }
      }
      if (action.commentBody !== null) {
        postCommentBestEffort(context.seams, repo, pr.number, action.commentBody, warnings);
      }
    }
  }

  const lines: string[] = [`scanned ${scanned} PR(s)${dryRun ? " (dry run)" : ""}`];
  let total = 0;
  for (const result of results) {
    for (const action of result.actions) {
      total += 1;
      lines.push(`#${result.prNumber} run ${action.run.id}: ${action.kind} -- ${action.reason}`);
    }
  }
  if (total === 0) lines.push("no swallowed wakes found");
  for (const warning of warnings) lines.push(`warning: ${warning}`);

  emit(context.io, context.json, { repo, now, dryRun, scanned, results, warnings }, lines);
  return 0;
}

/**
 * Post a comment, tolerating a transient failure of the POST itself: by the
 * time this is called the tick already took its real action (a redrive, or
 * deciding to flag), so a failed comment must never take the whole sweep
 * down -- see the caller's own header for the incident this preserves
 * (bankai-core#398/PR #411).
 */
function postCommentBestEffort(
  seams: Seams,
  repo: string,
  prNumber: number,
  body: string,
  warnings: string[],
): void {
  const result = seams.run(GH, ["api", `repos/${repo}/issues/${prNumber}/comments`, "-f", `body=${body}`]);
  if (result.spawnFailed || result.code !== 0) {
    warnings.push(
      `#${prNumber}: the action above this line took effect, but posting its follow-up comment failed -- this tick is not marked, so a later sweep may retry it.`,
    );
  }
}

function pickSwallowedCount(runs: readonly WorkflowRun[]): number {
  return runs.filter((run): boolean => run.conclusion === "action_required" || run.conclusion === "startup_failure").length;
}

function fire(context: CommandContext): number {
  const repo = requireValue(context.args, "repo-slug", "The owner/name to fire against.");
  const refToken = requireValue(context.args, "ref", "The object to fire the wake on.");
  const numberMatch = /#(\d+)$/.exec(refToken);
  if (numberMatch === null) {
    throw new VerbUsageError(`--ref '${refToken}' does not carry a '#<N>' -- expected object notation <CODE>-<IS|PR>-#<N>.`);
  }
  const number = numberMatch[1];
  if (number === undefined) {
    throw new VerbUsageError(`--ref '${refToken}' does not carry a '#<N>' -- expected object notation <CODE>-<IS|PR>-#<N>.`);
  }
  const label = requireValue(context.args, "label", "The label removed then re-applied to edge-trigger the wake.");
  const comment = context.args.values["comment"] ?? null;
  const run = context.args.booleans.has("run");

  const lines = [
    `${run ? "" : "(dry run) "}remove label '${label}' from ${repo}#${number}`,
    `${run ? "" : "(dry run) "}re-apply label '${label}' to ${repo}#${number}`,
  ];
  if (comment !== null) lines.push(`${run ? "" : "(dry run) "}post settle comment on ${repo}#${number}`);
  if (!run) lines.push("nothing written -- pass --run to fire for real.");

  if (run) {
    must(context.seams, GH, ["issue", "edit", number, "--repo", repo, "--remove-label", label]);
    must(context.seams, GH, ["issue", "edit", number, "--repo", repo, "--add-label", label]);
    if (comment !== null) {
      must(context.seams, GH, ["api", `repos/${repo}/issues/${number}/comments`, "-f", `body=${comment}`]);
    }
  }

  emit(context.io, context.json, { repo, number, label, comment, run }, lines);
  return 0;
}

export const wakeCommand: Command = {
  name: "wake",
  summary: "Fire or verify a wake: redrive/flag a swallowed run, or edge-trigger a re-apply.",
  usage: USAGE,
  flags: {
    values: [
      "repo-slug",
      "now",
      "author-pattern",
      "flag-marker",
      "redrive-marker",
      "max-prs",
      "max-runs-per-pr",
      "ref",
      "label",
      "comment",
    ],
    booleans: ["run"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("wake", context.args, ["fire", "verify"]);
    return subcommand === "verify" ? verify(context) : fire(context);
  },
};

export type { Seams };
