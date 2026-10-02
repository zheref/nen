// Tests for ../github/pr_state.ts's transport half -- everything the header's
// "FOUR TRANSPORT DIVERGENCES" section documents, plus `unresolvedThreadCount`
// and `requestedAt`'s own bounds -- all against a STUBBED PrStateSource. No
// network, no gh, no git: the seam this module is built around exists
// precisely so this file can drive it with plain objects.

import { describe, expect, it } from "vitest";
import {
  EARLIER_COMMIT_READS_DEFAULT,
  PULL_REQUEST_COMMITS_CAP,
  earlierRoundCheckWanted,
  fetchPrState,
  fullCheckRollup,
  readEarlierRoundChecks,
  fullReviewRequests,
  requestedAt,
  unresolvedThreadCount,
  type FetchStateOptions,
  type PrRef,
  type PrStateSource,
} from "./pr_state.js";
import { loadGateIdentities, parseGateIdentities } from "../schema/gates.js";
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

/**
 * One REST check run's `pull_requests[]` entry: a number AND its base
 * repository, spelled as REST spells it -- `{ id, name, url }` with no owner
 * field (finding F4: a number alone is not a pull request's identity).
 */
function listed(number: number, owner = "zheref", name = "example"): Record<string, unknown> {
  return {
    number,
    url: `https://api.github.com/repos/${owner}/${name}/pulls/${number}`,
    base: { ref: "main", repo: { id: 1, name, url: `https://api.github.com/repos/${owner}/${name}` } },
  };
}

