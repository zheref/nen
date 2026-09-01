import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { boardCommand } from "./command.js";

// NEVER `defaultSeams()` HERE (review finding, src/seam/exec.ts's own header:
// "NO SHIPPED VERB IMPORTS `node:child_process`, and no test in this
// repository makes a network call"). None of board's covered paths spawns
// today, but that safety was incidental rather than structural -- the day
// this verb grows a `gh` call, `defaultSeams()` would silently start issuing
// real subprocess calls from this test rather than failing red. A `run` that
// throws converts that future regression into an immediate, loud test
// failure instead (mirrors src/repo/resolve.test.ts:84).
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding: several family test files
// re-implemented that mapping locally, which can silently drift from the
// real one).
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
  const code = runFamily(boardCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
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
