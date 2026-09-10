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
// AND A WATCHED PROCESS IS A THIRD SEAM, for the same reason the second one is
// a seam at all. `run` hands back one buffer when the child is already over, so
// a caller cannot ask "has this said anything in the last minute" -- the only
// answer it ever has is "it is over, and here is everything". `runInteractive`
// gives up the output entirely. Neither can carry a stall guard, which is
// arithmetic over the INSTANTS output arrived at, so `runStreamed` is its own
// member: the child's stdout and stderr reach the caller as they arrive, each
// chunk carrying the millisecond it landed on, and a caller may ask to be
// consulted on a fixed interval with the two numbers it would otherwise have to
// keep itself. It answers a PROMISE, because there is no synchronous way to
// watch a process that is still running.
//
// WHAT IT DOES NOT DO IS KILL ANYTHING. The watcher is consulted and its
// verdict is honoured; nen never signals the child it started, on any path, at
// any budget. What to do about a stalled process is the target repository's own
// declared command (../shu/render.ts's `onStall`), spawned through `run` like
// every other declared step, and this seam is only what makes the question
// answerable.
//
// THE HOST PLATFORM IS A SEAM FOR THE SAME REASON THE CLOCK IS. `nen shu` refuses
// a verb whose declaration allows only `darwin` when it is running on `linux`
// (exit 3), and a test that read `process.platform` directly could only prove that
// refusal on the platform it happens to be running on -- so "xcodebuild on linux
// exits 3" and "msbuild on darwin exits 3" would each be provable on exactly one
// of the three CI lanes, which is the same as not being provable at all.
//
// A TCP CONNECT IS A SEAM FOR THE SAME REASON A SUBPROCESS IS, and it is the one
// member here that is ASYNC. `nen shu` asserts a precondition of kind `port` by
// trying to open `127.0.0.1:<port>` -- "is the dev server already up", "is this
// port still free" -- and node offers no synchronous way to ask. Behind a seam,
// a test states the answer it means and proves both directions on every CI lane;
// in front of one, a test would be racing whatever else happens to be listening
// on the machine it runs on, which is the definition of a flake. It answers with
// a THREE-member verdict rather than a boolean, because "nothing answered in
// time" is not "nothing is there": ../shu/run.ts reports a timeout as `satisfied:
// null` -- cannot assert -- exactly as it reports a kind it does not know.

import { spawn, spawnSync } from "node:child_process";
import { connect } from "node:net";
import { constants as osConstants } from "node:os";

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

/**
 * What one attempt to open a TCP connection said.
 *
 * THREE OUTCOMES, NOT TWO, and the third is the one a boolean gets wrong. A
 * refused connection is a POSITIVE fact -- something answered, and it said no
 * -- and it is what "the port is free" looks like on every platform. A timeout
 * is the absence of a fact: a firewall dropping the SYN, a host under load, a
 * listener that accepted and then said nothing. Collapsing the two would let
 * nen report "this port is free" about a port it never actually reached, which
 * is the same lie as reporting an unperformed check as a clean one.
 */
export type PortVerdict = "open" | "refused" | "timeout";

/**
 * Try to open a TCP connection to `127.0.0.1:<port>` and say what happened.
 *
 * LOOPBACK ONLY, AND THE HOST IS NOT A PARAMETER. The precondition this exists
 * for is "is the thing this build needs already running ON THIS MACHINE", and a
 * declaration that could name a host would be a declaration that can make nen
 * connect to an arbitrary address on a repository's say-so. There is no reading
 * and no writing either way: the socket is opened and destroyed.
 */
export type PortProbe = (port: number) => Promise<PortVerdict>;

/**
 * How long a port probe waits before it answers `timeout`.
 *
 * SHORT ON PURPOSE. A loopback connect either completes in microseconds or is
 * refused in microseconds; anything slower than this is a machine that cannot
 * answer the question, and a precondition table is not the place to spend
 * seconds finding that out. Exported so the refusal text and the tests can name
 * the same number rather than two that drift.
 */
export const PORT_PROBE_TIMEOUT_MS = 500;

/**
 * One piece of a watched child's output, with the instant it arrived.
 *
 * A CHUNK IS NOT A LINE, and this seam does not pretend otherwise: a write can
 * split a line in half and two writes can share one. Assembling lines is the
 * caller's, which is also why nothing is EOL-normalized here -- a `\r\n` can
 * straddle two chunks, and normalizing each half separately would leave the
 * stray `\r` this repository's `normalizeEol` exists to remove. A caller that
 * joins chunks and then normalizes complete lines gets the right answer on
 * every host; one that normalized per chunk would not.
 */
export interface StreamedChunk {
  readonly stream: "stdout" | "stderr";
  readonly text: string;
  /** Milliseconds since this child was started, by the seam's own clock. */
  readonly atMs: number;
}

/**
 * The two numbers a watcher decides on: how long the child has been running,
 * and how long it has been silent.
 *
 * BOTH, NEVER ONE. A stall guard that acted on silence alone would kill a
 * healthy compile that legitimately went quiet for a stretch early on, which is
 * the exact mistake the operational canon this exists for calls out by name.
 */
