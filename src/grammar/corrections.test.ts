import { describe, expect, it } from "vitest";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { parseCommand } from "./command.js";
import { parseInvocation, parseTemplate, type ParseResult } from "./engine.js";

const SELECTOR = "[@<gate:G4|G5>{+}|<severity:high|low>[+]|<label>]";
const TEMPLATE = `<repo>${SELECTOR}[#<labels>{&}]`;
const parse = (line: string, template = TEMPLATE): ParseResult => parseInvocation("state", parseTemplate(template), line);

const REPAIRS = [
  ["hatsu@g4+model/gpt", "hatsu@G4#model/gpt"],
  ["hatsu@g4+g5+model/gpt#lang/prose", "hatsu@G4+G5#model/gpt&lang/prose"],
  ["hatsu@high+model/gpt", "hatsu@high#model/gpt"],
  ["hatsu@g4+c++", "hatsu@G4#c++"],
  ["hatsu@high+low", "hatsu@low+"],
  ["hatsu@low+HIGH", "hatsu@low+"],
  ["hatsu@high++", "hatsu@high+"],
  ["hatsu@g4+", "hatsu@G4"],
  ["hatsu@g4++g5", "hatsu@G4+G5"],
  ["hatsu#model/gpt&", "hatsu#model/gpt"],
  ["hatsu#&model/gpt", "hatsu#model/gpt"],
  ["hatsu#x&&y", "hatsu#x&y"],
] as const;
const COMBINED = [
  [`<repo:foo|bar>${SELECTOR}`, "baz@g4+", "is one of"],
  [`<repo>${SELECTOR}`, "@g4+", "is required"],
  [`<repo>${SELECTOR} onto <base>`, "foo@g4+", "<base> is required"],
  [`on <repo>${SELECTOR}`, "foo@g4+", "must open with"],
  [`<repo>${SELECTOR}[then sweep]`, "foo@g4+ then sweep stray", "continues past it"],
] as const;

async function cli(template: string, line: string, json: boolean): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = []; const err: string[] = [];
  const code = await runFamily(parseCommand, ["parse", "state", "--grammar", template, "--line", line], null, json,
    { out: (text) => void out.push(text), err: (text) => void err.push(text) }, new ScriptedSeams([]));
  return { code, out, err };
}

describe("concrete corrections on the canonical list/alternation contract", () => {
  it.each(REPAIRS)("offers a pasteable concrete correction for %s", (line, corrected) => {
    const result = parse(line);
    expect(result.ok).toBe(false); expect(result.corrected).toBe(`state ${corrected}`);
    expect(parse(corrected).ok).toBe(true);
  });
  it.each(["hatsu@high+g4", "hatsu@high+low+high", "hatsu@g9+g5", "hatsu@high++model/gpt"])("withholds an ambiguous correction for %s", (line) => {
    const result = parse(line); expect(result.ok).toBe(false); expect(result.corrected).toBeNull();
  });
  it.each(COMBINED)("withholds the whole-line correction when another problem remains: %s", (template, line, problem) => {
    const result = parse(line, template);
    expect(result.ok).toBe(false); expect(result.problems).toHaveLength(2);
    expect(result.problems.join("\n")).toContain(problem); expect(result.corrected).toBeNull();
  });
  it("preserves canonical successful string values, list items, position names and echoes", () => {
    const result = parse("hatsu@g4+g5#model/gpt&lang/prose");
    expect(result.ok).toBe(true);
    expect(result.slots).toEqual([
      { name: "repo", value: "hatsu", suffix: false },
      { name: "gate|severity|label", value: "G4+G5", suffix: false, alternative: "gate", items: ["G4", "G5"] },
      { name: "labels", value: "model/gpt&lang/prose", suffix: false, items: ["model/gpt", "lang/prose"] },
    ]);
    expect(result.echo).toContain("gate: G4+G5");
    expect(parse("hatsu@high+").slots[1]).toEqual({ name: "gate|severity|label", value: "high", suffix: true, alternative: "severity" });
  });
  it.each(["hatsu@", "hatsu#"])("preserves canonical accepted optional empty segments: %s", (line) => {
    const result = parse(line); expect(result.ok).toBe(true); expect(result.corrected).toBe("state hatsu");
  });
  it("preserves legacy-only refusal placeholders", () => {
    expect(parse("baz@g4", `<repo:foo|bar>${SELECTOR}`).corrected).toBe("state <repo: foo | bar>@G4");
    expect(parse("foo@g4", `<repo:foo|bar>${SELECTOR}`).corrected).toBe("state foo@G4");
  });
  it("uses caller vocabulary and arbitrary list/separator literals", () => {
    const template = "<scope>[%<phase:Start|End>{/}|<rank:hot|cold>[~]|<term>][!<terms>{&}]";
    const result = parse("project%start/topic/tag!other", template);
    expect(result.corrected).toBe("state project%Start!topic/tag&other");
    expect(parse("project%start/hot", template).corrected).toBeNull();
    expect(parse("project%hot~~", template).corrected).toBe("state project%hot~");
    expect(parse("project%start//end/", template).corrected).toBe("state project%Start/End");
  });
  it.each([false, true])("keeps the canonical CLI output mode and concrete corrected line, json=%s", async (json) => {
    const result = await cli(TEMPLATE, "hatsu@g4+model/gpt", json); expect(result.code).toBe(2);
    if (json) { expect(JSON.parse(result.out.join("\n")).corrected).toBe("state hatsu@G4#model/gpt"); expect(result.err).toEqual([]); }
    else expect(result.err).toContain("  state hatsu@G4#model/gpt");
  });
  it.each([...COMBINED.map(([template, line]): [string, string] => [template, line]), [TEMPLATE, "hatsu@high+g4"]])("offers no heading or invented rewrite for %s", async (template, line) => {
    for (const json of [false, true]) {
      const result = await cli(template!, line!, json); expect(result.code).toBe(2);
      expect(result.err.join("\n")).not.toContain("Corrected line:");
      if (json) { expect(JSON.parse(result.out.join("\n")).corrected).toBeNull(); expect(result.err).toEqual([]); }
      else expect(result.out).toEqual([]);
    }
  });
});

