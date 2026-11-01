import { describe, expect, it } from "vitest";
import { formatPointer, JsonPointerSyntaxError, parsePointer, setJsonPointer } from "./json-pointer.js";
import { arrayItems, indentUnit, insertMember, JsonSpanError, objectMembers, renderJson, skipWs } from "./json-span.js";

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

  it("refuses a change of kind -- a scalar for a structure, an object for an array, and back -- and still adds a structure as a new member", () => {
    expect((): unknown => setJsonPointer(MESSY, ["coverage", "minimum"], { a: 1 })).toThrow(/holds a scalar, and replacing it with an object changes its kind/);
    expect((): unknown => setJsonPointer(MESSY, ["branch", "base"], ["x"])).toThrow(/holds a scalar, and replacing it with an array changes its kind/);
    expect(setJsonPointer(MESSY, ["monitor", "list"], ["x"]).op).toBe("add");
  });

  it("refuses an object or array target given another kind, and an index past the end, naming the append", () => {
    expect((): unknown => setJsonPointer(MESSY, ["coverage"], 1)).toThrow(/holds an object, and replacing it with a scalar/);
    expect((): unknown => setJsonPointer(MESSY, ["coverage"], [1])).toThrow(/holds an object, and replacing it with an array/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers"], 1)).toThrow(/holds an array, .* appends with \/reviewers\/-/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers", "2"], 1)).toThrow(/past the end .* append with \/reviewers\/-/);
    expect((): unknown => setJsonPointer(MESSY, ["reviewers", "-", "name"], 1)).toThrow(/only a LAST '-' appends/);
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
    // R4: one member, no comma to copy, a spaced colon -> ", ".
    expect(setJsonPointer('{"a": 1}', ["b"], 2).text).toBe('{"a": 1, "b": 2}');
    expect(setJsonPointer('{"a":1}', ["b"], 2).text).toBe('{"a":1,"b":2}');
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

describe("setJsonPointer -- append an item to an array (#587 AC-1)", () => {
  it("appends a structure after the last item, in a one-line array's own comma spacing, and resolves '-' to its index", () => {
    const edit = setJsonPointer(MESSY, ["reviewers", "-"], { name: "c", on: true });
    expect(edit.op).toBe("append");
    expect(edit.before).toBeUndefined();
    expect(edit.segments).toEqual(["reviewers", "2"]);
    expect(diff(MESSY, edit.text)).toEqual({
      removed: ['  "reviewers": [ {"name":"a","on":true}, { "name": "b \\u2014 two", "on": false } ],'],
      added: ['  "reviewers": [ {"name":"a","on":true}, { "name": "b \\u2014 two", "on": false }, {"name": "c", "on": true} ],'],
    });
    expect(edit.text.slice(edit.span.start, edit.span.end)).toBe('{"name": "c", "on": true}');
    expect(edit.line).toBe(8);
  });

  it("appends one item per line in an expanded array, a structure expanded one unit in", () => {
    const text = '{\n  "tests": {\n    "required": [\n      "test",\n      "lint"\n    ]\n  }\n}\n';
    expect(setJsonPointer(text, ["tests", "required", "-"], "typecheck").text).toBe('{\n  "tests": {\n    "required": [\n      "test",\n      "lint",\n      "typecheck"\n    ]\n  }\n}\n');
    const rows = '{\n  "rows": [\n    {\n      "a": 1\n    }\n  ]\n}\n';
    expect(setJsonPointer(rows, ["rows", "-"], { a: 2, b: [3] }).text).toBe(
      '{\n  "rows": [\n    {\n      "a": 1\n    },\n    {\n      "a": 2,\n      "b": [\n        3\n      ]\n    }\n  ]\n}\n',
    );
  });

  it("writes into an empty array: a scalar inline, a structure expanded in a multi-line document, [ ] keeping its space", () => {
    expect(setJsonPointer('{\n  "a": []\n}\n', ["a", "-"], "x").text).toBe('{\n  "a": ["x"]\n}\n');
    expect(setJsonPointer('{\n  "a": []\n}\n', ["a", "-"], { k: 1 }).text).toBe('{\n  "a": [\n    {\n      "k": 1\n    }\n  ]\n}\n');
    expect(setJsonPointer('{"a":[]}', ["a", "-"], { k: 1 }).text).toBe('{"a":[{"k":1}]}');
    expect(setJsonPointer('{"a":[ ]}', ["a", "-"], 1).text).toBe('{"a":[ 1 ]}');
    expect(setJsonPointer('{\n  "a": [\n  ]\n}\n', ["a", "-"], 1).text).toBe('{\n  "a": [\n    1\n  ]\n}\n');
  });

  it("copies a one-item array's spacing: tight after a tight colon, ', ' after a spaced one", () => {
    expect(setJsonPointer('{"a":[1]}', ["a", "-"], 2).text).toBe('{"a":[1,2]}');
    expect(setJsonPointer('{"a": [1]}', ["a", "-"], 2).text).toBe('{"a": [1, 2]}');
    expect(setJsonPointer('{"a": [ 1 ]}', ["a", "-"], 2).text).toBe('{"a": [ 1, 2 ]}');
  });

  it("keeps CRLF and tabs, and appends into a nested array by index", () => {
    const crlf = '{\r\n\t"a": [\r\n\t\t1\r\n\t]\r\n}\r\n';
    expect(setJsonPointer(crlf, ["a", "-"], 2).text).toBe('{\r\n\t"a": [\r\n\t\t1,\r\n\t\t2\r\n\t]\r\n}\r\n');
    expect(setJsonPointer('{"m":[[1],[2]]}', ["m", "1", "-"], 3).text).toBe('{"m":[[1],[2,3]]}');
  });

  it("refuses appending to an object or a scalar: '-' there is a member name, and a scalar has none", () => {
    expect(setJsonPointer('{"a":{}}', ["a", "-"], 1).op).toBe("add");
    expect((): unknown => setJsonPointer('{"a":1}', ["a", "-"], 1)).toThrow(/not an object or an array/);
  });
});

