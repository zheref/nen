import { describe, expect, it } from "vitest";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { fetchPullRequest, FetchError, reviewsArgv, reviewThreadsArgv, reviewThreadsPageArgv, viewArgv } from "./fetch.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function threadsPageResult(nodes: unknown[], pageInfo: { hasNextPage?: unknown; endCursor?: unknown }): { stdout: string } {
  return {
    stdout: JSON.stringify({
      data: { repository: { pullRequest: { reviewThreads: { nodes, pageInfo } } } },
    }),
  };
}

function scriptedFetch(overrides: {
  view?: Record<string, unknown>;
  // `unknown`, not `unknown[]`: zheref/nen#19's second defect is GitHub
  // answering a LONE pending review as a bare object rather than an array,
  // and the fixture type must be able to say so.
  reviews?: unknown;
  threadsNodes?: unknown[];
  hasNextPage?: unknown;
  endCursor?: unknown;
  extraCalls?: readonly ScriptedCall[];
}): ScriptedSeams {
  const view = {
    number: 9,
    headRefOid: "abc123",
    baseRefName: "main",
    headRefName: "feature/x",
    author: { login: "alice" },
    labels: [],
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    isDraft: false,
    body: "## How to verify\n\nrun it",
    url: "https://x/9",
    title: "a PR",
    state: "OPEN",
    statusCheckRollup: [],
    reviewRequests: [],
    ...overrides.view,
  };
  return new ScriptedSeams([
    { match: `gh ${viewArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify(view) } },
    { match: `gh ${reviewsArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify(overrides.reviews ?? []) } },
    {
      match: `gh ${reviewThreadsArgv(TARGET, 9).join(" ")}`,
      result: threadsPageResult(overrides.threadsNodes ?? [], {
        // NOT `??` -- a test that explicitly passes `hasNextPage: undefined`
        // (the unreadable-cursor fail-closed case) must not have that
        // collapsed back to the default `false` the way `??` would.
        hasNextPage: "hasNextPage" in overrides ? overrides.hasNextPage : false,
        endCursor: overrides.endCursor,
      }),
    },
    ...(overrides.extraCalls ?? []),
  ]);
}

