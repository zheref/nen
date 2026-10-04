// Tests for ../gates/ready.ts's COMPOSITION -- the conjunction, the
// short-circuit conjunct table, and the reason strings -- as distinct from the
// predicates it composes (already exercised, case for case, by
// ./predicates.test.ts against the SAME fixture identities). What this file
// proves that the predicate suite cannot: the evaluation ORDER, that a failure
// no longer stops the walk -- every row is evaluated and a row that cannot be
// computed names its missing fact (zheref/nen#248) -- that
// the reason attached is the gate's own sentence rather than a paraphrase, and
// the three PORT CHANGE mappings (§3) that route a structural identity flag
// (`bounded_policy_exempt`, `approves_when_posted_at_head`) to the string the
// shell used to hard-code a persona for.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  CAVEATS,
  deliveryEvidence,
  earlierRoundChecks,
  evaluateReady,
  minutesSince,
  type Conjunct,
  type ConjunctId,
} from "./ready.js";
import { loadGateIdentities, parseGateIdentities } from "../schema/gates.js";
import { parseCheckRollup } from "../github/parse.js";
import { defaultReviewers } from "./predicates.js";
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

const OPTIONS = {
  roundPolicyDefault: "bounded" as const,
  stallMinutes: 30,
  now: NOW,
  excludeCheckNames: [] as readonly string[],
};

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

  it("reports the context: reviewers, approvers, policy, head, both carve-outs", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    expect(evaluation.context).toEqual({
      reviewers: ["sasuke", "tenma", "copilot"],
      approvers: ["sasuke", "tenma"],
      approvalPolicy: "required",
      policy: "bounded",
      headSha: HEAD,
      deliveryPr: false,
      // CON-30's carve-out is reported on EVERY evaluation, false included:
      // "this pull request was not carved out" is a fact a reader of a ready
      // verdict needs as much as the opposite one (zheref/nen#18).
      dependabotCarveOut: false,
      // No `--exclude-check <name>` was given, so there is nothing to warn
      // about matching or not matching.
      warnings: [],
      // The fixture declares no `checks.excluded` (zheref/nen#249).
      declaredExclusions: [],
    });
  });
});

describe("evaluateReady -- explicit review-round-only approval policy", () => {
  const roundsOnly = parseGateIdentities("/fake/nen/gates.json", {
    version: 1,
    reviewers: [{ name: "copilot", login_pattern: { pattern: "^copilot$", ignoreCase: true } }],
    approval_policy: "review-round-only",
    default_approvers: [],
    base_reviewers: ["copilot"],
    delivery: {
      author_pattern: { pattern: "^maintainer$", ignoreCase: true },
      head_ref_prefixes: ["codex/"],
    },
    dependabot_carve_out: {
      author_pattern: { pattern: "^dependency-bot$", ignoreCase: true },
      satisfied_by_context: ["review shim"],
    },
  });
  const commentedRound = {
    ...readyState(),
    reviews: [{ author: "copilot", state: "COMMENTED", commit_id: HEAD, submitted_at: NOW }],
  };

  it("reports honestly that no separate APPROVED review is required", () => {
    const evaluation = evaluateReady(roundsOnly, commentedRound, OPTIONS);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.context.approvers).toEqual([]);
    expect(evaluation.context.approvalPolicy).toBe("review-round-only");
    expect(evaluation.conjuncts.find((row) => row.id === "approvals-at-head")?.note).toContain(
      "human merge authority remains separate",
    );
  });

  it("keeps the policy disclosure when a dependency carve-out also supplies review evidence", () => {
    const evaluation = evaluateReady(
      roundsOnly,
      {
        ...commentedRound,
        author: "dependency-bot",
        checks: [greenCheck(), greenCheck("review shim")],
      },
      OPTIONS,
    );
    const note = evaluation.conjuncts.find((row) => row.id === "approvals-at-head")?.note;
    expect(note).toContain("dependabot_carve_out");
    expect(note).toContain("human merge authority remains separate");
  });

  it("still refuses a missing current-head round and an unresolved thread", () => {
    expect(evaluateReady(roundsOnly, { ...commentedRound, reviews: [] }, OPTIONS).firstFailing).toBe(
      "rounds-owed",
    );
    expect(
      evaluateReady(roundsOnly, { ...commentedRound, unresolved_threads: 1 }, OPTIONS).firstFailing,
    ).toBe("unresolved-threads");
  });

  it("does not silently ignore a conditional approver that joins the effective set", () => {
    const withConditionalApprover = parseGateIdentities("/fake/nen/gates.json", {
      version: 1,
      reviewers: [
        { name: "copilot", login_pattern: { pattern: "^copilot$", ignoreCase: true } },
        {
          name: "audit",
          login_pattern: { pattern: "^audit$", ignoreCase: true },
          approves_when_posted_at_head: true,
          round_check_pattern: { pattern: "^audit / review$", ignoreCase: true },
        },
      ],
      approval_policy: "review-round-only",
      default_approvers: [],
      base_reviewers: ["copilot", "audit"],
      delivery: {
        author_pattern: { pattern: "^maintainer$", ignoreCase: true },
        head_ref_prefixes: ["codex/"],
      },
    });
    const evaluation = evaluateReady(
      withConditionalApprover,
      {
        ...commentedRound,
        checks: [greenCheck(), greenCheck("audit / review")],
        reviews: [
          ...commentedRound.reviews,
          { author: "audit", state: "COMMENTED", commit_id: HEAD, submitted_at: NOW },
        ],
      },
      OPTIONS,
    );
    expect(evaluation.firstFailing).toBe("approvals-at-head");
    expect(evaluation.conjuncts.find((row) => row.id === "approvals-at-head")?.note).toBeNull();
  });
});

