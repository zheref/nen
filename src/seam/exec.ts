// src/seam/exec.ts -- the ONE place this binary talks to another process, and
// the ONE place it reads the clock or the environment.
//
// WHY A SEAM AT ALL. Every verb this repository ports from a shell script was a
// script whose behaviour WAS its subprocess calls: a `gh api` here, a `git
// merge-base --is-ancestor` there, a `date -u` for the arithmetic. Ported
// naively, each verb would reach for `spawnSync` directly and the whole family
// would become untestable without a network and a live repository -- which is
// how the originals ended up with the coverage they have (BC-9's "a script with
// real branching and no test" auto-reject exists because of exactly this).
//
// So the three ambient dependencies are ARGUMENTS. A verb takes `Seams` and can
// therefore be driven from a table of recorded responses; the command layer is
// the only place the real ones are constructed. The rule that keeps it honest:
// NO SHIPPED VERB IMPORTS `node:child_process`, and no test in this repository
// makes a network call. If a verb needs a new kind of I/O, it grows a seam
// method here rather than a direct import there.
//
// THE CLOCK IS A SEAM FOR THE SAME REASON THE SUBPROCESS IS. `nen pr staleness`
// is arithmetic over "how long since the last event", `nen wake verify` decides
// whether a probe window has closed, and a test that computed either against the
// real clock would be a test whose verdict changed with the hour. The originals
// already understood this -- `detect_swallowed_wakes.sh` takes `NOW` from the
// environment precisely so a replay is reproducible -- and that env contract is
// carried through `Seams.now()` rather than dropped.
//
// FAILURE TO SPAWN IS ITS OWN OUTCOME, not an exception and not exit code 127.
// "the tool is not installed" and "the tool ran and said no" want different
// messages from every caller, and collapsing them is how an operator with no
// `gh` on PATH gets told their pull request is not ready.

import { spawnSync } from "node:child_process";

/** The two external tools this binary is allowed to know about (D16). */
export const GIT = "git";
export const GH = "gh";

export interface RunOptions {
  /** Working directory. Defaults to the runner's own inherited cwd. */
  readonly cwd?: string;
  /** Extra environment, merged over the process environment. */
  readonly env?: Readonly<Record<string, string | undefined>>;
  /** Text written to the child's stdin. */
  readonly stdin?: string;
}

export interface CommandResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
  /**
   * True when the executable could not be started at all -- no such binary, no
   * permission. `code` is then meaningless and every caller must say "not
   * installed" rather than "reported a failure".
   */
  readonly spawnFailed: boolean;
}

export type Runner = (
  command: string,
  args: readonly string[],
  options?: RunOptions,
) => CommandResult;

export interface Seams {
  readonly run: Runner;
  /** The instant this invocation reasons about. Read once per verb, not per row. */
  readonly now: () => Date;
  readonly env: Readonly<Record<string, string | undefined>>;
}

// CRLF IS NORMALIZED AT THE SEAM, once, for every caller.
//
// The repository is `* text=auto`, the maintainer's host is Windows/Git Bash,
// and `git log --format=%H` there answers with `\r\n` line endings while the
// same command on a POSIX host does not. Every verb that splits a subprocess's
// stdout into lines would otherwise carry a stray carriage return into a
// comparison, a set membership, or a rendered table -- and the failure is
// platform-conditional, which is the class of defect this repository's CI matrix
// exists to catch and its tests are written to avoid. Normalizing here means a
// verb never has to remember.
export function normalizeEol(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

/** Split subprocess output into non-empty lines, EOL-normalized and trimmed. */
export function outputLines(text: string): string[] {
  return normalizeEol(text)
    .split("\n")
    .map((line): string => line.trim())
    .filter((line): boolean => line !== "");
}

export const spawnRunner: Runner = (command, args, options = {}): CommandResult => {
  const result = spawnSync(command, [...args], {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined
      ? {}
      : { env: { ...process.env, ...options.env } as NodeJS.ProcessEnv }),
    ...(options.stdin === undefined ? {} : { input: options.stdin }),
    encoding: "utf8",
    // Generous, because a backlog sweep's response can be large and a truncated
    // JSON body would be parsed as a syntax error rather than reported as a
    // truncation.
    maxBuffer: 64 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return {
      code: -1,
      stdout: "",
      stderr: result.error.message,
      spawnFailed: true,
    };
  }
  return {
    code: result.status ?? 1,
    stdout: normalizeEol(result.stdout ?? ""),
    stderr: normalizeEol(result.stderr ?? ""),
    spawnFailed: false,
  };
};

export function defaultSeams(): Seams {
  return { run: spawnRunner, now: (): Date => new Date(), env: process.env };
}

// --- error shape -------------------------------------------------------------

// The ONE error a verb throws when an external tool refused, so that index.ts
// can print it whole and return 1 without every verb inventing its own class.
//
// It carries the argv, because "gh failed" is not a report -- an operator needs
// to be able to re-run the exact call and see the same refusal.
export class ToolError extends Error {
  readonly command: string;
  readonly args: readonly string[];
  readonly result: CommandResult;

  constructor(command: string, args: readonly string[], result: CommandResult) {
    const detail = result.spawnFailed
      ? `could not be started (${result.stderr}). Nen shells out to '${command}' for this verb; install it, or put it on PATH.`
      : `exited ${result.code}${result.stderr === "" ? "" : `: ${result.stderr.trim()}`}`;
    super(`${command} ${args.join(" ")} -- ${detail}`);
    this.name = "ToolError";
    this.command = command;
    this.args = args;
    this.result = result;
  }
}

/** Run a tool and throw ToolError unless it exited 0. */
export function must(
  seams: Seams,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): CommandResult {
  const result = seams.run(command, args, options);
  if (result.spawnFailed || result.code !== 0) {
    throw new ToolError(command, args, result);
  }
  return result;
}

/** Run a tool that answers with JSON, and parse it. */
export function mustJson<T>(
  seams: Seams,
  command: string,
  args: readonly string[],
  options?: RunOptions,
): T {
  const result = must(seams, command, args, options);
  try {
    return JSON.parse(result.stdout) as T;
  } catch (error) {
    throw new ToolError(command, args, {
      ...result,
      code: 1,
      stderr: `answered something that is not JSON (${error instanceof Error ? error.message : String(error)})`,
    });
  }
}
