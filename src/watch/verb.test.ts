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

  it("refuses an unknown subcommand", () => {
    expect(runWatch(makeContext({ args: ["bogus"] }).context, new QueueRunner([]))).toBe(2);
  });
});
