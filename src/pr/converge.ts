// src/pr/converge.ts -- the reads behind `nen pr converge`: one pull request's
// body and closing issues, then each closing issue's body. The comparison
// itself is ../issue/criteria.ts's `converge`, pure.
//
// READ-ONLY, AND EVERY READ IS ONE nen ALREADY MAKES. The pull request is read
// with `gh pr view --json` (the call ./fetch.ts and ../issue/file.ts make),
// whose `closingIssuesReferences` is GitHub's own list of the issues the PR
// will close -- a body keyword and a sidebar link alike, BUT ONLY for a PR
// into the repository's default branch. On another base GitHub computes no
// closing references, so when the list is empty and the base is not the
// default branch (read with `gh repo view --json defaultBranchRef`), the
// body's own closing keywords (`Closes #12`, `Fixes owner/name#3`, an issue
// URL) are parsed instead; a body naming none there is reported, never "closes
// no issue" at exit 0. Each issue is read
// over REST with ../issue/subissue.ts's `readIssue`, the read the issue-shape
// verbs make, in the issue's OWN repository (a PR may close an issue
// elsewhere).
//
// A READ THAT DID NOT FINISH IS NEVER AN EMPTY LIST. A failed call, a payload
// without the field, a page that came back full (gh reads the first 100
// closing references), a reference naming no repository, or an issue with no
// body each throw `ConvergeReadError`, which the verb reports at exit 1:
// "could not read" is never "nothing to cover".

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { readIssue } from "../issue/subissue.js";
import { converge, extractCriteria, type ClosingIssue, type CoveragePolicy, DEFAULT_COVERAGE_POLICY } from "../issue/criteria.js";
import { maskedLines, type IssueSectionsCatalogue } from "../issue/shape.js";

export class ConvergeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvergeReadError";
  }
}

/** gh's `pr view` asks for the first 100 closing references; a full page may not be all of them. */
export const CLOSING_PAGE = 100;

export function convergeViewArgv(target: Target, prNumber: number): readonly string[] {
  return ["pr", "view", String(prNumber), "--repo", target.slug, "--json", "number,url,headRefOid,baseRefName,body,closingIssuesReferences"];
}

/** The head-only re-read `--require-head` closes with (zheref/nen#483 AC-6). */
export function headViewArgv(target: Target, prNumber: number): readonly string[] {
  return ["pr", "view", String(prNumber), "--repo", target.slug, "--json", "headRefOid"];
}

/**
 * Hold a converge read to one pinned head (zheref/nen#483 AC-6): the first
 * read's `headRefOid` must equal `requireHead`, and a head-only re-read AFTER
 * every closing issue was read must still equal it. Either differing -- or the
 * re-read failing -- throws: a verdict assembled across two heads is refused,
 * never reported.
 */
export function assertPinnedHead(seams: Seams, target: Target, prNumber: number, input: ConvergeInput, requireHead: string): void {
  const pin = requireHead.toLowerCase();
  if (input.headSha.toLowerCase() !== pin) {
    throw new ConvergeReadError(`${target.slug}#${prNumber}'s head is ${input.headSha === "" ? "(unread)" : input.headSha}, not the pinned ${requireHead}; no verdict is reported for a head other than the one pinned.`);
  }
  const again = seams.run(GH, headViewArgv(target, prNumber));
  let head: unknown = null;
  try {
    head = again.code === 0 ? record(JSON.parse(again.stdout))?.["headRefOid"] : null;
  } catch {
    head = null;
  }
  if (typeof head !== "string" || head === "") {
    throw new ConvergeReadError(`could not re-read ${target.slug}#${prNumber}'s head after the closing issues, so the reads cannot be shown to share one head: ${outputLines(again.stderr).join(" ") || `exit ${again.code}`}`);
  }
  if (head.toLowerCase() !== pin) {
    throw new ConvergeReadError(`${target.slug}#${prNumber}'s head moved from ${requireHead} to ${head} between the reads; refusing to mix two heads in one verdict.`);
  }
}

export function defaultBranchViewArgv(target: Target): readonly string[] {
  return ["repo", "view", target.slug, "--json", "defaultBranchRef"];
}

/** Where the closing issues came from: GitHub's list, the body's keywords on a non-default base, or nowhere. */
export type ClosingSource = "github" | "body-keywords" | "none-on-non-default-base" | "none";

