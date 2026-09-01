import { describe, expect, it } from "vitest";
import { parseInvocation, parseTemplate, splitLastSymbol, splitLastWord } from "./engine.js";

describe("splitLastWord", () => {
  it("splits at the LAST whole-word occurrence, case-insensitively", () => {
    expect(splitLastWord("do the thing until it works until noon", "until")).toEqual({
      head: "do the thing until it works ",
      tail: " noon",
    });
  });

  it("does not split inside a word", () => {
    expect(splitLastWord("cauliflower", "flow")).toBeNull();
  });

  it("returns null when the phrase does not occur", () => {
    expect(splitLastWord("nothing here", "until")).toBeNull();
  });
});

describe("splitLastSymbol", () => {
  it("splits at the last occurrence with no word boundary needed", () => {
    expect(splitLastSymbol("a@b@c", "@")).toEqual({ head: "a@b", tail: "c" });
  });
});

describe("parseTemplate", () => {
  it("parses a leading slot plus word-separated and enumerated slots", () => {
    const grammar = parseTemplate("<repo> then <mode:build|watch>");
    expect(grammar.slots.map((s): string => s.name)).toEqual(["repo", "mode"]);
    expect(grammar.slots[1]?.separator).toBe("then");
    expect(grammar.slots[1]?.values).toEqual(["build", "watch"]);
  });

  it("parses an optional trailing clause and a [+] suffix", () => {
    const grammar = parseTemplate("<repo>@<gate> [every <mode>[+]]");
    const mode = grammar.slots.find((s): boolean => s.name === "mode");
    expect(mode?.optional).toBe(true);
    expect(mode?.suffix).toBe("+");
  });

  it("refuses a template with no slot", () => {
    expect(() => parseTemplate("no slots here")).toThrow();
  });

  it("refuses an unbalanced bracket", () => {
    expect(() => parseTemplate("<a> [unclosed")).toThrow();
    expect(() => parseTemplate("<a> unopened]")).toThrow();
  });
});

describe("parseInvocation", () => {
  const grammar = parseTemplate("<repo>@<gate:G1|G2|G3> [every <mode:turn|state-change|once>]");

  it("parses right to left and normalizes enumerated values to the template's spelling", () => {
    const result = parseInvocation("myskill", grammar, "bc@g2 every TURN");
    expect(result.ok).toBe(true);
    expect(result.slots).toEqual([
      { name: "repo", value: "bc", suffix: false },
      { name: "gate", value: "G2", suffix: false },
      { name: "mode", value: "turn", suffix: false },
    ]);
  });

  it("echoes the parse, one clause per line", () => {
    const result = parseInvocation("myskill", grammar, "bc@g2");
    expect(result.echo).toEqual(["repo: bc", "gate: G2"]);
  });

  it("refuses an unparseable enumerated value and lists the valid set", () => {
    const result = parseInvocation("myskill", grammar, "bc@g9");
    expect(result.ok).toBe(false);
    expect(result.problems[0]).toMatch(/G1 \| G2 \| G3/);
  });

  it("hands back a corrected line that keeps what the caller got right", () => {
    const result = parseInvocation("myskill", grammar, "bc@g9");
    // 'bc' was understood and is kept; only the failed <gate> slot is re-prompted.
    expect(result.corrected).toContain("bc@");
    expect(result.corrected).toContain("<gate: G1 | G2 | G3>");
  });

  it("reports a missing required slot", () => {
    const result = parseInvocation("myskill", grammar, "");
    expect(result.ok).toBe(false);
    expect(result.missing).toContain("gate");
  });

  it("a task title containing the separator word is not mistaken for the separator", () => {
    // "until" in prose must not be mistaken for a real 'until' separator --
    // here the analogous case is 'every' appearing inside the repo slot text
    // BEFORE the real trailing 'every' clause; the LAST occurrence wins.
    const g = parseTemplate("<task> until <condition>");
    const result = parseInvocation("s", g, "ship the widget until launch until the tests pass");
    expect(result.slots.find((s): boolean => s.name === "condition")?.value).toBe("the tests pass");
    expect(result.slots.find((s): boolean => s.name === "task")?.value).toBe("ship the widget until launch");
  });
});
