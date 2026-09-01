import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { fetchPullRequest, FetchError, reviewsArgv, reviewThreadsArgv, viewArgv } from "./fetch.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

function scriptedFetch(overrides: {
  view?: Record<string, unknown>;
  reviews?: unknown[];
  threadsNodes?: unknown[];
  hasNextPage?: boolean;
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
      result: {
        stdout: JSON.stringify({
          data: {
            repository: {
              pullRequest: {
                reviewThreads: {
                  nodes: overrides.threadsNodes ?? [],
                  pageInfo: { hasNextPage: overrides.hasNextPage ?? false },
                },
              },
            },
          },
        }),
      },
    },
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
    expect(snapshot.threadsTruncated).toBe(false);
  });

  it("flags a full review-thread page as truncated", () => {
    const seams = scriptedFetch({ hasNextPage: true });
    expect(fetchPullRequest(seams, TARGET, 9).threadsTruncated).toBe(true);
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
