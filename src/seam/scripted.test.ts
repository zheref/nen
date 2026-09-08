import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "./scripted.js";

describe("ScriptedSeams", () => {
  it("answers a matching call", () => {
    const seams = new ScriptedSeams([{ match: "git status", result: { stdout: "clean\n" } }]);
    expect(seams.run("git", ["status"])).toEqual({ code: 0, stdout: "clean\n", stderr: "", spawnFailed: false });
    expect(seams.calls).toEqual([{ command: "git", args: ["status"], interactive: false }]);
  });

  it("throws loudly on an unscripted call rather than answering empty", () => {
    const seams = new ScriptedSeams([]);
    expect(() => seams.run("gh", ["pr", "list"])).toThrow(/unscripted subprocess: 'gh pr list'/);
  });

  // The interactive half is scripted from the SAME table, and the recorded call
  // says which seam took it -- so a test can prove `nen shu dev` went through
  // the long-running runner and `nen shu build` did not. Without the flag the
  // two are indistinguishable in `calls`, which is the whole distinction
  // ../seam/exec.ts's header draws.
  it("records an interactive call as interactive, and answers it from the same script", () => {
    const seams = new ScriptedSeams([{ match: "tool serve", result: { code: 0 } }]);
    expect(seams.runInteractive("tool", ["serve"])).toEqual({
      code: 0,
      signal: null,
      spawnFailed: false,
    });
    expect(seams.calls).toEqual([{ command: "tool", args: ["serve"], interactive: true }]);
  });

  it("throws on an unscripted interactive call, naming which seam it was", () => {
    const seams = new ScriptedSeams([]);
    expect(() => seams.runInteractive("tool", ["serve"])).toThrow(
      /unscripted interactive subprocess: 'tool serve'/,
    );
  });

  // stdout/stderr in a script entry are DELIBERATELY not returned by the
  // interactive runner: an interactive child's output went to the terminal, and
  // a stub that handed it back would let a verb be written against output the
  // real seam can never give it.
  it("never hands back captured output from the interactive runner", () => {
    const seams = new ScriptedSeams([
      { match: "tool serve", result: { code: 3, stdout: "never seen", stderr: "nor this" } },
    ]);
    expect(seams.runInteractive("tool", ["serve"])).toEqual({
      code: 3,
      signal: null,
      spawnFailed: false,
    });
  });

  it("reports the real host platform unless a test states one", () => {
    expect(new ScriptedSeams([]).platform).toBe(process.platform);
    expect(new ScriptedSeams([], { platform: "win32" }).platform).toBe("win32");
  });
});