/** One REST `commits/{sha}/check-runs` page: the raw payload the client hands back. */
function page(runs: readonly unknown[], totalCount = runs.length): unknown {
  return { total_count: totalCount, check_runs: runs };
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
// context past the cap was invisible to checksAllGreen(). When observed on
// 2026-08-31, #927's rollup had totalCount 114 with hasNextPage true, and the
// one failing entry ('sasuke / audit') sat at position 101+ -- these tests
// pin the fix with a SMALLER stubbed rollup spanning two pages, the failure
// on the second, and prove the fail-closed behaviour on every way a page can
// go wrong.

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

describe("fetchPrState -- the draft flag (zheref/nen#331)", () => {
  it("carries GraphQL's isDraft into the state as is_draft, which row 1 refuses", async () => {
    const base = snapshot();
    const node = base.pullRequest;
    if (node === undefined) throw new Error("unreachable");
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => ({
        ...base,
        pullRequest: { ...node, isDraft: true },
      }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["is_draft"]).toBe(true);
  });

  it("refuses a non-boolean isDraft as unreadable, never as 'not a draft' (Feitan F4)", async () => {
    const base = snapshot();
    const node = base.pullRequest;
    if (node === undefined) throw new Error("unreachable");
    const source = stubSource({
      pullRequestSnapshot: async (): Promise<PullRequestSnapshot> => ({
        ...base,
        pullRequest: { ...node, isDraft: null },
      }),
    });
    const result = await fetchPrState(source, REPO, 7, baseOptions());
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("unreachable");
    expect(result.reason).toContain("isDraft");
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
      is_draft: false,
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

// ── BOUNDED earlier-head round checks (maintainer ruling 2026-09-29, option B) ──
//
// Under `bounded`, a round-check reviewer's completed run on an EARLIER commit
// of the pull request is its round, as an earlier review already is. What is
// proved here is the TRANSPORT's half: the call budget (zero unless needed,
// then one listing plus one read per commit, newest first, stopping early and
// at a cap), and that every failure fails CLOSED -- not counted, never counted.
describe("readEarlierRoundChecks -- the call budget and the fail-closed walk", () => {
  const BUGBOT = { reviewer: "bugbot", pattern: /^Cursor Bugbot$/i };
  // A REST check run MADE FOR this pull request (#7): finding H1 counts an
  // earlier-head run only when its `pull_requests` names this PR.
  const clean = { name: "Cursor Bugbot", status: "completed", conclusion: "success", pull_requests: [listed(7)] };

  /** A source that records every earlier-commit call it serves. */
  function walkSource(
    commits: readonly string[],
    runsBySha: Readonly<Record<string, unknown>>,
  ): { source: PrStateSource; calls: string[] } {
    const calls: string[] = [];
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => {
        calls.push("commits");
        return commits.map((sha) => ({ sha }));
      },
      commitCheckRuns: async (_repo, sha): Promise<unknown> => {
        calls.push(sha);
        const runs = runsBySha[sha];
        if (runs instanceof Error) throw runs;
        // An array is a page of runs; anything else is handed back RAW, so a
        // case can serve a malformed payload.
        return Array.isArray(runs) ? page(runs) : (runs ?? page([]));
      },
    });
    return { source, calls };
  }

  it("makes ZERO calls when nothing is wanted", async () => {
    const { source, calls } = walkSource(["a1", "b2", "head"], {});
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [], 20);
    expect(calls).toEqual([]);
    expect(result).toEqual({ checks: [], warnings: [], commitReads: 0 });
  });

  it("lists commits ONCE, walks NEWEST FIRST past the head, and STOPS at the first qualifying run", async () => {
    const { source, calls } = walkSource(["c1", "c2", "c3", "c4", "head"], {
      c3: [clean],
      c1: [clean],
    });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "c4", "c3"]);
    expect(result.commitReads).toBe(2);
    expect(result.checks).toEqual([{ sha: "c3", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" }]);
    expect(result.warnings).toEqual([]);
  });

  it("does not count a SKIPPED or unfinished earlier run -- it keeps walking past it", async () => {
    const { source, calls } = walkSource(["c1", "c2", "c3", "head"], {
      c3: [{ name: "Cursor Bugbot", status: "completed", conclusion: "skipped" }],
      c2: [{ name: "Cursor Bugbot", status: "in_progress", conclusion: null }],
    });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "c3", "c2", "c1"]);
    expect(result.checks).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("a READ ERROR on an earlier commit counts NOTHING from it, stops the walk, and says so", async () => {
    const { source, calls } = walkSource(["c1", "c2", "head"], {
      c2: new Error("403 resource not accessible"),
      c1: [clean],
    });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "c2"]);
    expect(result.checks).toEqual([]);
    expect(result.warnings).toEqual([
      "earlier-head round checks: reading the check runs of c2 on zheref/example#7 failed (403 resource not accessible); the walk stopped and nothing further was counted",
    ]);
  });

  it("an UNREADABLE check-run page fails closed exactly like a thrown one", async () => {
    const { source } = walkSource(["c1", "head"], { c1: { not: "an array" } });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 20);
    expect(result.checks).toEqual([]);
    expect(result.warnings[0]).toMatch(/came back unreadable; the walk stopped/);
  });

  it("keeps a run found BEFORE a later failure -- it was read in full and is real evidence", async () => {
    const other = { reviewer: "bisky", pattern: /^bisky \/ review$/ };
    const { source } = walkSource(["c1", "c2", "head"], {
      c2: [clean],
      c1: new Error("rate limited"),
    });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT, other], 20);
    expect(result.checks.map((check) => check.sha)).toEqual(["c2"]);
    expect(result.warnings[0]).toMatch(/failed \(rate limited\)/);
  });

  it("a FAILED listing counts nothing and makes no per-commit read", async () => {
    const calls: string[] = [];
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => {
        throw new Error("boom");
      },
      commitCheckRuns: async (): Promise<unknown> => {
        calls.push("runs");
        return page([clean]);
      },
    });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual([]);
    expect(result.checks).toEqual([]);
    expect(result.warnings[0]).toMatch(/listing the pull request's commits failed \(boom\), so none were counted/);
  });

  it("stops at the BUDGET with a warning, never reading past it", async () => {
    const commits = ["c1", "c2", "c3", "c4", "c5", "head"];
    const { source, calls } = walkSource(commits, { c1: [clean] });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 2);
    expect(calls).toEqual(["commits", "c5", "c4"]);
    expect(result.checks).toEqual([]);
    expect(result.warnings).toEqual([
      "earlier-head round checks: stopped after 2 earlier commit(s) of zheref/example#7 without a qualifying run for bugbot; not counted",
    ]);
  });

  it("a source without the two optional methods reads nothing and says so -- never a guess", async () => {
    const result = await readEarlierRoundChecks(stubSource(), REPO, 7, "head", [BUGBOT], 20);
    expect(result.checks).toEqual([]);
    expect(result.warnings[0]).toMatch(/cannot list a pull request's commits/);
  });

  it("never reads the head itself, and skips a commit entry with no sha", async () => {
    const calls: string[] = [];
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => [{ sha: "c1" }, { nope: true }, { sha: "head" }],
      commitCheckRuns: async (_repo, sha): Promise<unknown> => {
        calls.push(sha);
        return page([clean]);
      },
    });
    const result = await readEarlierRoundChecks(source, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["c1"]);
    expect(result.checks[0]?.sha).toBe("c1");
  });
});

