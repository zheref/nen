// Tests for ../gates/ready.ts's COMPOSITION -- the conjunction, the
// short-circuit conjunct table, and the reason strings -- as distinct from the
// predicates it composes (already exercised, case for case, by
// ./predicates.test.ts against the SAME fixture identities). What this file
// proves that the predicate suite cannot: the evaluation ORDER, that a failure
// stops the walk with every later row `unevaluated` rather than `ready`, that
// the reason attached is the gate's own sentence rather than a paraphrase, and
// the three PORT CHANGE mappings (§3) that route a structural identity flag
// (`bounded_policy_exempt`, `approves_when_posted_at_head`) to the string the
// shell used to hard-code a persona for.

import { describe, expect, it } from "vitest";
import {
  CAVEATS,
  deliveryEvidence,
  evaluateReady,
  minutesSince,
  type ConjunctId,
} from "./ready.js";
import { loadGateIdentities } from "../schema/gates.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";

// The same fixture identities ./predicates.test.ts runs the ported bats cases
// against: sasuke/tenma (default approvers, review-check gated), copilot
// (bounded_policy_exempt), bisky (approves_when_posted_at_head, its check IS
// its round), bugbot (round_check only, no approval role).
const IDENTITIES = loadGateIdentities(BANKAI_REPO);

const HEAD = "deadbeef";
const NOW = "2025-06-01T12:00:00Z";

function greenCheck(name = "ci / build"): Record<string, unknown> {
  return { name, status: "COMPLETED", conclusion: "SUCCESS" };
}

function approvedAtHead(author: string, commit = HEAD): Record<string, unknown> {
  return { author, state: "APPROVED", commit_id: commit, submitted_at: NOW };
}

/** A state blob that passes every conjunct -- the baseline every failure case mutates ONE field of. */
function readyState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    mergeable: "MERGEABLE",
    head_sha: HEAD,
    checks: [greenCheck()],
    reviews: [approvedAtHead("sasuke"), approvedAtHead("tenma")],
    review_requests: [],
    unresolved_threads: 0,
    ...overrides,
  };
}

const OPTIONS = { roundPolicyDefault: "bounded" as const, stallMinutes: 30, now: NOW };

describe("evaluateReady -- the ready path", () => {
  it("passes all six conjuncts, in order, with no reason attached to any", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.line).toBe("ready");
    expect(evaluation.firstFailing).toBeNull();
    expect(evaluation.conjuncts.map((c): ConjunctId => c.id)).toEqual([
      "mergeable",
      "checks-green",
      "round-stalled",
      "rounds-owed",
      "approvals-at-head",
      "unresolved-threads",
    ]);
    expect(evaluation.conjuncts.map((c): number => c.order)).toEqual([1, 2, 3, 4, 5, 6]);
    for (const conjunct of evaluation.conjuncts) {
      expect(conjunct.status).toBe("ready");
      expect(conjunct.reason).toBeNull();
    }
  });

  it("reports the context: reviewers, approvers, policy, head, delivery-PR", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    expect(evaluation.context).toEqual({
      reviewers: ["sasuke", "tenma", "copilot"],
      approvers: ["sasuke", "tenma"],
      policy: "bounded",
      headSha: HEAD,
      deliveryPr: false,
    });
  });
});

describe("evaluateReady -- short-circuit: a failing row leaves every later row `unevaluated`, never `ready`", () => {
  it("mergeable fails first: every other row is unevaluated, none is `ready`", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ mergeable: "CONFLICTING" }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("mergeable");
    expect(evaluation.line).toBe(
      "not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)",
    );
    const [mergeable, ...rest] = evaluation.conjuncts;
    expect(mergeable?.status).toBe("failed");
    expect(mergeable?.reason).toBe(evaluation.line);
    for (const conjunct of rest) {
      expect(conjunct.status).toBe("unevaluated");
      expect(conjunct.reason).toBeNull();
    }
  });

  it("a later failure leaves EARLIER rows `ready` and only LATER ones `unevaluated`", () => {
    // unresolved-threads is the last row; every row before it must read `ready`.
    const evaluation = evaluateReady(IDENTITIES, readyState({ unresolved_threads: 3 }), OPTIONS);
    expect(evaluation.firstFailing).toBe("unresolved-threads");
    const statuses = new Map(evaluation.conjuncts.map((c): [ConjunctId, string] => [c.id, c.status]));
    expect(statuses.get("mergeable")).toBe("ready");
    expect(statuses.get("checks-green")).toBe("ready");
    expect(statuses.get("round-stalled")).toBe("ready");
    expect(statuses.get("rounds-owed")).toBe("ready");
    expect(statuses.get("approvals-at-head")).toBe("ready");
    expect(statuses.get("unresolved-threads")).toBe("failed");
  });
});

