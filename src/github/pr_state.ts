// src/github/pr_state.ts -- the PR-state blob ../gates/ready.ts judges, read
// from GitHub (zheref/nen#2, Akatsuki migration P1).
//
// ADOPTED FROM bankai-core `cli/src/ports/pr_ready_gate.ts`'s layer 3
// (`fetch_pr_state`, `unresolved_thread_count`, `copilot_requested_at`). The
// WHYs below are that file's and the shell's, carried across per BC-IS-#737;
// what changed is the TRANSPORT, and the changes are enumerated rather than
// implied.
//
// ── WHY THE TRANSPORT CHANGED, AND WHAT THAT COSTS ──────────────────────────
//
// The original's ONE seam is a `gh` SUBPROCESS, and its header is emphatic that
// this is a harness constraint rather than a style choice: bankai-core#841's
// ledger intercepts `gh`/`git`/`curl` through a PATH shim, so a port speaking
// HTTP directly records nothing and every gh-backed case replays as "only 0 of N
// recorded subprocess call(s) were made".
//
// THAT LEDGER DOES NOT EXIST HERE, and the constraint it imposed does not come
// with it. Nen's D16 rule is the opposite one -- "a binary plus git and gh is
// the whole requirement", with no jq and no shell in an executed path -- and
// ./client.ts already carries an octokit client with an EXPLICIT token
// (tokenFromEnv), which is the property `gh` cannot offer: `gh` picks
// credentials up ambiently, so which identity a readiness read ran as becomes a
// property of the environment rather than of the code.
//
// WHAT IT COSTS, STATED UP FRONT. The shell's call ORDER is part of its
// contract, and this module cannot prove byte-identical `gh` invocations because
// it issues none. The evidence available to it is different and weaker in kind:
// the shadow window (docs/evidence/shadow-window-p1.md) compares VERDICTS
// against the live script on live pull requests. That is the bar §7 sets for P1,
// and it is why the shell stays CON-32's authority until it closes clean.
//
// ── THE FOUR TRANSPORT DIVERGENCES, EACH BOUNDED ────────────────────────────
//
// Every one of them can only ever produce not-ready or unevaluated, never
// `ready`, which is the property that makes them acceptable at all.
//
//  1. A BLANKED PR NODE IS `unevaluated`, NOT `not-ready: mergeable=`. The shell
//     writes `read -r mergeable head <<<"$(gh ...)"`, and `read`'s own status is
//     what `set -e` sees -- so a FAILING gh is silently tolerated, both values
//     end up empty, and the failure surfaces one predicate later as
//     `not-ready: mergeable= (expected MERGEABLE ...)`. A readiness gate that
//     reports "this PR conflicts" when the truth is "the token could not read
//     it" sends the reader to fix the wrong thing, and the pr-state skill's § 4
//     already has the right classification for it: `unevaluated`, never `ready`,
//     never silently omitted, with what would fix it.
//  2. THE GUARD BELOW STILL REFUSES ON `undefined`/`null` -- CORRECTED
//     (zheref/nen#14's fact-check) to refuse for the right reason. This
//     module's own comment used to claim `gh pr view --json statusCheckRollup
//     --jq '.statusCheckRollup'` "prints `null` for a PR whose rollup GitHub
//     answered as null", and that claim was never verified and is FALSE:
//     checked live against zheref/akatsuki-ai#33 (a head commit whose own
//     `statusCheckRollup` GraphQL field genuinely is `null` -- no runs have
//     ever attached to it), `gh pr view --json statusCheckRollup` prints `[]`,
//     not `null`. gh's own flattening already reduces a null-because-no-runs
//     commit rollup to a readable empty array before the shell's `jq -e`
//     guard ever runs, so `fetch_pr_state` succeeds and `evaluate_ready`
//     reaches its `.checks // []` branch on genuinely EMPTY evidence,
//     answering `not-ready: NO checks reported at head (CON-32a)`
//     (bankai-core#671) -- never a refusal. ../github/graphql.ts's
//     `headCommitCheckRollupPage` reproduces that same reduction now: a
//     present-but-null `commit.statusCheckRollup` on an otherwise-resolvable
//     head commit normalizes to `[]`, not `undefined`, so `snapshot.checkRollup`
//     reaching THIS guard as `undefined` means what it says -- the head commit
//     itself, or something above it in the path, could not be resolved at all
//     (a partial-data blank, a permission that truncated the selection). That
//     is the case with no shell-side counterpart to reproduce a specific
//     reason string for -- the shell's OWN `gh pr view --json statusCheckRollup`
//     failing outright is the nearest analogue, and its diagnostic is
//     "the token is very likely missing a required grant", which is exactly
//     the remedy below.
//  3. THE PAGINATION CAP AND THE NULL CURSOR COLLAPSE INTO ONE FALLBACK. The
//     shell, on `hasNextPage=true` with `endCursor: null`, keeps paginating with
//     the literal four-character cursor `null` until it hits MAX_THREAD_PAGES
//     and falls back to a count of 1; on an EMPTY endCursor it falls back
//     immediately. Both reach the same value, so this module falls back at once
//     in both cases. The VALUE is identical; only the number of round trips
//     differs, and there is no ledger here for that to matter to.
//  4. THE `mktemp -d` AND `native_path` BRANCHES HAVE NO COUNTERPART. They exist
//     because the shell must move multi-kilobyte blobs to `jq` through FILES
//     rather than argv (bankai-core#639/#695: Windows caps argv at 32,767 bytes
//     and a busy PR's statusCheckRollup clears that on its own). There is no jq
//     subprocess here, so the bug those branches guard is structurally absent
//     and the diagnostic has no counterpart. Carried from the original's own
//     "WHAT THIS PORT CANNOT REPRODUCE" section.
//
// NO VERDICTS LIVE HERE, including the conservative ones -- except the ONE the
// shell's own `unresolved_thread_count` makes, which is transcribed with its
// reasoning below because it is a COUNT, not a readiness call.

