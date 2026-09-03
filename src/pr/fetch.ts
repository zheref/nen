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
// REVIEW THREADS ARE PAGINATED TO COMPLETION (zheref/nen#14's fact-check,
// same false-green class ../github/pr_state.ts's fullCheckRollup() and
// fullReviewRequests() close). This module used to read `reviewThreads`'
// first(100) page alone and set a `threadsTruncated` flag when the page came
// back full -- but nextBlocker() (../pr/blocker.ts) only ever SURFACED that
// flag in its `detail` STRING, and only on the branch where the FIRST page
// already had an unresolved thread. A PR whose first 100 threads are all
// resolved but whose 101st+ thread is NOT fell straight through: `unresolved
// = []`, the truncation flag never inspected, and nextBlocker() carried on to
// the next conjunct as though zero unresolved threads were a confirmed fact
// -- a false-green verdict from a partial set, not merely a documented
// caveat, and invisible in `--json` (whose Blocker shape carries no
// truncation field at all). Fixed the same way ../github/pr_state.ts fixed
// the identical shape one layer down: fetchAllReviewThreads() below walks the
// cursor to completion -- ONLY the literal boolean `false` for `hasNextPage`
// ends the walk, so an unreadable `hasNextPage` (`undefined`, a stray
// string, anything else) is treated exactly like `true` and must produce a
// usable next page or fail closed. Every failure path -- an unreadable
// `hasNextPage`, a `nodes` that will not parse, a `hasNextPage`-not-`false`
// page with no usable cursor, hitting the page cap -- throws `FetchError`,
// which is this module's own existing fail-closed contract: a snapshot this
// process could not finish reading is never returned as though it were
// complete, so `nextBlocker()` never answers `none` (or any other verdict)
// from a review-thread set it did not read in full.
//
// EVERY `gh api` ARGV NAMES ITS METHOD EXPLICITLY (zheref/nen#19). gh's own
// documented rule -- https://cli.github.com/manual/gh_api, already cited by
// ../parse/izanami.ts for the identical reason -- is that the HTTP method
// flips from GET to POST the moment ANY `-f`/`-F` parameter is supplied.
// This module's reviews READ passed `-F per_page=100` with no method, so
// `gh api` POSTed to `pulls/{n}/reviews` -- the CREATE-review endpoint. The
// first call on a fresh PR silently left an empty PENDING draft review under
// the caller's identity, and every later call 422'd ("one pending review per
// user"), which is why the failure looked intermittent. A read verb that
// writes is the single worst defect class this CLI can have: under a frozen
// or third-party repository it is a policy violation the caller never
// intended, and every verb that composes this fetch (`pr next-blocker`)
// inherits the write. So the rule here is total, not minimal: no argv this
// module builds leaves the method to gh's parameter-driven inference --
// REST reads say `--method GET`, and the GraphQL calls say `--method POST`
// because GitHub's GraphQL transport accepts nothing else (the queries
// themselves are pure `query` operations; see REVIEW_THREADS_QUERY). The
// sweep test in ./fetch.test.ts holds this invariant over every exported
// argv builder with zero exceptions.

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
  // `--method GET`, EXPLICITLY, AND LOAD-BEARING (zheref/nen#19): without it,
  // the `-F per_page=100` below flips gh's inferred method to POST -- and
  // POST `pulls/{n}/reviews` is GitHub's CREATE-review endpoint. That turned
  // this read into a write: one empty PENDING draft review created under the
  // caller's identity on the first call, HTTP 422 ("one pending review per
  // user") on every call after it. Never remove the method to "simplify" the
  // argv; the parameter is exactly what makes it unsafe to omit. See the
  // module header for the whole incident, and ./fetch.test.ts's sweep test
  // for the invariant that pins it.
  //
  // Unpaginated on purpose, for a first cut: a review ROUND count over 100 on
  // one PR is itself the finding. A caller that hits this ceiling sees it in
  // `reviews.length === 100` and can say so; --paginate output is line-delimited
  // JSON pages rather than one array, which this module's single-parse shape
  // does not want to grow a second code path for yet.
  return ["api", "--method", "GET", `repos/${target.slug}/pulls/${prNumber}/reviews`, "-F", "per_page=100"];
}

