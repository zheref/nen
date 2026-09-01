import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "../seam/scripted.js";
import type { Target } from "../github/target.js";
import { rerunFailed, rerunFailedArgv } from "./rerun.js";

const TARGET: Target = { owner: "zheref", repo: "KroApple", slug: "zheref/KroApple" };

describe("rerunFailedArgv", () => {
  it("builds 'gh run rerun <id> --repo <slug> --failed' exactly", () => {
    expect(rerunFailedArgv(TARGET, 42)).toEqual(["run", "rerun", "42", "--repo", "zheref/KroApple", "--failed"]);
  });
});

describe("rerunFailed", () => {
  it("reports success reading gh's exit code", () => {
    const seams = new ScriptedSeams([{ match: `gh ${rerunFailedArgv(TARGET, 42).join(" ")}`, result: {} }]);
    expect(rerunFailed(seams, TARGET, 42).ok).toBe(true);
  });

  it("carries gh's failure through", () => {
    const seams = new ScriptedSeams([
      { match: `gh ${rerunFailedArgv(TARGET, 42).join(" ")}`, result: { code: 1, stderr: "no such run" } },
    ]);
    const result = rerunFailed(seams, TARGET, 42);
    expect(result.ok).toBe(false);
    expect(result.message).toMatch(/no such run/);
  });
});
