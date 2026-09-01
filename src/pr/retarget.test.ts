import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { retarget, retargetArgv } from "./retarget.js";

const TARGET: Target = { owner: "zheref", repo: "nen", slug: "zheref/nen" };

describe("retarget -- gh pr edit --base, the one documented command", () => {
  it("builds the argv exactly", () => {
    expect(retargetArgv(TARGET, 12, "release/1.0")).toEqual([
      "pr",
      "edit",
      "12",
      "--repo",
      "zheref/nen",
      "--base",
      "release/1.0",
    ]);
  });

  it("reports success reading gh's own exit code", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${retargetArgv(TARGET, 12, "release/1.0").join(" ")}`, result: {} },
    ]);
    const result = retarget(seams, TARGET, 12, "release/1.0");
    expect(result.ok).toBe(true);
    expect(result.message).toMatch(/now targets 'release\/1\.0'/);
  });

  it("carries gh's failure through rather than claiming success", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${retargetArgv(TARGET, 12, "release/1.0").join(" ")}`, result: { code: 1, stderr: "no such branch" } },
    ]);
    const result = retarget(seams, TARGET, 12, "release/1.0");
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no such branch/);
  });
});
