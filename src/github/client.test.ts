// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/client.test.ts` (zheref/nen#1, Akatsuki migration P1).
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
// Tests for the octokit wrapper's non-I/O surface (BC-IS-#736, epic BC-IS-#733
// Phase 1).
//
// NO NETWORK. What is tested here is the one piece of behaviour that decides
// something before any request happens: WHICH token is used. A wrong answer is
// silent -- an ambient token runs as the wrong identity, and an unauthenticated
// read of a private repo 404s in a way that reads like a deleted PR.
//
// THE CLIENT'S OTHER BRANCHING IS NOT UNTESTED, IT MOVED (BC-9, BC-PR-#802
// verification). `checkRollup()` used to decide which commit's rollup is read
// inside an async method that only a live PR could exercise, which is BC-9's
// auto-reject: real branching, no vitest test. That logic is pure, so it now
// lives in ./graphql.ts and is driven directly -- including the client-response
// -> parser -> typed-model composition the old split had nobody testing -- by
// ./graphql.test.ts. The methods left in ./client.ts are one await plus one
// extraction call each, with no branch to cover.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient, GitHubClient, tokenFromEnv } from "./client.js";
import {
  CHECK_ROLLUP_PAGE_QUERY,
  PULL_REQUEST_QUERY,
  REVIEW_REQUESTS_PAGE_QUERY,
  REVIEW_THREADS_QUERY,
} from "./graphql.js";
import { PROGRAM, VERSION } from "../version.js";

// ── ONE FAKE CLOCK, SET IN THE PAST, FOR EVERY TEST IN THIS FILE ────────────
//
// octokit's throttling plugin sends every request through Bottleneck limiters.
// It builds them ONCE per process and every client shares them. The GraphQL
// limiter spaces POSTs at least 1s apart, so on a real clock each GraphQL case
// after the first waits a second. GitHubClient passes no `throttle` option
// through, and a test should not widen its surface to get one. Fake timers
// release the limiters without changing a byte of what is requested or how the
// answer is mapped, which is all this suite asserts.
//
// A limiter records its next free slot as an ABSOLUTE time, read off `Date`.
// That is the trap every clock choice here has to avoid. A slot left AHEAD of
// the real clock makes the next real-clock call in the process wait out the
// difference -- it did, as a 5s timeout. The previous design faked the timers
// and never `Date`, which holds under vitest only: `bun test`'s fake timers fake
// `Date` whatever `toFake` says. Each case then started its fake clock at the
// real time, inherited the last case's slot, and pushed it a second further,
// so the clock drifted ahead case by case. The REST cases share the same
// limiters on the real clock, and they then waited that drift out for real.
//
// So both runners get the same regime, and it cannot drift ahead:
//   * `Date` is faked in both, starting at `FAKE_EPOCH`, an instant long past.
//     A slot recorded on this clock is years BEHIND the real one, so no
//     real-clock caller anywhere in the process ever waits on it.
//   * The clock CONTINUES from case to case (`fakeClock`), rather than
//     restarting, so a case never inherits a slot ahead of its own clock.
//   * EVERY test in this file runs on it, so no limiter ever records a
//     real-clock slot that this clock would then have to jump to. That is why
//     the REST cases go through `drive` too.
const FAKE_EPOCH = Date.UTC(2020, 0, 1);
let fakeClock = FAKE_EPOCH;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"], now: fakeClock });
});

afterEach(() => {
  fakeClock = Date.now();
  vi.useRealTimers();
});

/**
 * Settle a client call on the fake clock.
 *
 * ONE STEP IS ONE REAL MACROTASK, THEN AT MOST ONE TIMER. `setImmediate` is not
 * faked in either runner. Awaiting it lets every microtask the call has queued
 * run first, so on return the call is either settled or parked on a timer, and
 * `vi.advanceTimersToNextTimer()` then fires exactly that timer. It moves the
 * clock only as far as the limiter asked, where a fixed tick would overshoot.
 * Both runners implement it the same way. `vi.advanceTimersByTimeAsync` did the
 * same job before this, but `bun test`'s `vi` lacks it and 7 tests here failed
 * on its absence.
 */
