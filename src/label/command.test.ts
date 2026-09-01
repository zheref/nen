import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { UsageError } from "../cli/args.js";
import { labelCommand } from "./command.js";
import { parseLedger } from "./ledger.js";

// Mirrors ../index.ts's own runFamily() error-to-exit-code mapping, so a test
// calling a family's run() directly (rather than through the whole CLI
// dispatch) still sees the SAME contract a real invocation would.
function capture(argv: readonly string[], run: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false })): {
  code: number;
  out: string[];
  err: string[];
} {
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
  const args = parseArgs(argv, mergeFlags(labelCommand.flags));
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  try {
    const code = labelCommand.run({ args, repoFlag: BANKAI_REPO, json: args.booleans.has("json"), io, seams });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

describe("nen label apply", () => {
  it("is a dry run by default: writes a ledger line with run:false and no gh call", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    let calls = 0;
    const result = capture(
      ["label", "apply", "XX-PR-#12", "--label", "bankai:stage/idea", "--repo-slug", "o/r", "--ledger", ledger],
      (): CommandResult => {
        calls += 1;
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(0);
    expect(calls).toBe(0);
    const parsed = parseLedger(readFileSync(ledger, "utf8"));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ object: "XX-PR-#12", label: "bankai:stage/idea", run: false });
  });

  it("--run applies the label via gh and logs run:true", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    const calls: string[][] = [];
    const result = capture(
      ["label", "apply", "XX-PR-#12", "--label", "bankai:stage/idea", "--repo-slug", "o/r", "--ledger", ledger, "--run"],
      (command, args): CommandResult => {
        calls.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(0);
    expect(calls).toEqual([["gh", "pr", "edit", "12", "--repo", "o/r", "--add-label", "bankai:stage/idea"]]);
    const parsed = parseLedger(readFileSync(ledger, "utf8"));
    expect(parsed.entries[0]?.run).toBe(true);
  });

  it("refuses a label the target taxonomy does not declare", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    const result = capture([
      "label",
      "apply",
      "XX-PR-#12",
      "--label",
      "no-such-label",
      "--repo-slug",
      "o/r",
      "--ledger",
      ledger,
    ]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is not in/);
  });

  it("refuses a malformed object ref", () => {
    // RefError is not a VerbUsageError -- like GateError/ColorError elsewhere
    // in this codebase, a malformed-input domain error exits 1, not 2.
    const result = capture(["label", "apply", "not-a-ref", "--label", "bankai:stage/idea", "--repo-slug", "o/r"]);
    expect(result.code).toBe(1);
  });
});
