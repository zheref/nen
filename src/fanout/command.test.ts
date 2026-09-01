import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { fanoutCommand } from "./command.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(argv: readonly string[], run: Seams["run"]): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  const code = await runFamily(fanoutCommand, argv, BANKAI_REPO, false, io, seams);
  return { code, out, err };
}

const runner: Seams["run"] = (): CommandResult => ({
  code: 0,
  stdout: ".github/workflows/sasuke-review.yml\n",
  stderr: "",
  spawnFailed: false,
});

describe("nen fanout compute", () => {
  it("marks consumers of the changed workflow affected, and every other consumer an explicit n/a", async () => {
    const result = await capture(["fanout", "compute", "--range", "v1..v2"], runner);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/AFFECTED\s+zheref\/KroApple/);
    expect(result.out.join("\n")).toMatch(/AFFECTED\s+zheref\/bankai-scaffold/);
  });
});

describe("nen fanout record", () => {
  it("appends one ledger line per consumer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fanout-"));
    const ledger = join(dir, "l.jsonl");
    const result = await capture(["fanout", "record", "--range", "v1..v2", "--ledger", ledger], runner);
    expect(result.code).toBe(0);
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3); // three consumers in the fixture
  });
});
