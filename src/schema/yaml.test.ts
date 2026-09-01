import { describe, expect, it } from "vitest";
import { parseYaml, splitKey, YamlError } from "./yaml.js";

describe("parseYaml -- the supported subset", () => {
  it("reads a nested block mapping", () => {
    expect(
      parseYaml(["version: 1", "categories:", "  status:", "    scope: one"].join("\n")),
    ).toEqual({ version: 1, categories: { status: { scope: "one" } } });
  });

  it("reads a flow sequence", () => {
    expect(parseYaml("precedence: [on_hold, blocked, ready_g1]")).toEqual({
      precedence: ["on_hold", "blocked", "ready_g1"],
    });
  });

  it("reads a flow mapping", () => {
    expect(parseYaml('ichigo:   { emoji: "X", note: "a, b" }')).toEqual({
      ichigo: { emoji: "X", note: "a, b" },
    });
  });

  it("reads a block sequence of scalars", () => {
    expect(parseYaml(["phases:", "  - review-pair", "  - dev-team"].join("\n"))).toEqual({
      phases: ["review-pair", "dev-team"],
    });
  });

  it("reads a block sequence of mappings whose first key is on the dash line", () => {
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

  it("folds a `>-` block scalar into one line with no trailing newline", () => {
    expect(
      parseYaml(["means: >-", "  Work is moving: jobs queued", "  or running."].join("\n")),
    ).toEqual({ means: "Work is moving: jobs queued or running." });
  });

  it("keeps newlines in a `|` block scalar", () => {
    expect(parseYaml(["body: |", "  one", "  two"].join("\n"))).toEqual({
      body: "one\ntwo\n",
    });
  });

  it("reads null, ~, an empty value, booleans and numbers", () => {
    expect(
      parseYaml(["a: null", "b: ~", "c:", "d: true", "e: false", "f: 12", "g: 1.5"].join("\n")),
    ).toEqual({ a: null, b: null, c: null, d: true, e: false, f: 12, g: 1.5 });
  });

  it("accepts exactly one leading document marker", () => {
    expect(parseYaml("---\nversion: 1")).toEqual({ version: 1 });
  });
});

describe("parseYaml -- the cases the taxonomy files actually contain", () => {
  it("keeps a '#' that is part of a quoted colour, not a comment", () => {
    expect(parseYaml('hex: "#0e8a16"')).toEqual({ hex: "#0e8a16" });
  });

  it("strips a real trailing comment", () => {
    expect(parseYaml("gate: G1   # the approval gate")).toEqual({ gate: "G1" });
  });

  it("does NOT split a value that itself contains a colon", () => {
    // `label: bankai:severity/critical` -- splitting at the first colon would
    // truncate a taxonomy value at the character the taxonomy uses as a
    // namespace separator.
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
      "        means: >-",
      "          Deliberately parked pending another effort.",
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
              means: "Deliberately parked pending another effort.",
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

describe("parseYaml -- the refusals", () => {
  const refusals: readonly [string, string, RegExp][] = [
    ["an anchor", "a: &x 1", /anchors and aliases/],
    ["an alias", "a: *x", /anchors and aliases/],
    ["a merge key", "a:\n  <<: b", /merge keys/],
    ["a tag", "a: !!str 1", /tags are not supported/],
    ["a directive", "%YAML 1.2\na: 1", /directives/],
    ["a second document", "---\n---\na: 1", /second document/],
    ["a mid-file document marker", "a: 1\n---\nb: 2", /appears after content/],
    ["a tab in the indentation", "a:\n\tb: 1", /TAB/],
    ["a duplicate key", "a: 1\na: 2", /duplicate key/],
    ["a nested flow collection", "a: [[1]]", /nested flow collections/],
    ["an unterminated flow collection", "a: [1, 2", /unterminated/],
    ["a line that is not key: value", "a: 1\njust-a-word", /expected 'key: value'/],
    ["over-indentation", "a: 1\n    b: 2", /indented deeper/],
  ];

  for (const [name, source, message] of refusals) {
    it(`refuses ${name}, loudly and with a line number`, () => {
      expect(() => parseYaml(source)).toThrow(YamlError);
      expect(() => parseYaml(source)).toThrow(message);
      expect(() => parseYaml(source)).toThrow(/line \d+/);
    });
  }

  it("never silently drops an unsupported construct", () => {
    // The property that matters: a refusal, not a partial parse. If this ever
    // returned a value it would be a taxonomy read that quietly lost a field.
    let threw = false;
    try {
      parseYaml("a: &anchor 1\nb: *anchor");
    } catch {
      threw = true;
    }
    expect(threw).toBe(true);
  });
});

describe("splitKey", () => {
  it("splits at the first colon followed by a space or end of line", () => {
    expect(splitKey("a: b")).toEqual({ key: "a", rest: "b" });
    expect(splitKey("a:")).toEqual({ key: "a", rest: "" });
    expect(splitKey("a: b:c")).toEqual({ key: "a", rest: "b:c" });
  });

  it("ignores colons inside quotes and flow collections", () => {
    expect(splitKey('a: "b: c"')).toEqual({ key: "a", rest: '"b: c"' });
    expect(splitKey("a: { b: c }")).toEqual({ key: "a", rest: "{ b: c }" });
  });

  it("returns null when there is no key", () => {
    expect(splitKey("plain scalar")).toBeNull();
  });
});
