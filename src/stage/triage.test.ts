import { describe, expect, it } from "vitest";
import { parseStatusPorcelain, triageStage } from "./triage.js";

describe("parseStatusPorcelain", () => {
  it("parses ordinary modified/added/deleted/untracked entries", () => {
    const entries = parseStatusPorcelain(" M src/a.ts\nA  src/b.ts\n D src/c.ts\n?? src/new.ts\n");
    expect(entries.map((e): string => e.path)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/new.ts"]);
  });

  it("marks '!!' entries ignored", () => {
    const entries = parseStatusPorcelain("!! node_modules/x\n");
    expect(entries[0]).toMatchObject({ path: "node_modules/x", ignored: true });
  });

  it("keeps only the NEW path of a rename", () => {
    const entries = parseStatusPorcelain("R  old/name.ts -> new/name.ts\n");
    expect(entries[0]?.path).toBe("new/name.ts");
  });

  it("returns empty for empty input", () => {
    expect(parseStatusPorcelain("")).toEqual([]);
  });
});

describe("triageStage -- detects, never decides; every flag reported, not just the first", () => {
  it("flags a secret-shaped filename", () => {
    const result = triageStage([{ path: ".env", indexStatus: "?", worktreeStatus: "?", ignored: false }]);
    expect(result.flagged).toEqual([{ path: ".env", reasons: ["secret-shape"] }]);
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
