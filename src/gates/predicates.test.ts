// Tests for the CON-32 readiness predicates (BC-IS-#736, epic BC-IS-#733
// Phase 1), ported case-for-case from tests/pr_ready_gate.bats.
//
// Every case whose bats counterpart exercises one of these predicates -- directly
// or through `evaluate_ready` in a way expressible without the composition -- is
// reproduced here, and the field-lesson cases are reproduced with the SAME
// fixtures the bats suite uses (the live shapes observed on bankai-core#577,
// #708, #720, KP-PR-#460), so a divergence shows up as a failing assertion
// rather than as a difference nobody looked for. Cases with no bats counterpart
// are marked ADDED: the bats suite is a floor, not a ceiling (BC-9).

import { describe, expect, it } from "vitest";
import type {
  CheckRun,
  Review,
  ReviewRequest,
  RollupEntry,
  StatusContext,
} from "../github/types.js";
import {
  cancelledLatestReport,
  checksAllGreen,
  defaultReviewers,
  excludeCheckRun,
  isDeliveryPr,
  latestChecks,
  normalizeReviewerNames,
  normalizeReviewers,
  pendingRounds,
  reviewerLoginPattern,
  reviewerReviewCheckPattern,
  reviewsAllApprovedAtHead,
  unapprovedApprovers,
  defaultApprovers,
  type OwedRound,
  type RoundInputs,
} from "./predicates.js";
import { loadGateIdentities } from "../schema/gates.js";
import { ALT_REPO, BANKAI_REPO } from "../schema/fixtures/paths.js";

// --- the identities every case below is run against --------------------------
//
// PORT CHANGE (zheref/nen#1). Every reviewer-aware predicate now takes a
// `GateIdentities` as its first argument, and this is the one the ported cases
// use: a fixture repository whose `schemas/gates.json` states EXACTLY the
// identities the original wrote into its own source. That is what makes this
// suite a regression test for the refactor rather than merely a test of new
// code -- the assertions below are the originals, unchanged, so a behavioural
// divergence shows up here instead of in production.
//
// `ALT` is the same structure with entirely different names, used by the
// NAMES ARE DATA section at the end of this file. Nothing in the shipped tree
// knows any of its strings, so a predicate that behaves identically against
// both cannot be carrying reviewer knowledge of its own.
const BANKAI = loadGateIdentities(BANKAI_REPO);
const ALT = loadGateIdentities(ALT_REPO);

// --- fixtures ----------------------------------------------------------------

function checkRun(fields: Partial<Omit<CheckRun, "kind">> = {}): CheckRun {
  return {
    kind: "check_run",
    name: null,
    status: null,
    conclusion: null,
    startedAt: null,
    completedAt: null,
    detailsUrl: null,
    ...fields,
  };
}

function statusContext(
  fields: Partial<Omit<StatusContext, "kind">> = {},
): StatusContext {
  return {
    kind: "status_context",
    context: null,
    state: null,
    startedAt: null,
    completedAt: null,
    targetUrl: null,
    ...fields,
  };
}

function review(fields: Partial<Review> = {}): Review {
  return {
    author: "sasuke-bankai[bot]",
    state: "APPROVED",
    commitId: "headsha",
    submittedAt: "2026-08-14T01:00:00Z",
    ...fields,
  };
}

function request(login: string): ReviewRequest {
  return { login, name: null };
}

function rounds(
  overrides: Partial<RoundInputs> = {},
): RoundInputs {
  return { reviewRequests: [], checks: [], reviews: [], ...overrides };
}

function owedNames(owed: readonly OwedRound[]): string[] {
  return owed.map((entry): string => entry.reviewer);
}

// The KP-PR-#460 shape, as tests/pr_ready_gate.bats' `delivery_state` builds it:
// a product-epic delivery PR one `synchronize` past `opened`, with both
// reviewers' holistic pass on `opensha` and their abstain-green review checks at
// `headsha`.
const DELIVERY_CHECKS: RollupEntry[] = [
  checkRun({ name: "sasuke / audit", conclusion: "SUCCESS", status: "COMPLETED" }),
  checkRun({ name: "tenma / review", conclusion: "SUCCESS", status: "COMPLETED" }),
];
const DELIVERY_REVIEWS: Review[] = [
  review({
    author: "sasuke-bankai[bot]",
    commitId: "opensha",
    submittedAt: "2026-08-25T02:41:03Z",
  }),
  review({
    author: "tenma-bankai[bot]",
    commitId: "opensha",
    submittedAt: "2026-08-25T02:42:00Z",
  }),
];

// --- latestChecks ------------------------------------------------------------

