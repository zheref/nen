import { describe, expect, it } from "vitest";
import { parseStatusPorcelain, triageStage } from "./triage.js";

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

  it("flags an ignored file", () => {
    const result = triageStage([{ path: "node_modules/x", indexStatus: "!", worktreeStatus: "!", ignored: true }]);
    expect(result.flagged[0]?.reasons).toEqual(["ignored"]);
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

  it("reports EVERY reason a file matches, not just the first", () => {
    const entries = [{ path: ".env", indexStatus: "!", worktreeStatus: "!", ignored: true }];
    const result = triageStage(entries, { scopePrefixes: ["src/"] });
    expect([...(result.flagged[0]?.reasons ?? [])].sort()).toEqual(["ignored", "out-of-scope", "secret-shape"]);
  });

  it("a file matching nothing is clean", () => {
    const entries = [{ path: "src/a.ts", indexStatus: "M", worktreeStatus: " ", ignored: false }];
    const result = triageStage(entries, { scopePrefixes: ["src/"] });
    expect(result.clean).toEqual(["src/a.ts"]);
    expect(result.flagged).toEqual([]);
  });
});