describe("fetchPullRequest -- one typed snapshot from three gh calls", () => {
  it("parses the PR, checks, reviews, requests and threads", () => {
    const seams = scriptedFetch({
      reviews: [{ user: { login: "sasuke" }, state: "APPROVED", commit_id: "abc123", submitted_at: "2026-01-01T00:00:00Z" }],
      threadsNodes: [{ id: "t1", isResolved: false }],
    });
    const snapshot = fetchPullRequest(seams, TARGET, 9);
    expect(snapshot.pr.number).toBe(9);
    expect(snapshot.pr.headSha).toBe("abc123");
    expect(snapshot.reviews).toEqual([
      { author: "sasuke", state: "APPROVED", commitId: "abc123", submittedAt: "2026-01-01T00:00:00Z" },
    ]);
    expect(snapshot.reviewThreads).toEqual([{ id: "t1", isResolved: false }]);
  });

  // THE FALSE-GREEN SHAPE ../pr/fetch.ts's own header names (zheref/nen#14's
  // fact-check): page one has ZERO unresolved threads, so a caller that only
  // ever inspected page one would see "unresolved: []" and move on -- but a
  // genuinely unresolved thread sits on page two. This is the exact scenario
  // nextBlocker() (../pr/blocker.ts) used to answer past incorrectly.
  it("walks a second page of review threads to completion -- a page-one-clean, page-two-unresolved rollup is not silently truncated", () => {
    const seams = scriptedFetch({
      threadsNodes: [{ id: "t1", isResolved: true }],
      hasNextPage: true,
      endCursor: "cursor-1",
      extraCalls: [
        {
          match: `gh ${reviewThreadsPageArgv(TARGET, 9, "cursor-1").join(" ")}`,
          result: threadsPageResult([{ id: "t2", isResolved: false }], { hasNextPage: false }),
        },
      ],
    });
    const snapshot = fetchPullRequest(seams, TARGET, 9);
    expect(snapshot.reviewThreads).toEqual([
      { id: "t1", isResolved: true },
      { id: "t2", isResolved: false },
    ]);
  });

  // FAIL CLOSED on an unreadable hasNextPage (mirrors ../github/pr_state.ts's
  // fullCheckRollup/fullReviewRequests fix for the identical shape): reverting
  // fetchAllReviewThreads()'s `page.hasNextPage === false` walk-ending test
  // back to something that also matches `undefined` would make this throw
  // turn into a silent, truncated `ok` return instead -- exactly the bug this
  // pins.
  it("fails closed -- an unreadable hasNextPage with no usable cursor throws rather than returning the partial page", () => {
    const seams = scriptedFetch({ threadsNodes: [{ id: "t1", isResolved: true }], hasNextPage: undefined });
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(FetchError);
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(/did not answer hasNextPage:false/);
  });

  it("fails closed -- hasNextPage:true with no endCursor throws rather than stopping silently", () => {
    const seams = scriptedFetch({ threadsNodes: [{ id: "t1", isResolved: true }], hasNextPage: true, endCursor: undefined });
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(FetchError);
  });

  it("fails closed -- hitting the page cap before hasNextPage goes false throws rather than returning what was collected", () => {
    const seams = scriptedFetch({
      threadsNodes: [{ id: "t1", isResolved: true }],
      hasNextPage: true,
      endCursor: "cursor-1",
      extraCalls: [
        {
          match: `gh ${reviewThreadsPageArgv(TARGET, 9, "cursor-1").join(" ")}`,
          result: threadsPageResult([{ id: "t2", isResolved: true }], { hasNextPage: true, endCursor: "cursor-2" }),
        },
      ],
    });
    expect(() => fetchPullRequest(seams, TARGET, 9, { maxReviewThreadPages: 1 })).toThrow(/pagination cap/);
  });

  it("throws a named FetchError rather than reading a malformed rollup as empty", () => {
    const seams = scriptedFetch({ view: { statusCheckRollup: [{ bogus: true }] } });
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(FetchError);
  });

  it("throws when the view call itself fails", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${viewArgv(TARGET, 9).join(" ")}`, result: { code: 1, stderr: "not found" } },
    ]);
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(/not found/);
  });

  // zheref/nen#19's second defect: a PR whose ONLY review is a still-PENDING
  // draft has been observed arriving from the reviews endpoint as the bare
  // review OBJECT, not a one-element array, and the snapshot then died with
  // "$.reviews -- expected an array, got object". The coercion is shape-only:
  // the wrapped object still validates field-by-field.
  it("accepts a lone PENDING review answered as a bare object -- coerced to a one-element array before validation", () => {
    const seams = scriptedFetch({
      reviews: { user: { login: "sasuke" }, state: "PENDING", commit_id: null, submitted_at: null },
    });
    const snapshot = fetchPullRequest(seams, TARGET, 9);
    expect(snapshot.reviews).toEqual([{ author: "sasuke", state: "PENDING", commitId: null, submittedAt: null }]);
  });

  it("still fails closed on a bare object that is NOT a review -- the coercion widens one spelling, not the validation", () => {
    // An error-ish body that somehow arrived at exit 0 must refuse by name at
    // the wrapped element, never parse as an empty or one-review snapshot.
    const seams = scriptedFetch({ reviews: { message: "Server Error" } });
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(FetchError);
    expect(() => fetchPullRequest(seams, TARGET, 9)).toThrow(/\$\.reviews\[0\]/);
  });

  it("throws a named FetchError, not a raw SyntaxError, when the reviews body is not JSON", () => {
    // A truncated reviews body: the view call answers normally, the reviews
    // call answers half a JSON document. The failure must be this module's
    // named contract (FetchError, repo#pr context attached), never a raw
    // SyntaxError escaping to the operator.
    const broken = new ScriptedSeams([
      { match: `gh ${viewArgv(TARGET, 9).join(" ")}`, result: { stdout: JSON.stringify({
        number: 9, headRefOid: "abc123", baseRefName: "main", headRefName: "feature/x",
        author: { login: "alice" }, labels: [], mergeable: "MERGEABLE", mergeStateStatus: "CLEAN",
        isDraft: false, body: "b", url: "https://x/9", title: "a PR", state: "OPEN",
        statusCheckRollup: [], reviewRequests: [],
      }) } },
      { match: `gh ${reviewsArgv(TARGET, 9).join(" ")}`, result: { stdout: "[{\"user\":" } },
    ]);
    expect(() => fetchPullRequest(broken, TARGET, 9)).toThrow(FetchError);
    expect(() => fetchPullRequest(broken, TARGET, 9)).toThrow(/did not return JSON/);
  });
});

// zheref/nen#19's FIRST defect, pinned as an invariant over the WHOLE module:
// gh api's documented rule is that supplying any `-f`/`-F` parameter flips the
// inferred method from GET to POST (https://cli.github.com/manual/gh_api --
// the rule ../parse/izanami.ts also encodes). reviewsArgv() carried
// `-F per_page=100` with no method, so the reviews READ became a POST to
// pulls/{n}/reviews -- the CREATE-review endpoint: an empty PENDING draft
// review written under the caller's identity on the first call, HTTP 422 on
// every call after. This sweep makes the fix structural rather than local: NO
// gh-api argv this module builds may carry a parameter without an explicitly
// spelled method, so the next builder someone adds fails this test the moment
// it repeats the shape.
describe("fetch argv builders -- no gh api call may leave its method to parameter inference (zheref/nen#19)", () => {
  const BUILT: ReadonlyArray<readonly [string, readonly string[]]> = [
    ["viewArgv", viewArgv(TARGET, 9)],
    ["reviewsArgv", reviewsArgv(TARGET, 9)],
    ["reviewThreadsArgv", reviewThreadsArgv(TARGET, 9)],
    ["reviewThreadsPageArgv", reviewThreadsPageArgv(TARGET, 9, "cursor-1")],
  ];

  it("every gh-api argv carrying -F/-f params names an explicit method", () => {
    for (const [name, argv] of BUILT) {
      if (argv[0] !== "api") continue; // `gh pr view` has no method concept.
      const hasParams = argv.some((arg): boolean => arg === "-F" || arg === "-f" || arg === "--field" || arg === "--raw-field");
      if (!hasParams) continue;
      const methodFlagAt = argv.findIndex((arg): boolean => arg === "--method" || arg === "-X");
      // The method must be PRESENT and must NAME a verb in the next slot --
      // a dangling `--method` would make gh read the endpoint as the method.
      expect(methodFlagAt, `${name} carries -F/-f params but no explicit --method/-X -- gh api would infer POST and a read would write (zheref/nen#19)`).toBeGreaterThanOrEqual(0);
      expect(argv[methodFlagAt + 1], `${name}'s --method flag names no verb`).toMatch(/^(GET|POST)$/);
    }
  });

  it("the reviews read is explicitly GET -- the exact argv that used to POST to the create-review endpoint", () => {
    const argv = reviewsArgv(TARGET, 9);
    const methodFlagAt = argv.findIndex((arg): boolean => arg === "--method" || arg === "-X");
    expect(methodFlagAt).toBeGreaterThanOrEqual(0);
    expect(argv[methodFlagAt + 1]).toBe("GET");
    // And it still addresses the reviews collection with the page-size param
    // -- the fix changed the method, not the read.
    expect(argv).toContain("repos/zheref/nen/pulls/9/reviews");
    expect(argv).toContain("per_page=100");
  });

  it("the GraphQL calls are POST by transport, and their query text is a pure read -- no mutation operation", () => {
    for (const [name, argv] of [
      ["reviewThreadsArgv", reviewThreadsArgv(TARGET, 9)],
      ["reviewThreadsPageArgv", reviewThreadsPageArgv(TARGET, 9, "cursor-1")],
    ] as const) {
      // GitHub's GraphQL endpoint accepts only POST; the explicit method is a
      // decision on the record, not a write. What makes it safe is the query.
      expect(argv).toContain("graphql");
      const queryField = argv.find((arg): boolean => arg.startsWith("query="));
      expect(queryField, `${name} carries no query= field`).toBeDefined();
      expect(queryField, `${name}'s GraphQL document must stay a query -- a mutation here would be zheref/nen#19 all over again`).not.toMatch(/\bmutation\b/);
    }
  });
});
