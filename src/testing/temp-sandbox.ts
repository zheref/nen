// The test run's own temp directory (zheref/nen#635).
//
// `bun run test` creates thousands of `nen-*` directories and most of them are
// never removed (at filing: 194 files call mkdtemp, 85 mention removing one). On the
// self-hosted Windows pool they piled up in the runner service account's
// %TEMP% -- 1.27 million entries -- and the Test step grew past its timeout.
//
// The fix is one place, not 194: vitest's globalSetup (global-setup.ts) opens a
// sandbox directory under the real temp dir, points TMPDIR, TMP and TEMP at it
// for the run, and removes it when the run ends, whether the tests passed,
// failed or threw. os.tmpdir() reads those variables at call time, so every
// test worker and every child process a test spawns lands inside the sandbox.
//
// A run killed outright (SIGKILL, power loss) cannot run its own teardown, so
// the sandbox name carries the owning pid and the next run removes the sandboxes
// whose pid is gone and that have sat untouched for a few minutes (a pid is not
// meaningful across containers sharing one temp volume, and a live run keeps
// touching its sandbox) -- one directory to sweep, never thousands.
import { chmodSync, lstatSync, statSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The three variables os.tmpdir() reads across POSIX (TMPDIR) and Windows (TEMP, then TMP). */
export const TEMP_VARIABLES = ["TMPDIR", "TMP", "TEMP"] as const;

/** Every sandbox directory starts with this, then `<pid>-`. */
export const SANDBOX_PREFIX = "nen-test-run-";

export interface TempSandbox {
  /** The sandbox directory every temp dir of the run is created in. */
  readonly dir: string;
  /**
   * Restores the temp variables, removes the sandbox and returns how many entries tests left in it.
   * A removal that fails (Windows holds a handle open while a worker is still alive) is reported in
   * `error` and never thrown: the next run's sweep takes the directory, and a green suite stays green.
   */
  close(): { leftover: number; error?: string };
}

type Env = Record<string, string | undefined>;

/** True when a process with this pid exists (signal 0 only probes; EPERM means it exists, owned by someone else). */
export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** rm -rf that also removes a tree a test left read-only (a 0o500 directory refuses its own removal). */
export function removeTree(path: string): void {
  try {
    rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    return;
  } catch {
    makeWritable(path);
  }
  rmSync(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

function makeWritable(path: string): void {
  let info;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  try {
    chmodSync(path, info.isDirectory() ? 0o700 : 0o600);
  } catch {
    return;
  }
  if (!info.isDirectory()) return;
  for (const entry of readdirSync(path)) makeWritable(join(path, entry));
}

/** A dead pid's sandbox younger than this is left alone: the pid may be another container's. */
export const STALE_AFTER_MS = 10 * 60 * 1000;

/** Removes the sandboxes under `base` whose owning process is gone and that are older than `minAgeMs`; returns how many it removed. */
export function sweepStaleSandboxes(base: string, alive: (pid: number) => boolean = pidAlive, minAgeMs: number = STALE_AFTER_MS): number {
  let removed = 0;
  let names: string[];
  try {
    names = readdirSync(base);
  } catch {
    return 0;
  }
  for (const name of names) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const pid = Number(/^(\d+)-/.exec(name.slice(SANDBOX_PREFIX.length))?.[1]);
    if (!Number.isInteger(pid) || pid <= 0 || alive(pid)) continue;
    try {
      if (Date.now() - statSync(join(base, name)).mtimeMs < minAgeMs) continue;
      removeTree(join(base, name));
      removed += 1;
    } catch {
      // Someone else's, or held open: leave it for the next run.
    }
  }
  return removed;
}

/**
 * Opens the sandbox under `base` (default: the real temp dir) and binds `env` (default process.env)
 * to it. The previous variable values are put back by `close()`.
 */
export function openTempSandbox(base: string = tmpdir(), env: Env = process.env): TempSandbox {
  mkdirSync(base, { recursive: true });
  sweepStaleSandboxes(base);
  const dir = mkdtempSync(join(base, `${SANDBOX_PREFIX}${process.pid}-`));
  const previous = new Map<string, string | undefined>(TEMP_VARIABLES.map((name) => [name, env[name]]));
  for (const name of TEMP_VARIABLES) env[name] = dir;
  return {
    dir,
    close(): { leftover: number; error?: string } {
      for (const [name, value] of previous) {
        if (value === undefined) delete env[name];
        else env[name] = value;
      }
      let leftover = 0;
      try {
        leftover = readdirSync(dir).length;
      } catch {
        // Already gone.
      }
      try {
        removeTree(dir);
      } catch (error) {
        return { leftover, error: error instanceof Error ? error.message : String(error) };
      }
      return { leftover };
    },
  };
}
