// src/wc/overlap.test.ts -- `nen wc overlap`: file disjointness of parallel
// efforts, computed from their merge-base diffs.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { wcCommand } from "./command.js";
import { computeOverlap, withDeclared, type EffortFiles } from "./overlap.js";

const files = (effort: string, list: readonly string[] | null): EffortFiles => ({ effort, files: list, unreadReason: list === null ? "bad ref" : null });

describe("computeOverlap", () => {
  it("is disjoint when no path is shared", () => {
    const report = computeOverlap("origin/main", [files("a", ["src/a.ts"]), files("b", ["src/b.ts"])], []);
    expect(report.verdict).toBe("disjoint");
    expect(report.overlaps).toEqual([]);
  });

  it("names every shared path and who shares it, path-sorted", () => {
    const report = computeOverlap("origin/main", [files("a", ["z.ts", "docs/USAGE.md"]), files("b", ["docs/USAGE.md", "z.ts"]), files("c", ["c.ts"])], []);
    expect(report.verdict).toBe("stack");
    expect(report.overlaps).toEqual([
      { path: "docs/USAGE.md", efforts: ["a", "b"], always: false },
      { path: "z.ts", efforts: ["a", "b"], always: false },
    ]);
  });

  it("counts an always-overlapping path as every effort's, touched yet or not, and a prefix through the paths under it", () => {
    const report = computeOverlap("origin/main", [files("a", ["src/a.ts", "surfaces/x/a.md"]), files("b", ["src/b.ts"])], ["CHANGELOG.md", "surfaces/"]);
    expect(report.verdict).toBe("stack");
    expect(report.overlaps).toEqual([
      { path: "CHANGELOG.md", efforts: ["a", "b"], always: true },
      { path: "surfaces/x/a.md", efforts: ["a", "b"], always: true },
    ]);
    expect(computeOverlap("origin/main", [files("a", ["src/a.ts"])], ["CHANGELOG.md"]).verdict).toBe("disjoint");
  });

  it("stacks in git's chain when the overlapping branches chain, else in the given --efforts order (NN#488 AC-1, AC-2)", () => {
    const chain = (ancestor: string, descendant: string): boolean => (ancestor === "a" && descendant !== "a") || (ancestor === "b" && descendant === "c");
    const stacked = computeOverlap("origin/main", [files("c", ["x"]), files("a", ["x"]), files("b", ["x"])], [], chain);
    expect(stacked).toMatchObject({ verdict: "stack", stack: ["a", "b", "c"], stackSource: "chain" });
    const forked = computeOverlap("origin/main", [files("b", ["x"]), files("a", ["x"])], [], () => false);
    expect(forked).toMatchObject({ verdict: "stack", stack: ["b", "a"], stackSource: "given" });
    expect(computeOverlap("origin/main", [files("a", ["x"]), files("b", ["x"])], [], () => null)).toMatchObject({ verdict: "stack", stackSource: "ancestry-unread" });
    // Only the efforts that share a path stack (#515 F7).
    expect(computeOverlap("origin/main", [files("a", ["x"]), files("solo", ["s"]), files("b", ["x"])], [], () => false)).toMatchObject({ verdict: "stack", stack: ["a", "b"], stackSource: "given" });
    expect(computeOverlap("origin/main", [files("a", ["x"]), files("b", ["y"])], [])).toMatchObject({ verdict: "disjoint", stack: null, stackSource: null });
  });

  it("returns stack(...) for two efforts that both touch plugin.json, touched or declared always-overlapping (NN#488 AC-2)", () => {
    const touched = computeOverlap("origin/main", [files("a", [".claude-plugin/plugin.json", "a.md"]), files("b", [".claude-plugin/plugin.json"])], []);
    expect(touched).toMatchObject({ verdict: "stack", stack: ["a", "b"], stackSource: "ancestry-unread" });
    const declared = computeOverlap("origin/main", [files("a", ["a.md"]), files("b", ["b.md"])], [".claude-plugin/plugin.json"]);
    expect(declared.verdict).toBe("stack");
    expect(declared.overlaps).toEqual([{ path: ".claude-plugin/plugin.json", efforts: ["a", "b"], always: true }]);
  });

  it("lets declared paths stand in for an unread diff and adds them to a read one, keeping the diff's reason (NN#488 AC-1, AC-3)", () => {
    expect(withDeclared(files("a", null), ["p.md"])).toEqual({ effort: "a", files: ["p.md"], unreadReason: "bad ref", sources: ["declared"] });
    expect(withDeclared(files("a", ["x.ts"]), ["p.md", "x.ts"])).toEqual({ effort: "a", files: ["p.md", "x.ts"], unreadReason: null, sources: ["diff", "declared"] });
    expect(withDeclared(files("a", null), undefined)).toEqual({ effort: "a", files: null, unreadReason: "bad ref", sources: [] });
    const report = computeOverlap("origin/main", [withDeclared(files("a", null), ["p.md"]), withDeclared(files("b", ["p.md"]), undefined)], []);
    expect(report).toMatchObject({ verdict: "stack", unread: [] });
  });

  it("is unknown when any effort's diff could not be read -- never 'touches nothing'", () => {
    const report = computeOverlap("origin/main", [files("a", ["x"]), files("b", null)], []);
    expect(report.verdict).toBe("unknown");
    expect(report.unread).toEqual(["b"]);
  });
});

