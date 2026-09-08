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
//
// A LONG-RUNNING PROCESS IS A DIFFERENT SEAM, not a flag on this one
// (zheref/nen#110). `run` is `spawnSync` with the child's output CAPTURED, which
// is the right shape for a `gh api` answer a verb parses and the wrong one for a
// dev server: a captured stream buffers until the child exits, so a process that
// never exits prints nothing, ever, and a caller cannot type into it. So
// `runInteractive` is its own member -- stdio inherited, no capture, an exit code
// and nothing else -- and the two are distinguishable at every call site instead
// of hidden behind an option a reviewer has to notice. It is REQUIRED rather than
// optional for the reason every member here is: a seam nobody has to provide is a
// seam a test can silently fall through to the real one on.
//
// THE HOST PLATFORM IS A SEAM FOR THE SAME REASON THE CLOCK IS. `nen shu` refuses
// a verb whose declaration allows only `darwin` when it is running on `linux`
// (exit 3), and a test that read `process.platform` directly could only prove that
// refusal on the platform it happens to be running on -- so "xcodebuild on linux
// exits 3" and "msbuild on darwin exits 3" would each be provable on exactly one
// of the three CI lanes, which is the same as not being provable at all.

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

/** What a long-running, stdio-inheriting child answers with. */
export interface InteractiveResult {
  /**
   * The child's own exit code. `130` when it was killed by SIGINT and reported
   * no code of its own -- the shell convention (128 + SIGINT's 2), so a caller
   * can tell "the developer pressed Ctrl-C" from "the tool decided no".
   */
  readonly code: number;
  /** The signal that killed it, or null. Never inferred from `code`. */
  readonly signal: string | null;
  /** Same meaning as CommandResult's: the binary could not be started at all. */
  readonly spawnFailed: boolean;
}

/**
 * Run a child with the TERMINAL, not with a buffer: stdio inherited, nothing
 * captured, an exit code back. For `nen shu dev` / `nen shu run` and anything
 * else whose whole point is that it does not finish on its own.
 */
export type InteractiveRunner = (
  command: string,
  args: readonly string[],
  options?: Omit<RunOptions, "stdin">,
) => InteractiveResult;

export interface Seams {
  readonly run: Runner;
  /** A long-running child, on this terminal. See InteractiveRunner. */
  readonly runInteractive: InteractiveRunner;
  /** The instant this invocation reasons about. Read once per verb, not per row. */
  readonly now: () => Date;
  readonly env: Readonly<Record<string, string | undefined>>;
  /**
   * `process.platform`'s value for THIS invocation -- `darwin`, `linux`,
   * `win32`. Injected so a host refusal is provable on every CI lane rather
   * than only on the lane that happens to be the host.
   */
  readonly platform: NodeJS.Platform;
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

/**
 * The interactive runner. Nothing is captured and nothing is parsed: the child
 * owns the terminal until it exits.
 *
 * SIGINT IS FORWARDED BY THE TERMINAL, NOT BY NEN -- and nen's job is to stay
 * alive long enough to report what happened. A Ctrl-C at an interactive child
 * goes to the whole foreground process group, so the child already has it; what
 * would otherwise happen is that node's DEFAULT SIGINT handler kills nen too,
 * mid-`spawnSync`, so the developer gets no exit line and no `--json` object for
 * a run they deliberately stopped. Installing a no-op handler for the duration
 * suppresses that default while changing nothing about what the child receives,
 * and the handler is removed in a `finally` so a later verb in the same process
 * is not left un-interruptible.
 */
export const spawnInteractiveRunner: InteractiveRunner = (
  command,
  args,
  options = {},
): InteractiveResult => {
  const holdSigint = (): void => {};
  process.on("SIGINT", holdSigint);
  try {
    const result = spawnSync(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { env: { ...process.env, ...options.env } as NodeJS.ProcessEnv }),
      stdio: "inherit",
    });
    if (result.error !== undefined) {
      return { code: -1, signal: null, spawnFailed: true };
    }
    const signal = result.signal ?? null;
    return {
      // `status` is null exactly when a signal killed the child. 128 + the
      // signal number is the shell's own convention, and SIGINT is 2; every
      // other signal keeps the same arithmetic rather than collapsing to 1,
      // because "it was killed" and "it failed" are different facts.
      code: result.status ?? (signal === "SIGINT" ? 130 : signal === null ? 1 : 128),
      signal,
      spawnFailed: false,
    };
  } finally {
    // THE CAST IS A TYPING WORKAROUND, NOT A BEHAVIOUR ONE. bun-types declares
    // its own `off(event: "memoryPressure", ...)` on NodeJS.Process, which HIDES
    // the EventEmitter `off` it would otherwise inherit -- so the signal form
    // does not typecheck through `process` itself. Reaching the base interface
    // is the narrowest way to say the thing that is true: process IS an
    // EventEmitter, and this removes the listener installed three lines up.
    (process as NodeJS.EventEmitter).off("SIGINT", holdSigint);
  }
};

export function defaultSeams(): Seams {
  return {
    run: spawnRunner,
    runInteractive: spawnInteractiveRunner,
    now: (): Date => new Date(),
    env: process.env,
    platform: process.platform,
  };
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