async function drive<T>(pending: Promise<T>): Promise<T> {
  // BOTH handlers are attached before any time is advanced, so a call that
  // REJECTS while the loop is still stepping is never an unhandled rejection --
  // an earlier `finally`-derived copy was, and vitest failed the whole run on it.
  const settled: { outcome?: { ok: true; value: T } | { ok: false; error: unknown } } = {};
  pending.then(
    (value): void => {
      settled.outcome = { ok: true, value };
    },
    (error: unknown): void => {
      settled.outcome = { ok: false, error };
    },
  );
  for (let step = 0; step < 1000 && settled.outcome === undefined; step += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
    if (settled.outcome === undefined) vi.advanceTimersToNextTimer();
  }
  const outcome = settled.outcome;
  if (outcome === undefined) throw new Error("the client call did not settle within 1000 steps of the fake clock");
  if (!outcome.ok) throw outcome.error;
  return outcome.value;
}

/**
 * The error a client call rejects with, once `drive` has settled it.
 *
 * SETTLE FIRST, ASSERT SECOND. Given a promise that `drive` was still stepping,
 * `bun test`'s `expect(...).rejects` stalled past its 5s timeout, though the
 * call itself settled within a dozen steps. Given an already-settled promise,
 * the same matcher returned at once. That cost the three failure cases in this
 * file a 6-7s stall each. vitest behaves the same either way. So the error is
 * collected here and the case asserts on it synchronously. A call that
 * RESOLVES fails the case, as `.rejects` would have failed it.
 */
async function rejection(pending: Promise<unknown>): Promise<unknown> {
  try {
    await drive(pending);
  } catch (error: unknown) {
    return error;
  }
  throw new Error("the client call resolved, and this case expects it to reject");
}

describe("tokenFromEnv", () => {
  it("reads the variable the caller names", () => {
    const result = tokenFromEnv("BANKAI_APP_TOKEN", { BANKAI_APP_TOKEN: "ghs_x" });

    expect(result).toEqual({ ok: true, token: "ghs_x" });
  });

  it("reports an UNSET variable as itself, rather than failing later as an auth error", () => {
    const result = tokenFromEnv("GITHUB_TOKEN", {});

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.message).toContain("GITHUB_TOKEN");
  });

  it("reports an EMPTY variable -- an empty token authenticates as nobody, and an unauthenticated read of a private repo 404s like a deleted PR", () => {
    expect(tokenFromEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "" }).ok).toBe(false);
    expect(tokenFromEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "   " }).ok).toBe(false);
  });

  it("returns the TRIMMED value -- a pasted token's trailing newline reaches the Authorization header otherwise", () => {
    // zheref/nen#7's review thread on src/github/client.ts:103: the seed
    // validated with `raw.trim()` and returned `raw`, so a token copied with
    // surrounding whitespace passed the emptiness check and then authenticated
    // as a malformed credential -- 401, or 404 on a private repository, which
    // reads like a deleted PR rather than like whitespace.
    //
    // Whitespace-ONLY values stay a refusal; only the surrounds are removed.
    expect(tokenFromEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "ghs_x\n" })).toEqual({
      ok: true,
      token: "ghs_x",
    });
    expect(tokenFromEnv("GITHUB_TOKEN", { GITHUB_TOKEN: "  ghs_x  " })).toEqual({
      ok: true,
      token: "ghs_x",
    });
  });

  it("NEVER falls back to another variable -- the identity a call runs as is a property of the code, not of the environment", () => {
    // The failure this prevents: a job that forgot to mint its App token
    // silently running as whatever GH_TOKEN happened to be exported, which is
    // how `gh` behaves and is precisely what this client does not do.
    const result = tokenFromEnv("BANKAI_APP_TOKEN", {
      GH_TOKEN: "ghp_ambient",
      GITHUB_TOKEN: "ghs_ambient",
    });

    expect(result.ok).toBe(false);
  });
});

