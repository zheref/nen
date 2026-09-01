import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { fanoutCommand } from "./command.js";

function capture(argv: readonly string[], run: Seams["run"]): { code: number; out: string[]; err: string[] } {
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
  const args = parseArgs(argv, mergeFlags(fanoutCommand.flags));
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  try {
    const code = fanoutCommand.run({ args, repoFlag: BANKAI_REPO, json: args.booleans.has("json"), io, seams });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

const runner: Seams["run"] = (): CommandResult => ({
  code: 0,
  stdout: ".github/workflows/sasuke-review.yml\n",
  stderr: "",
  spawnFailed: false,
});

describe("nen fanout compute", () => {
  it("marks consumers of the changed workflow affected, and every other consumer an explicit n/a", () => {
    const result = capture(["fanout", "compute", "--range", "v1..v2"], runner);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/AFFECTED\s+zheref\/KroApple/);
    expect(result.out.join("\n")).toMatch(/AFFECTED\s+zheref\/bankai-scaffold/);
  });
});

describe("nen fanout record", () => {
  it("appends one ledger line per consumer", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-fanout-"));
    const ledger = join(dir, "l.jsonl");
    const result = capture(["fanout", "record", "--range", "v1..v2", "--ledger", ledger], runner);
    expect(result.code).toBe(0);
    const lines = readFileSync(ledger, "utf8").trim().split("\n");
    expect(lines).toHaveLength(3); // three consumers in the fixture
  });
});
