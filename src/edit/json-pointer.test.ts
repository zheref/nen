import { describe, expect, it } from "vitest";
import { formatPointer, JsonPointerSyntaxError, parsePointer, setJsonPointer } from "./json-pointer.js";
import { indentUnit, insertMember, JsonSpanError, objectMembers, skipWs } from "./json-span.js";

/** The lines of `before` and `after` that differ -- the diff a reviewer reads. */
function diff(before: string, after: string): { removed: string[]; added: string[] } {
  const a = before.split("\n");
  const b = after.split("\n");
  return { removed: a.filter((line): boolean => !b.includes(line)), added: b.filter((line): boolean => !a.includes(line)) };
}

// A declaration as a person keeps one: tabs and spaces mixed, a compact row,
// `$` notes at several levels, a unicode escape, and a trailing newline.
const MESSY = `{
\t"$comment": "hand-kept -- café",
  "coverage" : { "minimum": 80, "$minimum": "one of: 70, 80, 90", "ideal": 90 },
  "branch": {
      "base"   :   "main",
      "template": "{model}/{persona}/{descriptor}"
  },
  "reviewers": [ {"name":"a","on":true}, { "name": "b \\u2014 two", "on": false } ],
  "empty": {},
  "monitor": { "maxCycles": 20 }
}
`;

describe("parsePointer / formatPointer -- RFC 6901", () => {
  it("splits, unescapes ~1 then ~0, and round-trips", () => {
    expect(parsePointer("")).toEqual([]);
    expect(parsePointer("/a/b")).toEqual(["a", "b"]);
    expect(parsePointer("/a~1b/c~0d/~01")).toEqual(["a/b", "c~d", "~1"]);
    expect(parsePointer("/")).toEqual([""]);
    expect(formatPointer(["a/b", "c~d", "~1"])).toBe("/a~1b/c~0d/~01");
  });

  it("refuses a pointer without a leading '/' and a bare '~'", () => {
    expect((): unknown => parsePointer("a/b")).toThrow(JsonPointerSyntaxError);
    expect((): unknown => parsePointer("/a~2")).toThrow(JsonPointerSyntaxError);
    expect((): unknown => parsePointer("/a~")).toThrow(JsonPointerSyntaxError);
  });
});

describe("setJsonPointer -- replace an existing scalar", () => {
  it("changes one literal, and only that line", () => {
    const edit = setJsonPointer(MESSY, ["coverage", "minimum"], 85);
    expect(edit.op).toBe("replace");
    expect(edit.before).toBe(80);
    expect(edit.after).toBe(85);
    expect(edit.changed).toBe(true);
    expect(edit.line).toBe(3);
    expect(diff(MESSY, edit.text)).toEqual({
      removed: ['  "coverage" : { "minimum": 80, "$minimum": "one of: 70, 80, 90", "ideal": 90 },'],
      added: ['  "coverage" : { "minimum": 85, "$minimum": "one of: 70, 80, 90", "ideal": 90 },'],
    });
    expect(edit.text.endsWith("}\n")).toBe(true);
  });

  it("keeps the spacing around the literal it replaces, and replaces inside arrays by index", () => {
    const base = setJsonPointer(MESSY, ["branch", "base"], "trunk");
    expect(base.text).toContain('"base"   :   "trunk",');
    const flag = setJsonPointer(MESSY, ["reviewers", "1", "on"], true);
    expect(flag.text).toContain('{ "name": "b \\u2014 two", "on": true }');
    const compact = setJsonPointer(MESSY, ["reviewers", "0", "name"], null);
    expect(compact.text).toContain('{"name":null,"on":true}');
  });

  it("writes a string as JSON, escapes and all", () => {
    const edit = setJsonPointer(MESSY, ["branch", "base"], 'a "quoted" — / name');
    expect((JSON.parse(edit.text) as { branch: { base: string } }).branch.base).toBe('a "quoted" — / name');
  });

  it("an equal value is unchanged and keeps the text byte for byte", () => {
    const edit = setJsonPointer(MESSY, ["coverage", "minimum"], 80);
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(MESSY);
  });

  it("refuses replacing a scalar with an object or an array (v1), and still adds one as a new member", () => {
    expect((): unknown => setJsonPointer(MESSY, ["coverage", "minimum"], { a: 1 })).toThrow(/replacing it with an object is not supported in v1/);
    expect((): unknown => setJsonPointer(MESSY, ["branch", "base"], ["x"])).toThrow(/replacing it with an array is not supported in v1/);
    expect(setJsonPointer(MESSY, ["monitor", "list"], ["x"]).op).toBe("add");
  });

  it("refuses an object or array target, and an index past the end or '-'", () => {
    expect((): unknown => setJsonPointer(MESSY, ["coverage"], 1)).toThrow(/holds an object/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers"], 1)).toThrow(/holds an array/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers", "2"], 1)).toThrow(/past the end/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers", "-"], 1)).toThrow(/appending/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers", "01"], 1)).toThrow(/not an index/);
    expect((): unknown => setJsonPointer(MESSY, ["coverage", "minimum", "x"], 1)).toThrow(/not an object or an array/);
    expect((): unknown => setJsonPointer(MESSY, [], 1)).toThrow(/whole document/);
  });
});