describe("setJsonPointer -- replace an object or an array whole (#587 AC-2)", () => {
  it("rewrites an expanded object in its own layout, every other line kept", () => {
    const text = '{\n  "$comment": "kept",\n  "monitor": {\n    "maxCycles": 20,\n    "pollSeconds": 60\n  },\n  "z": 1\n}\n';
    const edit = setJsonPointer(text, ["monitor"], { maxCycles: 5, note: { a: [1, 2] } });
    expect(edit.op).toBe("replace");
    expect(edit.before).toEqual({ maxCycles: 20, pollSeconds: 60 });
    expect(edit.text).toBe('{\n  "$comment": "kept",\n  "monitor": {\n    "maxCycles": 5,\n    "note": {\n      "a": [\n        1,\n        2\n      ]\n    }\n  },\n  "z": 1\n}\n');
    expect(edit.line).toBe(3);
  });

  it("keeps an inline object inline, in its own colon spacing; an array by an array; an empty structure as {} or []", () => {
    expect(setJsonPointer(MESSY, ["monitor"], { maxCycles: 5, pollSeconds: 30 }).text).toContain('  "monitor": { "maxCycles": 5, "pollSeconds": 30 }\n');
    expect(diff(MESSY, setJsonPointer(MESSY, ["coverage"], { minimum: 70 }).text).added).toEqual(['  "coverage" : { "minimum": 70 },']);
    expect(setJsonPointer('{"a":[1,2]}', ["a"], ["x"]).text).toBe('{"a":["x"]}');
    expect(setJsonPointer('{"a":{"b":1}}', ["a"], {}).text).toBe('{"a":{}}');
    expect(setJsonPointer('{\n  "a": [\n    1\n  ]\n}', ["a"], []).text).toBe('{\n  "a": []\n}');
  });

  it("an equal structure is unchanged and keeps the text byte for byte", () => {
    const edit = setJsonPointer(MESSY, ["monitor"], { maxCycles: 20 });
    expect(edit.changed).toBe(false);
    expect(edit.text).toBe(MESSY);
  });
});

describe("arrayItems / renderJson", () => {
  it("lists every item's span, and refuses a non-array", () => {
    const text = '[ 1, {"a": [2]}, "x" ]';
    expect(arrayItems(text, 0).map((span): string => text.slice(span.start, span.end))).toEqual(["1", '{"a": [2]}', '"x"']);
    expect(arrayItems("[]", 0)).toEqual([]);
    expect((): unknown => arrayItems("{}", 0)).toThrow(JsonSpanError);
  });

  it("renders inline and expanded, and refuses what JSON cannot carry", () => {
    const layout = { expanded: false, base: "", unit: "  ", br: "\n", colon: ":" };
    expect(renderJson({ a: [1, { b: null }] }, layout)).toBe('{"a":[1,{"b":null}]}');
    expect(renderJson({ a: [] }, { ...layout, expanded: true, colon: ": " })).toBe('{\n  "a": []\n}');
    expect((): unknown => renderJson(undefined, layout)).toThrow(JsonSpanError);
  });
});
