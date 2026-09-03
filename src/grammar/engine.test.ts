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

// zheref/nen#30: with only one slot ahead of a `[ ... ]` clause, the engine
// swallowed the whole line into that slot and reported ok:true. Every shape the
// issue names is pinned here so the collapse cannot come back quietly.
describe("parseInvocation -- single-slot templates with a bracketed clause (zheref/nen#30)", () => {
  const slot = (result: ReturnType<typeof parseInvocation>, name: string): string | undefined =>
    result.slots.find((s): boolean => s.name === name)?.value;

  describe("<repo>[@<gate:...>] -- a bracketed symbol-separated enumerated slot", () => {
    const grammar = parseTemplate("<repo>[@<gate:G1|G1-M|G2|G3|G4|G5|all>]");

    it("template parse: the '@' is <gate>'s separator, never a [+]-style suffix on <repo>", () => {
      expect(grammar.slots[0]?.suffix).toBeNull();
      expect(grammar.slots[1]?.separator).toBe("@");
      expect(grammar.slots[1]?.separatorKind).toBe("symbol");
      expect(grammar.slots[1]?.optional).toBe(true);
    });

    it("splits 'BC@G4' into repo=BC, gate=G4", () => {
      const result = parseInvocation("backlog-state", grammar, "BC@G4");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC");
      expect(slot(result, "gate")).toBe("G4");
    });

    it("parses a bare 'BC' with the optional gate simply absent", () => {
      const result = parseInvocation("backlog-state", grammar, "BC");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC");
      expect(slot(result, "gate")).toBeUndefined();
      expect(result.missing).toEqual([]);
    });

    it("REFUSES 'BC@G9' on the enumeration -- never swallows it into <repo>", () => {
      const result = parseInvocation("backlog-state", grammar, "BC@G9");
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatch(/G1 \| G1-M \| G2 \| G3 \| G4 \| G5 \| all/);
      expect(slot(result, "repo")).toBe("BC");
      // The corrected line keeps the repo AND re-prompts the gate the caller
      // attempted, rather than pretending they never typed one.
      expect(result.corrected).toContain("BC@<gate:");
    });
  });

  describe("<repo>[@<gate>] -- the same shape, unconstrained", () => {
    const grammar = parseTemplate("<repo>[@<gate>]");

    it("splits 'BC@G4' into repo=BC, gate=G4", () => {
      const result = parseInvocation("backlog-state", grammar, "BC@G4");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC");
      expect(slot(result, "gate")).toBe("G4");
    });

    it("parses a bare 'BC' with the gate absent", () => {
      const result = parseInvocation("backlog-state", grammar, "BC");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC");
      expect(slot(result, "gate")).toBeUndefined();
    });
  });

  describe("<repo> [then sweep] -- a literal-only optional clause", () => {
    const grammar = parseTemplate("<repo> [then sweep]");

    it("template parse: the clause is recorded, not dropped", () => {
      expect(grammar.clauses).toEqual([{ literal: "then sweep", slotsBefore: 1 }]);
    });

    it("recognises the clause and stops <repo>'s capture before it", () => {
      const result = parseInvocation("futon", grammar, "BC then sweep");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC");
      expect(result.clauses).toEqual([{ literal: "then sweep", present: true }]);
      expect(result.echo).toContain("[then sweep]: present");
      expect(result.corrected).toBe("futon BC then sweep");
    });

    it("parses a bare 'BC' with the clause absent", () => {
      const result = parseInvocation("futon", grammar, "BC");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC");
      expect(result.clauses).toEqual([{ literal: "then sweep", present: false }]);
    });

    it("matches the clause on whole words: 'then sweeper' is repo prose, not the clause", () => {
      const result = parseInvocation("futon", grammar, "BC then sweeper");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC then sweeper");
      expect(result.clauses[0]?.present).toBe(false);
    });

    it("matches the LAST occurrence, so the clause's words in prose stay in <repo>", () => {
      const result = parseInvocation("futon", grammar, "BC then sweep then sweep");
      expect(result.ok).toBe(true);
      expect(slot(result, "repo")).toBe("BC then sweep");
      expect(result.clauses[0]?.present).toBe(true);
    });

    it("refuses trailing text after the clause instead of swallowing it", () => {
      const result = parseInvocation("futon", grammar, "BC then sweep twice");
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatch(/defines nothing after it/);
    });
  });

  describe("onto [<target-branch>] -- a required literal introducing an optional leading slot", () => {
    const grammar = parseTemplate("onto [<target-branch>]");

    it("a bare 'onto' leaves <target-branch> ABSENT -- the literal is never the value", () => {
      const result = parseInvocation("tensho", grammar, "onto");
      expect(result.ok).toBe(true);
      expect(result.slots).toEqual([]);
      expect(result.missing).toEqual([]);
      // 'onto' alone is a complete valid line, and the corrected line keeps it.
      expect(result.corrected).toBe("tensho onto");
    });

    it("captures the value after the literal", () => {
      const result = parseInvocation("tensho", grammar, "onto main");
      expect(result.ok).toBe(true);
      expect(slot(result, "target-branch")).toBe("main");
    });

    it("refuses a line that does not open with the literal", () => {
      const result = parseInvocation("tensho", grammar, "main");
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatch(/must open with the literal 'onto'/);
    });
  });

  describe("templates the engine cannot split unambiguously are refused LOUDLY", () => {
    it("refuses a bracketed leading slot that nothing introduces", () => {
      // An omitted value and a mistyped one would read identically; the refusal
      // names the anchored rewrite.
      expect(() => parseTemplate("[<repo>]")).toThrow(/nothing introduces it/);
      expect(() => parseTemplate("[<repo>]@<gate>")).toThrow(/nothing introduces it/);
    });

    it("refuses a literal clause that appears before any slot", () => {
      expect(() => parseTemplate("[then sweep] <repo>")).toThrow(/before any <slot>/);
    });

    it("refuses introducing words that cross a '[' boundary", () => {
      expect(() => parseTemplate("<repo> foo [bar <mode>]")).toThrow(/cross a '\[' boundary/);
    });

    it("refuses a bracketed clause ending in a separator that introduces nothing", () => {
      expect(() => parseTemplate("<repo> [x @]")).toThrow(/introducing no <slot>/);
    });
  });

  describe("[word <slot>] -- the separator itself inside the brackets", () => {
    const grammar = parseTemplate("[onto <target-branch>]");

    it("an empty line parses with the whole clause absent", () => {
      const result = parseInvocation("tensho", grammar, "");
      expect(result.ok).toBe(true);
      expect(result.slots).toEqual([]);
    });

    it("a line carrying the clause supplies the slot", () => {
      const result = parseInvocation("tensho", grammar, "onto main");
      expect(result.ok).toBe(true);
      expect(slot(result, "target-branch")).toBe("main");
    });

    it("a line that is neither the clause nor empty is refused", () => {
      const result = parseInvocation("tensho", grammar, "main");
      expect(result.ok).toBe(false);
      expect(result.problems[0]).toMatch(/omit that clause entirely/);
    });
  });

  it("the fix does not regress the two-slot template the issue shows working", () => {
    const grammar = parseTemplate("<repo>@<gate:G1|G1-M|G2|G3|G4|G5|all>");
    const result = parseInvocation("backlog-state", grammar, "BC@G4");
    expect(result.ok).toBe(true);
    expect(result.slots).toEqual([
      { name: "repo", value: "BC", suffix: false },
      { name: "gate", value: "G4", suffix: false },
    ]);
  });

  it("the [+] suffix is still a suffix: its bracket group holds nothing else", () => {
    const grammar = parseTemplate("<repo>@<severity>[+] [then <terminal>]");
    expect(grammar.slots[1]?.suffix).toBe("+");
    const result = parseInvocation("futon", grammar, "BC@high+ then tag");
    expect(result.ok).toBe(true);
    expect(result.slots).toEqual([
      { name: "repo", value: "BC", suffix: false },
      { name: "severity", value: "high", suffix: true },
      { name: "terminal", value: "tag", suffix: false },
    ]);
  });
});
