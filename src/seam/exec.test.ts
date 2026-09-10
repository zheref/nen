// src/seam/exec.test.ts -- this seam had NO test at HEAD (the branch's
// original src/exec/seam.ts carried the two `defaultRunner` cases below, but
// the convergence merge (43f09f1) deleted src/exec/seam.ts/.test.ts and main
// never shipped an equivalent src/seam/exec.test.ts). That gap is exactly how
// the failure-to-start SHAPE could change underneath every caller -- old:
// `{ code: 127, spawnError }`, new: `{ code: -1, spawnFailed: true }` --
// without a single red test. This file pins the new shape so a future change
// to it is a deliberate, visible decision rather than a silent one.

import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { constants as osConstants, tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultSeams,
  must,
  mustJson,
  normalizeEol,
  outputLines,
  outputWindow,
  spawnInteractiveRunner,
  spawnRunner,
  spawnStreamedRunner,
  ToolError,
  type OutputWindow,
  type Seams,
  type StreamedChunk,
} from "./exec.js";

/** A real-spawn Seams (no scripting) for the `must`/`mustJson` tests below. */
function realSeams(): Seams {
  return {
    run: spawnRunner,
    runInteractive: spawnInteractiveRunner,
    runStreamed: spawnStreamedRunner,
    now: (): Date => new Date(),
    env: {},
    platform: process.platform,
  };
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

  it("wires the interactive runner and the real host platform", () => {
    const seams = defaultSeams();
    expect(seams.runInteractive).toBe(spawnInteractiveRunner);
    expect(seams.platform).toBe(process.platform);
  });

  it("wires the streamed runner, so no caller can fall through to a real spawn", () => {
    expect(defaultSeams().runStreamed).toBe(spawnStreamedRunner);
  });
});