describe("latestChecks", () => {
  it("discards a CANCELLED attempt that started AFTER the SUCCESS -- concurrency retires the superseded run, it is not a verdict", () => {
    // The live shape observed on bankai-core#577's own head: five overlapping
    // runs inside 90s, so `kisuke / probe / probe` has a SUCCESS started
    // 23:03:05Z and a CANCELLED started 23:03:19Z. Ordering by time alone picks
    // the CANCELLED one and reports not-ready forever.
    const reduced = latestChecks([
      checkRun({
        name: "kisuke / probe / probe",
        conclusion: "SUCCESS",
        status: "COMPLETED",
        startedAt: "2026-08-22T23:03:05Z",
      }),
      checkRun({
        name: "kisuke / probe / probe",
        conclusion: "CANCELLED",
        status: "COMPLETED",
        startedAt: "2026-08-22T23:03:19Z",
      }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ conclusion: "SUCCESS" });
  });

  it("keeps a CANCELLED entry when EVERY attempt for that name was cancelled -- never green on no verdict", () => {
    const reduced = latestChecks([
      checkRun({
        name: "flaky / probe",
        conclusion: "CANCELLED",
        startedAt: "2026-08-22T23:03:05Z",
      }),
      checkRun({
        name: "flaky / probe",
        conclusion: "CANCELLED",
        startedAt: "2026-08-22T23:03:19Z",
      }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ conclusion: "CANCELLED" });
  });

  it("lets an IN-FLIGHT rerun supersede an earlier SUCCESS -- work in progress is not green", () => {
    const reduced = latestChecks([
      checkRun({
        name: "sasuke / audit",
        conclusion: "SUCCESS",
        status: "COMPLETED",
        startedAt: "2026-08-22T23:03:05Z",
      }),
      checkRun({
        name: "sasuke / audit",
        conclusion: null,
        status: "IN_PROGRESS",
        startedAt: "2026-08-22T23:03:19Z",
      }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ status: "IN_PROGRESS" });
  });

  it("ADDED: groups a legacy StatusContext by its .context, the way the display label does", () => {
    const reduced = latestChecks([
      statusContext({
        context: "external-ci/status",
        state: "FAILURE",
        startedAt: "2026-08-22T10:00:00Z",
      }),
      statusContext({
        context: "external-ci/status",
        state: "SUCCESS",
        startedAt: "2026-08-22T11:00:00Z",
      }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ state: "SUCCESS" });
  });

  it("ADDED: never collapses UNNAMED entries into one another -- each keeps its own group", () => {
    const reduced = latestChecks([
      checkRun({ conclusion: "SUCCESS" }),
      checkRun({ conclusion: "FAILURE" }),
    ]);

    expect(reduced).toHaveLength(2);
  });

  it("ADDED: breaks a startedAt tie on completedAt", () => {
    const reduced = latestChecks([
      checkRun({
        name: "kisuke / build",
        conclusion: "FAILURE",
        startedAt: "2026-08-22T10:00:00Z",
        completedAt: "2026-08-22T10:05:00Z",
      }),
      checkRun({
        name: "kisuke / build",
        conclusion: "SUCCESS",
        startedAt: "2026-08-22T10:00:00Z",
        completedAt: "2026-08-22T10:09:00Z",
      }),
    ]);

    expect(reduced[0]).toMatchObject({ conclusion: "SUCCESS" });
  });

  it("ADDED: falls back to the entry's position when both timestamps are absent -- the last reported wins, as jq's sort key does", () => {
    const reduced = latestChecks([
      checkRun({ name: "kisuke / build", conclusion: "FAILURE" }),
      checkRun({ name: "kisuke / build", conclusion: "SUCCESS" }),
    ]);

    expect(reduced).toHaveLength(1);
    expect(reduced[0]).toMatchObject({ conclusion: "SUCCESS" });
  });

  it("ADDED: an empty rollup reduces to an empty rollup, never to a synthetic entry", () => {
    expect(latestChecks([])).toEqual([]);
  });
});

// --- checksAllGreen ----------------------------------------------------------

describe("checksAllGreen (CON-32a)", () => {
  it("is true when every check is SUCCESS", () => {
    expect(
      checksAllGreen([
        checkRun({ name: "a", conclusion: "SUCCESS" }),
        checkRun({ name: "b", conclusion: "SUCCESS" }),
      ]),
    ).toBe(true);
  });

  it("accepts NEUTRAL and SKIPPED alongside SUCCESS", () => {
    expect(
      checksAllGreen([
        checkRun({ name: "a", conclusion: "SUCCESS" }),
        checkRun({ name: "b", conclusion: "NEUTRAL" }),
        checkRun({ name: "c", conclusion: "SKIPPED" }),
      ]),
    ).toBe(true);
  });

  it("reads a legacy StatusContext's .state where a CheckRun has .conclusion", () => {
    expect(checksAllGreen([statusContext({ context: "ci", state: "SUCCESS" })])).toBe(
      true,
    );
  });

  it("is false when any check is not green", () => {
    expect(
      checksAllGreen([
        checkRun({ name: "a", conclusion: "SUCCESS" }),
        checkRun({ name: "b", conclusion: "FAILURE" }),
      ]),
    ).toBe(false);
  });

  it("is false for an EMPTY array -- no signal is not green (bankai-core#671)", () => {
    // The field lesson in one assertion: "no reported check" is not evidence
    // that checks passed. BC-PR-#660 and BC-PR-#610 each sat 11 hours on a
    // startup_failure that produced no job, no log and no check run.
    expect(checksAllGreen([])).toBe(false);
  });

  it("is false for an in-flight run -- a null conclusion is a run still deciding, not a pass (bankai-core#727)", () => {
    expect(
      checksAllGreen([
        checkRun({ name: "kisuke / build", conclusion: null, status: "IN_PROGRESS" }),
      ]),
    ).toBe(false);
  });

  it("is true when a check name has any non-CANCELLED attempt at the head, whichever started last (regression)", () => {
    expect(
      checksAllGreen([
        checkRun({
          name: "kisuke / probe / probe",
          conclusion: "SUCCESS",
          startedAt: "2026-08-22T23:03:05Z",
        }),
        checkRun({
          name: "kisuke / probe / probe",
          conclusion: "CANCELLED",
          startedAt: "2026-08-22T23:03:19Z",
        }),
      ]),
    ).toBe(true);
  });

  it("is false when every attempt for a name was CANCELLED -- a cancellation carries no verdict (bankai-core#698)", () => {
    expect(
      checksAllGreen([
        checkRun({ name: "kisuke / probe / probe", conclusion: "CANCELLED" }),
        checkRun({ name: "kisuke / probe / probe", conclusion: "CANCELLED" }),
      ]),
    ).toBe(false);
  });

  it("ADDED: is false for a legacy StatusContext still PENDING", () => {
    expect(checksAllGreen([statusContext({ context: "ci", state: "PENDING" })])).toBe(
      false,
    );
  });

  it("ADDED: an in-flight run alongside greens still blocks -- the gate waits for it", () => {
    expect(
      checksAllGreen([
        checkRun({ name: "sasuke / audit", conclusion: "SUCCESS" }),
        checkRun({ name: "kisuke / build", conclusion: null, status: "IN_PROGRESS" }),
      ]),
    ).toBe(false);
  });
});

// --- excludeCheckRun ---------------------------------------------------------

describe("excludeCheckRun (CON-36 self-run carve-out, bankai-core#708)", () => {
  const selfRun = "32789507863";
  const otherRun = "32789485088";
  const rollup: RollupEntry[] = [
    checkRun({
      name: "kisuke / build",
      detailsUrl: `https://github.com/zheref/bankai-core/actions/runs/${selfRun}/job/97631309568`,
    }),
    checkRun({
      name: "sasuke / audit",
      detailsUrl: `https://github.com/zheref/bankai-core/actions/runs/${otherRun}/job/97629838319`,
    }),
  ];

  it("drops every entry whose detailsUrl names the given run id", () => {
    const kept = excludeCheckRun(rollup, selfRun);

    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ name: "sasuke / audit" });
  });

  it("is a no-op when RUN_ID is empty -- every other caller of this gate is unaffected", () => {
    expect(excludeCheckRun(rollup, "")).toHaveLength(2);
    expect(excludeCheckRun(rollup, null)).toHaveLength(2);
    expect(excludeCheckRun(rollup, undefined)).toHaveLength(2);
  });

  it("never touches a legacy StatusContext (no detailsUrl) even when a run id is given", () => {
    const contexts: RollupEntry[] = [
      statusContext({ context: "external-ci/status", state: "SUCCESS" }),
    ];

    expect(excludeCheckRun(contexts, selfRun)).toHaveLength(1);
  });

  it("ADDED: drops EVERY job and attempt the run posted, not just the first", () => {
    const kept = excludeCheckRun(
      [
        checkRun({
          name: "kisuke / build",
          detailsUrl: `https://x/actions/runs/${selfRun}/job/1`,
        }),
        checkRun({
          name: "kisuke / probe",
          detailsUrl: `https://x/actions/runs/${selfRun}/job/2`,
        }),
      ],
      selfRun,
    );

    expect(kept).toEqual([]);
  });

  it("ADDED: matches a detailsUrl that ENDS at the run id, with no /job suffix", () => {
    expect(
      excludeCheckRun(
        [checkRun({ detailsUrl: `https://x/actions/runs/${selfRun}` })],
        selfRun,
      ),
    ).toEqual([]);
  });

  it("ADDED: a run id that is a PREFIX of another run's id is not excluded -- the exclusion is narrow, never a prefix skip", () => {
    const kept = excludeCheckRun(
      [checkRun({ name: "sasuke / audit", detailsUrl: "https://x/actions/runs/9991/job/1" })],
      "999",
    );

    expect(kept).toHaveLength(1);
  });

  it("ADDED: a non-numeric run id can only ever match LESS -- the pattern is literal, never a regex the caller injected", () => {
    // `main`'s numeric validation belongs to the caller; escaping here means a
    // metacharacter cannot widen the exclusion into a wildcard that drops a
    // still-blocking check.
    const kept = excludeCheckRun(
      [checkRun({ detailsUrl: "https://x/actions/runs/12345/job/1" })],
      ".*",
    );

    expect(kept).toHaveLength(1);
  });

  it("a self-job in flight AND excluded reads green -- the #708 shape", () => {
    const excluded = excludeCheckRun(
      [
        checkRun({
          name: "kisuke / build",
          status: "IN_PROGRESS",
          detailsUrl: `https://github.com/zheref/bankai-core/actions/runs/${selfRun}/job/97631309568`,
        }),
        checkRun({
          name: "sasuke / audit",
          conclusion: "SUCCESS",
          detailsUrl: `https://github.com/zheref/bankai-core/actions/runs/${otherRun}/job/97629838319`,
        }),
      ],
      selfRun,
    );

    expect(checksAllGreen(excluded)).toBe(true);
  });

  it("a self-job in flight and NOT excluded stays not-green -- the default is unchanged", () => {
    const untouched = excludeCheckRun(
      [
        checkRun({
          name: "kisuke / build",
          status: "IN_PROGRESS",
          detailsUrl: `https://github.com/zheref/bankai-core/actions/runs/${selfRun}/job/1`,
        }),
        checkRun({ name: "sasuke / audit", conclusion: "SUCCESS" }),
      ],
      null,
    );

    expect(checksAllGreen(untouched)).toBe(false);
  });

  it("a NON-self job in flight stays blocking even with an exclusion set", () => {
    const excluded = excludeCheckRun(
      [
        checkRun({
          name: "kisuke / build",
          conclusion: "SUCCESS",
          detailsUrl: `https://github.com/zheref/bankai-core/actions/runs/${selfRun}/job/1`,
        }),
        checkRun({
          name: "sasuke / audit",
          status: "IN_PROGRESS",
          detailsUrl: "https://github.com/zheref/bankai-core/actions/runs/32790532610/job/2",
        }),
      ],
      selfRun,
    );

    expect(checksAllGreen(excluded)).toBe(false);
  });

  it("a rollup holding ONLY the excluded run empties, and an empty rollup is never green (bankai-core#671)", () => {
    // The caller can still tell this apart from an always-empty rollup, because
    // the INPUT was non-empty -- which is the distinction the not-ready reason
    // turns on: "your own run is the only thing reporting" is a different
    // finding from "CI never started".
    const input: RollupEntry[] = [
      checkRun({
        name: "kisuke / build",
        status: "IN_PROGRESS",
        detailsUrl: "https://github.com/o/r/actions/runs/999/job/1",
      }),
    ];
    const excluded = excludeCheckRun(input, "999");

    expect(input.length).toBeGreaterThan(0);
    expect(excluded).toEqual([]);
    expect(checksAllGreen(excluded)).toBe(false);
  });
});

// --- normalizeReviewers ------------------------------------------------------

describe("normalizeReviewers (bankai-core#577)", () => {
  it("trims a whitespace-padded CSV -- ' tenma' matches no login and would pin the PR not-ready", () => {
    expect(normalizeReviewers("sasuke, tenma, copilot")).toEqual([
      "sasuke",
      "tenma",
      "copilot",
    ]);
  });

  it("drops empty entries and preserves order", () => {
    expect(normalizeReviewers(" sasuke ,, ,  tenma ")).toEqual(["sasuke", "tenma"]);
  });

  it("ADDED: an empty, null or undefined list is no reviewers, never a default set", () => {
    expect(normalizeReviewers("")).toEqual([]);
    expect(normalizeReviewers(null)).toEqual([]);
    expect(normalizeReviewers(undefined)).toEqual([]);
  });

  it("ADDED: normalizeReviewerNames applies the same trimming to an already-split list", () => {
    expect(normalizeReviewerNames([" sasuke ", "", "  tenma"])).toEqual([
      "sasuke",
      "tenma",
    ]);
  });

  // --- bankai-core#826: parity with the shell on UNICODE whitespace ----------
  //
  // The shell trims with POSIX `[[:space:]]`, which in the C locale is exactly
  // six ASCII characters. `.trim()` strips the whole Unicode White_Space set, so
  // the port read READY where the shell reads NOT-READY -- the one direction of
  // divergence that cannot ship.
  //
  // Every character below is written as a \u escape deliberately: a literal
  // U+00A0 in a test file is invisible, and an editor or formatter that
  // normalises whitespace would silently delete the thing being tested.

  it("#826 POSITIVE CONTROL: a trailing NON-BREAKING space is NOT trimmed, as in the shell", () => {
    // The exact input from the report. Under `.trim()` this returned ["sasuke"],
    // which matches `sasuke-bankai[bot]` and enters the CON-40 delivery branch;
    // the shell keeps the U+00A0, matches nothing, and owes a round.
    expect(normalizeReviewerNames(["sasuke\u00A0"])).toEqual(["sasuke\u00A0"]);
    expect(normalizeReviewers("sasuke\u00A0,tenma")).toEqual(["sasuke\u00A0", "tenma"]);
  });

  it("#826: the wider Unicode whitespace class is left alone too", () => {
    // Not just U+00A0 -- `.trim()` strips all of these, and the shell strips none.
    for (const ch of ["\u00A0", "\u2007", "\u202F", "\u2003", "\u3000", "\uFEFF"]) {
      expect(normalizeReviewerNames([`sasuke${ch}`])).toEqual([`sasuke${ch}`]);
    }
  });

  it("#826: all six POSIX space characters ARE still trimmed", () => {
    // The other half of parity: narrowing the trim must not stop it doing the
    // job bankai-core#577 added it for.
    for (const ch of [" ", "\t", "\n", "\v", "\f", "\r"]) {
      expect(normalizeReviewerNames([`${ch}sasuke${ch}`])).toEqual(["sasuke"]);
    }
  });

  it("#826: the #577 case still works -- the fix must not regress into the bug", () => {
    // `--reviewers "sasuke, tenma, copilot"` is the natural way to write it and
    // is the whole reason the trim exists.
    expect(normalizeReviewers("sasuke, tenma, copilot")).toEqual([
      "sasuke",
      "tenma",
      "copilot",
    ]);
  });

  it("#826: a name that is ONLY unicode whitespace survives, matching the shell", () => {
    // The shell drops entries that are empty AFTER its ASCII trim. A lone U+00A0
    // is not empty to the shell, so it survives as a (never-matching) name, and
    // the port must agree rather than silently dropping it.
    expect(normalizeReviewerNames(["\u00A0"])).toEqual(["\u00A0"]);
    // ...while a lone ASCII space IS dropped, by both.
    expect(normalizeReviewerNames([" "])).toEqual([]);
  });
});

// --- reviewerLoginPattern ----------------------------------------------------

describe("reviewerLoginPattern", () => {
  it("maps copilot to the login Copilot actually posts under", () => {
    expect(
      reviewerLoginPattern(BANKAI, "copilot").test("copilot-pull-request-reviewer[bot]"),
    ).toBe(true);
  });

  it("maps bugbot to cursor OR bugbot -- the login varies with the installation", () => {
    expect(reviewerLoginPattern(BANKAI, "bugbot").test("cursor[bot]")).toBe(true);
    expect(reviewerLoginPattern(BANKAI, "bugbot").test("bugbot[bot]")).toBe(true);
  });

  it("maps every other name to itself, unanchored and case-insensitive", () => {
    expect(reviewerLoginPattern(BANKAI, "sasuke").test("sasuke-bankai[bot]")).toBe(true);
    expect(reviewerLoginPattern(BANKAI, "tenma").test("TENMA-bankai[bot]")).toBe(true);
    expect(reviewerLoginPattern(BANKAI, "sasuke").test("tenma-bankai[bot]")).toBe(false);
  });

  it("ADDED: a name that is not a valid regex matches NOTHING -- conservative, so it can only fail to satisfy a round, never satisfy one", () => {
    expect(reviewerLoginPattern(BANKAI, "sasuke[").test("sasuke-bankai[bot]")).toBe(false);
  });
});

// --- reviewerReviewCheckPattern ----------------------------------------------

describe("reviewerReviewCheckPattern (CON-40, bankai-core#720)", () => {
  it("names the REVIEW job, never a name prefix", () => {
    expect(reviewerReviewCheckPattern(BANKAI, "sasuke")?.source).toBe("^sasuke \\/ audit$");
    expect(reviewerReviewCheckPattern(BANKAI, "tenma")?.source).toBe("^tenma \\/ review$");
    expect(reviewerReviewCheckPattern(BANKAI, "bisky")?.source).toBe("^bisky \\/ review$");
    expect(reviewerReviewCheckPattern(BANKAI, "copilot")).toBeNull();
  });

  it("ADDED: the runner probe does not match -- it is green on every PR whether or not the review ran", () => {
    const pattern = reviewerReviewCheckPattern(BANKAI, "sasuke");

    expect(pattern?.test("sasuke / probe / probe")).toBe(false);
    expect(pattern?.test("sasuke / audit")).toBe(true);
  });
});

// --- reviewsAllApprovedAtHead ------------------------------------------------

describe("reviewsAllApprovedAtHead (CON-32b approve limb, CON-16 current head)", () => {
  it("is true when every reviewer's latest review approves the head", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({ author: "sasuke-bankai[bot]", submittedAt: "2026-08-14T01:00:00Z" }),
          review({ author: "tenma-bankai[bot]", submittedAt: "2026-08-14T01:05:00Z" }),
        ],
        "headsha",
      ),
    ).toBe(true);
  });

  it("takes the LATEST review per author, not the first", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({
            author: "sasuke-bankai[bot]",
            state: "CHANGES_REQUESTED",
            commitId: "oldsha",
            submittedAt: "2026-08-14T01:00:00Z",
          }),
          review({ author: "sasuke-bankai[bot]", submittedAt: "2026-08-14T02:00:00Z" }),
          review({ author: "tenma-bankai[bot]", submittedAt: "2026-08-14T02:05:00Z" }),
        ],
        "headsha",
      ),
    ).toBe(true);
  });

  it("is false when a reviewer's latest review is stale (superseded commit)", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [review({ author: "sasuke-bankai[bot]", commitId: "oldsha" })],
        "headsha",
      ),
    ).toBe(false);
  });

  it("is false when any reviewer's latest round is not an approval", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({ author: "sasuke-bankai[bot]" }),
          review({ author: "tenma-bankai[bot]", state: "COMMENTED" }),
        ],
        "headsha",
      ),
    ).toBe(false);
  });

  it("is false for an EMPTY array -- no review signal is not ready", () => {
    expect(reviewsAllApprovedAtHead(BANKAI, [], "headsha")).toBe(false);
  });

  it("is false when a NON-approving, NON-required reviewer (Copilot) is the only entry -- it must not block, and it also must not satisfy", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({
            author: "copilot-pull-request-reviewer[bot]",
            state: "COMMENTED",
          }),
        ],
        "headsha",
      ),
    ).toBe(false);
  });

  it("is true when sasuke+tenma approved at head even with a Copilot COMMENTED round present -- Copilot never blocks here", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({ author: "sasuke-bankai[bot]" }),
          review({ author: "tenma-bankai[bot]", submittedAt: "2026-08-14T01:05:00Z" }),
          review({
            author: "copilot-pull-request-reviewer[bot]",
            state: "COMMENTED",
            submittedAt: "2026-08-14T01:06:00Z",
          }),
        ],
        "headsha",
      ),
    ).toBe(true);
  });

  it("is false when only ONE required reviewer approved -- a single approver must not satisfy", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI, [review({ author: "sasuke-bankai[bot]" })], "headsha"),
    ).toBe(false);
  });

  it("handles reviews INTERLEAVED by author rather than grouped", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({
            author: "tenma-bankai[bot]",
            commitId: "oldsha",
            submittedAt: "2026-08-14T01:00:00Z",
          }),
          review({
            author: "sasuke-bankai[bot]",
            commitId: "oldsha",
            submittedAt: "2026-08-14T01:01:00Z",
          }),
          review({ author: "tenma-bankai[bot]", submittedAt: "2026-08-14T02:00:00Z" }),
          review({ author: "sasuke-bankai[bot]", submittedAt: "2026-08-14T02:01:00Z" }),
        ],
        "headsha",
      ),
    ).toBe(true);
  });

  it("an EMPTY approver list is vacuously true -- the caller configured no approving reviewer, so there is no approval to require", () => {
    // DIVERGENCE FROM THE SHELL, verified against it and deliberate: there,
    // `reviews_all_approved_at_head "$head" ""` falls through `${2:-sasuke,tenma}`
    // and demands the approvals the caller excluded, which is why
    // `evaluate_ready` guards the call with `[ -n "$approvers" ]` and skips the
    // predicate -- behaviourally the same as this vacuous true. Here "omitted"
    // and "empty" are different values, so no caller-side guard is needed
    // (bankai-core#577).
    expect(reviewsAllApprovedAtHead(BANKAI, [], "headsha", [])).toBe(true);
    expect(unapprovedApprovers(BANKAI, [], "headsha", [])).toEqual([]);
  });

  it("ADDED: defaults to CON-32(b)'s approval set, sasuke and tenma", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI, [review({ author: "sasuke-bankai[bot]" })], "headsha"),
    ).toBe(false);
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [review({ author: "sasuke-bankai[bot]" })],
        "headsha",
        ["sasuke"],
      ),
    ).toBe(true);
  });

  it("ADDED: a review with NO submitted_at never displaces a timestamped one", () => {
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [
          review({ author: "sasuke-bankai[bot]", submittedAt: "2026-08-14T02:00:00Z" }),
          review({
            author: "sasuke-bankai[bot]",
            state: "CHANGES_REQUESTED",
            submittedAt: null,
          }),
        ],
        "headsha",
        ["sasuke"],
      ),
    ).toBe(true);
  });

  it("does NOT trim the approver names it is handed -- the shell asks for ' tenma' literally, and so does this", () => {
    // WAS A DIVERGENCE, AND THE ONLY PERMISSIVE ONE (BC-PR-#802 verification).
    // This predicate used to trim, so `[" sasuke ", " tenma "]` with both
    // approving at head read APPROVED here and NOT_APPROVED in
    // scripts/pr_ready_gate.sh, whose `split(",") | map(select(length > 0))`
    // drops empties and keeps whitespace. Every other divergence found made the
    // port stricter; this one made it looser, which is the direction a gate must
    // never drift in -- even where no current caller can reach it, since
    // `evaluate_ready` pre-normalizes and these are exported APIs now. Trimming
    // lives in normalizeReviewers() (bankai-core#577); a caller that wants it
    // calls that first, exactly as evaluate_ready does.
    const approvedAtHead: Review[] = [
      review({ author: "sasuke-bankai[bot]" }),
      review({ author: "tenma-bankai[bot]" }),
    ];

    expect(
      reviewsAllApprovedAtHead(BANKAI, approvedAtHead, "headsha", [" sasuke ", " tenma "]),
    ).toBe(false);

    // ... and unapprovedApprovers must name the SAME set, or the verdict and the
    // reason disagree about who the approvers even are -- BC-PR-#773's failure
    // mode approached from the other end.
    expect(
      unapprovedApprovers(BANKAI, approvedAtHead, "headsha", [" sasuke ", " tenma "]),
    ).toEqual([
      { reviewer: " sasuke ", reading: "current-head" },
      { reviewer: " tenma ", reading: "current-head" },
    ]);

    // Normalizing FIRST is the supported path, and restores the approval.
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        approvedAtHead,
        "headsha",
        normalizeReviewers(" sasuke , tenma "),
      ),
    ).toBe(true);
  });

  it("still DROPS empty names, exactly as `map(select(length > 0))` does -- an empty pattern matches every author", () => {
    // The half of the shell's idiom that is kept, and it is load-bearing: `""`
    // compiles to a regex matching every login, so a stray comma in
    // `--approvers` would otherwise satisfy the approve limb against any review
    // at all.
    expect(
      reviewsAllApprovedAtHead(BANKAI,
        [review({ author: "sasuke-bankai[bot]" })],
        "headsha",
        ["sasuke", ""],
      ),
    ).toBe(true);
    expect(
      unapprovedApprovers(BANKAI, [review({ author: "sasuke-bankai[bot]" })], "headsha", [
        "sasuke",
        "",
      ]),
    ).toEqual([]);
  });

  describe("CON-40 delivery-PR carve-out (bankai-core#720)", () => {
    const staleButApproved: Review[] = [
      ...DELIVERY_REVIEWS,
      review({
        author: "bisky-bankai[bot]",
        commitId: "opensha",
        submittedAt: "2026-08-25T02:43:00Z",
      }),
    ];

    it("sasuke and tenma pass under the delivery reading, on their `opened` pass", () => {
      expect(
        reviewsAllApprovedAtHead(BANKAI, staleButApproved, "headsha", ["sasuke", "tenma"], true),
      ).toBe(true);
    });

    it("... and fail without it -- the ordinary path is unchanged", () => {
      expect(
        reviewsAllApprovedAtHead(BANKAI, staleButApproved, "headsha", ["sasuke", "tenma"], false),
      ).toBe(false);
    });

    it("... while bisky is refused even WITH it -- the relaxation reaches the two reviewers CON-40 names and no others", () => {
      expect(
        reviewsAllApprovedAtHead(BANKAI,
          staleButApproved,
          "headsha",
          ["sasuke", "tenma", "bisky"],
          true,
        ),
      ).toBe(false);
    });

    it("a holistic pass that ended CHANGES_REQUESTED stays not-ready -- dropping `at head` must never drop `is an APPROVE`", () => {
      const changesRequested = DELIVERY_REVIEWS.map((entry): Review =>
        entry.author.includes("sasuke")
          ? { ...entry, state: "CHANGES_REQUESTED" }
          : entry,
      );

      expect(
        reviewsAllApprovedAtHead(BANKAI, changesRequested, "headsha", ["sasuke", "tenma"], true),
      ).toBe(false);
    });

    it("defaults DELIVERY_PR to false -- every pre-#720 caller is unchanged", () => {
      expect(
        reviewsAllApprovedAtHead(BANKAI,
          [review({ author: "sasuke-bankai[bot]", commitId: "opensha" })],
          "headsha",
          ["sasuke"],
        ),
      ).toBe(false);
    });

    it("ADDED: a delivery reviewer with NO review at all is still not approved -- the carve-out relocates the round, it does not waive it", () => {
      expect(reviewsAllApprovedAtHead(BANKAI, [], "headsha", ["sasuke", "tenma"], true)).toBe(
        false,
      );
    });
  });
});

