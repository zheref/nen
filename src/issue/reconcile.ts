// src/issue/reconcile.ts -- `nen issue reconcile`: which OPEN issues a LANDED
// pull request already claims to close, proposed and never acted on
// (zheref/nen#332).
//
// READ-ONLY AND PROPOSE-ONLY, BY RULING -- the maintainer's ruling recorded on
// this verb's PR (zheref/nen#332's delivery), which narrowed the issue's "closes
// or proposes closure" to PROPOSES ONLY: this module finds open issues a
// merged pull request already closes, and says which issue, on which evidence,
// and what it suggests -- in the human rendering and in --json alike. It never
// closes, comments, labels or otherwise writes to GitHub, and there is no flag
// that makes it. That is also why it has no --dry-run: a dry run previews a
// write, and there is none to preview. Every `gh` call below is a READ, and the
// test suite asserts that positively over every call a run makes.
//
// EVERY PROPOSAL IS EVIDENCE-BOUND. A proposal exists only where a MERGED pull
// request carries a CLOSING REFERENCE to the issue -- GitHub's own
// `closingIssuesReferences` (which also catches a sidebar link with no text),
// or a closing keyword (`Closes #12`, `fixes owner/name#12`, a full issue URL)
// in the PR's body or in one of its commit messages. The report cites the PR,
// its merge commit and the exact reference text. Nothing here ever matches on
// title similarity, on a bare `#12` mention, or on `Part of #12`: a mention is
// not a claim that the work is done, and a title that looks alike is not
// evidence of anything. The closing reference is the PR author's own claim that
// the issue is finished; that is the strongest statement GitHub records short of
// the close itself, and the verb says it is a claim rather than a verified
// criterion.
//
// WHY AN ISSUE CAN BE OPEN WITH A MERGED CLOSING REFERENCE AT ALL. GitHub closes
// an issue through a keyword only when the PR merges into the DEFAULT branch. A
// PR merged into an integration or epic branch leaves the issue open even after
// that branch itself lands -- the commit reached the trunk through a merge that
// carries no keyword. So "landed" is decided here, not assumed: a PR whose base
// IS the default branch has landed; any other base is checked with
// `repos/{o}/{n}/compare/{default}...{mergeCommit}`, whose `behind`/`identical`
// answer means the merge commit is reachable from the default branch. `ahead`
// means it is not. `diverged` is weaker than it looks: a base branch that was
// SQUASHED or REBASED into the default branch reads `diverged` too, because its
// commits arrived as different ones -- so a diverged merge never asserts "has
// NOT reached"; the verb looks for a merged delivery PR from that base into the
// default branch and proposes `verify` citing it when there is one, `wait`
// (worded as "not reachable") when there is none. Neither is ever `close`.
//
// AN UNREADABLE SOURCE IS A FINDING, NEVER "NOTHING TO RECONCILE". Every read
// that fails is carried as a finding, and so is a partial one -- an open list
// that came back full, a search that matched more than it returned (it may have
// stopped before the PR that matters). Any finding makes the run exit
// 1, and the human rendering says in words that an empty proposal list under a
// finding is not a clean answer -- the same "found nothing" vs "could not look"
// rule ./search.ts follows.
//
// NAMES ARE DATA (the Akatsuki migration's § 3). No label is known here. A
// repository's "do not close this" override is whatever it calls it, and the
// caller hands those names in through --hold-labels; with none given, nothing is
// held. They match case-insensitively, as GitHub's label names do, and a named
// hold label that matches no label in the REPOSITORY's own label list is a
// FINDING -- a typo must never read as "nothing held". A label that exists but
// sits on no open issue today is fine and silent. The closing keywords are
// GitHub's own grammar, not any repository's vocabulary, and `REOPENED` is GitHub's `stateReason` enum.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { openPrCheck } from "./file.js";
import { plainLine } from "../cli/plain.js";

export const RECONCILE_CONTRACT = "nen.issue.reconcile/v0.1";

/** The page both lists are asked for by default, and the number a truncation is judged against. */
export const RECONCILE_LIMIT = 100;

/** The largest --limit accepted: GitHub search's ceiling -- it returns no result past the 1000th. */
export const RECONCILE_MAX_LIMIT = 1000;

// --- closing references ------------------------------------------------------

/** Where a closing reference was read from. */
export type ReferenceSource = "linked" | "body" | "commit";

export interface ClosingReference {
  readonly source: ReferenceSource;
  /**
   * The reference exactly as it was written (`Closes #12`), or, for a `linked`
   * reference, the issue URL GitHub's `closingIssuesReferences` returned.
   */
  readonly text: string;
  /** The commit whose message carried it; `null` for `linked` and `body`. */
  readonly commit: string | null;
}

// GitHub's closing keywords, each followed by ONE reference. `Closes #1, #2`
// closes only #1 on GitHub, and this grammar agrees: the keyword binds to the
// reference immediately after it and nothing further. An optional colon is
// accepted (`Closes: #12`), as GitHub does.
const KEYWORD = String.raw`\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?[ \t]+`;
const SLUG = String.raw`[A-Za-z0-9_.-]+`;
const REFERENCE = new RegExp(
  `${KEYWORD}(?:(?:(${SLUG})/(${SLUG}))?#(\\d+)|https://github\\.com/(${SLUG})/(${SLUG})/issues/(\\d+))\\b`,
  "gi",
);

/**
 * Text that is never a closing reference: fenced code, inline code and HTML
 * comments. A pull-request template's `<!-- Closes #123 -->` and a commit that
 * quotes `Fixes #9` in backticks as an example are not claims, and GitHub
 * itself does not act on either.
 */
export function stripNonReferenceText(text: string): string {
  const unfenced = stripFences(text.replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?-->/g, " "));
  return stripIndentedCode(unfenced).replace(CODE_SPAN, " ");
}

/**
 * Drop fenced code blocks, CommonMark's way: the opening line's delimiter is
 * a run of 3+ backticks or 3+ tildes (up to 3 spaces in), and the block closes
 * only on a line holding a run of the SAME character at least as long, and
 * nothing else. So a four-backtick fence can quote a triple-backtick line
 * without ending, and a fence never closed runs to the end of the text.
 */
