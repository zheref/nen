import { describe, expect, it } from "vitest";
import { detectStalePins, sweepHandbookQuestions } from "./sweep.js";
import type { ConsumerEntry } from "../schema/repos.js";

function consumer(overrides: Partial<ConsumerEntry>): ConsumerEntry {
  return {
    repo: "o/r",
    pinned: "v1.0.0",
    consumes: [],
    scenario: null,
    phases: [],
    auth: null,
    notes: null,
    code: null,
    callerPins: {},
    ...overrides,
  };
}

describe("detectStalePins", () => {
  it("flags a stale default pin", () => {
    const findings = detectStalePins([consumer({ pinned: "v1.0.0" })], "v1.1.0");
    expect(findings).toEqual([
      { kind: "stale", repo: "o/r", field: "pinned", pinned: "v1.0.0", current: "v1.1.0" },
    ]);
  });

  it("flags a stale PER-CALLER pin even when the default pin is current", () => {
    const findings = detectStalePins(
      [consumer({ pinned: "v1.1.0", callerPins: { db_migrate_pinned: "v1.0.0" } })],
      "v1.1.0",
    );
    expect(findings).toEqual([
      { kind: "stale", repo: "o/r", field: "db_migrate_pinned", pinned: "v1.0.0", current: "v1.1.0" },
    ]);
  });

  it("reports nothing when every pin is current", () => {
    expect(detectStalePins([consumer({ pinned: "v1.1.0" })], "v1.1.0")).toEqual([]);
  });

  it("reports an UNPINNED consumer as its own kind, never as current (zheref/nen#10 item 4)", () => {
    // A registry entry with no pin recorded used to be skipped outright, so
    // this returned [] -- byte-identical to "every pin is current" above.
    expect(detectStalePins([consumer({ pinned: null })], "v1.1.0")).toEqual([
      { kind: "unpinned", repo: "o/r", field: "pinned", pinned: null, current: "v1.1.0" },
    ]);
  });

  it("still checks an unpinned consumer's PER-CALLER overrides", () => {
    // The missing default pin must not shadow the fields that ARE recorded.
    expect(
      detectStalePins(
        [consumer({ pinned: null, callerPins: { db_migrate_pinned: "v1.0.0" } })],
        "v1.1.0",
      ),
    ).toEqual([
      { kind: "unpinned", repo: "o/r", field: "pinned", pinned: null, current: "v1.1.0" },
      { kind: "stale", repo: "o/r", field: "db_migrate_pinned", pinned: "v1.0.0", current: "v1.1.0" },
    ]);
  });

  it("reports an unpinned consumer ONCE, not also as stale", () => {
    const findings = detectStalePins([consumer({ pinned: null })], "v1.1.0");
    expect(findings).toHaveLength(1);
  });

  it("reads an EMPTY-STRING pin as unpinned, byte-identically to a missing one", () => {
    // `"pinned": ""` records the same absence as a missing key. Read as a
    // stale pin it rendered with a blank left-hand side and told the operator
    // to bump a pin from nothing.
    expect(detectStalePins([consumer({ pinned: "" })], "v1.1.0")).toEqual(
      detectStalePins([consumer({ pinned: null })], "v1.1.0"),
    );
    expect(detectStalePins([consumer({ pinned: "" })], "v1.1.0")).toEqual([
      { kind: "unpinned", repo: "o/r", field: "pinned", pinned: null, current: "v1.1.0" },
    ]);
  });
});

describe("sweepHandbookQuestions", () => {
  it("reports every unanswered question per repo, never the first only", () => {
    const gaps = sweepHandbookQuestions(
      ["o/a", "o/b"],
      [{ id: "q1", text: "?" }, { id: "q2", text: "??" }],
      new Map([["o/a", new Set(["q1"])]]),
    );
    expect(gaps).toEqual([
      { repo: "o/a", questionId: "q2", text: "??" },
      { repo: "o/b", questionId: "q1", text: "?" },
      { repo: "o/b", questionId: "q2", text: "??" },
    ]);
  });
});
