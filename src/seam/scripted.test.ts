import { describe, expect, it } from "vitest";
import { ScriptedSeams } from "./scripted.js";

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

  // ── the watched seam, on a clock the test owns ────────────────────────────
  //
  // THE POINT OF THE TIMELINE IS THAT NOTHING SLEEPS. A three-minute budget and
  // a one-minute quiet window are two numbers; replaying them costs no
  // milliseconds, and a stall guard proved this way is proved against the same
  // `outputWindow` the real runner uses rather than against a fixture's own
  // opinion of what "quiet" means.
  describe("runStreamed", () => {
    it("replays chunks with their instants and answers the scripted code", async () => {
      const seams = new ScriptedSeams([
        {
          match: "tool build",
          result: {
            code: 0,
            stream: {
              events: [
                { atMs: 10, stream: "stdout", text: "compiling\n" },
                { atMs: 20, stream: "stderr", text: "a warning\n" },
              ],
              exitAtMs: 30,
            },
          },
        },
      ]);
      const seen: string[] = [];
      const result = await seams.runStreamed("tool", ["build"], {
        onOutput: (chunk): void => void seen.push(`${chunk.atMs}:${chunk.stream}:${chunk.text.trim()}`),
      });
      expect(seen).toEqual(["10:stdout:compiling", "20:stderr:a warning"]);
      expect(result).toEqual({
        code: 0,
        signal: null,
        spawnFailed: false,
        abandoned: false,
        durationMs: 30,
      });
      expect(seams.calls).toEqual([
        {
          command: "tool",
          args: ["build"],
          interactive: false,
          streamed: true,
          cwd: null,
          env: null,
        },
      ]);
    });

    it("computes elapsed and quiet from the timeline, and honours 'reset'", async () => {
      const seams = new ScriptedSeams([
        {
          match: "tool build",
          result: {
            code: 0,
            stream: {
              events: [
                { atMs: 100, stream: "stdout", text: "a line\n" },
                { atMs: 200 },
                { atMs: 400 },
                { atMs: 500 },
              ],
            },
          },
        },
      ]);
      const windows: string[] = [];
      await seams.runStreamed("tool", ["build"], {
        onWindow: (window): "watch" | "reset" => {
          windows.push(`${window.elapsedMs}/${window.quietMs}`);
          // The second tick answers `reset`, so the third measures its quiet
          // from THAT tick rather than from the last real output.
          return windows.length === 2 ? "reset" : "watch";
        },
      });
      expect(windows).toEqual(["200/100", "400/300", "500/100"]);
    });

    it("stops consulting after 'stop' but plays the child out", async () => {
      const seams = new ScriptedSeams([
        {
          match: "tool build",
          result: { code: 7, stream: { events: [{ atMs: 10 }, { atMs: 20 }], exitAtMs: 50 } },
        },
      ]);
      let asked = 0;
      const result = await seams.runStreamed("tool", ["build"], {
        onWindow: (): "stop" => {
          asked += 1;
          return "stop";
        },
      });
      expect(asked).toBe(1);
      expect(result.code).toBe(7);
      expect(result.abandoned).toBe(false);
    });

    it("stops the timeline dead on 'abandon', with no code to report", async () => {
      const seams = new ScriptedSeams([
        {
          match: "tool build",
          result: { code: 0, stream: { events: [{ atMs: 10 }, { atMs: 999 }], exitAtMs: 1000 } },
        },
      ]);
      const result = await seams.runStreamed("tool", ["build"], {
        onWindow: (): "abandon" => "abandon",
      });
      expect(result).toEqual({
        code: null,
        signal: null,
        spawnFailed: false,
        abandoned: true,
        durationMs: 10,
      });
    });

    it("answers an entry with no timeline as one chunk and an immediate exit", async () => {
      const seams = new ScriptedSeams([
        { match: "tool build", result: { code: 0, stdout: "done\n" } },
      ]);
      const seen: string[] = [];
      const result = await seams.runStreamed("tool", ["build"], {
        onOutput: (chunk): void => void seen.push(chunk.text),
      });
      expect(seen).toEqual(["done\n"]);
      expect(result.durationMs).toBe(0);
    });

    it("throws on an unscripted watched call, naming which seam it was", async () => {
      const seams = new ScriptedSeams([]);
      await expect(seams.runStreamed("tool", ["build"])).rejects.toThrow(
        /unscripted streamed subprocess: 'tool build'/,
      );
    });
  });
});
