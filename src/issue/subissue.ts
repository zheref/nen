// src/issue/subissue.ts -- sub-issue attachment and the consolidation close,
// in the one order that is safe.
//
// THE ORDER IS THE FEATURE. `file -> attach -> close`, stated as a rule because
// the alternative has a name: "a close comment that points at an issue that does
// not exist yet is a dead reference, and a failure halfway through leaves the
// backlog in a state nobody planned". So this module runs the steps in that
// order and STOPS at the first failure, rather than continuing to the closes on
// the assumption that the attachments probably worked.
//
// THE API TAKES AN ID, NOT A NUMBER, and that is the single most common way this
// choreography breaks. `POST /repos/{owner}/{repo}/issues/{n}/sub_issues` wants
// the child's internal `id`; the number in the URL bar is the child's
// `number`. Posting the number succeeds for whichever issue happens to carry
// that id -- a DIFFERENT issue, possibly in a different repository -- so the
// resolution is done first, explicitly, and a child whose id cannot be resolved
// is never posted with its number as a guess.
//
// FALLBACK IS DETECTED, NOT PERFORMED. Where the sub-issues API is unavailable
// the documented fallback is a task list in the parent's body. This module
// reports that condition and hands back the exact task-list lines; it does not
// rewrite a body on its own, because "a claimed sub-issue graph that does not
// exist misleads every later sweep" and silently substituting one form for the
// other is how that claim gets made.
//
// THE LABEL UNION AND THE SEVERITY MAXIMUM ARE COMPUTED, NOT CHOSEN. Which
// labels are severities, and which severity outranks which, are the TARGET
// repository's vocabulary: the family is named by the caller and the ordering is
// read from that repository's own colour precedence, falling back to the order
// its taxonomy file declares them in. Nothing here knows a severity's name.

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { decomposeLabelName, type LabelTaxonomy } from "../schema/labels.js";

export interface IssueSummary {
  readonly number: number;
  readonly id: number | null;
  readonly title: string;
  readonly state: string;
  readonly labels: readonly string[];
}

// One `gh api` read per issue. REST rather than `gh issue view`, because `id`
// -- the field the sub-issues API actually takes -- is not one of the fields
// `gh issue view --json` exposes.
export function readIssue(runner: Runner, target: Target, number: number): IssueSummary {
  const result = runner.run({
    bin: "gh",
    args: ["api", `repos/${target.slug}/issues/${number}`],
  });
  if (result.code !== 0) {
    throw new Error(
      `could not read ${target.slug}#${number}: ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }`,
    );
  }
  const parsed = JSON.parse(result.stdout) as Record<string, unknown>;
  const rawLabels = parsed["labels"];
  const labels = Array.isArray(rawLabels)
    ? rawLabels
        .map((label): string =>
          typeof label === "string" ? label : String((label as Record<string, unknown>)["name"] ?? ""),
        )
        .filter((name): boolean => name !== "")
    : [];
  const rawId = parsed["id"];
  return {
    number: Number(parsed["number"] ?? number),
    id: typeof rawId === "number" ? rawId : null,
    title: String(parsed["title"] ?? ""),
    state: String(parsed["state"] ?? ""),
    labels,
  };
}

export interface AttachReport {
  readonly attached: readonly number[];
  readonly failed: readonly { readonly child: number; readonly reason: string }[];
  /**
   * Present when the API answered in a way that says the sub-issues endpoint is
   * not available here. The task-list lines are handed back so the caller can
   * use the documented fallback KNOWINGLY -- and say which form was used.
   */
  readonly fallbackTaskList: readonly string[] | null;
  readonly log: readonly string[];
}

// A response that means "this endpoint does not exist here" rather than "this
// request was wrong". 404 and 410 are the two GitHub returns for an endpoint
// that is absent or retired; a 422 is a bad request and must NOT be read as a
// missing API, because doing so would substitute the fallback for a defect.
function looksUnavailable(stderr: string): boolean {
  return /HTTP (404|410)\b/.test(stderr);
}