const REVIEW_THREADS_QUERY =
  "query($owner:String!,$name:String!,$number:Int!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100){nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}";

// Page 2+, cursor-driven -- mirrors REVIEW_THREADS_QUERY's shape with an
// `after:$cursor` argument, the same pattern ../github/graphql.ts's
// CHECK_ROLLUP_PAGE_QUERY and REVIEW_REQUESTS_PAGE_QUERY use for the
// identical reason.
const REVIEW_THREADS_PAGE_QUERY =
  "query($owner:String!,$name:String!,$number:Int!,$cursor:String!){repository(owner:$owner,name:$name){pullRequest(number:$number){reviewThreads(first:100,after:$cursor){nodes{id isResolved} pageInfo{hasNextPage endCursor}}}}}";

// A runaway-loop backstop only, matching src/verbs/pr_ready.ts's own
// MAX_THREAD_PAGES default (50 pages = 5000 threads) -- large enough that a
// real PR never reaches it, small enough that a server which never reports
// `hasNextPage:false` cannot spin this walk forever.
const MAX_REVIEW_THREAD_PAGES = 50;

// `--method POST` on the two GraphQL argvs below is NOT a write declaration
// -- GitHub's GraphQL endpoint transports every operation, reads included,
// over POST and accepts nothing else, and both query strings above are pure
// `query` operations (no `mutation` token; the sweep test pins that too).
// The method is spelled out anyway so that NO argv this module builds relies
// on gh's "parameters present, therefore POST" inference -- the exact
// inference that turned reviewsArgv() into a write (zheref/nen#19, module
// header). An explicit method is a statement someone made a decision; an
// inferred one is a decision nobody made.
export function reviewThreadsArgv(target: Target, prNumber: number): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
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

export function reviewThreadsPageArgv(target: Target, prNumber: number, cursor: string): readonly string[] {
  return [
    "api",
    "--method",
    "POST",
    "graphql",
    "-f",
    `query=${REVIEW_THREADS_PAGE_QUERY}`,
    "-F",
    `owner=${target.owner}`,
    "-F",
    `name=${target.repo}`,
    "-F",
    `number=${prNumber}`,
    "-F",
    `cursor=${cursor}`,
  ];
}

function runOrThrow(seams: Seams, args: readonly string[], what: string): string {
  const result = seams.run(GH, [...args]);
  if (result.code !== 0) {
    throw new FetchError(`could not fetch ${what}: ${outputLines(result.stderr).join(" ") || `exit ${result.code}`}`);
  }
  return result.stdout;
}

interface ReviewThreadsPage {
  readonly nodes: unknown;
  readonly hasNextPage: unknown;
  readonly endCursor: unknown;
}

function parseThreadsPage(raw: string, what: string): ReviewThreadsPage {
  let parsed: {
    data?: {
      repository?: {
        pullRequest?: {
          reviewThreads?: { nodes?: unknown; pageInfo?: { hasNextPage?: unknown; endCursor?: unknown } };
        };
      };
    };
  };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch (error) {
    throw new FetchError(`${what}: gh api graphql did not return JSON (${String(error)})`);
  }
  const field = parsed.data?.repository?.pullRequest?.reviewThreads;
  return { nodes: field?.nodes, hasNextPage: field?.pageInfo?.hasNextPage, endCursor: field?.pageInfo?.endCursor };
}

/**
 * Walks `reviewThreads`' cursor across pages of 100 so a PR with MORE than
 * 100 review threads is read in full rather than silently truncated at page
 * one (zheref/nen#14's fact-check -- see this module's own header for the
 * false-green shape this closes).
 *
 * FAILS CLOSED, ALWAYS: ONLY the literal boolean `false` for `hasNextPage`
 * ends the walk. Every other outcome -- a thrown fetch, a page whose `nodes`
 * will not parse (via ../github/parse.ts's parseReviewThreads, never read by
 * hand), a page whose `hasNextPage` is not literally `false` but carries no
 * usable `endCursor`, or hitting MAX_REVIEW_THREAD_PAGES -- throws
 * `FetchError`, this module's own existing fail-closed contract. A page this
 * process could not confirm was the last one is exactly as untrustworthy as
 * one it never read, so this function never returns a partial thread list as
 * though it were the whole one.
 */
