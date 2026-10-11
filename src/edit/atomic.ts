// src/edit/atomic.ts -- replacing a file the caller CHECKED, atomically
// (moved from ../canon/pin-write.ts and ../canon/command.ts for zheref/nen#338
// and shared by `canon pin --write` and `schema set`). The checks are those
// #291 shipped; two things are new here: `checkedTarget`, and a failure after
// the rename raising `WrittenButUnverifiedError` instead of
// `TargetChangedError`, so no caller can report it as "nothing was written".
//
// THE READ IS CHECKED: `readChecked` opens the real path without following a
// final symbolic link and records the identity of the file it read. THE WRITE
// IS ATOMIC: a temporary file in the SAME directory (so the rename never
// crosses a filesystem), given its mode explicitly, flushed, then renamed over
// the target. A reader sees the old file or the new one, never half of either.
//
// WHAT THE RE-CHECKS RELY ON, PER PLATFORM. On POSIX they compare device and
// inode numbers (of the target and of the temporary file) and the
// `realpath.native` of each path. On win32 there is no O_NOFOLLOW and inode
// identity is not reliable, so the re-checks there rely on the
// `realpath.native` comparisons -- the directory and the file still resolve to
// themselves -- and on size and timestamps; they claim nothing more.

import { closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync, type Stats } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { containedOn } from "../canon/paths.js";

/** The temporary-file name `writeFileAtomic` writes beside `target`: `.<name>.nen-<pid>-<12 hex>.tmp`. */
export const TEMP_PATTERN = ".<name>.nen-<pid>-<hex>.tmp";

/** The file `writeFileAtomic` may replace, as the caller CHECKED it -- never re-resolved here. */
export interface CheckedTarget {
  /** The real path (symbolic links resolved), contained in `root`. */
  readonly path: string;
  /** The real root it must stay contained in. */
  readonly root: string;
  readonly platform: NodeJS.Platform;
  /** The identity and state of the file as it was read: a replacement or an in-place edit since then is refused. */
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  /**
   * The status-change time as read (Feitan N3): no call can set it, so a
   * same-size edit with the modification time restored -- or a chmod -- is
   * still seen.
   */
  readonly ctimeMs: number;
  /** The permission bits to give the new file. */
  readonly mode: number;
}

/** Thrown when the checked target is no longer what the caller checked. */
export class TargetChangedError extends Error {}

/**
 * Thrown when a check fails AFTER the rename (Nobunaga N3, zheref/nen#338):
 * the new text is on disk -- or somewhere -- so this is never "nothing was
 * written". A caller reports it as written, `read-back-mismatch`, distinct
 * from a `TargetChangedError`, which is always raised before the rename.
 */
export class WrittenButUnverifiedError extends Error {}

/** Test seams: called with the temporary file's path at the two re-check points. */
export interface AtomicHooks {
  readonly afterOpen?: (temp: string) => void;
  readonly beforeRename?: (temp: string) => void;
  readonly afterRename?: (temp: string) => void;
}

/** The signals during which a temporary file is guarded. */
const GUARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

/**
 * Guard `temp` against an interrupt for as long as it exists (Feitan F6).
 * Without a listener, SIGINT kills the process WHERE IT STANDS -- mid-write --
 * and the temporary file is left behind. With one, Node defers the signal to
 * the event loop, so the synchronous write and its own cleanup finish first;
 * the listener then removes anything left and re-raises the signal with the
 * default disposition, so the process still dies of it. Returns the disposer.
 */
export function guardTempFile(temp: string, kill: (pid: number, signal: NodeJS.Signals) => void = (pid, signal) => void process.kill(pid, signal)): () => void {
  const handlers = GUARDED_SIGNALS.map((signal): [NodeJS.Signals, () => void] => {
    const handler = (): void => {
      dispose();
      try {
        unlinkSync(temp);
      } catch {
        // Already removed by the write's own cleanup.
      }
      kill(process.pid, signal);
    };
    return [signal, handler];
  });
  const dispose = (): void => {
    for (const [signal, handler] of handlers) (process as NodeJS.EventEmitter).removeListener(signal, handler);
  };
  const emitter = process as NodeJS.EventEmitter;
  for (const [signal, handler] of handlers) emitter.on(signal, handler);
  return dispose;
}