export function attachSub(
  runner: Runner,
  target: Target,
  parent: number,
  children: readonly number[],
  dryRun: boolean,
): AttachReport {
  const attached: number[] = [];
  const failed: { child: number; reason: string }[] = [];
  const log: string[] = [];
  let fallback: string[] | null = null;

  for (const child of children) {
    let summary: IssueSummary;
    try {
      summary = readIssue(runner, target, child);
    } catch (error) {
      failed.push({ child, reason: error instanceof Error ? error.message : String(error) });
      continue;
    }
    if (summary.id === null) {
      failed.push({
        child,
        reason: `#${child} carries no 'id' in the API response, and the sub-issues endpoint takes an id. Posting the NUMBER instead would attach whichever issue happens to hold that id.`,
      });
      continue;
    }
    const argv = [
      "api",
      "--method",
      "POST",
      `repos/${target.slug}/issues/${parent}/sub_issues`,
      "-F",
      `sub_issue_id=${summary.id}`,
    ];
    if (dryRun) {
      log.push(`would run: gh ${argv.join(" ")}   (#${child} -> id ${summary.id})`);
      attached.push(child);
      continue;
    }
    const result = runner.run({ bin: "gh", args: argv });
    if (result.code === 0) {
      attached.push(child);
      log.push(`attached #${child} (id ${summary.id}) to #${parent}`);
      continue;
    }
    const reason = (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`;
    failed.push({ child, reason });
    if (fallback === null && looksUnavailable(result.stderr)) {
      fallback = children.map((entry): string => `- [ ] #${entry}`);
      log.push(
        "the sub-issues endpoint answered 404/410 -- it is not available here. The documented fallback is a task list in the parent's body; the lines are in this report, and whichever form is used must be SAID, because a claimed sub-issue graph that does not exist misleads every later sweep.",
      );
    }
  }
  return { attached, failed, fallbackTaskList: fallback, log };
}

// --- consolidation -----------------------------------------------------------

export interface ConsolidationPlan {
  readonly parent: number;
  readonly children: readonly IssueSummary[];
  /** The union of every child's labels, minus the severity family. */
  readonly labelUnion: readonly string[];
  /** The highest severity among the children, or null when none carries one. */
  readonly severity: string | null;
  /** Which child set the severity -- so an overruled maximum can be argued with. */
  readonly severitySetBy: number | null;
  /** Children that already carry an open state and would be closed. */
  readonly toClose: readonly number[];
  readonly notes: readonly string[];
}

export interface SeverityOrdering {
  /** `<namespace>:<family>`, e.g. as the target repository spells its severities. */
  readonly family: string;
  /** Leaf names, strongest first. */
  readonly order: readonly string[];
}

// The declaration order of a family's labels in the repository's own taxonomy
// file, which is the ordering the file itself asserts by writing them down in
// that sequence. It is a WEAKER source than an explicit precedence list and is
// used only when none is supplied -- and the plan says which was used.
export function orderingFromTaxonomy(taxonomy: LabelTaxonomy, family: string): SeverityOrdering {
  const [namespace, leaf] = family.split(":");
  if (namespace === undefined || leaf === undefined) return { family, order: [] };
  return {
    family,
    order: taxonomy
      .inFamily(namespace, leaf)
      .map((label): string => decomposeLabelName(label.name).leaf ?? "")
      .filter((name): boolean => name !== ""),
  };
}

