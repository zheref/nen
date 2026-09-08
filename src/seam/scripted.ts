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
import type { CommandResult, InteractiveResult, InteractiveRunner, Runner, Seams } from "./exec.js";

export interface ScriptedCall {
  readonly match: string;
  readonly result: Partial<CommandResult>;
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
  private find(command: string, args: readonly string[], what: string): Partial<CommandResult> {
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
}
