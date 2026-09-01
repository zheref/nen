// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/graphql.ts` (zheref/nen#1, Akatsuki migration P1).
//
// The header below this block is the ORIGINAL's, carried VERBATIM. It is not
// decoration: every WHY in it names a production incident, and a port that
// arrives without the explanation of why a branch exists is a port whose next
// maintainer "simplifies" it back into the bug (the BC-IS-#737 discipline).
// Only file PATHS have been rewritten, because this repository has no `cli/`
// subdirectory -- nen IS the CLI. References to bankai-core's own scripts,
// workflows and clause IDs are left alone: they are accurate statements about
// the system this code came from and where its reasoning is recorded.
// ============================================================================
// src/github/graphql.ts -- the ONE place GitHub's GraphQL WIRE SHAPE is
// known (BC-IS-#736, epic BC-IS-#733 Phase 1).
//
// WHY THIS FILE EXISTS. It is the seam BC-PR-#802's verification pass found
// broken. client.ts asked GraphQL for `labels(first:100) { nodes { name } }` --
// a connection OBJECT -- while ./parse.ts is written against gh's
// `pr view --json` shape, where `labels` is an ARRAY. Nothing bridged them, so
// the two halves of the domain core could not compose AT ALL:
//
//   parsePullRequest({ labels: { nodes: [{ name: "bankai:epic" }] }, ... })
//     -> { ok: false, error: { path: "$.labels",
//            message: "expected an array, got object (...)" } }
//
// and `reviewRequests` was worse than unparseable: the query returns
// `[{ requestedReviewer: { login } }]` while parseReviewRequest() reads
// `login`/`name` at the TOP level, AND no client method extracted the list at
// all. A ReviewRequest is the ONLY pre-post footprint a non-check reviewer has
// -- Copilot is not a check run, so a PENDING request is the whole of the
// evidence that a round is owed -- which makes that gap the exact regression
// bankai-core#564 was filed for and pendingRounds()' limb (i) exists to close.
//
// WHICH SIDE NORMALIZES: THIS ONE, at the TRANSPORT boundary. ./client.ts calls
// these functions and hands ./parse.ts a gh-shaped object; ./parse.ts never
// learns that connections exist and keeps parsing exactly the two documented
// shapes (gh camelCase, and the flattened snake_case state blob
// scripts/pr_ready_gate.sh's `fetch_pr_state` emits). The direction is chosen
// deliberately: the query TEXT lives here too, so a selection and the unwrapping
// that mirrors it sit in the same file and change in the same diff. Splitting
// them across two files is precisely the arrangement that let this seam ship
// broken and typecheck clean.
//
// THE NORMALIZERS NEVER INVENT A VALUE. A connection they RECOGNISE is
// unwrapped; anything else is passed through EXACTLY as GitHub sent it, so the
// unrecognised shape reaches ./parse.ts and is rejected there, loudly, with its
// path. Coalescing an unreadable `labels` connection into `[]` here would read
// as "no labels" -- the `//` failure class this module tree exists to remove
// (see ./parse.ts's header), reintroduced one layer lower where no test looks.

// --- path walking ------------------------------------------------------------