export interface OutputWindow {
  readonly elapsedMs: number;
  readonly quietMs: number;
}

/**
 * What a watcher answers.
 *
 *   * `watch`   -- nothing to do; ask me again next tick.
 *   * `reset`   -- I have just done something about it; start the quiet window
 *     again from now. (Not from the tick's own instant: whatever the watcher
 *     did took time, and that time was not silence anybody should be judged on.)
 *   * `stop`    -- stop asking. The child keeps running and is still waited
 *     for; only the watching ends.
 *   * `abandon` -- stop asking AND stop waiting. The child is left running,
 *     untouched: nen releases its own hold on it (the pipes it was reading and
 *     the reference keeping this process alive) and answers `code: null,
 *     abandoned: true`. This is what "nen never kills what it started" costs on
 *     the one path where waiting forever is the alternative -- a caller that has
 *     spent every remedy the repository declared and is still being told
 *     nothing. It hands the terminal back and says the process is still there.
 */
export type WatchVerdict = "watch" | "reset" | "stop" | "abandon";

/** How often a watcher is consulted when the caller names no interval. */
export const DEFAULT_POLL_MS = 5_000;

export interface StreamedOptions extends Omit<RunOptions, "stdin"> {
  /** Every chunk, as it arrives. Absent: the output is dropped. */
  readonly onOutput?: (chunk: StreamedChunk) => void;
  /**
   * Consulted every `pollMs` while the child is alive. Absent: no timer is
   * created at all, and this runner is a plain streaming spawn.
   */
  readonly onWindow?: (window: OutputWindow) => WatchVerdict;
  readonly pollMs?: number;
}

/** What a watched child answers with. Its output went to `onOutput`. */
export interface StreamedResult {
  /**
   * The child's own exit code (or 128 + the signal's number when killed), and
   * `null` when this runner stopped waiting -- see `abandoned`. Never a
   * sentinel: a caller must branch on the field that says what happened.
   */
  readonly code: number | null;
  readonly signal: string | null;
  /** Same meaning as CommandResult's: the binary could not be started at all. */
  readonly spawnFailed: boolean;
  /** True when the watcher answered `abandon` and the child was left running. */
  readonly abandoned: boolean;
  /** Wall time from spawn to close (or to being abandoned), by the seam's clock. */
  readonly durationMs: number;
}

/**
 * Run a child and WATCH it: output relayed as it arrives, each chunk stamped,
 * and an optional watcher consulted on a fixed interval.
 *
 * It never kills what it started. See this file's header.
 */
export type StreamedRunner = (
  command: string,
  args: readonly string[],
  options?: StreamedOptions,
) => Promise<StreamedResult>;

/**
 * The window arithmetic, in the one place both runners read it from.
 *
 * IT IS SHARED RATHER THAN COPIED because ./scripted.ts replays a timeline
 * against the same rule the real runner applies to a real clock -- and a stall
 * guard tested against a second, hand-written copy of "elapsed" and "quiet"
 * would be tested against a fixture's opinion rather than against the seam.
 */
export function outputWindow(
  startedAtMs: number,
  lastOutputAtMs: number,
  atMs: number,
): OutputWindow {
  return { elapsedMs: atMs - startedAtMs, quietMs: atMs - lastOutputAtMs };
}