// --- unapprovedApprovers -----------------------------------------------------

describe("unapprovedApprovers (BC-PR-#773 mis-blame)", () => {
  const mixed: Review[] = [
    review({
      author: "sasuke-bankai[bot]",
      state: "CHANGES_REQUESTED",
      commitId: "opensha",
      submittedAt: "2026-08-25T02:41:03Z",
    }),
    review({
      author: "tenma-bankai[bot]",
      commitId: "opensha",
      submittedAt: "2026-08-25T02:42:00Z",
    }),
    review({
      author: "bisky-bankai[bot]",
      commitId: "opensha",
      submittedAt: "2026-08-25T02:43:00Z",
    }),
  ];

  it("reports the READING applied per name under the delivery reading", () => {
    expect(unapprovedApprovers(BANKAI, mixed, "headsha", ["sasuke", "tenma", "bisky"], true)).toEqual(
      [
        { reviewer: "sasuke", reading: "con40-holistic-pass" },
        { reviewer: "bisky", reading: "current-head" },
      ],
    );
  });

  it("reports the at-head reading for everyone on the ordinary path", () => {
    expect(unapprovedApprovers(BANKAI, mixed, "headsha", ["sasuke", "tenma", "bisky"], false)).toEqual(
      [
        { reviewer: "sasuke", reading: "current-head" },
        { reviewer: "tenma", reading: "current-head" },
        { reviewer: "bisky", reading: "current-head" },
      ],
    );
  });

  it("names nobody when every approver approved at head, and agrees with the predicate that decides", () => {
    const approved: Review[] = [
      review({ author: "sasuke-bankai[bot]" }),
      review({ author: "tenma-bankai[bot]" }),
    ];

    expect(unapprovedApprovers(BANKAI, approved, "headsha", ["sasuke", "tenma"], false)).toEqual([]);
    expect(reviewsAllApprovedAtHead(BANKAI, approved, "headsha", ["sasuke", "tenma"], false)).toBe(
      true,
    );
  });

  it("names BISKY, not sasuke/tenma, when bisky is the only failing approver on a delivery PR", () => {
    // The mis-blame Bugbot caught: the verdict was right and the reason pointed
    // at the wrong reviewer, sending a reader to re-run the wrong thing.
    const state: Review[] = [
      ...DELIVERY_REVIEWS,
      review({
        author: "bisky-bankai[bot]",
        state: "CHANGES_REQUESTED",
        commitId: "headsha",
        submittedAt: "2026-08-25T02:43:00Z",
      }),
    ];

    expect(
      unapprovedApprovers(BANKAI, state, "headsha", ["sasuke", "tenma", "bisky"], true),
    ).toEqual([{ reviewer: "bisky", reading: "current-head" }]);
  });

  it("ADDED: it decides nothing -- an empty result and a true verdict always coincide", () => {
    const cases: readonly Review[][] = [[], DELIVERY_REVIEWS, mixed];
    for (const reviews of cases) {
      for (const delivery of [false, true]) {
        const named = unapprovedApprovers(BANKAI, reviews, "headsha", ["sasuke", "tenma"], delivery);
        const verdict = reviewsAllApprovedAtHead(BANKAI,
          reviews,
          "headsha",
          ["sasuke", "tenma"],
          delivery,
        );
        expect(named.length === 0).toBe(verdict);
      }
    }
  });
});