function fetchAllReviewThreads(
  seams: Seams,
  target: Target,
  prNumber: number,
  what: string,
  maxPages: number = MAX_REVIEW_THREAD_PAGES,
): ReviewThread[] {
  let page = parseThreadsPage(runOrThrow(seams, reviewThreadsArgv(target, prNumber), what), what);
  let allNodes: ReviewThread[] = [];
  for (let pageNum = 1; ; pageNum += 1) {
    const parsed = parseReviewThreads(page.nodes, `$.reviewThreads.nodes (page ${pageNum})`);
    if (!parsed.ok) {
      throw new FetchError(`${what}: ${parsed.error.path} -- ${parsed.error.message}`);
    }
    allNodes = allNodes.concat(parsed.value);
    if (page.hasNextPage === false) break;
    if (pageNum >= maxPages) {
      throw new FetchError(`${what}: hit the ${maxPages}-page pagination cap on review threads before hasNextPage went false`);
    }
    const cursor = page.endCursor;
    if (typeof cursor !== "string" || cursor === "") {
      throw new FetchError(
        `${what}: review threads page ${pageNum} did not answer hasNextPage:false but carried no usable cursor -- ` +
          "an unreadable hasNextPage must not be treated as the end of the walk",
      );
    }
    page = parseThreadsPage(runOrThrow(seams, reviewThreadsPageArgv(target, prNumber, cursor), what), what);
  }
  return allNodes;
}

export function fetchPullRequest(
  seams: Seams,
  target: Target,
  prNumber: number,
  options: { readonly maxReviewThreadPages?: number } = {},
): PrSnapshot {
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
  let reviewsJson: unknown;
  try {
    reviewsJson = JSON.parse(reviewsRaw === "" ? "[]" : reviewsRaw);
  } catch (error) {
    // Mirrors the `gh pr view` guard above: a truncated or non-JSON reviews
    // body is this module's named failure, never a raw SyntaxError escaping
    // to the operator with no repo/PR context attached.
    throw new FetchError(`${target.slug}#${prNumber} reviews: gh api did not return JSON (${String(error)})`);
  }
  // A LONE PENDING REVIEW ARRIVES AS A BARE OBJECT, NOT A ONE-ELEMENT ARRAY
  // (zheref/nen#19, observed in the field): when the only review on a PR is a
  // still-PENDING draft, GitHub's reviews endpoint has been seen answering
  // the single review object itself rather than `[review]`, and the schema
  // boundary then refused the whole snapshot with "$.reviews -- expected an
  // array, got object". The unusual SHAPE is real data about a real state, so
  // it is coerced -- object becomes [object] -- BEFORE validation, and only
  // the shape: every field of the wrapped review still goes through
  // parseReviews() unrelaxed, so a bare object that is NOT a review still
  // fails by name (at `$.reviews[0]...`) instead of slipping through. An
  // array (including []) passes untouched; this widens one documented
  // spelling, not the validation.
  const reviewsPayload =
    typeof reviewsJson === "object" && reviewsJson !== null && !Array.isArray(reviewsJson)
      ? [reviewsJson]
      : reviewsJson;
  const reviews = parseReviews(reviewsPayload);
  if (!reviews.ok) throw new FetchError(`${target.slug}#${prNumber}: ${reviews.error.path} -- ${reviews.error.message}`);

  const reviewThreads = fetchAllReviewThreads(
    seams,
    target,
    prNumber,
    `${target.slug}#${prNumber} review threads`,
    options.maxReviewThreadPages ?? MAX_REVIEW_THREAD_PAGES,
  );

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
    reviewThreads,
  };
}
