// src/issue/file.ts -- the open-PR guard on a candidate set, and the filing call
// itself.
//
// THE GUARD EXISTS BECAUSE CLOSING ORPHANS WORK. Both skills this ports from
// carry the same warning in the same words: an issue with an OPEN PR is never
// quietly closed, because closing it orphans work already in flight. Deciding
// WHETHER to close is judgment and stays with the caller; establishing whether a
// PR is in flight is a lookup, and a lookup done by eye across forty open PRs
// is a lookup that will be skipped on the fortieth.
//
// THE LABELS AND THE ASSIGNEE GO IN THE CREATE CALL, never a follow-up edit.
// That is not tidiness: a label applied a second later is a `labeled` event on
// an issue that already existed, and in a system where a label is a wake edge
// the difference between "created with it" and "labelled afterwards" is the
// difference between one dispatch and two. `gh issue create` takes both, so
// there is no reason to ever be in the second state.
//
// WHAT IT REFUSES. A label the target repository's taxonomy does not carry, and
// a label in a family the caller declared off-limits. Both are mechanical, and
// both are the shape of mistake that is invisible afterwards: GitHub CREATES a
// label that does not exist rather than refusing, so a typo'd label becomes a
// real, grey, undocumented label in the repository's taxonomy forever.
//
// WHAT IT DOES NOT DO: choose a severity, write a title, or decide that two
// issues are the same problem. Those are § 2's "stays with the LLM" list, and a
// verb that guessed one would be scoped wrong rather than ambitious.