// --- pendingRounds -----------------------------------------------------------

describe("pendingRounds (CON-32b owed limb)", () => {
  it("names every reviewer owed a round when nothing has been posted (strict)", () => {
    const owed = pendingRounds(BANKAI, rounds(), "headsha", ["sasuke", "tenma", "copilot"], "strict");

    expect(owedNames(owed)).toEqual(["sasuke", "tenma", "copilot"]);
    expect(owed.every((entry): boolean => entry.reason === "no-round-at-head")).toBe(true);
  });

  it("under BOUNDED does not wait on a Copilot round nobody requested", () => {
    // 0 of 8 merged PRs sampled carried a Copilot round at their final head, so
    // `strict` holds every one of them not-ready indefinitely (bankai-core#570).
    const owed = pendingRounds(BANKAI, rounds(), "headsha", ["sasuke", "tenma", "copilot"], "bounded");

    expect(owedNames(owed)).toEqual(["sasuke", "tenma"]);
  });

  it("under BOUNDED still owes Copilot while its review request is PENDING -- the #564 shape", () => {
    // bounded is not "ignore Copilot": a pending request is the one footprint an
    // un-posted Copilot round has, and it is honoured under both policies.
    const owed = pendingRounds(BANKAI,
      rounds({
        reviewRequests: [request("Copilot")],
        reviews: [
          review({ author: "sasuke-bankai[bot]" }),
          review({ author: "tenma-bankai[bot]" }),
        ],
      }),
      "headsha",
      ["sasuke", "tenma", "copilot"],
      "bounded",
    );

    expect(owed).toEqual([
      { reviewer: "copilot", reason: "review-requested-not-yet-posted" },
    ]);
  });

  it("ADDED: a pending request is owed under STRICT too", () => {
    const owed = pendingRounds(BANKAI,
      rounds({ reviewRequests: [request("Copilot")] }),
      "headsha",
      ["copilot"],
      "strict",
    );

    expect(owed).toEqual([
      { reviewer: "copilot", reason: "review-requested-not-yet-posted" },
    ]);
  });

  it("ADDED: a request naming an UNCONFIGURED login (the human maintainer) is ignored -- the human is the gate, never a round the gate waits on", () => {
    const owed = pendingRounds(BANKAI,
      rounds({
        reviewRequests: [request("zheref")],
        reviews: [review({ author: "sasuke-bankai[bot]" })],
      }),
      "headsha",
      ["sasuke"],
      "bounded",
    );

    expect(owed).toEqual([]);
  });

  it("a COMPLETED non-SKIPPED 'bisky / review' check at head satisfies bisky's round without a posted review", () => {
    // Bisky posts a review only when it has findings; a clean run concludes its
    // check silently, so the check IS the round.
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [
          checkRun({ name: "bisky / review", conclusion: "SUCCESS", status: "COMPLETED" }),
        ],
        reviews: [
          review({ author: "sasuke-bankai[bot]", commitId: "h" }),
          review({ author: "tenma-bankai[bot]", commitId: "h" }),
          review({
            author: "copilot-pull-request-reviewer[bot]",
            state: "COMMENTED",
            commitId: "h",
          }),
        ],
      }),
      "h",
      ["sasuke", "tenma", "copilot", "bisky"],
      "strict",
    );

    expect(owed).toEqual([]);
  });

  it("a still-running 'bisky / review' check does NOT satisfy bisky's round", () => {
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [
          checkRun({ name: "bisky / review", conclusion: null, status: "IN_PROGRESS" }),
        ],
      }),
      "h",
      ["bisky"],
      "strict",
    );

    expect(owed).toEqual([{ reviewer: "bisky", reason: "no-round-at-head" }]);
  });

  it("a SUPERSEDED non-SKIPPED bisky run must not satisfy the round when the LATEST is SKIPPED (bankai-core#577)", () => {
    // The reduction must happen BEFORE the round test. Reading the raw rollup
    // let an obsolete SUCCESS clear a reviewer whose latest run says otherwise.
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [
          checkRun({
            name: "bisky / review",
            conclusion: "SUCCESS",
            status: "COMPLETED",
            startedAt: "2026-08-22T10:00:00Z",
          }),
          checkRun({
            name: "bisky / review",
            conclusion: "SKIPPED",
            status: "COMPLETED",
            startedAt: "2026-08-22T11:00:00Z",
          }),
        ],
      }),
      "h",
      ["bisky"],
      "strict",
    );

    expect(owed).toEqual([{ reviewer: "bisky", reason: "no-round-at-head" }]);
  });

  it("a green 'sasuke / audit' check at head is NOT a substitute for Sasuke's review", () => {
    // The proxy-vs-evidence rule, and the shape KroApple#329 merged in.
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [
          checkRun({ name: "sasuke / audit", conclusion: "SUCCESS", status: "COMPLETED" }),
        ],
      }),
      "h",
      ["sasuke"],
      "strict",
    );

    expect(owed).toEqual([{ reviewer: "sasuke", reason: "no-round-at-head" }]);
  });

  it("tolerates a whitespace-padded reviewer list (bankai-core#577)", () => {
    const owed = pendingRounds(BANKAI,
      rounds({
        reviews: [
          review({ author: "sasuke-bankai[bot]", commitId: "h" }),
          review({ author: "tenma-bankai[bot]", commitId: "h" }),
        ],
      }),
      "h",
      [" sasuke ", "  tenma "],
      "strict",
    );

    expect(owed).toEqual([]);
  });

  it("ADDED: a COMPLETED, non-SKIPPED Cursor Bugbot check satisfies bugbot's round", () => {
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [
          checkRun({ name: "Cursor Bugbot", conclusion: "SUCCESS", status: "COMPLETED" }),
        ],
      }),
      "h",
      ["bugbot"],
      "strict",
    );

    expect(owed).toEqual([]);
  });

  it("ADDED: a SKIPPED Bugbot check does NOT satisfy the round -- accepting it would be a gate that can never clear", () => {
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [
          checkRun({ name: "Cursor Bugbot", conclusion: "SKIPPED", status: "COMPLETED" }),
        ],
      }),
      "h",
      ["bugbot"],
      "strict",
    );

    expect(owed).toEqual([{ reviewer: "bugbot", reason: "no-round-at-head" }]);
  });

  it("ADDED: a review at head in ANY state satisfies the owed limb -- a COMMENTED round IS a round", () => {
    // The owed limb asks whether the reviewer SHOWED UP; whether it approved is
    // the approve limb's question, one clause later.
    const owed = pendingRounds(BANKAI,
      rounds({ reviews: [review({ author: "sasuke-bankai[bot]", state: "COMMENTED" })] }),
      "headsha",
      ["sasuke"],
      "strict",
    );

    expect(owed).toEqual([]);
  });

  it("ADDED: a review on a SUPERSEDED commit does not satisfy the owed limb", () => {
    const owed = pendingRounds(BANKAI,
      rounds({ reviews: [review({ author: "sasuke-bankai[bot]", commitId: "oldsha" })] }),
      "headsha",
      ["sasuke"],
      "strict",
    );

    expect(owed).toEqual([{ reviewer: "sasuke", reason: "no-round-at-head" }]);
  });

  it("ADDED: a legacy StatusContext named like a reviewer check cannot satisfy a round -- the rule reads .name alone", () => {
    // A commit status from an external CI system is not bisky's review job
    // concluding silently, however it is named.
    const owed = pendingRounds(BANKAI,
      rounds({
        checks: [statusContext({ context: "bisky / review", state: "SUCCESS" })],
      }),
      "h",
      ["bisky"],
      "strict",
    );

    expect(owed).toEqual([{ reviewer: "bisky", reason: "no-round-at-head" }]);
  });

  it("ADDED: an empty reviewer set owes nothing", () => {
    expect(pendingRounds(BANKAI, rounds(), "headsha", [], "strict")).toEqual([]);
  });

  describe("CON-40 delivery-PR carve-out (bankai-core#720)", () => {
    const deliveryInputs = (
      overrides: Partial<RoundInputs> = {},
    ): RoundInputs =>
      rounds({ checks: DELIVERY_CHECKS, reviews: DELIVERY_REVIEWS, ...overrides });

    it("a delivery PR one synchronize past `opened` owes nothing -- the abstain-green round counts", () => {
      expect(
        pendingRounds(BANKAI, deliveryInputs(), "headsha", ["sasuke", "tenma"], "bounded", true),
      ).toEqual([]);
    });

    it("the SAME state WITHOUT the delivery reading is still owed -- the carve-out fires on evidence, never on shape", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs(),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        false,
      );

      expect(owed).toEqual([
        { reviewer: "sasuke", reason: "no-round-at-head" },
        { reviewer: "tenma", reason: "no-round-at-head" },
      ]);
    });

    it("a delivery reviewer that NEVER posted its one holistic pass is still owed, distinctly (KP-PR-#460)", () => {
      // Tenma's `opened` pass was concurrency-cancelled by the synchronize that
      // followed it, so Tenma abstained green having never reviewed at all. An
      // abstain-green check cannot stand in for a review that never happened --
      // and Sasuke, who DID post, must clear.
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          reviews: DELIVERY_REVIEWS.filter(
            (entry): boolean => !entry.author.includes("tenma"),
          ),
        }),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "tenma", reason: "delivery-holistic-pass-never-posted" },
      ]);
    });

    it("a delivery reviewer whose review check is SKIPPED at head is owed -- CON-40 requires a definitive pass, never a skip", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          checks: DELIVERY_CHECKS.map((entry): RollupEntry =>
            entry.kind === "check_run" && entry.name === "tenma / review"
              ? { ...entry, conclusion: "SKIPPED" }
              : entry,
          ),
        }),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "tenma", reason: "delivery-no-definitive-success-review-check" },
      ]);
    });

    it("a green 'sasuke / probe / probe' does NOT satisfy sasuke's delivery round -- only the REVIEW job does", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          checks: DELIVERY_CHECKS.map((entry): RollupEntry =>
            entry.kind === "check_run" && entry.name === "sasuke / audit"
              ? { ...entry, name: "sasuke / probe / probe" }
              : entry,
          ),
        }),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "sasuke", reason: "delivery-no-definitive-success-review-check" },
      ]);
    });

    it("ADDED: a NEUTRAL review check is not a definitive pass either", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          checks: [
            checkRun({ name: "sasuke / audit", conclusion: "NEUTRAL", status: "COMPLETED" }),
            checkRun({ name: "tenma / review", conclusion: "SUCCESS", status: "COMPLETED" }),
          ],
        }),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "sasuke", reason: "delivery-no-definitive-success-review-check" },
      ]);
    });

    it("ADDED: an IN_PROGRESS review check is not a definitive pass either", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          checks: [
            checkRun({ name: "sasuke / audit", conclusion: "SUCCESS", status: "IN_PROGRESS" }),
            checkRun({ name: "tenma / review", conclusion: "SUCCESS", status: "COMPLETED" }),
          ],
        }),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "sasuke", reason: "delivery-no-definitive-success-review-check" },
      ]);
    });

    it("ADDED: a delivery reviewer WITH a round at head clears by the ordinary path, never reaching the carve-out", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          checks: [],
          reviews: [
            review({ author: "sasuke-bankai[bot]" }),
            review({ author: "tenma-bankai[bot]" }),
          ],
        }),
        "headsha",
        ["sasuke", "tenma"],
        "bounded",
        true,
      );

      expect(owed).toEqual([]);
    });

    it("ADDED: the carve-out never reaches bisky or copilot, however green their checks are", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({
          checks: [
            ...DELIVERY_CHECKS,
            checkRun({ name: "bisky / review", conclusion: "SKIPPED", status: "COMPLETED" }),
          ],
        }),
        "headsha",
        ["bisky", "copilot"],
        "strict",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "bisky", reason: "no-round-at-head" },
        { reviewer: "copilot", reason: "no-round-at-head" },
      ]);
    });

    it("defaults DELIVERY_PR to false -- every pre-#720 caller is unchanged", () => {
      const owed = pendingRounds(BANKAI,
        rounds({
          checks: [
            checkRun({ name: "sasuke / audit", conclusion: "SUCCESS", status: "COMPLETED" }),
          ],
        }),
        "headsha",
        ["sasuke"],
        "bounded",
      );

      expect(owed).toEqual([{ reviewer: "sasuke", reason: "no-round-at-head" }]);
    });

    it("ADDED: a PENDING request still wins over the carve-out -- limb (i) is tested first", () => {
      const owed = pendingRounds(BANKAI,
        deliveryInputs({ reviewRequests: [request("sasuke-bankai")] }),
        "headsha",
        ["sasuke"],
        "bounded",
        true,
      );

      expect(owed).toEqual([
        { reviewer: "sasuke", reason: "review-requested-not-yet-posted" },
      ]);
    });
  });
});