function stripFences(text: string): string {
  let open: { readonly char: string; readonly length: number } | null = null;
  return text
    .split("\n")
    .map((line): string => {
      if (open === null) {
        const opener = /^ {0,3}(`{3,}|~{3,})/.exec(line);
        if (opener === null) return line;
        const run = opener[1] as string;
        // A backtick fence's info string may not contain a backtick; such a
        // line is inline code, which CODE_SPAN handles.
        if (run.startsWith("`") && line.slice(opener[0].length).includes("`")) return line;
        open = { char: run.charAt(0), length: run.length };
        return "";
      }
      const closer = /^ {0,3}(`{3,}|~{3,})[ \t]*$/.exec(line);
      const run = closer?.[1];
      if (run !== undefined && run.charAt(0) === open.char && run.length >= open.length) open = null;
      return "";
    })
    .join("\n");
}

// A code span is a run of N backticks closed by a run of EXACTLY N (CommonMark),
// so ``Closes `#1` `` is one span, and it never crosses a blank line.
const CODE_SPAN = /(?<!`)(`+)(?!`)(?:(?!\n[ \t]*\n)[\s\S])*?(?<!`)\1(?!`)/g;

/**
 * Drop indented code blocks: a line whose content starts at column 4 or more
 * (a tab advances to the next multiple of 4, so 1-3 spaces then a tab counts)
 * that follows a blank line, the start of the text, or another such line.
 * Blockquote markers (`>`) are removed before the column is measured, so code
 * indented inside a quote is code too. A line indented the same way straight
 * after a paragraph line is a continuation, not code, and is kept.
 *
 * CONSERVATIVE ON LIST CONTINUATIONS, DELIBERATELY. Inside a list item,
 * CommonMark measures indentation from the item's content column, so a
 * four-space line after a blank line in a list is a continued paragraph, not
 * code. This does not track list context and drops it. Dropping text can only
 * lose a proposal, never invent one, so the error falls on the side the verb's
 * evidence rule already prefers.
 */
function stripIndentedCode(text: string): string {
  let afterBlank = true;
  let inCode = false;
  return text
    .split("\n")
    .map((line): string => {
      const unquoted = line.replace(/^(?: {0,3}>[ ]?)+/, "");
      if (unquoted.trim() === "") {
        afterBlank = true;
        return line;
      }
      const indented = indentColumn(unquoted) >= 4;
      inCode = indented && (afterBlank || inCode);
      afterBlank = false;
      return inCode ? "" : line;
    })
    .join("\n");
}

/** The column a line's content starts at: a space advances one, a tab to the next multiple of 4. */
function indentColumn(line: string): number {
  let column = 0;
  for (const character of line) {
    if (character === " ") column += 1;
    else if (character === "\t") column += 4 - (column % 4);
    else break;
  }
  return column;
}

/**
 * Every closing reference in a text that names an issue in THIS repository, in
 * first-appearance order, as `[issue, the reference as written]`. A reference
 * to another repository is dropped: an issue there is not this verb's to
 * reconcile against this target.
 */
export function closingReferencesIn(text: string, target: Target): readonly (readonly [number, string])[] {
  const found: [number, string][] = [];
  for (const match of stripNonReferenceText(text).matchAll(REFERENCE)) {
    const owner = match[1] ?? match[4];
    const repo = match[2] ?? match[5];
    const number = Number(match[3] ?? match[6]);
    if (!Number.isInteger(number) || number <= 0) continue;
    if (owner !== undefined && repo !== undefined && !sameRepository(owner, repo, target)) continue;
    found.push([number, match[0].trim()]);
  }
  return found;
}

function sameRepository(owner: string, repo: string, target: Target): boolean {
  return owner.toLowerCase() === target.owner.toLowerCase() && repo.toLowerCase() === target.repo.toLowerCase();
}

// --- the reads -----------------------------------------------------------------

export interface OpenIssue {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  /** GitHub's `stateReason`: `REOPENED` on an issue a human reopened after a close. */
  readonly stateReason: string;
}

export interface MergedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly base: string;
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
  /** Every same-repository closing reference this PR carries, by issue. */
  readonly references: ReadonlyMap<number, readonly ClosingReference[]>;
}

const ISSUE_FIELDS = "number,title,url,labels,stateReason";

/** Commits read per pull request; a PR with more is a finding, never a silent cut. */
export const COMMITS_PER_PR = 100;
/** The most commits GitHub serves for one pull request, however it is paged. */
export const COMMITS_SERVED_PER_PR = 250;
/** Closing references read per pull request; the same rule. */
export const LINKS_PER_PR = 50;

// WHY A HAND-WRITTEN QUERY AND NOT `gh pr list --json commits`. gh's `commits`
// field selects every commit's AUTHORS connection as well, and at a page of 100
// pull requests GitHub refuses the whole query before running it ("requesting up
// to 1,000,000 possible nodes ... exceeds the maximum limit of 500,000") --
// observed live against zheref/nen while building this verb. This query selects
// exactly what a closing reference needs (oid and message) and nothing else, so
// a full page costs 100 x (100 + 50) nodes. It goes through `gh api graphql` on
// the same Runner seam as every other read here, and it is a QUERY: there is no
// mutation anywhere in this module.
//
// THE SEARCH INDEX, NOT `repository.pullRequests`, because --since is a
// `merged:>=` qualifier and only search takes one. Its 1000-result ceiling is
// why RECONCILE_MAX_LIMIT is 1000.
export const MERGED_PULLS_QUERY = [
  "query($q: String!, $first: Int!, $after: String) {",
  "  search(query: $q, type: ISSUE, first: $first, after: $after) {",
  "    issueCount",
  "    pageInfo { hasNextPage endCursor }",
  "    nodes { ... on PullRequest {",
  "      number title url baseRefName mergedAt body",
  "      mergeCommit { oid }",
  `      closingIssuesReferences(first: ${LINKS_PER_PR}) { totalCount nodes { number url repository { name owner { login } } } }`,
  `      commits(first: ${COMMITS_PER_PR}) { totalCount pageInfo { hasNextPage endCursor } nodes { commit { oid messageHeadline messageBody } } }`,
  "    } }",
  "  }",
  "}",
].join("\n");

/**
 * The follow-up for one pull request whose commits did not fit the search page:
 * the next page of its commits, after the cursor the previous page ended on.
 */
export const PR_COMMITS_QUERY = [
  "query($owner: String!, $name: String!, $number: Int!, $after: String) {",
  "  repository(owner: $owner, name: $name) {",
  "    pullRequest(number: $number) {",
  `      commits(first: ${COMMITS_PER_PR}, after: $after) { pageInfo { hasNextPage endCursor } nodes { commit { oid messageHeadline messageBody } } }`,
  "    }",
  "  }",
  "}",
].join("\n");

export function prCommitsArgv(target: Target, number: number, after: string): readonly string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${PR_COMMITS_QUERY}`,
    "-f",
    `owner=${target.owner}`,
    "-f",
    `name=${target.repo}`,
    "-F",
    `number=${number}`,
    "-f",
    `after=${after}`,
  ];
}

