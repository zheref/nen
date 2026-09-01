// src/backlog/fetch.ts -- assembling one row per EFFORT from open issues and
// open pull requests.
//
// PORTED FROM the backlog-state skill §3's three fetching rules:
//
//   1. NEVER WORK FROM A CACHED LIST. Labels, severities and review state
//      change under you; this module holds no cache of its own -- every call
//      is handed fresh data by its caller (../backlog/command.ts, which reads
//      it fresh over `gh api` on every invocation).
//   2. NO SILENT CAPS. If a fetch is truncated, the caller must say so
//      alongside the rows -- see ../backlog/command.ts's `truncated` report
//      field, which this module's `Assembly` carries through.
//   3. AN ISSUE AND THE PRs THAT SERVE IT ARE ONE ROW. "The unit is the
//      effort, not the object." A PR that references no open issue is its own
//      row (an effort with no separately-filed issue is still an effort).

export interface RawIssue {
  readonly number: number;
  readonly title: string;
  readonly labels: readonly string[];
  readonly createdAt: string;
}

export interface RawPr {
  readonly number: number;
  readonly title: string;
  readonly body: string;
  readonly createdAt: string;
}

export interface BacklogRow {
  /** null when this row is a PR with no linked issue. */
  readonly issueNumber: number | null;
  readonly title: string;
  readonly labels: readonly string[];
  readonly prNumbers: readonly number[];
  readonly createdAt: string;
}

export interface Assembly {
  readonly rows: readonly BacklogRow[];
  readonly issueCount: number;
  readonly prCount: number;
}

// A PR "serves" an issue when its title or body references it via a GitHub
// closing keyword or a bare `#<n>` -- the same cross-reference surface a
// reader following the PR would use to find the issue it delivers. Matched
// case-insensitively, as GitHub's own keyword parsing is.
const CLOSING_KEYWORDS = ["close", "closes", "closed", "fix", "fixes", "fixed", "resolve", "resolves", "resolved"];
const REF_PATTERN = new RegExp(`(?:\\b(?:${CLOSING_KEYWORDS.join("|")})\\s+)?#(\\d+)`, "gi");

export function referencedIssueNumbers(text: string): Set<number> {
  const found = new Set<number>();
  for (const match of text.matchAll(REF_PATTERN)) {
    const digits = match[1];
    if (digits !== undefined) found.add(Number.parseInt(digits, 10));
  }
  return found;
}

/** Assemble one row per issue (with the PRs that reference it), plus one row per unreferenced PR. */
export function assembleRows(issues: readonly RawIssue[], prs: readonly RawPr[]): Assembly {
  const byIssue = new Map<number, number[]>();
  for (const issue of issues) byIssue.set(issue.number, []);

  const orphanPrs: RawPr[] = [];
  for (const pr of prs) {
    const refs = referencedIssueNumbers(`${pr.title}\n${pr.body}`);
    let matched = false;
    for (const ref of refs) {
      const list = byIssue.get(ref);
      if (list !== undefined) {
        list.push(pr.number);
        matched = true;
      }
    }
    if (!matched) orphanPrs.push(pr);
  }

  const rows: BacklogRow[] = issues.map((issue): BacklogRow => ({
    issueNumber: issue.number,
    title: issue.title,
    labels: issue.labels,
    prNumbers: (byIssue.get(issue.number) ?? []).slice().sort((a, b): number => a - b),
    createdAt: issue.createdAt,
  }));

  for (const pr of orphanPrs) {
    rows.push({
      issueNumber: null,
      title: pr.title,
      labels: [],
      prNumbers: [pr.number],
      createdAt: pr.createdAt,
    });
  }

  return { rows, issueCount: issues.length, prCount: prs.length };
}
