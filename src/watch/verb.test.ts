import { describe, expect, it } from "vitest";
import type { Runner, RunResult } from "../exec/seam.js";
import type { VerbContext } from "../cli/verb.js";
import { runWatch } from "./verb.js";

class QueueRunner implements Runner {
  private readonly queue: RunResult[];
  constructor(queue: readonly RunResult[]) {
    this.queue = [...queue];
  }
  run(): RunResult {
    const next = this.queue.shift();
    if (next === undefined) throw new Error("QueueRunner ran out of scripted results");
    return next;
  }
}

const OK = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "", spawnError: null });

function makeContext(overrides: Partial<VerbContext> = {}): { context: VerbContext; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const context: VerbContext = {
    args: [],
    values: {},
    booleans: new Set(),
    passthrough: [],
    repoFlag: null,
    json: false,
    io: { out: (l): void => void out.push(l), err: (l): void => void err.push(l) },
    ...overrides,
  };
  return { context, out, err };
}

describe("nen watch until -- CLI wiring", () => {
  it("refuses a mutating --command before ever observing", () => {
    const { context, err } = makeContext({ args: ["until"], values: { command: "git push origin main" } });
    const code = runWatch(context, new QueueRunner([]), (): void => {});
    expect(code).toBe(2);
    expect(err.join("\n")).toMatch(/classifies as mutating/);
  });

  it("exits 0 the moment exit-code-0 is reached, with no --true-pattern given", () => {
    const { context } = makeContext({ args: ["until"], values: { command: "gh pr checks 1", "interval-ms": "0" } });
    const runner = new QueueRunner([OK()]);
    expect(runWatch(context, runner, (): void => {})).toBe(0);
  });

  it("matches --true-pattern against stdout", () => {
    const { context, out } = makeContext({
      args: ["until"],
      values: { command: "gh pr checks 1", "true-pattern": "ALL_GREEN", "interval-ms": "0" },
    });
    const runner = new QueueRunner([OK("pending"), OK("ALL_GREEN at last")]);
    expect(runWatch(context, runner, (): void => {})).toBe(0);
    expect(out.join("\n")).toMatch(/condition became true after 2 observation/);
  });

  it("exits 1 and reports the bound when --max-iterations is reached", () => {
    const { context, err } = makeContext({
      args: ["until"],
      values: { command: "gh pr checks 1", "true-pattern": "NEVER", "max-iterations": "2", "interval-ms": "0" },
    });
    const runner = new QueueRunner([OK("no"), OK("no")]);
    expect(runWatch(context, runner, (): void => {})).toBe(1);
    expect(err.join("\n")).toMatch(/--max-iterations bound/);
  });

  it("requires --command", () => {
    expect(runWatch(makeContext({ args: ["until"] }).context, new QueueRunner([]))).toBe(2);
  });

  // Review finding #12: the default isError only catches a missing binary,
  // so a command that runs but fails fatally (git in a non-git directory,
  // gh unauthenticated) used to read as "condition is not yet true" forever
  // instead of stopping at the 3-consecutive-error streak.
  it("stops at the error streak, NOT --max-iterations, when the command itself fails fatally (exit-code-as-truth mode)", () => {
    const FATAL = (): RunResult => ({ code: 128, stdout: "", stderr: "fatal: not a git repository\n", spawnError: null });
    const { context, err, out } = makeContext({
      args: ["until"],
      values: { command: "git log --oneline -1", "max-iterations": "10", "interval-ms": "0" },
    });
    const runner = new QueueRunner([FATAL(), FATAL(), FATAL()]);
    expect(runWatch(context, runner, (): void => {})).toBe(1);
    expect(err.join("\n")).toMatch(/consecutive observation errors/);
    expect(out.join("\n")).toMatch(/fatal: not a git repository/);
  });

  it("a --true-pattern command that exits non-zero is an ERROR, not a false reading", () => {
    const FATAL = (): RunResult => ({ code: 1, stdout: "", stderr: "gh: not authenticated\n", spawnError: null });
    const { context, err } = makeContext({
      args: ["until"],
      values: { command: "gh pr checks 1", "true-pattern": "ALL_GREEN", "max-iterations": "10", "interval-ms": "0" },
    });
    const runner = new QueueRunner([FATAL(), FATAL(), FATAL()]);
    expect(runWatch(context, runner, (): void => {})).toBe(1);
    expect(err.join("\n")).toMatch(/consecutive observation errors/);
  });

  it("--error-exit-threshold raises the bar for what counts as an error in exit-code-as-truth mode", () => {
    const { context, err } = makeContext({
      args: ["until"],
      values: { command: "git status", "error-exit-threshold": "5", "max-iterations": "2", "interval-ms": "0" },
    });
    // Exit code 3 is below the raised threshold -- a false reading, not an error.
    const runner = new QueueRunner([
      { code: 3, stdout: "", stderr: "", spawnError: null },
      { code: 3, stdout: "", stderr: "", spawnError: null },
    ]);
    expect(runWatch(context, runner, (): void => {})).toBe(1);
    // Reached the iteration bound, not the error streak -- exit 3 was read as
    // false (below the raised threshold), not as an observation error.
    expect(err.join("\n")).toMatch(/--max-iterations bound/);
  });

  it("refuses an unknown subcommand", () => {
    expect(runWatch(makeContext({ args: ["bogus"] }).context, new QueueRunner([]))).toBe(2);
  });
});
