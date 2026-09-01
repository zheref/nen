// ============================================================================
// SEEDED FROM bankai-core `cli/src/github/parse.test.ts` (zheref/nen#1, Akatsuki migration P1).
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
// Tests for the validating boundary (BC-IS-#736, epic BC-IS-#733 Phase 1).
//
// The cases are built from the RAW JSON shapes tests/pr_ready_gate.bats feeds
// the shell, because the property under test is precisely the one the shell
// cannot have: a payload that is not the shape we modelled produces a NAMED
// ERROR instead of an `undefined` that a `//` turns into a value. Several cases
// assert that end to end -- parse, then run the predicate -- since "it did not
// read as green" is the assertion that matters, not "it returned an object".

import { describe, expect, it } from "vitest";
import { checksAllGreen } from "../gates/predicates.js";
import {
  parseCheckRollup,
  parsePullRequest,
  parseReview,
  parseReviewRequests,
  parseReviewThreads,
  parseReviews,
  type ParseResult,
} from "./parse.js";

function expectOk<T>(result: ParseResult<T>): T {
  if (!result.ok) {
    throw new Error(`expected a parse, got ${result.error.path}: ${result.error.message}`);
  }
  return result.value;
}

function expectError<T>(result: ParseResult<T>): { path: string; message: string } {
  if (result.ok) {
    throw new Error(`expected a parse error, got ${JSON.stringify(result.value)}`);
  }
  return { path: result.error.path, message: result.error.message };
}

// --- check rollup ------------------------------------------------------------