describe("setJsonPointer -- add a member to an existing object", () => {
  it("appends in a one-line object's own style", () => {
    const edit = setJsonPointer(MESSY, ["monitor", "pollSeconds"], 300);
    expect(edit.op).toBe("add");
    expect(edit.before).toBeUndefined();
    expect(diff(MESSY, edit.text)).toEqual({
      removed: ['  "monitor": { "maxCycles": 20 }'],
      added: ['  "monitor": { "maxCycles": 20, "pollSeconds": 300 }'],
    });
  });

  it("appends after the last member -- a $ note included -- in an expanded object's own indentation", () => {
    const edit = setJsonPointer(MESSY, ["branch", "lane"], "nen");
    expect(edit.text).toContain('      "template": "{model}/{persona}/{descriptor}",\n      "lane"   :   "nen"\n  },');
    const after = setJsonPointer(MESSY, ["coverage", "scope"], "touched");
    expect(after.text).toContain('"$minimum": "one of: 70, 80, 90", "ideal": 90, "scope": "touched" }');
  });

  it("adds a root member, and expands an empty object in a multi-line document", () => {
    const root = setJsonPointer(MESSY, ["tests"], { required: ["test"] });
    expect(root.text.endsWith('  "monitor": { "maxCycles": 20 },\n  "tests": {"required":["test"]}\n}\n')).toBe(true);
    const empty = setJsonPointer(MESSY, ["empty", "k"], "v");
    expect(empty.text).toContain('  "empty": {\n    "k": "v"\n  },');
    expect(empty.line).toBe(10);
  });

  it("matches a one-line object's own comma and colon spacing (N6)", () => {
    expect(setJsonPointer('{"a":1,"b":2}', ["c"], 3).text).toBe('{"a":1,"b":2,"c":3}');
    expect(setJsonPointer('{ "a" : 1 , "b" : 2 }', ["c"], 3).text).toBe('{ "a" : 1 , "b" : 2 , "c" : 3 }');
    expect(setJsonPointer('{"a" :1}', ["c"], 3).text).toBe('{"a" :1,"c" :3}');
  });

  it("keeps { }'s inner space, in a one-line and a multi-line document (N6)", () => {
    expect(setJsonPointer('{"a":{ }}', ["a", "b"], 1).text).toBe('{"a":{ "b":1 }}');
    expect(setJsonPointer('{\n  "a": { }\n}\n', ["a", "b"], 1).text).toBe('{\n  "a": { "b": 1 }\n}\n');
  });

  it("writes into an empty object inline in a one-line document, and into the root of an empty one", () => {
    expect(setJsonPointer('{"a":{}}', ["a", "b"], 1).text).toBe('{"a":{"b":1}}');
    expect(setJsonPointer("{}", ["b"], 1).text).toBe('{"b": 1}');
    expect(setJsonPointer("{}\n", ["b"], 1).text).toBe('{"b": 1}\n');
  });

  it("keeps CRLF and tabs where the file uses them", () => {
    const crlf = '{\r\n\t"a": {\r\n\t}\r\n}\r\n';
    expect(setJsonPointer(crlf, ["a", "b"], 1).text).toBe('{\r\n\t"a": {\r\n\t\t"b": 1\r\n\t}\r\n}\r\n');
    expect(indentUnit(crlf)).toBe("\t");
    expect(indentUnit('{\n    "a": {\n        "b": 1\n    }\n}')).toBe("    ");
    expect(indentUnit("{}")).toBe("  ");
  });

  it("refuses a missing member before the last step -- nothing is created on the way", () => {
    expect((): unknown => setJsonPointer(MESSY, ["profile", "default"], "fast")).toThrow(/does not exist/);
  });
});

describe("setJsonPointer -- each member on the path once", () => {
  it("refuses a path through a repeated member, and adding a member the object repeats", () => {
    const text = '{ "a": { "p": 1 }, "a": { "p": 2, "q": 3 } }';
    expect((): unknown => setJsonPointer(text, ["a", "q"], 4)).toThrow(/carries 'a' more than once/);
    const inner = '{ "a": { "p": 1, "p": 2 } }';
    expect((): unknown => setJsonPointer(inner, ["a", "p"], 3)).toThrow(/carries 'p' more than once/);
  });

  it("refuses a value JSON cannot carry", () => {
    expect((): unknown => setJsonPointer(MESSY, ["coverage", "minimum"], undefined)).toThrow(JsonSpanError);
  });
});

describe("objectMembers / insertMember", () => {
  it("lists every member in text order, duplicates included", () => {
    const text = '{ "a": 1, "b": [2], "a": {"c": 3} }';
    expect(objectMembers(text, skipWs(text, 0)).map((member): string => member.key)).toEqual(["a", "b", "a"]);
    expect(objectMembers("{}", 0)).toEqual([]);
    expect((): unknown => objectMembers("[1]", 0)).toThrow(JsonSpanError);
  });

  it("reports the span of the member it added", () => {
    const inserted = insertMember('{ "a": 1 }', 0, "b", "2");
    expect(inserted.text).toBe('{ "a": 1, "b": 2 }');
    expect(inserted.text.slice(inserted.span.start, inserted.span.end)).toBe('"b": 2');
    const expanded = insertMember('{\n  "a": {\n  }\n}', 9, "b", "2");
    expect(expanded.text.slice(expanded.span.start, expanded.span.end)).toBe('"b": 2');
  });
});
