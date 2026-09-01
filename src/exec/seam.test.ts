import { describe, expect, it } from "vitest";
import { defaultRunner, lines, ScriptedRunner, stdoutLines } from "./seam.js";

describe("lines -- CRLF normalization at the one seam", () => {
  it("splits on LF after normalizing CRLF", () => {
    expect(lines("a\r\nb\nc")).toEqual(["a", "b", "c"]);
  });

  it("drops empty lines", () => {
    expect(lines("a\n\nb\n")).toEqual(["a", "b"]);
  });

  it("returns an empty array for empty input", () => {
    expect(lines("")).toEqual([]);
  });
});

describe("stdoutLines", () => {
  it("reads lines off a RunResult's stdout", () => {
    expect(stdoutLines({ code: 0, stdout: "x\r\ny\n", stderr: "", spawnError: null })).toEqual([
      "x",
      "y",
    ]);
  });
});

describe("ScriptedRunner -- an unscripted call throws rather than answering empty", () => {
  it("returns the scripted result for an exact bin+argv match", () => {
    const runner = new ScriptedRunner([
      { match: "git status", result: { stdout: "clean\n" } },
    ]);
    const result = runner.run({ bin: "git", args: ["status"] });
    expect(result.stdout).toBe("clean\n");
    expect(result.code).toBe(0);
  });

  it("records every call it received, in order", () => {
    const runner = new ScriptedRunner([
      { match: "git status", result: {} },
      { match: "git diff", result: {} },
    ]);
    runner.run({ bin: "git", args: ["status"] });
    runner.run({ bin: "git", args: ["diff"] });
    expect(runner.calls.map((c): string => `${c.bin} ${c.args.join(" ")}`)).toEqual([
      "git status",
      "git diff",
    ]);
  });

  it("throws, loudly, on a call nobody scripted -- never answers empty", () => {
    const runner = new ScriptedRunner([]);
    expect(() => runner.run({ bin: "git", args: ["status"] })).toThrow(/unscripted subprocess/);
  });

  it("defaults an unset field of a scripted result to its safe value", () => {
    const runner = new ScriptedRunner([{ match: "gh issue list", result: {} }]);
    const result = runner.run({ bin: "gh", args: ["issue", "list"] });
    expect(result).toEqual({ code: 0, stdout: "", stderr: "", spawnError: null });
  });
});

describe("defaultRunner", () => {
  it("is a real Runner backed by spawnSync", () => {
    const result = defaultRunner.run({ bin: "node", args: ["-e", "console.log('hi'); process.exit(0)"] });
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
  });

  it("reports a missing binary as a spawnError rather than throwing", () => {
    const result = defaultRunner.run({ bin: "definitely-not-a-real-binary-xyz", args: [] });
    expect(result.spawnError).not.toBeNull();
    expect(result.code).toBe(127);
  });
});