import { defaultReviewers, type RoundPolicy } from "../gates/predicates.js";
import { parseCheckRollup } from "./parse.js";
import type { GateIdentities, ReviewerIdentity } from "../schema/gates.js";
import {
  digPath,
  type CheckRollupPage,
  type PullRequestSnapshot,
  type ReviewRequestsPage,
  type ReviewThreadPage,
} from "./graphql.js";

export interface PrRef {
  readonly owner: string;
  readonly repo: string;
}

/**
 * The narrow slice of ./client.ts this module needs.
 *
 * A STRUCTURAL interface rather than the class, so the tests drive the assembly
 * with stubs and no test in this repository ever reaches GitHub. GitHubClient
 * satisfies it without declaring that it does.
 */
export interface PrStateSource {
  pullRequestSnapshot(repo: PrRef, prNumber: number): Promise<PullRequestSnapshot>;
  reviews(repo: PrRef, prNumber: number): Promise<unknown[]>;
  reviewThreadsPage(
    repo: PrRef,
    prNumber: number,
    cursor: string | null,
  ): Promise<ReviewThreadPage>;
  timeline(repo: PrRef, prNumber: number): Promise<unknown[]>;
  /**
   * Page 2+ of the head commit's check-rollup `contexts` connection.
   * `pullRequestSnapshot` above returns page ONE only -- see
   * PullRequestSnapshot.checkRollupPageInfo's own comment.
   */
  checkRollupPage(repo: PrRef, prNumber: number, cursor: string): Promise<CheckRollupPage>;
  /**
   * Page 2+ of the `reviewRequests` connection. `pullRequestSnapshot` above
   * returns page ONE only -- see PullRequestSnapshot.reviewRequestsPageInfo's
   * own comment.
   */
  reviewRequestsPage(repo: PrRef, prNumber: number, cursor: string): Promise<ReviewRequestsPage>;
}

export interface FetchStateOptions {
  readonly identities: GateIdentities;
  /** `--reviewers a,b,c`. EMPTY means "derive the set from the rollup". */
  readonly reviewersCsv: string;
  readonly policy: RoundPolicy;
  /** `--exclude-run`. EMPTY means no carve-out. */
  readonly excludeRun: string;
  readonly maxThreadPages: number;
  /**
   * The check-rollup counterpart of maxThreadPages -- a runaway-loop backstop
   * on fullCheckRollup()'s walk, not an operator-facing knob the shell has:
   * `gh pr view --json statusCheckRollup` paginates this connection INSIDE
   * gh's own client with no configurable cap exposed to the script, so there
   * is no `${...:-N}` default to mirror. 50 (5000 contexts) is chosen to
   * match maxThreadPages's own default for the same reason: large enough that
   * no real rollup should ever hit it, small enough that a server which never
   * reports `hasNextPage:false` cannot loop forever.
   */
  readonly maxRollupPages: number;
  /**
   * The `reviewRequests` counterpart of maxRollupPages -- same runaway-loop
   * backstop, same reasoning, on fullReviewRequests()'s walk (zheref/nen#14's
   * second fact-check: `reviewRequests(first:100)` is now paginated to
   * completion rather than left as an argued-safe cap; see ../github/
   * graphql.ts's PULL_REQUEST_QUERY comment). Defaulted the same as
   * maxRollupPages for the same reason, though in practice this walk should
   * rarely if ever leave page one.
   */
  readonly maxReviewRequestPages: number;
}

/**
 * `unevaluated` carries a REMEDY, always.
 *
 * The pr-state skill's § 4: "Say what would fix it -- a token scope, an auth, a
 * re-run -- so the reader can act rather than retry blindly." An unevaluated
 * with no remedy is a row that gets retried forever.
 */
export interface StateUnavailable {
  readonly ok: false;
  readonly reason: string;
  readonly remedy: string;
}

export interface StateFetched {
  readonly ok: true;
  readonly state: Record<string, unknown>;
  /** Non-fatal notes (the thread-page cap), for the renderer to surface. */
  readonly warnings: readonly string[];
}

