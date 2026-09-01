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
                }
              }
            }
          }
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
  // parseCheckRollup().
  readonly checkRollup: unknown;
  // Raw gh-shaped review-request objects, for parseReviewRequests().
  readonly reviewRequests: unknown;
}

// The head commit's rollup contexts.
//
// `statusCheckRollup: commits(last:1)` asks for ONE commit, so this array holds
// at most one node -- but the LAST is taken rather than the first, deliberately:
// `last:N` returns the N most recent in ASCENDING order, so if the selection is
// ever widened the head commit stays the one read. Taking `[0]` would silently
// start judging readiness on the OLDEST commit in the window, and a rollup read
// off the wrong commit is a green verdict about work that is not at head.
//
// A non-array (absent, null, or a partial-data blank) yields `undefined`, NOT
// `[]`. parseCheckRollup() turns `undefined` into the empty array that is never
// green (bankai-core#671); manufacturing `[]` here would make "the token could
// not read the checks" indistinguishable from "no checks reported".
function headCommitRollupContexts(response: unknown): unknown {
  const commits = digPath(
    response,
    "repository",
    "pullRequest",
    "statusCheckRollup",
    "nodes",
  );
  if (!Array.isArray(commits)) return undefined;
  const head: unknown = commits[commits.length - 1];
  return digPath(head, "commit", "statusCheckRollup", "contexts", "nodes");
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
  return {
    pullRequest: node,
    // A non-string (absent, null, or a partial-data blank) yields `undefined`,
    // never `""`: an empty string would reach isDeliveryPr() as evidence and be
    // refused there anyway, but `undefined` says "not read" at the boundary
    // where that is still distinguishable.
    defaultBranch: typeof defaultBranch === "string" ? defaultBranch : undefined,
    checkRollup: headCommitRollupContexts(response),
    // Read off the NORMALIZED node so the snapshot and the PR object can never
    // disagree about what was requested -- one unwrap, one answer.
    reviewRequests: node?.reviewRequests,
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
