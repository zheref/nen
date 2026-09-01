// src/exec/seam.ts -- the ONE place this binary shells out, and the seam every
// test substitutes.
//
// WHY A SEAM AND NOT `spawnSync` AT EACH CALL SITE. Half the verbs in this
// repository are choreography over `git` and `gh`: which command, in which
// order, with what read of the output. That choreography is the part that is
// worth testing and the part that must never run for real in a test -- a suite
// that could reach the network is a suite that can label an issue, retarget a
// PR, or push a tag on somebody's laptop. So every subprocess goes through a
// `Runner`, tests pass a recorded one, and a verb that forgot to take the
// runner as an argument is visible in review as a `defaultRunner` reference
// where an injected one belongs.
//
// IT IS SYNCHRONOUS, DELIBERATELY. Every verb here is a short choreography with
// a strict order -- file, then attach, then close; fetch, then compare -- and
// order is the property most worth keeping obvious. `spawnSync` also keeps the
// whole CLI a plain function of argv, which is what lets `run()` return an exit
// code instead of awaiting one.
//
// NOTHING HERE INTERPRETS ANYTHING. No exit code is judged, no stderr is
// classified, no JSON is parsed. A runner returns the three observable facts
// (stdout, stderr, code) and the caller decides what they mean -- the same
// split ../github/client.ts draws between transport and verdict, for the same
// reason.

import { spawnSync } from "node:child_process";

export interface RunRequest {
  readonly bin: string;
  readonly args: readonly string[];
  /** Working directory. Defaults to the process's own. */
  readonly cwd?: string | undefined;
  readonly stdin?: string | undefined;
  /** Extra environment on top of the process's. */
  readonly env?: Readonly<Record<string, string>> | undefined;
}

export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /** Set when the process could not be started at all (missing binary). */
  readonly spawnError: string | null;
}

export interface Runner {
  run(request: RunRequest): RunResult;
}

export const defaultRunner: Runner = {
  run(request: RunRequest): RunResult {
    const result = spawnSync(request.bin, [...request.args], {
      cwd: request.cwd,
      input: request.stdin,
      encoding: "utf8",
      env: request.env === undefined ? process.env : { ...process.env, ...request.env },
      // Never `shell: true`. A quoted argument that reaches a shell is an
      // argument that can be re-split, and half of what is passed here is
      // user-supplied text (an issue title, a branch name, a commit body).
      shell: false,
      maxBuffer: 64 * 1024 * 1024,
    });
    if (result.error !== undefined) {
      return {
        code: 127,
        stdout: "",
        stderr: "",
        spawnError: `${request.bin}: ${result.error.message}`,
      };
    }
    return {
      code: result.status ?? 1,
      stdout: result.stdout ?? "",
      stderr: result.stderr ?? "",
      spawnError: null,
    };
  },
};

// A recorded runner for tests: exact-match on `bin` plus the joined argv, with
// a loud failure for a call nobody scripted.
//
// UNSCRIPTED CALLS THROW, they do not return empty. A stub that answered every
// unknown call with `{code: 0, stdout: ""}` would let a verb make an extra `gh`
// call -- a second create, a stray label -- and still pass, which is precisely
// the class of defect these verbs exist to prevent.
export interface ScriptedCall {
  readonly match: string;
  readonly result: Partial<RunResult>;
}

export class ScriptedRunner implements Runner {
  readonly calls: RunRequest[] = [];
  private readonly script: ScriptedCall[];

  constructor(script: readonly ScriptedCall[]) {
    this.script = [...script];
  }

  static key(request: RunRequest): string {
    return [request.bin, ...request.args].join(" ");
  }

  run(request: RunRequest): RunResult {
    this.calls.push(request);
    const key = ScriptedRunner.key(request);
    const found = this.script.find((entry): boolean => entry.match === key);
    if (found === undefined) {
      throw new Error(
        `unscripted subprocess: '${key}'. Add it to the script, or fix the verb that made it -- an unexpected call is the finding, not the fixture's gap.`,
      );
    }
    return {
      code: found.result.code ?? 0,
      stdout: found.result.stdout ?? "",
      stderr: found.result.stderr ?? "",
      spawnError: found.result.spawnError ?? null,
    };
  }
}

// `git`/`gh` output is line-oriented and this repository is checked out with
// `* text=auto`, so a Windows run reads CRLF where a macOS run reads LF. Every
// parser here goes through this, once, rather than each remembering.
export function lines(text: string): string[] {
  return text.replace(/\r\n/g, "\n").split("\n").filter((line): boolean => line !== "");
}

export function stdoutLines(result: RunResult): string[] {
  return lines(result.stdout);
}