describe("parseCheckRollup", () => {
  it("parses a completed CheckRun", () => {
    const entries = expectOk(
      parseCheckRollup([
        {
          name: "kisuke / build",
          status: "COMPLETED",
          conclusion: "SUCCESS",
          startedAt: "2026-08-22T23:03:05Z",
          completedAt: "2026-08-22T23:09:00Z",
          detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
        },
      ]),
    );

    expect(entries[0]).toEqual({
      kind: "check_run",
      name: "kisuke / build",
      status: "COMPLETED",
      conclusion: "SUCCESS",
      startedAt: "2026-08-22T23:03:05Z",
      completedAt: "2026-08-22T23:09:00Z",
      detailsUrl: "https://github.com/o/r/actions/runs/1/job/2",
    });
  });

  it("parses an IN-FLIGHT CheckRun -- an absent conclusion becomes null, never a verdict", () => {
    // The `//` chain in shell turns this into "", and "" is one comparison away
    // from being treated as a value. Here it is null and stays null.
    const entries = expectOk(
      parseCheckRollup([{ name: "kisuke / build", status: "IN_PROGRESS" }]),
    );

    expect(entries[0]).toMatchObject({ kind: "check_run", conclusion: null });
    expect(checksAllGreen(entries)).toBe(false);
  });

  it("parses an EXPLICIT null conclusion the same way as an absent one", () => {
    const entries = expectOk(
      parseCheckRollup([
        { name: "kisuke / build", conclusion: null, status: "IN_PROGRESS" },
      ]),
    );

    expect(entries[0]).toMatchObject({ conclusion: null });
  });

  it("parses a legacy StatusContext, which carries .state and .targetUrl and never .conclusion", () => {
    const entries = expectOk(
      parseCheckRollup([
        {
          context: "external-ci/status",
          state: "SUCCESS",
          targetUrl: "https://ci.example/build/1",
        },
      ]),
    );

    expect(entries[0]).toEqual({
      kind: "status_context",
      context: "external-ci/status",
      state: "SUCCESS",
      startedAt: null,
      completedAt: null,
      targetUrl: "https://ci.example/build/1",
    });
  });

  it("honours __typename when GraphQL supplied it", () => {
    const entries = expectOk(
      parseCheckRollup([
        { __typename: "CheckRun", name: "unit_tests", conclusion: "SUCCESS" },
      ]),
    );

    expect(entries[0]).toMatchObject({ kind: "check_run", name: "unit_tests" });
  });

  it("treats a NULL rollup as the EMPTY rollup, which is never green (bankai-core#671, BC-PR-#745)", () => {
    // GitHub answers `statusCheckRollup: null` on a PR with no runs at all. It
    // is a real state, not a shape change -- and it must survive to the
    // predicate as [], which checksAllGreen() refuses.
    const entries = expectOk(parseCheckRollup(null));

    expect(entries).toEqual([]);
    expect(checksAllGreen(entries)).toBe(false);
  });

  it("treats an ABSENT rollup the same way", () => {
    expect(expectOk(parseCheckRollup(undefined))).toEqual([]);
  });

  it("REFUSES a rollup that is not an array", () => {
    const error = expectError(parseCheckRollup({ nodes: [] }));

    expect(error.message).toContain("expected an array");
  });

  it("REFUSES an unrecognised conclusion rather than reading it as not-green in silence", () => {
    // The shell reads an unknown value through `//` and says nothing, which is
    // conservative but silent; a gate that cannot explain itself is the failure
    // class bankai-core#639/#698 are both about.
    const error = expectError(
      parseCheckRollup([{ name: "kisuke / build", conclusion: "BLOWN_UP" }]),
    );

    expect(error.path).toBe("$.statusCheckRollup[0].conclusion");
    expect(error.message).toContain("BLOWN_UP");
  });

  it("REFUSES a lowercase REST spelling -- the gate compares against the GraphQL enum and nothing else", () => {
    // Accepting `success` here would widen the gate by a reading the shell never
    // gave it. A parse error is loud; it can never be mistaken for green.
    const result = parseCheckRollup([{ name: "kisuke / build", conclusion: "success" }]);

    expect(result.ok).toBe(false);
  });

  it("REFUSES an entry carrying neither a CheckRun nor a StatusContext tell", () => {
    const error = expectError(parseCheckRollup([{ name: "kisuke / build" }]));

    expect(error.message).toContain("neither");
  });

  it("REFUSES a non-object entry", () => {
    expect(parseCheckRollup(["kisuke / build"]).ok).toBe(false);
  });

  it("names the OFFENDING INDEX, so a 400-entry rollup does not have to be searched by hand", () => {
    const error = expectError(
      parseCheckRollup([
        { name: "a", conclusion: "SUCCESS" },
        { name: "b", conclusion: "SUCCESS" },
        { name: "c", conclusion: 7 },
      ]),
    );

    expect(error.path).toBe("$.statusCheckRollup[2].conclusion");
  });

  it("fails the WHOLE rollup on one bad entry -- a rollup that parsed mostly is not one a readiness claim can be made on", () => {
    const result = parseCheckRollup([
      { name: "a", conclusion: "SUCCESS" },
      { name: "b", conclusion: "NOPE" },
    ]);

    expect(result.ok).toBe(false);
  });

  it("REFUSES a non-string check name", () => {
    const error = expectError(parseCheckRollup([{ name: 7, conclusion: "SUCCESS" }]));

    expect(error.path).toBe("$.statusCheckRollup[0].name");
  });

  it("accepts an unnamed rollup entry -- the bats fixtures carry them and the reduction keeps them apart", () => {
    const entries = expectOk(parseCheckRollup([{ conclusion: "SUCCESS" }]));

    expect(entries[0]).toMatchObject({ name: null, conclusion: "SUCCESS" });
    expect(checksAllGreen(entries)).toBe(true);
  });
});

// --- reviews -----------------------------------------------------------------

