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
}

export class ScriptedSeams implements Seams {
  readonly calls: RecordedRun[] = [];
  readonly now: () => Date;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly platform: NodeJS.Platform;
  private readonly script: readonly ScriptedCall[];

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

  private find(command: string, args: readonly string[], what: string): Partial<CommandResult> {
    const key = [command, ...args].join(" ");
    const found = this.script.find((entry): boolean => entry.match === key);
    if (found === undefined) {
      throw new Error(
        `unscripted ${what}: '${key}'. Add it to the script, or fix the caller that made it -- an unexpected call is the finding, not the fixture's gap.`,
      );
    }
    return found.result;
  }

  run: Runner = (command, args): CommandResult => {
    this.calls.push({ command, args, interactive: false });
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
  runInteractive: InteractiveRunner = (command, args): InteractiveResult => {
    this.calls.push({ command, args, interactive: true });
    const found = this.find(command, args, "interactive subprocess");
    return {
      code: found.code ?? 0,
      signal: null,
      spawnFailed: found.spawnFailed ?? false,
    };
  };
}
