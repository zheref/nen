import { describe, expect, it } from "vitest";
import { GrammarError, parseInvocation, parseTemplate } from "./engine.js";
import { KAGE_BUNSHIN_GRAMMAR } from "./command.js";
const grammar = "<from:a|b> to <to:a|b> [ruling <text>]";
const urls = "https://github.com/zheref/hatsu/issues/470 https://github.com/zheref/nen/issues/300";

describe("first-anchored trailing clauses (#458)", () => {
  it("protects repeated earlier and own anchors in free text, without changing default splitting", () => {
    const line = "a to b ruling x maps to y; the ruling is map";
    const marked = parseInvocation("bankai-rule", parseTemplate(`${grammar}{first}`), line);
    expect(marked.ok).toBe(true);
    expect(marked.slots.map((slot) => [slot.name, slot.value])).toEqual([["from", "a"], ["to", "b"], ["text", "x maps to y; the ruling is map"]]);
    expect(parseInvocation("bankai-rule", parseTemplate(grammar), line).ok).toBe(false);
  });
  it("matches case-sensitive whole words and preserves internal text spacing", () => {
    const g = parseTemplate(`${grammar}{first}`);
    for (const line of ["a to b Ruling text", "a to b overruling text"]) expect(parseInvocation("x", g, line).ok).toBe(false);
    const result = parseInvocation("x", g, "a to b ruling x  ruling  y");
    expect(result.slots.at(-1)?.value).toBe("x  ruling  y");
    expect(parseInvocation("x", g, "a to b").echo).toContain("text: (clause absent)");
    const missing = parseInvocation("x", g, "ruling x");
    expect(missing.ok).toBe(false);
    expect(missing.missing).toEqual(expect.arrayContaining(["from", "to"]));
  });
  it("refuses modifiers on nontrailing, literal-only or enumerated clauses", () => {
    for (const template of ["<x> [ruling <text>]{first} [then <more>]", "<x> [ruling]{first}", "<x> [ruling <text:a|b>]{first}"]) {
      expect(() => parseTemplate(template)).toThrow(GrammarError);
    }
  });
});

describe("space-joined lists and hyphen mode correction (#593)", () => {
  it("returns individual URL items and an absent cap without deriving a number", () => {
    const grammar = parseTemplate(KAGE_BUNSHIN_GRAMMAR);
    for (const line of [`${urls} --parallel`, `${urls.replace(" ", "  \t")} --parallel`]) {
      const result = parseInvocation("kage-bunshin", grammar, line);
      expect(result.ok).toBe(true);
      expect(result.slots[0]?.items).toEqual(urls.split(" "));
      expect(result.echo).toContain("cap: (clause absent)");
      expect(result.slots.some((slot) => slot.name === "cap")).toBe(false);
    }
    const capped = parseInvocation("kage-bunshin", grammar, `${urls} --parallel --cap 3`);
    expect(capped.ok).toBe(true);
    expect(capped.slots.at(-1)?.value).toBe("3");
  });
  it("names missing and invalid mode and missing issues, with spaced placeholders", () => {
    const grammar = parseTemplate(KAGE_BUNSHIN_GRAMMAR);
    const missingMode = parseInvocation("kage-bunshin", grammar, urls);
    expect(missingMode.ok).toBe(false);
    expect(missingMode.missing).toContain("mode");
    expect(missingMode.corrected).toContain("/300 --<mode: sequential | parallel>");
    const invalidMode = parseInvocation("kage-bunshin", grammar, `${urls} --unknown`);
    expect(invalidMode.ok).toBe(false);
    expect(invalidMode.problems.join(" ")).toContain("<mode>");
    const missingIssues = parseInvocation("kage-bunshin", grammar, "--sequential");
    expect(missingIssues.ok).toBe(false);
    expect(missingIssues.missing).toContain("urls");
  });
});