/**
 * Merged pull requests from BASE into HEAD -- the delivery a diverged compare
 * may be hiding (a squash or rebase landing of the base branch).
 */
export function deliveryArgv(target: Target, head: string, base: string): readonly string[] {
  return [
    "pr",
    "list",
    "--repo",
    target.slug,
    "--state",
    "merged",
    "--head",
    head,
    "--base",
    base,
    "--limit",
    String(DELIVERY_LIMIT),
    "--json",
    "number,url,mergedAt,headRepositoryOwner",
  ];
}

/** How many merged deliveries from one base are read: enough to see past a stale or forked one. */
export const DELIVERY_LIMIT = 10;

export function openIssuesArgv(target: Target, limit: number): readonly string[] {
  return ["issue", "list", "--repo", target.slug, "--state", "open", "--limit", String(limit), "--json", ISSUE_FIELDS];
}

/**
 * The search expression: this repository's merged pull requests, most recently
 * UPDATED first -- search has no merge-date sort, so this is not merge order.
 */
export function mergedPullsSearch(target: Target, since: string | null): string {
  return `repo:${target.slug} is:pr is:merged${since === null ? "" : ` merged:>=${since}`} sort:updated-desc`;
}

/** One page of the merged-PR search. `first` is at most 100, GitHub's page ceiling. */
export function mergedPullsArgv(target: Target, first: number, since: string | null, after: string | null): readonly string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${MERGED_PULLS_QUERY}`,
    "-f",
    `q=${mergedPullsSearch(target, since)}`,
    "-F",
    `first=${first}`,
    ...(after === null ? [] : ["-f", `after=${after}`]),
  ];
}

/**
 * The repository's whole label list, every page (`--paginate` follows the Link
 * header, so the list cannot come back cut at a page boundary), one name per
 * line AS A JSON STRING (`@json`), so a name carrying a newline, a quote or
 * surrounding spaces is read back exactly. Read only when --hold-labels names
 * something to check.
 */
export function repositoryLabelsArgv(target: Target): readonly string[] {
  return ["api", `repos/${target.slug}/labels?per_page=100`, "--paginate", "--jq", ".[].name | @json"];
}

export function defaultBranchArgv(target: Target): readonly string[] {
  return ["repo", "view", target.slug, "--json", "defaultBranchRef"];
}

export function compareArgv(target: Target, defaultBranch: string, commit: string): readonly string[] {
  return ["api", `repos/${target.slug}/compare/${defaultBranch}...${commit}`, "--jq", ".status"];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function jsonArray(text: string, what: string): unknown[] {
  const parsed: unknown = JSON.parse(text.trim() === "" ? "[]" : text);
  if (!Array.isArray(parsed)) throw new Error(`expected a JSON array of ${what}`);
  return parsed;
}

export function parseOpenIssues(text: string): OpenIssue[] {
  return jsonArray(text, "issues").map((entry): OpenIssue => {
    const row = record(entry);
    const labels = Array.isArray(row["labels"])
      ? row["labels"].map((label): string => String(record(label)["name"] ?? "")).filter((name): boolean => name !== "")
      : [];
    return {
      number: Number(row["number"] ?? 0),
      title: String(row["title"] ?? ""),
      url: String(row["url"] ?? ""),
      labels,
      stateReason: typeof row["stateReason"] === "string" ? row["stateReason"] : "",
    };
  });
}

export function parseMergedPulls(text: string, target: Target): MergedPullRequest[] {
  return jsonArray(text, "pull requests").map((entry): MergedPullRequest => {
    const row = record(entry);
    const references = new Map<number, ClosingReference[]>();
    const add = (issue: number, reference: ClosingReference): void => {
      const list = references.get(issue) ?? [];
      if (!list.some((seen): boolean => seen.source === reference.source && seen.text === reference.text && seen.commit === reference.commit)) {
        list.push(reference);
      }
      references.set(issue, list);
    };
    // GitHub's own field first: it is the reference GitHub itself recorded,
    // including one made through the sidebar with no text anywhere.
    if (Array.isArray(row["closingIssuesReferences"])) {
      for (const item of row["closingIssuesReferences"]) {
        const ref = record(item);
        const repository = record(ref["repository"]);
        const owner = String(record(repository["owner"])["login"] ?? "");
        const name = String(repository["name"] ?? "");
        const number = Number(ref["number"] ?? 0);
        if (!Number.isInteger(number) || number <= 0) continue;
        // A reference with no repository at all is read as this one's: that is
        // the only repository `gh pr list --repo` was asked about.
        if (owner !== "" && name !== "" && !sameRepository(owner, name, target)) continue;
        add(number, { source: "linked", text: String(ref["url"] ?? `#${number}`), commit: null });
      }
    }
    for (const [issue, text] of closingReferencesIn(String(row["body"] ?? ""), target)) {
      add(issue, { source: "body", text, commit: null });
    }
    if (Array.isArray(row["commits"])) {
      for (const item of row["commits"]) {
        const commit = record(item);
        const oid = String(commit["oid"] ?? "");
        const message = `${String(commit["messageHeadline"] ?? "")}\n${String(commit["messageBody"] ?? "")}`;
        for (const [issue, text] of closingReferencesIn(message, target)) {
          add(issue, { source: "commit", text, commit: oid === "" ? null : oid });
        }
      }
    }
    const merge = record(row["mergeCommit"])["oid"];
    return {
      number: Number(row["number"] ?? 0),
      title: String(row["title"] ?? ""),
      url: String(row["url"] ?? ""),
      base: String(row["baseRefName"] ?? ""),
      mergedAt: typeof row["mergedAt"] === "string" && row["mergedAt"] !== "" ? row["mergedAt"] : null,
      mergeCommit: typeof merge === "string" && merge !== "" ? merge : null,
      references,
    };
  });
}

/**
 * One page of the GraphQL search, normalised to the `gh pr list --json` shape
 * parseMergedPulls reads -- `closingIssuesReferences` and `commits` as arrays --
 * plus what pagination and the per-PR caps need. A shape it does not recognise
 * THROWS: an unreadable page must be a finding, never an empty one.
 */