function assertUnchanged(target: CheckedTarget): void {
  const where = dirname(target.path);
  const fail = (why: string): never => {
    throw new TargetChangedError(`${target.path} changed after it was checked (${why}); refusing to replace it`);
  };
  let realDir: string;
  let realFile: string;
  try {
    realDir = realpathSync.native(where);
    realFile = realpathSync.native(target.path);
  } catch (error) {
    return fail(`it no longer resolves: ${error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.message) : String(error)}`);
  }
  if (realDir !== where) fail(`its directory now resolves to ${realDir}`);
  if (realFile !== target.path) fail(`it now resolves to ${realFile}`);
  if (!containedOn(target.root, target.path, target.platform)) fail(`it is not inside ${target.root}`);
  const now = lstatSync(target.path);
  if (!now.isFile() || now.dev !== target.dev || now.ino !== target.ino) fail("it is another file now");
  if (now.size !== target.size || now.mtimeMs !== target.mtimeMs) fail("it was modified since it was read -- a lost update");
  if (now.ctimeMs !== target.ctimeMs) fail("its status changed since it was read (ctime) -- an edit with its modification time restored, or a chmod");
}

/**
 * The temporary file is still the one this run opened, where it was opened
 * (Feitan N1): its directory still resolves to the target's, and the path
 * still names the file behind `fd`. A directory swapped at the open would
 * otherwise put the temporary file -- and the new text -- outside the
 * repository while the path checks looked at the inside one.
 */
function assertTempInPlace(temp: string, where: string, opened: { readonly dev: number; readonly ino: number }): void {
  let realDir: string;
  try {
    realDir = realpathSync.native(dirname(temp));
  } catch (error) {
    throw new TargetChangedError(`the temporary file's directory no longer resolves (${error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.message) : String(error)}); refusing to write`);
  }
  if (realDir !== where) throw new TargetChangedError(`the temporary file's directory now resolves to ${realDir}, not ${where}; refusing to write`);
  let now;
  try {
    now = lstatSync(temp);
  } catch {
    throw new TargetChangedError(`the temporary file ${temp} is gone; refusing to write`);
  }
  if (!now.isFile() || now.dev !== opened.dev || now.ino !== opened.ino) {
    throw new TargetChangedError(`${temp} is no longer the temporary file this run opened; refusing to write`);
  }
}

/**
 * Write `text` over the CHECKED `target` atomically (Feitan F1): a temporary
 * file beside it, given `target.mode` explicitly (`fchmod`, so the umask
 * cannot narrow it), written and flushed, then renamed over it.
 *
 * THE PATH IS NOT RESOLVED AGAIN HERE. The caller resolved it, checked its
 * containment and recorded the identity of the file it read; this function
 * re-asserts all of that -- the directory and the file still resolve to
 * themselves, the file is still contained, and it is still the same file,
 * unmodified -- and that the temporary file is still the one it opened, in
 * that directory (Feitan N1): once BEFORE any content is written, so a refused
 * run leaves no orphan holding the text, and again right before the rename.
 * The descriptor stays open through the second check, and every failure path
 * truncates it before unlinking, so wherever the file really is, it holds
 * nothing. After the rename the target must be the temporary file's inode, or
 * the write is reported as having landed elsewhere.
 *
 * THE WINDOW THAT REMAINS. Between the last check and `rename(2)` a few
 * microseconds remain in which a path component could be swapped, and a
 * process that wins that race COULD make the rename write outside the
 * repository. Closing it needs `renameat(2)` against a directory descriptor,
 * which Node does not offer. The post-rename identity check reports such a
 * landing; it cannot undo it.
 */
