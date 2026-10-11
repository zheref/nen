import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { guardTempFile, JsonSpanError, locateJsonValue, memberCount, rewritePin, TargetChangedError, writeFileAtomic, type CheckedTarget } from "./pin-write.js";

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

  it("refuses a duplicated member on the edit path: maintained_tools, or a row's repo or pinned (Feitan F3)", () => {
    expect(() => rewritePin('{"maintained_tools":[{"repo":"o/h","pinned":"v0.1","pinned":"v0.2"}]}', 0, "v0.3", "o/h")).toThrow(/maintained_tools\[0\] carries 'pinned' more than once/);
    expect(() => rewritePin('{"maintained_tools":[{"repo":"x/y","repo":"o/h","pinned":"v0.1"}]}', 0, "v0.3", "o/h")).toThrow(/carries 'repo' more than once/);
    expect(() => rewritePin('{"maintained_tools":[{"repo":"x/y","pinned":"v0.1"}],"maintained_tools":[{"repo":"o/h","pinned":"v0.1"}]}', 0, "v0.3", "o/h")).toThrow(/maintained_tools appears more than once/);
    // A duplicate elsewhere -- another row, another key -- is not the edit path's.
    expect(rewritePin('{"x":1,"x":2,"maintained_tools":[{"repo":"a/b","repo":"a/b"},{"repo":"o/h","pinned":"v0.1"}]}', 1, "v0.3", "o/h").after).toBe("v0.3");
    expect(memberCount('{"a":1,"b":{"a":2},"a":3}', 0, "a")).toBe(2);
    expect(memberCount("{}", 0, "a")).toBe(0);
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

/** A target checked as the verb checks one: real path, real root, the file's identity as read. */
function checked(path: string, over: Partial<CheckedTarget> = {}): CheckedTarget {
  const real = realpathSync.native(path);
  const stat = lstatSync(real);
  return { path: real, root: realpathSync.native(dirname(real)), platform: process.platform, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, mode: stat.mode & 0o777, ...over };
}

describe("writeFileAtomic -- a temporary file beside the CHECKED target, renamed over it", () => {
  it("replaces the bytes, keeps the permission bits and leaves no temporary file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-atomic-"));
    const path = join(dir, "repos.json");
    writeFileSync(path, "old\n", { mode: 0o640 });
    writeFileAtomic(checked(path), "new\n");
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
      writeFileAtomic(checked(path), "new\n");
    } finally {
      process.umask(previous);
    }
    expect(statSync(path).mode & 0o777).toBe(0o664);
  });

  // Feitan F1: the target is never re-resolved; every fact the caller checked
  // is re-asserted after the open and before the rename.
  const raced = (what: string, swap: (path: string, dir: string) => void, hook: "afterOpen" | "beforeRename", message: RegExp): void => {
    it.skipIf(process.platform === "win32")(`refuses, removing its temporary file, when ${what} (${hook})`, () => {
      const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-pin-atomic-race-")));
      mkdirSync(join(dir, "repo"));
      const path = join(dir, "repo", "repos.json");
      writeFileSync(path, "old\n");
      const target = checked(path, { root: join(dir, "repo") });
      expect(() => writeFileAtomic(target, "new\n", { [hook]: (): void => swap(path, dir) })).toThrow(message);
      expect(readdirSync(join(dir, "repo")).filter((name): boolean => name.endsWith(".tmp"))).toEqual([]);
    });
  };
  raced("the file is replaced by another (a lost update)", (path) => {
    rmSync(path);
    writeFileSync(path, "someone else's\n");
  }, "beforeRename", /changed after it was checked \((it is another file now|it was modified)/);
  raced("the file is edited in place", (path) => {
    writeFileSync(path, "edited in place, longer\n");
  }, "beforeRename", /it was modified since it was read -- a lost update/);
  raced("the file becomes a link out of the root", (path, dir) => {
    writeFileSync(join(dir, "outside.json"), "outside\n");
    rmSync(path);
    symlinkSync(join(dir, "outside.json"), path);
  }, "afterOpen", /it now resolves to .*outside\.json/);
  raced("the file vanishes", (path) => {
    rmSync(path);
  }, "beforeRename", /it no longer resolves: ENOENT/);

  it.skipIf(process.platform === "win32")("refuses a target outside the root it was checked against", () => {
    const dir = realpathSync.native(mkdtempSync(join(tmpdir(), "nen-pin-atomic-root-")));
    const path = join(dir, "repos.json");
    writeFileSync(path, "old\n");
    expect(() => writeFileAtomic(checked(path, { root: join(dir, "elsewhere") }), "new\n")).toThrow(TargetChangedError);
    expect(readFileSync(path, "utf8")).toBe("old\n");
    expect(readdirSync(dir)).toEqual(["repos.json"]);
  });

  it("removes its temporary file when the rename fails, leaving the target as it was", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-atomic-fail-"));
    const path = join(dir, "repos.json");
    mkdirSync(path);
    writeFileSync(join(path, "inside"), "x");
    expect(() => writeFileAtomic(checked(path), "new\n")).toThrow();
    expect(readdirSync(dir)).toEqual(["repos.json"]);
    expect(readFileSync(join(path, "inside"), "utf8")).toBe("x");
  });
});

describe("guardTempFile -- an interrupt never leaves the temporary file behind (Feitan F6)", () => {
  it("is installed for the write's window and removed after it", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-guard-window-"));
    const path = join(dir, "repos.json");
    writeFileSync(path, "old\n");
    const before = process.listenerCount("SIGINT");
    let during = -1;
    writeFileAtomic(checked(path), "new\n", { beforeRename: (): void => void (during = process.listenerCount("SIGINT")) });
    expect(during).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it("removes the temporary file on SIGINT and re-raises the signal", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pin-guard-"));
    const temp = join(dir, ".repos.json.nen-1-abc.tmp");
    writeFileSync(temp, "partial");
    const before = process.listeners("SIGINT");
    const kills: string[] = [];
    const dispose = guardTempFile(temp, (_pid, signal): void => void kills.push(signal));
    const added = process.listeners("SIGINT").filter((listener): boolean => !before.includes(listener));
    expect(added).toHaveLength(1);
    (added[0] as () => void)();
    expect(existsSync(temp)).toBe(false);
    expect(kills).toEqual(["SIGINT"]);
    expect(process.listeners("SIGINT")).toEqual(before);
    dispose();
  });
});
