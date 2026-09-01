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
//     `headCommitRollupContexts` reproduces that same reduction now: a
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
import { digPath, type PullRequestSnapshot, type ReviewThreadPage } from "./graphql.js";

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
}

export interface FetchStateOptions {
  readonly identities: GateIdentities;
  /** `--reviewers a,b,c`. EMPTY means "derive the set from the rollup". */
  readonly reviewersCsv: string;
  readonly policy: RoundPolicy;
  /** `--exclude-run`. EMPTY means no carve-out. */
  readonly excludeRun: string;
  readonly maxThreadPages: number;
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
  // null" -- ../github/graphql.ts's headCommitRollupContexts() now reduces
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

  // The PENDING review requests, flattened to bare logins exactly as
  // `fetch_pr_state` does. A request naming NOBODY stays in the list as "" --
  // transcribed, because dropping it here would silently remove the only
  // pre-post footprint an un-posted round has (bankai-core#564), and because
  // ./parse.ts is the layer that gets to call an unnamed request unreadable.
  const rawRequests = snapshot.reviewRequests;
  const requests: string[] = Array.isArray(rawRequests) ? rawRequests.map(requestLogin) : [];

  const threads = await unresolvedThreadCount(source, repo, prNumber, options.maxThreadPages);

  // The reviewer set, resolved from the rollup only when the caller named none.
  const parsedChecks = parseCheckRollup(snapshot.checkRollup, "$.checks");
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
      checks: snapshot.checkRollup,
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
