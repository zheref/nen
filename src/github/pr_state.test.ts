// Tests for ../github/pr_state.ts's transport half -- everything the header's
// "FOUR TRANSPORT DIVERGENCES" section documents, plus `unresolvedThreadCount`
// and `requestedAt`'s own bounds -- all against a STUBBED PrStateSource. No
// network, no gh, no git: the seam this module is built around exists
// precisely so this file can drive it with plain objects.

import { describe, expect, it } from "vitest";
import {
  fetchPrState,
  requestedAt,
  unresolvedThreadCount,
  type FetchStateOptions,
  type PrRef,
  type PrStateSource,
} from "./pr_state.js";
import { loadGateIdentities } from "../schema/gates.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { PullRequestSnapshot, ReviewThreadPage } from "./graphql.js";

const IDENTITIES = loadGateIdentities(BANKAI_REPO);
const REPO: PrRef = { owner: "zheref", repo: "example" };

function baseOptions(overrides: Partial<FetchStateOptions> = {}): FetchStateOptions {
  return {
    identities: IDENTITIES,
    reviewersCsv: "",
    policy: "bounded",
    excludeRun: "",
    maxThreadPages: 5,
    ...overrides,
  };
}

function snapshot(overrides: Partial<PullRequestSnapshot> = {}): PullRequestSnapshot {
  return {
    pullRequest: {
      number: 1,
      mergeable: "MERGEABLE",
      isDraft: false,
      headRefOid: "deadbeef",
      headRefName: "feature/x",
      baseRefName: "main",
      author: { login: "someone" },
      labels: [],
      reviewRequests: [],
    },
    defaultBranch: "main",
    checkRollup: [{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }],
    reviewRequests: [],
    ...overrides,
  };
}

/** A source whose every method is independently overridable, none of them reaching a network. */
function stubSource(overrides: Partial<PrStateSource> = {}): PrStateSource {
  return {
    pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot(),
    reviews: async (): Promise<unknown[]> => [],
    reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({
      nodes: [],
      hasNextPage: false,
      endCursor: null,
    }),
    timeline: async (): Promise<unknown[]> => [],
    ...overrides,
  };
}

describe("fetchPrState -- divergence 1: a blanked PR node is `unevaluated`, never `not-ready`", () => {
  it("reports ok:false with a remedy, never fabricates mergeable=''", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot({ pullRequest: undefined }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("zheref/example#7");
    expect(result.remedy.length).toBeGreaterThan(0);
  });
});

describe("fetchPrState -- divergence 2: an absent/null rollup is refused, not read as empty", () => {
  it.each([undefined, null])("refuses when checkRollup is %s", async (rollup) => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot({ checkRollup: rollup }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.remedy).toMatch(/actions:read/);
  });

  it("an EMPTY array rollup ([]) is NOT refused -- that is a different, later finding", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => snapshot({ checkRollup: [] }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
  });
});

describe("fetchPrState -- the happy path's state shape", () => {
  it("assembles the renamed fields (round_policy, stall_requested_at) and the delivery evidence", async () => {
    const source = stubSource({
      reviews: async (): Promise<unknown[]> => [
        { user: { login: "sasuke" }, state: "APPROVED", commit_id: "deadbeef", submitted_at: "2025-01-01T00:00:00Z" },
      ],
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions({ policy: "strict" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state).toMatchObject({
      mergeable: "MERGEABLE",
      head_sha: "deadbeef",
      unresolved_threads: 0,
      round_policy: "strict",
      stall_requested_at: null,
      exclude_run_id: null,
      author: "someone",
      base_ref: "main",
      head_ref: "feature/x",
      labels: [],
      default_branch: "main",
    });
    expect(result.state["reviews"]).toEqual([
      { author: "sasuke", state: "APPROVED", commit_id: "deadbeef", submitted_at: "2025-01-01T00:00:00Z" },
    ]);
    // §3's rename, stated in ../gates/ready.ts's header: neither persona-named
    // field survives into the state blob under its original name.
    expect(result.state).not.toHaveProperty("copilot_policy");
    expect(result.state).not.toHaveProperty("copilot_requested_at");
  });

  it("derives the reviewer set from the rollup only when the caller named none", async () => {
    const source = stubSource();
    const explicit = await fetchPrState(source, REPO, 7, baseOptions({ reviewersCsv: "sasuke,tenma" }));
    expect(explicit.ok && explicit.state["reviewers"]).toBe("sasuke,tenma");

    const derived = await fetchPrState(source, REPO, 7, baseOptions({ reviewersCsv: "" }));
    expect(derived.ok).toBe(true);
    if (!derived.ok) throw new Error("unreachable");
    // No bisky/bugbot check in the rollup, so defaultReviewers() falls back to
    // the base three -- this asserts the FALLBACK ran, not its exact contents
    // (already ./predicates.test.ts's job).
    expect(typeof derived.state["reviewers"]).toBe("string");
    expect((derived.state["reviewers"] as string).length).toBeGreaterThan(0);
  });

  it("an unreadable `reviews` fetch degrades to an EMPTY list, never throws", async () => {
    const source = stubSource({
      reviews: async (): Promise<unknown[]> => {
        throw new Error("network gremlin");
      },
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["reviews"]).toEqual([]);
  });

  it("author/labels tolerate gh's bare-string spelling as well as the object spelling", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          pullRequest: {
            number: 1,
            mergeable: "MERGEABLE",
            isDraft: false,
            headRefOid: "deadbeef",
            headRefName: "feature/x",
            baseRefName: "main",
            author: "bare-login",
            labels: ["bankai:epic", { name: "priority:p1" }],
            reviewRequests: [],
          },
        }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["author"]).toBe("bare-login");
    expect(result.state["labels"]).toEqual(["bankai:epic", "priority:p1"]);
  });
});

describe("fetchPrState -- the stall timestamp, ONLY when it is actually pending", () => {
  it("does not call timeline() when nobody bounded-exempt is pending", async () => {
    let called = false;
    const source = stubSource({
      timeline: async (): Promise<unknown[]> => {
        called = true;
        return [];
      },
    });
    await fetchPrState(source, REPO, 7, baseOptions());
    expect(called).toBe(false);
  });

  it("calls timeline() and threads the result through when copilot's request is pending", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({ reviewRequests: [{ login: "copilot-pull-request-reviewer[bot]" }] }),
      timeline: async (): Promise<unknown[]> => [
        {
          event: "review_requested",
          requested_reviewer: { login: "copilot-pull-request-reviewer[bot]" },
          created_at: "2025-01-01T00:00:00Z",
        },
      ],
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["stall_requested_at"]).toBe("2025-01-01T00:00:00Z");
  });
});

