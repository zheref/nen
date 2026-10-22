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
import { computeOverlap, type EffortFiles } from "./overlap.js";

const files = (effort: string, list: readonly string[] | null): EffortFiles => ({ effort, files: list, unreadReason: list === null ? "bad ref" : null });

describe("computeOverlap", () => {
  it("is disjoint when no path is shared", () => {
    const report = computeOverlap("origin/main", [files("a", ["src/a.ts"]), files("b", ["src/b.ts"])], []);
    expect(report.verdict).toBe("disjoint");
    expect(report.overlaps).toEqual([]);
  });

  it("names every shared path and who shares it, path-sorted", () => {
    const report = computeOverlap("origin/main", [files("a", ["z.ts", "docs/USAGE.md"]), files("b", ["docs/USAGE.md", "z.ts"]), files("c", ["c.ts"])], []);
    expect(report.verdict).toBe("overlap");
    expect(report.overlaps).toEqual([
      { path: "docs/USAGE.md", efforts: ["a", "b"], always: false },
      { path: "z.ts", efforts: ["a", "b"], always: false },
    ]);
  });

  it("counts an always-overlapping path as every effort's, touched yet or not, and a prefix through the paths under it", () => {
    const report = computeOverlap("origin/main", [files("a", ["src/a.ts", "surfaces/x/a.md"]), files("b", ["src/b.ts"])], ["CHANGELOG.md", "surfaces/"]);
    expect(report.verdict).toBe("overlap");
    expect(report.overlaps).toEqual([
      { path: "CHANGELOG.md", efforts: ["a", "b"], always: true },
      { path: "surfaces/x/a.md", efforts: ["a", "b"], always: true },
    ]);
    expect(computeOverlap("origin/main", [files("a", ["src/a.ts"])], ["CHANGELOG.md"]).verdict).toBe("disjoint");
  });

  it("is stack(<order>) when the overlapping efforts' branches chain, and overlap when they do not (NN#488 AC-1)", () => {
    const chain = (ancestor: string, descendant: string): boolean => (ancestor === "a" && descendant !== "a") || (ancestor === "b" && descendant === "c");
    const stacked = computeOverlap("origin/main", [files("c", ["x"]), files("a", ["x"]), files("b", ["x"])], [], chain);
    expect(stacked.verdict).toBe("stack");
    expect(stacked.stack).toEqual(["a", "b", "c"]);
    const forked = computeOverlap("origin/main", [files("a", ["x"]), files("b", ["x"])], [], () => false);
    expect(forked.verdict).toBe("overlap");
    expect(forked.stack).toBeNull();
    expect(computeOverlap("origin/main", [files("a", ["x"]), files("b", ["x"])], [], () => null).verdict).toBe("overlap");
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
    expect(Object.keys(doc)).toEqual(["verdict", "base", "alwaysOverlaps", "overlaps", "efforts", "unread", "stack"]);
    expect(doc.overlaps[0].path).toBe("CHANGELOG.md");
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

  it("refuses an empty, repeated or dash-led effort list and another verb's flags at exit 2", async () => {
    const root = repo();
    expect((await capture(["wc", "overlap"], root, {})).code).toBe(2);
    expect((await capture(["wc", "overlap", "--efforts", "a,a"], root, {})).code).toBe(2);
    expect((await capture(["wc", "overlap", "--efforts", "-a"], root, {})).code).toBe(2);
    expect((await capture(["wc", "overlap", "--efforts", "a", "--dry-run"], root, {})).code).toBe(2);
    expect((await capture(["wc", "classify", "--efforts", "a"], root, {})).code).toBe(2);
  });
});