export type FetchedState = StateFetched | StateUnavailable;

/**
 * `unresolved_thread_count REPO PR` -- walks reviewThreads' cursor across pages
 * of 100.
 *
 * WHY THE WALK EXISTS. CON-32(d)'s boundary is "zero unresolved". The single
 * `first(100)`-only query this replaced silently dropped threads 101+, letting
 * the gate declare READY with unresolved threads still open.
 *
 * EVERY failure path yields 1 -- not-ready -- and that is the same conservative
 * "can't confirm zero, so not zero" stance the single-page version took: a
 * failed request, a page whose threads will not parse, and a `hasNextPage=true`
 * page with no usable cursor.
 *
 * The cap itself (default 50 pages = 5000 threads) is purely a runaway-loop
 * backstop against a server that never reports `hasNextPage=false`; hitting it
 * also falls back to not-ready, WITH a warning, rather than returning the
 * partial count.
 */
export async function unresolvedThreadCount(
  source: PrStateSource,
  repo: PrRef,
  prNumber: number,
  maxThreadPages: number,
): Promise<{ readonly count: number; readonly warnings: readonly string[] }> {
  let cursor: string | null = null;
  let total = 0;
  for (let page = 1; ; page += 1) {
    if (page > maxThreadPages) {
      return {
        count: 1,
        warnings: [
          `unresolved_thread_count: hit the ${maxThreadPages}-page pagination cap on ` +
            `${repo.owner}/${repo.repo}#${prNumber} — count may be incomplete, falling back to not-ready.`,
        ],
      };
    }
    let answered: ReviewThreadPage;
    try {
      answered = await source.reviewThreadsPage(repo, prNumber, cursor);
    } catch {
      return { count: 1, warnings: [] };
    }
    // `.nodes[]?` tolerates a missing/non-array `nodes` and yields NOTHING, so
    // the count contribution is 0 -- distinct from a request that failed.
    // `isResolved` is compared to `false` EXPLICITLY: a thread whose resolution
    // could not be read is not counted as unresolved here, and is not counted as
    // resolved either, because the page-level fallbacks above already refuse to
    // confirm zero on a page this module could not establish.
    const nodes = answered.nodes;
    if (Array.isArray(nodes)) {
      total += nodes.filter((node): boolean => digPath(node, "isResolved") === false).length;
    }
    if (answered.hasNextPage !== true) break;
    const next = answered.endCursor;
    // Divergence 3 in the header: an empty or unreadable cursor with more pages
    // outstanding is "cannot confirm zero", exactly as it is in the shell -- by
    // a shorter route to the same value.
    if (typeof next !== "string" || next === "") return { count: 1, warnings: [] };
    cursor = next;
  }
  return { count: total, warnings: [] };
}

/**
 * Result of walking the head commit's check-rollup `contexts` connection to
 * completion. `ok:false` carries a remedy, exactly like StateUnavailable --
 * fetchPrState() returns this branch STRAIGHT THROUGH as its own `ok:false`.
 */
export type CheckRollupOutcome =
  | { readonly ok: true; readonly nodes: readonly unknown[] }
  | { readonly ok: false; readonly reason: string; readonly remedy: string };

/**
 * Walks `contexts`' cursor across pages of 100 so a rollup with MORE than 100
 * contexts is read in full rather than silently truncated at page one.
 *
 * WHY THE WALK EXISTS (zheref/nen#14's fact-check, verified live against
 * zheref/bankai-core#927). `contexts(first:100)` alone -- ../github/
 * graphql.ts's PULL_REQUEST_QUERY before this walk existed -- NEVER
 * PAGINATED. When observed on 2026-08-31, #927's rollup had totalCount 114
 * with hasNextPage true, with the one failing entry ('sasuke / audit')
 * sitting beyond the first 100: this process fed a truncated-but-all-green
 * rollup to parseCheckRollup() and answered `ready` while
 * scripts/pr_ready_gate.sh -- whose `gh pr view --json statusCheckRollup`
 * paginates the identical connection INSIDE gh's own client, invisibly to
 * the shell -- answered `not-ready: required checks reported but are not all
 * green (CON-32a)`. Deterministic across three runs of each side. (The same
 * PR's rollup is a live figure, not a fixed one: re-observed on 2026-09-01 it
 * had grown to totalCount 139, with the failing entry now at position 131 --
 * see docs/evidence/shadow-window-p1.md's "Update 3" section for both
 * readings, dated.) CON-32(a)'s boundary is "every required check green"; a
 * check this process never saw cannot be weighed against it, so reading only
 * page one is a FALSE-GREEN bug, not a completeness nicety.
 *
 * FAILS CLOSED, ALWAYS -- this is the property that makes it safe to compose
 * into a readiness gate at all. Every failure path below -- a thrown fetch, a
 * page whose `nodes` will not even parse as an array, a page whose
 * `hasNextPage` will not even parse as a boolean (zheref/nen#14's SECOND
 * fact-check below), a `hasNextPage:true` page with no usable cursor, or
 * hitting the page cap -- returns `ok:false`, which fetchPrState() surfaces
 * as `unevaluated`. NONE of them return the PARTIAL set collected so far as
 * though it were the whole rollup: a rollup this process could not finish
 * reading is exactly as untrustworthy as one it never started reading, and
 * treating a partial read as complete is the same defect this function
 * exists to close, wearing a different hat. Contrast
 * unresolvedThreadCount() just above, which fails toward `not-ready` (a count
 * of 1) on the SAME shapes of failure -- that is safe there because
 * CON-32(d)'s predicate is a simple non-zero test with no way to be
 * mistakenly green on a fabricated 1. checksAllGreen() has no such backstop:
 * a fabricated PARTIAL array of all-green entries reads as fully green, so
 * this function refuses to fabricate one at all.
 */