describe("nen wc overlap (CLI)", () => {
  async function capture(argv: readonly string[], root: string, diffs: Record<string, string[] | null>, json = false): Promise<{ code: number; out: string[]; calls: string[][] }> {
    const out: string[] = [];
    const calls: string[][] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (): void => {} };
    const seams: Seams = {
      run: (command, args): CommandResult => {
        calls.push([command, ...args]);
        const range = args.find((a): boolean => a.includes("..."));
        const effort = range?.split("...")[1] ?? "";
        const list = diffs[effort];
        if (list === null || list === undefined) return { code: 128, stdout: "", stderr: `fatal: bad revision '${range ?? ""}'`, spawnFailed: false };
        return { code: 0, stdout: list.map((p): string => `${p}\0`).join(""), stderr: "", spawnFailed: false };
      },
      now: (): Date => new Date("2026-10-22T00:00:00Z"),
      env: {},
      probePort: noPortProbe,
      runInteractive: (): never => {
        throw new Error("none");
      },
      runStreamed: (): never => {
        throw new Error("none");
      },
      platform: "linux",
    };
    const code = await runFamily(wcCommand, argv, root, json, io, seams);
    return { code, out, calls };
  }
  const repo = (base?: string): string => {
    const root = mkdtempSync(join(tmpdir(), "nen-overlap-"));
    if (base !== undefined) {
      mkdirSync(join(root, "nen"));
      writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ branch: { base } }));
    }
    return root;
  };

  it("diffs each effort against origin/<branch.base> and exits 0 on disjoint", async () => {
    const root = repo("trunk");
    const result = await capture(["wc", "overlap", "--efforts", "a,b"], root, { a: ["x.ts"], b: ["y.ts"] });
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("verdict: disjoint");
    expect(result.calls).toEqual([
      ["git", "-C", root, "diff", "--name-only", "-z", "origin/trunk...a", "--"],
      ["git", "-C", root, "diff", "--name-only", "-z", "origin/trunk...b", "--"],
    ]);
  });

  it("exits 1 on overlap and on unknown, with the --json shape", async () => {
    const root = repo();
    const overlap = await capture(["wc", "overlap", "--efforts", "a,b", "--base", "origin/main", "--always-overlaps", "CHANGELOG.md"], root, { a: ["x.ts"], b: ["y.ts"] }, true);
    expect(overlap.code).toBe(1);
    const doc = JSON.parse(overlap.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["verdict", "base", "alwaysOverlaps", "overlaps", "efforts", "unread", "stack", "stackSource"]);
    expect(doc.overlaps[0].path).toBe("CHANGELOG.md");
    expect(doc).toMatchObject({ verdict: "stack", stack: ["a", "b"], stackSource: "ancestry-unread" });
    const unknown = await capture(["wc", "overlap", "--efforts", "a,gone"], root, { a: ["x.ts"], gone: null });
    expect(unknown.code).toBe(1);
    expect(unknown.out[0]).toMatch(/^verdict: unknown \(could not read gone\)/);
  });

  it("counts nen/workflow.json's alwaysOverlaps list as touched by every effort, beside the flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-overlap-"));
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ branch: { base: "main" }, alwaysOverlaps: ["package.json"] }));
    const result = await capture(["wc", "overlap", "--efforts", "a,b"], root, { a: ["x.ts"], b: ["y.ts"] }, true);
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n")) as { alwaysOverlaps: string[]; overlaps: { path: string }[] };
    expect(doc.alwaysOverlaps).toEqual(["package.json"]);
    expect(doc.overlaps.map((row) => row.path)).toEqual(["package.json"]);
  });

  it("reads --declared before authoring: a branch with no tip yet is not unknown, and the text names the inputs", async () => {
    const root = repo();
    writeFileSync(join(root, "declared.json"), JSON.stringify({ planned: ["docs/USAGE.md"] }));
    const result = await capture(["wc", "overlap", "--efforts", "a,planned", "--base", "origin/main", "--declared", "declared.json"], root, { a: ["docs/USAGE.md"], planned: null });
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("verdict: stack(a <- planned)");
    expect(result.out[1]).toBe("order: given (the --efforts order; ancestry unread -- git could not say whether the branches chain)");
    expect(result.out.join("\n")).toMatch(/planned: 1 file\(s\) \(declared\); diff not read -- fatal: bad revision/);
  });

  it("refuses an unreadable, malformed or foreign --declared at exit 2", async () => {
    const root = repo();
    writeFileSync(join(root, "bad.json"), "{");
    writeFileSync(join(root, "foreign.json"), JSON.stringify({ other: ["x"] }));
    writeFileSync(join(root, "climb.json"), JSON.stringify({ a: ["../x"] }));
    writeFileSync(join(root, "empty.json"), JSON.stringify({ a: [] }));
    for (const file of ["missing.json", "bad.json", "foreign.json", "climb.json", "empty.json"]) {
      expect((await capture(["wc", "overlap", "--efforts", "a", "--base", "origin/main", "--declared", file], root, { a: [] })).code, file).toBe(2);
    }
    expect((await capture(["wc", "classify", "--declared", "x"], root, {})).code).toBe(2);
  });

  it("refuses an empty, repeated or dash-led effort list and another verb's flags at exit 2", async () => {
    const root = repo();
    expect((await capture(["wc", "overlap"], root, {})).code).toBe(2);
    expect((await capture(["wc", "overlap", "--efforts", "a,a"], root, {})).code).toBe(2);
    expect((await capture(["wc", "overlap", "--efforts", "-a"], root, {})).code).toBe(2);
    expect((await capture(["wc", "overlap", "--efforts", "a", "--dry-run"], root, {})).code).toBe(2);
    expect((await capture(["wc", "classify", "--efforts", "a"], root, {})).code).toBe(2);
  });
});
