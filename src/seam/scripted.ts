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
import type { CommandResult, Runner, Seams } from "./exec.js";

export interface ScriptedCall {
  readonly match: string;
  readonly result: Partial<CommandResult>;
}

export interface RecordedRun {
  readonly command: string;
  readonly args: readonly string[];
}

export class ScriptedSeams implements Seams {
  readonly calls: RecordedRun[] = [];
  readonly now: () => Date;
  readonly env: Readonly<Record<string, string | undefined>>;
  private readonly script: readonly ScriptedCall[];

  constructor(
    script: readonly ScriptedCall[],
    options: { now?: () => Date; env?: Readonly<Record<string, string | undefined>> } = {},
  ) {
    this.script = [...script];
    this.now = options.now ?? ((): Date => new Date("2026-01-01T00:00:00Z"));
    this.env = options.env ?? {};
  }

  run: Runner = (command, args): CommandResult => {
    this.calls.push({ command, args });
    const key = [command, ...args].join(" ");
    const found = this.script.find((entry): boolean => entry.match === key);
    if (found === undefined) {
      throw new Error(
        `unscripted subprocess: '${key}'. Add it to the script, or fix the caller that made it -- an unexpected call is the finding, not the fixture's gap.`,
      );
    }
    return {
      code: found.result.code ?? 0,
      stdout: found.result.stdout ?? "",
      stderr: found.result.stderr ?? "",
      spawnFailed: found.result.spawnFailed ?? false,
    };
  };
}