describe("evaluateReady -- CON-30's dependency-author carve-out (zheref/nen#18)", () => {
  // The fixture declares `dependabot_carve_out`: author `^dependabot(\[bot\])?$`,
  // satisfied by `sasuke / audit` and `tenma / review` -- the two contexts the
  // review shim reports. A dependency bot's PR carries NO review round and NO
  // approval, which is exactly the state every case below starts from.
  const SHIMMED = [greenCheck(), greenCheck("sasuke / audit"), greenCheck("tenma / review")];

  function botState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return readyState({
      author: "dependabot[bot]",
      checks: SHIMMED,
      reviews: [],
      review_requests: [],
      ...overrides,
    });
  }

  it("never clears rows on a head nobody read: no head_sha is NEVER ready, carve-out or not (Copilot, zheref/nen#255)", () => {
    // The carve-out needs no head of its own. Evaluated ahead of the head
    // check, it marked rows 3-5 ready and the verdict came out `ready` with no
    // judged commit at all.
    const evaluation = evaluateReady(IDENTITIES, botState({ head_sha: "" }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.context.headSha).toBe("");
    expect(evaluation.context.dependabotCarveOut).toBe(false);
    for (const id of ["round-stalled", "rounds-owed", "approvals-at-head"] as const) {
      const row = evaluation.conjuncts.find((c): boolean => c.id === id);
      expect(row?.status).toBe("unevaluated");
      expect(row?.missing).toMatch(/no head SHA was read/);
      expect(row?.note).toBeNull();
    }
  });

  it("clears the three CON-32(b) rows for the declared author when every context is green", () => {
    const evaluation = evaluateReady(IDENTITIES, botState(), OPTIONS);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.line).toBe("ready");
    expect(evaluation.context.dependabotCarveOut).toBe(true);
    // NEVER A SILENT EXEMPTION (CON-30): the rows it satisfied say so, by field
    // name, and no other row does.
    const noted = evaluation.conjuncts.filter((c): boolean => c.note !== null);
    expect(noted.map((c): ConjunctId => c.id)).toEqual([
      "round-stalled",
      "rounds-owed",
      "approvals-at-head",
    ]);
    for (const conjunct of noted) {
      expect(conjunct.status).toBe("ready");
      expect(conjunct.note).toContain("dependabot_carve_out");
      expect(conjunct.note).toContain("sasuke / audit, tenma / review");
    }
  });

  it("does NOT fire for anyone else with the identical context set", () => {
    // The control. Same shimmed checks, same absent reviews -- a different
    // author. If this passed, the carve-out would be an exemption for whoever
    // arranged the right check names, which is the opposite of what it is.
    const evaluation = evaluateReady(IDENTITIES, botState({ author: "alice" }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.context.dependabotCarveOut).toBe(false);
    expect(evaluation.firstFailing).toBe("rounds-owed");
    expect(evaluation.conjuncts.every((c): boolean => c.note === null)).toBe(true);
  });

  it("is satisfied by PRESENCE, never by absence: one context missing and the gate runs as usual", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      botState({ checks: [greenCheck(), greenCheck("sasuke / audit")] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.context.dependabotCarveOut).toBe(false);
    expect(evaluation.firstFailing).toBe("rounds-owed");
  });

  it("is not reached at all when a shimmed context is RED -- CON-32(a) still runs first", () => {
    // A dependency PR is never exempted from having checks, and never from
    // their being green. The carve-out sits AFTER row 2 for this reason.
    const evaluation = evaluateReady(
      IDENTITIES,
      botState({
        checks: [
          greenCheck(),
          { name: "sasuke / audit", status: "COMPLETED", conclusion: "FAILURE" },
          greenCheck("tenma / review"),
        ],
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("checks-green");
    expect(evaluation.context.dependabotCarveOut).toBe(false);
  });

  it("does not clear CON-32(d): an unresolved thread still fails, carve-out or not", () => {
    // A human who did open a thread on a dependency PR is owed an answer. The
    // carve-out stands in for review ROUNDS, not for a conversation.
    const evaluation = evaluateReady(IDENTITIES, botState({ unresolved_threads: 2 }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("unresolved-threads");
    expect(evaluation.context.dependabotCarveOut).toBe(true);
    // The rows it DID satisfy still explain themselves; the failing row does not
    // carry a passing note.
    expect(evaluation.conjuncts.find((c): boolean => c.id === "rounds-owed")?.note).toContain(
      "dependabot_carve_out",
    );
    expect(
      evaluation.conjuncts.find((c): boolean => c.id === "unresolved-threads")?.note,
    ).toBeNull();
  });

  it("reaches the SAME verdict a normally-reviewed pull request would", () => {
    // The shadow-window shape #18 asks for, as a fixture comparison: the only
    // difference between these two states is that one was reviewed by people
    // and the other was shimmed. Both are ready.
    const reviewed = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    const shimmed = evaluateReady(IDENTITIES, botState(), OPTIONS);
    expect(shimmed.ready).toBe(reviewed.ready);
    expect(shimmed.line).toBe(reviewed.line);
    expect(shimmed.conjuncts.map((c): string => c.status)).toEqual(
      reviewed.conjuncts.map((c): string => c.status),
    );
  });
});

describe("evaluateReady -- every row is evaluated; the verdict stays the conjunction (zheref/nen#248)", () => {
  const status = (evaluation: ReturnType<typeof evaluateReady>): Map<ConjunctId, string> =>
    new Map(evaluation.conjuncts.map((c): [ConjunctId, string] => [c.id, c.status]));

  it("THE REGRESSION: a red check AND an unresolved thread are BOTH reported, not the first alone", () => {
    // zheref/nen#247, 2026-09-23: row 2 failed on a Windows job ruled out of
    // scope, and row 6 -- two real unresolved Copilot threads -- was printed
    // `unevaluated`. A caller reading the verdict saw one infrastructure
    // failure and the PR was called ready on that basis.
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        checks: [greenCheck(), { name: "windows / test", status: "COMPLETED", conclusion: "FAILURE" }],
        unresolved_threads: 2,
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.failing).toEqual(["checks-green", "unresolved-threads"]);
    // `firstFailing` and the LINE are exactly what they were: the first failure.
    expect(evaluation.firstFailing).toBe("checks-green");
    expect(evaluation.line).toBe("not-ready: required checks reported but are not all green (CON-32a)");
    const threads = evaluation.conjuncts.find((c): boolean => c.id === "unresolved-threads");
    expect(threads?.status).toBe("failed");
    expect(threads?.reason).toBe("not-ready: 2 unresolved review thread(s) (CON-32d)");
    // The rows between them were evaluated and passed -- not `unevaluated`.
    const statuses = status(evaluation);
    expect(statuses.get("round-stalled")).toBe("ready");
    expect(statuses.get("rounds-owed")).toBe("ready");
    expect(statuses.get("approvals-at-head")).toBe("ready");
  });

  it("mergeable failing first no longer hides the rest: every other row is evaluated on its own evidence", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ mergeable: "CONFLICTING" }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("mergeable");
    expect(evaluation.failing).toEqual(["mergeable"]);
    expect(evaluation.line).toBe(
      "not-ready: mergeable=CONFLICTING (expected MERGEABLE — CON-42/1's added predicate)",
    );
    const [mergeable, ...rest] = evaluation.conjuncts;
    expect(mergeable?.status).toBe("failed");
    expect(mergeable?.reason).toBe(evaluation.line);
    for (const conjunct of rest) {
      expect(conjunct.status).toBe("ready");
      expect(conjunct.reason).toBeNull();
      expect(conjunct.missing).toBeNull();
    }
  });

  it("a stalled round fails BOTH CON-32(b) rows it is (stalled and owed); the line stays the stall's", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        review_requests: [{ login: "copilot-pull-request-reviewer[bot]" }],
        stall_requested_at: "2025-06-01T11:00:00Z",
      }),
      OPTIONS,
    );
    expect(evaluation.failing).toEqual(["round-stalled", "rounds-owed"]);
    expect(evaluation.line).toMatch(/^not-ready: copilot round stalled/);
  });

  it("an owed round and a missing APPROVE are both reported -- each is its own predicate", () => {
    // tenma posted nothing: its round is owed AND it has no APPROVE at head.
    const evaluation = evaluateReady(IDENTITIES, readyState({ reviews: [approvedAtHead("sasuke")] }), OPTIONS);
    expect(evaluation.failing).toEqual(["rounds-owed", "approvals-at-head"]);
    expect(evaluation.firstFailing).toBe("rounds-owed");
  });

  it("no head SHA: the three CON-32(b) rows are unknown and NAME the missing fact, never a blanket `unevaluated`", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ head_sha: "" }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.failing).toEqual([]);
    expect(evaluation.firstFailing).toBeNull();
    for (const id of ["round-stalled", "rounds-owed", "approvals-at-head"] as const) {
      const row = evaluation.conjuncts.find((c): boolean => c.id === id);
      expect(row?.status).toBe("unevaluated");
      expect(row?.missing).toMatch(/no head SHA was read/);
      expect(row?.reason).toBeNull();
    }
    // An unknown row is never a pass, so with no failure the line names it.
    expect(evaluation.line).toMatch(/^not-ready: CON-32\(b\) could not be judged — no head SHA was read/);
    expect(evaluation.context.headSha).toBe("");
  });

  it("an unreadable rollup fails row 2 and leaves the rows that read it unknown -- the thread row is still judged", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: "not-an-array", unresolved_threads: 1 }),
      OPTIONS,
    );
    expect(evaluation.failing).toEqual(["checks-green", "unresolved-threads"]);
    const owed = evaluation.conjuncts.find((c): boolean => c.id === "rounds-owed");
    expect(owed?.status).toBe("unevaluated");
    expect(owed?.missing).toMatch(/check rollup could not be read/);
  });

  it("unreadable reviews fail rounds-owed (obligation A) and leave stalled/approvals unknown by name", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ reviews: "nope" }), OPTIONS);
    expect(evaluation.firstFailing).toBe("rounds-owed");
    expect(evaluation.line).toMatch(/^not-ready: the PR state could not be read/);
    const approvals = evaluation.conjuncts.find((c): boolean => c.id === "approvals-at-head");
    expect(approvals?.status).toBe("unevaluated");
    expect(approvals?.missing).toMatch(/reviews could not be read/);
  });

  it("the LAST row failing still leaves every earlier row `ready`", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ unresolved_threads: 3 }), OPTIONS);
    expect(evaluation.firstFailing).toBe("unresolved-threads");
    expect(evaluation.failing).toEqual(["unresolved-threads"]);
    const statuses = status(evaluation);
    expect(statuses.get("mergeable")).toBe("ready");
    expect(statuses.get("checks-green")).toBe("ready");
    expect(statuses.get("round-stalled")).toBe("ready");
    expect(statuses.get("rounds-owed")).toBe("ready");
    expect(statuses.get("approvals-at-head")).toBe("ready");
    expect(statuses.get("unresolved-threads")).toBe("failed");
  });

  it("a ready verdict has an empty `failing` list", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    expect(evaluation.ready).toBe(true);
    expect(evaluation.failing).toEqual([]);
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

  it("a PENDING run whose conclusion gh wrote as \"\" is judged, and never ready (zheref/nen#304)", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        checks: [greenCheck("ci / lint"), { name: "ci / build", status: "IN_PROGRESS", conclusion: "" }],
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("checks-green");
    // Judged, not unreadable: the normalization reaches the gate as a run
    // still deciding, never as a parse failure and never as green.
    expect(evaluation.line).not.toMatch(/could not be read/);
    expect(evaluation.line).toMatch(/\(CON-32a\)/);
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

describe("evaluateReady -- skipped checks and drafts (zheref/nen#331, ruling 2026-10-02)", () => {
  const skipped = (name: string): Record<string, unknown> => ({
    name,
    status: "COMPLETED",
    conclusion: "SKIPPED",
  });
  const row = (evaluation: ReturnType<typeof evaluateReady>, id: ConjunctId): Conjunct | undefined =>
    evaluation.conjuncts.find((c): boolean => c.id === id);

  it("ONLY SKIPPED checks at head is not-ready, and the reason names each one instead of calling it green", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [skipped("readiness"), skipped("snapshots"), skipped("windows")] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("checks-green");
    expect(evaluation.line).toMatch(/^not-ready: no check SUCCEEDED at head \(CON-32a\)/);
    expect(evaluation.line).toContain("readiness (SKIPPED), snapshots (SKIPPED), windows (SKIPPED)");
  });

  it("ONE SUCCESS beside ONE SKIPPED is ready, and the row's note names the skipped check", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [greenCheck(), skipped("windows")] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    expect(row(evaluation, "checks-green")?.note).toBe(
      "admitted beside a SUCCESS, not verified: windows (SKIPPED)",
    );
  });

  it("an all-SUCCESS head carries no note", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    expect(row(evaluation, "checks-green")?.note).toBeNull();
  });

  it("a DRAFT is never ready, even MERGEABLE with every other row passing", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ is_draft: true }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("mergeable");
    expect(evaluation.line).toMatch(/^not-ready: the PR is a DRAFT \(CON-42\/1\)/);
  });

  it("is_draft false or absent leaves row 1 to mergeable alone", () => {
    expect(evaluateReady(IDENTITIES, readyState({ is_draft: false }), OPTIONS).ready).toBe(true);
    expect(evaluateReady(IDENTITIES, readyState(), OPTIONS).ready).toBe(true);
  });
});

