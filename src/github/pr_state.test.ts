// Tests for ../github/pr_state.ts's transport half -- everything the header's
// "FOUR TRANSPORT DIVERGENCES" section documents, plus `unresolvedThreadCount`
// and `requestedAt`'s own bounds -- all against a STUBBED PrStateSource. No
// network, no gh, no git: the seam this module is built around exists
// precisely so this file can drive it with plain objects.

import { describe, expect, it } from "vitest";
import {
  fetchPrState,
  fullCheckRollup,
  fullReviewRequests,
  requestedAt,
  unresolvedThreadCount,
  type FetchStateOptions,
  type PrRef,
  type PrStateSource,
} from "./pr_state.js";
import { loadGateIdentities } from "../schema/gates.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type {
  CheckRollupPage,
  PullRequestSnapshot,
  ReviewRequestsPage,
  ReviewThreadPage,
} from "./graphql.js";
import { parseCheckRollup } from "./parse.js";
import { checksAllGreen } from "../gates/predicates.js";

const IDENTITIES = loadGateIdentities(BANKAI_REPO);
const REPO: PrRef = { owner: "zheref", repo: "example" };

function baseOptions(overrides: Partial<FetchStateOptions> = {}): FetchStateOptions {
  return {
    identities: IDENTITIES,
    reviewersCsv: "",
    policy: "bounded",
    excludeRun: "",
    maxThreadPages: 5,
    maxRollupPages: 5,
    maxReviewRequestPages: 5,
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
    checkRollupPageInfo: { hasNextPage: false, endCursor: null },
    reviewRequests: [],
    reviewRequestsPageInfo: { hasNextPage: false, endCursor: null },
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
    checkRollupPage: async (): Promise<CheckRollupPage> => {
      throw new Error("checkRollupPage should not be called when hasNextPage is false");
    },
    reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
      throw new Error("reviewRequestsPage should not be called when hasNextPage is false");
    },
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

// --- check-rollup pagination (zheref/nen#14's fact-check, false-green ------
// defect, verified live against zheref/bankai-core#927) ---------------------
//
// `contexts(first:100)` alone never paginated: a rollup with more than 100
// contexts had its 101st-and-beyond entries silently dropped, so a FAILING
// context past the cap was invisible to checksAllGreen(). #927's rollup has
// totalCount 114 with hasNextPage true, and the one failing entry
// ('sasuke / audit') sits at position 101+ -- these tests pin the fix with a
// SMALLER stubbed rollup spanning two pages, the failure on the second, and
// prove the fail-closed behaviour on every way a page can go wrong.

function greenEntry(name: string): unknown {
  return { name, status: "COMPLETED", conclusion: "SUCCESS" };
}

function redEntry(name: string): unknown {
  return { name, status: "COMPLETED", conclusion: "FAILURE" };
}

describe("fullCheckRollup", () => {
  it("walks the cursor across pages and concatenates every page's nodes, in order", async () => {
    let call = 0;
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => {
        call += 1;
        if (call === 1) return { nodes: [greenEntry("b")], hasNextPage: true, endCursor: "c3" };
        return { nodes: [greenEntry("c")], hasNextPage: false, endCursor: null };
      },
    });
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.nodes.map((n): unknown => (n as { name: unknown }).name)).toEqual(["a", "b", "c"]);
    expect(call).toBe(2);
  });

  it("THE PIN: the failure sits on the SECOND page -- page one is all-green, page two is not, and the walk surfaces it", async () => {
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => ({
        nodes: [redEntry("sasuke / audit")],
        hasNextPage: false,
        endCursor: null,
      }),
    });
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("kisuke / probe")],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    const parsed = parseCheckRollup(result.nodes, "$.checks");
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) throw new Error("unreachable");
    expect(checksAllGreen(parsed.value)).toBe(false);
  });

  it("fails CLOSED, never returns the partial set, when a page throws mid-pagination", async () => {
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("page 2");
    expect(result.remedy.length).toBeGreaterThan(0);
  });

  it("fails CLOSED when hasNextPage is true but the cursor is unusable", async () => {
    const source = stubSource();
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: true, endCursor: null },
      10,
    );
    expect(result.ok).toBe(false);
  });

  it("fails CLOSED when a page's own nodes will not parse as an array", async () => {
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => ({
        nodes: null,
        hasNextPage: false,
        endCursor: null,
      }),
    });
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
  });

  it("hits the page cap and fails CLOSED rather than returning the partial set silently", async () => {
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => ({
        nodes: [greenEntry("a")],
        hasNextPage: true,
        endCursor: "next",
      }),
    });
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: true, endCursor: "c2" },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/pagination cap/);
  });

  it("page one alone (hasNextPage: false) never calls checkRollupPage at all", async () => {
    const source = stubSource(); // its checkRollupPage throws if ever called
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: false, endCursor: null },
      10,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.nodes).toEqual([greenEntry("a")]);
  });

  // THE SECOND FACT-CHECK'S PIN (zheref/nen#14, 2026-09-01): an independent
  // probe against this exported function found `hasNextPage === true` was
  // the loop's ONLY continuation test, so `undefined` and any other
  // non-boolean silently ENDED THE WALK and returned `ok:true` with the
  // partial set collected so far -- a truncated rollup presented as whole,
  // the identical false-green shape the pagination walk itself exists to
  // close. `false`, and ONLY `false`, may end the walk; everything else must
  // fail CLOSED. These two cases pin it for the two shapes named in the
  // fact-check: an unreadable (`undefined`) hasNextPage, and a non-boolean
  // (`"true"`, the literal string) one.
  it.each([
    ["undefined (unreadable)", undefined],
    ['the non-boolean string "true"', "true"],
  ])("fails CLOSED, never silently ends the walk, when hasNextPage is %s", async (_label, badValue) => {
    const source = stubSource(); // its checkRollupPage throws if ever called
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: badValue, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unreadable");
    expect(result.reason).toContain("hasNextPage");
    expect(result.remedy.length).toBeGreaterThan(0);
  });

  it("the SAME unreadable-hasNextPage fail-closed applies mid-walk, not just on the first page", async () => {
    // Page one legitimately continues; page two's OWN hasNextPage is the
    // unreadable one -- proving the check runs on every iteration, not only
    // the entry call.
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => ({
        nodes: [greenEntry("b")],
        hasNextPage: undefined,
        endCursor: undefined,
      }),
    });
    const result = await fullCheckRollup(
      source,
      REPO,
      7,
      [greenEntry("a")],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
  });
});