describe("whole-invocation correction boundaries", () => {
  const unsafe = [
    [TEMPLATE, "hatsu@g4+model#one#two"],
    ["<repo>[@<gate:G4|G5>{+}][then <labels>{&}]", "repo@G4+then x then y"],
    ["<repo>[%<phase:Start|End>{+}|<term>][!<terms>{&}]", "repo%start+model!one!two"],
  ] as const;
  it.each(unsafe)("withholds a delimiter relocation that changes meaning or stays invalid: %s", async (template, line) => {
    expect(parse(line, template).ok).toBe(false);
    expect(parse(line, template).corrected).toBeNull();
    for (const json of [false, true]) {
      const result = await cli(template, line, json); expect(result.code).toBe(2);
      expect(result.err.join("\n")).not.toContain("Corrected line:");
      if (json) expect(JSON.parse(result.out.join("\n")).corrected).toBeNull();
    }
  });
  it.each([
    ["<repo>@<gates:G4|G5>{+}", "hatsu@"],
    ["<repo>@<gates:G4|G5>{+}", "hatsu"],
    ["<gates:G4|G5>{+}", ""],
    ["<repo>@<gate:G4|G5>{+}|<terms>{&}", "hatsu@"],
    ["<repo>#<terms>{&}", "hatsu#"],
  ])("withholds placeholders for an incomplete required structured position: %s", async (template, line) => {
    expect(parse(line, template).ok).toBe(false); expect(parse(line, template).corrected).toBeNull();
    for (const json of [false, true]) {
      const result = await cli(template, line, json); expect(result.code).toBe(2);
      expect(result.err.join("\n")).not.toContain("Corrected line:");
      if (json) expect(JSON.parse(result.out.join("\n")).corrected).toBeNull();
    }
  });
  it.each(["x&&y", "&x&y", "x&y&"])("normalizes a malformed free-list alternative without changing its chosen alternative: %s", async (value) => {
    const template = "<repo>[@<gate:G4|G5>{+}|<terms>{&}]";
    const result = parse(`hatsu@${value}`, template); expect(result.ok).toBe(false);
    expect(result.corrected).toBe("state hatsu@x&y");
    const repaired = parse("hatsu@x&y", template); expect(repaired.ok).toBe(true);
    expect(repaired.slots[1]).toEqual({ name: "gate|terms", value: "x&y", suffix: false, alternative: "terms", items: ["x", "y"] });
    const json = await cli(template, `hatsu@${value}`, true); expect(JSON.parse(json.out.join("\n")).corrected).toBe(result.corrected);
  });
  it("does not turn a malformed free list into an enumerated alternative", () => {
    expect(parse("hatsu@&g4&", "<repo>[@<gate:G4|G5>{+}|<terms>{&}]").corrected).toBeNull();
  });
  it("retains intended normalized slots, suffixes, list items and literal clauses after relocation", () => {
    const template = `${TEMPLATE}[then sweep]`;
    const result = parse("hatsu@g4+model#one&two then sweep", template);
    expect(result.corrected).toBe("state hatsu@G4#model&one&two then sweep");
    const repaired = parse(result.corrected!.slice("state ".length), template);
    expect(repaired.ok).toBe(true);
    expect(repaired.slots).toEqual([
      { name: "repo", value: "hatsu", suffix: false },
      { name: "gate|severity|label", value: "G4", suffix: false, alternative: "gate", items: ["G4"] },
      { name: "labels", value: "model&one&two", suffix: false, items: ["model", "one", "two"] },
    ]);
    expect(repaired.clauses).toEqual([{ literal: "then sweep", present: true }]);
  });
});

it("publishes the concrete severity repair in JSON while refusing the input", async () => {
  const result = await cli(TEMPLATE, "hatsu@high+low#model/gpt", true);
  expect(result.code).toBe(2);
  expect(JSON.parse(result.out.join("\n")).corrected).toBe("state hatsu@low+#model/gpt");
});