// PORT ADDITION (zheref/nen#2's review record, finding 4): `timeline()` had no
// test at all -- it is REST-only, so nothing in ./graphql.test.ts's
// composition suite could reach it -- and it is the ONLY source of
// `stall_requested_at` (../gates/ready.ts's round-stalled conjunct). A silent
// regression here degrades that conjunct to `rounds-owed` and makes the
// "round stalled -- requested N min ago" message unreachable, and it fails in
// the CONSERVATIVE direction (the gate stays shut), which is exactly the
// shape of bug a `ready`-side check can never surface. Driven against a
// STUBBED `fetch`, via octokit's own `request.fetch` hook
// (GitHubClient's `request` option) -- no network, no live token.
describe("GitHubClient.timeline -- the issue timeline, paginated, raw", () => {
  it("hits GET /repos/{owner}/{repo}/issues/{issue_number}/timeline with per_page:100, and paginates through a Link: rel=\"next\" header", async () => {
    const requestedUrls: string[] = [];
    const fetchStub = async (url: string): Promise<Response> => {
      requestedUrls.push(url);
      if (requestedUrls.length === 1) {
        return new Response(JSON.stringify([{ event: "review_requested" }]), {
          status: 200,
          headers: {
            "content-type": "application/json",
            link: '<https://api.github.com/repositories/1/issues/9/timeline?page=2>; rel="next"',
          },
        });
      }
      return new Response(JSON.stringify([{ event: "commented" }]), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };
    const client = new GitHubClient("ghs_x", { request: { fetch: fetchStub } });

    const events = await drive(client.timeline({ owner: "zheref", repo: "nen" }, 9));

    // Both pages came back, in order -- proof `paginate` (not a single
    // request) drove this call.
    expect(events).toEqual([{ event: "review_requested" }, { event: "commented" }]);
    expect(requestedUrls).toHaveLength(2);
    expect(requestedUrls[0]).toContain("/repos/zheref/nen/issues/9/timeline");
    expect(requestedUrls[0]).toMatch(/per_page=100/);
  });
});

// ── every network method, driven through the same `request.fetch` seam ──────
//
// E7 (maintainer ruling 2026-09-29, option B) added `pullRequestCommits` and
// `commitCheckRuns` for ../github/pr_state.ts's bounded earlier-head walk,
// which made this file a TOUCHED file and put all of it under the coverage
// bar. Every method below is a single await plus one extraction, so what is
// asserted is exactly the two things that can silently go wrong in such a
// method: the REQUEST it makes (path, method, per_page, GraphQL variables) and
// the MAPPING of what came back. No network, no token: a recording `fetch`
// stub answers every call, and error cases use 403/404, which octokit's retry
// plugin does not retry (a 5xx would be re-tried on a timer).

interface RecordedCall {
  readonly url: string;
  readonly method: string;
  readonly headers: Record<string, string>;
  readonly body: Record<string, unknown> | null;
}

interface StubResponse {
  readonly status?: number;
  readonly body: unknown;
  readonly link?: string;
}

/** A recording fetch: every call is kept, and `answer` decides each response. */
function recordingFetch(answer: (call: RecordedCall, index: number) => StubResponse): {
  readonly fetch: (url: string, init?: RequestInit) => Promise<Response>;
  readonly calls: RecordedCall[];
} {
  const calls: RecordedCall[] = [];
  const fetchStub = async (url: string, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((value, key) => {
      headers[key] = value;
    });
    const body =
      typeof init.body === "string" && init.body !== ""
        ? (JSON.parse(init.body) as Record<string, unknown>)
        : null;
    const call: RecordedCall = { url, method: (init.method ?? "GET").toUpperCase(), headers, body };
    calls.push(call);
    const reply = answer(call, calls.length - 1);
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: {
        "content-type": "application/json",
        ...(reply.link === undefined ? {} : { link: reply.link }),
      },
    });
  };
  return { fetch: fetchStub, calls };
}

const REPO = { owner: "zheref", repo: "nen" };

function clientWith(fetchStub: (url: string, init?: RequestInit) => Promise<Response>): GitHubClient {
  return new GitHubClient("ghs_x", { request: { fetch: fetchStub } });
}

