// src/seam/scripted.ts -- a recorded Seams, for tests: exact-match on the
// command plus its joined argv, with a loud failure for a call nobody
// scripted.
//
// PORTED FROM src/exec/seam.ts's ScriptedRunner (verbs/4-remainders), rebuilt
// against ./exec.ts's Seams contract rather than the branch-local Runner one
// it replaces -- see ./exec.ts's own header for why this repository has only
// one real subprocess seam now. The "unscripted calls throw, they never
// silently return empty" discipline is carried over unchanged: a stub that
// answered every unknown call with `{code: 0, stdout: ""}` would let a verb
// make an extra `gh` call -- a second create, a stray label -- and still
// pass, which is exactly the class of defect these verbs exist to prevent.
import {
  outputWindow,
  type CommandResult,
  type InteractiveResult,
  type InteractiveRunner,
  type Runner,
  type Seams,
  type StreamedResult,
  type StreamedRunner,
} from "./exec.js";

/**
 * ONE MOMENT IN A WATCHED CHILD'S LIFE, on a clock the test owns.
 *
 * A chunk of output (`stream` + `text`) or -- with neither -- a bare TICK: the
 * instant the watcher is consulted at. That is the whole of what a stall guard
 * reacts to, so a scripted run is a list of these and nothing else, and a test
 * about a three-minute budget costs no milliseconds at all.
 */
export interface ScriptedStreamEvent {
  /** Milliseconds since the child started. Ascending, in the test's own units. */
  readonly atMs: number;
  readonly stream?: "stdout" | "stderr";
  readonly text?: string;
}

/** What a scripted child does while it runs, and when it stops. */
export interface ScriptedStream {
  readonly events: readonly ScriptedStreamEvent[];
  /** The instant it exits. Defaults to the last event's. */
  readonly exitAtMs?: number;
}

export interface ScriptedCall {
  readonly match: string;
  readonly result: Partial<CommandResult> & {
    /**
     * The timeline `runStreamed` replays for this call. Absent: a streamed
     * call answers with this entry's `stdout`/`stderr` as one chunk at 0ms and
     * exits immediately -- which is what a step with no stall guard, driven
     * through the streaming seam, actually looks like from the caller's side.
     */
    readonly stream?: ScriptedStream;
  };
}

export interface RecordedRun {
  readonly command: string;
  readonly args: readonly string[];
  /**
   * Which seam took the call. Present on every recorded run so a test can
   * assert that a long-running verb went through `runInteractive` and a
   * captured one did not -- the distinction ../seam/exec.ts's header exists
   * for, which a single flat list of argv would erase.
   */
  readonly interactive: boolean;
  /**
   * True when the call went through `runStreamed` rather than `run`.
   *
   * A SECOND COLUMN RATHER THAN A THIRD VALUE IN THE FIRST, because the two
   * ask different questions: `interactive` is "did nen give up the output"
   * (false for both captured seams) and this is "was the child watched while
   * it ran". Folding them into one enum would have re-typed every existing
   * assertion to say the thing it already said.
   */
  readonly streamed?: boolean;
  /**
   * The working directory the caller asked for, or null when it asked for
   * none (the child then inherits this process's own).
   *
   * RECORDED BECAUSE THE SCRIPT CANNOT MATCH ON IT. `find` keys on the command
   * plus its argv, so a verb that resolved a lane's `cwd` wrongly -- against
   * the process's directory instead of `--repo`, say -- produced a call this
   * seam happily answered and no test could see. `nen shu` runs every step in
   * a directory the declaration names, so "which directory" is half of what
   * it does.
   */
  readonly cwd: string | null;
  /**
   * The extra environment the caller passed to the child, or null for none.
   *
   * THE VALUES ARE HERE ON PURPOSE, and they are the only place in a test run
   * where they legitimately appear: a declaration's `env` value must reach the
   * CHILD and must never reach a report, a log line or a refusal. Asserting
   * "the value is in no output" proves half of that; the other half needs
   * somewhere the value is supposed to be.
   */
  readonly env: Readonly<Record<string, string | undefined>> | null;
}

export class ScriptedSeams implements Seams {
  readonly calls: RecordedRun[] = [];
  readonly now: () => Date;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  private readonly script: readonly ScriptedCall[];
  /** How many times each command line has been answered, for `find`'s ordering. */
  private readonly answered = new Map<string, number>();

  constructor(
    script: readonly ScriptedCall[],
    options: {
      now?: () => Date;
      env?: Readonly<Record<string, string | undefined>>;
      /**
       * The host this invocation should believe it is on. Defaults to the REAL
       * platform so every existing test keeps the behaviour it was written
       * against; a test about a host refusal states the platform it means, and
       * therefore proves the same thing on all three CI lanes.
       */
      platform?: NodeJS.Platform;
    } = {},
  ) {
    this.script = [...script];
    this.now = options.now ?? ((): Date => new Date("2026-01-01T00:00:00Z"));
    this.env = options.env ?? {};
    this.platform = options.platform ?? process.platform;
  }