import { lines, type Runner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { decomposeLabelName, type LabelTaxonomy } from "../schema/labels.js";

// --- open-PR guard -----------------------------------------------------------

/** The page `gh pr list` is asked for, and the number a truncation is judged against. */
export const OPEN_PR_LIMIT = 100;

export interface LinkedPullRequest {
  readonly number: number;
  readonly title: string;
  readonly url: string;
  readonly isDraft: boolean;
  /** Issue numbers this PR declares it CLOSES. */
  readonly closes: readonly number[];
  /** Issue numbers it merely mentions in its body. */
  readonly mentions: readonly number[];
}

export interface OpenPrFinding {
  readonly issue: number;
  readonly pullRequests: readonly LinkedPullRequest[];
  /** `true` when at least one open PR closes or mentions this issue. */
  readonly blocked: boolean;
}

export interface OpenPrReport {
  readonly findings: readonly OpenPrFinding[];
  /** Open PRs scanned. */
  readonly scanned: number;
  /**
   * Set when the scan came back FULL. A guard that silently read one page would
   * report "no open PR" for an issue whose PR sat on page two -- and the whole
   * point of the guard is that its negative answer is trusted.
   */
  readonly truncated: boolean;
}

const PR_FIELDS = "number,title,url,isDraft,body,closingIssuesReferences";

export function parsePullRequestList(json: string): LinkedPullRequest[] {
  const parsed: unknown = JSON.parse(json === "" ? "[]" : json);
  if (!Array.isArray(parsed)) throw new Error("expected a JSON array of pull requests");
  return parsed.map((entry): LinkedPullRequest => {
    const record = entry as Record<string, unknown>;
    const closingRaw = record["closingIssuesReferences"];
    const closes = Array.isArray(closingRaw)
      ? closingRaw
          .map((item): number => Number((item as Record<string, unknown>)["number"] ?? 0))
          .filter((value): boolean => value > 0)
      : [];
    return {
      number: Number(record["number"] ?? 0),
      title: String(record["title"] ?? ""),
      url: String(record["url"] ?? ""),
      isDraft: record["isDraft"] === true,
      closes,
      mentions: mentionedIssues(String(record["body"] ?? "")),
    };
  });
}

// `#123` anywhere in the body, deduplicated, in first-appearance order.
//
// It deliberately does NOT try to distinguish "Closes #12" from "see #12": the
// declared closing links come from GitHub's own field above, which also catches
// a link made through the sidebar with no body text at all. This is the wider,
// weaker signal, reported separately so a caller can tell a claim from a
// mention.
export function mentionedIssues(body: string): number[] {
  const found = new Set<number>();
  for (const match of body.matchAll(/#(\d+)\b/g)) {
    const value = Number(match[1]);
    if (Number.isInteger(value) && value > 0) found.add(value);
  }
  return [...found];
}

export function openPrCheck(
  runner: Runner,
  target: Target,
  issues: readonly number[],
): OpenPrReport {
  const result = runner.run({
    bin: "gh",
    args: [
      "pr",
      "list",
      "--repo",
      target.slug,
      "--state",
      "open",
      "--limit",
      String(OPEN_PR_LIMIT),
      "--json",
      PR_FIELDS,
    ],
  });
  if (result.code !== 0) {
    throw new Error(
      `could not list open pull requests on ${target.slug}: ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }`,
    );
  }
  const pulls = parsePullRequestList(result.stdout.trim());
  const findings = issues.map((issue): OpenPrFinding => {
    const matched = pulls.filter(
      (pull): boolean => pull.closes.includes(issue) || pull.mentions.includes(issue),
    );
    return { issue, pullRequests: matched, blocked: matched.length > 0 };
  });
  return { findings, scanned: pulls.length, truncated: pulls.length >= OPEN_PR_LIMIT };
}

// --- filing ------------------------------------------------------------------

export interface FileRequest {
  readonly title: string;
  readonly bodyFile: string;
  readonly labels: readonly string[];
  readonly assignee: string;
  /**
   * Label FAMILIES the caller declares off-limits, as `<namespace>:<family>`.
   * The caller supplies them because which family means "this is released into
   * a build" is the target repository's vocabulary, not this binary's -- § 3's
   * names-are-data rule applied to a prohibition rather than to a value.
   */
  readonly forbiddenFamilies: readonly string[];
}

export interface FileRefusal {
  readonly reason: string;
}

// Everything checkable before a single write.
//
// ALL of them are reported, not the first: a filing blocked by three things and
// reported one at a time is three round-trips, and the caller here is usually a
// loop that will simply retry the same broken invocation.
export function validateFiling(
  request: FileRequest,
  taxonomy: LabelTaxonomy,
): readonly FileRefusal[] {
  const refusals: FileRefusal[] = [];
  if (request.title.trim() === "") {
    refusals.push({ reason: "--title is empty" });
  }
  if (request.labels.length === 0) {
    refusals.push({
      reason:
        "--label was not given. Labels go in the create call so a loop can triage the issue without reading it; filing unlabelled and labelling afterwards is a second event on an object that already exists.",
    });
  }
  if (request.assignee.trim() === "") {
    refusals.push({
      reason:
        "--assignee was not given. An unassigned issue reaches nobody by notification and is found at the next sweep instead.",
    });
  }
  const forbidden = new Set(request.forbiddenFamilies);
  for (const label of request.labels) {
    if (!taxonomy.has(label)) {
      refusals.push({
        reason: `label '${label}' is not in this repository's taxonomy (${taxonomy.path}). GitHub would CREATE it rather than refuse, so a typo becomes a permanent undocumented label.`,
      });
      continue;
    }
    const parts = decomposeLabelName(label);
    if (parts.namespace === null || parts.family === null) continue;
    const family = `${parts.namespace}:${parts.family}`;
    if (forbidden.has(family)) {
      refusals.push({
        reason: `label '${label}' is in the '${family}' family, which this invocation declared off-limits with --forbid-family.`,
      });
    }
  }
  return refusals;
}

export function createArgv(target: Target, request: FileRequest): readonly string[] {
  const argv = [
    "issue",
    "create",
    "--repo",
    target.slug,
    "--title",
    request.title,
    "--body-file",
    request.bodyFile,
    "--assignee",
    request.assignee,
  ];
  // One `--label` per label, in the order given. `gh` also accepts a
  // comma-joined value, which silently breaks on a label whose own name
  // contains a comma -- a legal GitHub label.
  for (const label of request.labels) argv.push("--label", label);
  return argv;
}

export interface FileResult {
  readonly url: string;
  readonly number: number;
}

const ISSUE_URL = /https:\/\/[^\s]+\/issues\/(\d+)/;

export function fileIssue(runner: Runner, target: Target, request: FileRequest): FileResult {
  const result = runner.run({ bin: "gh", args: createArgv(target, request) });
  if (result.code !== 0) {
    throw new Error(
      `issue creation failed: ${
        (result.spawnError ?? lines(result.stderr).join(" ")) || `exit ${result.code}`
      }`,
    );
  }
  // The URL is READ OUT of stdout rather than assumed: a `gh` that printed a
  // warning first, or nothing at all, must not be reported as a successful
  // filing whose number nobody has.
  const match = ISSUE_URL.exec(result.stdout);
  if (match === null || match[1] === undefined) {
    throw new Error(
      "issue creation returned no issue URL, so there is nothing to report as filed. Nothing was labelled or assigned by this call beyond what the create carried.",
    );
  }
  return { url: match[0], number: Number(match[1]) };
}