export interface CommitsContinuation {
  readonly number: number;
  readonly totalCount: number;
  /** Where the next page of commits starts; `null` when GitHub gave no cursor. */
  readonly after: string | null;
}

export function parseMergedPullsPage(text: string): {
  readonly rows: readonly Record<string, unknown>[];
  readonly issueCount: number | null;
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly overflow: readonly string[];
  readonly continuations: readonly CommitsContinuation[];
} {
  const response = record(JSON.parse(text));
  if (Array.isArray(response["errors"]) && response["errors"].length > 0) {
    throw new Error(response["errors"].map((error): string => String(record(error)["message"] ?? "error")).join("; "));
  }
  const search = record(record(response["data"])["search"]);
  const nodes = search["nodes"];
  if (!Array.isArray(nodes)) throw new Error("the search answered with no 'nodes' list");
  const pageInfo = record(search["pageInfo"]);
  const overflow: string[] = [];
  const continuations: CommitsContinuation[] = [];
  const rows = nodes.map((node): Record<string, unknown> => {
    const row = record(node);
    const links = record(row["closingIssuesReferences"]);
    const commits = record(row["commits"]);
    const linkNodes = Array.isArray(links["nodes"]) ? links["nodes"] : [];
    const commitNodes = Array.isArray(commits["nodes"]) ? commits["nodes"] : [];
    if (Number(links["totalCount"] ?? 0) > linkNodes.length) {
      overflow.push(`PR #${String(row["number"])} has ${String(links["totalCount"])} closing references; only ${linkNodes.length} were read`);
    }
    const commitsPage = record(commits["pageInfo"]);
    if (commitsPage["hasNextPage"] === true || Number(commits["totalCount"] ?? 0) > commitNodes.length) {
      const cursor = commitsPage["endCursor"];
      continuations.push({
        number: Number(row["number"] ?? 0),
        totalCount: Number(commits["totalCount"] ?? 0),
        after: typeof cursor === "string" && cursor !== "" ? cursor : null,
      });
    }
    return {
      ...row,
      closingIssuesReferences: linkNodes,
      commits: commitNodes.map((item): Record<string, unknown> => record(record(item)["commit"])),
    };
  });
  const cursor = pageInfo["endCursor"];
  const count = search["issueCount"];
  return {
    rows,
    issueCount: typeof count === "number" && Number.isFinite(count) ? count : null,
    hasNextPage: pageInfo["hasNextPage"] === true,
    endCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
    overflow,
    continuations,
  };
}

/**
 * The commits of one pull request beyond the search page's first 100, page by
 * page. A failed read returns its reason; the commits read so far are kept.
 */
function readRemainingCommits(
  seams: Seams,
  target: Target,
  continuation: CommitsContinuation,
): { readonly commits: Record<string, unknown>[]; readonly error: string | null } {
  const commits: Record<string, unknown>[] = [];
  let after = continuation.after;
  if (after === null) return { commits, error: "GitHub gave no cursor for the rest of them" };
  // A cursor GitHub has already handed out means the next read would be one
  // already made: the loop would spin, or silently re-read the same page.
  const cursors = new Set<string>([after]);
  for (;;) {
    const result = seams.run(GH, prCommitsArgv(target, continuation.number, after));
    if (result.spawnFailed || result.code !== 0) return { commits, error: failure(result.stderr, result.code) };
    let connection: Record<string, unknown>;
    try {
      const response = record(JSON.parse(result.stdout));
      if (Array.isArray(response["errors"]) && response["errors"].length > 0) {
        throw new Error(response["errors"].map((error): string => String(record(error)["message"] ?? "error")).join("; "));
      }
      connection = record(record(record(record(response["data"])["repository"])["pullRequest"])["commits"]);
      if (!Array.isArray(connection["nodes"])) throw new Error("the answer carried no commits list");
    } catch (error) {
      return { commits, error: message(error) };
    }
    for (const item of connection["nodes"] as unknown[]) commits.push(record(record(item)["commit"]));
    const page = record(connection["pageInfo"]);
    if (page["hasNextPage"] !== true) return { commits, error: null };
    const next = page["endCursor"];
    if (typeof next !== "string" || next === "") return { commits, error: "GitHub said another page of commits exists and gave no cursor" };
    if (cursors.has(next)) return { commits, error: `GitHub repeated the cursor '${next}', so the commit pages made no progress` };
    cursors.add(next);
    after = next;
  }
}

/**
 * Every merged pull request the search yields, up to `limit`, page by page,
 * each PR once (a row whose number was already read on an earlier page is
 * dropped -- an update between two page reads can move a PR across the
 * boundary). `null` when a page could not be read (the finding is recorded).
 *
 * TRUNCATED IS DECIDED BY `issueCount`, NOT BY `hasNextPage` ALONE. GitHub
 * search returns nothing past its 1000th result and answers that last page
 * with `hasNextPage: false`, so a search that matched 4000 PRs would otherwise
 * read as complete. `issueCount` is the total the search matched; more matched
 * than read is a truncation whatever the cursor says.
 */