  /**
   * SEVERAL ENTRIES WITH ONE `match` ARE ANSWERED IN ORDER, one per call, and
   * the last of them repeats for every call after that.
   *
   * One entry behaves exactly as it always did -- answering every call with the
   * same result -- so no existing script changes meaning. What this adds is the
   * one thing a single-answer table could not express: a verb that reads
   * something, CHANGES it, and reads it again to check. `nen shu warmup
   * --discard` does precisely that (`git status`, discard, `git status`), and
   * the whole point of the second read is that the answer must be allowed to
   * differ from the first -- a fixture that could only ever give one answer
   * could not tell a discard that worked from one that silently did not.
   */
  private find(command: string, args: readonly string[], what: string): ScriptedCall["result"] {
    const key = [command, ...args].join(" ");
    const matching = this.script.filter((entry): boolean => entry.match === key);
    if (matching.length === 0) {
      throw new Error(
        `unscripted ${what}: '${key}'. Add it to the script, or fix the caller that made it -- an unexpected call is the finding, not the fixture's gap.`,
      );
    }
    const seen = this.answered.get(key) ?? 0;
    this.answered.set(key, seen + 1);
    const chosen = matching[Math.min(seen, matching.length - 1)];
    /* c8 ignore next -- `matching` is non-empty here, so the index is in range */
    if (chosen === undefined) throw new Error(`unscripted ${what}: '${key}'.`);
    return chosen.result;
  }

  run: Runner = (command, args, options = {}): CommandResult => {
    this.calls.push({
      command,
      args,
      interactive: false,
      cwd: options.cwd ?? null,
      env: options.env ?? null,
    });
    const found = this.find(command, args, "subprocess");
    return {
      code: found.code ?? 0,
      stdout: found.stdout ?? "",
      stderr: found.stderr ?? "",
      spawnFailed: found.spawnFailed ?? false,
    };
  };

  /**
   * The recorded long-running child. It answers from the SAME script as `run`,
   * keyed the same way, because a test's fixture should not have to know which
   * seam a verb chose -- and an unscripted call throws here for the same reason
   * it throws there: a verb that spawned something nobody expected is the
   * finding.
   *
   * `stdout`/`stderr` in a script entry are IGNORED here rather than returned,
   * which is the point of the seam: an interactive child's output went to the
   * terminal and nen never saw it.
   */
  runInteractive: InteractiveRunner = (command, args, options = {}): InteractiveResult => {
    this.calls.push({
      command,
      args,
      interactive: true,
      cwd: options.cwd ?? null,
      env: options.env ?? null,
    });
    const found = this.find(command, args, "interactive subprocess");
    return {
      code: found.code ?? 0,
      signal: null,
      spawnFailed: found.spawnFailed ?? false,
    };
  };

  /**
   * The recorded WATCHED child: the same script, keyed the same way, replaying
   * a timeline the entry states instead of a real clock.
   *
   * THE ARITHMETIC IS THE SEAM'S OWN (`outputWindow`), not a second copy of it
   * here. What a test drives is WHEN things happened; what decides `elapsedMs`
   * and `quietMs` from those instants is the one function the real runner also
   * calls, so a stall guard proved against this fixture is proved against the
   * rule that ships. The verdicts are honoured exactly as the real runner
   * honours them, `reset` included -- and a scripted run has no wall clock, so
   * `reset` restarts the quiet window at the tick's own instant.
   *
   * IT RECORDS `interactive: false`, because that column answers "did nen keep
   * the output" and a watched child's output is nen's. A test that needs to
   * tell the two captured seams apart reads `streamed`.
   */
  runStreamed: StreamedRunner = async (command, args, options = {}): Promise<StreamedResult> => {
    this.calls.push({
      command,
      args,
      interactive: false,
      streamed: true,
      cwd: options.cwd ?? null,
      env: options.env ?? null,
    });
    const found = this.find(command, args, "streamed subprocess");
    if (found.spawnFailed === true) {
      return { code: -1, signal: null, spawnFailed: true, abandoned: false, durationMs: 0 };
    }
    const timeline = found.stream ?? {
      events: [
        ...(found.stdout === undefined
          ? []
          : [{ atMs: 0, stream: "stdout" as const, text: found.stdout }]),
        ...(found.stderr === undefined
          ? []
          : [{ atMs: 0, stream: "stderr" as const, text: found.stderr }]),
      ],
    };
    let lastOutputAt = 0;
    let watching = options.onWindow !== undefined;
    let last = 0;
    for (const event of timeline.events) {
      last = event.atMs;
      if (event.stream !== undefined && event.text !== undefined) {
        lastOutputAt = event.atMs;
        options.onOutput?.({ stream: event.stream, text: event.text, atMs: event.atMs });
        continue;
      }
      if (!watching || options.onWindow === undefined) continue;
      const verdict = options.onWindow(outputWindow(0, lastOutputAt, event.atMs));
      if (verdict === "reset") lastOutputAt = event.atMs;
      if (verdict === "stop") watching = false;
      if (verdict === "abandon") {
        // THE TIMELINE STOPS HERE, exactly as the real runner stops reading:
        // the scripted child is "still running" and nen has let go of it, so
        // there is no exit code to report and no later event to replay.
        return {
          code: null,
          signal: null,
          spawnFailed: false,
          abandoned: true,
          durationMs: event.atMs,
        };
      }
    }
    return {
      code: found.code ?? 0,
      signal: null,
      spawnFailed: false,
      abandoned: false,
      durationMs: timeline.exitAtMs ?? last,
    };
  };
}