describe("evaluateReady -- CON-32(a), transcribed reason strings", () => {
  it("an EMPTY rollup is a different reason than a RED one (bankai-core#671), and carries no system name", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ checks: [] }), OPTIONS);
    expect(evaluation.firstFailing).toBe("checks-green");
    expect(evaluation.line).toMatch(/^not-ready: NO checks reported at head \(CON-32a\)/);
    // ADOPTION DIVERGENCE (3), ../gates/ready.ts's header: the citation moved to
    // the comment, so the emitted string never carries the source system's name.
    expect(evaluation.line).not.toMatch(/bankai-core/i);
  });

  it("a RED check (not empty, not cancelled) is the generic CON-32(a) message", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [{ name: "ci / build", status: "COMPLETED", conclusion: "FAILURE" }] }),
      OPTIONS,
    );
    expect(evaluation.line).toBe("not-ready: required checks reported but are not all green (CON-32a)");
  });

  it("a CANCELLED latest run is named separately -- needs a re-run, not a fix", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [{ name: "ci / build", status: "COMPLETED", conclusion: "CANCELLED" }] }),
      OPTIONS,
    );
    expect(evaluation.line).toMatch(/^not-ready: required checks are not all green \(CON-32a\) — latest run CANCELLED/);
    expect(evaluation.line).toContain("ci / build");
  });

  it("an unparsable checks payload maps to the ONE unreadable-state sentence, never a guess", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ checks: "not-an-array" }), OPTIONS);
    expect(evaluation.firstFailing).toBe("checks-green");
    expect(evaluation.line).toMatch(
      /^not-ready: the PR state could not be read, so CON-32 cannot be judged \(\$\.checks: /,
    );
  });
});

describe("evaluateReady -- CON-32(b), the round-stalled / rounds-owed split", () => {
  // copilot is `bounded_policy_exempt` in the fixture -- the PORT CHANGE that
  // replaces the original's `entry.reviewer === "copilot"` literal. A pending
  // request naming it is the one footprint an un-posted round leaves.
  function pendingCopilot(requestedAt: string): Record<string, unknown> {
    return readyState({
      review_requests: [{ login: "copilot-pull-request-reviewer[bot]" }],
      stall_requested_at: requestedAt,
    });
  }

  it("fires AT the boundary (>=), not only past it -- the sabotage-caught mutation ../gates/ready.ts's header names", () => {
    // NOW - 30 minutes exactly.
    const evaluation = evaluateReady(IDENTITIES, pendingCopilot("2025-06-01T11:30:00Z"), OPTIONS);
    expect(evaluation.firstFailing).toBe("round-stalled");
    expect(evaluation.line).toBe(
      "not-ready: copilot round stalled — requested 30 min ago and never posted (CON-32b; re-request it, a user token is required)",
    );
  });

  it("does NOT fire one minute under the boundary -- falls through to the plain owed-round message instead", () => {
    // NOW - 29 minutes.
    const evaluation = evaluateReady(IDENTITIES, pendingCopilot("2025-06-01T11:31:00Z"), OPTIONS);
    expect(evaluation.firstFailing).toBe("rounds-owed");
    expect(evaluation.line).toBe(
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): copilot (review requested, not yet posted)",
    );
  });

  it("an ordinary owed round (no pending request, nothing posted) is `rounds-owed`, not `round-stalled`", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ reviews: [approvedAtHead("sasuke")] }), // tenma never reviewed at all
      OPTIONS,
    );
    expect(evaluation.firstFailing).toBe("rounds-owed");
    expect(evaluation.line).toBe(
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): tenma (no round at head)",
    );
  });
});

