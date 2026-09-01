import { describe, expect, it } from "vitest";
import type { CommandResult, Seams } from "../seam/exec.js";
import { watchUntil } from "./until.js";

// A Seams whose run() results come from a queue -- one per call -- so a test
// can script "false, false, true" without a real subprocess or a real clock.
class QueueSeams implements Seams {
  private readonly queue: CommandResult[];
  calls = 0;
  readonly now = (): Date => new Date("2026-01-01T00:00:00Z");
  readonly env = {};
  constructor(queue: readonly CommandResult[]) {
    this.queue = [...queue];
  }
  run: Seams["run"] = (): CommandResult => {
    this.calls += 1;
    const next = this.queue.shift();
    if (next === undefined) throw new Error("QueueSeams ran out of scripted results");
    return next;
  };
}

const OK = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "", spawnFailed: false });
const ERR = (): CommandResult => ({ code: 1, stdout: "", stderr: "boom", spawnFailed: true });

describe("watchUntil -- fetch, evaluate, pace, stop", () => {
  it("stops the moment the condition is true, never sleeping again after", () => {
    const seams = new QueueSeams([OK("pending"), OK("pending"), OK("done")]);
    const sleeps: number[] = [];
    const result = watchUntil(seams, {
      request: { command: "gh", args: [] },
      isTrue: (r): boolean => r.stdout === "done",
      intervalMs: 10,
      sleep: (ms): void => void sleeps.push(ms),
    });
    expect(result.outcome).toBe("condition-true");
    expect(result.iterations.length).toBe(3);
    // Two sleeps between three observations, never a third after success.
    expect(sleeps).toEqual([10, 10]);
  });

  it("stops after 3 CONSECUTIVE observation errors, distinct from a false reading", () => {
    const seams = new QueueSeams([OK("no"), ERR(), ERR(), ERR()]);
    const result = watchUntil(seams, {
      request: { command: "gh", args: [] },
      isTrue: (r): boolean => r.stdout === "yes",
      intervalMs: 0,
      sleep: (): void => {},
    });
    expect(result.outcome).toBe("error-streak");
    expect(result.iterations.length).toBe(4);
    expect(result.iterations[0]?.errored).toBe(false);
    expect(result.iterations.slice(1).every((it): boolean => it.errored)).toBe(true);
  });

  it("an error streak RESETS on a successful (even false) observation", () => {
    const seams = new QueueSeams([ERR(), ERR(), OK("no"), ERR(), ERR(), OK("yes")]);
    const result = watchUntil(seams, {
      request: { command: "gh", args: [] },
      isTrue: (r): boolean => r.stdout === "yes",
      intervalMs: 0,
      sleep: (): void => {},
    });
    expect(result.outcome).toBe("condition-true");
    expect(result.iterations.length).toBe(6);
  });

  it("stops at maxIterations, a safety bound distinct from a real cap", () => {
    const seams = new QueueSeams([OK("no"), OK("no"), OK("no")]);
    const result = watchUntil(seams, {
      request: { command: "gh", args: [] },
      isTrue: (r): boolean => r.stdout === "yes",
      intervalMs: 0,
      maxIterations: 3,
      sleep: (): void => {},
    });
    expect(result.outcome).toBe("max-iterations");
    expect(result.iterations.length).toBe(3);
  });

  it("calls onIteration once per observation, in order", () => {
    const seams = new QueueSeams([OK("no"), OK("yes")]);
    const seen: number[] = [];
    watchUntil(seams, {
      request: { command: "gh", args: [] },
      isTrue: (r): boolean => r.stdout === "yes",
      intervalMs: 0,
      sleep: (): void => {},
      onIteration: (it): void => void seen.push(it.iteration),
    });
    expect(seen).toEqual([1, 2]);
  });
});