// Walk a path of object keys, yielding `undefined` for any step that is missing
// or not an object.
//
// Deliberately NOT a `//`-style default: it returns `undefined`, which every
// parser in ./parse.ts reports as "the field is absent" rather than silently
// treating as an empty result. GraphQL answers partial data with nulls along the
// path -- a permission the token lacks blanks one sub-field and leaves the rest
// intact -- so this must be able to say "nothing here" without inventing an
// empty array that would read as "no checks reported".
//
// It lives here rather than in ./client.ts because it is GraphQL-shape
// knowledge, not transport: partial-data nulls along a path are a property of
// the wire protocol, and this file is where that knowledge is allowed to be.
export function digPath(value: unknown, ...path: readonly string[]): unknown {
  let current: unknown = value;
  for (const key of path) {
    if (typeof current !== "object" || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === "object" && raw !== null && !Array.isArray(raw);
}

// GraphQL sends `null` and REST omits; no consumer here distinguishes them.
function isAbsent(value: unknown): boolean {
  return value === undefined || value === null;
}

// --- queries -----------------------------------------------------------------
//
// The selections and their normalizers are deliberately adjacent. Every `{ nodes
// { ... } }` below has a matching unwrap in this file, and adding a connection
// to a query without adding its unwrap is a one-file review finding rather than
// a cross-file one.
//
// `defaultBranchRef { name }` is selected and NOT carried into the normalized
// node, on purpose: PullRequest has no `defaultBranch` field yet, and inventing
// one here would be authoring model shape Phase 1 did not scope (BC-6). The
// obligation to extend the model is recorded where the model lives -- see the
// `is_delivery_pr` forward obligation in ./types.ts (BC-IS-#737).
//
// PAGINATION AUDIT (zheref/nen#14's fact-check, false-green defect on
// zheref/bankai-core#927): every `first:N` connection below was checked for
// the SAME defect the fix below closes on `contexts` -- a cap that silently
// truncates a set a VERDICT depends on.
//   - `labels(first:100)`: AUDITED, SAFE, left uncapped-in-practice on
//     purpose. ../gates/predicates.ts's isDeliveryPr() reads `state.labels`
//     only as `identities.delivery.labels.some(label => evidence.labels.
//     includes(label))`, OR'd with a headRef pattern -- a truncated labels
//     list can only make that disjunction MORE conservative (fall back to
//     the ordinary at-head rounds), never WIDER. Never the false-green
//     direction, so left as page-one-only.
//   - `reviewRequests(first:100)`: WAS flagged as a follow-up rather than
//     fixed, on the reasoning that GitHub's platform-level limit on
//     requestable reviewers makes truncation here "exceptionally unlikely."
//     THAT REASONING WAS ITSELF UNCITED AND UNTESTED (no linked doc, no
//     pinned test) -- exactly the shape of claim the `contexts` bug was found
//     by NOT trusting (zheref/nen#14's second fact-check, 2026-09-01) -- and
//     it feeds ../gates/predicates.ts's pendingRounds() limb (i) via
//     ../github/pr_state.ts's `requests` array, so a truncation here is the
//     identical false-green shape. A documentation search for a citable,
//     numbered platform limit at fact-check time turned up no authoritative
//     source to pin the assumption to, which settles the choice on its own:
//     PAGINATED NOW, to completion, with the identical fail-closed discipline
//     as `contexts` -- see REVIEW_REQUESTS_PAGE_QUERY and ../github/
//     pr_state.ts's `fullReviewRequests()`. This is deliberately NOT a
//     "trust the platform limit" pin: a coded, tested walk is a guarantee
//     that holds regardless of what GitHub's UI enforces this year, or
//     whether it enforces anything at all.
//   - `contexts(first:100)`: WAS the defect. Fixed below -- see
//     CHECK_ROLLUP_PAGE_QUERY and its own comment.
export const PULL_REQUEST_QUERY = `
  query($owner:String!, $name:String!, $pr:Int!) {
    repository(owner:$owner, name:$name) {
      defaultBranchRef { name }
      pullRequest(number:$pr) {
        number
        mergeable
        isDraft
        headRefOid
        headRefName
        baseRefName
        author { login }
        labels(first:100) { nodes { name } }
        reviewRequests(first:100) {
          nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } }
          pageInfo { hasNextPage endCursor }
        }
        statusCheckRollup: commits(last:1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first:100) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }
      }
    }
  }`;

// zheref/nen#14's fact-check on zheref/bankai-core#927 (independent
// verification pass, 2026-08-31): `contexts(first:100)` above NEVER
// PAGINATED. When observed that day, #927's rollup had totalCount 114 with
// hasNextPage true, and the ONLY failing entry ('sasuke / audit') sat beyond
// the first 100 -- so PULL_REQUEST_QUERY silently dropped it, ../github/
// pr_state.ts fed a TRUNCATED-but-all-green rollup to parseCheckRollup(), and
// the gate answered `ready` while scripts/pr_ready_gate.sh (whose `gh pr view
// --json statusCheckRollup` paginates this same connection internally,
// invisibly to the shell) answered `not-ready: required checks reported but
// are not all green (CON-32a)`. Deterministic across three runs of each
// side. (Re-observed 2026-09-01: the same PR's rollup had grown to
// totalCount 139, failing entry now at position 131 -- see docs/evidence/
// shadow-window-p1.md's "Update 3" section; the figure was never fixed, only
// the day it was read.) A cap that silently truncates a set a VERDICT depends
// on is a false-GREEN bug, not a completeness nicety -- CON-32(a)'s boundary
// is "every required check green", and a check this process never even saw
// cannot be weighed against it.
//
// THE FIX IS THIS QUERY (added `pageInfo`) PLUS THE WALK BELOW. Mirroring
// REVIEW_THREADS_QUERY's own shape deliberately: a `first:N` connection whose
// completeness a verdict depends on gets a cursor and a caller that walks it
// to `hasNextPage:false`, never a caller that reads page one and stops. See
// ../github/pr_state.ts's `fullCheckRollup` for the walk, and its own header
// for why every failure path there is `unevaluated`, never a partial `ready`.
export const CHECK_ROLLUP_PAGE_QUERY = `
  query($owner:String!, $name:String!, $pr:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$pr) {
        statusCheckRollup: commits(last:1) {
          nodes {
            commit {
              statusCheckRollup {
                contexts(first:100, after:$cursor) {
                  nodes {
                    __typename
                    ... on CheckRun { name status conclusion startedAt completedAt detailsUrl }
                    ... on StatusContext { context state targetUrl }
                  }
                  pageInfo { hasNextPage endCursor }
                }
              }
            }
          }
        }
      }
    }
  }`;

// The `reviewRequests` counterpart of CHECK_ROLLUP_PAGE_QUERY just above --
// see PULL_REQUEST_QUERY's own "PAGINATION AUDIT" comment for why this
// connection is now paginated too, and ../github/pr_state.ts's
// `fullReviewRequests` for the walk.
export const REVIEW_REQUESTS_PAGE_QUERY = `
  query($owner:String!, $name:String!, $pr:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$pr) {
        reviewRequests(first:100, after:$cursor) {
          nodes { requestedReviewer { ... on User { login } ... on Bot { login } ... on Team { name } } }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;

export const REVIEW_THREADS_QUERY = `
  query($owner:String!, $name:String!, $pr:Int!, $cursor:String) {
    repository(owner:$owner, name:$name) {
      pullRequest(number:$pr) {
        reviewThreads(first:100, after:$cursor) {
          nodes { id isResolved }
          pageInfo { hasNextPage endCursor }
        }
      }
    }
  }`;

// --- connection unwrapping ---------------------------------------------------

// `{ nodes: [...] }` -> `[...]`, and NOTHING else.
//
// The three non-unwrapping branches are each load-bearing:
//   - ABSENT/null passes through as itself, because ./parse.ts already gives
//     absence its documented meaning (`.labels // []` is "no labels", an absent
//     rollup is the empty array that is never green, bankai-core#671). Deciding
//     that here would move a documented reading out of the file that documents
//     it.
//   - An ALREADY-UNWRAPPED array passes through, which makes this idempotent:
//     the same normalizer can be pointed at a gh `pr view --json` payload or a
//     replay fixture without a second code path.
//   - Anything else -- `{ nodes: null }` from a partial-data response, a scalar,
//     a differently-named connection -- passes through UNCHANGED so ./parse.ts
//     rejects it by path. An unreadable connection is not an empty one.
function connectionNodes(value: unknown): unknown {
  if (isAbsent(value)) return value;
  const nodes = digPath(value, "nodes");
  return Array.isArray(nodes) ? nodes : value;
}

// `reviewRequests.nodes[].requestedReviewer` -> the reviewer object itself.
//
// parseReviewRequest() reads `login` (user/bot) or `name` (team) at the TOP
// level, matching gh's `pr view --json reviewRequests`; GraphQL wraps that same
// object one level deeper. Only the wrapper is removed -- the reviewer object is
// handed on untouched, so a `requestedReviewer: null` (a reviewer the token
// cannot resolve) reaches the parser as `null` and FAILS there rather than
// disappearing from the list. A request that silently vanishes is exactly how
// the gate read `ready` while Copilot still owed a round (bankai-core#564), so
// "unreadable" must never become "not requested".
function requestedReviewers(value: unknown): unknown {
  const nodes = connectionNodes(value);
  if (!Array.isArray(nodes)) return nodes;
  return nodes.map((node: unknown): unknown => {
    if (!isRecord(node)) return node;
    // Already gh-shaped (`{login}` / `{name}`, or a flattened login string):
    // leave it alone rather than wrapping-then-unwrapping.
    if (!("requestedReviewer" in node)) return node;
    return node["requestedReviewer"];
  });
}

// --- the normalized pull-request node ----------------------------------------

// The gh-shaped PR object ./parse.ts accepts, with every field typed `unknown`.
//
// `unknown` rather than a modelled type is the point: this names WHICH FIELDS
// EXIST -- so a caller reaching for `.labels` gets a compile-time field and a
// value it is forced to parse -- WITHOUT claiming anything about their contents
// that the API does not guarantee. Before this type, GitHubClient.pullRequest()
// returned bare `unknown` and the compiler could not see the client/parser
// mismatch at all; that blindness is why the seam shipped broken.
//
// Fields are copied EXPLICITLY, never spread. A query selection that reaches no
// field here is then a visible, reviewable omission rather than an accident --
// `defaultBranchRef` is the current, deliberate one (see PULL_REQUEST_QUERY).
export interface GhPullRequestNode {
  readonly number: unknown;
  readonly mergeable: unknown;
  readonly isDraft: unknown;
  readonly headRefOid: unknown;
  readonly headRefName: unknown;
  readonly baseRefName: unknown;
  readonly author: unknown;
  // Unwrapped from `labels(first:100) { nodes { name } }`.
  readonly labels: unknown;
  // Unwrapped from `reviewRequests(first:100) { nodes { requestedReviewer } }`.
  readonly reviewRequests: unknown;
}

// Everything one PULL_REQUEST_QUERY round trip yields, split into the three
// slices the domain core consumes. This is what makes ./client.ts's "one round
// trip serves all three" TRUE rather than merely claimed.
export interface PullRequestSnapshot {
  // `undefined` when the response carried no PR node at all (a 404 the API
  // answered as partial data, a permission that blanked it). parsePullRequest()
  // reports that as its own error rather than this file guessing.
  readonly pullRequest: GhPullRequestNode | undefined;
  // `defaultBranchRef.name`, a SIBLING of the pullRequest node rather than a
  // field of it -- which is why it is carried on the SNAPSHOT and not on
  // GhPullRequestNode.
  //
  // FORWARD OBLIGATION DISCHARGED (../github/types.ts, item 1: "#737 must carry
  // it through and add the field; nothing else needs to change on the wire").
  // The composition phase is the caller that finally needs it: CON-40's
  // delivery carve-out is `base is the DEFAULT branch`, and the shell READS the
  // trunk (`gh repo view --json defaultBranchRef`) rather than assuming `main`,
  // so a repository that renames its trunk is not silently mis-gated. The query
  // has selected it since Phase 1; only the normalizer dropped it.
  //
  // `undefined` rather than a guess when the response did not carry it. That
  // direction is the safe one: ../gates/predicates.ts's isDeliveryPr() requires
  // a NON-EMPTY default branch, so an unread trunk leaves the ordinary at-head
  // rounds binding instead of WIDENING the gate on absent evidence.
  readonly defaultBranch: string | undefined;
  // Raw `statusCheckRollup.contexts.nodes` of the HEAD commit, for
  // parseCheckRollup(). This is PAGE ONE ONLY -- see checkRollupPageInfo.
  readonly checkRollup: unknown;
  // `statusCheckRollup.contexts.pageInfo` of the HEAD commit's rollup. The
  // caller (../github/pr_state.ts's fetchPrState) MUST walk this to
  // `hasNextPage: false` with CHECK_ROLLUP_PAGE_QUERY before treating
  // `checkRollup` as the whole rollup -- reading page one alone is exactly the
  // false-green defect PULL_REQUEST_QUERY's own comment above documents.
  // `hasNextPage`/`endCursor` stay `unknown` rather than coerced, for the same
  // reason ReviewThreadPage's do: an unreadable `hasNextPage` must not become
  // `false` and end the walk early.
  readonly checkRollupPageInfo: {
    readonly hasNextPage: unknown;
    readonly endCursor: unknown;
  };
  // Raw gh-shaped review-request objects, for parseReviewRequests(). PAGE ONE
  // ONLY -- see reviewRequestsPageInfo, exactly the same relationship
  // checkRollup has to checkRollupPageInfo just above, and for the identical
  // reason (zheref/nen#14's second fact-check, PULL_REQUEST_QUERY's own
  // "PAGINATION AUDIT" comment above).
  readonly reviewRequests: unknown;
  // `reviewRequests.pageInfo` of the pull request. The caller (../github/
  // pr_state.ts's fetchPrState) MUST walk this to `hasNextPage: false` with
  // REVIEW_REQUESTS_PAGE_QUERY before treating `reviewRequests` as the whole
  // list -- reading page one alone is the identical false-green shape
  // `checkRollupPageInfo` exists to close on the rollup. `hasNextPage`/
  // `endCursor` stay `unknown` rather than coerced, for the same reason: an
  // unreadable `hasNextPage` must not become `false` and end the walk early.
  readonly reviewRequestsPageInfo: {
    readonly hasNextPage: unknown;
    readonly endCursor: unknown;
  };
}

// The head commit's rollup `contexts`, one PAGE at a time.
//
// `statusCheckRollup: commits(last:1)` asks for ONE commit, so the `commits`
// array holds at most one node -- but the LAST is taken rather than the
// first, deliberately: `last:N` returns the N most recent in ASCENDING
// order, so if the selection is ever widened the head commit stays the one
// read. Taking `[0]` would silently start judging readiness on the OLDEST
// commit in the window, and a rollup read off the wrong commit is a green
// verdict about work that is not at head.
//
// CORRECTION (zheref/nen#14's fact-check, shadow-window disagreement on
// zheref/akatsuki-ai#33): a non-array `commits` connection, or a missing/
// non-object head COMMIT, still yields the unreadable `{undefined,undefined,
// undefined}` page below -- the path genuinely could not be walked, which is
// unreadable in exactly the way ../github/pr_state.ts's fetch-time guard
// means it. But an otherwise-readable head commit whose OWN
// `commit.statusCheckRollup` field is the literal GraphQL value `null` is a
// DIFFERENT fact, and this file's own comment above it used to get that wrong:
// it claimed "manufacturing `[]` here would make 'the token could not read the
// checks' indistinguishable from 'no checks reported'" and treated the two as
// one case. Verified live against zheref/akatsuki-ai#33 (`gh api graphql` on
// that PR's head commit answers `commit: { statusCheckRollup: null }` for
// exactly the "no runs have ever attached to this commit" case) and against
// `gh pr view --json statusCheckRollup` on the SAME PR, which prints `[]`, not
// `null` -- `scripts/pr_ready_gate.sh`'s `fetch_pr_state` never even sees a
// null, because gh's own flattening has already reduced it to a readable empty
// array before the shell's `jq -e` guard runs. The oracle's `evaluate_ready`
// then reaches its `.checks // []` branch on genuinely EMPTY (not unreadable)
// evidence and answers "not-ready: NO checks reported at head (CON-32a)" --
// which is CON-32(a)'s own distinct, empty-rollup finding (bankai-core#671),
// never a refusal. This port's job is to reproduce THAT, not the read this
// comment previously assumed: a present-but-null `commit.statusCheckRollup` on
// an otherwise-resolvable head commit is the empty-rollup case and reads as
// `[]` with `hasNextPage: false` (nothing further to page); only a head
// commit this function cannot resolve at all stays unreadable, and
// unreadable is still what a genuinely unreadable connection (a partial-data
// blank higher up the path, or a non-object commit) yields.
//
// Shared by normalizePullRequestResponse() (PULL_REQUEST_QUERY's page one,
// nested three levels under the aliased `statusCheckRollup: commits(last:1)`
// field) AND normalizeCheckRollupPageResponse() (CHECK_ROLLUP_PAGE_QUERY,
// every page after it) -- both queries select the identical shape at the
// identical path, on purpose, so one normalizer serves both and a change to
// one query's selection that is not mirrored in the other is a shape neither
// can silently paper over.
function headCommitCheckRollupPage(response: unknown): CheckRollupPage {
  const commits = digPath(
    response,
    "repository",
    "pullRequest",
    "statusCheckRollup",
    "nodes",
  );
  if (!Array.isArray(commits)) {
    return { nodes: undefined, hasNextPage: undefined, endCursor: undefined };
  }
  const head: unknown = commits[commits.length - 1];
  const commit = digPath(head, "commit");
  if (!isRecord(commit)) {
    return { nodes: undefined, hasNextPage: undefined, endCursor: undefined };
  }
  // The commit resolved; its OWN rollup field is what GitHub answered.
  // `=== null` (as opposed to `undefined`, an absent key) is the wire's own
  // "no runs at all on this commit" signal, and it is a fact ABOUT the
  // commit, not a failure to read one -- and a commit with no rollup at all
  // has no `contexts` connection to page, so this is complete as read.
  if (commit["statusCheckRollup"] === null) {
    return { nodes: [], hasNextPage: false, endCursor: undefined };
  }
  return {
    nodes: digPath(commit, "statusCheckRollup", "contexts", "nodes"),
    hasNextPage: digPath(commit, "statusCheckRollup", "contexts", "pageInfo", "hasNextPage"),
    endCursor: digPath(commit, "statusCheckRollup", "contexts", "pageInfo", "endCursor"),
  };
}

// One CHECK_ROLLUP_PAGE_QUERY response -> its nodes and its cursor.
//
// ../github/pr_state.ts's `fullCheckRollup` walks this exactly as
// `unresolvedThreadCount` walks ReviewThreadPage: call, check `hasNextPage`,
// follow `endCursor`, and fail closed (never coerce an unreadable
// `hasNextPage` to `false`) rather than stop early and under-count.
export function normalizeCheckRollupPageResponse(response: unknown): CheckRollupPage {
  return headCommitCheckRollupPage(response);
}

function toGhPullRequestNode(raw: unknown): GhPullRequestNode | undefined {
  if (!isRecord(raw)) return undefined;
  return {
    number: raw["number"],
    mergeable: raw["mergeable"],
    isDraft: raw["isDraft"],
    headRefOid: raw["headRefOid"],
    headRefName: raw["headRefName"],
    baseRefName: raw["baseRefName"],
    // `author { login }` is ALREADY the shape parsePullRequest() reads
    // (`{login}` object or bare string), so it is carried across untouched.
    author: raw["author"],
    labels: connectionNodes(raw["labels"]),
    reviewRequests: requestedReviewers(raw["reviewRequests"]),
  };
}

// One PULL_REQUEST_QUERY response -> the three slices, gh-shaped.
export function normalizePullRequestResponse(
  response: unknown,
): PullRequestSnapshot {
  const node = toGhPullRequestNode(
    digPath(response, "repository", "pullRequest"),
  );
  const defaultBranch = digPath(response, "repository", "defaultBranchRef", "name");
  const rollupPage = headCommitCheckRollupPage(response);
  return {
    pullRequest: node,
    // A non-string (absent, null, or a partial-data blank) yields `undefined`,
    // never `""`: an empty string would reach isDeliveryPr() as evidence and be
    // refused there anyway, but `undefined` says "not read" at the boundary
    // where that is still distinguishable.
    defaultBranch: typeof defaultBranch === "string" ? defaultBranch : undefined,
    // PAGE ONE only -- unchanged in shape and value from before pagination
    // existed, so every pre-existing caller and test that reads
    // `snapshot.checkRollup` directly keeps its exact meaning. The caller MUST
    // consult checkRollupPageInfo before treating this as the whole rollup.
    checkRollup: rollupPage.nodes,
    checkRollupPageInfo: { hasNextPage: rollupPage.hasNextPage, endCursor: rollupPage.endCursor },
    // Read off the NORMALIZED node so the snapshot and the PR object can never
    // disagree about what was requested -- one unwrap, one answer.
    reviewRequests: node?.reviewRequests,
    // PAGE ONE only, dug independently of `node.reviewRequests` because that
    // field is already unwrapped to bare reviewer objects and no longer
    // carries its connection's `pageInfo`. The caller MUST consult this
    // before treating `reviewRequests` above as the whole list.
    reviewRequestsPageInfo: {
      hasNextPage: digPath(response, "repository", "pullRequest", "reviewRequests", "pageInfo", "hasNextPage"),
      endCursor: digPath(response, "repository", "pullRequest", "reviewRequests", "pageInfo", "endCursor"),
    },
  };
}

// --- check-rollup pages -------------------------------------------------------

// One page of the head commit's rollup `contexts` connection. Structurally
// identical to ReviewThreadPage -- deliberately: both are `first:100` GraphQL
// connections a readiness verdict depends on reading IN FULL, and both are
// walked by the identical cursor loop shape in ../github/pr_state.ts. A
// SEPARATE named type rather than a shared alias, because the two are not
// interchangeable at their call sites and a caller passing one where the
// other belongs should be a compile error, not a structural coincidence.
export interface CheckRollupPage {
  // Raw nodes, for parseCheckRollup() to validate once the walk is complete.
  readonly nodes: unknown;
  readonly hasNextPage: unknown;
  readonly endCursor: unknown;
}

// --- review-request pages -----------------------------------------------------

// One page of the `reviewRequests` connection. Structurally identical to
// CheckRollupPage/ReviewThreadPage, for the same reason: a `first:N`
// connection a verdict depends on reading in full, walked by the identical
// cursor loop shape in ../github/pr_state.ts (see `fullReviewRequests`).
export interface ReviewRequestsPage {
  // Raw reviewer objects, ALREADY unwrapped from `requestedReviewer` (see
  // requestedReviewers() below) -- the same post-unwrap shape
  // `PullRequestSnapshot.reviewRequests` carries for page one, so a caller
  // concatenating the two never has to know which page a node came from.
  readonly nodes: unknown;
  readonly hasNextPage: unknown;
  readonly endCursor: unknown;
}

// One REVIEW_REQUESTS_PAGE_QUERY response -> its nodes and its cursor.
//
// ../github/pr_state.ts's `fullReviewRequests` walks this exactly as
// `fullCheckRollup` walks CheckRollupPage: call, check `hasNextPage`, follow
// `endCursor`, and fail closed (never coerce an unreadable `hasNextPage` to
// `false`, and never end the walk on anything other than the literal boolean
// `false`) rather than stop early and under-count.
export function normalizeReviewRequestsPageResponse(response: unknown): ReviewRequestsPage {
  const connection = digPath(response, "repository", "pullRequest", "reviewRequests");
  return {
    nodes: requestedReviewers(connection),
    hasNextPage: digPath(connection, "pageInfo", "hasNextPage"),
    endCursor: digPath(connection, "pageInfo", "endCursor"),
  };
}

// --- review threads ----------------------------------------------------------

export interface ReviewThreadPage {
  // Raw nodes, for parseReviewThreads() to validate.
  readonly nodes: unknown;
  readonly hasNextPage: unknown;
  readonly endCursor: unknown;
}

// One REVIEW_THREADS_QUERY response -> its nodes and its cursor.
//
// The cursor fields stay `unknown` rather than being coerced: CON-32(d)'s
// boundary is "zero unresolved", a `hasNextPage` that could not be read must not
// become `false` (which would end the walk early and under-count threads), and
// what an unreadable page MEANS for readiness is a verdict the composition phase
// owns, not this file (bankai-core#568).
export function normalizeReviewThreadsResponse(
  response: unknown,
): ReviewThreadPage {
  const threads = digPath(response, "repository", "pullRequest", "reviewThreads");
  return {
    nodes: digPath(threads, "nodes"),
    hasNextPage: digPath(threads, "pageInfo", "hasNextPage"),
    endCursor: digPath(threads, "pageInfo", "endCursor"),
  };
}