describe("evaluateReady -- CON-32(b), the approve-at-head split", () => {
  it("names the reviewer whose LATEST round at head is not an APPROVE, not merely 'someone'", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        reviews: [
          approvedAtHead("sasuke"),
          { author: "tenma", state: "COMMENTED", commit_id: HEAD, submitted_at: NOW },
        ],
      }),
      OPTIONS,
    );
    expect(evaluation.firstFailing).toBe("approvals-at-head");
    expect(evaluation.line).toBe(
      "not-ready: not every approving reviewer's latest round is an APPROVE (CON-32b): tenma (no APPROVE at the current head)",
    );
  });

  it("a conditional approver (approves_when_posted_at_head) that HAS posted at head is REQUIRED to have approved", () => {
    // bisky enrols the moment its round check is at head; once enrolled it is
    // held to the same approve-at-head bar as sasuke/tenma.
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        reviewers: "sasuke,tenma,bisky",
        checks: [greenCheck(), { name: "bisky / review", status: "COMPLETED", conclusion: "NEUTRAL" }],
        reviews: [
          approvedAtHead("sasuke"),
          approvedAtHead("tenma"),
          { author: "bisky", state: "CHANGES_REQUESTED", commit_id: HEAD, submitted_at: NOW },
        ],
      }),
      OPTIONS,
    );
    expect(evaluation.firstFailing).toBe("approvals-at-head");
    expect(evaluation.line).toContain("bisky (no APPROVE at the current head)");
  });

  it("a conditional approver that has NOT posted at head stays OUT of the approver set entirely (vacuous, not owed)", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        reviewers: "sasuke,tenma,bisky",
        checks: [greenCheck(), { name: "bisky / review", status: "COMPLETED", conclusion: "NEUTRAL" }],
        // bisky posts nothing; its round check alone satisfies rounds-owed.
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    expect(evaluation.context.approvers).toEqual(["sasuke", "tenma"]);
  });
});

describe("evaluateReady -- CON-32(d)", () => {
  it("`unresolved_threads` other than 0 fails, naming the count", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ unresolved_threads: 2 }), OPTIONS);
    expect(evaluation.line).toBe("not-ready: 2 unresolved review thread(s) (CON-32d)");
  });

  it("cannot confirm zero is not zero: an empty/unreadable count defaults to not-ready", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ unresolved_threads: "" }), OPTIONS);
    expect(evaluation.firstFailing).toBe("unresolved-threads");
  });
});

describe("deliveryEvidence -- the tolerant reader, absence reads as 'not a delivery PR'", () => {
  it("reads every field as its own default rather than throwing on a missing one", () => {
    expect(deliveryEvidence({})).toEqual({
      author: "",
      baseRef: "",
      headRef: "",
      defaultBranch: "",
      labels: [],
    });
  });

  it("stringifies a non-string label rather than dropping it (jq's `tostring`)", () => {
    expect(deliveryEvidence({ labels: [42, "bankai:epic"] }).labels).toEqual(["42", "bankai:epic"]);
  });
});

describe("minutesSince", () => {
  it("truncates toward zero, matching bash arithmetic", () => {
    expect(minutesSince("2025-06-01T11:59:31Z", "2025-06-01T12:00:00Z")).toBe(0);
    expect(minutesSince("2025-06-01T11:30:00Z", "2025-06-01T12:00:00Z")).toBe(30);
  });

  it("returns undefined for an unparseable timestamp rather than NaN", () => {
    expect(minutesSince("not-a-date", NOW)).toBeUndefined();
  });
});

describe("CAVEATS -- the fixed 'what the gate does not decide' set", () => {
  it("is exactly three entries, one per residual clause, and names no reviewer", () => {
    expect(CAVEATS.map((c): string => c.clause)).toEqual(["CON-32(c)", "CON-32(a)", "CON-32(e)"]);
    for (const caveat of CAVEATS) {
      expect(caveat.text).not.toMatch(/\bbisky\b/i);
    }
  });
});
