import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "./scripted.js";

describe("ScriptedSeams", () => {
  it("answers a matching call", () => {
    const seams = new ScriptedSeams([{ match: "git status", result: { stdout: "clean\n" } }]);
    expect(seams.run("git", ["status"])).toEqual({ code: 0, stdout: "clean\n", stderr: "", spawnFailed: false });
    expect(seams.calls).toEqual([{ command: "git", args: ["status"] }]);
  });

  it("throws loudly on an unscripted call rather than answering empty", () => {
    const seams = new ScriptedSeams([]);
    expect(() => seams.run("gh", ["pr", "list"])).toThrow(/unscripted subprocess: 'gh pr list'/);
  });
});