export async function fullCheckRollup(
  source: PrStateSource,
  repo: PrRef,
  prNumber: number,
  firstPageNodes: readonly unknown[],
  firstPageInfo: { readonly hasNextPage: unknown; readonly endCursor: unknown },
  maxRollupPages: number,
): Promise<CheckRollupOutcome> {
  let nodes: readonly unknown[] = firstPageNodes;
  let hasNextPage: unknown = firstPageInfo.hasNextPage;
  let cursor: unknown = firstPageInfo.endCursor;
  for (let page = 2; ; page += 1) {
    // FAIL-OPEN, CLOSED (zheref/nen#14's second fact-check, independent probe
    // against this exported function, 2026-09-01). The loop used to read as
    // `hasNextPage === true`, which is true ONLY for the boolean `true` --
    // every other value, including `false`, ended the walk. That is correct
    // for a genuine `false` (nothing more to page), but the SAME test also
    // fires on `undefined` (a page whose `contexts.nodes` parsed fine while
    // its `pageInfo.hasNextPage` did not -- a partial-data null a level
    // deeper than `nodes` itself) and on any other non-boolean GitHub might
    // one day answer (a stray string, a number): both silently ENDED THE WALK
    // and returned `ok:true` with whatever had been collected so far, which is
    // the identical false-green shape `Update 3`'s fix closed one layer down
    // -- a truncated rollup presented as the whole one. Proven live: an
    // independent probe against this exported function with a stubbed
    // `hasNextPage: undefined` returned `{"ok":true,"count":200}` where a
    // well-formed `hasNextPage: false` control returns the complete set.
    // ../github/graphql.ts's own comment on `PullRequestSnapshot.
    // checkRollupPageInfo` already stated the invariant this enforces --
    // "an unreadable `hasNextPage` must not become `false` and end the walk
    // early" -- the code just did not honor it. `false`, and ONLY `false`,
    // ends the walk; anything else -- including the entry call from
    // fetchPrState() below, which now hands this function every page-info it
    // receives rather than pre-filtering on `=== true` -- fails CLOSED here,
    // for the same reason a thrown fetch or an unparseable `nodes` does two
    // guards below: a rollup this process could not confirm complete is
    // exactly as untrustworthy as one it never started reading.
    if (hasNextPage === false) break;
    if (hasNextPage !== true) {
      return {
        ok: false,
        reason:
          `the check rollup for ${repo.owner}/${repo.repo}#${prNumber} reported an unreadable ` +
          `hasNextPage (${describeUnreadable(hasNextPage)}) instead of the boolean true or false`,
        remedy:
          "Retry the read; a well-formed page reports hasNextPage as a boolean, never undefined " +
          "or another type. Refusing to end the walk on an unreadable flag rather than treating " +
          "the contexts read so far as the complete set.",
      };
    }
    if (page > maxRollupPages) {
      return {
        ok: false,
        reason:
          `the check rollup for ${repo.owner}/${repo.repo}#${prNumber} hit the ` +
          `${maxRollupPages}-page pagination cap before hasNextPage went false`,
        remedy:
          "Raise maxRollupPages, or investigate why this PR's head commit reports so many " +
          "check-rollup contexts; refusing to evaluate readiness on a partial rollup rather than " +
          "treating the contexts read so far as the complete set.",
      };
    }
    // Divergence-3-shaped fallback (see this module's header): `hasNextPage`
    // true with an unreadable cursor means more contexts exist and cannot be
    // reached. Never treat the contexts already collected as the whole set.
    if (typeof cursor !== "string" || cursor === "") {
      return {
        ok: false,
        reason:
          `the check rollup for ${repo.owner}/${repo.repo}#${prNumber} reported more pages ` +
          "(hasNextPage=true) but no usable cursor",
        remedy: "Retry the read; a transient partial-data response can leave the cursor blank.",
      };
    }
    let answered: CheckRollupPage;
    try {
      answered = await source.checkRollupPage(repo, prNumber, cursor);
    } catch (error) {
      return {
        ok: false,
        reason:
          `fetching page ${page} of the check rollup for ${repo.owner}/${repo.repo}#${prNumber} ` +
          `failed: ${error instanceof Error ? error.message : String(error)}`,
        remedy:
          "Retry the read; the token is very likely missing a required grant. checks:read alone " +
          "is not enough: the rollup's own checkSuite.workflowRun sub-field needs actions:read too.",
      };
    }
    if (!Array.isArray(answered.nodes)) {
      return {
        ok: false,
        reason:
          `page ${page} of the check rollup for ${repo.owner}/${repo.repo}#${prNumber} came back ` +
          "unreadable (a non-array or missing `nodes`)",
        remedy:
          "Retry the read; the token is very likely missing a required grant. checks:read alone " +
          "is not enough: the rollup's own checkSuite.workflowRun sub-field needs actions:read too.",
      };
    }
    nodes = nodes.concat(answered.nodes);
    hasNextPage = answered.hasNextPage;
    cursor = answered.endCursor;
  }
  return { ok: true, nodes };
}

