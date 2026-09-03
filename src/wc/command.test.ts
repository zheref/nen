import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { wcCommand } from "./command.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
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
  const scripted = new ScriptedSeams(script);
  const seams: Seams = scripted;
  const code = await runFamily(wcCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen wc classify -- CLI wiring", () => {
  it("reports must-move for a dirty trunk", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/case: must-move/);
  });

  it("always exits 0 -- a report, not a guard", async () => {
    const result = await capture(["wc", "classify"], [
      { match: "git symbolic-ref --short HEAD", result: { stdout: "main\n" } },
      { match: "git status --porcelain=v1 -uall", result: { stdout: " M x.ts\n" } },
    ]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- never silently read as "classify the process's cwd".
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["wc", "classify"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["wc", "bogus"])).code).toBe(2);
  });
});