const CLOSING_KEYWORD =
  /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\b:?\s+(?:https:\/\/github\.com\/([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)\/issues\/|([A-Za-z0-9-]+\/[A-Za-z0-9._-]+)?#)(\d{1,9})\b/gi;

/** The issues a body's closing keywords name, outside fenced code, inline code and comments, deduplicated in order. */
export function bodyClosingReferences(body: string, target: Target): { slug: string; number: number }[] {
  const found: { slug: string; number: number }[] = [];
  const seen = new Set<string>();
  for (const line of maskedLines(body)) {
    for (const match of line.text.matchAll(CLOSING_KEYWORD)) {
      const slug = match[1] ?? match[2] ?? target.slug;
      const number = Number(match[3]);
      const key = `${slug.toLowerCase()}#${number}`;
      if (seen.has(key) || !SLUG.test(slug)) continue;
      seen.add(key);
      found.push({ slug, number });
    }
  }
  return found;
}

export interface ConvergeInput {
  readonly url: string;
  readonly headSha: string;
  readonly base: string;
  readonly body: string;
  readonly issues: readonly ClosingIssue[];
  readonly closingSource: ClosingSource;
  /** GitHub's own closing references (the Development links), as read; empty on a non-default base. */
  readonly linked: readonly { readonly slug: string; readonly number: number }[];
  /** The catalogue the closing issues' criteria were read with: the verify rows' ids are read in its grammar too (zheref/nen#519). */
  readonly catalogue?: IssueSectionsCatalogue | null;
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * An `owner/name` GitHub could have issued. The slug comes from the payload
 * and becomes a `gh api repos/<slug>/...` path, so a value with a `..`, a
 * slash too many or a query character is refused (exit 1, could not read), never sent.
 */
const SLUG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})\/(?!\.\.?$)[A-Za-z0-9._-]{1,100}$/;

/** `owner/name` of one closing reference: its `repository`, else its issue URL. */
function referenceSlug(entry: Record<string, unknown>): string | null {
  const repository = record(entry["repository"]);
  const owner = record(repository?.["owner"]);
  const login = owner?.["login"];
  const name = repository?.["name"];
  const slug = typeof login === "string" && typeof name === "string" ? `${login}/${name}` : null;
  if (slug !== null && SLUG.test(slug)) return slug;
  if (slug !== null && slug !== "/") return null;
  const url = entry["url"];
  const match = typeof url === "string" ? /^https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/issues\/\d+$/.exec(url) : null;
  return match !== null && SLUG.test(match[1] as string) ? (match[1] as string) : null;
}

/** Read the pull request and every issue it closes, or throw `ConvergeReadError`. */
export function readConvergeInput(seams: Seams, target: Target, prNumber: number, catalogue: IssueSectionsCatalogue | null = null): ConvergeInput {
  const result = seams.run(GH, convergeViewArgv(target, prNumber));
  if (result.code !== 0) {
    throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
  let parsed: Record<string, unknown> | null;
  try {
    parsed = record(JSON.parse(result.stdout));
  } catch {
    parsed = null;
  }
  if (parsed === null) throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}: gh pr view did not answer a JSON object.`);
  return convergeInputFromView(seams, target, prNumber, parsed, catalogue);
}

/**
 * The converge input from a `gh pr view` payload already read (its `body`,
 * `closingIssuesReferences`, `baseRefName`, `headRefOid`, `url`), then each
 * closing issue read. `defaultBranch`, when the caller has read it, spares the
 * `gh repo view`; absent, it is read here when the closing list is empty. A
 * caller that read the payload in ITS one fetch (`pr merge --delivery`)
 * judges the criteria at the very head it pinned.
 */
export function convergeInputFromView(
  seams: Seams,
  target: Target,
  prNumber: number,
  parsed: Record<string, unknown>,
  catalogue: IssueSectionsCatalogue | null = null,
  defaultBranchKnown: string | null = null,
): ConvergeInput {
  const body = parsed["body"];
  if (typeof body !== "string") throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s body: the payload carried no 'body' string.`);
  const references = parsed["closingIssuesReferences"];
  if (!Array.isArray(references)) {
    throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s closing issues: the payload carried no 'closingIssuesReferences' array.`);
  }
  if (references.length >= CLOSING_PAGE) {
    throw new ConvergeReadError(`${target.slug}#${prNumber} lists ${references.length} closing issues, a full page of gh's first ${CLOSING_PAGE}; the rest were not read.`);
  }
  const base = typeof parsed["baseRefName"] === "string" ? (parsed["baseRefName"] as string) : "";
  const named: { slug: string; number: number }[] = [];
  for (const [index, raw] of references.entries()) {
    const entry = record(raw);
    const number = entry?.["number"];
    const slug = entry === null ? null : referenceSlug(entry);
    if (entry === null || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || slug === null) {
      throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s closing reference [${index}]: it names no issue number and repository.`);
    }
    named.push({ slug, number });
  }
  let closingSource: ClosingSource = named.length > 0 ? "github" : "none";
  if (named.length === 0) {
    let defaultBranch: unknown = defaultBranchKnown;
    if (defaultBranch === null) {
      const view = seams.run(GH, defaultBranchViewArgv(target));
      try {
        defaultBranch = view.code === 0 ? record(record(JSON.parse(view.stdout))?.["defaultBranchRef"])?.["name"] : null;
      } catch {
        defaultBranch = null;
      }
      if (typeof defaultBranch !== "string" || defaultBranch === "") {
        throw new ConvergeReadError(`could not read ${target.slug}'s default branch, so an empty closing list cannot be told from a non-default base's: ${outputLines(view.stderr).join(" ") || `exit ${view.code}`}`);
      }
    }
    if (base === "") throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s base: the payload carried no 'baseRefName' string.`);
    if (base !== defaultBranch) {
      named.push(...bodyClosingReferences(body.replace(/\r\n?/g, "\n"), target));
      closingSource = named.length > 0 ? "body-keywords" : "none-on-non-default-base";
    }
  }
  const seen = new Set<string>();
  const issues: ClosingIssue[] = [];
  for (const { slug, number } of named) {
    const key = `${slug.toLowerCase()}#${number}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const [owner, name] = slug.split("/") as [string, string];
    const issueTarget: Target = { owner, repo: name, slug };
    let summary;
    try {
      summary = readIssue(seams, issueTarget, number);
    } catch (error) {
      throw new ConvergeReadError(error instanceof Error ? error.message : String(error));
    }
    if (summary.isPullRequest) throw new ConvergeReadError(`${slug}#${number}, a closing reference of ${target.slug}#${prNumber}, names a pull request, not an issue.`);
    if (summary.body === undefined) throw new ConvergeReadError(`could not read ${slug}#${number}'s body: the API payload carried no 'body' field.`);
    issues.push({ target: slug, number, report: extractCriteria(summary.body.replace(/\r\n?/g, "\n"), catalogue) });
  }
  const url = parsed["url"];
  const head = parsed["headRefOid"];
  return {
    url: typeof url === "string" ? url : "",
    headSha: typeof head === "string" ? head : "",
    base,
    body: body.replace(/\r\n?/g, "\n"),
    issues,
    closingSource,
    linked: closingSource === "github" ? named.slice() : [],
    catalogue,
  };
}