export function planConsolidation(
  runner: Runner,
  target: Target,
  parent: number,
  children: readonly number[],
  taxonomy: LabelTaxonomy,
  severityFamily: string,
  ordering?: SeverityOrdering,
): ConsolidationPlan {
  const summaries = children.map((child): IssueSummary => readIssue(runner, target, child));
  const notes: string[] = [];

  const resolved =
    ordering ??
    (severityFamily === ""
      ? { family: "", order: [] }
      : orderingFromTaxonomy(taxonomy, severityFamily));
  if (severityFamily !== "" && ordering === undefined) {
    notes.push(
      `severity ordering read from ${taxonomy.path}'s declaration order for '${severityFamily}': ${resolved.order.join(" > ") || "(none declared)"}`,
    );
  }

  const union = new Set<string>();
  let severity: string | null = null;
  let severitySetBy: number | null = null;
  let bestRank = Number.MAX_SAFE_INTEGER;

  for (const child of summaries) {
    for (const label of child.labels) {
      const parts = decomposeLabelName(label);
      const family =
        parts.namespace === null || parts.family === null
          ? null
          : `${parts.namespace}:${parts.family}`;
      if (family !== null && family === severityFamily) {
        const rank = resolved.order.indexOf(parts.leaf ?? "");
        if (rank !== -1 && rank < bestRank) {
          bestRank = rank;
          severity = label;
          severitySetBy = child.number;
        }
        // A severity label is NOT unioned: exactly one belongs on the
        // consolidated issue, and unioning them would leave the parent carrying
        // several at once -- which is a state-machine violation, not a merge.
        continue;
      }
      union.add(label);
    }
  }

  const toClose = summaries
    .filter((child): boolean => child.state.toLowerCase() === "open")
    .map((child): number => child.number);
  const alreadyClosed = summaries.filter((child): boolean => child.state.toLowerCase() !== "open");
  if (alreadyClosed.length > 0) {
    notes.push(
      `already closed, so not closed again: ${alreadyClosed.map((child): string => `#${child.number}`).join(", ")}`,
    );
  }

  return {
    parent,
    children: summaries,
    labelUnion: [...union].sort(),
    severity,
    severitySetBy,
    toClose,
    notes,
  };
}

export interface ConsolidateReport {
  readonly log: readonly string[];
  readonly failed: readonly string[];
  readonly attached: readonly number[];
  readonly closed: readonly number[];
}

// file -> attach -> close, and it stops at the first failing STAGE.
//
// The parent must already exist -- filing it is `nen issue file`, and it is a
// separate call on purpose: the consolidated issue's title and body are written
// by a human or an LLM, and a verb that generated them would be authoring the
// judgment this whole surface refuses to author.
export function consolidateClose(
  runner: Runner,
  target: Target,
  plan: ConsolidationPlan,
  dryRun: boolean,
): ConsolidateReport {
  const log: string[] = [];
  const failed: string[] = [];

  log.push(`parent: #${plan.parent}`);
  log.push(`label union: ${plan.labelUnion.join(", ") || "(none)"}`);
  log.push(
    `severity: ${plan.severity ?? "(none)"}${plan.severitySetBy === null ? "" : ` (set by #${plan.severitySetBy})`}`,
  );
  for (const note of plan.notes) log.push(`note: ${note}`);

  const attachReport = attachSub(
    runner,
    target,
    plan.parent,
    plan.children.map((child): number => child.number),
    dryRun,
  );
  log.push(...attachReport.log);
  if (attachReport.failed.length > 0) {
    for (const failure of attachReport.failed) {
      failed.push(`attach #${failure.child}: ${failure.reason}`);
    }
    log.push(
      "STOPPED before the closes. A close comment naming a parent whose sub-issue graph is incomplete is a claim the graph does not support; the closes are the last step for exactly this reason.",
    );
    return { log, failed, attached: attachReport.attached, closed: [] };
  }

  const closed: number[] = [];
  for (const child of plan.toClose) {
    const comment = `Consolidated into #${plan.parent}.`;
    const argv = [
      "issue",
      "close",
      String(child),
      "--repo",
      target.slug,
      "--comment",
      comment,
    ];
    if (dryRun) {
      log.push(`would run: gh ${argv.join(" ")}`);
      closed.push(child);
      continue;
    }
    const result = runner.run({ bin: "gh", args: argv });
    if (result.code !== 0) {
      failed.push(
        `close #${child}: ${(result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`}`,
      );
      continue;
    }
    closed.push(child);
    log.push(`closed #${child} with a comment naming #${plan.parent}`);
  }
  return { log, failed, attached: attachReport.attached, closed };
}
