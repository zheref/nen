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
  reviews?: unknown[];
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
});
