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
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
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
  const code = await runFamily(labelsCommand, argv, repoFlag, false, io, seams);
  return { code, out, err, seams: scripted };
}

describe("nen labels sync -- CLI wiring", () => {
  it("dry-run reports every label without calling gh", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen", "--dry-run"]);
    expect(result.code).toBe(0);
    expect(result.out.length).toBeGreaterThan(0);
    expect(result.seams.calls).toEqual([]);
  });

  // zheref/nen#93: EXIT 2, not 1. Four families each kept a private
  // `requireTarget` that threw a plain Error, so sixteen verbs answered a
  // forgotten flag with "the thing you asked for did not work" instead of "you
  // typed it wrong" -- and a retry wrapper honouring that distinction retries a
  // 1 forever. One shared `requireTargetFlag` now answers for all of them, the
  // way every OTHER required flag in these same families already did.
  it("requires --target, as a USAGE error", async () => {
    const result = await capture(["labels", "sync"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--target owner\/name is required/);
  });

  // zheref/nen#28: sync's usage line lists --repo unbracketed, so omitting it
  // is refused by name -- a sync that read the cwd's taxonomy would push THAT
  // repository's labels at --target.
  it("sync refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["labels", "sync", "--target", "zheref/nen"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
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