describe("parseReviews", () => {
  it("parses the flattened {author,state,commit_id,submitted_at} blob every fixture uses", () => {
    const reviews = expectOk(
      parseReviews([
        {
          author: "sasuke-bankai[bot]",
          state: "APPROVED",
          commit_id: "headsha",
          submitted_at: "2026-08-14T01:00:00Z",
        },
      ]),
    );

    expect(reviews[0]).toEqual({
      author: "sasuke-bankai[bot]",
      state: "APPROVED",
      commitId: "headsha",
      submittedAt: "2026-08-14T01:00:00Z",
    });
  });

  it("parses the REST review object, whose login lives at .user.login", () => {
    const reviews = expectOk(
      parseReviews([
        {
          user: { login: "tenma-bankai[bot]" },
          state: "APPROVED",
          commit_id: "headsha",
          submitted_at: "2026-08-14T01:05:00Z",
        },
      ]),
    );

    expect(reviews[0]).toMatchObject({ author: "tenma-bankai[bot]" });
  });

  it("REFUSES a review with no author in either shape", () => {
    const error = expectError(
      parseReviews([{ state: "APPROVED", commit_id: "headsha" }]),
    );

    expect(error.path).toBe("$.reviews[0].user");
  });

  it("REFUSES an unrecognised review state", () => {
    const error = expectError(
      parseReviews([{ author: "sasuke-bankai[bot]", state: "LGTM" }]),
    );

    expect(error.path).toBe("$.reviews[0].state");
  });

  it("REQUIRES the state -- an absent one must not default to anything", () => {
    expect(parseReviews([{ author: "sasuke-bankai[bot]" }]).ok).toBe(false);
  });

  it("leaves commit_id and submitted_at null when absent -- a PENDING review has neither, and null matches no head SHA", () => {
    const reviews = expectOk(
      parseReviews([{ author: "sasuke-bankai[bot]", state: "PENDING" }]),
    );

    expect(reviews[0]).toMatchObject({ commitId: null, submittedAt: null });
  });

  it("treats an absent review list as no reviews", () => {
    expect(expectOk(parseReviews(null))).toEqual([]);
    expect(expectOk(parseReviews(undefined))).toEqual([]);
  });

  it("REFUSES a review list that is not an array", () => {
    expect(parseReviews({ nodes: [] }).ok).toBe(false);
  });

  it("REFUSES an empty author string -- an empty login matches no reviewer pattern", () => {
    expect(parseReview({ author: "", state: "APPROVED" }).ok).toBe(false);
  });
});

// --- review threads ----------------------------------------------------------

describe("parseReviewThreads (CON-32d)", () => {
  it("parses the GraphQL nodes", () => {
    const threads = expectOk(
      parseReviewThreads([
        { id: "PRRT_1", isResolved: false },
        { id: "PRRT_2", isResolved: true },
      ]),
    );

    expect(threads).toEqual([
      { id: "PRRT_1", isResolved: false },
      { id: "PRRT_2", isResolved: true },
    ]);
  });

  it("REQUIRES isResolved -- a thread whose resolution cannot be read must never be counted as resolved", () => {
    const error = expectError(parseReviewThreads([{ id: "PRRT_1" }]));

    expect(error.path).toBe("$.reviewThreads.nodes[0].isResolved");
  });

  it("REFUSES a non-boolean isResolved", () => {
    expect(parseReviewThreads([{ isResolved: "false" }]).ok).toBe(false);
  });

  it("treats an absent node list as no threads", () => {
    expect(expectOk(parseReviewThreads(null))).toEqual([]);
  });

  it("leaves an absent id null -- the id is for the caller's reporting, never for the verdict", () => {
    expect(expectOk(parseReviewThreads([{ isResolved: true }]))[0]).toEqual({
      id: null,
      isResolved: true,
    });
  });
});

// --- review requests ---------------------------------------------------------