function readMergedPulls(
  seams: Seams,
  target: Target,
  limit: number,
  since: string | null,
  findings: Finding[],
): { readonly pulls: MergedPullRequest[]; readonly truncated: boolean } | null {
  const rows: Record<string, unknown>[] = [];
  const seen = new Set<number>();
  let after: string | null = null;
  let truncated = false;
  // A cursor the search already handed out means the next read would repeat
  // one already made -- the loop would spin or re-read the same page.
  const cursors = new Set<string>();
  for (;;) {
    const first = Math.min(100, limit - rows.length);
    const result = seams.run(GH, mergedPullsArgv(target, first, since, after));
    if (result.spawnFailed || result.code !== 0) {
      findings.push({ source: "merged-pull-requests", detail: `could not search ${target.slug}'s merged pull requests: ${failure(result.stderr, result.code)}` });
      return null;
    }
    let page: ReturnType<typeof parseMergedPullsPage>;
    try {
      page = parseMergedPullsPage(result.stdout);
    } catch (error) {
      findings.push({ source: "merged-pull-requests", detail: `could not parse ${target.slug}'s merged pull requests: ${message(error)}` });
      return null;
    }
    const fresh = new Set<number>();
    for (const row of page.rows) {
      const number = Number(row["number"] ?? 0);
      if (seen.has(number)) continue;
      seen.add(number);
      fresh.add(number);
      rows.push(row);
    }
    for (const detail of page.overflow) findings.push({ source: "merged-pull-requests", detail });
    for (const continuation of page.continuations) {
      if (!fresh.has(continuation.number)) continue;
      const row = rows.find((candidate): boolean => Number(candidate["number"] ?? 0) === continuation.number);
      const more = readRemainingCommits(seams, target, continuation);
      if (row !== undefined) row["commits"] = [...(row["commits"] as Record<string, unknown>[]), ...more.commits];
      const read = row === undefined ? 0 : (row["commits"] as unknown[]).length;
      if (more.error !== null) {
        findings.push({
          source: "merged-pull-requests",
          detail: `PR #${continuation.number} has ${continuation.totalCount} commits; only ${read} were read: ${more.error}`,
        });
      } else if (read < continuation.totalCount) {
        // GitHub serves at most 250 of a pull request's commits, and answers
        // the last of them with hasNextPage: false -- so a cursor loop that
        // ended cleanly can still have read less than the PR holds.
        findings.push({
          source: "merged-pull-requests",
          detail: `PR #${continuation.number} has ${continuation.totalCount} commits; GitHub serves at most ${COMMITS_SERVED_PER_PR} of a pull request's, and ${read} were read, so ${continuation.totalCount - read} were not`,
        });
      }
    }
    const beyond = page.issueCount !== null && page.issueCount > rows.length;
    // The limit is checked FIRST: once it is reached nothing more is asked for,
    // and whether that was the end is the search's count to say.
    if (rows.length >= limit || !page.hasNextPage) {
      truncated = (rows.length >= limit && page.hasNextPage) || beyond;
      // Without the total, "no next page" is the cursor's word alone -- and the
      // cursor is exactly what lies at search's 1000-result ceiling.
      if (page.issueCount === null && !truncated) {
        findings.push({ source: "merged-pull-requests", detail: "the search answered without its total (issueCount), so whether it returned every match could not be read" });
      }
      break;
    }
    if (page.endCursor === null) {
      findings.push({ source: "merged-pull-requests", detail: "the search said another page exists and gave no cursor to read it" });
      truncated = true;
      break;
    }
    if (cursors.has(page.endCursor)) {
      findings.push({ source: "merged-pull-requests", detail: `the search repeated the cursor '${page.endCursor}', so its pages made no progress` });
      truncated = true;
      break;
    }
    cursors.add(page.endCursor);
    after = page.endCursor;
  }
  return { pulls: parseMergedPulls(JSON.stringify(rows), target), truncated };
}

// --- the report ----------------------------------------------------------------

/**
 * Where a merged pull request's merge commit stands against the default branch.
 *   default-branch         -- the PR merged straight into it;
 *   reached-default-branch -- it merged elsewhere, and the merge commit is now
 *                             reachable from the default branch;
 *   not-on-default-branch  -- it merged elsewhere and the default branch is an
 *                             ancestor of it (compare `ahead`): not landed;
 *   diverged               -- it merged elsewhere and is not reachable from the
 *                             default branch, which has moved on too (compare
 *                             `diverged`). A squash or rebase landing of the base
 *                             reads exactly this way, so it asserts nothing --
 *                             see `delivery`;
 *   unknown                -- that could not be read (a finding names why).
 */
export type Landing = "default-branch" | "reached-default-branch" | "not-on-default-branch" | "diverged" | "unknown";

/** A merged PR from a closing PR's base into the default branch: how a squash/rebase landing is seen. */
export interface Delivery {
  readonly pr: number;
  readonly url: string;
  readonly mergedAt: string | null;
}

export interface Evidence {
  readonly pr: number;
  readonly url: string;
  readonly title: string;
  readonly base: string;
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
  readonly landing: Landing;
  /** For a `diverged` landing only: the merged delivery PR from `base` into the default branch, or `null` when none. */
  readonly delivery: Delivery | null;
  readonly references: readonly ClosingReference[];
}

/**
 * What the verb SUGGESTS -- a proposal, never an act.
 *   close  -- a landed PR closes it, nothing in flight, not held or reopened;
 *   hold   -- it carries a caller-named hold label (--hold-labels);
 *   review -- landed evidence, but a human reopened it, or an open PR still
 *             closes or mentions it (closing it would orphan that work);
 *   wait   -- the closing PR merged into a branch that has not reached the
 *             default branch yet;
 *   verify -- the landing, or the open-PR guard, could not be read.
 */
export type ProposedAction = "close" | "hold" | "review" | "wait" | "verify";

export interface Proposal {
  readonly issue: number;
  readonly title: string;
  readonly url: string;
  readonly labels: readonly string[];
  readonly action: ProposedAction;
  readonly reason: string;
  readonly evidence: readonly Evidence[];
  /** Open PRs that close or mention the issue; empty when none, or when the guard did not run for it. */
  readonly openPullRequests: readonly number[];
}

export interface Finding {
  /** Which source: `default-branch`, `open-issues`, `merged-pull-requests`, `compare #<pr>`, `delivery <branch>`, `merge-commit #<pr>`, `open-pr-guard`, `hold-labels`. */
  readonly source: string;
  readonly detail: string;
}

export interface ReconcileOptions {
  /** `YYYY-MM-DD`: only PRs merged on or after it are scanned. */
  readonly since: string | null;
  readonly limit: number;
  /** Restrict the proposals to these issues; `null` for every open issue. */
  readonly issues: readonly number[] | null;
  /** The target repository's own "do not close" label names. */
  readonly holdLabels: readonly string[];
}

export interface ReconcileReport {
  readonly contract: string;
  readonly target: string;
  /** Always true: the verb proposes and never writes. Carried so a consumer never has to infer it. */
  readonly proposesOnly: true;
  readonly defaultBranch: string | null;
  readonly since: string | null;
  readonly limit: number;
  readonly holdLabels: readonly string[];
  readonly scanned: { readonly openIssues: number; readonly mergedPullRequests: number };
  readonly truncated: { readonly openIssues: boolean; readonly mergedPullRequests: boolean };
  readonly proposals: readonly Proposal[];
  /** --issues entries absent from a complete open-issue list: closed, a pull request, or no such number. */
  readonly notOpen: readonly number[];
  readonly findings: readonly Finding[];
  /** True only when every source was read in full. False means an empty proposal list is NOT "nothing to reconcile". */
  readonly complete: boolean;
}

