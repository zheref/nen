// src/pr/converge.ts -- the reads behind `nen pr converge`: one pull request's
// body and closing issues, then each closing issue's body. The comparison
// itself is ../issue/criteria.ts's `converge`, pure.
//
// READ-ONLY, AND EVERY READ IS ONE nen ALREADY MAKES. The pull request is read
// with `gh pr view --json` (the call ./fetch.ts and ../issue/file.ts make),
// whose `closingIssuesReferences` is GitHub's own list of the issues the PR
// will close -- a body keyword and a sidebar link alike. Each issue is read
// over REST with ../issue/subissue.ts's `readIssue`, the read the issue-shape
// verbs make, in the issue's OWN repository (a PR may close an issue
// elsewhere).
//
// A READ THAT DID NOT FINISH IS NEVER AN EMPTY LIST. A failed call, a payload
// without the field, a page that came back full (gh reads the first 100
// closing references), a reference naming no repository, or an issue with no
// body each throw `ConvergeReadError`, which the verb reports at exit 2:
// "could not read" is never "nothing to cover".

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import { readIssue } from "../issue/subissue.js";
import { extractCriteria, type ClosingIssue } from "../issue/criteria.js";

export class ConvergeReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConvergeReadError";
  }
}

/** gh's `pr view` asks for the first 100 closing references; a full page may not be all of them. */
export const CLOSING_PAGE = 100;

export function convergeViewArgv(target: Target, prNumber: number): readonly string[] {
  return ["pr", "view", String(prNumber), "--repo", target.slug, "--json", "number,url,headRefOid,body,closingIssuesReferences"];
}

export interface ConvergeInput {
  readonly url: string;
  readonly headSha: string;
  readonly body: string;
  readonly issues: readonly ClosingIssue[];
}

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/**
 * An `owner/name` GitHub could have issued. The slug comes from the payload
 * and becomes a `gh api repos/<slug>/...` path, so a value with a `..`, a
 * slash too many or a query character is refused (exit 2), never sent.
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
export function readConvergeInput(seams: Seams, target: Target, prNumber: number): ConvergeInput {
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
  const body = parsed["body"];
  if (typeof body !== "string") throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s body: the payload carried no 'body' string.`);
  const references = parsed["closingIssuesReferences"];
  if (!Array.isArray(references)) {
    throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s closing issues: the payload carried no 'closingIssuesReferences' array.`);
  }
  if (references.length >= CLOSING_PAGE) {
    throw new ConvergeReadError(`${target.slug}#${prNumber} lists ${references.length} closing issues, a full page of gh's first ${CLOSING_PAGE}; the rest were not read.`);
  }
  const seen = new Set<string>();
  const issues: ClosingIssue[] = [];
  for (const [index, raw] of references.entries()) {
    const entry = record(raw);
    const number = entry?.["number"];
    const slug = entry === null ? null : referenceSlug(entry);
    if (entry === null || typeof number !== "number" || !Number.isSafeInteger(number) || number <= 0 || slug === null) {
      throw new ConvergeReadError(`could not read ${target.slug}#${prNumber}'s closing reference [${index}]: it names no issue number and repository.`);
    }
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
    issues.push({ target: slug, number, report: extractCriteria(summary.body.replace(/\r\n?/g, "\n")) });
  }
  const url = parsed["url"];
  const head = parsed["headRefOid"];
  return { url: typeof url === "string" ? url : "", headSha: typeof head === "string" ? head : "", body: body.replace(/\r\n?/g, "\n"), issues };
}