describe("parseReviewRequests (bankai-core#564)", () => {
  it("parses the bare login string the gate's own state blob carries", () => {
    expect(expectOk(parseReviewRequests(["Copilot"]))).toEqual([
      { login: "Copilot", name: null },
    ]);
  });

  it("parses gh's {login} for a user or bot", () => {
    expect(expectOk(parseReviewRequests([{ login: "Copilot" }]))).toEqual([
      { login: "Copilot", name: null },
    ]);
  });

  it("parses gh's {name} for a team", () => {
    expect(expectOk(parseReviewRequests([{ name: "reviewers" }]))).toEqual([
      { login: null, name: "reviewers" },
    ]);
  });

  it("REFUSES a request naming NOBODY -- it would silently drop the only pre-post footprint an un-posted round has", () => {
    const error = expectError(parseReviewRequests([{}]));

    expect(error.message).toContain("neither");
  });

  it("REFUSES an empty login string, for the same reason", () => {
    expect(parseReviewRequests([""]).ok).toBe(false);
  });

  it("REFUSES a request that is neither an object nor a string", () => {
    expect(parseReviewRequests([7]).ok).toBe(false);
  });

  it("treats an absent request list as no pending requests", () => {
    expect(expectOk(parseReviewRequests(null))).toEqual([]);
  });
});

// --- pull request ------------------------------------------------------------

describe("parsePullRequest", () => {
  const ghShape = {
    number: 736,
    headRefOid: "headsha",
    headRefName: "integration/epic-193",
    baseRefName: "main",
    author: { login: "app/roy-bankai" },
    labels: [{ name: "bankai:epic" }],
    mergeable: "MERGEABLE",
    isDraft: false,
  };

  it("parses gh's `pr view --json` camelCase shape", () => {
    expect(expectOk(parsePullRequest(ghShape))).toEqual({
      number: 736,
      headSha: "headsha",
      headRef: "integration/epic-193",
      baseRef: "main",
      author: "app/roy-bankai",
      labels: ["bankai:epic"],
      mergeable: "MERGEABLE",
      isDraft: false,
    });
  });

  it("parses the flattened snake_case state blob the gate emits", () => {
    expect(
      expectOk(
        parsePullRequest({
          number: 736,
          head_sha: "headsha",
          head_ref: "integration/epic-193",
          base_ref: "main",
          author: "roy-bankai[bot]",
          labels: ["bankai:epic"],
          mergeable: "MERGEABLE",
        }),
      ),
    ).toMatchObject({ headSha: "headsha", author: "roy-bankai[bot]", isDraft: false });
  });

  it("leaves an ABSENT author null -- absent evidence must never widen a gate (bankai-core#720)", () => {
    // A degraded `gh pr view` yields no author. The CON-40 carve-out requires
    // one, so null keeps the ordinary at-head rounds binding rather than taking
    // the whole verdict away.
    const { author } = expectOk(parsePullRequest({ ...ghShape, author: undefined }));

    expect(author).toBeNull();
  });

  it("treats an EMPTY author string as absent, for the same reason", () => {
    expect(expectOk(parsePullRequest({ ...ghShape, author: "" })).author).toBeNull();
  });

  it("treats absent labels as no labels", () => {
    expect(expectOk(parsePullRequest({ ...ghShape, labels: undefined })).labels).toEqual(
      [],
    );
  });

  it("REFUSES an unrecognised mergeable state", () => {
    const error = expectError(parsePullRequest({ ...ghShape, mergeable: "yes" }));

    expect(error.path).toBe("$.mergeable");
  });

  it("REQUIRES mergeable -- CON-42/1's conflict-free predicate has no safe default", () => {
    expect(parsePullRequest({ ...ghShape, mergeable: undefined }).ok).toBe(false);
  });

  it("REFUSES a PR with no head SHA in either spelling", () => {
    const error = expectError(
      parsePullRequest({ ...ghShape, headRefOid: undefined }),
    );

    expect(error.message).toContain("head_sha");
  });

  it("REFUSES a non-integer PR number", () => {
    expect(parsePullRequest({ ...ghShape, number: "736" }).ok).toBe(false);
  });

  it("reads a draft PR from either spelling", () => {
    expect(expectOk(parsePullRequest({ ...ghShape, isDraft: true })).isDraft).toBe(true);
    expect(
      expectOk(parsePullRequest({ ...ghShape, isDraft: undefined, draft: true })).isDraft,
    ).toBe(true);
  });

  it("REFUSES a non-object", () => {
    expect(parsePullRequest("736").ok).toBe(false);
  });
});