/** A short, safe-to-interpolate description of a value that failed a type check. */
function describeUnreadable(value: unknown): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  return `${typeof value} ${JSON.stringify(value)}`;
}

/**
 * Result of walking the `reviewRequests` connection to completion. `ok:false`
 * carries a remedy, exactly like CheckRollupOutcome -- fetchPrState() returns
 * this branch STRAIGHT THROUGH as its own `ok:false`.
 */
export type ReviewRequestsOutcome =
  | { readonly ok: true; readonly nodes: readonly unknown[] }
  | { readonly ok: false; readonly reason: string; readonly remedy: string };

/**
 * Walks `reviewRequests`' cursor across pages of 100, to completion, with the
 * SAME fail-closed discipline as fullCheckRollup() just above -- structurally
 * the identical function, against a different connection.
 *
 * WHY THE WALK EXISTS (zheref/nen#14's second fact-check, 2026-09-01).
 * `reviewRequests(first:100)` was the LAST unpaginated verdict input:
 * ../github/pr_state.ts's `requests` array feeds ../gates/predicates.ts's
 * pendingRounds() limb (i), so a dropped 101st+ requested reviewer would hide
 * a pending round -- structurally the identical false-green shape the
 * `contexts` bug was. The PRIOR disposition ("GitHub's platform-level limit
 * on requestable reviewers makes this safe") was itself asserted with no
 * citation and no test -- the exact failure mode this whole fact-check exists
 * to close, one layer up. Rather than re-assert a safety argument, this walks
 * the connection to completion, exactly like `contexts`.
 *
 * FAILS CLOSED, ALWAYS, for the identical reason fullCheckRollup() does:
 * pendingRounds() has no backstop against a fabricated PARTIAL request list
 * reading as "nobody is owed a round" -- an entry this process never saw
 * cannot be weighed, so a rollup -- sorry, a review-request list -- this
 * process could not finish reading is exactly as untrustworthy as one it
 * never started reading. See fullCheckRollup()'s own header for the full
 * shape of that argument; every failure path below mirrors it precisely,
 * including honoring `hasNextPage === false` as the ONLY value that ends the
 * walk (an unreadable or non-boolean `hasNextPage` fails closed rather than
 * being read as "done").
 */
export async function fullReviewRequests(
  source: PrStateSource,
  repo: PrRef,
  prNumber: number,
  firstPageNodes: readonly unknown[],
  firstPageInfo: { readonly hasNextPage: unknown; readonly endCursor: unknown },
  maxReviewRequestPages: number,
): Promise<ReviewRequestsOutcome> {
  let nodes: readonly unknown[] = firstPageNodes;
  let hasNextPage: unknown = firstPageInfo.hasNextPage;
  let cursor: unknown = firstPageInfo.endCursor;
  for (let page = 2; ; page += 1) {
    if (hasNextPage === false) break;
    if (hasNextPage !== true) {
      return {
        ok: false,
        reason:
          `the review requests for ${repo.owner}/${repo.repo}#${prNumber} reported an unreadable ` +
          `hasNextPage (${describeUnreadable(hasNextPage)}) instead of the boolean true or false`,
        remedy:
          "Retry the read; a well-formed page reports hasNextPage as a boolean, never undefined " +
          "or another type. Refusing to end the walk on an unreadable flag rather than treating " +
          "the requests read so far as the complete set.",
      };
    }
    if (page > maxReviewRequestPages) {
      return {
        ok: false,
        reason:
          `the review requests for ${repo.owner}/${repo.repo}#${prNumber} hit the ` +
          `${maxReviewRequestPages}-page pagination cap before hasNextPage went false`,
        remedy:
          "Raise maxReviewRequestPages, or investigate why this PR reports so many requested " +
          "reviewers; refusing to evaluate readiness on a partial list rather than treating the " +
          "requests read so far as the complete set.",
      };
    }
    if (typeof cursor !== "string" || cursor === "") {
      return {
        ok: false,
        reason:
          `the review requests for ${repo.owner}/${repo.repo}#${prNumber} reported more pages ` +
          "(hasNextPage=true) but no usable cursor",
        remedy: "Retry the read; a transient partial-data response can leave the cursor blank.",
      };
    }
    let answered: ReviewRequestsPage;
    try {
      answered = await source.reviewRequestsPage(repo, prNumber, cursor);
    } catch (error) {
      return {
        ok: false,
        reason:
          `fetching page ${page} of the review requests for ${repo.owner}/${repo.repo}#${prNumber} ` +
          `failed: ${error instanceof Error ? error.message : String(error)}`,
        remedy: "Retry the read; the token is very likely missing a required grant (pull-requests:read).",
      };
    }
    if (!Array.isArray(answered.nodes)) {
      return {
        ok: false,
        reason:
          `page ${page} of the review requests for ${repo.owner}/${repo.repo}#${prNumber} came back ` +
          "unreadable (a non-array or missing `nodes`)",
        remedy: "Retry the read; the token is very likely missing a required grant (pull-requests:read).",
      };
    }
    nodes = nodes.concat(answered.nodes);
    hasNextPage = answered.hasNextPage;
    cursor = answered.endCursor;
  }
  return { ok: true, nodes };
}