// --- reviewRequests pagination (zheref/nen#14's SECOND fact-check, ---------
// 2026-09-01) -- structurally identical to fullCheckRollup() above, against a
// different connection. See ../github/graphql.ts's PULL_REQUEST_QUERY
// comment for why this was closed rather than left as an argued-safe cap.

describe("fullReviewRequests", () => {
  it("walks the cursor across pages and concatenates every page's nodes, in order", async () => {
    let call = 0;
    const source = stubSource({
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
        call += 1;
        if (call === 1) return { nodes: [{ login: "b" }], hasNextPage: true, endCursor: "c3" };
        return { nodes: [{ login: "c" }], hasNextPage: false, endCursor: null };
      },
    });
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.nodes).toEqual([{ login: "a" }, { login: "b" }, { login: "c" }]);
    expect(call).toBe(2);
  });

  it.each([
    ["undefined (unreadable)", undefined],
    ['the non-boolean string "true"', "true"],
  ])("fails CLOSED, never silently ends the walk, when hasNextPage is %s", async (_label, badValue) => {
    const source = stubSource();
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: badValue, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unreadable");
    expect(result.reason).toContain("hasNextPage");
    expect(result.remedy.length).toBeGreaterThan(0);
  });

  it("fails CLOSED, never returns the partial set, when a page throws mid-pagination", async () => {
    const source = stubSource({
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
        throw new Error("ECONNRESET");
      },
    });
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("page 2");
    expect(result.remedy.length).toBeGreaterThan(0);
  });

  it("fails CLOSED when hasNextPage is true but the cursor is unusable", async () => {
    const source = stubSource();
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: true, endCursor: null },
      10,
    );
    expect(result.ok).toBe(false);
  });

  it("fails CLOSED when a page's own nodes will not parse as an array", async () => {
    const source = stubSource({
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => ({
        nodes: null,
        hasNextPage: false,
        endCursor: null,
      }),
    });
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: true, endCursor: "c2" },
      10,
    );
    expect(result.ok).toBe(false);
  });

  it("hits the page cap and fails CLOSED rather than returning the partial set silently", async () => {
    const source = stubSource({
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => ({
        nodes: [{ login: "a" }],
        hasNextPage: true,
        endCursor: "next",
      }),
    });
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: true, endCursor: "c2" },
      2,
    );
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toMatch(/pagination cap/);
  });

  it("page one alone (hasNextPage: false) never calls reviewRequestsPage at all", async () => {
    const source = stubSource(); // its reviewRequestsPage throws if ever called
    const result = await fullReviewRequests(
      source,
      REPO,
      7,
      [{ login: "a" }],
      { hasNextPage: false, endCursor: null },
      10,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.nodes).toEqual([{ login: "a" }]);
  });
});