// --- cancelledLatestReport (BC-IS-#737, bankai-core#698) ---------------------

describe("cancelledLatestReport (CON-32a reason taxonomy)", () => {
  it("splits a reduced rollup into cancelled vs failing name buckets", () => {
    expect(
      cancelledLatestReport([
        checkRun({ name: "kisuke / probe", conclusion: "CANCELLED" }),
        checkRun({ name: "sasuke / audit", conclusion: "FAILURE" }),
        checkRun({ name: "tenma / audit", conclusion: "SUCCESS" }),
      ]),
    ).toEqual({ cancelled: ["kisuke / probe"], failing: ["sasuke / audit"] });
  });

  it("does NOT bucket a still-running check as failing (bankai-core#727)", () => {
    // A CheckRun's LATEST run is IN_PROGRESS: no conclusion yet, and a CheckRun
    // never carries `.state` either, so the effective status is null -- which is
    // neither a failure nor a cancellation. Landing it in `failing` would send
    // the reader to FIX something that has not finished deciding.
    expect(
      cancelledLatestReport([
        checkRun({ name: "kisuke / probe", conclusion: "CANCELLED" }),
        checkRun({ name: "kisuke / build", conclusion: null, status: "IN_PROGRESS" }),
      ]),
    ).toEqual({ cancelled: ["kisuke / probe"], failing: [] });
  });

  it("ADDED: names an entry that named itself nothing, rather than dropping it", () => {
    // "One check is red" with no name at all sends the reader to the rollup to
    // guess which. The shell's `// "unnamed check"` exists for that, and a
    // dropped entry would under-report the finding.
    expect(cancelledLatestReport([checkRun({ conclusion: "FAILURE" })])).toEqual({
      cancelled: [],
      failing: ["unnamed check"],
    });
  });

  it("ADDED: buckets every terminal conclusion the allowlist names, and no other", () => {
    // The allowlist is the point (bankai-core#727 review): `failing` is not
    // "everything left over". QUEUED/WAITING and a NEUTRAL/SKIPPED green land in
    // neither bucket.
    const terminal = ["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "STALE"] as const;
    for (const conclusion of terminal) {
      expect(
        cancelledLatestReport([checkRun({ name: conclusion, conclusion })]).failing,
        conclusion,
      ).toEqual([conclusion]);
    }
    expect(
      cancelledLatestReport([
        checkRun({ name: "green", conclusion: "NEUTRAL" }),
        checkRun({ name: "skipped", conclusion: "SKIPPED" }),
        checkRun({ name: "queued", conclusion: null, status: "QUEUED" }),
      ]),
    ).toEqual({ cancelled: [], failing: [] });
  });

  it("ADDED: reads a legacy StatusContext's ERROR as failing and its PENDING as neither", () => {
    // A commit status carries its verdict in `.state`, and ERROR is that API's
    // terminal red. PENDING is a status not yet decided, exactly like a null
    // conclusion.
    expect(
      cancelledLatestReport([
        statusContext({ context: "external-ci", state: "ERROR" }),
        statusContext({ context: "external-pending", state: "PENDING" }),
      ]),
    ).toEqual({ cancelled: [], failing: ["external-ci"] });
  });
});

// --- isDeliveryPr (BC-IS-#737, CON-40 / bankai-core#720) ---------------------

describe("isDeliveryPr (CON-40 delivery-PR carve-out)", () => {
  const DELIVERY = {
    author: "app/roy-bankai",
    baseRef: "main",
    headRef: "integration/epic-193",
    defaultBranch: "main",
    labels: ["bankai:epic"],
  };

  it("accepts both of issue #106's login formats", () => {
    expect(isDeliveryPr(BANKAI, DELIVERY)).toBe(true);
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, author: "roy-bankai[bot]" })).toBe(true);
  });

  it("accepts the bankai:epic label as the head-ref fallback (BC-PR-#372)", () => {
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, headRef: "roy/epic-193-delivery" })).toBe(true);
  });

  it("accepts an integration/* head with NO labels at all", () => {
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, labels: [] })).toBe(true);
  });

  it("REFUSES the label alone on a non-Roy author — BC-PR-#372's security fix", () => {
    // The label is self-declared (CON-34, applied by Roy). Accepting it without
    // the author would let ANY actor attach `bankai:epic` to an ordinary PR and
    // permanently exempt its reviewers from a round at head.
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, author: "some-human", headRef: "x/y" })).toBe(false);
  });

  it("REFUSES a near-miss login — the match is anchored, never a substring", () => {
    for (const author of ["roy-bankai-evil", "app/roy-bankai-evil", "evilroy-bankai2", "notroy-bankai-x"]) {
      expect(isDeliveryPr(BANKAI, { ...DELIVERY, author }), author).toBe(false);
    }
  });

  it("REFUSES a non-default base — a child PR onto integration/* is not a delivery PR", () => {
    expect(
      isDeliveryPr(BANKAI, { ...DELIVERY, baseRef: "integration/epic-193", headRef: "roy/193-child" }),
    ).toBe(false);
  });

  it("REFUSES when any of the three REQUIRED fields is empty — absent evidence never widens a gate", () => {
    for (const field of ["author", "baseRef", "defaultBranch"] as const) {
      expect(isDeliveryPr(BANKAI, { ...DELIVERY, [field]: "" }), field).toBe(false);
    }
  });

  it("ADDED: an empty head ref AND no labels is false, but either one alone suffices", () => {
    // The fourth conjunct is a DISJUNCTION: neither of its two limbs is
    // individually required, and what it cannot do is pass on nothing.
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, headRef: "", labels: [] })).toBe(false);
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, headRef: "", labels: ["bankai:epic"] })).toBe(true);
    expect(isDeliveryPr(BANKAI, { ...DELIVERY, headRef: "integration/x", labels: [] })).toBe(true);
  });
});