describe("GitHubClient.pullRequestCommits -- the PR's commits, paginated (E7 option B)", () => {
  it("GETs pulls/{n}/commits with per_page:100 and follows Link: rel=\"next\" across pages", async () => {
    const { fetch: stub, calls } = recordingFetch((_call, index) =>
      index === 0
        ? {
            body: [{ sha: "c1" }, { sha: "c2" }],
            link: '<https://api.github.com/repositories/1/pulls/279/commits?per_page=100&page=2>; rel="next"',
          }
        : { body: [{ sha: "c3" }] },
    );

    const commits = await drive(clientWith(stub).pullRequestCommits(REPO, 279));

    expect(commits).toEqual([{ sha: "c1" }, { sha: "c2" }, { sha: "c3" }]);
    expect(calls.map((call) => call.method)).toEqual(["GET", "GET"]);
    expect(calls[0]?.url).toContain("/repos/zheref/nen/pulls/279/commits");
    expect(calls[0]?.url).toMatch(/per_page=100/);
    expect(calls[1]?.url).toMatch(/page=2/);
  });

  it("returns GitHub's 250-commit ceiling whole: 100 + 100 + 50 across three pages, and nothing past the last", async () => {
    // GitHub serves at most 250 commits for this listing; the walk's L1
    // warning reads `length >= 250`, so the client must hand all of them back
    // in order and stop when the last page carries no `next` link.
    const pageOf = (from: number, count: number): { sha: string }[] =>
      Array.from({ length: count }, (_unused, offset) => ({ sha: `c${from + offset}` }));
    const next = (page: number): string =>
      `<https://api.github.com/repositories/1/pulls/9/commits?per_page=100&page=${page}>; rel="next"`;
    const { fetch: stub, calls } = recordingFetch((_call, index) => {
      if (index === 0) return { body: pageOf(0, 100), link: next(2) };
      if (index === 1) return { body: pageOf(100, 100), link: next(3) };
      return { body: pageOf(200, 50) };
    });

    const commits = await drive(clientWith(stub).pullRequestCommits(REPO, 9));

    expect(commits).toHaveLength(250);
    expect(commits[0]).toEqual({ sha: "c0" });
    expect(commits[249]).toEqual({ sha: "c249" });
    expect(calls).toHaveLength(3);
    expect(calls[2]?.url).toMatch(/page=3/);
  });

  it("propagates a failed read rather than answering an empty list -- the walk fails CLOSED on the throw", async () => {
    const { fetch: stub } = recordingFetch(() => ({
      status: 403,
      body: { message: "Resource not accessible by integration" },
    }));

    expect(await rejection(clientWith(stub).pullRequestCommits(REPO, 9))).toMatchObject({ status: 403 });
  });
});

describe("GitHubClient.fileAtRef -- one file at one commit (zheref/nen#249, Feitan F1)", () => {
  it("GETs contents/{path}?ref= and decodes GitHub's line-wrapped base64", async () => {
    const text = '{"version":1,"checks":{"excluded":[]}}';
    const b64 = Buffer.from(text).toString("base64");
    const wrapped = `${b64.slice(0, 20)}\n${b64.slice(20)}\n`;
    const { fetch: stub, calls } = recordingFetch(() => ({ body: { type: "file", content: wrapped, encoding: "base64" } }));
    expect(await drive(clientWith(stub).fileAtRef(REPO, "nen/gates.json", "base123"))).toBe(text);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/repos/zheref/nen/contents/nen/gates.json");
    expect(calls[0]?.url).toMatch(/ref=base123/);
  });

  it("answers null ONLY for a 404 -- the file is not there", async () => {
    const { fetch: stub } = recordingFetch(() => ({ status: 404, body: { message: "Not Found" } }));
    expect(await drive(clientWith(stub).fileAtRef(REPO, "nen/gates.json", "base123"))).toBeNull();
  });

  it("throws on any other failure, and on content that is not base64, so the caller can say the base was unread", async () => {
    const { fetch: forbidden } = recordingFetch(() => ({ status: 403, body: { message: "Resource not accessible" } }));
    expect(await rejection(clientWith(forbidden).fileAtRef(REPO, "nen/gates.json", "b"))).toMatchObject({ status: 403 });
    const { fetch: garbled } = recordingFetch(() => ({ body: { type: "file", encoding: "base64", content: "not*base64!" } }));
    expect(String(await rejection(clientWith(garbled).fileAtRef(REPO, "nen/gates.json", "b")))).toMatch(/not base64/);
    const { fetch: directory } = recordingFetch(() => ({ body: [{ name: "gates.json" }] }));
    expect(String(await rejection(clientWith(directory).fileAtRef(REPO, "nen", "b")))).toMatch(/directory listing, not a file/);
  });

  it("refuses a payload that is not a base64-encoded file, naming its type or size (N6)", async () => {
    const { fetch: symlink } = recordingFetch(() => ({ body: { type: "symlink", target: "../x", encoding: "base64", content: "" } }));
    expect(String(await rejection(clientWith(symlink).fileAtRef(REPO, "nen/gates.json", "b")))).toMatch(
      /is of type "symlink", not a file/,
    );
    const { fetch: big } = recordingFetch(() => ({ body: { type: "file", encoding: "none", content: "", size: 2_000_000 } }));
    expect(String(await rejection(clientWith(big).fileAtRef(REPO, "nen/gates.json", "b")))).toMatch(
      /encoding "none" \(size 2000000 bytes\), not base64/,
    );
  });
});