/** One conjunct of the convergence verdict: its name, whether it holds, and the lines that say why. */
export interface ConvergeConjunct {
  readonly name: string;
  readonly ok: boolean;
  readonly lines: readonly string[];
}

/**
 * The closing-issue links conjunct (zheref/nen#483 AC-1; Hatsu HA#203): on a
 * pull request into the default branch, every issue a body closing keyword
 * names must be one GitHub links as closing (a Development link), and every
 * issue GitHub links must be named in the body -- the link both ways. On
 * another base GitHub links nothing, so the conjunct holds and says the body's
 * keywords were read instead.
 */
export function closingLinksConjunct(input: ConvergeInput, target: Target): ConvergeConjunct {
  const name = "closing links";
  if (input.closingSource !== "github" && input.closingSource !== "none") {
    return { name, ok: true, lines: [`closing links: '${input.base}' is not the default branch -- GitHub links no closing issue there, so the body's closing keywords were read (${input.issues.length} issue(s))`] };
  }
  const key = (ref: { slug: string; number: number }): string => `${ref.slug.toLowerCase()}#${ref.number}`;
  const linked = new Set(input.linked.map(key));
  const named = bodyClosingReferences(input.body, target);
  const namedKeys = new Set(named.map(key));
  const unlinked = named.filter((ref): boolean => !linked.has(key(ref)));
  const unnamed = input.linked.filter((ref): boolean => !namedKeys.has(key(ref)));
  const lines: string[] = [];
  for (const ref of unlinked) lines.push(`closing links: the body closes ${ref.slug}#${ref.number}, but GitHub links no such closing issue (no Development link)`);
  for (const ref of unnamed) lines.push(`closing links: GitHub links ${ref.slug}#${ref.number} as closing, but the body names it in no closing keyword`);
  if (lines.length > 0) return { name, ok: false, lines };
  return {
    name,
    ok: true,
    lines: [input.linked.length === 0 ? "closing links: closes no issue, and the body names none" : `closing links: ${input.linked.length} issue(s) linked both ways: ${input.linked.map((ref): string => `${ref.slug}#${ref.number}`).join(", ")}`],
  };
}

/**
 * The criteria-coverage conjunct (Hatsu HR-11; Akatsuki CON-17(c)): every
 * closing issue's acceptance criteria against the body's verify rows, by the
 * caller's coverage policy. A blocking row is QUOTED (zheref/nen#479 AC-3).
 * A non-default base that closes nothing is reported, never blocked (#483
 * AC-5, the integrator's ruling of 2026-10-23).
 */
export function criteriaConjunct(input: ConvergeInput, policy: CoveragePolicy = DEFAULT_COVERAGE_POLICY): ConvergeConjunct & { readonly blocking: readonly string[] } {
  const report = converge(input.issues, input.body, policy, input.catalogue ?? null);
  const head =
    input.issues.length === 0
      ? input.closingSource === "none-on-non-default-base"
        ? "criteria: GitHub lists no closing issue and the body names none on a non-default base -- no criterion to compare"
        : "criteria: closes no issue -- no criterion to compare"
      : `criteria: ${report.criteria.length} criterion row(s) across ${input.issues.length} closing issue(s), ${report.blocking.length} blocking`;
  return { name: "criteria", ok: report.blocking.length === 0, lines: [head, ...report.blocking.map((line): string => `  BLOCKING ${line}`)], blocking: report.blocking };
}
