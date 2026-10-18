// zheref/nen#410: list slots (`{+}`, `{&}`) and alternations (`<a>|<b>[+]|<c>`),
// pinned against the backlog-state/backlog-board selector they were built for.
import { describe, expect, it } from "vitest";
import { GrammarError, parseInvocation, parseTemplate, type ParseResult, type SlotValue } from "./engine.js";

const SELECTOR =
  "<repo>[@<gate:G1|G1-M|G2|G3|G4|G5|all>{+}|<severity:critical|high|medium|low>[+]|<label>][#<labels>{&}] [every <freq:turn|state-change|once>]";
const grammar = parseTemplate(SELECTOR);
const parse = (line: string): ParseResult => parseInvocation("backlog-state", grammar, line);
const slot = (line: string, name: string): SlotValue | undefined => parse(line).slots.find((value): boolean => value.name === name);
const POSITION = "gate|severity|label";

describe("parseTemplate: lists and alternations", () => {
  it("declares one position with three alternatives, and a list slot", () => {
    expect(grammar.slots.map((s): string => s.name)).toEqual(["repo", POSITION, "labels", "freq"]);
    const position = grammar.slots[1];
    expect(position?.alternatives.map((a): string => a.name)).toEqual(["gate", "severity", "label"]);
    expect(position?.alternatives[0]?.joiner).toBe("+");
    expect(position?.alternatives[1]?.suffix).toBe("+");
    expect(grammar.slots[2]?.joiner).toBe("&");
  });

  it.each([
    ["<repo>[@<label>|<gate:G1|G2>]", /free alternative <label> takes any value/],
    ["<repo>[@<a:x|y>|<b:y|z>]", /'y' is a value of both <a> and <b>/],
    ["<repo>[@<a:x>|<b>[+]]", /suffix on it means nothing/],
    ["<repo>[@<a:x>|]", /ends at '\]' with no <slot>/],
    ["<repo>|", /alternates with nothing/],
    ["| <repo>", /follows no <slot>/],
    ["{+}<repo>", /follows no <slot>/],
    ["<repo>[@<a:x>{+}[+]]", /cannot be split unambiguously/],
    ["<repo>[@<a:x>[+]{+}]", /already carries/],
    ["<repo>[@<a:x>|<a:y>]", /names one alternative twice/],
    ["<repo>[@<a:x>| #<b>]", /shares the separator/],
  ])("refuses the template %s", (template, message) => {
    expect(() => parseTemplate(template)).toThrow(GrammarError);
    expect(() => parseTemplate(template)).toThrow(message);
  });
});

describe("parseInvocation: the selector's accepting lines", () => {
  it("hatsu@g5#model/gpt -> one gate and one label", () => {
    expect(parse("hatsu@g5#model/gpt").ok).toBe(true);
    expect(slot("hatsu@g5#model/gpt", POSITION)).toEqual({ name: POSITION, value: "G5", suffix: false, alternative: "gate", items: ["G5"] });
    expect(slot("hatsu@g5#model/gpt", "labels")).toEqual({ name: "labels", value: "model/gpt", suffix: false, items: ["model/gpt"] });
  });

  it("hatsu#model/claude -> no selector", () => {
    const result = parse("hatsu#model/claude");
    expect(result.ok).toBe(true);
    expect(slot("hatsu#model/claude", POSITION)).toBeUndefined();
    expect(result.echo).toContain(`${POSITION}: (clause absent)`);
  });

  it("hatsu@g4+g5#model/grok&lang/typescript -> a normalised gate list and two labels", () => {
    const line = "hatsu@g4+g5#model/grok&lang/typescript";
    expect(slot(line, POSITION)).toMatchObject({ value: "G4+G5", alternative: "gate", items: ["G4", "G5"] });
    expect(slot(line, "labels")?.items).toEqual(["model/grok", "lang/typescript"]);
    expect(parse(line).echo).toContain("gate: G4+G5");
  });

  it("hatsu@model/gpt -> a label, kept as typed", () => {
    expect(slot("hatsu@model/gpt", POSITION)).toEqual({ name: POSITION, value: "model/gpt", suffix: false, alternative: "label" });
  });

  it("hatsu@HIGH+ -> severity high or higher, normalised", () => {
    expect(slot("hatsu@HIGH+", POSITION)).toEqual({ name: POSITION, value: "high", suffix: true, alternative: "severity" });
    expect(parse("hatsu@HIGH+").echo).toContain("severity: high (+)");
  });

  it("hatsu@medium#lang/prose -> one severity band and a label", () => {
    expect(slot("hatsu@medium#lang/prose", POSITION)).toMatchObject({ value: "medium", suffix: false, alternative: "severity" });
  });

  it("hatsu@c++ -> the label c++ (no piece is an enumerated value)", () => {
    expect(slot("hatsu@c++", POSITION)).toMatchObject({ value: "c++", alternative: "label" });
  });

  it("context -> the repo slot alone", () => {
    const result = parse("context");
    expect(result.ok).toBe(true);
    expect(result.slots).toEqual([{ name: "repo", value: "context", suffix: false }]);
  });

  it("keeps the trailing every clause", () => {
    expect(slot("hatsu@g4+g5 every turn", "freq")?.value).toBe("turn");
  });
});

