import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import { defaultSeams } from "../seam/exec.js";
import { boardCommand } from "./command.js";

function capture(argv: readonly string[], repoFlag: string | null): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const args = parseArgs(argv, mergeFlags(boardCommand.flags));
  try {
    const code = boardCommand.run({ args, repoFlag, json: args.booleans.has("json"), io, seams: defaultSeams() });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

describe("nen board build/render/diff", () => {
  it("builds a board from a rows file and renders a padded table", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const rows = join(dir, "rows.json");
    writeFileSync(rows, JSON.stringify([{ id: "1", title: "t", refs: [], gate: "G2", status: "🟢 ready", needs: null }]));
    const result = capture(["board", "build", "--repo-slug", "o/r", "--rows-from", rows], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/G2/);
  });

  it("diffs two board snapshots", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify({ repo: "o/r", generatedAt: "t", rows: [{ id: "1", title: "t", refs: [], gate: null, status: "a", needs: null }] }));
    writeFileSync(after, JSON.stringify({ repo: "o/r", generatedAt: "t", rows: [{ id: "1", title: "t", refs: [], gate: null, status: "b", needs: null }] }));
    const result = capture(["board", "diff", "--before", before, "--after", after], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/changed\s+1:/);
  });
});
