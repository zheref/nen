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

import { outputLines, type CommandResult, type RunOptions, type Seams } from "../seam/exec.js";

/** What one watched observation runs -- the same shape ../seam/exec.ts's Seams.run() takes. */
export interface WatchRequest {
  readonly command: string;
  readonly args: readonly string[];
  readonly options?: RunOptions;
}

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
  readonly request: WatchRequest;
  /** Decides the condition from one observation. */
  readonly isTrue: (result: CommandResult) => boolean;
  /**
   * Decides whether an observation itself failed, distinct from a false
   * reading. Defaults to spawnFailed -- i.e. "the binary could not
   * even be started" -- which is deliberately narrow: it is the only
   * universally-safe default, because this module has no way to know which
   * non-zero exit codes a CALLER's specific command uses to mean "false" (a
   * normal reading) versus "broken" (auth expired, not a git repo, a 404).
   * A caller whose observation's exit code alone cannot tell those apart
   * MUST supply its own isError -- see ../watch/verb.ts's --error-exit-
   * threshold for the CLI's version of that choice. Passing this default
   * unexamined is how a permanently-broken observation command reports
   * "condition is not yet true" forever instead of stopping at the error
   * streak below.
   */
  readonly isError?: (result: CommandResult) => boolean;
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

export function watchUntil(seams: Seams, options: WatchOptions): WatchResult {
  const isError = options.isError ?? ((result): boolean => result.spawnFailed);
  const sleep = options.sleep ?? defaultSleep;
  const iterations: WatchIteration[] = [];
  let consecutiveErrors = 0;
  let iteration = 0;

  for (;;) {
    iteration += 1;
    const result = seams.run(options.request.command, options.request.args, options.request.options);
    const errored = isError(result);
    const conditionTrue = !errored && options.isTrue(result);

    // The exit code (and, on an error, the observation's own stderr) are
    // ALWAYS surfaced -- a human watching a `fatal: not a git repository`
    // masquerading as "not yet true" is exactly the failure mode the
    // consecutive-error streak above exists to catch; the message itself
    // must not hide the evidence that would let someone catch it sooner.
    const message = errored
      ? `observation failed: ${outputLines(result.stderr)[0] ?? `exit ${result.code}, no stderr`}`
      : conditionTrue
        ? `condition is true (exit ${result.code})`
        : `condition is not yet true (exit ${result.code})`;
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