describe("readEarlierRoundChecks -- what qualifies (review of E7: C1, H1, L1)", () => {
  const BUGBOT = { reviewer: "bugbot", pattern: /^Cursor Bugbot$/i };
  const run = (fields: Record<string, unknown> = {}): Record<string, unknown> => ({
    name: "Cursor Bugbot",
    status: "completed",
    conclusion: "success",
    pull_requests: [listed(7)],
    ...fields,
  });
  function source(
    commits: readonly string[],
    pages: Readonly<Record<string, unknown>>,
  ): { source: PrStateSource; calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      source: stubSource({
        pullRequestCommits: async (): Promise<unknown[]> => {
          calls.push("commits");
          return commits.map((sha) => ({ sha }));
        },
        commitCheckRuns: async (_repo, sha): Promise<unknown> => {
          calls.push(sha);
          return pages[sha] ?? page([]);
        },
      }),
    };
  }

  it("C1: skips a NEWER cancelled (NEUTRAL) run and walks on to an OLDER SUCCESS", async () => {
    const { source: s, calls } = source(["old", "new", "head"], {
      new: page([run({ conclusion: "neutral" })]),
      old: page([run()]),
    });
    const result = await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "new", "old"]);
    expect(result.checks).toEqual([{ sha: "old", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" }]);
  });

  it("C1: a FAILURE, CANCELLED or TIMED_OUT run is never counted", async () => {
    for (const conclusion of ["failure", "cancelled", "timed_out", "neutral"]) {
      const { source: s } = source(["c1", "head"], { c1: page([run({ conclusion })]) });
      expect((await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20)).checks, conclusion).toEqual([]);
    }
  });

  it("H1: a run made for ANOTHER pull request on a shared commit is skipped, silently, and the walk finds this PR's own", async () => {
    // Stacked PRs share commits: #278's list carries #274's four. A clean run
    // made for #274 is #274's round, not this PR's.
    const { source: s, calls } = source(["mine", "shared", "head"], {
      shared: page([run({ pull_requests: [listed(274)] })]),
      mine: page([run({ pull_requests: [listed(274), listed(7)] })]),
    });
    const result = await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "shared", "mine"]);
    expect(result.checks.map((check) => check.sha)).toEqual(["mine"]);
    expect(result.warnings).toEqual([]);
  });

  it("H1: a run naming NO pull request (a fork's PR, or a merged one) is not counted, with a warning", async () => {
    for (const pulls of [[], undefined, "not-a-list"]) {
      const { source: s } = source(["c1", "head"], { c1: page([run({ pull_requests: pulls })]) });
      const result = await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20);
      expect(result.checks).toEqual([]);
      expect(result.warnings).toEqual([
        "earlier-head round checks: a successful run for bugbot on c1 of zheref/example#7 names no pull request (a fork's pull request, or one already merged), so it cannot be attributed to this one and is not counted",
      ]);
    }
  });

  it("F4: the SAME NUMBER in another base repository is another pull request -- not counted, and the walk goes on", async () => {
    const { source: s, calls } = source(["mine", "fork", "head"], {
      fork: page([run({ pull_requests: [listed(7, "someone-else", "example")] })]),
      mine: page([run({ pull_requests: [listed(7)] })]),
    });
    const result = await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "fork", "mine"]);
    expect(result.checks.map((check) => check.sha)).toEqual(["mine"]);
    // A list that names a pull request is not "unattributed" -- it names the
    // wrong one, which is a correct non-count, not a warning.
    expect(result.warnings).toEqual([]);
  });

  it("F4: a different repository NAME under the same owner is another pull request too", async () => {
    const { source: s } = source(["c1", "head"], { c1: page([run({ pull_requests: [listed(7, "zheref", "other")] })]) });
    expect((await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20)).checks).toEqual([]);
  });

  it("F4: the base repository is matched case-insensitively, and through a GitHub Enterprise API path", async () => {
    for (const url of [
      "https://api.github.com/repos/ZheRef/Example",
      "https://ghe.example.test/api/v3/repos/zheref/example",
      "https://api.github.com/repos/zheref/example/",
    ]) {
      const entry = { number: 7, base: { repo: { id: 1, name: "Example", url } } };
      const { source: s } = source(["c1", "head"], { c1: page([run({ pull_requests: [entry] })]) });
      expect((await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20)).checks, url).toHaveLength(1);
    }
  });

  it("F4: an entry whose base repository cannot be read -- or disagrees with itself -- fails CLOSED", async () => {
    for (const entry of [
      { number: 7 },
      { number: 7, base: {} },
      { number: 7, base: { repo: { name: "example" } } },
      { number: 7, base: { repo: { url: "https://api.github.com/repos/zheref/example" } } },
      { number: 7, base: { repo: { name: "other", url: "https://api.github.com/repos/zheref/example" } } },
      { number: 7, base: { repo: { name: "example", url: "not a repository url" } } },
    ]) {
      const { source: s } = source(["c1", "head"], { c1: page([run({ pull_requests: [entry] })]) });
      expect((await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20)).checks, JSON.stringify(entry)).toEqual([]);
    }
  });

  it("L1: a listing of 250 commits -- GitHub's cap -- warns that older commits were not read, and still walks", async () => {
    const shas = Array.from({ length: PULL_REQUEST_COMMITS_CAP }, (_unused, index) => `c${index}`);
    const { source: s } = source(shas, { [`c${PULL_REQUEST_COMMITS_CAP - 2}`]: page([run()]) });
    const result = await readEarlierRoundChecks(s, REPO, 7, `c${PULL_REQUEST_COMMITS_CAP - 1}`, [BUGBOT], 20);
    expect(result.checks.map((check) => check.sha)).toEqual([`c${PULL_REQUEST_COMMITS_CAP - 2}`]);
    expect(result.warnings).toEqual([
      "earlier-head round checks: zheref/example#7 listed 250 commits, GitHub's cap for this listing; any older commit was not read, so a run on one is not counted",
    ]);
  });

  it("L1: a listing under the cap does not warn", async () => {
    const shas = Array.from({ length: PULL_REQUEST_COMMITS_CAP - 1 }, (_unused, index) => `c${index}`);
    const { source: s } = source(shas, {});
    const result = await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 1);
    expect(result.warnings.some((warning) => warning.includes("GitHub's cap"))).toBe(false);
  });

  it("L1: a page carrying fewer runs than total_count warns of the unread rest, and the walk carries on", async () => {
    const { source: s, calls } = source(["c1", "c2", "head"], {
      c2: page([run({ name: "ci / build" })], 140),
      c1: page([run()]),
    });
    const result = await readEarlierRoundChecks(s, REPO, 7, "head", [BUGBOT], 20);
    expect(calls).toEqual(["commits", "c2", "c1"]);
    expect(result.checks.map((check) => check.sha)).toEqual(["c1"]);
    expect(result.warnings).toEqual([
      "earlier-head round checks: c2 on zheref/example#7 has 140 check runs and one page carried 1; a run on the rest was not read, so it is not counted",
    ]);
  });
});

