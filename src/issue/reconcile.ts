// src/issue/reconcile.ts -- `nen issue reconcile`: which OPEN issues a LANDED
// pull request already claims to close, proposed and never acted on
// (zheref/nen#332).
//
// READ-ONLY AND PROPOSE-ONLY, BY RULING. The maintainer ruled #332 down from
// "closes or proposes closure" to PROPOSES ONLY: this module finds open issues a
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
// answer means the merge commit is reachable from the default branch. A merge
// that has not reached it is proposed as `wait`, never `close`.
//
// AN UNREADABLE SOURCE IS A FINDING, NEVER "NOTHING TO RECONCILE". Every read
// that fails is carried as a finding, and so is a list that came back full (it
// may have stopped before the PR that matters). Any finding makes the run exit
// 1, and the human rendering says in words that an empty proposal list under a
// finding is not a clean answer -- the same "found nothing" vs "could not look"
// rule ./search.ts follows.
//
// NAMES ARE DATA (the Akatsuki migration's § 3). No label is known here. A
// repository's "do not close this" override is whatever it calls it, and the
// caller hands those names in through --hold-labels; with none given, nothing is
// held. The closing keywords are GitHub's own grammar, not any repository's
// vocabulary, and `REOPENED` is GitHub's `stateReason` enum.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { openPrCheck } from "./file.js";

export const RECONCILE_CONTRACT = "nen.issue.reconcile/v0.1";

/** The page both lists are asked for by default, and the number a truncation is judged against. */
export const RECONCILE_LIMIT = 100;

/** The largest --limit accepted: `gh`'s own ceiling for a list it paginates itself. */
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
  return text
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ");
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
  "    pageInfo { hasNextPage endCursor }",
  "    nodes { ... on PullRequest {",
  "      number title url baseRefName mergedAt body",
  "      mergeCommit { oid }",
  `      closingIssuesReferences(first: ${LINKS_PER_PR}) { totalCount nodes { number url repository { name owner { login } } } }`,
  `      commits(first: ${COMMITS_PER_PR}) { totalCount nodes { commit { oid messageHeadline messageBody } } }`,
  "    } }",
  "  }",
  "}",
].join("\n");

export function openIssuesArgv(target: Target, limit: number): readonly string[] {
  return ["issue", "list", "--repo", target.slug, "--state", "open", "--limit", String(limit), "--json", ISSUE_FIELDS];
}

/** The search expression: this repository's merged pull requests, newest activity first. */
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
export function parseMergedPullsPage(text: string): {
  readonly rows: readonly Record<string, unknown>[];
  readonly hasNextPage: boolean;
  readonly endCursor: string | null;
  readonly overflow: readonly string[];
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
  const rows = nodes.map((node): Record<string, unknown> => {
    const row = record(node);
    const links = record(row["closingIssuesReferences"]);
    const commits = record(row["commits"]);
    const linkNodes = Array.isArray(links["nodes"]) ? links["nodes"] : [];
    const commitNodes = Array.isArray(commits["nodes"]) ? commits["nodes"] : [];
    if (Number(links["totalCount"] ?? 0) > linkNodes.length) {
      overflow.push(`PR #${String(row["number"])} has ${String(links["totalCount"])} closing references; only ${linkNodes.length} were read`);
    }
    if (Number(commits["totalCount"] ?? 0) > commitNodes.length) {
      overflow.push(`PR #${String(row["number"])} has ${String(commits["totalCount"])} commits; only ${commitNodes.length} were read`);
    }
    return {
      ...row,
      closingIssuesReferences: linkNodes,
      commits: commitNodes.map((item): Record<string, unknown> => record(record(item)["commit"])),
    };
  });
  const cursor = pageInfo["endCursor"];
  return {
    rows,
    hasNextPage: pageInfo["hasNextPage"] === true,
    endCursor: typeof cursor === "string" && cursor !== "" ? cursor : null,
    overflow,
  };
}

/**
 * Every merged pull request the search yields, up to `limit`, page by page.
 * `null` when a page could not be read (the finding is recorded); `truncated`
 * when the limit was reached with more still on GitHub's side.
 */