export interface Seams {
  readonly run: Runner;
  /** A long-running child, on this terminal. See InteractiveRunner. */
  readonly runInteractive: InteractiveRunner;
  /** A watched child, whose output arrives stamped. See StreamedRunner. */
  readonly runStreamed: StreamedRunner;
  /** One TCP connect against loopback. See PortProbe. */
  readonly probePort: PortProbe;
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
      // `exitCodeOf` below carries the convention -- SIGINT is 2, so a SIGINT
      // kill is 130 -- and it is shared with the streamed runner rather than
      // written twice: two copies of one rule are two rules the day either is
      // touched.
      code: exitCodeOf(result.status ?? null, signal),
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

/**
 * The signal-to-code convention, shared by the two runners that can see one.
 *
 * `status` is null exactly when a signal killed the child; 128 + the signal
 * number is the shell's own convention, and `os.constants.signals` is where
 * node exposes that number rather than this file hand-maintaining a table.
 */
// A signal name the current platform's `os.constants.signals` does not carry
// (there is no such name in practice, but the map is platform-built and not
// guaranteed exhaustive) falls back to the bare 128 rather than throwing: "it
// was killed" is still true even when nen cannot name the number.
function exitCodeOf(status: number | null, signal: NodeJS.Signals | null): number {
  if (status !== null) return status;
  /* c8 ignore next -- a child that reports neither a code nor a signal */
  if (signal === null) return 1;
  return 128 + (osConstants.signals[signal] ?? 0);
}

/**
 * The watched runner. Output is relayed as it arrives; nothing is buffered for
 * a caller to read afterwards, because a caller that wanted the whole buffer
 * wanted `run`.
 *
 * THE TIMER IS CREATED ONLY WHEN SOMEBODY IS WATCHING. A streamed run with no
 * `onWindow` is a plain spawn with its output relayed, and creating an interval
 * nobody reads would keep this process's event loop busy for the length of a
 * build to call a function that does not exist.
 *
 * NOTHING HERE SIGNALS THE CHILD, on any path. A watcher that answers `stop` is
 * answered by ending the WATCHING; the child runs to its own end and is waited
 * for, and the result is its own exit code. See this file's header for why that
 * rule is the seam's and not the caller's.
 */
export const spawnStreamedRunner: StreamedRunner = (command, args, options = {}) =>
  new Promise<StreamedResult>((resolve): void => {
    const startedAt = Date.now();
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined
        ? {}
        : { env: { ...process.env, ...options.env } as NodeJS.ProcessEnv }),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let lastOutputAt = startedAt;
    let timer: NodeJS.Timeout | null = null;
    const stopWatching = (): void => {
      if (timer === null) return;
      clearInterval(timer);
      timer = null;
    };
    const relay =
      (stream: StreamedChunk["stream"]) =>
      (data: Buffer | string): void => {
        const at = Date.now();
        lastOutputAt = at;
        options.onOutput?.({ stream, text: data.toString(), atMs: at - startedAt });
      };
    child.stdout?.on("data", relay("stdout"));
    child.stderr?.on("data", relay("stderr"));

    const onWindow = options.onWindow;
    if (onWindow !== undefined) {
      timer = setInterval((): void => {
        const verdict = onWindow(outputWindow(startedAt, lastOutputAt, Date.now()));
        // AFTER the watcher returned, not at the tick it was asked on: whatever
        // it did (spawning a declared remedy, say) took time, and counting that
        // time as silence would fire the next verdict early.
        if (verdict === "reset") lastOutputAt = Date.now();
        if (verdict === "stop") stopWatching();
        if (verdict === "abandon") {
          stopWatching();
          // LET GO, DO NOT KILL. `unref` drops the reference that keeps this
          // process alive for the child's sake and destroying the two pipes
          // drops the reads that would keep it alive for the OUTPUT's; the
          // child itself is untouched and keeps running with no parent
          // listening. `child.kill()` is what this repository will not do.
          child.stdout?.destroy();
          child.stderr?.destroy();
          child.unref();
          resolve({
            code: null,
            signal: null,
            spawnFailed: false,
            abandoned: true,
            durationMs: Date.now() - startedAt,
          });
        }
      }, options.pollMs ?? DEFAULT_POLL_MS);
    }

    child.on("error", (error: Error): void => {
      stopWatching();
      options.onOutput?.({ stream: "stderr", text: error.message, atMs: Date.now() - startedAt });
      resolve({
        code: -1,
        signal: null,
        spawnFailed: true,
        abandoned: false,
        durationMs: Date.now() - startedAt,
      });
    });
    // `close` RATHER THAN `exit`: `exit` fires when the process ends and `close`
    // when its pipes are drained, and a caller told the run was over while a
    // last chunk was still in flight would report a build's final line after its
    // own report.
    child.on("close", (status: number | null, signal: NodeJS.Signals | null): void => {
      stopWatching();
      resolve({
        code: exitCodeOf(status, signal),
        signal,
        spawnFailed: false,
        abandoned: false,
        durationMs: Date.now() - startedAt,
      });
    });
  });

/**
 * The real port probe: one loopback connect, destroyed the instant it answers.
 *
 * IT SETTLES EXACTLY ONCE, and the guard is why this is more than four lines.
 * A socket can emit `connect` and then `error`, or `error` and then `close`, and
 * a promise that resolved twice would take whichever raced first -- so the
 * resolution is latched, the timer is cleared on every path, and the socket is
 * destroyed before the verdict is returned rather than left for the event loop
 * to collect (an undestroyed socket keeps this process alive after the verb has
 * printed its report).
 *
 * ECONNREFUSED IS THE ONLY ERROR THAT MEANS `refused`. Every other errno --
 * EHOSTUNREACH, EACCES, EMFILE -- is nen failing to ask rather than the host
 * answering, and reporting one of those as "the port is free" would be a
 * precondition that passes because the check broke.
 */
export const connectProbe: PortProbe = async (port): Promise<PortVerdict> =>
  new Promise<PortVerdict>((resolve): void => {
    const socket = connect({ port, host: "127.0.0.1" });
    let settled = false;
    const finish = (verdict: PortVerdict): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(verdict);
    };
    const timer = setTimeout((): void => finish("timeout"), PORT_PROBE_TIMEOUT_MS);
    // `unref` so a probe in flight never holds the process open on its own; the
    // promise above is what the caller is waiting on.
    if (typeof timer.unref === "function") timer.unref();
    socket.once("connect", (): void => finish("open"));
    socket.once("error", (error: NodeJS.ErrnoException): void =>
      finish(error.code === "ECONNREFUSED" ? "refused" : "timeout"),
    );
  });

export function defaultSeams(): Seams {
  return {
    run: spawnRunner,
    runInteractive: spawnInteractiveRunner,
    runStreamed: spawnStreamedRunner,
    probePort: connectProbe,
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
