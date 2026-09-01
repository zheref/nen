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
    expect(findings).toEqual([{ repo: "o/r", field: "pinned", pinned: "v1.0.0", current: "v1.1.0" }]);
  });

  it("flags a stale PER-CALLER pin even when the default pin is current", () => {
    const findings = detectStalePins(
      [consumer({ pinned: "v1.1.0", callerPins: { db_migrate_pinned: "v1.0.0" } })],
      "v1.1.0",
    );
    expect(findings).toEqual([{ repo: "o/r", field: "db_migrate_pinned", pinned: "v1.0.0", current: "v1.1.0" }]);
  });

  it("reports nothing when every pin is current", () => {
    expect(detectStalePins([consumer({ pinned: "v1.1.0" })], "v1.1.0")).toEqual([]);
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
