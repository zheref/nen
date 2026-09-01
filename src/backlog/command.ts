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
import { GH, mustJson, type Seams } from "../seam/exec.js";
import { assembleRows, type RawIssue, type RawPr } from "./fetch.js";
import { orderBacklog, type OrderableRow } from "./order.js";

const USAGE = `nen backlog fetch --repo-slug <owner/name> [--limit <n>]
nen backlog order --rows-from <path> --severity-order <a,b,c,d> [--blocks <n,n>] [--affects-consumers <n,n>]

fetch:
  Fetches open issues and open pull requests fresh over 'gh api' (NEVER
  cached) and assembles one row per effort -- an issue plus the PRs that
  reference it, or a lone PR that references no open issue.
  PAGINATED, not one page: GitHub clamps a single page at 100 rows, so this
  follows '?page=N' until a short page comes back rather than stopping at the
  first one (review finding: a one-page fetch capped a repository with >100
  open issues at 100 with no way to lift it -- '--limit' then couldn't raise
  it, and omitting '--limit' selected the cap it was supposed to remove).
  --limit <n>   Caps the TOTAL rows fetched per resource (issues, PRs), across
                as many pages as it takes to reach it. Omit it to fetch every
                open row with NO CAP. A capped fetch is always reported as
                TRUNCATED, never presented as complete.

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

// GitHub's REST API clamps a single page's `per_page` at 100 -- that is a
// PAGE SIZE, not a cap, and `fetchPaginated` follows `?page=N` until a page
// comes back short of it rather than stopping at the first one (review
// finding).
const PAGE_SIZE = 100;
// A defensive ceiling only, never a normal cap: it stops a malformed/looping
// API response from paginating forever. No real repository's open-issue or
// open-PR count is expected to approach it, and hitting it is reported as
// truncated exactly like an explicit --limit would be.
const MAX_PAGES = 200;

interface PaginatedFetch<T> {
  readonly items: T[];
  readonly truncated: boolean;
}

function fetchPaginated<T>(seams: Seams, pathWithQuery: string, limit: number | null): PaginatedFetch<T> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const batch = mustJson<readonly T[]>(seams, GH, [
      "api",
      `${pathWithQuery}&per_page=${PAGE_SIZE}&page=${page}`,
    ]);
    items.push(...batch);
    const isLastPage = batch.length < PAGE_SIZE;
    if (limit !== null && items.length >= limit) {
      // Genuinely truncated only when there is something left to cut: either
      // this page overshot the limit on its own (items.length > limit), or
      // the page that got us to the limit was FULL, so a further page has
      // not been ruled out. When the limit lands exactly on the true last
      // (short) page, nothing was actually cut off.
      const truncated = items.length > limit || !isLastPage;
      return { items: items.slice(0, limit), truncated };
    }
    if (isLastPage) {
      return { items, truncated: false };
    }
  }
  return { items, truncated: true };
}

function fetch(context: CommandContext): number {
  const repo = requireValue(context.args, "repo-slug", "The owner/name to fetch fresh from.");
  const limitRaw = context.args.values["limit"];
  const limit = limitRaw === undefined ? null : Number.parseInt(limitRaw, 10);
  if (limitRaw !== undefined && (!/^\d+$/.test(limitRaw) || (limit ?? 0) < 1)) {
    throw new VerbUsageError(`--limit takes a positive whole number, got '${limitRaw}'.`);
  }

  // `issues?state=open` returns BOTH issues and PRs (GitHub's own API shape);
  // split by the presence of `.pull_request`.
  const rawFetch = fetchPaginated<RawGhIssue>(context.seams, `repos/${repo}/issues?state=open`, limit);
  const raw = rawFetch.items;
  const issues: RawIssue[] = raw
    .filter((item): boolean => item.pull_request === undefined)
    .map((item): RawIssue => ({
      number: item.number,
      title: item.title,
      labels: item.labels.map((label): string => label.name),
      createdAt: item.created_at,
    }));

  const prsFetch = fetchPaginated<{ number: number; title: string; body: string | null; created_at: string }>(
    context.seams,
    `repos/${repo}/pulls?state=open`,
    limit,
  );
  const prs: RawPr[] = prsFetch.items.map((pr): RawPr => ({
    number: pr.number,
    title: pr.title,
    body: pr.body ?? "",
    createdAt: pr.created_at,
  }));

  const truncated = rawFetch.truncated || prsFetch.truncated;
  const assembly = assembleRows(issues, prs);

  const lines = [`${assembly.rows.length} row(s) -- ${assembly.issueCount} issue(s), ${assembly.prCount} PR(s)`];
  if (truncated) {
    lines.push(
      limit === null
        ? `TRUNCATED at a defensive ${MAX_PAGES}-page ceiling: the fetch may not be complete.`
        : `TRUNCATED at --limit ${limit}: the fetch may not be complete. Raise --limit, or omit it to fetch every open row.`,
    );
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
