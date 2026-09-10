import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { labelCommand } from "./command.js";
import { parseLedger } from "./ledger.js";
import { noPortProbe } from "../seam/scripted.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding: a hand-copy can silently drift
// from the real one). This also exercises the real re-parse against
// `mergeFlags(family.flags)`.
async function capture(argv: readonly string[], run: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false })): Promise<{
  code: number;
  out: string[];
  err: string[];
}> {
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
  const seams: Seams = {
    run,
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("this verb has no watched form");
    },
    platform: "linux",
  };
  const code = await runFamily(labelCommand, argv, BANKAI_REPO, false, io, seams);
  return { code, out, err };
}

describe("nen label apply", () => {
  it("is a dry run by default: writes a ledger line with outcome:dry-run and no gh call", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    let calls = 0;
    const result = await capture(
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
    expect(parsed.entries[0]).toMatchObject({ object: "XX-PR-#12", label: "bankai:stage/idea", outcome: "dry-run" });
  });

  it("--run applies the label via gh and logs outcome:applied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    const calls: string[][] = [];
    const result = await capture(
      ["label", "apply", "XX-PR-#12", "--label", "bankai:stage/idea", "--repo-slug", "o/r", "--ledger", ledger, "--run"],
      (command, args): CommandResult => {
        calls.push([command, ...args]);
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(0);
    expect(calls).toEqual([["gh", "pr", "edit", "12", "--repo", "o/r", "--add-label", "bankai:stage/idea"]]);
    const parsed = parseLedger(readFileSync(ledger, "utf8"));
    expect(parsed.entries[0]?.outcome).toBe("applied");
  });

  it("a REFUSED mutation logs outcome:failed, never a false 'applied' claim (review finding)", async () => {
    // Reproduces the review's exact scenario: gh refuses the label (404) and
    // the process must exit non-zero WHILE the ledger records what actually
    // happened, not what was attempted.
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    const result = await capture(
      ["label", "apply", "XX-PR-#12", "--label", "bankai:stage/idea", "--repo-slug", "o/r", "--ledger", ledger, "--run"],
      (): CommandResult => ({ code: 1, stdout: "", stderr: "HTTP 404: not found", spawnFailed: false }),
    );
    expect(result.code).toBe(1);
    const parsed = parseLedger(readFileSync(ledger, "utf8"));
    expect(parsed.entries).toHaveLength(1);
    expect(parsed.entries[0]).toMatchObject({ object: "XX-PR-#12", label: "bankai:stage/idea", outcome: "failed" });
  });

  it("refuses a label the target taxonomy does not declare", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-label-"));
    const ledger = join(dir, "l.jsonl");
    const result = await capture([
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

  it("refuses a malformed object ref at exit 2, and keeps parseRef's message whole", async () => {
    // EXIT 2, NOT 1 (zheref/nen#10 item 3). `label apply not-a-ref` is a typo
    // in a positional, and ../index.ts's header is explicit about the split:
    // exit 1 says "the thing you asked for did not work" when the truth is
    // "you typed it wrong", and a retry wrapper honouring the distinction
    // would retry a typo forever. RefError is converted at the command
    // boundary by ../cli/command.ts's parseCallerToken; the message it carries
    // is parseRef's own, because that text is what tells the caller the form.
    const result = await capture(["label", "apply", "not-a-ref", "--label", "bankai:stage/idea", "--repo-slug", "o/r"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is not object notation/);
    expect(result.err.join("\n")).toMatch(/<CODE>-<IS\|PR>-#<N>/);
    // The exit-2 path also earns the "Run --help" line a usage error gets.
    expect(result.err.join("\n")).toMatch(/Run 'nen label --help'/);
  });
});
