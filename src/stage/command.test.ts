import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { stageCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
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
  const seams: Seams = new ScriptedSeams(script);
  const code = await runFamily(stageCommand, argv, BANKAI_REPO, false, io, seams);
  return { code, out, err };
}

describe("nen stage triage -- CLI wiring", () => {
  it("exits 0 when nothing is flagged", async () => {
    const result = await capture(["stage", "triage"], [
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/a.ts\0" } },
    ]);
    expect(result.code).toBe(0);
  });

  it("exits 1 and lists the reason(s) when something is flagged", async () => {
    const result = await capture(["stage", "triage"], [
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: "?? .env\0" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("passes --scope and --mentions through to the triage", async () => {
    const result = await capture(
      ["stage", "triage", "--scope", "src/", "--mentions", "renames src/old.ts"],
      [{ match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/old.ts\0" } }],
    );
    expect(result.code).toBe(0);
  });

  it("flags a real secret file even at a non-ASCII path (BLOCKER #3)", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: "?? secrëts/.env\0" },
      },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/secrëts\/\.env {2}\[secret-shape\]/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["stage", "bogus"])).code).toBe(2);
  });
});