describe("GitHubClient.commitCheckRuns -- ONE page of a commit's check runs, raw (E7 option B)", () => {
  const payload = {
    total_count: 140,
    check_runs: [
      { name: "Cursor Bugbot", status: "completed", conclusion: "success", pull_requests: [{ number: 279 }] },
    ],
  };

  it("GETs commits/{sha}/check-runs with per_page:100 and returns the RAW { total_count, check_runs } payload", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ body: payload }));

    const result = await drive(clientWith(stub).commitCheckRuns(REPO, "2851d2e"));

    // Raw, so the walk can see `total_count` (L1's truncation warning) and
    // each run's `pull_requests` (H1's attribution).
    expect(result).toEqual(payload);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("GET");
    expect(calls[0]?.url).toContain("/repos/zheref/nen/commits/2851d2e/check-runs");
    expect(calls[0]?.url).toMatch(/per_page=100/);
  });

  it("reads ONE page only, even when GitHub advertises a next one -- the budget is one request per commit", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({
      body: payload,
      link: '<https://api.github.com/repositories/1/commits/2851d2e/check-runs?per_page=100&page=2>; rel="next"',
    }));

    await drive(clientWith(stub).commitCheckRuns(REPO, "2851d2e"));

    expect(calls).toHaveLength(1);
  });

  it("propagates a failed read -- the walk turns the throw into 'nothing further counted'", async () => {
    const { fetch: stub } = recordingFetch(() => ({ status: 404, body: { message: "No commit found for SHA" } }));

    expect(await rejection(clientWith(stub).commitCheckRuns(REPO, "deadbeef"))).toMatchObject({ status: 404 });
  });
});

describe("GitHubClient.reviews -- REST, because commit_id is what CON-16 turns on", () => {
  it("GETs pulls/{n}/reviews with per_page:100 and paginates, returning every review raw", async () => {
    const { fetch: stub, calls } = recordingFetch((_call, index) =>
      index === 0
        ? {
            body: [{ user: { login: "cursor[bot]", type: "Bot" }, state: "COMMENTED", commit_id: "0a77992" }],
            link: '<https://api.github.com/repositories/1/pulls/278/reviews?per_page=100&page=2>; rel="next"',
          }
        : { body: [{ user: { login: "zheref", type: "User" }, state: "COMMENTED", commit_id: "faaa4ff" }] },
    );

    const reviews = await drive(clientWith(stub).reviews(REPO, 278));

    expect(reviews).toEqual([
      { user: { login: "cursor[bot]", type: "Bot" }, state: "COMMENTED", commit_id: "0a77992" },
      { user: { login: "zheref", type: "User" }, state: "COMMENTED", commit_id: "faaa4ff" },
    ]);
    expect(calls[0]?.url).toContain("/repos/zheref/nen/pulls/278/reviews");
    expect(calls[0]?.url).toMatch(/per_page=100/);
    expect(calls).toHaveLength(2);
  });
});

