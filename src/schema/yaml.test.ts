import { describe, expect, it } from "vitest";
import { parseYaml, YamlError } from "./yaml.js";

describe("parseYaml -- the shapes the taxonomy files use", () => {
  it("reads a nested block mapping", () => {
    expect(
      parseYaml(["version: 1", "categories:", "  status:", "    scope: one"].join("\n")),
    ).toEqual({ version: 1, categories: { status: { scope: "one" } } });
  });

  it("reads flow sequences and flow mappings", () => {
    expect(parseYaml("precedence: [on_hold, blocked, ready_g1]")).toEqual({
      precedence: ["on_hold", "blocked", "ready_g1"],
    });
    expect(parseYaml('badge:   { emoji: "X", note: "a, b" }')).toEqual({
      badge: { emoji: "X", note: "a, b" },
    });
  });

  it("reads block sequences, of scalars and of mappings", () => {
    expect(parseYaml(["phases:", "  - review-pair", "  - dev-team"].join("\n"))).toEqual({
      phases: ["review-pair", "dev-team"],
    });
    expect(
      parseYaml(
        ["consumers:", "  - repo: a/b", "    pinned: v1", "  - repo: c/d", "    pinned: v2"].join(
          "\n",
        ),
      ),
    ).toEqual({
      consumers: [
        { repo: "a/b", pinned: "v1" },
        { repo: "c/d", pinned: "v2" },
      ],
    });
  });

  it("REGRESSION: a NESTED block sequence returns instead of hanging", () => {
    // THE FINDING THAT FORCED THE SWAP. The hand-rolled reader spun forever on
    // this input -- reproduced end to end through the compiled binary, which had
    // to be killed. What matters about this case is not the value it asserts;
    // it is that the case TERMINATES.
    expect(parseYaml("- - foo: bar\n")).toEqual([[{ foo: "bar" }]]);
    expect(parseYaml("a:\n  - - 1\n    - 2\n")).toEqual({ a: [[1, 2]] });
    expect(parseYaml("- - - deep\n")).toEqual([[["deep"]]]);
  });

  it("REGRESSION: `__proto__` cannot become a prototype assignment", () => {
    // The second finding. `map[key] = value` with the key `__proto__` sets the
    // mapping's PROTOTYPE, which the duplicate-key guard could not see and every
    // later bracket read could inherit from. It is now refused outright -- and
    // the underlying property that made it dangerous is gone as well, because
    // the package makes it an ordinary own key.
    expect(() => parseYaml("a: 1\n__proto__: {polluted: yes}\n")).toThrow(YamlError);
    expect(() => parseYaml("a: 1\n__proto__: {polluted: yes}\n")).toThrow(
      /names a JavaScript object internal/,
    );
    // Nothing leaked on the way to the refusal.
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false);
  });

  it("returns objects whose prototype is Object.prototype and nothing else", () => {
    const value = parseYaml("a:\n  b: 1\n") as Record<string, unknown>;
    expect(Object.getPrototypeOf(value)).toBe(Object.prototype);
    expect(Object.getPrototypeOf(value["a"] as object)).toBe(Object.prototype);
    expect(Object.keys(value)).toEqual(["a"]);
  });

  it("folds a `>-` block scalar and keeps newlines in a `|`", () => {
    expect(
      parseYaml(["means: >-", "  Work is moving: jobs queued", "  or running."].join("\n")),
    ).toEqual({ means: "Work is moving: jobs queued or running." });
    expect(parseYaml(["body: |", "  one", "  two"].join("\n"))).toEqual({ body: "one\ntwo\n" });
  });

  it("reads null, ~, an empty value, booleans and numbers", () => {
    expect(
      parseYaml(["a: null", "b: ~", "c:", "d: true", "e: false", "f: 12", "g: 1.5"].join("\n")),
    ).toEqual({ a: null, b: null, c: null, d: true, e: false, f: 12, g: 1.5 });
  });

  it("parses under YAML 1.2 core, so a bare `on` stays a string", () => {
    // Not academic: src/pipeline.test.ts reads the GitHub Actions workflows
    // through this reader, and every one has a top-level `on:` key. Under YAML
    // 1.1 the bare word `on` is the boolean true.
    expect(parseYaml("on: [push]\nflag: on\n")).toEqual({ on: ["push"], flag: "on" });
  });

  it("accepts one leading document marker", () => {
    expect(parseYaml("---\nversion: 1")).toEqual({ version: 1 });
  });

  it("keeps a '#' that is part of a quoted colour, and strips a real comment", () => {
    expect(parseYaml('hex: "#0e8a16"')).toEqual({ hex: "#0e8a16" });
    expect(parseYaml("gate: G1   # the approval gate")).toEqual({ gate: "G1" });
  });

  it("does NOT split a value that itself contains a colon", () => {
    expect(parseYaml("label: sample:severity/critical")).toEqual({
      label: "sample:severity/critical",
    });
  });

  it("reads a whole colours-file shape end to end", () => {
    const source = [
      "# a comment",
      "version: 1",
      "",
      "categories:",
      "  status:",
      "    scope: >-",
      "      One per issue or PR.",
      "    precedence: [on_hold, blocked]",
      "    values:",
      "      on_hold:",
      '        emoji: "*"',
      '        hex: "#0052cc"',
      "        label: Intentionally on hold",
      "        gate: null",
      "      blocked:",
      '        emoji: "!"',
      '        hex: "#d73a4a"',
      "        label: Blocked",
      "        means: A human-only action is required.",
      "        gate: G5",
    ].join("\n");
    expect(parseYaml(source)).toEqual({
      version: 1,
      categories: {
        status: {
          scope: "One per issue or PR.",
          precedence: ["on_hold", "blocked"],
          values: {
            on_hold: {
              emoji: "*",
              hex: "#0052cc",
              label: "Intentionally on hold",
              gate: null,
            },
            blocked: {
              emoji: "!",
              hex: "#d73a4a",
              label: "Blocked",
              means: "A human-only action is required.",
              gate: "G5",
            },
          },
        },
      },
    });
  });
});

