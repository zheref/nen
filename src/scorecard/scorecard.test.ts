// src/scorecard/scorecard.test.ts -- the pure half of `nen scorecard`
// (zheref/hatsu#619): the catalogue, the row grammar, the weeks, the tallies.
import { describe, expect, it } from "vitest";
import { SchemaError } from "../schema/errors.js";
import {
  buildTrend,
  currentWeek,
  lastCompletedWeek,
  parseAspectCatalogue,
  parseWeek,
  readAspects,
  readDelta,
  renderTrend,
  renderTrendMarkdown,
  repoTrend,
  snapshotOf,
  weeksThrough,
  type MergedPull,
} from "./scorecard.js";

const ASPECTS = ["Observability", "Security", "End-user experience"];
const catalogue = (aspects: unknown): Buffer => Buffer.from(JSON.stringify({ contract: "test.sections/v1", aspects }));
const table = (rows: readonly (readonly [string, string])[]): string => ["## 📈 What this improves", "", "| Aspect | Delta | Why it moves |", "|---|---|---|", ...rows.map(([a, d]) => `| ${a} | ${d} | |`)].join("\n");

describe("parseAspectCatalogue", () => {
  it("keeps the catalogue's aspects in its own order and hashes its bytes (zheref/hatsu#619/AC-3)", () => {
    const parsed = parseAspectCatalogue("c.json", catalogue(["Zeta", "Alpha"]));
    expect(parsed.aspects).toEqual(["Zeta", "Alpha"]);
    expect(parsed.contract).toBe("test.sections/v1");
    expect(parsed.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["no aspects key", { sections: [] }],
    ["an empty list", { aspects: [] }],
    ["a duplicate, case-folded", { aspects: ["Cost", "cost"] }],
    ["a pipe", { aspects: ["a|b"] }],
    ["a non-string", { aspects: [3] }],
  ])("refuses %s", (_, raw) => {
    expect(() => parseAspectCatalogue("c.json", Buffer.from(JSON.stringify(raw)))).toThrow(SchemaError);
  });

  it("refuses bytes that are not JSON", () => {
    expect(() => parseAspectCatalogue("c.json", Buffer.from("{"))).toThrow(/not JSON/);
  });
});

describe("readDelta", () => {
  it.each([
    ["⬆", "improves"], ["⬆️", "improves"], ["**⬆**", "improves"], ["improves", "improves"],
    ["➖", "unchanged"], ["-", "unchanged"], ["unchanged", "unchanged"],
    ["⬇️", "regresses"], ["⬇ slower cold start", "regresses"], ["regresses", "regresses"],
    ["", null], ["maybe", null], ["-1", null],
  ])("reads %j as %s", (cell, expected) => {
    expect(readDelta(cell)).toBe(expected);
  });
});

describe("readAspects", () => {
  it("reads every catalogue aspect, absent ones included, in catalogue order (zheref/hatsu#619/AC-1)", () => {
    const readings = readAspects(table([["Security", "⬇"], ["Observability", "⬆"]]), ASPECTS);
    expect(Object.entries(readings)).toEqual([["Observability", "improves"], ["Security", "regresses"], ["End-user experience", "absent"]]);
  });

  it("lets the first row win, skips fenced code and comments, and marks a glyphless row unreadable", () => {
    const body = [
      "```markdown", "| Observability | ⬇ |", "```",
      "<!-- | Security | ⬇ | -->",
      table([["**observability**", "⬆"], ["Security", "➖"], ["End-user experience", "?"]]),
      "| Observability | ⬇ |",
    ].join("\n");
    expect(readAspects(body, ASPECTS)).toEqual({ Observability: "improves", Security: "unchanged", "End-user experience": "unreadable" });
  });

  it("reads a CRLF body and ignores a row with a single cell", () => {
    expect(readAspects("| Security |\r\n| Security | ⬆ |\r\n", ASPECTS).Security).toBe("improves");
  });
});

describe("weeks", () => {
  it("parses ISO weeks, the year-boundary ones included, and refuses weeks that do not exist", () => {
    expect(parseWeek("2026-W47")).toEqual({ id: "2026-W47", start: "2026-11-16T00:00:00.000Z", end: "2026-11-23T00:00:00.000Z" });
    expect(parseWeek("2026-W01")?.start).toBe("2025-12-29T00:00:00.000Z");
    expect(parseWeek("2026-W53")?.start).toBe("2026-12-28T00:00:00.000Z");
    expect(parseWeek("2025-W53")).toBeNull();
    expect(parseWeek("2026-W00")).toBeNull();
    expect(parseWeek("2026-47")).toBeNull();
  });

  it("names the running week and the last completed one from a clock (zheref/hatsu#619/AC-2)", () => {
    const friday = new Date("2026-11-20T21:00:00Z");
    expect(currentWeek(friday).id).toBe("2026-W47");
    expect(lastCompletedWeek(friday).id).toBe("2026-W46");
    expect(lastCompletedWeek(new Date("2026-11-23T00:00:00Z")).id).toBe("2026-W47");
    expect(weeksThrough(parseWeek("2026-W02")!, 3).map((week) => week.id)).toEqual(["2025-W52", "2026-W01", "2026-W02"]);
  });
});

const pull = (number: number, mergedAt: string, rows: readonly (readonly [string, string])[]): MergedPull => ({ number, title: `#${number}`, url: "", mergedAt, body: table(rows) });

describe("repoTrend", () => {
  const weeks = weeksThrough(parseWeek("2026-W47")!, 2);
  const now = new Date("2026-11-20T12:00:00Z");
  const pulls = [
    pull(3, "2026-11-10T09:00:00Z", [["Observability", "⬆"], ["Security", "⬇"]]),
    pull(1, "2026-11-12T09:00:00Z", [["Observability", "⬆"], ["Security", "➖"]]),
    pull(2, "2026-11-17T09:00:00Z", []),
    pull(9, "2026-11-01T09:00:00Z", [["Observability", "⬆"]]),
  ];

  it("tallies each aspect per week in catalogue order, and every aspect appears (zheref/hatsu#619/AC-2)", () => {
    const trend = repoTrend("o/r", ASPECTS, weeks, now, pulls);
    expect(trend.weeks.map((week) => [week.week, week.merged, week.scored, week.pulls, week.partial])).toEqual([
      ["2026-W46", 2, 2, [1, 3], false],
      ["2026-W47", 1, 0, [2], true],
    ]);
    expect(trend.aspects.map((row) => row.aspect)).toEqual(ASPECTS);
    expect(trend.aspects[0]!.tallies[0]).toEqual({ improves: 2, unchanged: 0, regresses: 0, unrecorded: 0, net: 2 });
    expect(trend.aspects[1]!.tallies[0]).toEqual({ improves: 0, unchanged: 1, regresses: 1, unrecorded: 0, net: -1 });
    expect(trend.aspects[2]!.tallies[0]).toEqual({ improves: 0, unchanged: 0, regresses: 0, unrecorded: 2, net: null });
    expect(trend.aspects[0]!.tallies[1]).toEqual({ improves: 0, unchanged: 0, regresses: 0, unrecorded: 1, net: null });
  });

  it("carries an unreadable repository's reason and no weeks", () => {
    const trend = repoTrend("o/r", ASPECTS, weeks, now, { reason: "gh exited 1" });
    expect(trend.unreadable).toBe("gh exited 1");
    expect(trend.weeks).toEqual([]);
  });

  it("renders plain and markdown with every aspect row in catalogue order (zheref/hatsu#619/SC-1)", () => {
    const parsed = parseAspectCatalogue("c.json", catalogue(ASPECTS));
    const trend = buildTrend("c.json", parsed, weeks, [repoTrend("o/r", ASPECTS, weeks, now, pulls), repoTrend("o/x", ASPECTS, weeks, now, { reason: "boom" })]);
    const plain = renderTrend(trend);
    expect(plain[0]).toBe("scorecard: 2 repositories · 3 aspects · 2026-W46..2026-W47");
    expect(plain).toContain("Security             -1        ·");
    expect(plain).toContain("o/x · could-not-read: boom");
    const markdown = renderTrendMarkdown(trend);
    const rows = markdown.filter((line) => /^\| (Observability|Security|End-user experience) \|/.test(line));
    expect(rows.map((line) => line.split(" | ")[0])).toEqual(["| Observability", "| Security", "| End-user experience"]);
    expect(markdown).toContain("| Aspect | 2026-W46 | 2026-W47 (running) |");
    expect(markdown).toContain("| Observability | **+2** (2/0/0) | · |");
  });

  it("snapshots one week with every aspect's recorded value", () => {
    const parsed = parseAspectCatalogue("c.json", catalogue(ASPECTS));
    const week = [parseWeek("2026-W46")!];
    const snapshot = snapshotOf(repoTrend("o/r", ASPECTS, week, now, pulls), parsed);
    expect(Object.keys(snapshot)).toEqual(["contract", "repository", "period", "catalogue", "merged", "scored", "pulls", "aspects"]);
    expect(snapshot.period.week).toBe("2026-W46");
    expect(snapshot.aspects.map((row) => [row.aspect, row.net])).toEqual([["Observability", 2], ["Security", -1], ["End-user experience", null]]);
  });
});