describe("unresolvedThreadCount", () => {
  it("walks the cursor across pages and sums unresolved threads only", async () => {
    let call = 0;
    const source = stubSource({
      reviewThreadsPage: async (): Promise<ReviewThreadPage> => {
        call += 1;
        if (call === 1) {
          return {
            nodes: [{ isResolved: false }, { isResolved: true }],
            hasNextPage: true,
            endCursor: "cursor-2",
          };
        }
        return { nodes: [{ isResolved: false }], hasNextPage: false, endCursor: null };
      },
    });
    const result = await unresolvedThreadCount(source, REPO, 7, 10);
    expect(result.count).toBe(2);
    expect(result.warnings).toEqual([]);
  });

  it("falls back to 1 (not-ready), never guesses zero, when a page throws", async () => {
    const source = stubSource({
      reviewThreadsPage: async (): Promise<ReviewThreadPage> => {
        throw new Error("boom");
      },
    });
    const result = await unresolvedThreadCount(source, REPO, 7, 10);
    expect(result.count).toBe(1);
  });

  it("falls back to 1 when hasNextPage is true but the cursor is unusable", async () => {
    const source = stubSource({
      reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({
        nodes: [],
        hasNextPage: true,
        endCursor: null,
      }),
    });
    const result = await unresolvedThreadCount(source, REPO, 7, 10);
    expect(result.count).toBe(1);
  });

  it("hits the page cap with a WARNING rather than returning a partial count silently", async () => {
    const source = stubSource({
      reviewThreadsPage: async (): Promise<ReviewThreadPage> => ({
        nodes: [{ isResolved: false }],
        hasNextPage: true,
        endCursor: "next",
      }),
    });
    const result = await unresolvedThreadCount(source, REPO, 7, 2);
    expect(result.count).toBe(1);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toMatch(/pagination cap/);
  });
});

describe("requestedAt", () => {
  it("returns the LATEST matching event's created_at, sorted, not merely the first", async () => {
    const source = stubSource({
      timeline: async (): Promise<unknown[]> => [
        { event: "review_requested", requested_reviewer: { login: "copilot" }, created_at: "2025-01-02T00:00:00Z" },
        { event: "review_requested", requested_reviewer: { login: "copilot" }, created_at: "2025-01-01T00:00:00Z" },
        { event: "review_dismissed", requested_reviewer: { login: "copilot" }, created_at: "2025-01-03T00:00:00Z" },
      ],
    });
    const result = await requestedAt(source, REPO, 7, /copilot/i);
    expect(result).toBe("2025-01-02T00:00:00Z");
  });

  it("returns '' on no match and on a thrown fetch, never an exception", async () => {
    const empty = await requestedAt(stubSource(), REPO, 7, /copilot/i);
    expect(empty).toBe("");

    const failing = stubSource({
      timeline: async (): Promise<unknown[]> => {
        throw new Error("boom");
      },
    });
    expect(await requestedAt(failing, REPO, 7, /copilot/i)).toBe("");
  });
});
