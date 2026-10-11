import { describe, expect, it } from "vitest";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JsonSpanError, locateJsonValue, rewritePin, writeFileAtomic } from "./pin-write.js";

/** The lines of `before` and `after` that differ, as [before, after] pairs -- the diff a reviewer reads. */
function changedLines(before: string, after: string): [string, string][] {
  const a = before.split("\n");
  const b = after.split("\n");
  expect(b.length).toBe(a.length);
  const out: [string, string][] = [];
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) out.push([a[index] ?? "", b[index] ?? ""]);
  }
  return out;
}

// A registry as a person writes one: tabs and spaces mixed, keys in no
// canonical order, a $comment, a compact row, a duplicate slug in another
// case, unicode and an escaped quote elsewhere, and a trailing newline.
const MESSY = `{
\t"$comment": "hand-kept \\"registry\\" -- café",
  "maintained_tools" : [
    { "role": "first", "repo": "owner/handbooks", "pinned": "v1.0.0" },
    {"repo":"owner/tool","pinned":"v9.9.9"},
    {
        "pinned"   :   "v1.2.0",
        "repo": "Owner/Handbooks",
        "role": "the canon \\u2014 last row"
    }
  ],
  "consumers": [ { "repo": "owner/app", "pinned": "v1.2.0" } ],
  "product_codes": {}
}
`;

describe("locateJsonValue -- the byte span the loader reads", () => {
  it("finds a nested value by member names and indexes", () => {
    const span = locateJsonValue(MESSY, ["maintained_tools", 2, "pinned"]);
    expect(MESSY.slice(span.start, span.end)).toBe('"v1.2.0"');
    const compact = locateJsonValue(MESSY, ["maintained_tools", 1, "pinned"]);
    expect(MESSY.slice(compact.start, compact.end)).toBe('"v9.9.9"');
    const object = locateJsonValue(MESSY, ["product_codes"]);
    expect(MESSY.slice(object.start, object.end)).toBe("{}");
  });

  it("answers with the LAST member of a duplicated name, as JSON.parse does", () => {
    const text = '{ "a": { "p": "first" }, "a": { "p": "second", "p": "third" } }';
    const span = locateJsonValue(text, ["a", "p"]);
    expect(text.slice(span.start, span.end)).toBe('"third"');
    expect((JSON.parse(text) as { a: { p: string } }).a.p).toBe("third");
  });

  it("walks over numbers, literals, nested arrays and escapes without losing its place", () => {
    const text = '{"x":[1,-2.5e3,true,null,[[]],{"k":"a\\\\\\"b"}],"y":"z"}';
    const span = locateJsonValue(text, ["y"]);
    expect(text.slice(span.start, span.end)).toBe('"z"');
  });

  it("refuses a path the text does not have", () => {
    expect(() => locateJsonValue(MESSY, ["maintained_tools", 7, "pinned"])).toThrow(JsonSpanError);
    expect(() => locateJsonValue(MESSY, ["maintained_tools", 1, "checkout"])).toThrow(/has no member 'checkout'/);
    expect(() => locateJsonValue(MESSY, ["product_codes", 0])).toThrow(/expected an array/);
    expect(() => locateJsonValue("[]", ["a"])).toThrow(/expected an object/);
    expect(() => locateJsonValue("{}", ["a"])).toThrow(/has no member 'a'/);
    expect(() => locateJsonValue("[]", [0])).toThrow(/past the end/);
    expect(() => locateJsonValue('{"a" 1}', ["a"])).toThrow(/expected ':'/);
    expect(() => locateJsonValue('{"a":1 "b":2}', ["b"])).toThrow(/expected ','/);
    expect(() => locateJsonValue('{"a":"open', ["a"])).toThrow(/never closed/);
    expect(() => locateJsonValue("{1:2}", ["a"])).toThrow(/expected a string/);
  });
});

