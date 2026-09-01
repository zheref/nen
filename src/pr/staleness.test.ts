import { describe, expect, it } from "vitest";
import { computeStaleness } from "./staleness.js";

describe("computeStaleness", () => {
  it("is stale at exactly 2 verified no-commit wakes and 60 idle minutes", () => {
    const result = computeStaleness({
      wakes: [{ at: "a", noCommit: true }, { at: "b", noCommit: true }],
      lastActivityAt: "2026-01-01T00:00:00Z",
      now: "2026-01-01T01:00:00Z",
      ready: false,
    });
    expect(result.stale).toBe(true);
    expect(result.verifiedNoCommitWakes).toBe(2);
    expect(result.idleMinutes).toBe(60);
  });

  it("is not stale below either threshold", () => {
    expect(
      computeStaleness({
        wakes: [{ at: "a", noCommit: true }],
        lastActivityAt: "2026-01-01T00:00:00Z",
        now: "2026-01-01T02:00:00Z",
        ready: false,
      }).stale,
    ).toBe(false);
    expect(
      computeStaleness({
        wakes: [{ at: "a", noCommit: true }, { at: "b", noCommit: true }],
        lastActivityAt: "2026-01-01T00:00:00Z",
        now: "2026-01-01T00:30:00Z",
        ready: false,
      }).stale,
    ).toBe(false);
  });

  it("ignores a wake that did NOT verify no-commit", () => {
    const result = computeStaleness({
      wakes: [{ at: "a", noCommit: true }, { at: "b", noCommit: false }],
      lastActivityAt: "2026-01-01T00:00:00Z",
      now: "2026-01-01T01:00:00Z",
      ready: false,
    });
    expect(result.verifiedNoCommitWakes).toBe(1);
    expect(result.stale).toBe(false);
  });

  it("permits a merge only when stale AND ready", () => {
    const base = {
      wakes: [{ at: "a", noCommit: true }, { at: "b", noCommit: true }],
      lastActivityAt: "2026-01-01T00:00:00Z",
      now: "2026-01-01T01:00:00Z",
    };
    expect(computeStaleness({ ...base, ready: true }).mergePermitted).toBe(true);
    expect(computeStaleness({ ...base, ready: false }).mergePermitted).toBe(false);
  });

  it("respects overridden thresholds", () => {
    const result = computeStaleness({
      wakes: [{ at: "a", noCommit: true }],
      lastActivityAt: "2026-01-01T00:00:00Z",
      now: "2026-01-01T00:10:00Z",
      ready: false,
      minVerifiedWakes: 1,
      idleMinutes: 5,
    });
    expect(result.stale).toBe(true);
  });
});