function failure(stderr: string, code: number): string {
  return outputLines(stderr).join(" ") || `exit ${code}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function readDefaultBranch(seams: Seams, target: Target, findings: Finding[]): string | null {
  const result = seams.run(GH, defaultBranchArgv(target));
  if (result.spawnFailed || result.code !== 0) {
    findings.push({ source: "default-branch", detail: `could not read ${target.slug}'s default branch: ${failure(result.stderr, result.code)}` });
    return null;
  }
  try {
    const name = record(record(JSON.parse(result.stdout))["defaultBranchRef"])["name"];
    if (typeof name === "string" && name !== "") return name;
    findings.push({ source: "default-branch", detail: `${target.slug} answered with no default branch name` });
  } catch (error) {
    findings.push({ source: "default-branch", detail: `could not parse ${target.slug}'s default branch: ${message(error)}` });
  }
  return null;
}

function readList<T>(
  seams: Seams,
  argv: readonly string[],
  source: string,
  what: string,
  parse: (text: string) => T[],
  findings: Finding[],
): T[] | null {
  const result = seams.run(GH, argv);
  if (result.spawnFailed || result.code !== 0) {
    findings.push({ source, detail: `could not list ${what}: ${failure(result.stderr, result.code)}` });
    return null;
  }
  try {
    return parse(result.stdout);
  } catch (error) {
    findings.push({ source, detail: `could not parse ${what}: ${message(error)}` });
    return null;
  }
}

const REACHED = new Set(["behind", "identical"]);


function landingOf(
  seams: Seams,
  target: Target,
  defaultBranch: string | null,
  pull: MergedPullRequest,
  cache: Map<string, Landing>,
  findings: Finding[],
): Landing {
  if (defaultBranch === null) return "unknown";
  if (pull.base === defaultBranch) {
    // Every proposal cites a merge commit; a merged PR with none recorded is
    // evidence the verb cannot cite, so it is verify, never close.
    if (pull.mergeCommit === null) {
      findings.push({ source: `merge-commit #${pull.number}`, detail: `PR #${pull.number} merged into '${pull.base}' with no merge commit recorded, so there is no commit to cite` });
      return "unknown";
    }
    return "default-branch";
  }
  if (pull.mergeCommit === null) {
    findings.push({ source: `compare #${pull.number}`, detail: `PR #${pull.number} merged into '${pull.base}' with no merge commit recorded, so whether it reached '${defaultBranch}' cannot be checked` });
    return "unknown";
  }
  const cached = cache.get(pull.mergeCommit);
  if (cached !== undefined) return cached;
  const result = seams.run(GH, compareArgv(target, defaultBranch, pull.mergeCommit));
  let landing: Landing = "unknown";
  if (result.spawnFailed || result.code !== 0) {
    findings.push({ source: `compare #${pull.number}`, detail: `could not compare ${pull.mergeCommit} with '${defaultBranch}': ${failure(result.stderr, result.code)}` });
  } else {
    const status = result.stdout.trim();
    if (REACHED.has(status)) landing = "reached-default-branch";
    else if (status === "ahead") landing = "not-on-default-branch";
    else if (status === "diverged") landing = "diverged";
    else findings.push({ source: `compare #${pull.number}`, detail: `comparing ${pull.mergeCommit} with '${defaultBranch}' answered an unrecognised status '${status}'` });
  }
  cache.set(pull.mergeCommit, landing);
  return landing;
}

interface DeliveryCandidate extends Delivery {
  /** The head repository's owner login, or `null` when GitHub gave none. */
  readonly headOwner: string | null;
}

/**
 * The merged delivery PR from `head` into `base` that could have carried a
 * child PR merged at `childMergedAt`: from a head in THIS repository (a fork's
 * branch of the same name is a different branch), and merged at or after the
 * child (a delivery merged before the child cannot have carried it). The newest
 * that qualifies; `null` for none; `undefined` when the read failed (the
 * finding is recorded). The list is read once per base and filtered per child.
 */
function deliveryOf(
  seams: Seams,
  target: Target,
  head: string,
  base: string,
  childMergedAt: string | null,
  cache: Map<string, readonly DeliveryCandidate[] | undefined>,
  findings: Finding[],
): Delivery | null | undefined {
  if (!cache.has(head)) cache.set(head, readDeliveries(seams, target, head, base, findings));
  const candidates = cache.get(head);
  if (candidates === undefined) return undefined;
  const qualifying = candidates
    .filter((candidate): boolean => candidate.headOwner !== null && candidate.headOwner.toLowerCase() === target.owner.toLowerCase())
    .filter((candidate): boolean => candidate.mergedAt !== null && childMergedAt !== null && candidate.mergedAt >= childMergedAt)
    .sort((a, b): number => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "") || b.pr - a.pr);
  const chosen = qualifying[0];
  return chosen === undefined ? null : { pr: chosen.pr, url: chosen.url, mergedAt: chosen.mergedAt };
}

function readDeliveries(
  seams: Seams,
  target: Target,
  head: string,
  base: string,
  findings: Finding[],
): readonly DeliveryCandidate[] | undefined {
  const result = seams.run(GH, deliveryArgv(target, head, base));
  if (result.spawnFailed || result.code !== 0) {
    findings.push({ source: `delivery ${head}`, detail: `could not look for a merged PR from '${head}' into '${base}': ${failure(result.stderr, result.code)}` });
    return undefined;
  }
  try {
    return jsonArray(result.stdout, "pull requests").map((entry): DeliveryCandidate => {
      const row = record(entry);
      const owner = record(row["headRepositoryOwner"])["login"];
      return {
        pr: Number(row["number"] ?? 0),
        url: String(row["url"] ?? ""),
        mergedAt: typeof row["mergedAt"] === "string" && row["mergedAt"] !== "" ? row["mergedAt"] : null,
        headOwner: typeof owner === "string" && owner !== "" ? owner : null,
      };
    });
  } catch (error) {
    findings.push({ source: `delivery ${head}`, detail: `could not parse the merged PRs from '${head}' into '${base}': ${message(error)}` });
    return undefined;
  }
}

