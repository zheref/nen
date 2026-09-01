// src/watch/until.ts -- izanami's loop, §4: fetch, evaluate, report one line,
// pace the interval, stop on truth / an error streak / a bound.
//
// ONE PREDICATE, POLLED IN-SHELL. Ichigo has no background or deferral
// primitive (invariant 5) -- the loop runs in the calling process and the
// caller holds it. That is exactly what a synchronous CLI verb already is, so
// this module is a plain loop: run the observation command, decide the
// condition from its result, sleep, repeat.
//
// THREE CONSECUTIVE OBSERVATION ERRORS STOP THE RUN (skill §4's table): "a loop
// that cannot see is not watching". This is NOT the same thing as the
// condition being false -- a false reading is progress (the watch is working
// and reporting "not yet"); an ERRORED reading is the watch itself failing.
// Conflating the two would let a broken observation command masquerade as "the
// condition just hasn't happened yet" for as long as anyone lets it run.
//
// `maxIterations` IS A SAFETY BOUND, NOT IZANAGI'S CAP. izanami is read-only
// and the skill says explicitly that it needs no cap because it can compound
// no mistake -- "a long watch costs time and nothing else". This binary still
// takes an optional bound so a caller (or a test) can stop an otherwise
// unbounded loop deliberately; reaching it is reported as its own outcome,
// distinct from both convergence and the error streak, and a caller that wants
// a truly unbounded watch simply omits it.

import type { Runner, RunRequest, RunResult } from "../exec/seam.js";

export interface WatchIteration {
  readonly iteration: number;
  readonly conditionTrue: boolean;
  readonly errored: boolean;
  readonly message: string;
}

export type WatchOutcome = "condition-true" | "error-streak" | "max-iterations";

export interface WatchResult {
  readonly outcome: WatchOutcome;
  readonly iterations: readonly WatchIteration[];
}

export interface WatchOptions {
  readonly request: RunRequest;
  /** Decides the condition from one observation. */
  readonly isTrue: (result: RunResult) => boolean;
  /** Decides whether an observation itself failed, distinct from a false reading. Defaults to spawnError !== null. */
  readonly isError?: (result: RunResult) => boolean;
  readonly intervalMs: number;
  readonly maxIterations?: number;
  /** Injectable so tests never actually sleep. Defaults to a real wait. */
  readonly sleep?: (ms: number) => void;
  readonly onIteration?: (iteration: WatchIteration) => void;
}

const ERROR_STREAK_LIMIT = 3;

function defaultSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export function watchUntil(runner: Runner, options: WatchOptions): WatchResult {
  const isError = options.isError ?? ((result): boolean => result.spawnError !== null);
  const sleep = options.sleep ?? defaultSleep;
  const iterations: WatchIteration[] = [];
  let consecutiveErrors = 0;
  let iteration = 0;

  for (;;) {
    iteration += 1;
    const result = runner.run(options.request);
    const errored = isError(result);
    const conditionTrue = !errored && options.isTrue(result);

    const message = errored
      ? `observation failed: ${result.spawnError ?? "non-zero/unreadable result"}`
      : conditionTrue
        ? "condition is true"
        : "condition is not yet true";
    const entry: WatchIteration = { iteration, conditionTrue, errored, message };
    iterations.push(entry);
    options.onIteration?.(entry);

    if (errored) {
      consecutiveErrors += 1;
      if (consecutiveErrors >= ERROR_STREAK_LIMIT) {
        return { outcome: "error-streak", iterations };
      }
    } else {
      consecutiveErrors = 0;
      if (conditionTrue) {
        return { outcome: "condition-true", iterations };
      }
    }

    if (options.maxIterations !== undefined && iteration >= options.maxIterations) {
      return { outcome: "max-iterations", iterations };
    }
    sleep(options.intervalMs);
  }
}
