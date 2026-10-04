import { describe, expect, it } from "vitest";
import {
  addListFrom,
  DEFAULT_LARGE_BYTES,
  expandWorktreeRenames,
  parseStatusPorcelain,
  parseStatusPorcelainBytes,
  pathspecLine,
  triageStage,
} from "./triage.js";

describe("parseStatusPorcelain -- -z / NUL-delimited format", () => {
  it("parses ordinary modified/added/deleted/untracked entries", () => {
    const entries = parseStatusPorcelain(" M src/a.ts\0A  src/b.ts\0 D src/c.ts\0?? src/new.ts\0");
    expect(entries.map((e): string => e.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/new.ts"]);
  });

  it("marks '!!' entries ignored", () => {
    const entries = parseStatusPorcelain("!! node_modules/x\0");
    expect(entries[0]).toMatchObject({ path: "node_modules/x", ignored: true });
  });

  it("keeps only the NEW path of a rename, consuming the ORIG_PATH record rather than treating it as its own entry", () => {
    const entries = parseStatusPorcelain("R  new/name.ts\0old/name.ts\0");
    expect(entries.map((e): string => e.path)).toEqual(["new/name.ts"]);
  });

  it("returns empty for empty input", () => {
    expect(parseStatusPorcelain("")).toEqual([]);
  });

  // Review finding #3: the default (non -z) porcelain format C-quotes any
  // path with a non-ASCII byte -- "secr\303\253ts/.env" -- which defeated the
  // $-anchored secret-shape check. -z disables quoting unconditionally.
  it("does not corrupt a non-ASCII path the way the default quoted format would", () => {
    const entries = parseStatusPorcelain("?? secrëts/.env\0");
    expect(entries[0]?.path).toBe("secrëts/.env");
    expect(entries[0]?.path.endsWith('"')).toBe(false);
  });
});

describe("triageStage -- detects, never decides; every flag reported, not just the first", () => {
  it("flags a secret-shaped filename", () => {
    const result = triageStage([{ path: ".env", indexStatus: "?", worktreeStatus: "?", ignored: false }]);
    expect(result.flagged).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
  });

  it("flags a secret-shaped filename with a non-ASCII path component (BLOCKER #3 -- must not depend on the caller unquoting the path)", () => {
    const result = triageStage([{ path: "secrëts/.env", indexStatus: "?", worktreeStatus: "?", ignored: false }]);
    expect(result.flagged).toEqual([{ path: "secrëts/.env", reasons: ["secret-shape"] }]);
  });

  it("flags credentials*, *.pem and *.key too", () => {
    const entries = [
      { path: "credentials.json", indexStatus: "?", worktreeStatus: "?", ignored: false },
      { path: "certs/server.pem", indexStatus: "?", worktreeStatus: "?", ignored: false },
      { path: "keys/id.key", indexStatus: "?", worktreeStatus: "?", ignored: false },
    ];
    const result = triageStage(entries);
    expect(result.flagged.map((f): string => f.path)).toEqual(entries.map((e): string => e.path));
  });

  it("reports an ignored file in its own bucket, never in flagged (zheref/nen#169)", () => {
    const result = triageStage([{ path: "node_modules/x", indexStatus: "!", worktreeStatus: "!", ignored: true }]);
    expect(result.ignored).toEqual([{ path: "node_modules/x", reasons: ["ignored"] }]);
    expect(result.flagged).toEqual([]);
    expect(result.clean).toEqual([]);
  });

  it("flags a binary by extension", () => {
    const result = triageStage([{ path: "assets/logo.png", indexStatus: "A", worktreeStatus: " ", ignored: false }]);
    expect(result.flagged[0]?.reasons).toEqual(["binary"]);
  });

  it("flags a binary supplied via numstat detection even without a recognized extension", () => {
    const result = triageStage(
      [{ path: "assets/blob", indexStatus: "A", worktreeStatus: " ", ignored: false }],
      { binaryPaths: new Set(["assets/blob"]) },
    );
    expect(result.flagged[0]?.reasons).toEqual(["binary"]);
  });

  it("flags a file outside the declared scope, and skips the check entirely when no scope is declared", () => {
    const entries = [{ path: "unrelated/dir/file.ts", indexStatus: "M", worktreeStatus: " ", ignored: false }];
    expect(triageStage(entries, { scopePrefixes: ["src/"] }).flagged[0]?.reasons).toEqual(["out-of-scope"]);
    expect(triageStage(entries, {}).flagged).toEqual([]);
  });

  it("flags a deletion whose basename is not mentioned in the free text", () => {
    const entries = [{ path: "src/old.ts", indexStatus: "D", worktreeStatus: " ", ignored: false }];
    expect(triageStage(entries, { mentionedText: "removes src/other.ts" }).flagged[0]?.reasons).toEqual([
      "unmentioned-deletion",
    ]);
    expect(triageStage(entries, { mentionedText: "removes old.ts as dead code" }).flagged).toEqual([]);
  });

  it("reports EVERY reason a file matches, not just the first -- including inside the ignored bucket", () => {
    const entries = [{ path: ".env", indexStatus: "!", worktreeStatus: "!", ignored: true }];
    const result = triageStage(entries, { scopePrefixes: ["src/"] });
    expect([...(result.ignored[0]?.reasons ?? [])].sort()).toEqual(["ignored", "out-of-scope", "secret-shape"]);
    expect(result.flagged).toEqual([]);
  });

  it("a file matching nothing is clean", () => {
    const entries = [{ path: "src/a.ts", indexStatus: "M", worktreeStatus: " ", ignored: false }];
    const result = triageStage(entries, { scopePrefixes: ["src/"] });
    expect(result.clean).toEqual(["src/a.ts"]);
    expect(result.flagged).toEqual([]);
    expect(result.ignored).toEqual([]);
  });
});

describe("triageStage -- the ignored bucket (zheref/nen#169)", () => {
  it("keeps a secret-shape inside an ignored tree in 'ignored', with the reason recorded, never in 'flagged'", () => {
    const entries = [{ path: "build/secrets/.env", indexStatus: "!", worktreeStatus: "!", ignored: true }];
    const result = triageStage(entries);
    expect(result.ignored).toEqual([{ path: "build/secrets/.env", reasons: ["ignored", "secret-shape"] }]);
    expect(result.flagged).toEqual([]);
  });

  it("splits a mixed tree into clean, flagged and ignored, and the exit-deciding bucket (flagged) carries only paths a commit could contain", () => {
    const entries = [
      { path: "src/a.ts", indexStatus: "M", worktreeStatus: " ", ignored: false }, // clean
      { path: ".env", indexStatus: "?", worktreeStatus: "?", ignored: false }, // flagged: secret-shape
      { path: "node_modules/x/index.js", indexStatus: "!", worktreeStatus: "!", ignored: true }, // ignored
      { path: "node_modules/y/.env", indexStatus: "!", worktreeStatus: "!", ignored: true }, // ignored, secret-shape too
    ];
    const result = triageStage(entries);
    expect(result.clean).toEqual(["src/a.ts"]);
    expect(result.flagged).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
    expect(result.ignored.map((f): string => f.path)).toEqual(["node_modules/x/index.js", "node_modules/y/.env"]);
    expect(result.ignored.every((f): boolean => f.reasons.includes("ignored"))).toBe(true);
  });

  it("a tree with only ignored rows leaves 'flagged' empty", () => {
    const entries = [
      { path: "node_modules/x", indexStatus: "!", worktreeStatus: "!", ignored: true },
      { path: ".cursor/rules/foo.mdc", indexStatus: "!", worktreeStatus: "!", ignored: true },
    ];
    const result = triageStage(entries);
    expect(result.flagged).toEqual([]);
    expect(result.ignored).toHaveLength(2);
  });
});

// zheref/nen#57. `hatsu:tensho` and `hatsu:jujisho` each independently kept
// local-config and file-size checks as by-eye judgement on top of this verb's
// five detectors -- two skills compensating the same way is the shape of a gap
// rather than a preference.
describe("triageStage -- local-config filenames", () => {
  function flagsFor(path: string): readonly string[] {
    const result = triageStage([
      { path, indexStatus: "?", worktreeStatus: "?", ignored: false },
    ]);
    return result.flagged[0]?.reasons ?? [];
  }

  it("flags the '.local' infix wherever a tool puts it", () => {
    for (const path of [
      ".claude/settings.local.json",
      "config.local.json",
      "app/config.local.yml",
      "notes.local",
    ]) {
      expect(flagsFor(path), path).toContain("local-config");
    }
  });

  it("leaves an ordinary path alone, including one that merely CONTAINS 'local'", () => {
    // A filename check that fired on `localisation.ts` or `src/local/index.ts`
    // would bury the rows that need a decision under ones that do not, which is
    // the defect zheref/nen#169's `ignored` bucket exists to undo.
    for (const path of ["src/localisation.ts", "src/local/index.ts", "locale.json", "src/index.ts"]) {
      expect(flagsFor(path), path).not.toContain("local-config");
    }
  });

  it("carries BOTH reasons where a file is local config AND secret-shaped", () => {
    // '.env.local' is each of those independently, and "present all flags at
    // once" is this module's own rule.
    expect(flagsFor(".env.local")).toEqual(["secret-shape", "local-config"]);
  });
});

describe("triageStage -- unusually large files", () => {
  const entry = { path: "big.txt", indexStatus: "?", worktreeStatus: "?", ignored: false } as const;

  it("flags a file at or over the threshold, and not one under it", () => {
    const at = triageStage([entry], { sizes: new Map([["big.txt", 100]]), largeBytes: 100 });
    expect(at.flagged[0]?.reasons).toContain("large");
    const under = triageStage([entry], { sizes: new Map([["big.txt", 99]]), largeBytes: 100 });
    expect(under.flagged).toEqual([]);
    expect(under.clean).toEqual(["big.txt"]);
  });

  it("uses one mebibyte when the caller states no threshold", () => {
    expect(DEFAULT_LARGE_BYTES).toBe(1024 * 1024);
    const big = triageStage([entry], { sizes: new Map([["big.txt", DEFAULT_LARGE_BYTES]]) });
    expect(big.flagged[0]?.reasons).toContain("large");
    const ordinary = triageStage([entry], { sizes: new Map([["big.txt", 4096]]) });
    expect(ordinary.clean).toEqual(["big.txt"]);
  });

  it("never flags a path it was given no size for -- unmeasured is not small", () => {
    // The one reading this must not produce. A deletion has no file to stat,
    // and a caller that measured nothing has claimed nothing.
    const unmeasured = triageStage([entry], { sizes: new Map(), largeBytes: 1 });
    expect(unmeasured.flagged).toEqual([]);
  });

  it("keeps a large file's OTHER reasons alongside it", () => {
    const result = triageStage(
      [{ path: "dump.local.json", indexStatus: "?", worktreeStatus: "?", ignored: false }],
      { sizes: new Map([["dump.local.json", 5_000_000]]) },
    );
    expect(result.flagged[0]?.reasons).toEqual(["local-config", "large"]);
  });
});

// zheref/nen#237: the add list is triage's complement, computed from the same
// entries -- never re-derived.
describe("addListFrom -- the exact add list", () => {
  function listOf(status: string, mentions = ""): ReturnType<typeof addListFrom> {
    const entries = parseStatusPorcelain(status);
    return addListFrom(entries, triageStage(entries, { mentionedText: mentions }));
  }

  it("keeps every modified, added, renamed, mentioned-deleted and UNTRACKED path, in git's order", () => {
    const list = listOf(
      " M src/a.ts\0A  src/b.ts\0R  src/new.ts\0src/old.ts\0 D src/gone.ts\0?? packages/core/src/utils/oauthReturnQuery.ts\0",
      "drops gone.ts",
    );
    expect(list.verdict).toBe("ready");
    expect(list.add).toEqual([
      "src/a.ts",
      "src/b.ts",
      "src/new.ts",
      "src/gone.ts",
      "packages/core/src/utils/oauthReturnQuery.ts",
    ]);
    expect(list.excluded).toEqual([]);
  });

  it("never lists a flagged or an ignored path, and names each exclusion with its reasons", () => {
    const list = listOf(" M src/a.ts\0?? .env\0!! node_modules/x.js\0");
    expect(list.add).toEqual(["src/a.ts"]);
    expect(list.excluded).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
    expect(list.ignored).toEqual([{ path: "node_modules/x.js", reasons: ["ignored"] }]);
    expect(list.verdict).toBe("flagged");
  });

  it("moves a deletion already staged to alreadyStaged -- git add would refuse its pathspec", () => {
    const list = listOf("D  src/staged-gone.ts\0 M src/a.ts\0", "staged-gone.ts");
    expect(list.add).toEqual(["src/a.ts"]);
    expect(list.alreadyStaged).toEqual(["src/staged-gone.ts"]);
  });

  it("is 'empty' on an all-ignored tree, and 'empty' on a tree with nothing at all", () => {
    expect(listOf("!! node_modules/x.js\0").verdict).toBe("empty");
    expect(listOf("").verdict).toBe("empty");
    expect(listOf("").add).toEqual([]);
  });

  it("calls a tree whose every change is flagged 'flagged', never 'empty'", () => {
    const list = listOf("?? .env\0");
    expect(list.add).toEqual([]);
    expect(list.verdict).toBe("flagged");
  });
});

describe("pathspecLine -- one path, one line git add reads back exactly", () => {
  it("writes ordinary paths raw: spaces, edge whitespace, non-ASCII, glob characters", () => {
    for (const path of ["src/a.ts", "with space.ts", " lead", "trail ", "secrëts/a.ts", "st*r[1].ts"]) {
      expect(pathspecLine(path)).toBe(path);
    }
  });

  it("C-quotes a path carrying a control character, or starting with a double quote", () => {
    expect(pathspecLine("new\nline.ts")).toBe('"new\\nline.ts"');
    expect(pathspecLine("cr\r")).toBe('"cr\\r"');
    expect(pathspecLine("tab\there")).toBe('"tab\\there"');
    expect(pathspecLine("bell\u0001")).toBe('"bell\\001"');
    expect(pathspecLine('"quoted')).toBe('"\\"quoted"');
    expect(pathspecLine('a\\b\n"c')).toBe('"a\\\\b\\n\\"c"');
  });
});

// hanten round 1 on #237 (N1, N3, N4, N7, N8).
describe("addListFrom -- what a list may never carry, and the rename it must", () => {
  function listOf(status: string, mentions = ""): ReturnType<typeof addListFrom> {
    const entries = expandWorktreeRenames(parseStatusPorcelain(status));
    return addListFrom(entries, triageStage(entries, { mentionedText: mentions }));
  }

  it("keeps a rename's ORIG_PATH on the entry", () => {
    expect(parseStatusPorcelain(" R src/new.ts\0src/old.ts\0")[0]).toMatchObject({
      path: "src/new.ts",
      origPath: "src/old.ts",
    });
  });

  it("expands a WORKTREE rename into its original's deletion, and leaves index renames and copies alone", () => {
    const paths = (status: string): string[] =>
      expandWorktreeRenames(parseStatusPorcelain(status)).map((e): string => `${e.indexStatus}${e.worktreeStatus} ${e.path}`);
    expect(paths(" R new.ts\0old.ts\0")).toEqual([" R new.ts", " D old.ts"]);
    expect(paths("R  new.ts\0old.ts\0")).toEqual(["R  new.ts"]);
    expect(paths(" C copy.ts\0orig.ts\0")).toEqual([" C copy.ts"]);
  });

  it("holds every unmerged pair off the list, verdict flagged", () => {
    const status = ["UU", "AA", "DD", "AU", "UA", "DU", "UD"].map((xy, i): string => `${xy} c${i}.ts\0`).join("");
    const list = listOf(`${status} M ok.ts\0`, "c2.ts c5.ts c6.ts");
    expect(list.unmerged).toEqual(["c0.ts", "c1.ts", "c2.ts", "c3.ts", "c4.ts", "c5.ts", "c6.ts"]);
    expect(list.add).toEqual(["ok.ts"]);
    expect(list.verdict).toBe("flagged");
  });

  it("holds an embedded repository (an untracked path ending in '/') off the list", () => {
    const list = listOf("?? vendor/lib/\0?? src/new.ts\0");
    expect(list.embeddedRepos).toEqual(["vendor/lib/"]);
    expect(list.add).toEqual(["src/new.ts"]);
    expect(list.verdict).toBe("flagged");
  });

  it("lists a REAL U+FFFD in a filename as an ordinary path -- it is a legal character", () => {
    const list = listOf("?? bad\uFFFD.ts\0?? src/new.ts\0");
    expect(list.undecodable).toEqual([]);
    expect(list.add).toEqual(["bad\uFFFD.ts", "src/new.ts"]);
    expect(list.verdict).toBe("ready");
  });

  it("holds a name whose RAW bytes are not UTF-8 off the list as undecodable", () => {
    const enc = new TextEncoder();
    const bytes = new Uint8Array([...enc.encode("?? bad"), 0xff, ...enc.encode(".ts\0?? src/new.ts\0")]);
    const entries = parseStatusPorcelainBytes(bytes);
    expect(entries.map((e): boolean => e.undecodable === true)).toEqual([true, false]);
    const list = addListFrom(entries, triageStage(entries));
    expect(list.undecodable).toEqual(["bad\uFFFD.ts"]);
    expect(list.add).toEqual(["src/new.ts"]);
    expect(list.verdict).toBe("flagged");
  });

  it("marks a rename undecodable when only its ORIGINAL's bytes are bad, and carries that to the expanded deletion", () => {
    const enc = new TextEncoder();
    const bytes = new Uint8Array([...enc.encode(" R new.ts\0old"), 0xfe, ...enc.encode(".ts\0")]);
    const expanded = expandWorktreeRenames(parseStatusPorcelainBytes(bytes));
    expect(expanded.map((e): boolean => e.undecodable === true)).toEqual([true, true]);
  });

  it("parses valid bytes exactly as the text parser does, CR/LF inside a path included", () => {
    const text = " M a\r\nb.ts\0R  new.ts\0old.ts\0?? x y.ts\0";
    expect(parseStatusPorcelainBytes(new TextEncoder().encode(text))).toEqual(parseStatusPorcelain(text));
  });

  it("dedupes the add list, keeping first-seen order", () => {
    // A worktree rename whose original git ALSO reports as its own deletion row.
    const list = listOf(" R b.ts\0a.ts\0 D a.ts\0 M c.ts\0", "a.ts");
    expect(list.add).toEqual(["b.ts", "a.ts", "c.ts"]);
  });
});