describe("spawnInteractiveRunner -- the long-running seam", () => {
  it("relays the child's own exit code, with nothing captured", () => {
    const zero = spawnInteractiveRunner(process.execPath, ["-e", "process.exit(0)"]);
    expect(zero).toEqual({ code: 0, signal: null, spawnFailed: false });
    const seven = spawnInteractiveRunner(process.execPath, ["-e", "process.exit(7)"]);
    expect(seven.code).toBe(7);
    expect(seven.spawnFailed).toBe(false);
  });

  it("reports spawnFailed rather than a code when the binary never starts", () => {
    const result = spawnInteractiveRunner("definitely-not-a-real-binary-xyz", []);
    expect(result.spawnFailed).toBe(true);
    // `code` is meaningless on this branch, exactly as CommandResult's header
    // says: a caller must branch on spawnFailed, never on the number.
    expect(result.code).toBe(-1);
  });

  it("leaves no SIGINT listener behind -- a later verb stays interruptible", () => {
    const before = process.listenerCount("SIGINT");
    spawnInteractiveRunner(process.execPath, ["-e", "process.exit(0)"]);
    expect(process.listenerCount("SIGINT")).toBe(before);
  });

  it.skipIf(process.platform === "win32")(
    "maps a non-SIGINT signal kill to 128 + the signal's number, not a bare 128 (POSIX only)",
    () => {
      // The comment above the arithmetic in exec.ts said "128 + the signal
      // number" while the code it sat over returned a constant 128 for every
      // non-SIGINT signal -- a claim only a NAMED, non-zero signal can pin,
      // since a bare 128 and "128 + 0" are indistinguishable. SIGTERM is 15 on
      // every POSIX platform node ships for, so a real self-SIGTERM must come
      // back as 143, not 128. Skipped on Windows: spawnSync there reports no
      // numbered POSIX signal for `signal` at all, so there is nothing to pin.
      const result = spawnInteractiveRunner(process.execPath, [
        "-e",
        "process.kill(process.pid, 'SIGTERM')",
      ]);
      expect(result.signal).toBe("SIGTERM");
      expect(osConstants.signals.SIGTERM).toBe(15);
      expect(result.code).toBe(143);
    },
  );

  it("runs the child in the cwd it was given, and not in this process's own", () => {
    // ASSERTS THE PATH, not that a path exists. The first version of this test
    // exited 0 when `process.cwd().length > 0`, which is true of every
    // directory on earth -- so deleting the `cwd` option entirely left it
    // green, and the one thing the option does was untested.
    //
    // `realpathSync` on both sides because a temp directory on macOS is
    // reached through a symlink (`/var` -> `/private/var`) and the child would
    // otherwise report a path that is the same directory spelled differently.
    const directory = mkdtempSync(join(tmpdir(), "nen-seam-cwd-"));
    const compare =
      "const {realpathSync} = require('node:fs'); process.exit(realpathSync(process.cwd()) === realpathSync(process.argv[1]) ? 0 : 1)";
    try {
      expect(
        spawnInteractiveRunner(process.execPath, ["-e", compare, directory], { cwd: directory })
          .code,
      ).toBe(0);
      // The negative half: the same child, told to compare against a different
      // directory, says no. Without it the assertion above could pass on a
      // runner that ignored `cwd` and a fixture that happened to match.
      expect(
        spawnInteractiveRunner(process.execPath, ["-e", compare, process.cwd()], {
          cwd: directory,
        }).code,
      ).toBe(1);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

describe("outputWindow -- the arithmetic both streaming runners share", () => {
  it("measures elapsed from the start and quiet from the last output", () => {
    expect(outputWindow(0, 40, 100)).toEqual({ elapsedMs: 100, quietMs: 60 });
  });

  it("reports the whole run as quiet when nothing has been said yet", () => {
    // `lastOutputAt` starts AT the start, so a child that has printed nothing
    // has been quiet for exactly as long as it has been running -- and the two
    // budgets are then the same number, which is what makes a guard on a silent
    // build fire on the elapsed one rather than immediately.
    expect(outputWindow(10, 10, 90)).toEqual({ elapsedMs: 80, quietMs: 80 });
  });
});

describe("spawnStreamedRunner -- the watched seam", () => {
  it("relays output as it arrives, stamped, and answers the child's own code", async () => {
    const chunks: StreamedChunk[] = [];
    const result = await spawnStreamedRunner(
      process.execPath,
      ["-e", "process.stdout.write('one\\n'); console.error('two'); process.exit(3)"],
      { onOutput: (chunk): void => void chunks.push(chunk) },
    );
    expect(result.code).toBe(3);
    expect(result.spawnFailed).toBe(false);
    expect(result.abandoned).toBe(false);
    expect(chunks.map((chunk): string => chunk.stream).sort()).toEqual(["stderr", "stdout"]);
    expect(chunks.map((chunk): string => chunk.text).join("")).toContain("one");
    expect(chunks.every((chunk): boolean => chunk.atMs >= 0)).toBe(true);
  });

  it("reports a missing binary as spawnFailed, never as an exit code", async () => {
    const result = await spawnStreamedRunner("definitely-not-a-real-binary-xyz", []);
    expect(result.spawnFailed).toBe(true);
    expect(result.abandoned).toBe(false);
  });

  it("creates no watcher at all when nobody is watching", async () => {
    // A streamed run with no `onWindow` is a plain spawn with its output
    // relayed. Nothing here can assert the absence of a timer directly; what it
    // CAN assert is that such a run still completes normally, which a caller
    // relies on for every step that declares no guard.
    const result = await spawnStreamedRunner(process.execPath, ["-e", "process.exit(0)"]);
    expect(result).toMatchObject({ code: 0, spawnFailed: false, abandoned: false });
  });

  it("consults the watcher on the interval, and honours 'reset' and 'stop'", async () => {
    // A REAL CHILD, A TINY CLOCK. The child sleeps ~120ms in silence while the
    // watcher is consulted every 5ms; the verdicts are the two that keep it
    // running, and the assertion is that the seam kept asking and then stopped.
    const windows: OutputWindow[] = [];
    const result = await spawnStreamedRunner(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 120)"],
      {
        pollMs: 5,
        onWindow: (window): "reset" | "stop" => {
          windows.push(window);
          return windows.length < 3 ? "reset" : "stop";
        },
      },
    );
    expect(result.code).toBe(0);
    expect(windows.length).toBe(3);
    // `reset` restarted the quiet window each time, so the third consultation
    // reports a SHORTER quiet than elapsed -- which is the whole point of the
    // verdict, and the thing a copy of the arithmetic would have got wrong.
    const last = windows[2] as OutputWindow;
    expect(last.quietMs).toBeLessThan(last.elapsedMs);
  });

  it("abandons a child rather than killing it, and says so", async () => {
    // The child outlives this call by design: nen never signals what it
    // started. It exits on its own a moment later, and the assertion is about
    // what the RUNNER answered -- no code, `abandoned: true` -- because that is
    // what a caller branches on.
    const started = Date.now();
    const result = await spawnStreamedRunner(
      process.execPath,
      ["-e", "setTimeout(() => process.exit(0), 2000)"],
      { pollMs: 5, onWindow: (): "abandon" => "abandon" },
    );
    expect(result.abandoned).toBe(true);
    expect(result.code).toBeNull();
    expect(result.signal).toBeNull();
    // It returned long before the child's own two seconds were up.
    expect(Date.now() - started).toBeLessThan(1500);
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