describe("fetchPrState -- reviewRequests pagination is wired in, and fails closed", () => {
  it("assembles state.review_requests from ALL pages, not just page one", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          reviewRequests: [{ login: "sasuke" }],
          reviewRequestsPageInfo: { hasNextPage: true, endCursor: "c2" },
        }),
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => ({
        nodes: [{ login: "tenma" }],
        hasNextPage: false,
        endCursor: null,
      }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["review_requests"]).toEqual(["sasuke", "tenma"]);
  });

  it("a mid-pagination failure -> ok:false (unevaluated), NEVER ok:true with a partial request list", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          reviewRequests: [{ login: "sasuke" }],
          reviewRequestsPageInfo: { hasNextPage: true, endCursor: "c2" },
        }),
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
        throw new Error("pull-requests:read grant missing");
      },
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("zheref/example#7");
    expect(result.remedy.length).toBeGreaterThan(0);
  });

  it("page one alone (hasNextPage: false) never calls reviewRequestsPage", async () => {
    let called = false;
    const source = stubSource({
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
        called = true;
        return { nodes: [], hasNextPage: false, endCursor: null };
      },
    });
    await fetchPrState(source, REPO, 7, baseOptions());
    expect(called).toBe(false);
  });

  it("an unreadable hasNextPage on the SNAPSHOT itself is unevaluated, never a silent page-one-only ok:true", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          reviewRequests: [{ login: "sasuke" }],
          reviewRequestsPageInfo: { hasNextPage: undefined, endCursor: undefined },
        }),
      reviewRequestsPage: async (): Promise<ReviewRequestsPage> => {
        throw new Error("reviewRequestsPage should not be reached without a usable cursor");
      },
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unreadable");
  });
});

describe("fetchPrState -- check-rollup pagination is wired in, and fails closed", () => {
  it("assembles state.checks from ALL pages, not just page one", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          checkRollup: [greenEntry("kisuke / probe")],
          checkRollupPageInfo: { hasNextPage: true, endCursor: "c2" },
        }),
      checkRollupPage: async (): Promise<CheckRollupPage> => ({
        nodes: [redEntry("sasuke / audit")],
        hasNextPage: false,
        endCursor: null,
      }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["checks"]).toEqual([
      greenEntry("kisuke / probe"),
      redEntry("sasuke / audit"),
    ]);
  });

  it("a mid-pagination failure -> ok:false (unevaluated), NEVER ok:true with a partial rollup", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          checkRollup: [greenEntry("kisuke / probe")],
          checkRollupPageInfo: { hasNextPage: true, endCursor: "c2" },
        }),
      checkRollupPage: async (): Promise<CheckRollupPage> => {
        throw new Error("checks:read grant missing");
      },
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("zheref/example#7");
    expect(result.remedy.length).toBeGreaterThan(0);
  });

  it("page one alone (hasNextPage: false) never calls checkRollupPage", async () => {
    let called = false;
    const source = stubSource({
      checkRollupPage: async (): Promise<CheckRollupPage> => {
        called = true;
        return { nodes: [], hasNextPage: false, endCursor: null };
      },
    });
    await fetchPrState(source, REPO, 7, baseOptions());
    expect(called).toBe(false);
  });

  // THE SECOND FACT-CHECK'S PIN AT THE ENTRY GUARD (zheref/nen#14,
  // 2026-09-01). Before this fix, the guard here read
  // `snapshot.checkRollupPageInfo.hasNextPage === true`, so an unreadable
  // `hasNextPage` (a page whose `contexts.nodes` parsed but whose own
  // `pageInfo.hasNextPage` did not) skipped fullCheckRollup() ENTIRELY and
  // returned `ok:true` with page one alone -- the false green one call
  // earlier than the walk's own guard. The guard now reads `!== false`, so
  // this case reaches fullCheckRollup() and fails CLOSED there instead.
  it("an unreadable hasNextPage on the SNAPSHOT itself (not just mid-walk) is unevaluated, never a silent page-one-only ok:true", async () => {
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> =>
        snapshot({
          checkRollup: [greenEntry("kisuke / probe")],
          checkRollupPageInfo: { hasNextPage: undefined, endCursor: undefined },
        }),
      checkRollupPage: async (): Promise<CheckRollupPage> => {
        throw new Error("checkRollupPage should not be reached without a usable cursor");
      },
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("unreadable");
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