/** Every --hold-labels name must exist in the repository; an unreadable list is a finding too. */
function checkHoldLabels(seams: Seams, target: Target, holdLabels: readonly string[], findings: Finding[]): void {
  const result = seams.run(GH, repositoryLabelsArgv(target));
  if (result.spawnFailed || result.code !== 0) {
    findings.push({
      source: "hold-labels",
      detail: `could not read ${target.slug}'s labels to check --hold-labels against: ${failure(result.stderr, result.code)}`,
    });
    return;
  }
  const names: string[] = [];
  for (const line of outputLines(result.stdout)) {
    if (line.trim() === "") continue;
    try {
      const name: unknown = JSON.parse(line);
      if (typeof name !== "string") throw new Error("not a JSON string");
      names.push(name);
    } catch (error) {
      findings.push({ source: "hold-labels", detail: `${target.slug}'s label list carried a line that is not a JSON-encoded name (${message(error)}), so --hold-labels could not be checked` });
      return;
    }
  }
  if (names.length === 0) {
    findings.push({ source: "hold-labels", detail: `${target.slug} answered an empty label list, so --hold-labels could not be checked` });
    return;
  }
  const known = new Set(names.map((name): string => name.toLowerCase()));
  for (const label of holdLabels) {
    if (known.has(label.toLowerCase())) continue;
    findings.push({
      source: "hold-labels",
      detail: `--hold-labels '${label}' matches no label in ${target.slug} (${names.length} read); a misspelt hold label would read as "nothing held", so this is not a clean answer`,
    });
  }
}

function landed(landing: Landing): boolean {
  return landing === "default-branch" || landing === "reached-default-branch";
}

function cite(evidence: Evidence, defaultBranch: string | null): string {
  const where =
    evidence.landing === "default-branch"
      ? `merged into '${evidence.base}', the default branch`
      : evidence.landing === "reached-default-branch"
        ? `merged into '${evidence.base}', and its merge commit has reached '${defaultBranch ?? "?"}'`
        : evidence.landing === "not-on-default-branch"
          ? `merged into '${evidence.base}', and its merge commit has NOT reached '${defaultBranch ?? "?"}' ('${defaultBranch ?? "?"}' is still an ancestor of it)`
          : evidence.landing === "diverged"
            ? evidence.delivery === null
              ? `merged into '${evidence.base}', and its merge commit is not reachable from '${defaultBranch ?? "?"}' (a squash or rebase landing reads the same way)`
              : `merged into '${evidence.base}', whose merge commit is not reachable from '${defaultBranch ?? "?"}' by ancestry, but PR #${evidence.delivery.pr} merged '${evidence.base}' into '${defaultBranch ?? "?"}' (a squash or rebase landing reads this way)`
            : `merged into '${evidence.base}', landing unknown`;
  return `PR #${evidence.pr} ${where}`;
}

/**
 * Run the reconciliation. Never throws for a failed read: every one is a
 * finding in the report, and the caller turns a non-empty findings list into
 * exit 1.
 */