function readMergedPulls(
  seams: Seams,
  target: Target,
  limit: number,
  since: string | null,
  findings: Finding[],
): { readonly pulls: MergedPullRequest[]; readonly truncated: boolean } | null {
  const rows: Record<string, unknown>[] = [];
  let after: string | null = null;
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
    rows.push(...page.rows);
    for (const detail of page.overflow) findings.push({ source: "merged-pull-requests", detail });
    if (!page.hasNextPage) return { pulls: parseMergedPulls(JSON.stringify(rows), target), truncated: false };
    if (rows.length >= limit) return { pulls: parseMergedPulls(JSON.stringify(rows), target), truncated: true };
    if (page.endCursor === null) {
      findings.push({ source: "merged-pull-requests", detail: "the search said another page exists and gave no cursor to read it" });
      return { pulls: parseMergedPulls(JSON.stringify(rows), target), truncated: true };
    }
    after = page.endCursor;
  }
}

// --- the report ----------------------------------------------------------------

/**
 * Where a merged pull request's merge commit stands against the default branch.
 *   default-branch         -- the PR merged straight into it;
 *   reached-default-branch -- it merged elsewhere, and the merge commit is now
 *                             reachable from the default branch;
 *   not-on-default-branch  -- it merged elsewhere and has not reached it;
 *   unknown                -- that could not be read (a finding names why).
 */
export type Landing = "default-branch" | "reached-default-branch" | "not-on-default-branch" | "unknown";

export interface Evidence {
  readonly pr: number;
  readonly url: string;
  readonly title: string;
  readonly base: string;
  readonly mergedAt: string | null;
  readonly mergeCommit: string | null;
  readonly landing: Landing;
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
  /** Which source: `default-branch`, `open-issues`, `merged-pull-requests`, `compare #<pr>`, `open-pr-guard`. */
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
const NOT_REACHED = new Set(["ahead", "diverged"]);

function landingOf(
  seams: Seams,
  target: Target,
  defaultBranch: string | null,
  pull: MergedPullRequest,
  cache: Map<string, Landing>,
  findings: Finding[],
): Landing {
  if (defaultBranch === null) return "unknown";
  if (pull.base === defaultBranch) return "default-branch";
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
    else if (NOT_REACHED.has(status)) landing = "not-on-default-branch";
    else findings.push({ source: `compare #${pull.number}`, detail: `comparing ${pull.mergeCommit} with '${defaultBranch}' answered an unrecognised status '${status}'` });
  }
  cache.set(pull.mergeCommit, landing);
  return landing;
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
          ? `merged into '${evidence.base}', and its merge commit has NOT reached '${defaultBranch ?? "?"}'`
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
      detail: `the merged pull-request search reached --limit (${options.limit}) with more left; an older merge was not scanned -- narrow --since or raise --limit`,
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

  // Issue -> its evidence, in the order the PRs were listed (newest merge first).
  const evidenceByIssue = new Map<number, Evidence[]>();
  const landingCache = new Map<string, Landing>();
  for (const pull of pulls ?? []) {
    for (const [issue, references] of pull.references) {
      if (!open.has(issue)) continue;
      const evidence: Evidence = {
        pr: pull.number,
        url: pull.url,
        title: pull.title,
        base: pull.base,
        mergedAt: pull.mergedAt,
        mergeCommit: pull.mergeCommit,
        landing: landingOf(seams, target, defaultBranch, pull, landingCache, findings),
        references,
      };
      evidenceByIssue.set(issue, [...(evidenceByIssue.get(issue) ?? []), evidence]);
    }
  }

  // The open-PR guard, over every issue some landed PR would close -- the same
  // guard `issue open-pr-check` and `consolidate-close` run, reused.
  const holds = new Set(options.holdLabels);
  const guardCandidates = [...evidenceByIssue.entries()]
    .filter(([issue, evidence]): boolean => evidence.some((item): boolean => landed(item.landing)) && !(open.get(issue)?.labels ?? []).some((label): boolean => holds.has(label)))
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
      const held = issue.labels.filter((label): boolean => holds.has(label));
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

/** The human rendering: the same report the --json document carries, in lines. */
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
  return lines;
}
