// src/seam/exec.test.ts -- this seam had NO test at HEAD (the branch's
// original src/exec/seam.ts carried the two `defaultRunner` cases below, but
// the convergence merge (43f09f1) deleted src/exec/seam.ts/.test.ts and main
// never shipped an equivalent src/seam/exec.test.ts). That gap is exactly how
// the failure-to-start SHAPE could change underneath every caller -- old:
// `{ code: 127, spawnError }`, new: `{ code: -1, spawnFailed: true }` --
// without a single red test. This file pins the new shape so a future change
// to it is a deliberate, visible decision rather than a silent one.

import { describe, expect, it } from "vitest";
import {
  defaultSeams,
  must,
  mustJson,
  normalizeEol,
  outputLines,
  spawnRunner,
  ToolError,
  type Seams,
} from "./exec.js";

/** A real-spawn Seams (no scripting) for the `must`/`mustJson` tests below. */
function realSeams(): Seams {
  return { run: spawnRunner, now: (): Date => new Date(), env: {} };
}

describe("normalizeEol", () => {
  it("collapses CRLF to LF", () => {
    expect(normalizeEol("a\r\nb\r\nc")).toBe("a\nb\nc");
  });

  it("leaves bare LF untouched", () => {
    expect(normalizeEol("a\nb\n")).toBe("a\nb\n");
  });
});

describe("outputLines", () => {
  it("splits, trims, normalizes CRLF, and drops empty lines", () => {
    expect(outputLines("  a  \r\n\r\nb\n  \n")).toEqual(["a", "b"]);
  });

  it("returns an empty array for empty input", () => {
    expect(outputLines("")).toEqual([]);
  });
});

describe("spawnRunner -- the real Runner backing production Seams", () => {
  // Ported from the branch's original src/exec/seam.test.ts
  // ("defaultRunner -- is a real Runner backed by spawnSync").
  it("is a real Runner backed by spawnSync", () => {
    const result = spawnRunner(process.execPath, ["-e", "console.log('hi'); process.exit(0)"]);
    expect(result.spawnFailed).toBe(false);
    expect(result.code).toBe(0);
    expect(result.stdout.trim()).toBe("hi");
  });

  it("carries a non-zero exit code through without treating it as a spawn failure", () => {
    const result = spawnRunner(process.execPath, ["-e", "process.exit(3)"]);
    expect(result.spawnFailed).toBe(false);
    expect(result.code).toBe(3);
  });

  // Ported from the branch's original src/exec/seam.test.ts
  // ("defaultRunner -- reports a missing binary as a spawnError rather than
  // throwing"). THE SHAPE CHANGED IN THE CONVERGENCE: the old defaultRunner
  // reported `{ code: 127, spawnError: <msg> }`; spawnRunner reports
  // `{ code: -1, spawnFailed: true }`. This is the exact CommandResult that
  // every "could not start git" caller (src/release/target.ts,
  // src/release/selfcheck.ts, src/tag/cut.ts, and the seam's own `must`
  // below) must recognize as a refusal, not a verdict.
  it("reports a missing binary as spawnFailed with code -1, rather than throwing", () => {
    const result = spawnRunner("definitely-not-a-real-binary-xyz", []);
    expect(result.spawnFailed).toBe(true);
    expect(result.code).toBe(-1);
    expect(result.stdout).toBe("");
    expect(result.stderr).not.toBe("");
  });

  it("normalizes CRLF in stdout/stderr the same way outputLines expects", () => {
    const result = spawnRunner(process.execPath, [
      "-e",
      "process.stdout.write('a\\r\\nb\\r\\n'); process.exit(0)",
    ]);
    expect(result.stdout).toBe("a\nb\n");
  });
});

describe("defaultSeams", () => {
  it("wires spawnRunner as its Runner, a real clock, and the real env", () => {
    const seams = defaultSeams();
    expect(seams.run).toBe(spawnRunner);
    expect(seams.now()).toBeInstanceOf(Date);
    expect(seams.env).toBe(process.env);
  });
});

describe("must -- throws ToolError unless the tool exited 0", () => {
  it("returns the result on a clean exit", () => {
    const result = must(realSeams(), process.execPath, [
      "-e",
      "console.log('ok'); process.exit(0)",
    ]);
    expect(result.stdout.trim()).toBe("ok");
  });

  it("throws ToolError, not a silent result, when the binary never starts", () => {
    const seams = realSeams();
    expect(() => must(seams, "definitely-not-a-real-binary-xyz", [])).toThrow(ToolError);
    try {
      must(seams, "definitely-not-a-real-binary-xyz", []);
      throw new Error("must() did not throw");
    } catch (error) {
      expect(error).toBeInstanceOf(ToolError);
      const toolError = error as ToolError;
      expect(toolError.result.spawnFailed).toBe(true);
      expect(toolError.message).toMatch(/could not be started/);
    }
  });

  it("throws ToolError on a non-zero exit even though spawn succeeded", () => {
    const seams = realSeams();
    expect(() => must(seams, process.execPath, ["-e", "process.exit(2)"])).toThrow(ToolError);
  });
});

describe("mustJson -- parses stdout as JSON after must()'s check", () => {
  it("parses valid JSON", () => {
    const seams = realSeams();
    const value = mustJson<{ ok: boolean }>(seams, process.execPath, [
      "-e",
      "console.log(JSON.stringify({ ok: true }))",
    ]);
    expect(value).toEqual({ ok: true });
  });

  it("throws ToolError, not a parse crash, when stdout is not JSON", () => {
    const seams = realSeams();
    expect(() =>
      mustJson(seams, process.execPath, ["-e", "console.log('not json')"]),
    ).toThrow(ToolError);
  });
});