export function reconcile(seams: Seams, target: Target, options: ReconcileOptions): ReconcileReport {
  const findings: Finding[] = [];
  const defaultBranch = readDefaultBranch(seams, target, findings);

  const openIssues = readList(seams, openIssuesArgv(target, options.limit), "open-issues", `${target.slug}'s open issues`, parseOpenIssues, findings);
  const merged = readMergedPulls(seams, target, options.limit, options.since, findings);
  const pulls = merged?.pulls ?? null;

  const issuesTruncated = openIssues !== null && openIssues.length >= options.limit;
  const pullsTruncated = merged?.truncated ?? false;
  if (issuesTruncated) {
    findings.push({ source: "open-issues", detail: `the open-issue list came back full (${options.limit}); an issue beyond it was not considered -- raise --limit` });
  }
  if (pullsTruncated) {
    findings.push({
      source: "merged-pull-requests",
      detail: `the merged pull-request search matched more than the ${merged?.pulls.length ?? 0} read (--limit ${options.limit}, and GitHub search stops at 1000); a PR further down its most-recently-updated order was not scanned -- narrow --since or raise --limit`,
    });
  }

  const wanted = options.issues === null ? null : new Set(options.issues);
  const open = new Map<number, OpenIssue>();
  for (const issue of openIssues ?? []) {
    if (wanted === null || wanted.has(issue.number)) open.set(issue.number, issue);
  }
  // Only a COMPLETE open list can say a number is not open; a failed or full
  // one is already a finding, and naming a number "not open" off it would be a
  // claim the read cannot support.
  const notOpen =
    openIssues === null || issuesTruncated || options.issues === null
      ? []
      : options.issues.filter((number): boolean => !open.has(number));

  // Issue -> its evidence; sorted below by merge date, newest first, because
  // the search's own order is most-recently-UPDATED, not merge order.
  const evidenceByIssue = new Map<number, Evidence[]>();
  const landingCache = new Map<string, Landing>();
  const deliveryCache = new Map<string, readonly DeliveryCandidate[] | undefined>();
  for (const pull of pulls ?? []) {
    for (const [issue, references] of pull.references) {
      if (!open.has(issue)) continue;
      let landing = landingOf(seams, target, defaultBranch, pull, landingCache, findings);
      let delivery: Delivery | null = null;
      if (landing === "diverged" && defaultBranch !== null) {
        const found = deliveryOf(seams, target, pull.base, defaultBranch, pull.mergedAt, deliveryCache, findings);
        if (found === undefined) landing = "unknown";
        else delivery = found;
      }
      const evidence: Evidence = {
        pr: pull.number,
        url: pull.url,
        title: pull.title,
        base: pull.base,
        mergedAt: pull.mergedAt,
        mergeCommit: pull.mergeCommit,
        landing,
        delivery,
        references,
      };
      evidenceByIssue.set(issue, [...(evidenceByIssue.get(issue) ?? []), evidence]);
    }
  }

  for (const list of evidenceByIssue.values()) {
    list.sort((a, b): number => (b.mergedAt ?? "").localeCompare(a.mergedAt ?? "") || b.pr - a.pr);
  }

  // Hold labels match case-insensitively, as GitHub's label names do. One that
  // matches no label IN THE REPOSITORY is a finding: a typo would otherwise read
  // as "nothing held". One that exists but is on no open issue is silent -- an
  // unused hold label is not a mistake.
  const holds = new Set(options.holdLabels.map((label): string => label.toLowerCase()));
  const isHeld = (label: string): boolean => holds.has(label.toLowerCase());
  if (options.holdLabels.length > 0) checkHoldLabels(seams, target, options.holdLabels, findings);

  // The open-PR guard, over every issue some landed PR would close -- the same
  // guard `issue open-pr-check` and `consolidate-close` run, reused.
  const guardCandidates = [...evidenceByIssue.entries()]
    .filter(([issue, evidence]): boolean => evidence.some((item): boolean => landed(item.landing)) && !(open.get(issue)?.labels ?? []).some(isHeld))
    .map(([issue]): number => issue)
    .sort((a, b): number => a - b);
  let guard: Map<number, number[]> | null = new Map();
  if (guardCandidates.length > 0) {
    try {
      const report = openPrCheck(seams, target, guardCandidates);
      for (const finding of report.findings) {
        guard.set(finding.issue, finding.pullRequests.map((pull): number => pull.number));
      }
      if (report.truncated) {
        findings.push({ source: "open-pr-guard", detail: `the open pull-request scan came back full (${report.scanned}); an open PR beyond it was not seen, so no 'close' is proposed` });
        guard = null;
      }
    } catch (error) {
      findings.push({ source: "open-pr-guard", detail: message(error) });
      guard = null;
    }
  }

  const proposals = [...evidenceByIssue.entries()]
    .sort(([a], [b]): number => a - b)
    .map(([number, evidence]): Proposal => {
      const issue = open.get(number) as OpenIssue;
      const inFlight = guard?.get(number) ?? [];
      const base = { issue: number, title: issue.title, url: issue.url, labels: issue.labels, evidence, openPullRequests: inFlight };
      const held = issue.labels.filter(isHeld);
      if (held.length > 0) {
        return { ...base, action: "hold", reason: `carries the hold label${held.length === 1 ? "" : "s"} ${held.map((label): string => `'${label}'`).join(", ")}` };
      }
      const landedEvidence = evidence.find((item): boolean => landed(item.landing));
      if (landedEvidence !== undefined) {
        const cited = cite(landedEvidence, defaultBranch);
        if (issue.stateReason.toUpperCase() === "REOPENED") {
          return { ...base, action: "review", reason: `${cited}, but the issue was reopened -- someone judged it unfinished after a close` };
        }
        if (guard === null) {
          return { ...base, action: "verify", reason: `${cited}, but the open-PR guard could not complete, so work in flight cannot be ruled out` };
        }
        if (inFlight.length > 0) {
          return { ...base, action: "review", reason: `${cited}, but open PR ${inFlight.map((pr): string => `#${pr}`).join(", ")} still closes or mentions it -- closing it would orphan work in flight` };
        }
        return { ...base, action: "close", reason: cited };
      }
      const unknown = evidence.find((item): boolean => item.landing === "unknown");
      if (unknown !== undefined) {
        return { ...base, action: "verify", reason: `${cite(unknown, defaultBranch)}; check whether it reached the default branch` };
      }
      const delivered = evidence.find((item): boolean => item.landing === "diverged" && item.delivery !== null);
      if (delivered !== undefined) {
        return { ...base, action: "verify", reason: `${cite(delivered, defaultBranch)}; verify the work arrived through that delivery` };
      }
      return { ...base, action: "wait", reason: `${cite(evidence[0] as Evidence, defaultBranch)}; propose again once that branch lands` };
    });

  return {
    contract: RECONCILE_CONTRACT,
    target: target.slug,
    proposesOnly: true,
    defaultBranch,
    since: options.since,
    limit: options.limit,
    holdLabels: options.holdLabels,
    scanned: { openIssues: openIssues?.length ?? 0, mergedPullRequests: pulls?.length ?? 0 },
    truncated: { openIssues: issuesTruncated, mergedPullRequests: pullsTruncated },
    proposals,
    notOpen,
    findings,
    complete: findings.length === 0,
  };
}

// --- the rendering ---------------------------------------------------------------

function describeReference(reference: ClosingReference): string {
  if (reference.source === "linked") return `GitHub closing reference ${reference.text}`;
  if (reference.source === "body") return `'${reference.text}' in the PR body`;
  return `'${reference.text}' in commit ${(reference.commit ?? "?").slice(0, 12)}`;
}

/**
 * The human rendering: the same report the --json document carries, in lines.
 * EVERY line goes through plainLine: titles, labels, base names, reference text
 * and finding details (gh's stderr, a compare status) are strings GitHub or
 * somebody else wrote, and a terminal executes a control sequence in one. The
 * --json document keeps the original bytes.
 */
export function renderReconcile(report: ReconcileReport): readonly string[] {
  const lines: string[] = [];
  lines.push(`repository: ${report.target} (default branch: ${report.defaultBranch ?? "UNREAD"})`);
  lines.push(
    `scanned: ${report.scanned.openIssues} open issue(s), ${report.scanned.mergedPullRequests} merged pull request(s)${report.since === null ? "" : ` merged on or after ${report.since}`}`,
  );
  lines.push("proposes only -- nothing was closed, commented on or labelled.");
  if (report.holdLabels.length > 0) lines.push(`hold labels: ${report.holdLabels.join(", ")}`);
  lines.push("");
  if (report.proposals.length === 0) {
    lines.push(
      report.complete
        ? "no proposals: no open issue is closed by a merged pull request in the scanned window."
        : "no proposals -- but the scan is INCOMPLETE (see findings), so this is NOT 'nothing to reconcile'.",
    );
  }
  for (const proposal of report.proposals) {
    lines.push(`#${proposal.issue} ${proposal.title}`);
    lines.push(`  propose: ${proposal.action} -- ${proposal.reason}`);
    for (const evidence of proposal.evidence) {
      const commit = evidence.mergeCommit === null ? "no merge commit" : `merge commit ${evidence.mergeCommit.slice(0, 12)}`;
      lines.push(`  evidence: PR #${evidence.pr} (${evidence.landing}, base ${evidence.base}, ${commit}${evidence.mergedAt === null ? "" : `, merged ${evidence.mergedAt}`})`);
      if (evidence.delivery !== null) {
        lines.push(`    delivery: PR #${evidence.delivery.pr} merged '${evidence.base}' into ${report.defaultBranch ?? "the default branch"}${evidence.delivery.mergedAt === null ? "" : ` on ${evidence.delivery.mergedAt}`}`);
      }
      for (const reference of evidence.references) lines.push(`    ${describeReference(reference)}`);
    }
  }
  if (report.notOpen.length > 0) {
    lines.push("");
    lines.push(`not open (closed, a pull request, or no such issue): ${report.notOpen.map((number): string => `#${number}`).join(", ")}`);
  }
  if (report.findings.length > 0) {
    lines.push("");
    lines.push(`findings (${report.findings.length}) -- a source that could not be read in full:`);
    for (const finding of report.findings) lines.push(`  ${finding.source}: ${finding.detail}`);
  }
  return lines.map(plainLine);
}
