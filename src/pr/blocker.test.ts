import { describe, expect, it } from "vitest";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { loadGateIdentities, type GateIdentities } from "../schema/gates.js";
import type { PrSnapshot } from "./fetch.js";
import { nextBlocker } from "./blocker.js";

const IDENTITIES: GateIdentities = loadGateIdentities(BANKAI_REPO);

function snapshot(overrides: Partial<PrSnapshot> = {}): PrSnapshot {
  return {
    pr: {
      number: 1,
      headSha: "head1",
      baseRef: "main",
      headRef: "feature/x",
      author: "alice",
      labels: [],
      mergeable: "MERGEABLE",
      isDraft: false,
    },
    title: "t",
    url: "https://x/1",
    body: "## How to verify\n\nrun the thing",
    state: "OPEN",
    mergeStateStatus: "CLEAN",
    checks: [],
    reviews: [],
    reviewRequests: [],
    reviewThreads: [],
    threadsTruncated: false,
    ...overrides,
  };
}

describe("nextBlocker -- the FIRST condition, fixed order, and nothing past it", () => {
  it("a conflicting PR blocks before anything else, even with red checks too", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({ pr: { ...snapshot().pr, mergeable: "CONFLICTING" }, checks: [] }),
    );
    expect(result.kind).toBe("conflict");
  });

  it("a DIRTY mergeStateStatus is also a conflict, even when mergeable itself is UNKNOWN", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({ pr: { ...snapshot().pr, mergeable: "UNKNOWN" }, mergeStateStatus: "DIRTY" }),
    );
    expect(result.kind).toBe("conflict");
  });

  it("no checks at all is a red-check blocker, not a pass-through", () => {
    expect(nextBlocker(IDENTITIES, snapshot({ checks: [] })).kind).toBe("red-check");
  });

  it("a non-green latest check blocks before reviews are even considered", () => {
    const result = nextBlocker(
      IDENTITIES,
      snapshot({
        checks: [{ kind: "check_run", name: "ci", status: "COMPLETED", conclusion: "FAILURE", startedAt: null, completedAt: null, detailsUrl: null }],
      }),
    );
    expect(result.kind).toBe("red-check");
  });

  it("an owed reviewer round blocks once checks are green", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews: [] }));
    expect(result.kind).toBe("owed-round");
    expect(result.detail).toMatch(/sasuke/);
  });

  it("an unresolved thread blocks once every reviewer round is satisfied", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const reviews = [
      { author: "sasuke", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
      { author: "tenma", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
    ];
    const result = nextBlocker(
      IDENTITIES,
      snapshot({ checks, reviews, reviewThreads: [{ id: "t1", isResolved: false }] }),
    );
    expect(result.kind).toBe("unresolved-thread");
  });

  it("a missing '## How to verify' section blocks once threads are resolved", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const reviews = [
      { author: "sasuke", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
      { author: "tenma", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews, body: "no verify section here" }));
    expect(result.kind).toBe("missing-body-requirement");
  });

  // Review finding #7: an explicitly-empty reviewers override must not be
  // treated as "no reviewers, nothing owed" -- it made this exact snapshot
  // read as kind:"none" instead of the correct owed-round.
  it("an explicitly EMPTY reviewers override falls back to the default set, not to 'nothing owed'", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews: [] }), { reviewers: [] });
    expect(result.kind).toBe("owed-round");
    expect(result.detail).toMatch(/sasuke/);
  });

  it("finds no blocker when every condition clears", () => {
    const checks = [
      { kind: "check_run" as const, name: "ci", status: "COMPLETED" as const, conclusion: "SUCCESS" as const, startedAt: null, completedAt: null, detailsUrl: null },
    ];
    const reviews = [
      { author: "sasuke", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
      { author: "tenma", state: "APPROVED" as const, commitId: "head1", submittedAt: null },
    ];
    const result = nextBlocker(IDENTITIES, snapshot({ checks, reviews }));
    expect(result.kind).toBe("none");
  });
});
