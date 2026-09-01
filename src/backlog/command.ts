// src/backlog/command.ts -- `nen backlog fetch` and `nen backlog order`.

import {
  emit,
  requireSubcommand,
  requireValue,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile, splitList } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { GH, mustJson } from "../seam/exec.js";
import { assembleRows, type RawIssue, type RawPr } from "./fetch.js";
import { orderBacklog, type OrderableRow } from "./order.js";

const USAGE = `nen backlog fetch --repo-slug <owner/name> [--limit <n>]
nen backlog order --rows-from <path> --severity-order <a,b,c,d> [--blocks <n,n>] [--affects-consumers <n,n>]

fetch:
  Fetches open issues and open pull requests fresh over 'gh api' (NEVER
  cached) and assembles one row per effort -- an issue plus the PRs that
  reference it, or a lone PR that references no open issue.
  --limit <n>   Caps the fetch. NO SILENT CAPS: a limited fetch is reported as
                truncated in the output, never presented as complete.

order:
  Applies the backlog-loop §2 priority order to a pre-fetched row set:
  severity (in the order given) first, then within a severity: blocks another
  issue, then affects consumer behaviour/DX, then age (oldest first), then
  issue number.
  --rows-from <path>        A JSON array of rows: { id, severity, createdAt,
                            number }, e.g. 'backlog fetch --json' reshaped.
  --severity-order <a,b,..> This repository's own severity vocabulary, in
                            priority order. A row whose severity is not in
                            this list ranks LAST.
  --blocks <n,n>            Row ids that block another issue.
  --affects-consumers <n,n> Row ids that affect consumer behaviour/DX.`;

interface RawGhIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly { readonly name: string }[];
  readonly created_at: string;
  readonly pull_request?: unknown;
}

function fetch(context: CommandContext): number {
  const repo = requireValue(context.args, "repo-slug", "The owner/name to fetch fresh from.");
  const limit = context.args.values["limit"];
  const perPage = limit === undefined ? 100 : Number.parseInt(limit, 10);
  if (limit !== undefined && (!/^\d+$/.test(limit) || perPage < 1)) {
    throw new VerbUsageError(`--limit takes a positive whole number, got '${limit}'.`);
  }

  // `issues?state=open` returns BOTH issues and PRs (GitHub's own API shape);
  // split by the presence of `.pull_request`.
  const raw = mustJson<readonly RawGhIssue[]>(context.seams, GH, [
    "api",
    `repos/${repo}/issues?state=open&per_page=${perPage}`,
  ]);
  const issues: RawIssue[] = raw
    .filter((item): boolean => item.pull_request === undefined)
    .map((item): RawIssue => ({
      number: item.number,
      title: item.title,
      labels: item.labels.map((label): string => label.name),
      createdAt: item.created_at,
    }));

  const rawPrs = mustJson<readonly { number: number; title: string; body: string | null; created_at: string }[]>(
    context.seams,
    GH,
    ["api", `repos/${repo}/pulls?state=open&per_page=${perPage}`],
  );
  const prs: RawPr[] = rawPrs.map((pr): RawPr => ({
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    createdAt: pr.created_at,
  }));

  const truncated = raw.length >= perPage || rawPrs.length >= perPage;
  const assembly = assembleRows(issues, prs);

  const lines = [`${assembly.rows.length} row(s) -- ${assembly.issueCount} issue(s), ${assembly.prCount} PR(s)`];
  if (truncated) {
    lines.push(`TRUNCATED at --limit ${perPage}: the fetch may not be complete. Raise --limit or omit it.`);
  }
  for (const row of assembly.rows) {
    const subject = row.issueNumber === null ? `PR #${row.prNumbers[0]}` : `#${row.issueNumber}`;
    const prList = row.prNumbers.length > 0 ? ` [${row.prNumbers.map((n): string => `#${n}`).join(", ")}]` : "";
    lines.push(`${subject}${prList}  ${row.title}`);
  }

  emit(context.io, context.json, { repo, truncated, ...assembly }, lines);
  return 0;
}

function order(context: CommandContext): number {
  const path = requireValue(context.args, "rows-from", "The JSON row array to order.");
  const orderRaw = requireValue(context.args, "severity-order", "This repository's own severity vocabulary, in priority order.");
  const severityOrder = splitList(orderRaw);
  const blocks = new Set(splitList(context.args.values["blocks"]));
  const affects = new Set(splitList(context.args.values["affects-consumers"]));

  const cwd = resolveRepoRoot({ repoFlag: context.repoFlag });
  interface InRow {
    readonly id: string;
    readonly severity: string | null;
    readonly createdAt: string;
    readonly number: number;
  }
  const input = readJsonFile<readonly InRow[]>(path, cwd);
  const rows: OrderableRow[] = input.map((row): OrderableRow => ({
    id: row.id,
    severity: row.severity,
    blocksOther: blocks.has(row.id),
    affectsConsumers: affects.has(row.id),
    createdAt: row.createdAt,
    number: row.number,
  }));

  const ordered = orderBacklog(rows, severityOrder);
  const lines = ordered.map((row, index): string =>
    `${index + 1}. ${row.id}  severity=${row.severity ?? "(none)"}${row.blocksOther ? " blocks" : ""}${row.affectsConsumers ? " affects-consumers" : ""}  ${row.createdAt}`,
  );
  emit(context.io, context.json, { severityOrder, rows: ordered }, lines);
  return 0;
}

export const backlogCommand: Command = {
  name: "backlog",
  summary: "Fetch the backlog fresh, or order a pre-fetched row set.",
  usage: USAGE,
  flags: {
    values: ["repo-slug", "limit", "rows-from", "severity-order", "blocks", "affects-consumers"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("backlog", context.args, ["fetch", "order"]);
    return subcommand === "fetch" ? fetch(context) : order(context);
  },
};