describe("rewritePin -- one value changes, and nothing else", () => {
  it("replaces exactly the one literal: the diff is that value on that line, every other byte preserved", () => {
    const edit = rewritePin(MESSY, 2, "v1.3.0", "owner/handbooks");
    expect(edit.before).toBe("v1.2.0");
    expect(edit.after).toBe("v1.3.0");
    expect(changedLines(MESSY, edit.text)).toEqual([['        "pinned"   :   "v1.2.0",', '        "pinned"   :   "v1.3.0",']]);
    // Byte-for-byte outside the span: the prefix and suffix are the original's.
    expect(edit.text.slice(0, edit.span.start)).toBe(MESSY.slice(0, edit.span.start));
    expect(edit.text.slice(edit.span.start + '"v1.3.0"'.length)).toBe(MESSY.slice(edit.span.end));
    expect(edit.text.endsWith("}\n")).toBe(true);
    expect(edit.line).toBe(7);
  });

  it("leaves the same tag in another row (a consumer pin, an earlier row) alone", () => {
    const edit = rewritePin(MESSY, 2, "v2.0.0", "owner/handbooks");
    expect(edit.text).toContain('"consumers": [ { "repo": "owner/app", "pinned": "v1.2.0" } ]');
    expect(edit.text).toContain('{ "role": "first", "repo": "owner/handbooks", "pinned": "v1.0.0" }');
  });

  it("keeps CRLF line endings and a missing trailing newline as they are", () => {
    const crlf = '{\r\n  "maintained_tools": [\r\n    { "repo": "o/h", "pinned": "v1.0" }\r\n  ]\r\n}';
    const edit = rewritePin(crlf, 0, "v1.1", "o/h");
    expect(edit.text).toBe(crlf.replace('"v1.0"', '"v1.1"'));
    expect(edit.text.endsWith("}")).toBe(true);
  });

  it("edits the pinned member JSON.parse reads when a row repeats the key", () => {
    const text = '{"maintained_tools":[{"repo":"o/h","pinned":"v0.1","pinned":"v0.2"}]}';
    const edit = rewritePin(text, 0, "v0.3", "o/h");
    expect(edit.before).toBe("v0.2");
    expect(edit.text).toBe('{"maintained_tools":[{"repo":"o/h","pinned":"v0.1","pinned":"v0.3"}]}');
  });

  it("refuses an index whose row names another source, whatever its pin (Nobunaga N3)", () => {
    expect(() => rewritePin(MESSY, 1, "v1.3.0", "owner/handbooks")).toThrow(/maintained_tools\[1\] is 'owner\/tool', not owner\/handbooks/);
    expect(() => rewritePin('{"maintained_tools":[{"pinned":"v1.0"}]}', 0, "v1.1", "o/h")).toThrow(/a row with no repo/);
    // The slug is compared case-insensitively, as everywhere in the family.
    expect(rewritePin(MESSY, 2, "v1.3.0", "OWNER/HANDBOOKS").after).toBe("v1.3.0");
  });

  it("refuses a pinned value that is not a string, and a row with no pinned key", () => {
    expect(() => rewritePin('{"maintained_tools":[{"repo":"o/h","pinned":3}]}', 0, "v1.0", "o/h")).toThrow(/is not a string/);
    expect(() => rewritePin('{"maintained_tools":[{"repo":"o/h"}]}', 0, "v1.0", "o/h")).toThrow(/has no member 'pinned'/);
  });
});

describe("writeFileAtomic -- a temporary file beside the target, renamed over it", () => {
  it("replaces the bytes, keeps the permission bits and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-atomic-"));
    const path = join(dir, "repos.json");
    writeFileSync(path, "old\n", { mode: 0o640 });
    writeFileAtomic(path, "new\n");
    expect(readFileSync(path, "utf8")).toBe("new\n");
    if (process.platform !== "win32") expect(statSync(path).mode & 0o777).toBe(0o640);
    expect(readdirSync(dir)).toEqual(["repos.json"]);
  });

  it.skipIf(process.platform === "win32")("keeps a group-writable 0664 under a 022 umask: the mode is set, not masked (Nobunaga N1)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-atomic-mode-"));
    const path = join(dir, "repos.json");
    writeFileSync(path, "old\n");
    chmodSync(path, 0o664);
    const previous = process.umask(0o022);
    try {
      writeFileAtomic(path, "new\n");
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(0o664);
  });

  it.skipIf(process.platform === "win32")("writes through a symbolic link, keeping the link", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-atomic-link-"));
    mkdirSync(join(dir, "real"));
    const real = join(dir, "real", "repos.json");
    writeFileSync(real, "old\n");
    const link = join(dir, "repos.json");
    symlinkSync(real, link);
    writeFileAtomic(link, "new\n");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(real);
    expect(readFileSync(real, "utf8")).toBe("new\n");
    expect(readdirSync(join(dir, "real"))).toEqual(["repos.json"]);
  });

  it("removes its temporary file when the rename fails, leaving the target as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-atomic-fail-"));
    // A directory where the file should be: realpath and stat succeed, the
    // rename of a file over a non-empty directory does not.
    const path = join(dir, "repos.json");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    expect(() => writeFileAtomic(path, "new\n")).toThrow();
    expect(readdirSync(dir)).toEqual(["repos.json"]);
    expect(readFileSync(join(path, "inside"), "utf8")).toBe("x");
  });
});