/**
 * The `created_at` of the LATEST `review_requested` timeline event naming a
 * given reviewer, or "".
 *
 * PORT CHANGE (§3): the original matches `/copilot/i`, a persona written into
 * the binary. The reviewer is now the caller's, and the match is that
 * reviewer's DECLARED login pattern -- which for a file whose reviewer names
 * equal their login patterns is the identical test.
 *
 * ANY failure yields "" (no stall verdict, still owed) -- never a guess, and
 * never an exception that would cost the caller its verdict.
 */
export async function requestedAt(
  source: PrStateSource,
  repo: PrRef,
  prNumber: number,
  loginPattern: RegExp,
): Promise<string> {
  let events: unknown[];
  try {
    events = await source.timeline(repo, prNumber);
  } catch {
    return "";
  }
  const matching = events.filter((event): boolean => {
    if (digPath(event, "event") !== "review_requested") return false;
    const login = digPath(event, "requested_reviewer", "login");
    return loginPattern.test(typeof login === "string" ? login : "");
  });
  if (matching.length === 0) return "";
  // `sort_by(.created_at) | last` -- a stable sort by the raw value, then the
  // last. An absent created_at sorts first, as jq's null does.
  const sorted = [...matching].sort((a, b): number => {
    const left = timestampOf(a);
    const right = timestampOf(b);
    return left < right ? -1 : left > right ? 1 : 0;
  });
  const created = digPath(sorted[sorted.length - 1], "created_at");
  // `.created_at // empty` -- absent yields nothing at all, i.e. "".
  return typeof created === "string" && created !== "" ? created : "";
}

function timestampOf(event: unknown): string {
  const value = digPath(event, "created_at");
  return typeof value === "string" ? value : "";
}

/** `(.login // .name // "")` -- gh's own flattening of a review request. */
function requestLogin(entry: unknown): string {
  if (typeof entry === "string") return entry;
  const login = digPath(entry, "login");
  if (typeof login === "string" && login !== "") return login;
  const name = digPath(entry, "name");
  if (typeof name === "string" && name !== "") return name;
  return "";
}

/**
 * `fetch_pr_state REPO PR [REVIEWERS] [POLICY] [EXCLUDE_RUN]`, over octokit.
 *
 * Assembles exactly the shape ../gates/ready.ts's `evaluateReady` reads, with
 * the two persona-named fields renamed per §3 (`copilot_policy` ->
 * `round_policy`, `copilot_requested_at` -> `stall_requested_at`); the rename is
 * recorded in that module's header.
 *
 * THE TOKEN NEEDS pull-requests:read AND checks:read AND actions:read. The
 * missing `checks:read` grant is exactly what broke every sweeper tick before
 * bankai-core#570, and `checks:read` ALONE is still not enough:
 * statusCheckRollup's own `checkSuite.workflowRun` sub-field needs
 * `actions:read` too (bankai-core#636). Both failure shapes are caught below and
 * named.
 */