describe("GitHubClient -- the GraphQL reads: one POST each, the query and variables asserted, the answer mapped", () => {
  const PR_RESPONSE = {
    data: {
      repository: {
        defaultBranchRef: { name: "main" },
        pullRequest: {
          number: 279,
          mergeable: "MERGEABLE",
          isDraft: false,
          headRefOid: "7cee8a5",
          headRefName: "fable/kurapika/x",
          baseRefName: "main",
          author: { login: "zheref" },
          labels: { nodes: [{ name: "priority:p1" }] },
          reviewRequests: {
            nodes: [{ requestedReviewer: { login: "Copilot" } }, { requestedReviewer: { name: "core" } }],
            pageInfo: { hasNextPage: false, endCursor: "rr1" },
          },
          statusCheckRollup: {
            nodes: [
              {
                commit: {
                  statusCheckRollup: {
                    contexts: {
                      nodes: [{ __typename: "CheckRun", name: "compile", status: "COMPLETED", conclusion: "SUCCESS" }],
                      pageInfo: { hasNextPage: true, endCursor: "ctx1" },
                    },
                  },
                },
              },
            ],
          },
        },
      },
    },
  };

  it("pullRequestSnapshot POSTs PULL_REQUEST_QUERY with {owner, name, pr} and maps all three slices", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ body: PR_RESPONSE }));

    const snapshot = await drive(clientWith(stub).pullRequestSnapshot(REPO, 279));

    expect(calls).toHaveLength(1);
    expect(calls[0]?.method).toBe("POST");
    expect(calls[0]?.url).toMatch(/\/graphql$/);
    expect(calls[0]?.body).toEqual({
      query: PULL_REQUEST_QUERY,
      variables: { owner: "zheref", name: "nen", pr: 279 },
    });
    expect(snapshot.defaultBranch).toBe("main");
    expect(snapshot.pullRequest).toMatchObject({
      number: 279,
      headRefOid: "7cee8a5",
      labels: [{ name: "priority:p1" }],
      reviewRequests: [{ login: "Copilot" }, { name: "core" }],
    });
    expect(snapshot.checkRollup).toEqual([
      { __typename: "CheckRun", name: "compile", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    expect(snapshot.checkRollupPageInfo).toEqual({ hasNextPage: true, endCursor: "ctx1" });
    expect(snapshot.reviewRequests).toEqual([{ login: "Copilot" }, { name: "core" }]);
    expect(snapshot.reviewRequestsPageInfo).toEqual({ hasNextPage: false, endCursor: "rr1" });
  });

  it("the three accessors each pay their OWN round trip and hand back their slice", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ body: PR_RESPONSE }));
    const client = clientWith(stub);

    expect(await drive(client.pullRequest(REPO, 279))).toMatchObject({ number: 279, mergeable: "MERGEABLE" });
    expect(await drive(client.checkRollup(REPO, 279))).toEqual([
      { __typename: "CheckRun", name: "compile", status: "COMPLETED", conclusion: "SUCCESS" },
    ]);
    expect(await drive(client.reviewRequests(REPO, 279))).toEqual([{ login: "Copilot" }, { name: "core" }]);
    // BC-PR-#802: one trip per accessor, never one shared -- the header says so.
    expect(calls).toHaveLength(3);
  });

  it("a response that carries no pull request maps to `undefined`, never a guess", async () => {
    const { fetch: stub } = recordingFetch(() => ({ body: { data: { repository: { pullRequest: null } } } }));

    expect(await drive(clientWith(stub).pullRequest(REPO, 404404))).toBeUndefined();
  });

  it("a GraphQL error response propagates as a throw -- the transport decides nothing", async () => {
    const { fetch: stub } = recordingFetch(() => ({
      body: { data: null, errors: [{ type: "NOT_FOUND", message: "Could not resolve to a Repository" }] },
    }));

    const error = await rejection(clientWith(stub).pullRequestSnapshot(REPO, 1));
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/Could not resolve to a Repository/);
  });

  it("reviewThreadsPage POSTs REVIEW_THREADS_QUERY, defaults the cursor to null, and maps nodes and pageInfo", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewThreads: {
                nodes: [{ id: "t1", isResolved: false }],
                pageInfo: { hasNextPage: true, endCursor: "th1" },
              },
            },
          },
        },
      },
    }));
    const client = clientWith(stub);

    const first = await drive(client.reviewThreadsPage(REPO, 278));
    await drive(client.reviewThreadsPage(REPO, 278, "th1"));

    expect(first).toEqual({ nodes: [{ id: "t1", isResolved: false }], hasNextPage: true, endCursor: "th1" });
    expect(calls[0]?.body).toEqual({
      query: REVIEW_THREADS_QUERY,
      variables: { owner: "zheref", name: "nen", pr: 278, cursor: null },
    });
    expect(calls[1]?.body).toMatchObject({ variables: { cursor: "th1" } });
  });

  it("checkRollupPage POSTs CHECK_ROLLUP_PAGE_QUERY with the cursor and maps the head commit's page", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({
      body: {
        data: {
          repository: {
            pullRequest: {
              statusCheckRollup: {
                nodes: [
                  {
                    commit: {
                      statusCheckRollup: {
                        contexts: {
                          nodes: [{ __typename: "StatusContext", context: "ext/ci", state: "SUCCESS" }],
                          pageInfo: { hasNextPage: false, endCursor: "ctx2" },
                        },
                      },
                    },
                  },
                ],
              },
            },
          },
        },
      },
    }));

    const page = await drive(clientWith(stub).checkRollupPage(REPO, 927, "ctx1"));

    expect(calls[0]?.body).toEqual({
      query: CHECK_ROLLUP_PAGE_QUERY,
      variables: { owner: "zheref", name: "nen", pr: 927, cursor: "ctx1" },
    });
    expect(page).toEqual({
      nodes: [{ __typename: "StatusContext", context: "ext/ci", state: "SUCCESS" }],
      hasNextPage: false,
      endCursor: "ctx2",
    });
  });

  it("reviewRequestsPage POSTs REVIEW_REQUESTS_PAGE_QUERY with the cursor and flattens requestedReviewer", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({
      body: {
        data: {
          repository: {
            pullRequest: {
              reviewRequests: {
                nodes: [{ requestedReviewer: { login: "cursor" } }],
                pageInfo: { hasNextPage: false, endCursor: "rr2" },
              },
            },
          },
        },
      },
    }));

    const page = await drive(clientWith(stub).reviewRequestsPage(REPO, 12, "rr1"));

    expect(calls[0]?.body).toEqual({
      query: REVIEW_REQUESTS_PAGE_QUERY,
      variables: { owner: "zheref", name: "nen", pr: 12, cursor: "rr1" },
    });
    expect(page).toEqual({ nodes: [{ login: "cursor" }], hasNextPage: false, endCursor: "rr2" });
  });
});

describe("GitHubClient -- the identity and the endpoint every call carries", () => {
  it("sends the EXPLICIT token and this build's own user-agent, and honours baseUrl", async () => {
    const { fetch: stub, calls } = recordingFetch(() => ({ body: [] }));
    const client = new GitHubClient("ghs_explicit", {
      baseUrl: "https://ghe.example.test/api/v3",
      request: { fetch: stub },
    });

    await drive(client.reviews(REPO, 1));

    expect(calls[0]?.url.startsWith("https://ghe.example.test/api/v3/repos/zheref/nen/pulls/1/reviews")).toBe(true);
    expect(calls[0]?.headers["authorization"]).toBe("token ghs_explicit");
    expect(calls[0]?.headers["user-agent"]).toContain(`${PROGRAM}/${VERSION}`);
  });

  it("createClient mints a real GitHubClient -- the production entry point never takes a fetch stub", () => {
    expect(createClient("ghs_x")).toBeInstanceOf(GitHubClient);
    expect(createClient("ghs_x", { baseUrl: "https://ghe.example.test/api/v3" })).toBeInstanceOf(GitHubClient);
  });
});
