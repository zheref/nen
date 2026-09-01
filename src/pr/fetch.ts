// src/pr/fetch.ts -- the whole-PR fetch: head SHA and mergeability, the check
// rollup, reviews PER COMMIT, review threads with their resolution state, and
// the pending review requests, in one typed snapshot.
//
// THREE gh CALLS, DELIBERATELY, NOT ONE. `gh pr view --json` answers the PR
// node, its labels, its mergeability and its check rollup in a single call, but
// it does not carry a review's `commit_id` -- and CON-16's current-head rule
// (a review counts only against the SHA it was cast on) needs exactly that
// field. So reviews are read over REST, matching ../github/client.ts's own
// documented reason for the same split. Review-thread RESOLUTION is not a
// `pr view --json` field at all; it exists only over GraphQL, so a third call
// asks for it directly.
//
// EVERY RESPONSE GOES THROUGH ../github/parse.ts, never read by hand. A rollup
// entry, a review, a thread that does not parse is a FAILURE of this fetch, not
// an empty list -- the whole point of the typed layer this repository already
// has is that "GitHub renamed a field" surfaces as a named parse error instead
// of silently reading as "no checks, no reviews, nothing unresolved", which is
// the single most dangerous direction a readiness fetch can be wrong in.
//
// ONE PAGE OF REVIEW THREADS. ../github/client.ts's own header says a single
// first(100) query silently drops threads 101+ and that deciding what that
// means for readiness belongs to the caller, not the transport. This module
// takes that decision: a fetch that came back with a FULL page of threads is
// reported `threadsTruncated: true` rather than pretending "unresolved: none"
// is the whole truth. A PR with over 100 review threads is already a
// pathological case a human is looking at directly.

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import {
  parseCheckRollup,
  parsePullRequest,
  parseReviewRequests,
  parseReviews,
  parseReviewThreads,
} from "../github/parse.js";
import type {
  PullRequest,
  ReviewRequest,
  Review,
  ReviewThread,
  RollupEntry,
} from "../github/types.js";

export interface PrSnapshot {
  readonly pr: PullRequest;
  readonly title: string;
  readonly url: string;
  readonly body: string;
  readonly state: string;
  /** GitHub's own composite: CLEAN, DIRTY, BLOCKED, BEHIND, UNSTABLE, UNKNOWN. */
  readonly mergeStateStatus: string;
  readonly checks: readonly RollupEntry[];
  readonly reviews: readonly Review[];
  readonly reviewRequests: readonly ReviewRequest[];
  readonly reviewThreads: readonly ReviewThread[];
  /** The review-thread page came back full; a thread beyond it was not seen. */
  readonly threadsTruncated: boolean;
}

export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

const VIEW_FIELDS =
  "number,headRefOid,baseRefName,headRefName,author,labels,mergeable,mergeStateStatus,isDraft,body,url,title,state,statusCheckRollup,reviewRequests";

export function viewArgv(target: Target, prNumber: number): readonly string[] {
  return ["pr", "view", String(prNumber), "--repo", target.slug, "--json", VIEW_FIELDS];
}

export function reviewsArgv(target: Target, prNumber: number): readonly string[] {
  // Unpaginated on purpose, for a first cut: a review ROUND count over 100 on
  // one PR is itself the finding. A caller that hits this ceiling sees it in
  // `reviews.length === 100` and can say so; --paginate output is line-delimited
  // JSON pages rather than one array, which this module's single-parse shape
  // does not want to grow a second code path for yet.
  return ["api", `repos/${target.slug}/pulls/${prNumber}/reviews`, "-F", "per_page=100"];
}

const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved} pageInfo{hasNextPage}}}}}";

export function reviewThreadsArgv(target: Target, prNumber: number): readonly string[] {
  return [
    "api",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_QUERY}`,
    "-F",
    `owner=${target.owner}`,
    "-F",
    `name=${target.repo}`,
    "-F",
    `number=${prNumber}`,
  ];
}

function runOrThrow(seams: Seams, args: readonly string[], what: string): string {
  const result = seams.run(GH, [...args]);
  if (result.code !== 0) {
    throw new FetchError(`could not fetch ${what}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
  return result.stdout;
}

export function fetchPullRequest(seams: Seams, target: Target, prNumber: number): PrSnapshot {
  const viewRaw = runOrThrow(seams, viewArgv(target, prNumber), `${target.slug}#${prNumber}`);
  let view: Record<string, unknown>;
  try {
    view = JSON.parse(viewRaw) as Record<string, unknown>;
  } catch (error) {
    throw new FetchError(`${target.slug}#${prNumber}: gh pr view did not return JSON (${String(error)})`);
  }

  const pr = parsePullRequest(view);
  if (!pr.ok) throw new FetchError(`${target.slug}#${prNumber}: ${pr.error.path} -- ${pr.error.message}`);
  const checks = parseCheckRollup(view["statusCheckRollup"]);
  if (!checks.ok) throw new FetchError(`${target.slug}#${prNumber}: ${checks.error.path} -- ${checks.error.message}`);
  const reviewRequests = parseReviewRequests(view["reviewRequests"]);
  if (!reviewRequests.ok) {
    throw new FetchError(`${target.slug}#${prNumber}: ${reviewRequests.error.path} -- ${reviewRequests.error.message}`);
  }

  const reviewsRaw = runOrThrow(seams, reviewsArgv(target, prNumber), `${target.slug}#${prNumber} reviews`);
  const reviews = parseReviews(JSON.parse(reviewsRaw === "" ? "[]" : reviewsRaw));
  if (!reviews.ok) throw new FetchError(`${target.slug}#${prNumber}: ${reviews.error.path} -- ${reviews.error.message}`);

  const threadsRaw = runOrThrow(
    seams,
    reviewThreadsArgv(target, prNumber),
    `${target.slug}#${prNumber} review threads`,
  );
  const threadsResponse = JSON.parse(threadsRaw) as {
    data?: { repository?: { pullRequest?: { reviewThreads?: { nodes?: unknown; pageInfo?: { hasNextPage?: boolean } } } } };
  };
  const threadsField = threadsResponse.data?.repository?.pullRequest?.reviewThreads;
  const reviewThreads = parseReviewThreads(threadsField?.nodes);
  if (!reviewThreads.ok) {
    throw new FetchError(`${target.slug}#${prNumber}: ${reviewThreads.error.path} -- ${reviewThreads.error.message}`);
  }

  return {
    pr: pr.value,
    title: String(view["title"] ?? ""),
    url: String(view["url"] ?? ""),
    body: String(view["body"] ?? ""),
    state: String(view["state"] ?? ""),
    mergeStateStatus: String(view["mergeStateStatus"] ?? "UNKNOWN"),
    checks: checks.value,
    reviews: reviews.value,
    reviewRequests: reviewRequests.value,
    reviewThreads: reviewThreads.value,
    threadsTruncated: threadsField?.pageInfo?.hasNextPage === true,
  };
}