describe("evaluateReady -- --exclude-check (zheref/hatsu#81)", () => {
  it("with no exclusion, an all-green rollup that includes the consumer's own check reads ready", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [greenCheck(), greenCheck("readiness")] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
  });

  it("excluding the ONLY check present yields the DISTINCT 'no checks reported (after excluding: ...)' message, never `ready`", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState({ checks: [greenCheck("readiness")] }), {
      ...OPTIONS,
      excludeCheckNames: ["readiness"],
    });
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("checks-green");
    expect(evaluation.line).toMatch(/^not-ready: no checks reported \(after excluding: readiness\)/);
    expect(evaluation.line).not.toMatch(/EMPTY rollup, not a red one/);
  });

  it("a MIXED rollup drops only the named check and judges the rest -- ready when what remains is green", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [greenCheck(), greenCheck("readiness")] }),
      { ...OPTIONS, excludeCheckNames: ["readiness"] },
    );
    expect(evaluation.ready).toBe(true);
  });

  it("a MIXED rollup drops only the named check and still fails CON-32(a) on the check that remains red", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        checks: [
          { name: "ci / build", status: "COMPLETED", conclusion: "FAILURE" },
          greenCheck("readiness"),
        ],
      }),
      { ...OPTIONS, excludeCheckNames: ["readiness"] },
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.line).toBe("not-ready: required checks reported but are not all green (CON-32a)");
  });

  it("a comma-joined multi-name exclusion drops every named check", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [greenCheck("readiness"), greenCheck("status-summary")] }),
      { ...OPTIONS, excludeCheckNames: ["readiness", "status-summary"] },
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.line).toMatch(
      /^not-ready: no checks reported \(after excluding: readiness, status-summary\)/,
    );
  });

  // The false-ready hazard `--exclude-check` exists to close: a typo'd name
  // that matches nothing in the rollup used to be a SILENT no-op. It now
  // surfaces as a `context.warnings` entry (rendered by `--explain` and in
  // `--json`'s `meta.warnings` -- see ../verbs/pr_ready.ts), and the rollup it
  // was applied to is left completely intact -- a typo excludes nothing, so
  // the gate judges every check exactly as if the flag had never been passed.
  it("a typo'd --exclude-check name produces a warning and leaves the rollup intact", () => {
    const evaluation = evaluateReady(IDENTITIES, readyState(), {
      ...OPTIONS,
      excludeCheckNames: ["ci / biuld"],
    });
    expect(evaluation.context.warnings).toEqual([
      "--exclude-check 'ci / biuld' matched no check in the rollup",
    ]);
    // The rollup is untouched: the one real check ("ci / build") is still
    // judged, still green, and the gate still reaches `ready`.
    expect(evaluation.ready).toBe(true);
  });

  it("a mix of a matching and an unmatched --exclude-check name warns only about the unmatched one", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [greenCheck(), greenCheck("readiness")] }),
      { ...OPTIONS, excludeCheckNames: ["readiness", "does-not-exist"] },
    );
    expect(evaluation.context.warnings).toEqual([
      "--exclude-check 'does-not-exist' matched no check in the rollup",
    ]);
    expect(evaluation.ready).toBe(true);
  });
});

