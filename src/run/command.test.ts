import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { runCommand } from "./command.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping -- see ../label/command.test.ts's header for why.
async function capture(
  argv: readonly string[],
  runFn: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "", stderr: "", spawnFailed: false }),
): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = { run: runFn, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  const code = await runFamily(runCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen run rerun-failed -- CLI wiring", () => {
  it("re-runs the failed jobs of a target run", async () => {
    const result = await capture(
      ["run", "rerun-failed", "--target", "zheref/KroApple", "--run-id", "42"],
      (command, args): CommandResult => {
        expect(command).toBe("gh");
        expect(args).toEqual(["run", "rerun", "42", "--repo", "zheref/KroApple", "--failed"]);
        return { code: 0, stdout: "", stderr: "", spawnFailed: false };
      },
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/re-ran the failed job/);
  });

  it("requires --target and --run-id", async () => {
    expect((await capture(["run", "rerun-failed"])).code).toBe(2);
    expect((await capture(["run", "rerun-failed", "--target", "o/n"])).code).toBe(2);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["run", "bogus"])).code).toBe(2);
  });
});