describe("parseInvocation: the selector's refusals", () => {
  it.each([
    ["hatsu@g4+model/gpt", /<gate> is one or more of .* and 'model\/gpt' is none of them/],
    ["hatsu@high+g4", /mixes <gate> and <severity> values/],
    ["hatsu@high+low", /<severity> is ONE of .* optionally followed by one '\+'/],
    ["hatsu@g4+", /'g4\+' has an empty item/],
    ["hatsu@g4++g5", /has an empty item/],
    ["hatsu@high++", /<severity> is ONE of/],
    ["hatsu@g9+g5", /'g9' is none of them/],
    ["hatsu#a&&b", /<labels> is one or more values joined by '&'/],
  ])("%s exits 2 with the reason and no invented correction", (line, message) => {
    const result = parse(line);
    expect(result.ok).toBe(false);
    expect(result.problems.join("\n")).toMatch(message);
    if (result.corrected !== null) expect(result.corrected).toContain("backlog-state hatsu");
  });

  it("withholds the corrected line for a mixture of alternatives", () => {
    expect(parse("hatsu@high+g4").corrected).toBeNull();
  });
});

describe("a plain enumerated list and a plain slot are unaffected", () => {
  it("a list with no alternation reports items, and no alternative key", () => {
    const list = parseTemplate("<repo>[@<gate:G1|G2>{+}]");
    const value = parseInvocation("s", list, "x@g1+g2").slots[1];
    expect(value).toEqual({ name: "gate", value: "G1+G2", suffix: false, items: ["G1", "G2"] });
  });

  it("a list with no alternation and a wrong item is refused", () => {
    const list = parseTemplate("<repo>[@<gate:G1|G2>{+}]");
    expect(parseInvocation("s", list, "x@g1+g3").problems[0]).toMatch(/'g3' is none of them/);
  });

  it("a plain enumerated slot keeps its old shape and message", () => {
    const plain = parseTemplate("<repo>[@<gate:G1|G2>]");
    expect(parseInvocation("s", plain, "x@g1").slots[1]).toEqual({ name: "gate", value: "G1", suffix: false });
    expect(parseInvocation("s", plain, "x@g1+g2").problems[0]).toMatch(/'g1\+g2' is none of them/);
  });

  it("an alternation with no free alternative refuses a value none fits", () => {
    const enumOnly = parseTemplate("<repo>[@<gate:G1|G2>|<sev:high|low>[+]]");
    expect(parseInvocation("s", enumOnly, "x@nope").problems[0]).toMatch(/<gate> is one or more of|<gate> is one of/);
  });
});

describe("a free LIST inside an alternation (Nobunaga n1)", () => {
  const freeList = parseTemplate("<repo>[@<gate:G1|G2>{+}|<labels>{&}]");

  it("fills the free list, items kept as typed", () => {
    const value = parseInvocation("s", freeList, "x@model/gpt&lang/typescript").slots[1];
    expect(value).toEqual({ name: "gate|labels", value: "model/gpt&lang/typescript", suffix: false, alternative: "labels", items: ["model/gpt", "lang/typescript"] });
  });

  it("refuses an empty item in the free list", () => {
    expect(parseInvocation("s", freeList, "x@a&&b").problems[0]).toMatch(/<labels> is one or more values joined by '&', and 'a&&b' has an empty item/);
  });

  it("still takes the gate list first", () => {
    expect(parseInvocation("s", freeList, "x@g1+g2").slots[1]).toMatchObject({ alternative: "gate", items: ["G1", "G2"] });
  });
});