describe("parseYaml -- the refusals this wrapper exists for", () => {
  // The package parses most of these happily. Each is refused because its
  // meaning depends on a resolution step two readers can disagree about.
  const refusals: readonly [string, string, RegExp][] = [
    ["an anchor", "a: &x 1", /anchors are not supported/],
    ["an anchor with an alias", "a: &x 1\nb: *x", /anchors are not supported/],
    ["a bare alias", "a: *x", /aliases are not supported|alias/i],
    ["a merge key", "a:\n  <<: b", /merge keys/],
    ["an explicit tag", "a: !!str 1", /explicit tags are not supported/],
    // An UNRESOLVED custom tag is refused by the package before the walk sees
    // it (TAG_RESOLVE_FAILED); a resolvable one is refused by the walk. Both
    // arrive as a YamlError with a line, which is the contract that matters.
    ["a custom tag", "a: !Foo bar", /explicit tags are not supported|TAG_RESOLVE_FAILED/],
    ["a directive", "%YAML 1.2\n---\na: 1", /YAML directives/],
    ["a second document", "a: 1\n---\nb: 2", /second document/],
    ["a tab in the indentation", "a:\n\tb: 1", /TAB_AS_INDENT/],
    ["a duplicate key", "a: 1\na: 2", /unique/i],
    ["a __proto__ key", "__proto__: 1", /object internal/],
    ["a constructor key", "constructor: 1", /object internal/],
    ["a prototype key", "prototype: 1", /object internal/],
    ["an unterminated flow collection", "a: [1, 2", /\[[A-Z_]+\]/],
  ];

  for (const [name, source, message] of refusals) {
    it(`refuses ${name}, loudly and with a line number`, () => {
      expect(() => parseYaml(source), name).toThrow(YamlError);
      expect(() => parseYaml(source), name).toThrow(message);
      expect(() => parseYaml(source), name).toThrow(/line \d+/);
    });
  }

  it("points at the offending LINE, not always at line 1", () => {
    try {
      parseYaml("a: 1\nb: 2\nc: &anchor 3\n");
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(YamlError);
      expect((error as YamlError).line).toBe(3);
    }
  });

  it("never returns a value for an unsupported construct", () => {
    // A refusal, not a partial parse. If any of these returned, it would be a
    // taxonomy read that quietly lost or invented a field.
    for (const source of ["a: &x 1\nb: *x", "a: !!str 1", "__proto__: {}"]) {
      let returned = false;
      try {
        parseYaml(source);
        returned = true;
      } catch {
        returned = false;
      }
      expect(returned, source).toBe(false);
    }
  });
});
