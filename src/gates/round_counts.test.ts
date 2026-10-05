// Tests for ./round_counts.ts (zheref/nen#240): each reviewer's rounds against
// round_policy.minRounds/maxRounds, and the #361 quorum reading.

import { describe, expect, it } from "vitest";
import { countRounds, renderRoundCounts } from "./round_counts.js";
import type { QuorumMember, QuorumResult, ReviewerRoundFacts } from "./predicates.js";

const fact = (reviewer: string, overrides: Partial<ReviewerRoundFacts> = {}): ReviewerRoundFacts => ({
  reviewer,
  posted: 0,
  pendingRequest: false,
  round: null,
  loginPattern: new RegExp(`^${reviewer}$`, "i"),
  ...overrides,
});

const member = (reviewer: string, round: QuorumMember["round"], state: "completed" | "pending" | "absent" | null): QuorumMember => ({
  reviewer,
  round,
  reading: "any-head",
  requested: false,
  roundCheck:
    state === null
      ? null
      : { pattern: "x", name: state === "absent" ? null : "x", state, conclusion: null, from: state === "absent" ? null : "head", sha: null },
});

const quorum = (members: QuorumMember[], minimum = 1): QuorumResult => {
  const count = members.filter((entry): boolean => entry.round !== null).length;
  return { anyOf: members.map((entry): string => entry.reviewer), minimum, count, met: count >= minimum, members };
};

describe("countRounds", () => {
  it("counts requests by the reviewer's login pattern, and judges max: under, reached, over", () => {
    const counts = countRounds(
      [fact("a"), fact("b"), fact("c")],
      ["A", "b", "b", "c", "c", "c", "c", "someone-else"],
      null,
      3,
      undefined,
    );
    expect(counts.reviewers.map((entry) => [entry.reviewer, entry.requested, entry.max])).toEqual([
      ["a", 1, "under"],
      ["b", 2, "under"],
      ["c", 4, "over"],
    ]);
    expect(countRounds([fact("a")], ["a", "a", "a"], null, 3, undefined).reviewers[0]?.max).toBe("reached");
  });

  it("N10: a request is the reviewer's only when the WHOLE login matches -- 'copilot' never counts copilot-swe-agent", () => {
    const counts = countRounds(
      [fact("copilot", { loginPattern: /copilot/i })],
      ["Copilot", "copilot[bot]", "copilot-swe-agent", "not-copilot"],
      null,
      3,
      undefined,
    );
    expect(counts.reviewers[0]?.requested).toBe(2);
  });

  it("an unread timeline is 'unknown', never zero", () => {
    const counts = countRounds([fact("a")], null, 1, 3, undefined);
    expect(counts.requestsRead).toBe(false);
    expect(counts.reviewers[0]?.requested).toBeNull();
    expect(counts.reviewers[0]?.max).toBe("unknown");
  });

  it("a round its check holds counts as one round with no review posted", () => {
    const entry = countRounds([fact("bot", { round: "round-check" })], [], 1, null, undefined).reviewers[0];
    expect(entry?.posted).toBe(0);
    expect(entry?.rounds).toBe(1);
    expect(entry?.min).toBe("met");
    expect(entry?.max).toBe("no-ceiling");
  });

  it("posted reviews count one round each", () => {
    expect(countRounds([fact("a", { posted: 2, round: "review" })], [], 3, null, undefined).reviewers[0]).toMatchObject({
      rounds: 2,
      min: "owed",
    });
  });

  it("#361: a met quorum fulfils a member short of minRounds, never a non-member", () => {
    const met = quorum([member("copilot", "review", null), member("bugbot", null, "absent")]);
    const counts = countRounds(
      [fact("copilot", { posted: 1, round: "review" }), fact("bugbot"), fact("sasuke")],
      [],
      1,
      3,
      met,
    );
    expect(counts.reviewers.map((entry) => [entry.reviewer, entry.min])).toEqual([
      ["copilot", "met"],
      ["bugbot", "fulfilled-by-quorum"],
      ["sasuke", "owed"],
    ]);
  });

  it("#361: a member whose round check is IN FLIGHT at head stays owed under a met quorum", () => {
    const met = quorum([member("copilot", "review", null), member("bugbot", null, "pending")]);
    const counts = countRounds([fact("copilot", { posted: 1, round: "review" }), fact("bugbot")], [], 1, 3, met);
    expect(counts.reviewers[1]?.min).toBe("owed-in-flight");
    expect(renderRoundCounts(counts).join("\n")).toContain(
      "bugbot: requested 0 of max 3 (another request allowed) · rounds 0 of min 1 (owed (its round check is in flight at head, so the met quorum does not cover it))",
    );
  });

  it("an UNMET quorum fulfils nobody", () => {
    const unmet = quorum([member("copilot", null, null), member("bugbot", null, "absent")]);
    const counts = countRounds([fact("copilot"), fact("bugbot")], [], 1, null, unmet);
    expect(counts.reviewers.map((entry) => entry.min)).toEqual(["owed", "owed"]);
  });

  it("minRounds 0 is met by nobody having reviewed; an unstated minimum is 'no-minimum'", () => {
    expect(countRounds([fact("a")], [], 0, null, undefined).reviewers[0]?.min).toBe("met");
    expect(countRounds([fact("a")], [], null, 2, undefined).reviewers[0]?.min).toBe("no-minimum");
  });

  it("renders a pending request and an unstated bound", () => {
    const lines = renderRoundCounts(countRounds([fact("a", { pendingRequest: true })], ["a"], null, 2, undefined));
    expect(lines[0]).toBe("  review rounds (round_policy minRounds unstated, maxRounds 2; counted, never a conjunct, zheref/nen#240):");
    expect(lines[1]).toBe(
      "    a: requested 1 of max 2 (another request allowed) · rounds 0 (no minimum stated) · a request is pending",
    );
  });
});
