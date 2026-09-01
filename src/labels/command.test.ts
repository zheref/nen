import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { labelsCommand } from "./command.js";
import { listLabelNamesArgv, renameArgv } from "./rename.js";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
): Promise<{ code: number; out: string[]; err: string[]; seams: ScriptedSeams }> {
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
  const code = await runFamily(labelsCommand, argv, BANKAI_REPO, false, io, seams);
  return { code, out, err, seams: scripted };
}

describe("nen labels sync -- CLI wiring", () => {
  it("dry-run reports every label without calling gh", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.length).toBeGreaterThan(0);
    expect(result.seams.calls).toEqual([]);
  });

  it("requires --target", async () => {
    expect((await capture(["labels", "sync"])).code).toBe(1);
  });
});

describe("nen labels rename -- CLI wiring", () => {
  const TARGET = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

  it("renames per --map and exits 0 on success", async () => {
    const result = await capture(["labels", "rename", "--target", "zheref/nen", "--map", "old=new"], [
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: { stdout: JSON.stringify([{ name: "old" }]) } },
      { match: `gh ${renameArgv(TARGET, { from: "old", to: "new" }).join(" ")}`, result: {} },
    ]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/renamed/);
  });

  it("requires --map", async () => {
    const result = await capture(["labels", "rename", "--target", "zheref/nen"]);
    expect(result.code).toBe(2);
  });

  it("exits 1 when a mapping fails", async () => {
    const result = await capture(["labels", "rename", "--target", "zheref/nen", "--map", "old=new"], [
      { match: `gh ${listLabelNamesArgv(TARGET).join(" ")}`, result: { stdout: "[]" } },
    ]);
    expect(result.code).toBe(1);
  });
});

describe("nen labels -- refuses an unknown subcommand", () => {
  it("exits 2", async () => {
    expect((await capture(["labels", "bogus"])).code).toBe(2);
  });
});
