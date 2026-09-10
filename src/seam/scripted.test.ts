import { describe, expect, it } from "vitest";
import { noPortProbe, ScriptedSeams } from "./scripted.js";

describe("ScriptedSeams", () => {
  it("answers a matching call", () => {
    const seams = new ScriptedSeams([{ match: "git status", result: { stdout: "clean\n" } }]);
    expect(seams.run("git", ["status"])).toEqual({ code: 0, stdout: "clean\n", stderr: "", spawnFailed: false });
    expect(seams.calls).toEqual([
      { command: "git", args: ["status"], interactive: false, cwd: null, env: null },
    ]);
  });

  // `find` keys on the command plus its argv, so `cwd` and `env` are invisible
  // to the script -- which is exactly why they are RECORDED. A verb that
  // resolved a lane's directory against the wrong root, or dropped a declared
  // environment on the floor, produced a call this seam answered happily and no
  // test could see.
  it("records the cwd and the env the caller asked for, which the script cannot match on", () => {
    const seams = new ScriptedSeams([{ match: "tool go", result: { code: 0 } }]);
    seams.run("tool", ["go"], { cwd: "/somewhere/lane", env: { PORT: "4173" } });
    seams.runInteractive("tool", ["go"], { cwd: "/somewhere/else" });
    expect(seams.calls).toEqual([
      {
        command: "tool",
        args: ["go"],
        interactive: false,
        cwd: "/somewhere/lane",
        env: { PORT: "4173" },
      },
      { command: "tool", args: ["go"], interactive: true, cwd: "/somewhere/else", env: null },
    ]);
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
    expect(seams.calls).toEqual([
      { command: "tool", args: ["serve"], interactive: true, cwd: null, env: null },
    ]);
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

  // The one thing a single-answer table could not express: a verb that reads
  // something, changes it, and reads it AGAIN to check what it changed. `nen shu
  // warmup --discard` does exactly that, and the point of its second `git
  // status` is that the answer is allowed to differ from the first.
  it("answers duplicate entries for one command line in order, repeating the last", () => {
    const seams = new ScriptedSeams([
      { match: "git status", result: { stdout: "dirty\n" } },
      { match: "git status", result: { stdout: "clean\n" } },
    ]);
    expect(seams.run("git", ["status"]).stdout).toBe("dirty\n");
    expect(seams.run("git", ["status"]).stdout).toBe("clean\n");
    expect(seams.run("git", ["status"]).stdout).toBe("clean\n");
  });

  it("still answers a single entry with the same result every time", () => {
    const seams = new ScriptedSeams([{ match: "git status", result: { stdout: "same\n" } }]);
    expect(seams.run("git", ["status"]).stdout).toBe("same\n");
    expect(seams.run("git", ["status"]).stdout).toBe("same\n");
  });

  it("reports the real host platform unless a test states one", () => {
    expect(new ScriptedSeams([]).platform).toBe(process.platform);
    expect(new ScriptedSeams([], { platform: "win32" }).platform).toBe("win32");
  });
});

describe("the recorded port probe", () => {
  it("answers from the table, and records every port it was asked about", async () => {
    const seams = new ScriptedSeams([], { ports: { 3000: "open", 5173: "refused", 9999: "timeout" } });
    expect(await seams.probePort(3000)).toBe("open");
    expect(await seams.probePort(5173)).toBe("refused");
    expect(await seams.probePort(9999)).toBe("timeout");
    expect(seams.probedPorts).toEqual([3000, 5173, 9999]);
  });

  it("THROWS on a port nobody scripted, exactly as an unscripted call does", async () => {
    // A verb that reached for the network without a fixture saying so is the
    // finding; a stub that quietly answered `refused` would hide it, and the
    // test's verdict would then depend on what the host is listening on.
    const seams = new ScriptedSeams([]);
    await expect(seams.probePort(3000)).rejects.toThrow(/unscripted port probe: 127\.0\.0\.1:3000/);
    // It is still RECORDED, so a failure names what was asked for.
    expect(seams.probedPorts).toEqual([3000]);
  });

  it("opens no socket: an empty table is not a fall-through to the real seam", async () => {
    const seams = new ScriptedSeams([], { ports: { 1: "refused" } });
    expect(await seams.probePort(1)).toBe("refused");
  });
});

describe("noPortProbe -- the stub every other family's Seams carries", () => {
  it("refuses by name rather than answering", () => {
    expect(() => noPortProbe(8080)).toThrow(/this family never probes a port/);
    expect(() => noPortProbe(8080)).toThrow(/127\.0\.0\.1:8080/);
  });
});
