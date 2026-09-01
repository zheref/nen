import { describe, expect, it } from "vitest";
import { loadColorVocabulary, parseColorVocabulary } from "./colors.js";
import { ALT_REPO, BANKAI_REPO } from "./fixtures/paths.js";
import { parseYaml } from "./yaml.js";

describe("loadColorVocabulary -- reads the TARGET repository", () => {
  it("reads whichever categories the target repo declares", () => {
    const bankai = loadColorVocabulary(BANKAI_REPO);
    const alt = loadColorVocabulary(ALT_REPO);

    expect(bankai.categories.map((c): string => c.name)).toEqual([
      "status",
      "severity",
      "agent_identity",
    ]);
    // Entirely different category names. Nothing shipped assumes "status".
    expect(alt.categories.map((c): string => c.name)).toEqual(["phase", "impact"]);
    expect(alt.category("status")).toBeUndefined();
    expect(bankai.category("phase")).toBeUndefined();
  });

  it("carries emoji, hex, label and means through unchanged", () => {
    const high = loadColorVocabulary(BANKAI_REPO).category("severity")?.get("high");
    expect(high?.emoji).toBe("🔴");
    expect(high?.hex).toBe("#d93f0b");
    expect(high?.label).toBe("bankai:severity/high");
    expect(high?.means).toBe("Must fix before merge/release.");
  });

  it("keeps a null emoji as null rather than an empty string", () => {
    // "unassigned" and "absent" must stay distinguishable: the file lists a
    // value with `emoji: null` precisely so nobody invents a glyph for it.
    const sasuke = loadColorVocabulary(BANKAI_REPO).category("agent_identity")?.get("sasuke");
    expect(sasuke).toBeDefined();
    expect(sasuke?.emoji).toBeNull();
  });

  it("keeps unmodelled per-value fields in `extra` rather than dropping them", () => {
    const ready = loadColorVocabulary(BANKAI_REPO).category("status")?.get("ready_g2_g4");
    expect(ready?.extra["gate"]).toBe("G2/G4");
    expect(ready?.extra["decided_by"]).toBe("scripts/pr_ready_gate.sh");
    const blocked = loadColorVocabulary(BANKAI_REPO).category("status")?.get("blocked");
    expect(blocked?.extra["gate"]).toBe("G5");
    const onHold = loadColorVocabulary(BANKAI_REPO).category("status")?.get("on_hold");
    expect(onHold?.extra["gate"]).toBeNull();
  });

  it("resolves a category's precedence first-match-wins, in the FILE's order", () => {
    const bankai = loadColorVocabulary(BANKAI_REPO);
    expect(bankai.resolve("status", ["in_progress", "blocked"])?.name).toBe("blocked");
    expect(bankai.resolve("status", ["ready_g1", "in_progress"])?.name).toBe("ready_g1");
    expect(bankai.resolve("status", ["in_progress"])?.name).toBe("in_progress");

    const alt = loadColorVocabulary(ALT_REPO);
    expect(alt.resolve("phase", ["proposed", "landed"])?.name).toBe("landed");
    expect(alt.resolve("phase", ["proposed", "ratified"])?.name).toBe("ratified");
  });

  it("returns nothing for an unknown category or an unlisted value", () => {
    const bankai = loadColorVocabulary(BANKAI_REPO);
    expect(bankai.resolve("no-such-category", ["x"])).toBeUndefined();
    expect(bankai.resolve("status", ["not-a-status"])).toBeUndefined();
  });

  it("declines to guess when a category has no precedence and two values are present", () => {
    // `severity` declares no precedence in the fixture. With one candidate the
    // answer is unambiguous; with two there is no defensible tie-break, and an
    // arbitrary pick is how two renderers disagree about the same row.
    const bankai = loadColorVocabulary(BANKAI_REPO);
    expect(bankai.resolve("severity", ["high"])?.name).toBe("high");
    expect(bankai.resolve("severity", ["high", "low"])).toBeUndefined();
  });

  it("errors loudly when the file is absent", () => {
    expect(() => loadColorVocabulary("/definitely/not/a/repo")).toThrow(/no such file/);
  });
});

describe("parseColorVocabulary -- validation", () => {
  const at = "/fake/schemas/colors.yml";
  const parse = (yaml: string): ReturnType<typeof parseColorVocabulary> =>
    parseColorVocabulary(at, parseYaml(yaml));

  it("refuses a hex that is not #rrggbb", () => {
    expect(() =>
      parse(["categories:", "  a:", "    values:", "      b:", '        hex: "d93f0b"'].join("\n")),
    ).toThrow(/expected '#rrggbb'/);
  });

  it("refuses a precedence entry naming a value that does not exist", () => {
    expect(() =>
      parse(
        [
          "categories:",
          "  a:",
          "    precedence: [b, ghost]",
          "    values:",
          "      b:",
          '        emoji: "x"',
        ].join("\n"),
      ),
    ).toThrow(/can never fire/);
  });

  it("refuses a non-integer version", () => {
    expect(() => parse(["version: one", "categories:", "  a:", "    values: {}"].join("\n"))).toThrow(
      /expected an integer/,
    );
  });

  it("refuses a label that is not a string", () => {
    expect(() =>
      parse(["categories:", "  a:", "    values:", "      b:", "        label: true"].join("\n")),
    ).toThrow(/expected a string or null/);
  });

  it("refuses a value that is not an object", () => {
    expect(() =>
      parse(["categories:", "  a:", "    values:", "      b: just-a-string"].join("\n")),
    ).toThrow(/expected an object describing the value/);
  });
});