// --- defaultReviewers (BC-IS-#737, bankai-core#577) -------------------------

describe("defaultReviewers (the DEFAULT production path)", () => {
  it("is the base three when no reviewer check is present at head", () => {
    expect(defaultReviewers(BANKAI, [checkRun({ name: "sasuke / audit", conclusion: "SUCCESS" })])).toEqual([
      "sasuke",
      "tenma",
      "copilot",
    ]);
  });

  it("enrols bisky on a present, non-SKIPPED `bisky / review` check", () => {
    expect(defaultReviewers(BANKAI, [checkRun({ name: "bisky / review", conclusion: "SUCCESS" })])).toEqual([
      "sasuke",
      "tenma",
      "copilot",
      "bisky",
    ]);
  });

  it("does NOT enrol bisky on a SKIPPED check — the job gated this PR out", () => {
    expect(defaultReviewers(BANKAI, [checkRun({ name: "bisky / review", conclusion: "SKIPPED" })])).toEqual([
      "sasuke",
      "tenma",
      "copilot",
    ]);
  });

  it("does NOT enrol bugbot on a SKIPPED check — enrolling it created an UNSATISFIABLE gate", () => {
    // Sasuke's high-severity finding on bankai-core#577: pendingRounds(BANKAI, ) accepts
    // only a COMPLETED, non-SKIPPED check as bugbot's round, so a SKIPPED Bugbot
    // check enrolled a reviewer that could never clear -- no review ever posts,
    // the check never un-skips, not-ready forever with no path out.
    expect(defaultReviewers(BANKAI, [checkRun({ name: "Cursor Bugbot", conclusion: "SKIPPED" })])).toEqual([
      "sasuke",
      "tenma",
      "copilot",
    ]);
    expect(defaultReviewers(BANKAI, [checkRun({ name: "Cursor Bugbot", conclusion: "SUCCESS" })])).toEqual([
      "sasuke",
      "tenma",
      "copilot",
      "bugbot",
    ]);
  });

  it("evaluates the LATEST run per name — a superseded non-SKIPPED run must not enrol", () => {
    expect(
      defaultReviewers(BANKAI, [
        checkRun({ name: "bisky / review", conclusion: "SUCCESS", startedAt: "2026-08-22T10:00:00Z" }),
        checkRun({ name: "bisky / review", conclusion: "SKIPPED", startedAt: "2026-08-22T11:00:00Z" }),
      ]),
    ).toEqual(["sasuke", "tenma", "copilot"]);
  });

  it("survives an empty rollup", () => {
    expect(defaultReviewers(BANKAI, [])).toEqual(["sasuke", "tenma", "copilot"]);
  });

  it("ADDED: bisky's pattern is ANCHORED — `bisky / probe / probe` must not enrol it", () => {
    // The probe is green on every PR whether or not the review ever ran, so a
    // prefix match would gate the PR on a check that says nothing about review.
    expect(defaultReviewers(BANKAI, [checkRun({ name: "bisky / probe / probe", conclusion: "SUCCESS" })])).toEqual([
      "sasuke",
      "tenma",
      "copilot",
    ]);
  });

  it("ADDED: bugbot's pattern is an UNANCHORED, case-insensitive substring", () => {
    // The Bugbot check's name varies with the installation, so the asymmetry
    // with bisky's anchored pattern is deliberate and carried across.
    for (const name of ["Cursor Bugbot", "bugbot", "BUGBOT / review"]) {
      expect(defaultReviewers(BANKAI, [checkRun({ name, conclusion: "SUCCESS" })]), name).toContain("bugbot");
    }
  });

  it("ADDED: a legacy StatusContext can never enrol a reviewer, however it is named", () => {
    // `.name // ""` alone -- an external CI system's commit status is not
    // bisky's or Bugbot's review job concluding silently.
    expect(
      defaultReviewers(BANKAI, [
        statusContext({ context: "bisky / review", state: "SUCCESS" }),
        statusContext({ context: "Cursor Bugbot", state: "SUCCESS" }),
      ]),
    ).toEqual(["sasuke", "tenma", "copilot"]);
  });
});

