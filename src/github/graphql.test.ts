// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/graphql.test.ts` (zheref/nen#1, Akatsuki migration P1).
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
// Tests for the GraphQL wire-shape layer (BC-IS-#736, epic BC-IS-#733 Phase 1).
//
// THIS FILE IS THE ONE THAT WOULD HAVE CAUGHT THE BUG (BC-PR-#802
// verification). parse.test.ts tested the parser against gh-shaped input and
// passed; client.test.ts tested the token reader and passed; NOTHING tested
// client-output -> parser-input, so the two halves of the domain core could not
// compose and both suites stayed green. The COMPOSITION section below drives a
// realistic PULL_REQUEST_QUERY response all the way through to typed models and
// then into a CON-32 predicate, which is the only shape of test that can fail
// when a query selection and a parser disagree.

import { describe, expect, it } from "vitest";
import {
  digPath,
  normalizePullRequestResponse,
  normalizeReviewThreadsResponse,
} from "./graphql.js";
import {
  parseCheckRollup,
  parsePullRequest,
  parseReviewRequests,
  parseReviewThreads,
} from "./parse.js";
import { pendingRounds } from "../gates/predicates.js";
import type { ReviewRequest, RollupEntry } from "./types.js";
// PORT ADDITION (zheref/nen#1): the predicates are parameterised by identities
// read from the target repository, so the composition case below needs a
// repository to read them from.
import { loadGateIdentities } from "../schema/gates.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";

const IDENTITIES = loadGateIdentities(BANKAI_REPO);

// A response with exactly PULL_REQUEST_QUERY's selections, in exactly the shape
// GitHub answers them: every connection is a `{ nodes: [...] }` OBJECT, and each
// review request wraps its reviewer in `requestedReviewer`. Written by hand
// against the query text rather than captured, so that a change to the query
// which is not mirrored in the normalizer shows up here as a failure.
function queryResponse(): unknown {
  return {
    repository: {
      defaultBranchRef: { name: "main" },
      pullRequest: {
        number: 802,
        mergeable: "MERGEABLE",
        isDraft: false,
        headRefOid: "d4f0a1cf401a39",
        headRefName: "ichigo/736-domain-core",
        baseRefName: "main",
        author: { login: "roy-bankai" },
        labels: { nodes: [{ name: "bankai:epic" }, { name: "kind:machinery" }] },
        reviewRequests: {
          nodes: [
            { requestedReviewer: { login: "Copilot" } },
            { requestedReviewer: { name: "bankai-reviewers" } },
          ],
        },
        statusCheckRollup: {
          nodes: [
            {
              commit: {
                statusCheckRollup: {
                  contexts: {
                    nodes: [
                      {
                        __typename: "CheckRun",
                        name: "sasuke / audit",
                        status: "COMPLETED",
                        conclusion: "SUCCESS",
                        startedAt: "2026-08-26T02:00:00Z",
                        completedAt: "2026-08-26T02:04:00Z",
                        detailsUrl:
                          "https://github.com/zheref/bankai-core/actions/runs/111/job/222",
                      },
                      {
                        __typename: "StatusContext",
                        context: "ci/external",
                        state: "SUCCESS",
                        targetUrl: "https://ci.invalid/build/9",
                      },
                    ],
                  },
                },
              },
            },
          ],
        },
      },
    },
  };
}

// The PR node as the query returns it, un-normalized -- i.e. what the client
// used to hand the parser.
function rawPullRequestNode(): unknown {
  return digPath(queryResponse(), "repository", "pullRequest");
}

describe("digPath", () => {
  it("walks a path of object keys", () => {
    expect(
      digPath({ repository: { pullRequest: { number: 736 } } }, "repository", "pullRequest"),
    ).toEqual({ number: 736 });
  });

  it("returns the value itself for an empty path", () => {
    expect(digPath({ a: 1 })).toEqual({ a: 1 });
  });

  it("yields undefined -- never an empty object or array -- for a missing step", () => {
    // GraphQL blanks a sub-field the token cannot read and leaves the rest
    // intact. Inventing `[]` here would turn a missing permission into "no
    // checks reported at head", which is a different finding with a different
    // remedy (bankai-core#671/#636).
    expect(digPath({ repository: {} }, "repository", "pullRequest", "number")).toBeUndefined();
  });

  it("yields undefined when a step is null, a scalar, or an array", () => {
    expect(digPath({ repository: null }, "repository", "pullRequest")).toBeUndefined();
    expect(digPath({ repository: 7 }, "repository", "pullRequest")).toBeUndefined();
    expect(digPath({ repository: [] }, "repository", "pullRequest")).toBeUndefined();
  });

  it("preserves an explicit null at the END of the path -- `statusCheckRollup: null` is a real answer, not a missing one", () => {
    expect(digPath({ commit: { statusCheckRollup: null } }, "commit", "statusCheckRollup")).toBeNull();
  });
});