describe("earlierRoundCheckWanted -- the narrowing that keeps the walk at zero calls", () => {
  const OWN = loadGateIdentities(process.cwd()); // copilot (exempt) + bugbot + round_quorum
  const headClean = { name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" };
  const reviewBy = (author: string): Record<string, unknown> => ({
    author,
    state: "COMMENTED",
    commit_id: "old",
    submitted_at: "2026-09-29T00:00:00Z",
  });

  it("wants nothing under STRICT", () => {
    expect(earlierRoundCheckWanted(OWN, "strict", ["copilot"], [], [])).toEqual([]);
  });

  it("wants nothing when no declared reviewer has a round_check_pattern", () => {
    const plain = parseGateIdentities("/f/nen/gates.json", {
      version: 1,
      reviewers: [{ name: "a", login_pattern: { pattern: "^a$", ignoreCase: true } }],
      default_approvers: ["a"],
      base_reviewers: ["a"],
      delivery: { author_pattern: { pattern: "^x$", ignoreCase: true }, head_ref_prefixes: ["x/"] },
    });
    expect(earlierRoundCheckWanted(plain, "bounded", ["a"], [], [])).toEqual([]);
  });

  it("wants a quorum member with no head run and no review, under BOUNDED", () => {
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot"], [], []).map((w) => w.reviewer)).toEqual(["bugbot"]);
  });

  it("does not want it once the head settles it: completed or IN FLIGHT at head", () => {
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot"], [headClean], [])).toEqual([]);
    const running = { name: "Cursor Bugbot", status: "IN_PROGRESS", conclusion: null };
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot", "bugbot"], [running], [])).toEqual([]);
  });

  it("C1: still wants it when its head run completed WITHOUT SUCCESS -- a NEUTRAL may be a cancelled run", () => {
    const neutral = { name: "Cursor Bugbot", status: "COMPLETED", conclusion: "NEUTRAL" };
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot"], [neutral], []).map((w) => w.reviewer)).toEqual(["bugbot"]);
  });

  it("still wants it when its head run was SKIPPED -- a skip is not a round", () => {
    const skipped = { name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SKIPPED" };
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot"], [skipped], []).map((w) => w.reviewer)).toEqual(["bugbot"]);
  });

  it("does not want it once it has POSTED a review -- under bounded that is already its round", () => {
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot"], [], [reviewBy("cursor")])).toEqual([]);
  });

  it("does not chase a QUORUM-ONLY member once the quorum is met by known rounds (zheref/nen#274)", () => {
    expect(earlierRoundCheckWanted(OWN, "bounded", ["copilot"], [], [reviewBy("copilot-pull-request-reviewer")])).toEqual([]);
  });

  it("still wants a CONFIGURED member when the quorum is met -- it can be owed, the quorum cannot excuse it", () => {
    const wanted = earlierRoundCheckWanted(OWN, "bounded", ["copilot", "bugbot"], [], [reviewBy("copilot-pull-request-reviewer")]);
    expect(wanted.map((w) => w.reviewer)).toEqual(["bugbot"]);
  });

  it("does not want a round-check reviewer that is neither configured nor a quorum member", () => {
    // The bankai fixture declares no quorum; bisky and bugbot are enrolled only by a head check.
    expect(earlierRoundCheckWanted(IDENTITIES, "bounded", ["sasuke", "tenma", "copilot"], [], [])).toEqual([]);
  });
});

describe("fetchPrState -- earlier-head round checks are wired in, bounded, and fail closed", () => {
  const OWN = loadGateIdentities(process.cwd());
  const ownOptions = (overrides: Partial<FetchStateOptions> = {}): FetchStateOptions =>
    baseOptions({ identities: OWN, ...overrides });
  const refuseEarlierReads = {
    pullRequestCommits: async (): Promise<unknown[]> => {
      throw new Error("pullRequestCommits must not be called");
    },
    commitCheckRuns: async (): Promise<unknown> => {
      throw new Error("commitCheckRuns must not be called");
    },
  };

  it("zheref/nen#279's shape: reads the earlier run into `earlier_round_checks` and leaves `checks` head-only", async () => {
    const calls: string[] = [];
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => {
        calls.push("commits");
        return [{ sha: "55b9ed2" }, { sha: "2851d2e" }, { sha: "deadbeef" }];
      },
      commitCheckRuns: async (_repo, sha): Promise<unknown> => {
        calls.push(sha);
        // 2851d2e's run names [279], as `gh api repos/zheref/nen/commits/2851d2e/check-runs` does.
        return page(
          sha === "2851d2e"
            ? [{ name: "Cursor Bugbot", status: "completed", conclusion: "success", pull_requests: [listed(279)] }]
            : [],
        );
      },
    });
    const result = await fetchPrState(source, REPO, 279, ownOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(calls).toEqual(["commits", "2851d2e"]);
    expect(result.state["earlier_round_checks"]).toEqual([
      { sha: "2851d2e", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    expect(result.state["checks"]).toEqual([{ name: "ci / build", status: "COMPLETED", conclusion: "SUCCESS" }]);
    expect(result.warnings).toEqual([]);
  });

  it("makes NO earlier-commit call under STRICT", async () => {
    const result = await fetchPrState(stubSource(refuseEarlierReads), REPO, 279, ownOptions({ policy: "strict" }));
    expect(result.ok && result.state["earlier_round_checks"]).toEqual([]);
  });

  it("makes NO earlier-commit call when no reviewer declares a round_check_pattern that matters", async () => {
    const result = await fetchPrState(stubSource(refuseEarlierReads), REPO, 7, baseOptions());
    expect(result.ok && result.state["earlier_round_checks"]).toEqual([]);
  });

  it("a read error surfaces as a warning and counts nothing -- the state is still read", async () => {
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => [{ sha: "c1" }, { sha: "deadbeef" }],
      commitCheckRuns: async (): Promise<unknown> => {
        throw new Error("403");
      },
    });
    const result = await fetchPrState(source, REPO, 7, ownOptions());
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("unreachable");
    expect(result.state["earlier_round_checks"]).toEqual([]);
    expect(result.warnings.some((warning) => warning.includes("the walk stopped and nothing further was counted"))).toBe(true);
  });

  it("honours a caller's maxEarlierCommitReads", async () => {
    const calls: string[] = [];
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => [{ sha: "c1" }, { sha: "c2" }, { sha: "c3" }, { sha: "deadbeef" }],
      commitCheckRuns: async (_repo, sha): Promise<unknown> => {
        calls.push(sha);
        return page([]);
      },
    });
    await fetchPrState(source, REPO, 7, ownOptions({ maxEarlierCommitReads: 1 }));
    expect(calls).toEqual(["c3"]);
  });

  it("defaults the budget to EARLIER_COMMIT_READS_DEFAULT", async () => {
    const shas = Array.from({ length: EARLIER_COMMIT_READS_DEFAULT + 5 }, (_unused, index) => ({ sha: `c${index}` }));
    let reads = 0;
    const source = stubSource({
      pullRequestCommits: async (): Promise<unknown[]> => [...shas, { sha: "deadbeef" }],
      commitCheckRuns: async (): Promise<unknown> => {
        reads += 1;
        return page([]);
      },
    });
    await fetchPrState(source, REPO, 7, ownOptions());
    expect(reads).toBe(EARLIER_COMMIT_READS_DEFAULT);
  });
});