// =============================================================================
// NAMES ARE DATA (ADDED for zheref/nen#1; no counterpart in the original suite)
// =============================================================================
//
// Everything above this line runs against `BANKAI` -- a fixture repository whose
// `schemas/gates.json` states exactly the identities the original wrote into its
// own source -- and passes UNCHANGED. That proves the refactor did not move the
// behaviour.
//
// It does NOT prove the second half of the claim. A predicate that still had a
// reviewer name written into it somewhere would also pass every case above,
// because every case above uses those names. So this section runs the SAME
// structural cases against `ALT`: a repository with different reviewer names,
// different logins, different check names, a different delivery author, a
// different delivery branch prefix and a different delivery label. Not one of
// its strings appears anywhere in the shipped tree.
//
// If any predicate carried a reviewer identity of its own, these would fail.

describe("names are data -- the same predicates against a different vocabulary", () => {
  it("matches a reviewer's login through the FILE's pattern", () => {
    expect(reviewerLoginPattern(ALT, "itachi").test("itachi-akatsuki[bot]")).toBe(true);
    expect(reviewerLoginPattern(ALT, "sentry").test("watchtower-app[bot]")).toBe(true);
    // A reviewer the ALT file does not declare falls through to the original's
    // `default:` reading -- it matches its own name, case-insensitively.
    expect(reviewerLoginPattern(ALT, "sasuke").test("sasuke-bankai[bot]")).toBe(true);
    // ...but it does NOT inherit the other repository's identity: the bankai
    // fixture's `bugbot` matches `cursor`, and ALT declares no such reviewer.
    expect(reviewerLoginPattern(BANKAI, "bugbot").test("cursor[bot]")).toBe(true);
    expect(reviewerLoginPattern(ALT, "bugbot").test("cursor[bot]")).toBe(false);
  });

  it("resolves a reviewer's review check through the FILE's pattern", () => {
    const itachi = reviewerReviewCheckPattern(ALT, "itachi");
    expect(itachi?.test("itachi / inspect")).toBe(true);
    // ANCHORED, never a name prefix: a probe job is green on every PR whether
    // or not the review ever ran, so `^itachi / ` would clear a round on a
    // check that says nothing about review.
    expect(itachi?.test("itachi / probe / probe")).toBe(false);
    expect(reviewerReviewCheckPattern(ALT, "sasuke")).toBeNull();
    expect(reviewerReviewCheckPattern(BANKAI, "itachi")).toBeNull();
  });

  it("uses the FILE's default approver set", () => {
    expect(defaultApprovers(ALT)).toEqual(["itachi", "kisame"]);
    expect(defaultApprovers(BANKAI)).toEqual(["sasuke", "tenma"]);

    const approvals: Review[] = [
      review({ author: "itachi-akatsuki[bot]", commitId: "headsha" }),
      review({ author: "kisame-akatsuki[bot]", commitId: "headsha" }),
    ];
    expect(reviewsAllApprovedAtHead(ALT, approvals, "headsha")).toBe(true);
    // The same reviews against the OTHER repository's approver set: nobody it
    // names approved, so it is not approved there.
    expect(reviewsAllApprovedAtHead(BANKAI, approvals, "headsha")).toBe(false);
  });

  it("enrols reviewers from the FILE's base set plus its enrolment checks", () => {
    expect(defaultReviewers(ALT, [])).toEqual(["itachi", "kisame", "scribe"]);
    expect(
      defaultReviewers(ALT, [checkRun({ name: "sentry / sweep", conclusion: "SUCCESS" })]),
    ).toEqual(["itachi", "kisame", "scribe", "sentry"]);
    // ANCHORED and CASE-SENSITIVE, exactly as the file states -- the same
    // asymmetry the original hard-coded, now carried as data.
    expect(
      defaultReviewers(ALT, [checkRun({ name: "Sentry / Sweep", conclusion: "SUCCESS" })]),
    ).toEqual(["itachi", "kisame", "scribe"]);
    // The non-SKIPPED filter is not optional: enrolling on a skipped check
    // creates a gate that can never be satisfied (bankai-core#577).
    expect(
      defaultReviewers(ALT, [checkRun({ name: "sentry / sweep", conclusion: "SKIPPED" })]),
    ).toEqual(["itachi", "kisame", "scribe"]);
  });

  it("owes and clears rounds by the FILE's structural flags", () => {
    // The bounded-policy exemption follows the FLAG, not a name: `scribe` is
    // ALT's exempt reviewer and clears with no round, while `itachi` owes one.
    expect(
      owedNames(pendingRounds(ALT, rounds(), "headsha", ["scribe", "itachi"], "bounded")),
    ).toEqual(["itachi"]);
    // Under `strict` the exemption does not apply.
    expect(
      owedNames(pendingRounds(ALT, rounds(), "headsha", ["scribe"], "strict")),
    ).toEqual(["scribe"]);

    // A reviewer whose CHECK IS THE ROUND clears on a completed, non-skipped
    // check -- identified by the file's `round_check_pattern`.
    expect(
      owedNames(
        pendingRounds(
          ALT,
          rounds({
            checks: [
              checkRun({ name: "sentry / sweep", status: "COMPLETED", conclusion: "SUCCESS" }),
            ],
          }),
          "headsha",
          ["sentry"],
          "bounded",
        ),
      ),
    ).toEqual([]);
    // ...and the SAME shape of check leaves the round owed for a reviewer whose
    // review is the evidence and whose check is only a proxy.
    expect(
      owedNames(
        pendingRounds(
          ALT,
          rounds({
            checks: [
              checkRun({ name: "itachi / inspect", status: "COMPLETED", conclusion: "SUCCESS" }),
            ],
          }),
          "headsha",
          ["itachi"],
          "bounded",
        ),
      ),
    ).toEqual(["itachi"]);
  });

  it("applies the delivery carve-out by the FILE's convention", () => {
    const evidence = {
      author: "train-bot[bot]",
      baseRef: "main",
      headRef: "train/2-something",
      defaultBranch: "main",
      labels: [] as readonly string[],
    };
    expect(isDeliveryPr(ALT, evidence)).toBe(true);
    // The other repository's convention says no: different author, different
    // prefix, different label.
    expect(isDeliveryPr(BANKAI, evidence)).toBe(false);

    // The label limb, with a head ref that matches no prefix.
    expect(
      isDeliveryPr(ALT, { ...evidence, headRef: "fix/x", labels: ["akatsuki:migration"] }),
    ).toBe(true);
    expect(
      isDeliveryPr(ALT, { ...evidence, headRef: "fix/x", labels: ["bankai:epic"] }),
    ).toBe(false);

    // BC-PR-#372's security property survives the move to data: the author
    // pattern the file states is anchored, so a look-alike is refused.
    expect(isDeliveryPr(ALT, { ...evidence, author: "train-bot-evil" })).toBe(false);
    expect(isDeliveryPr(ALT, { ...evidence, author: "eviltrain-bot2" })).toBe(false);
  });

  it("reads the delivery holistic-pass carve-out off the FILE's flag", () => {
    const checks: RollupEntry[] = [
      checkRun({ name: "itachi / inspect", status: "COMPLETED", conclusion: "SUCCESS" }),
      checkRun({ name: "kisame / inspect", status: "COMPLETED", conclusion: "SUCCESS" }),
    ];
    const reviews: Review[] = [
      review({ author: "itachi-akatsuki[bot]", commitId: "opensha" }),
      review({ author: "kisame-akatsuki[bot]", commitId: "opensha" }),
    ];

    // On a delivery PR the one holistic pass plus a definitive green review
    // check satisfies both rounds, even though neither review is at head.
    expect(
      owedNames(
        pendingRounds(
          ALT,
          rounds({ checks, reviews }),
          "headsha",
          ["itachi", "kisame"],
          "bounded",
          true,
        ),
      ),
    ).toEqual([]);
    // Off a delivery PR the ordinary at-head rule binds and both owe a round.
    expect(
      owedNames(
        pendingRounds(
          ALT,
          rounds({ checks, reviews }),
          "headsha",
          ["itachi", "kisame"],
          "bounded",
          false,
        ),
      ),
    ).toEqual(["itachi", "kisame"]);

    // The approval limb reads the same flag: their latest round is an APPROVE
    // cast on `opensha`, and the carve-out drops the at-head requirement.
    expect(
      reviewsAllApprovedAtHead(ALT, reviews, "headsha", ["itachi", "kisame"], true),
    ).toBe(true);
    expect(
      reviewsAllApprovedAtHead(ALT, reviews, "headsha", ["itachi", "kisame"], false),
    ).toBe(false);
    expect(
      unapprovedApprovers(ALT, reviews, "headsha", ["itachi", "kisame"], false).map(
        (entry): string => entry.reviewer,
      ),
    ).toEqual(["itachi", "kisame"]);
  });

  it("leaves the identity-FREE predicates identity-free", () => {
    // These take no identities and must not have grown any: each is a function
    // of a check rollup or a string alone.
    const entries: RollupEntry[] = [
      checkRun({ name: "anything", conclusion: "SUCCESS", startedAt: "2026-01-01T00:00:00Z" }),
      checkRun({ name: "anything", conclusion: "CANCELLED", startedAt: "2026-01-01T00:00:01Z" }),
    ];
    expect(latestChecks(entries).length).toBe(1);
    expect(checksAllGreen(entries)).toBe(true);
    expect(cancelledLatestReport(latestChecks(entries))).toEqual({
      cancelled: [],
      failing: [],
    });
    expect(excludeCheckRun(entries, null).length).toBe(2);
    expect(normalizeReviewers(" a , b ")).toEqual(["a", "b"]);
    expect(normalizeReviewerNames([" a ", ""])).toEqual(["a"]);
  });
});