// --- the defect this layer exists to close -----------------------------------

describe("the client/parser seam (BC-PR-#802 verification)", () => {
  it("the RAW query node is unparseable -- `labels` is a connection object, and the parser wants an array", () => {
    // Pinned as a test rather than described in a comment, because it is the
    // entire reason ./graphql.ts exists. If GitHub ever starts answering a bare
    // array here, this goes green and the normalizer's unwrap becomes a no-op
    // that someone should then delete on purpose.
    const result = parsePullRequest(rawPullRequestNode());

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.path).toBe("$.labels");
      expect(result.error.message).toContain("expected an array");
    }
  });

  it("... and normalizing it first makes it parse", () => {
    const snapshot = normalizePullRequestResponse(queryResponse());
    const result = parsePullRequest(snapshot.pullRequest);

    expect(result.ok).toBe(true);
  });
});

// --- composition: query response -> normalizer -> parser -> typed model ------

describe("COMPOSITION: a PULL_REQUEST_QUERY response driven to typed models", () => {
  it("yields a PullRequest with its labels unwrapped from the connection", () => {
    const snapshot = normalizePullRequestResponse(queryResponse());
    const result = parsePullRequest(snapshot.pullRequest);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual({
      number: 802,
      headSha: "d4f0a1cf401a39",
      baseRef: "main",
      headRef: "ichigo/736-domain-core",
      author: "roy-bankai",
      labels: ["bankai:epic", "kind:machinery"],
      mergeable: "MERGEABLE",
      isDraft: false,
    });
  });

  it("yields ReviewRequests with `requestedReviewer` unwrapped -- a login for a user/bot, a name for a team", () => {
    // The list #564 is about. Before this layer nothing extracted it at all, so
    // the ONLY pre-post footprint a non-check reviewer has could not reach the
    // gate.
    const snapshot = normalizePullRequestResponse(queryResponse());
    const result = parseReviewRequests(snapshot.reviewRequests);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { login: "Copilot", name: null },
      { login: null, name: "bankai-reviewers" },
    ]);
  });

  it("yields both rollup kinds off the head commit, discriminated", () => {
    const snapshot = normalizePullRequestResponse(queryResponse());
    const result = parseCheckRollup(snapshot.checkRollup);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((entry: RollupEntry): string => entry.kind)).toEqual([
      "check_run",
      "status_context",
    ]);
    expect(result.value[0]).toMatchObject({
      kind: "check_run",
      name: "sasuke / audit",
      conclusion: "SUCCESS",
    });
    expect(result.value[1]).toMatchObject({
      kind: "status_context",
      context: "ci/external",
      state: "SUCCESS",
      // Never selected by the query for a StatusContext, so absent -- and
      // absent parses to null rather than to a timestamp nobody reported.
      startedAt: null,
    });
  });

  it("carries all the way into pendingRounds -- Copilot's PENDING request owes a round (bankai-core#564)", () => {
    // The end of the seam. If any link in it breaks, the gate stops seeing the
    // pending request and reads `ready` in the window between an approval and
    // Copilot's threads, which is the regression #564 was filed for.
    const snapshot = normalizePullRequestResponse(queryResponse());
    const requests = parseReviewRequests(snapshot.reviewRequests);
    const checks = parseCheckRollup(snapshot.checkRollup);

    expect(requests.ok).toBe(true);
    expect(checks.ok).toBe(true);
    if (!requests.ok || !checks.ok) return;

    expect(
      pendingRounds(
        IDENTITIES,
        { reviewRequests: requests.value, checks: checks.value, reviews: [] },
        "d4f0a1cf401a39",
        ["copilot"],
        "bounded",
      ),
    ).toEqual([{ reviewer: "copilot", reason: "review-requested-not-yet-posted" }]);
  });
});