describe("evaluateReady -- declared checks.excluded (zheref/nen#249)", () => {
  // The fixture identities, plus a `checks.excluded` block: the same file a
  // repository would carry, read through the same loader.
  const FIXTURE_RAW = JSON.parse(
    readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8"),
  ) as Record<string, unknown>;
  const WINDOWS = 'check (Windows, ["self-hosted","Windows","X64"])';
  const RULING = {
    name: WINDOWS,
    reason: "the maintainer ruled Windows out of scope until a runner exists",
    ruled: "2025-05-01",
    until: { condition: "a Windows runner exists" },
  };
  function declaring(...excluded: Record<string, unknown>[]): ReturnType<typeof parseGateIdentities> {
    return parseGateIdentities("/fixture/nen/gates.json", { ...FIXTURE_RAW, checks: { excluded } });
  }
  const redWindows = { name: WINDOWS, status: "COMPLETED", conclusion: "FAILURE" };

  it("an excluded RED matrix check still yields ready when every other row passes, and the row names it with its reason", () => {
    const evaluation = evaluateReady(
      declaring(RULING),
      readyState({ checks: [greenCheck(), redWindows] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    const row = evaluation.conjuncts.find((c): boolean => c.id === "checks-green");
    expect(row?.note).toBe(
      `excluded by declaration: ${WINDOWS} — ${RULING.reason} (ruled 2025-05-01, until a Windows runner exists)`,
    );
    expect(evaluation.context.declaredExclusions).toEqual([
      { ...RULING, match: "exact", status: "honoured", matched: [WINDOWS] },
    ]);
    // Never silent (Feitan F2): the notice rides in the warnings too, and a
    // condition nen cannot evaluate says so on every run (Feitan F3).
    expect(evaluation.context.warnings).toEqual([
      `excluded by declaration: ${WINDOWS} — ${RULING.reason} (ruled 2025-05-01, until a Windows runner exists)`,
      `declared exclusion '${WINDOWS}' (/fixture/nen/gates.json checks.excluded) is in force on a CONDITION nen cannot evaluate: "a Windows runner exists". It lapses only when the file is edited; re-check the condition.`,
    ]);
  });

  it("the SAME check undeclared yields not-ready", () => {
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({ checks: [greenCheck(), redWindows] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("checks-green");
  });

  it("a check that never starts (queued forever, no runner) is excluded just the same", () => {
    const evaluation = evaluateReady(
      declaring(RULING),
      readyState({ checks: [greenCheck(), { name: WINDOWS, status: "QUEUED", conclusion: null }] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
  });

  it("a glob drops every matrix leg it names and nothing else", () => {
    const glob = { ...RULING, name: "check (Windows*", match: "glob" };
    const legs = [
      redWindows,
      { name: "check (Windows, arm64)", status: "COMPLETED", conclusion: "FAILURE" },
    ];
    const ready = evaluateReady(declaring(glob), readyState({ checks: [greenCheck(), ...legs] }), OPTIONS);
    expect(ready.ready).toBe(true);
    expect(ready.context.declaredExclusions[0]?.matched).toEqual([WINDOWS, "check (Windows, arm64)"]);
    const linux = evaluateReady(
      declaring(glob),
      readyState({
        checks: [greenCheck(), ...legs, { name: "check (Linux)", status: "COMPLETED", conclusion: "FAILURE" }],
      }),
      OPTIONS,
    );
    expect(linux.ready).toBe(false);
  });

  it("an exact name does not match a neighbour that merely contains it", () => {
    const evaluation = evaluateReady(
      declaring({ ...RULING, name: "check" }),
      readyState({ checks: [greenCheck(), redWindows] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.context.declaredExclusions[0]?.matched).toEqual([]);
  });

  it("is honoured THROUGH its until date and ignored -- and named EXPIRED -- the day after", () => {
    const dated = { ...RULING, until: "2025-06-01" };
    const onTheDay = evaluateReady(declaring(dated), readyState({ checks: [greenCheck(), redWindows] }), {
      ...OPTIONS,
      now: "2025-06-01T23:59:59Z",
    });
    expect(onTheDay.ready).toBe(true);
    const after = evaluateReady(declaring(dated), readyState({ checks: [greenCheck(), redWindows] }), {
      ...OPTIONS,
      now: "2025-06-02T00:00:00Z",
    });
    expect(after.ready).toBe(false);
    expect(after.firstFailing).toBe("checks-green");
    expect(after.context.declaredExclusions[0]?.status).toBe("expired");
    expect(after.context.declaredExclusions[0]?.matched).toEqual([WINDOWS]);
    expect(after.context.warnings).toEqual([
      `declared exclusion '${WINDOWS}' (/fixture/nen/gates.json checks.excluded) EXPIRED — until 2025-06-01 has passed, so it is no longer honoured; counted on CON-32(a): ${WINDOWS}. Renew the ruling with a new until, or delete the entry.`,
    ]);
  });

  it("an expired exclusion is named even when it matches nothing at this head", () => {
    const evaluation = evaluateReady(
      declaring({ ...RULING, ruled: "2025-04-01", until: "2025-05-15" }),
      readyState(),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    expect(evaluation.context.warnings[0]).toMatch(/EXPIRED[\s\S]*it names no check at this head/);
  });

  it("a ruling dated after today is NOT YET in force: not honoured, and named", () => {
    const evaluation = evaluateReady(
      declaring({ ...RULING, ruled: "2025-06-02", until: "2025-12-31" }),
      readyState({ checks: [greenCheck(), redWindows] }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.context.declaredExclusions[0]?.status).toBe("not-yet-ruled");
    expect(evaluation.context.warnings).toEqual([
      `declared exclusion '${WINDOWS}' (/fixture/nen/gates.json checks.excluded) NOT honoured — ruled 2025-06-02 is after today (UTC), so the ruling is not in force yet; counted on CON-32(a): ${WINDOWS}.`,
    ]);
    // ...and from its own day on, it is.
    expect(
      evaluateReady(declaring({ ...RULING, ruled: "2025-06-01" }), readyState({ checks: [greenCheck(), redWindows] }), OPTIONS)
        .ready,
    ).toBe(true);
  });

  it("names the source the caller says the exclusions came from (the base, in pr ready)", () => {
    const evaluation = evaluateReady(
      declaring({ ...RULING, until: "2025-01-02", ruled: "2025-01-01" }),
      readyState(),
      { ...OPTIONS, declaredExclusionsSource: "o/r@base:nen/gates.json checks.excluded" },
    );
    expect(evaluation.context.warnings[0]).toContain("(o/r@base:nen/gates.json checks.excluded) EXPIRED");
  });

  it("an unreadable clock honours NO dated exclusion, and says so", () => {
    const evaluation = evaluateReady(
      declaring({ ...RULING, until: "2099-01-01" }),
      readyState({ checks: [greenCheck(), redWindows] }),
      { ...OPTIONS, now: "not a time" },
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.context.declaredExclusions[0]?.status).toBe("unknown-date");
    expect(evaluation.context.warnings[0]).toMatch(/NOT honoured — the evaluation time 'not a time'/);
    // An unreadable clock honours NO exclusion, a condition one included.
    expect(
      evaluateReady(declaring(RULING), readyState({ checks: [greenCheck(), redWindows] }), { ...OPTIONS, now: "x" })
        .context.declaredExclusions[0]?.status,
    ).toBe("unknown-date");
  });

  it("a rollup holding only declared-excluded checks keeps the ABSENT finding, naming them", () => {
    const evaluation = evaluateReady(declaring(RULING), readyState({ checks: [redWindows] }), OPTIONS);
    expect(evaluation.ready).toBe(false);
    expect(evaluation.line).toMatch(
      /^not-ready: no checks reported \(after excluding: check \(Windows, \["self-hosted","Windows","X64"\]\)\) \(CON-32a\)/,
    );
  });

  it("combines with --exclude-check: both sources drop, and the absent finding names both once", () => {
    const evaluation = evaluateReady(
      declaring(RULING),
      readyState({ checks: [redWindows, greenCheck("readiness")] }),
      { ...OPTIONS, excludeCheckNames: ["readiness", WINDOWS] },
    );
    expect(evaluation.line).toMatch(/after excluding: readiness, check \(Windows/);
    expect(evaluation.line.split(WINDOWS).length - 1).toBe(1);
  });

  it("does not excuse an all-skipped head: a skip beside an excluded check is still nothing verified", () => {
    const evaluation = evaluateReady(
      declaring(RULING),
      readyState({
        checks: [redWindows, { name: "ci / build", status: "COMPLETED", conclusion: "SKIPPED" }],
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(false);
    expect(evaluation.line).toMatch(/no check SUCCEEDED at head/);
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

  it("respects a repository-declared round_policy.stallMinutes override, not just the caller's fixed default", () => {
    // A stall bound of 5 minutes: a request 10 minutes old is already stalled,
    // where the 30-minute OPTIONS default would still be waiting.
    const evaluation = evaluateReady(
      IDENTITIES,
      pendingCopilot("2025-06-01T11:50:00Z"),
      { ...OPTIONS, stallMinutes: 5 },
    );
    expect(evaluation.firstFailing).toBe("round-stalled");
    expect(evaluation.line).toBe(
      "not-ready: copilot round stalled — requested 10 min ago and never posted (CON-32b; re-request it, a user token is required)",
    );
  });
});

describe("evaluateReady -- BOUNDED round policy, any-head limb (zheref/nen#214)", () => {
  // Sasuke posted its round at an EARLIER head; the current head carries only
  // a remediation push nothing re-reviewed. Under `bounded` (the default)
  // that round still satisfies CON-32(b)'s owed limb -- a THIRD round must
  // never become structurally required just because the head moved.
  function remediatedState(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return readyState({
      reviews: [
        approvedAtHead("sasuke", "r1sha"),
        approvedAtHead("tenma", "r1sha"),
      ],
      ...overrides,
    });
  }

  it("under STRICT a round-only-at-an-earlier-head still owes -- the OLD behaviour, unchanged", () => {
    const evaluation = evaluateReady(IDENTITIES, remediatedState(), {
      ...OPTIONS,
      roundPolicyDefault: "strict",
    });
    expect(evaluation.ready).toBe(false);
    expect(evaluation.firstFailing).toBe("rounds-owed");
  });

  it("under BOUNDED the owed limb clears on the earlier-head round; the APPROVE-at-head conjunct still fails on its own", () => {
    // pendingRounds() clears (sasuke/tenma showed up), but
    // reviewsAllApprovedAtHead() still requires the LATEST round to be an
    // APPROVE AT the CURRENT head -- CON-16 -- so the gate still stops, one
    // row later, with a DIFFERENT reason than "no round at head" at all.
    const evaluation = evaluateReady(IDENTITIES, remediatedState(), OPTIONS);
    expect(evaluation.firstFailing).toBe("approvals-at-head");
    expect(evaluation.line).toContain("not every approving reviewer's latest round is an APPROVE");
  });

  it("the zheref/nen#214 shape: a NON-EXEMPT, non-approving reviewer's round at an EARLIER head, everything else at head, reads ready", () => {
    // `bisky` is deliberately NOT `bounded_policy_exempt` in the fixture --
    // its round is ordinarily current-head-only, exactly the shape #214 was
    // about for a reviewer that has no such exemption at all. It has no
    // `bisky / review` check in this rollup (so the round-check limb cannot
    // clear it either) and never posted AT head, only at the PR's first head,
    // so `approvesWhenPostedAtHead` never enrols it as an approver -- only
    // Sasuke and Tenma (current at head, as any ordinary ready PR) are.
    // #214's failure was exactly this shape reading
    // `not-ready: ... bisky (no round at head)` forever after a remediation
    // push; under `bounded` it now reads ready.
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        reviewers: "sasuke,tenma,bisky",
        reviews: [
          approvedAtHead("sasuke"),
          approvedAtHead("tenma"),
          { author: "bisky-bankai[bot]", state: "COMMENTED", commit_id: "r1sha", submitted_at: NOW },
        ],
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    expect(evaluation.line).toBe("ready");
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
        checks: [greenCheck(), { name: "bisky / review", status: "COMPLETED", conclusion: "SUCCESS" }],
        // bisky posts nothing; its round check alone satisfies rounds-owed.
        // SUCCESS, not the NEUTRAL this case once carried: since E7's finding
        // C1 only a definitive SUCCESS is a round-check round (a NEUTRAL may be
        // a run cancelled by the next push). The approver-set property this
        // case is about is unchanged by the conclusion.
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    expect(evaluation.context.approvers).toEqual(["sasuke", "tenma"]);
  });

  it("a conditional approver posted at a SUPERSEDED commit stays OUT of the approver set -- `&& review.commitId === head` is not decoration", () => {
    // PORT ADDITION test (zheref/nen#2's review record, finding 8): the two
    // cases above only ever exercise "posted at head" and "posted nothing" --
    // neither distinguishes the `&& review.commitId === head` half of the
    // enrolment guard from its absence. bisky's round check being at head
    // satisfies rounds-owed on its own; a review it left at a STALE commit
    // must not additionally enrol it into the approver set, or a reviewer that
    // said nothing about the CURRENT head would be read as though it had.
    const evaluation = evaluateReady(
      IDENTITIES,
      readyState({
        reviewers: "sasuke,tenma,bisky",
        // SUCCESS, so the comment above is TRUE: since E7's finding C1 only a
        // SUCCESS run is a round-check round. With the NEUTRAL this case once
        // carried it still passed, but only because bisky's stale-commit review
        // is itself a round under `bounded` (Nobunaga's delta review, nit N1).
        checks: [greenCheck(), { name: "bisky / review", status: "COMPLETED", conclusion: "SUCCESS" }],
        reviews: [
          approvedAtHead("sasuke"),
          approvedAtHead("tenma"),
          // A round at a superseded commit -- the PR moved on since bisky
          // looked at it.
          { author: "bisky", state: "CHANGES_REQUESTED", commit_id: "stalecommit", submitted_at: NOW },
        ],
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

// ── round_quorum, on THIS repository's own nen/gates.json (ruling 2026-09-29) ──
//
// "Copilot credits are exhausted. Expect Cursor instead. Let's make it canon on
// the repo so that we solve at least one round of reviews from both Copilot OR
// Cursor (or both) as applicable." Everything below reads the file the
// maintainer's gate actually reads (vitest's cwd is the repository root), not a
// fixture of it -- so a later edit to that file that changes these verdicts
// fails here, where it can be read, rather than on a pull request.
describe("evaluateReady -- round_quorum on this repository's nen/gates.json (ruling 2026-09-29)", () => {
  const OWN = loadGateIdentities(process.cwd());
  const OWN_RAW = JSON.parse(
    readFileSync(join(process.cwd(), "nen", "gates.json"), "utf8"),
  ) as Record<string, unknown>;
  // THE PRE-QUORUM READING: every nen release before the one that ships
  // `round_quorum` (v0.15.1 and v0.16.0 verified) ignores the key and applies
  // the rest of the file. Parsing the file with the key removed IS that
  // reading -- the only field such a reader drops is this one.
  const DECLARATION_ALONE = parseGateIdentities(
    "/as-read-by-a-pre-quorum-release/nen/gates.json",
    Object.fromEntries(Object.entries(OWN_RAW).filter(([key]): boolean => key !== "round_quorum")),
  );

  type BugbotCheck = "absent" | "in-progress" | "completed" | "skipped" | "neutral";
  interface Combo {
    readonly copilotReview: boolean;
    readonly bugbotReview: boolean;
    readonly copilotRequested: boolean;
    readonly bugbotCheck: BugbotCheck;
    /**
     * A clean `Cursor Bugbot` run on an EARLIER commit of this PR (option B of
     * the 2026-09-29 ruling), as ../github/pr_state.ts hands it over in
     * `earlier_round_checks`. Optional so the named single cases below read
     * as they did; the matrix states it for every case.
     */
    readonly bugbotEarlierRun?: boolean;
  }

  const CHECK_SHAPES: Readonly<Record<BugbotCheck, Record<string, unknown> | null>> = {
    absent: null,
    "in-progress": { name: "Cursor Bugbot", status: "IN_PROGRESS", conclusion: null },
    completed: { name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
    skipped: { name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SKIPPED" },
    // Finding C1: completed, but not SUCCESS -- Bugbot's NEUTRAL may be a run
    // cancelled by the next push. It enrols (non-SKIPPED) and is not a round.
    neutral: { name: "Cursor Bugbot", status: "COMPLETED", conclusion: "NEUTRAL" },
  };

  /**
   * The state the transport would assemble. `reviewers` is derived exactly as
   * ../github/pr_state.ts derives it when no `--reviewers` is given --
   * `defaultReviewers` over the rollup -- so enrolment is the real rule, not a
   * value this test chose. Every round is COMMENTED at an EARLIER head: a
   * bounded any-head round, the shape Copilot and Bugbot actually leave.
   */
  function stateFor(combo: Combo): Record<string, unknown> {
    const bugbotCheck = CHECK_SHAPES[combo.bugbotCheck];
    const checks = bugbotCheck === null ? [greenCheck()] : [greenCheck(), bugbotCheck];
    const parsed = parseCheckRollup(checks, "$.checks");
    if (!parsed.ok) throw new Error("fixture rollup did not parse");
    const reviews: Record<string, unknown>[] = [];
    if (combo.copilotReview) {
      reviews.push({ author: "copilot-pull-request-reviewer", state: "COMMENTED", commit_id: "r1sha", submitted_at: NOW });
    }
    if (combo.bugbotReview) {
      reviews.push({ author: "cursor", state: "COMMENTED", commit_id: "r1sha", submitted_at: NOW });
    }
    return readyState({
      checks,
      reviews,
      review_requests: combo.copilotRequested ? [{ login: "Copilot" }] : [],
      reviewers: defaultReviewers(OWN, parsed.value).join(","),
      earlier_round_checks:
        combo.bugbotEarlierRun === true
          ? [{ sha: "r0sha", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" }]
          : [],
    });
  }

  const COMBOS: Combo[] = [];
  for (const copilotReview of [false, true]) {
    for (const bugbotReview of [false, true]) {
      for (const copilotRequested of [false, true]) {
        for (const bugbotCheck of ["absent", "in-progress", "completed", "skipped", "neutral"] as const) {
          for (const bugbotEarlierRun of [false, true]) {
            COMBOS.push({ copilotReview, bugbotReview, copilotRequested, bugbotCheck, bugbotEarlierRun });
          }
        }
      }
    }
  }

  const label = (c: Combo): string =>
    `copilot ${c.copilotReview ? "reviewed" : "silent"}${c.copilotRequested ? " + requested" : ""}, ` +
    `bugbot ${c.bugbotReview ? "reviewed" : "silent"}, 'Cursor Bugbot' check ${c.bugbotCheck} at head` +
    `${c.bugbotEarlierRun === true ? ", clean at an earlier head" : ""}`;

  const rowOf = (evaluation: ReturnType<typeof evaluateReady>, id: ConjunctId): Conjunct => {
    const row = evaluation.conjuncts.find((conjunct): boolean => conjunct.id === id);
    if (row === undefined) throw new Error(`no ${id} row`);
    return row;
  };

  it("covers all 80 combinations", () => {
    expect(COMBOS).toHaveLength(80);
  });

  it.each(COMBOS.map((combo): [string, Combo] => [label(combo), combo]))(
    "%s",
    (_name, combo) => {
      // Expected, from first principles rather than from the code under test:
      // Enrolment is any non-SKIPPED run at head -- a NEUTRAL one included.
      const enrolled =
        combo.bugbotCheck === "in-progress" || combo.bugbotCheck === "completed" || combo.bugbotCheck === "neutral";
      const copilotOwed = combo.copilotRequested; // exempt: owed only while requested
      const copilotHas = combo.copilotReview;
      // Option B under `bounded`: a clean earlier-head run is a round, unless a
      // run is IN FLIGHT at head -- work in progress supersedes history.
      const bugbotEarlierRound = combo.bugbotEarlierRun === true && combo.bugbotCheck !== "in-progress";
      const bugbotHas = combo.bugbotReview || combo.bugbotCheck === "completed" || bugbotEarlierRound;
      const bugbotOwed = enrolled && !bugbotHas;
      const quorumMet = copilotHas || bugbotHas;

      const evaluation = evaluateReady(OWN, stateFor(combo), OPTIONS);
      expect(evaluation.context.reviewers).toEqual(enrolled ? ["copilot", "bugbot"] : ["copilot"]);
      const owedRow = rowOf(evaluation, "rounds-owed");
      expect(owedRow.status).toBe(!copilotOwed && !bugbotOwed && quorumMet ? "ready" : "failed");

      // The quorum is carried on the row whatever its outcome.
      expect(owedRow.roundQuorum).toMatchObject({
        anyOf: ["copilot", "bugbot"],
        minimum: 1,
        count: Number(copilotHas) + Number(bugbotHas),
        met: quorumMet,
      });

      // Each failure is named, and nothing that did not fail is.
      const reason = owedRow.reason ?? "";
      expect(reason.includes("copilot (review requested, not yet posted)")).toBe(copilotOwed);
      expect(reason.includes("bugbot (no round at head)")).toBe(bugbotOwed);
      expect(reason.includes("round quorum not met")).toBe(!quorumMet);
      if (!quorumMet) {
        const lack = {
          absent: "bugbot (no round, no 'Cursor Bugbot' check)",
          "in-progress": "bugbot (no round, 'Cursor Bugbot' check not yet completed)",
          skipped: "bugbot (no round, 'Cursor Bugbot' check SKIPPED)",
          neutral: "bugbot (no round, 'Cursor Bugbot' check concluded NEUTRAL, not SUCCESS)",
          completed: "unreachable: a completed check is a round",
        }[combo.bugbotCheck];
        expect(reason).toContain(lack);
        expect(reason).toContain(
          combo.copilotRequested ? "copilot (no round, review requested, not yet posted)" : "copilot (no round)",
        );
      }
      if (owedRow.status === "ready") expect(owedRow.note).toMatch(/^round quorum met \(/);

      // THE PRE-QUORUM READING -- the declaration alone -- is the per-reviewer
      // verdict, and the quorum only ever ADDS to it: whatever the declaration
      // refuses, the quorum-carrying file refuses too.
      const alone = rowOf(evaluateReady(DECLARATION_ALONE, stateFor(combo), OPTIONS), "rounds-owed");
      expect(alone.status).toBe(!copilotOwed && !bugbotOwed ? "ready" : "failed");
      expect(alone).not.toHaveProperty("roundQuorum");
      if (alone.status === "failed") expect(owedRow.status).toBe("failed");
      if (owedRow.status === "ready") expect(alone.status).toBe("ready");
    },
  );

  it("NOBODY reviewed: the line is the quorum's, word for word, and it is the only failing row", () => {
    // No review, no run at head, and no run on any earlier head either -- a
    // pull request no reviewer has touched. A pre-quorum release, which ignores
    // the quorum, reads this `ready`.
    const evaluation = evaluateReady(
      OWN,
      stateFor({ copilotReview: false, bugbotReview: false, copilotRequested: false, bugbotCheck: "absent" }),
      OPTIONS,
    );
    expect(evaluation.line).toBe(
      "not-ready: round quorum not met (0 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round), bugbot (no round, no 'Cursor Bugbot' check)",
    );
    expect(evaluation.failing).toEqual(["rounds-owed"]);
    expect(
      evaluateReady(
        DECLARATION_ALONE,
        stateFor({ copilotReview: false, bugbotReview: false, copilotRequested: false, bugbotCheck: "absent" }),
        OPTIONS,
      ).line,
    ).toBe("ready");
  });

  it("zheref/nen#281's shape (C1): NO review, and Bugbot's only run was CANCELLED (NEUTRAL) -- the quorum is NOT met", () => {
    // cc7a948 carried a NEUTRAL `Cursor Bugbot` run cancelled by the push of
    // 322a492, and nobody posted a review. Nothing about that is a round,
    // whether the run is at head or on an earlier commit.
    for (const state of [
      readyState({ reviews: [], reviewers: "copilot,bugbot", checks: [greenCheck(), CHECK_SHAPES.neutral] }),
      readyState({
        reviews: [],
        reviewers: "copilot",
        earlier_round_checks: [{ sha: "cc7a948", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "NEUTRAL" }],
      }),
    ]) {
      const row = rowOf(evaluateReady(OWN, state, OPTIONS), "rounds-owed");
      expect(row.status).toBe("failed");
      expect(row.reason).toContain("round quorum not met (0 of 2 with a round");
      expect(row.roundQuorum?.met).toBe(false);
    }
  });

  it("zheref/nen#279's shape: Bugbot ran ONCE, clean, at an EARLIER head -- under BOUNDED that is its round", () => {
    // 2851d2e carried the clean `Cursor Bugbot` run; 7cee8a5 was pushed after
    // and Bugbot never re-ran. The head rollup has no run, and no review was
    // posted -- the evidence is the earlier run, and option B counts it.
    const state = readyState({
      head_sha: "7cee8a59bb43b3859de705bbdf4ff5eaf278fddc",
      reviews: [],
      reviewers: "copilot",
      earlier_round_checks: [
        { sha: "2851d2ec9cae06fc0d4718a27afd085577014b53", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
      ],
    });
    const bounded = evaluateReady(OWN, state, OPTIONS);
    expect(bounded.ready).toBe(true);
    const row = rowOf(bounded, "rounds-owed");
    expect(row.note).toBe(
      "round quorum met (1 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round), bugbot (round: 'Cursor Bugbot' check completed at earlier head 2851d2e)",
    );
    expect(row.roundQuorum?.members[1]).toMatchObject({
      round: "round-check-earlier-head",
      roundCheck: { from: "earlier-head", sha: "2851d2ec9cae06fc0d4718a27afd085577014b53" },
    });

    // ...and under STRICT only the head counts, so the same blob is not-ready.
    const strict = evaluateReady(OWN, state, { ...OPTIONS, roundPolicyDefault: "strict" });
    expect(rowOf(strict, "rounds-owed").reason).toContain("bugbot (no round at head, no 'Cursor Bugbot' check)");
  });

  it("an owed round AND an unmet quorum: the owed sentence leads, byte for byte, and the quorum follows it", () => {
    const evaluation = evaluateReady(
      OWN,
      stateFor({ copilotReview: false, bugbotReview: false, copilotRequested: true, bugbotCheck: "absent" }),
      OPTIONS,
    );
    expect(evaluation.line).toBe(
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): " +
        "copilot (review requested, not yet posted)" +
        " — and round quorum not met (0 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round, review requested, not yet posted), bugbot (no round, no 'Cursor Bugbot' check)",
    );
  });

  it("a clean Cursor Bugbot run at head reads ready, and --explain's note says which member met the floor", () => {
    const evaluation = evaluateReady(
      OWN,
      stateFor({ copilotReview: false, bugbotReview: false, copilotRequested: false, bugbotCheck: "completed" }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    expect(rowOf(evaluation, "rounds-owed").note).toBe(
      "round quorum met (1 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round), bugbot (round: 'Cursor Bugbot' check completed)",
    );
  });

  it("a met quorum never excuses an owed round: Copilot requested, Bugbot's round had, still not-ready", () => {
    const evaluation = evaluateReady(
      OWN,
      stateFor({ copilotReview: false, bugbotReview: true, copilotRequested: true, bugbotCheck: "absent" }),
      OPTIONS,
    );
    expect(rowOf(evaluation, "rounds-owed").roundQuorum?.met).toBe(true);
    expect(evaluation.line).toBe(
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): " +
        "copilot (review requested, not yet posted)",
    );
  });

  it("a Cursor Bugbot check still RUNNING keeps bugbot owed even though Copilot's round meets the quorum", () => {
    const evaluation = evaluateReady(
      OWN,
      stateFor({ copilotReview: true, bugbotReview: false, copilotRequested: false, bugbotCheck: "in-progress" }),
      OPTIONS,
    );
    const row = rowOf(evaluation, "rounds-owed");
    expect(row.roundQuorum?.met).toBe(true);
    expect(row.reason).toBe(
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): bugbot (no round at head)",
    );
  });

  it("the stall bound is unchanged: a stalled Copilot request is row 3's line; row 4 carries owed AND quorum", () => {
    const evaluation = evaluateReady(
      OWN,
      {
        ...stateFor({ copilotReview: false, bugbotReview: false, copilotRequested: true, bugbotCheck: "absent" }),
        stall_requested_at: "2025-06-01T11:00:00Z",
      },
      OPTIONS,
    );
    expect(evaluation.firstFailing).toBe("round-stalled");
    expect(evaluation.line).toBe(
      "not-ready: copilot round stalled — requested 60 min ago and never posted (CON-32b; re-request it, a user token is required)",
    );
    expect(rowOf(evaluation, "rounds-owed").reason).toContain("— and round quorum not met");
  });

  describe("--reviewers given explicitly: the quorum is the FILE's policy and still applies", () => {
    it("--reviewers copilot, nobody reviewed: not-ready on the quorum alone", () => {
      const evaluation = evaluateReady(OWN, readyState({ reviews: [], reviewers: "copilot" }), OPTIONS);
      expect(evaluation.firstFailing).toBe("rounds-owed");
      expect(evaluation.line).toMatch(/^not-ready: round quorum not met \(0 of 2/);
    });

    it("--reviewers copilot, Bugbot reviewed though never named: the floor counts it and the row passes", () => {
      const evaluation = evaluateReady(
        OWN,
        readyState({
          reviews: [{ author: "cursor", state: "COMMENTED", commit_id: "r1sha", submitted_at: NOW }],
          reviewers: "copilot",
        }),
        OPTIONS,
      );
      expect(evaluation.ready).toBe(true);
    });

    it("--reviewers bugbot with only Copilot's round: bugbot is owed; the met quorum does not excuse it", () => {
      const evaluation = evaluateReady(
        OWN,
        readyState({
          reviews: [{ author: "copilot-pull-request-reviewer", state: "COMMENTED", commit_id: "r1sha", submitted_at: NOW }],
          reviewers: "bugbot",
        }),
        OPTIONS,
      );
      const row = rowOf(evaluation, "rounds-owed");
      expect(row.roundQuorum?.met).toBe(true);
      expect(row.reason).toBe(
        "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): bugbot (no round at head)",
      );
    });
  });

  it("under STRICT an earlier-head review no longer meets the floor, and the member says 'at head'", () => {
    const evaluation = evaluateReady(
      OWN,
      stateFor({ copilotReview: true, bugbotReview: false, copilotRequested: false, bugbotCheck: "absent" }),
      { ...OPTIONS, roundPolicyDefault: "strict" },
    );
    expect(evaluation.line).toBe(
      "not-ready: a configured reviewer's round is still owed at the current head (CON-32b): copilot (no round at head)" +
        " — and round quorum not met (0 of 2 with a round, 1 required, CON-32b): " +
        "copilot (no round at head), bugbot (no round at head, no 'Cursor Bugbot' check)",
    );
  });

  it("an unreadable reviews array fails row 4 with the parse error and carries NO quorum -- nothing was counted", () => {
    const evaluation = evaluateReady(OWN, readyState({ reviews: "not-an-array" }), OPTIONS);
    const row = rowOf(evaluation, "rounds-owed");
    expect(row.reason).toMatch(/the PR state could not be read/);
    expect(row).not.toHaveProperty("roundQuorum");
  });

  it("no head SHA: row 4 is unknown and carries NO quorum", () => {
    const row = rowOf(evaluateReady(OWN, readyState({ head_sha: "" }), OPTIONS), "rounds-owed");
    expect(row.status).toBe("unevaluated");
    expect(row).not.toHaveProperty("roundQuorum");
  });

  it("only row 4 ever carries the quorum, and it serialises there in --json", () => {
    const evaluation = evaluateReady(OWN, readyState({ reviews: [] }), OPTIONS);
    for (const conjunct of evaluation.conjuncts) {
      expect(Object.prototype.hasOwnProperty.call(conjunct, "roundQuorum")).toBe(conjunct.id === "rounds-owed");
    }
    const json = JSON.parse(JSON.stringify(evaluation.conjuncts)) as Record<string, unknown>[];
    expect(json[3]?.["roundQuorum"]).toMatchObject({ anyOf: ["copilot", "bugbot"], minimum: 1, met: false });
  });
});

describe("earlierRoundChecks -- the tolerant reader of `earlier_round_checks`", () => {
  it("reads well-formed runs and DROPS everything else -- a dropped run can only go uncounted", () => {
    expect(
      earlierRoundChecks({
        earlier_round_checks: [
          { sha: "a1", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
          { sha: "", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
          { sha: "b2", name: 7, status: "COMPLETED", conclusion: "SUCCESS" },
          { sha: "c3", name: "Cursor Bugbot", status: 1, conclusion: null },
          "not a run",
          null,
          ["a", "b"],
        ],
      }),
    ).toEqual([
      { sha: "a1", name: "Cursor Bugbot", status: "COMPLETED", conclusion: "SUCCESS" },
      { sha: "c3", name: "Cursor Bugbot", status: null, conclusion: null },
    ]);
  });

  it("reads absent, null and non-array as NONE -- every older blob and replay keeps its head-only reading", () => {
    expect(earlierRoundChecks({})).toEqual([]);
    expect(earlierRoundChecks({ earlier_round_checks: null })).toEqual([]);
    expect(earlierRoundChecks({ earlier_round_checks: "a1" })).toEqual([]);
  });
});

describe("evaluateReady -- round_quorum is ADDITIVE for a repository that declares none", () => {
  it("no row carries the key, row 4's note stays null, and the serialised table never mentions it", () => {
    // IDENTITIES is the bankai fixture, which declares no quorum: its report
    // must be byte-for-byte what it was before the key existed.
    const evaluation = evaluateReady(IDENTITIES, readyState(), OPTIONS);
    for (const conjunct of evaluation.conjuncts) {
      expect(conjunct).not.toHaveProperty("roundQuorum");
    }
    expect(evaluation.conjuncts.find((c) => c.id === "rounds-owed")?.note).toBeNull();
    expect(JSON.stringify(evaluation)).not.toContain("roundQuorum");
    expect(JSON.stringify(evaluation)).not.toContain("round quorum");
  });

  it("CON-30's carve-out satisfies the quorum's row too: the shim stands in for review rounds, all of them", () => {
    const raw = JSON.parse(
      readFileSync(join(BANKAI_REPO, "nen", "gates.json"), "utf8"),
    ) as Record<string, unknown>;
    const withQuorum = parseGateIdentities("/fixture/nen/gates.json", {
      ...raw,
      round_quorum: { any_of: ["copilot", "bugbot"], minimum: 1 },
    });
    const evaluation = evaluateReady(
      withQuorum,
      readyState({
        author: "dependabot[bot]",
        checks: [greenCheck(), greenCheck("sasuke / audit"), greenCheck("tenma / review")],
        reviews: [],
      }),
      OPTIONS,
    );
    expect(evaluation.ready).toBe(true);
    const row = evaluation.conjuncts.find((c) => c.id === "rounds-owed");
    expect(row?.note).toMatch(/^satisfied by dependabot_carve_out/);
    expect(row).not.toHaveProperty("roundQuorum");
  });
});