export function writeFileAtomic(target: CheckedTarget, text: string, hooks: AtomicHooks = {}): void {
  const where = dirname(target.path);
  const temp = join(where, `.${basename(target.path)}.nen-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", target.mode);
  const opened = fstatSync(fd);
  const dispose = guardTempFile(temp);
  // ON WIN32 an open file cannot be renamed, so the descriptor is closed just
  // before the rename there; on POSIX it stays open until the rename is done.
  const closeBeforeRename = target.platform === "win32";
  let open = true;
  let renamed = false;
  try {
    // THE MODE IS SET, NOT REQUESTED (Nobunaga N1): open()'s mode is masked
    // by the umask, so a 0664 file would come back 0644.
    fchmodSync(fd, target.mode);
    hooks.afterOpen?.(temp);
    assertTempInPlace(temp, where, opened);
    assertUnchanged(target);
    writeFileSync(fd, text, "utf8");
    fsyncSync(fd);
    hooks.beforeRename?.(temp);
    assertTempInPlace(temp, where, opened);
    assertUnchanged(target);
    if (closeBeforeRename) {
      closeSync(fd);
      open = false;
    }
    renameSync(temp, target.path);
    renamed = true;
    hooks.afterRename?.(temp);
    // EVERY FAILURE FROM HERE ON IS AFTER THE RENAME, so it is never "nothing
    // was written" (Nobunaga N3): a target gone by now is the same report.
    let landed;
    try {
      landed = lstatSync(target.path);
    } catch (error) {
      throw new WrittenButUnverifiedError(`${target.path} does not resolve after the rename (${errnoOf(error)})`);
    }
    if (landed.dev !== opened.dev || landed.ino !== opened.ino) {
      throw new WrittenButUnverifiedError(`the new text landed elsewhere: ${target.path} is not the file this run wrote after the rename`);
    }
  } finally {
    if (!renamed) {
      if (open) {
        try {
          ftruncateSync(fd, 0);
        } catch {
          // Nothing more can be done through the descriptor.
        }
      }
      try {
        unlinkSync(temp);
      } catch {
        // Already gone; the original is untouched either way.
      }
    }
    if (open) closeSync(fd);
    // DISPOSED ON THE NEXT TURN, NOT HERE (Feitan N2): this write is
    // synchronous, so a signal that arrived during it is still pending. Were
    // the listener removed now, the pending signal would find none and the
    // process would exit 0; on the next turn it runs the guard's handler,
    // which re-raises it, and the process dies of the signal.
    setImmediate(dispose);
  }
}

/** The errno of a filesystem failure, or its message. */
export function errnoOf(error: unknown): string {
  return error instanceof Error ? ((error as NodeJS.ErrnoException).code ?? error.message) : String(error);
}

/**
 * Read the CHECKED real path, recording the identity of the file read
 * (Feitan F1): opened without following a final symbolic link, and the path
 * re-resolved after the read must still be itself and still that file. A
 * string is the reason it is not.
 */
export function readChecked(real: string): { readonly text: string; readonly stat: Stats } | string {
  let fd: number;
  try {
    fd = openSync(real, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  } catch (error) {
    return `could not be opened as the file that was checked (${errnoOf(error)})`;
  }
  let stat: Stats;
  let text: string;
  try {
    stat = fstatSync(fd);
    text = readFileSync(fd, "utf8");
  } finally {
    closeSync(fd);
  }
  try {
    if (realpathSync.native(real) !== real) return "no longer resolves to itself";
    const now = lstatSync(real);
    if (now.dev !== stat.dev || now.ino !== stat.ino) return "is another file than the one read";
  } catch (error) {
    return `no longer resolves (${errnoOf(error)})`;
  }
  return { text, stat };
}

/** The `CheckedTarget` for a file `readChecked` read at `path`, contained in `root`. */
export function checkedTarget(path: string, root: string, platform: NodeJS.Platform, stat: Stats): CheckedTarget {
  return { path, root, platform, dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, mode: stat.mode & 0o777 };
}