// --- defaultBranch ------------------------------------------------------------
//
// PORT ADDITION (zheref/nen#2's review record, finding 4): zero coverage
// before this. `defaultBranch` is a SIBLING of `pullRequest` (see
// PullRequestSnapshot's own doc comment), required non-empty by
// ../gates/predicates.ts's `isDeliveryPr()`, so a silent regression here
// disables the whole CON-40 delivery carve-out -- and, like `timeline()`,
// fails in the direction a `ready`-side check can never catch (the carve-out
// simply never fires, which only ever makes the gate MORE conservative).

function repositoryWith(fields: Record<string, unknown>): unknown {
  return { repository: { pullRequest: { number: 1 }, ...fields } };
}

describe("normalizePullRequestResponse -- defaultBranch", () => {
  it("lifts repository.defaultBranchRef.name onto the snapshot", () => {
    const snapshot = normalizePullRequestResponse(queryResponse());

    expect(snapshot.defaultBranch).toBe("main");
  });

  it("yields undefined, never '', when defaultBranchRef is absent", () => {
    const snapshot = normalizePullRequestResponse(repositoryWith({}));

    expect(snapshot.defaultBranch).toBeUndefined();
  });

  it("yields undefined when defaultBranchRef is null", () => {
    const snapshot = normalizePullRequestResponse(
      repositoryWith({ defaultBranchRef: null }),
    );

    expect(snapshot.defaultBranch).toBeUndefined();
  });

  it("yields undefined when defaultBranchRef.name is present but non-string", () => {
    const snapshot = normalizePullRequestResponse(
      repositoryWith({ defaultBranchRef: { name: 42 } }),
    );

    expect(snapshot.defaultBranch).toBeUndefined();
  });
});

// --- connection unwrapping ---------------------------------------------------

function nodeWith(fields: Record<string, unknown>): unknown {
  return { repository: { pullRequest: { number: 1, ...fields } } };
}

describe("connection unwrapping", () => {
  it("passes an ABSENT connection through as itself -- `.labels // []` stays the parser's reading", () => {
    const snapshot = normalizePullRequestResponse(nodeWith({}));

    expect(snapshot.pullRequest?.labels).toBeUndefined();
  });

  it("passes an ALREADY-UNWRAPPED array through -- the normalizer is idempotent, so a gh payload or a replay fixture needs no second code path", () => {
    const snapshot = normalizePullRequestResponse(
      nodeWith({ labels: [{ name: "bankai:epic" }] }),
    );

    expect(snapshot.pullRequest?.labels).toEqual([{ name: "bankai:epic" }]);
  });

  it("passes an UNREADABLE connection through UNCHANGED so the parser rejects it -- `{nodes:null}` must never become `[]`", () => {
    // A partial-data blank on `labels` is "we could not read the labels", not
    // "there are no labels". Coalescing it here would reintroduce, one layer
    // below the parser, the exact `//` failure class parse.ts exists to remove.
    const snapshot = normalizePullRequestResponse(
      nodeWith({
        labels: { nodes: null },
        mergeable: "MERGEABLE",
        headRefOid: "sha",
        headRefName: "topic",
        baseRefName: "main",
      }),
    );

    expect(snapshot.pullRequest?.labels).toEqual({ nodes: null });

    const result = parsePullRequest(snapshot.pullRequest);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.labels");
  });
});

describe("requestedReviewer unwrapping", () => {
  it("leaves an already gh-shaped request alone rather than wrapping-then-unwrapping", () => {
    const snapshot = normalizePullRequestResponse(
      nodeWith({ reviewRequests: [{ login: "Copilot" }] }),
    );

    expect(parseReviewRequests(snapshot.reviewRequests)).toEqual({
      ok: true,
      value: [{ login: "Copilot", name: null }],
    });
  });

  it("hands an UNRESOLVABLE reviewer to the parser as null -- a request that cannot be named must FAIL, never vanish (bankai-core#564)", () => {
    // `requestedReviewer` is nullable: a token that cannot resolve the reviewer
    // gets a null. Dropping such an entry would shorten the owed-round list,
    // which is the failure direction that makes the gate MORE permissive.
    const snapshot = normalizePullRequestResponse(
      nodeWith({ reviewRequests: { nodes: [{ requestedReviewer: null }] } }),
    );

    const result = parseReviewRequests(snapshot.reviewRequests);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.path).toBe("$.review_requests[0]");
  });

  it("preserves ORDER and arity across the unwrap", () => {
    const snapshot = normalizePullRequestResponse(
      nodeWith({
        reviewRequests: {
          nodes: [
            { requestedReviewer: { login: "Copilot" } },
            { requestedReviewer: { login: "bisky-bankai[bot]" } },
            { requestedReviewer: { name: "maintainers" } },
          ],
        },
      }),
    );

    const result = parseReviewRequests(snapshot.reviewRequests);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.map((request: ReviewRequest): string | null => request.login)).toEqual([
      "Copilot",
      "bisky-bankai[bot]",
      null,
    ]);
  });
});

