import { describe, expect, it } from "vitest";
import { ScriptedRunner } from "../exec/seam.js";
import type { Target } from "../github/target.js";
import { closedSince, findCanonical, normalizeTitle, recipes, runSearch } from "./search.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("closedSince", () => {
  it("is computed from an injected clock, never the wall clock", () => {
    expect(closedSince(new Date("2026-08-31T00:00:00Z"), 90)).toBe("2026-06-02");
  });
});

describe("recipes -- the four duplicate searches, verbatim", () => {
  it("builds all four, in the skill's own order", () => {
    const list = recipes("zheref/nen", {
      subject: "flaky test",
      files: ["src/foo.ts"],
      ruleIds: ["UZF-1"],
      laneLabels: ["lane:x"],
      closedSince: "2026-01-01",
    });
    expect(list.map((r): string => r.id)).toEqual([
      "subject-open",
      "subject-recently-closed",
      "files-and-rule-ids",
      "lane",
    ]);
    expect(list[0]?.argv).toEqual([
      "issue",
      "list",
      "--repo",
      "zheref/nen",
      "--state",
      "open",
      "--search",
      "flaky test",
      "--limit",
      "100",
      "--json",
      "number,title,state,url,labels,updatedAt,closedAt",
    ]);
    expect(list[1]?.query).toBe("flaky test closed:>=2026-01-01");
    expect(list[2]?.query).toBe('"src/foo.ts" OR "UZF-1"');
    expect(list[3]?.query).toBe('label:"lane:x"');
  });

  it("marks a pass with no terms by an empty query, not by omitting it", () => {
    const list = recipes("o/n", {
      subject: "",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    expect(list.every((r): boolean => r.query === "")).toBe(true);
  });
});

describe("runSearch -- skip empty passes, carry failures rather than swallow them", () => {
  it("skips a pass whose query is empty without calling gh", () => {
    const runner = new ScriptedRunner([]);
    const results = runSearch(runner, TARGET, {
      subject: "",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    expect(results.every((r): boolean => r.skipped)).toBe(true);
    expect(runner.calls).toEqual([]);
  });

  it("parses issues from a scripted gh call", () => {
    const list = recipes("zheref/nen", {
      subject: "flaky test",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    const runner = new ScriptedRunner([
      {
        match: `gh ${list[0]?.argv.join(" ")}`,
        result: {
          stdout: JSON.stringify([
            { number: 5, title: "Flaky test", state: "OPEN", url: "https://x/5", labels: [{ name: "bug" }] },
          ]),
        },
      },
      { match: `gh ${list[1]?.argv.join(" ")}`, result: { stdout: "[]" } },
    ]);
    const results = runSearch(runner, TARGET, {
      subject: "flaky test",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    const open = results.find((r): boolean => r.recipe.id === "subject-open");
    expect(open?.issues).toEqual([
      { number: 5, title: "Flaky test", state: "OPEN", url: "https://x/5", labels: ["bug"], updatedAt: null, closedAt: null },
    ]);
    expect(open?.truncated).toBe(false);
    expect(open?.error).toBeNull();
  });

  it("carries a failure rather than reporting an empty result -- 'found nothing' != 'could not look'", () => {
    const list = recipes("zheref/nen", {
      subject: "x",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    const runner = new ScriptedRunner([
      { match: `gh ${list[0]?.argv.join(" ")}`, result: { code: 1, stderr: "network down" } },
      { match: `gh ${list[1]?.argv.join(" ")}`, result: { stdout: "[]" } },
    ]);
    const results = runSearch(runner, TARGET, {
      subject: "x",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    const open = results.find((r): boolean => r.recipe.id === "subject-open");
    expect(open?.error).toMatch(/network down/);
    expect(open?.issues).toEqual([]);
  });

  it("flags truncation when the page comes back full", () => {
    const list = recipes("zheref/nen", {
      subject: "x",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    const full = Array.from({ length: 100 }, (_, i): unknown => ({ number: i + 1, title: "t", state: "OPEN" }));
    const runner = new ScriptedRunner([
      { match: `gh ${list[0]?.argv.join(" ")}`, result: { stdout: JSON.stringify(full) } },
      { match: `gh ${list[1]?.argv.join(" ")}`, result: { stdout: "[]" } },
    ]);
    const results = runSearch(runner, TARGET, {
      subject: "x",
      files: [],
      ruleIds: [],
      laneLabels: [],
      closedSince: "2026-01-01",
    });
    expect(results.find((r): boolean => r.recipe.id === "subject-open")?.truncated).toBe(true);
  });
});

describe("normalizeTitle -- the absorbed dedupe_handbook_questions.sh normalization", () => {
  it("lowercases and collapses non-alphanumeric runs", () => {
    expect(normalizeTitle("Flaky Test: `foo.ts`  fails!")).toBe("flaky test foo ts fails");
  });

  it("normalizes pure punctuation to empty", () => {
    expect(normalizeTitle("!!!")).toBe("");
  });
});

describe("findCanonical -- lowest-number-wins, order-independent", () => {
  it("finds the lowest-numbered exact match strictly below the new number", () => {
    const canonical = findCanonical(10, "Flaky test", [
      { number: 7, title: "flaky test" },
      { number: 3, title: "Flaky Test" },
      { number: 9, title: "flaky test" },
    ]);
    expect(canonical).toBe(3);
  });

  it("ignores a candidate at or above the new number", () => {
    expect(findCanonical(5, "x", [{ number: 5, title: "x" }, { number: 6, title: "x" }])).toBeNull();
  });

  it("returns null for a blank normalized title -- must not match everything", () => {
    expect(findCanonical(10, "!!!", [{ number: 1, title: "???" }])).toBeNull();
  });

  it("returns null when nothing matches", () => {
    expect(findCanonical(10, "unique", [{ number: 1, title: "other" }])).toBeNull();
  });
});