export async function fetchPrState(
  source: PrStateSource,
  repo: PrRef,
  prNumber: number,
  options: FetchStateOptions,
): Promise<FetchedState> {
  const snapshot = await source.pullRequestSnapshot(repo, prNumber);
  const node = snapshot.pullRequest;
  if (node === undefined) {
    // Divergence 1 in the header. The response carried no pull-request node at
    // all: a 404 the API answered as partial data, or a permission that blanked
    // it. Never `not-ready`, because it is not a fact about the pull request.
    return {
      ok: false,
      reason: `the response carried no pull request for ${repo.owner}/${repo.repo}#${prNumber}`,
      remedy:
        "Check the number names a pull request in that repository, and that the token can read " +
        "it (a private repository read without pull-requests:read answers 404, which is " +
        "indistinguishable from a deleted PR).",
    };
  }

  // Divergence 2 in the header, CORRECTED. `snapshot.checkRollup` reaching
  // here as `undefined` no longer includes "the head commit's own rollup is
  // null" -- ../github/graphql.ts's headCommitCheckRollupPage() now reduces
  // that case to `[]`, matching gh's own flattening, so it never arrives here
  // at all. Only a head commit (or something above it) that this process
  // could not resolve reaches this branch, which is the SAME
  // missing-permission signature `gh pr view --json statusCheckRollup`
  // itself fails loudly on. Refuse rather than evaluate readiness on it -- an
  // empty rollup and an unread one are different facts, and only one of them
  // is a finding about the pull request.
  if (snapshot.checkRollup === undefined || snapshot.checkRollup === null) {
    return {
      ok: false,
      reason: `the check rollup could not be read for ${repo.owner}/${repo.repo}#${prNumber}`,
      remedy:
        "The token is very likely missing a required grant. checks:read alone is not enough: the " +
        "rollup's own checkSuite.workflowRun sub-field needs actions:read too. Refusing to judge " +
        "readiness on unreadable checks data rather than reporting an EMPTY rollup, which is a " +
        "different finding with a different remedy.",
    };
  }

  // FALSE-GREEN DEFECT, FIXED (zheref/nen#14's fact-check on
  // zheref/bankai-core#927). `snapshot.checkRollup` is PAGE ONE ONLY --
  // `contexts(first:100)` with no cursor, capped at exactly the 100 entries
  // GitHub answers first. Reading it alone here is what used to let a
  // rollup's 101st-and-beyond entries (any of which may be the one FAILING
  // context) go completely unweighed: when observed on 2026-08-31, #927's
  // rollup had totalCount 114 with hasNextPage true, and the only failing
  // entry ('sasuke / audit') sat at position 101+, so this process answered
  // `ready` on a truncated, all-green-so-far view while
  // scripts/pr_ready_gate.sh -- whose `gh pr view --json statusCheckRollup`
  // paginates the identical connection inside gh's own client -- answered
  // `not-ready: required checks reported but are not all green (CON-32a)`.
  // checksAllGreen() has no backstop against a fabricated partial array
  // reading as fully green, so the walk below MUST complete before
  // parseCheckRollup() ever sees this data, and MUST fail closed (this whole
  // function returning `unevaluated`, never a partial `ready`) if it cannot.
  //
  // THE GUARD BELOW READS `!== false`, NOT `=== true` (zheref/nen#14's SECOND
  // fact-check, independent probe against the real exported fullCheckRollup(),
  // 2026-09-01). `=== true` used to mean an unreadable or non-boolean
  // `hasNextPage` -- `undefined` (a page whose `contexts.nodes` parsed but
  // whose `pageInfo.hasNextPage` did not), or any other non-boolean value --
  // skipped the walk ENTIRELY, silently treating page one as the whole
  // rollup: the identical false-green shape this whole block exists to close,
  // one call earlier. `false`, and only `false`, is now the one value that
  // skips the walk; every other value -- including `true`, unchanged -- is
  // handed to fullCheckRollup(), whose own first check (see its header) is
  // exactly this same `hasNextPage === false` / `!== true` distinction, so an
  // unreadable flag fails CLOSED there rather than being read as "done" here.
  let checkRollupNodes: readonly unknown[] = Array.isArray(snapshot.checkRollup)
    ? snapshot.checkRollup
    : [];
  if (snapshot.checkRollupPageInfo.hasNextPage !== false) {
    const full = await fullCheckRollup(
      source,
      repo,
      prNumber,
      checkRollupNodes,
      snapshot.checkRollupPageInfo,
      options.maxRollupPages,
    );
    if (!full.ok) {
      return { ok: false, reason: full.reason, remedy: full.remedy };
    }
    checkRollupNodes = full.nodes;
  }

  const mergeable = typeof node.mergeable === "string" ? node.mergeable : "";
  const head = typeof node.headRefOid === "string" ? node.headRefOid : "";

  // Reviews over REST, flattened to the gate's own shape. REST throughout,
  // because `commit_id` is the field CON-16's current-head rule turns on and the
  // GraphQL-backed `pr view --json reviews` does not expose it.
  let reviews: unknown[] = [];
  try {
    reviews = (await source.reviews(repo, prNumber)).map(
      (review): Record<string, unknown> => ({
        author: digPath(review, "user", "login") ?? null,
        state: digPath(review, "state") ?? null,
        commit_id: digPath(review, "commit_id") ?? null,
        submitted_at: digPath(review, "submitted_at") ?? null,
      }),
    );
  } catch {
    // `|| reviews='[]'` -- the shell's own degradation. An unreadable review
    // list is NOT an approval and NOT a round at head, so every reviewer stays
    // owed and the gate stays shut.
    reviews = [];
  }

  // THE LAST UNPAGINATED VERDICT INPUT, CLOSED (zheref/nen#14's second
  // fact-check, 2026-09-01). `snapshot.reviewRequests` is PAGE ONE ONLY --
  // `reviewRequests(first:100)` with no cursor -- and it feeds
  // pendingRounds() limb (i) via `requests` below, so a truncated 101st+
  // entry is the identical false-green shape the check-rollup pagination
  // above closes; see ../github/graphql.ts's PULL_REQUEST_QUERY comment for
  // why the prior "GitHub limits this" disposition was corrected rather than
  // kept. Same guard shape as checkRollupPageInfo just above: `!== false`,
  // never `=== true`, so an unreadable/non-boolean hasNextPage is handed to
  // fullReviewRequests() to fail CLOSED rather than being read as "done"
  // here.
  let reviewRequestNodes: readonly unknown[] = Array.isArray(snapshot.reviewRequests)
    ? snapshot.reviewRequests
    : [];
  if (snapshot.reviewRequestsPageInfo.hasNextPage !== false) {
    const full = await fullReviewRequests(
      source,
      repo,
      prNumber,
      reviewRequestNodes,
      snapshot.reviewRequestsPageInfo,
      options.maxReviewRequestPages,
    );
    if (!full.ok) {
      return { ok: false, reason: full.reason, remedy: full.remedy };
    }
    reviewRequestNodes = full.nodes;
  }

  // The PENDING review requests, flattened to bare logins exactly as
  // `fetch_pr_state` does. A request naming NOBODY stays in the list as "" --
  // transcribed, because dropping it here would silently remove the only
  // pre-post footprint an un-posted round has (bankai-core#564), and because
  // ./parse.ts is the layer that gets to call an unnamed request unreadable.
  const requests: string[] = reviewRequestNodes.map(requestLogin);

  const threads = await unresolvedThreadCount(source, repo, prNumber, options.maxThreadPages);

  // The reviewer set, resolved from the rollup only when the caller named none.
  // Reads the FULLY PAGINATED rollup, never `snapshot.checkRollup` (page one
  // alone) -- see the pagination block above.
  const parsedChecks = parseCheckRollup(checkRollupNodes, "$.checks");
  const reviewers =
    options.reviewersCsv !== ""
      ? options.reviewersCsv
      : // `|| checks='[]'` -- the shell degrades an unreducible rollup to the
        // base set rather than failing the fetch.
        defaultReviewers(options.identities, parsedChecks.ok ? parsedChecks.value : []).join(",");

  // The stall timestamp, ONLY when a request for the reviewer the stall bound
  // applies to is actually pending. No pending request means no bound to
  // compute and no timeline call to make.
  //
  // PORT CHANGE (§3): "the reviewer the bound applies to" is the file's
  // `bounded_policy_exempt` one -- the reviewer nothing re-requests after a
  // final push, which is precisely the reviewer a pending request can go stale
  // on. The original tested `/copilot/i`.
  let stallRequestedAt = "";
  const exempt: ReviewerIdentity | undefined = options.identities.reviewers.find(
    (reviewer): boolean =>
      reviewer.boundedPolicyExempt &&
      requests.some((login): boolean => reviewer.loginPattern.test(login)),
  );
  if (exempt !== undefined) {
    stallRequestedAt = await requestedAt(source, repo, prNumber, exempt.loginPattern);
  }

  return {
    ok: true,
    warnings: threads.warnings,
    state: {
      mergeable,
      head_sha: head,
      // The FULLY PAGINATED rollup -- see the pagination block above. Never
      // `snapshot.checkRollup`, which is page one only.
      checks: checkRollupNodes,
      reviews,
      review_requests: requests,
      unresolved_threads: threads.count,
      reviewers,
      round_policy: options.policy,
      stall_requested_at: stallRequestedAt === "" ? null : stallRequestedAt,
      exclude_run_id: options.excludeRun === "" ? null : options.excludeRun,
      // The CON-40 delivery evidence. EVERY absent field reads as "not a
      // delivery PR" rather than as unreadable -- isDeliveryPr() requires
      // author, base_ref and default_branch NON-EMPTY -- so a degraded read
      // falls back to the ordinary at-head rounds rather than to a wider gate.
      author: authorLogin(node.author),
      base_ref: typeof node.baseRefName === "string" ? node.baseRefName : "",
      head_ref: typeof node.headRefName === "string" ? node.headRefName : "",
      labels: labelNames(node.labels),
      // READ, never assumed to be the conventional trunk name, so a repository
      // that renames its default branch is not silently mis-gated.
      default_branch: snapshot.defaultBranch ?? "",
    },
  };
}

/** `(.author.login // "")`, tolerating gh's bare-string spelling. */
function authorLogin(raw: unknown): string {
  if (typeof raw === "string") return raw;
  const login = digPath(raw, "login");
  return typeof login === "string" ? login : "";
}

/** `[.labels[].name]`, tolerating the already-flattened spelling. */
function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((label): string => {
    if (typeof label === "string") return label;
    const name = digPath(label, "name");
    return typeof name === "string" ? name : "";
  });
}