// --- head-commit rollup selection (BC-9, BC-PR-#802 finding 3) ---------------

function responseWithCommits(commits: unknown): unknown {
  return { repository: { pullRequest: { statusCheckRollup: { nodes: commits } } } };
}

function contexts(name: string): unknown {
  return {
    commit: {
      statusCheckRollup: { contexts: { nodes: [{ __typename: "CheckRun", name }] } },
    },
  };
}

describe("head-commit rollup selection", () => {
  it("reads the LAST commit node -- `last:N` returns ascending, so the head is the last", () => {
    // Taking `[0]` would judge readiness on the OLDEST commit in the window if
    // the selection were ever widened past `last:1`, and a rollup read off the
    // wrong commit is a green verdict about work that is not at head.
    const result = parseCheckRollup(
      normalizePullRequestResponse(
        responseWithCommits([contexts("stale / audit"), contexts("head / audit")]),
      ).checkRollup,
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).toEqual([
      { kind: "check_run", name: "head / audit", status: null, conclusion: null, startedAt: null, completedAt: null, detailsUrl: null },
    ]);
  });

  it("yields undefined -- never [] -- when the commits connection is ABSENT", () => {
    expect(
      normalizePullRequestResponse({ repository: { pullRequest: {} } }).checkRollup,
    ).toBeUndefined();
  });

  it("yields undefined when the commits connection is NULL or a non-array", () => {
    expect(normalizePullRequestResponse(responseWithCommits(null)).checkRollup).toBeUndefined();
    expect(normalizePullRequestResponse(responseWithCommits({})).checkRollup).toBeUndefined();
    expect(normalizePullRequestResponse(responseWithCommits("nope")).checkRollup).toBeUndefined();
  });

  it("yields undefined for an EMPTY commits array -- a PR with no commits reported", () => {
    expect(normalizePullRequestResponse(responseWithCommits([])).checkRollup).toBeUndefined();
  });

  it("yields undefined when the head commit reports `statusCheckRollup: null` -- a real answer for a PR with no runs (bankai-core#671)", () => {
    expect(
      normalizePullRequestResponse(
        responseWithCommits([{ commit: { statusCheckRollup: null } }]),
      ).checkRollup,
    ).toBeUndefined();
  });

  it("and every one of those undefineds parses to the EMPTY rollup, which is never green", () => {
    // The chain that matters: `undefined` -> `[]` -> checksAllGreen()'s
    // non-empty test says "no signal", not "passed" (bankai-core#671).
    expect(parseCheckRollup(normalizePullRequestResponse(responseWithCommits([])).checkRollup)).toEqual({
      ok: true,
      value: [],
    });
  });
});

// --- review-thread page ------------------------------------------------------

describe("normalizeReviewThreadsResponse", () => {
  it("splits a page into its nodes and its cursor", () => {
    const page = normalizeReviewThreadsResponse({
      repository: {
        pullRequest: {
          reviewThreads: {
            nodes: [{ id: "T1", isResolved: false }],
            pageInfo: { hasNextPage: true, endCursor: "Y3Vyc29y" },
          },
        },
      },
    });

    expect(page.hasNextPage).toBe(true);
    expect(page.endCursor).toBe("Y3Vyc29y");
    expect(parseReviewThreads(page.nodes)).toEqual({
      ok: true,
      value: [{ id: "T1", isResolved: false }],
    });
  });

  it("leaves an unreadable page's cursor UNDEFINED rather than coercing hasNextPage to false", () => {
    // A `hasNextPage` that could not be read must not end the walk: CON-32(d)'s
    // boundary is "zero unresolved", and a short walk under-counts threads. What
    // an unreadable page MEANS is the composition phase's verdict, not this
    // file's (bankai-core#568).
    const page = normalizeReviewThreadsResponse({ repository: { pullRequest: null } });

    expect(page.nodes).toBeUndefined();
    expect(page.hasNextPage).toBeUndefined();
    expect(page.endCursor).toBeUndefined();
  });
});
