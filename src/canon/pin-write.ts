// src/canon/pin-write.ts -- moving a canon pin is a verb, not an editor
// (zheref/nen#291).
//
// ONE KEY CHANGES, AND NOTHING ELSE. A consumer's `nen/repos.json` is a
// hand-maintained file: its indentation, its key order, its other rows, its
// `$comment`s and its trailing newline are the author's. Parsing it and
// serialising it back would reflow all of that, and the diff a reviewer reads
// for "move the pin" would be the whole file. So the edit is SURGICAL: the
// text is scanned (never re-serialised) to find the byte span of the one
// string value at `maintained_tools[<index>].pinned`, and only that span is
// replaced.
//
// THE SCAN AGREES WITH `JSON.parse` ON DUPLICATES. A JSON object may carry a
// key twice, and `JSON.parse` -- which is how ../schema/repos.ts reads the
// file -- keeps the LAST. The scanner therefore answers with the last member
// of a given name too, at every level, so the span it edits is the value the
// loader reads, not one the loader ignores.
//
// AND THE RESULT IS PROVED, NOT ASSUMED. Before anything touches the disk, the
// new text is parsed and compared with the old parse with that one value
// changed: any other difference -- a scanner bug, an escape the splice broke
// -- refuses the write.
//
// THE WRITE IS ATOMIC: a temporary file in the SAME directory (so the rename
// never crosses a filesystem), flushed, then renamed over the target. A reader
// sees the old file or the new one, never half of either.
//
// WHAT THE RE-CHECKS RELY ON, PER PLATFORM. On POSIX they compare device and
// inode numbers (of the target and of the temporary file) and the
// `realpath.native` of each path. On win32 there is no O_NOFOLLOW and inode
// identity is not reliable, so the re-checks there rely on the
// `realpath.native` comparisons -- the directory and the file still resolve to
// themselves -- and on size and timestamps; they claim nothing more.

import { closeSync, fchmodSync, fstatSync, fsyncSync, ftruncateSync, lstatSync, openSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";
import { containedOn } from "./paths.js";

/** A half-open byte span `[start, end)` of `text`. */
export interface Span {
  readonly start: number;
  readonly end: number;
}

/** One step of a path into a JSON document: an object member's name, or an array index. */
export type JsonStep = string | number;

/** Thrown when the text does not have the shape the path walks. */
export class JsonSpanError extends Error {}

const WS = new Set([" ", "\t", "\n", "\r"]);

function skipWs(text: string, at: number): number {
  let index = at;
  while (index < text.length && WS.has(text.charAt(index))) index += 1;
  return index;
}

/** The index just past the string literal opening at `at` (which must be a `"`). */
function scanString(text: string, at: number): number {
  if (text.charAt(at) !== '"') throw new JsonSpanError(`expected a string at offset ${at}`);
  let index = at + 1;
  while (index < text.length) {
    const char = text.charAt(index);
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === '"') return index + 1;
    index += 1;
  }
  throw new JsonSpanError(`a string opened at offset ${at} is never closed`);
}

/** The index just past the JSON value starting at `at` (whitespace already skipped). */
function scanValue(text: string, at: number): number {
  const char = text.charAt(at);
  if (char === '"') return scanString(text, at);
  if (char === "{" || char === "[") {
    const close = char === "{" ? "}" : "]";
    let index = skipWs(text, at + 1);
    if (text.charAt(index) === close) return index + 1;
    for (;;) {
      if (char === "{") {
        index = skipWs(text, scanString(text, index));
        if (text.charAt(index) !== ":") throw new JsonSpanError(`expected ':' at offset ${index}`);
        index = skipWs(text, index + 1);
      }
      index = skipWs(text, scanValue(text, index));
      const next = text.charAt(index);
      if (next === close) return index + 1;
      if (next !== ",") throw new JsonSpanError(`expected ',' or '${close}' at offset ${index}`);
      index = skipWs(text, index + 1);
    }
  }
  // A number, true, false or null: everything up to the next structural character.
  const literal = /^[^\s,\]}]+/.exec(text.slice(at));
  if (literal === null) throw new JsonSpanError(`expected a value at offset ${at}`);
  return at + literal[0].length;
}

/**
 * How many members named `name` the object whose value starts at `at` carries
 * (Feitan F3): the edit path must name each member once, so a duplicate --
 * which JSON.parse silently collapses to its last -- is refused rather than
 * edited.
 */
export function memberCount(text: string, at: number, name: string): number {
  if (text.charAt(at) !== "{") throw new JsonSpanError(`expected an object at offset ${at} for member '${name}'`);
  let index = skipWs(text, at + 1);
  let count = 0;
  if (text.charAt(index) === "}") return 0;
  for (;;) {
    const keyEnd = scanString(text, index);
    if ((JSON.parse(text.slice(index, keyEnd)) as string) === name) count += 1;
    index = skipWs(text, keyEnd);
    if (text.charAt(index) !== ":") throw new JsonSpanError(`expected ':' at offset ${index}`);
    index = skipWs(text, scanValue(text, skipWs(text, index + 1)));
    if (text.charAt(index) === "}") return count;
    if (text.charAt(index) !== ",") throw new JsonSpanError(`expected ',' or '}' at offset ${index}`);
    index = skipWs(text, index + 1);
  }
}

/** The span of the value `step` selects inside the container whose value starts at `at`. */
function stepInto(text: string, at: number, step: JsonStep): Span {
  const open = text.charAt(at);
  if (typeof step === "number") {
    if (open !== "[") throw new JsonSpanError(`expected an array at offset ${at} for index ${step}`);
    let index = skipWs(text, at + 1);
    let position = 0;
    if (text.charAt(index) === "]") throw new JsonSpanError(`index ${step} is past the end of the array at offset ${at}`);
    for (;;) {
      const end = scanValue(text, index);
      if (position === step) return { start: index, end };
      index = skipWs(text, end);
      if (text.charAt(index) === "]") throw new JsonSpanError(`index ${step} is past the end of the array at offset ${at}`);
      index = skipWs(text, index + 1);
      position += 1;
    }
  }
  if (open !== "{") throw new JsonSpanError(`expected an object at offset ${at} for member '${step}'`);
  let index = skipWs(text, at + 1);
  let found: Span | null = null;
  if (text.charAt(index) === "}") throw new JsonSpanError(`the object at offset ${at} has no member '${step}'`);
  for (;;) {
    const keyEnd = scanString(text, index);
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    index = skipWs(text, keyEnd);
    if (text.charAt(index) !== ":") throw new JsonSpanError(`expected ':' at offset ${index}`);
    const start = skipWs(text, index + 1);
    const end = scanValue(text, start);
    // THE LAST MEMBER OF THE NAME WINS, as it does in JSON.parse.
    if (key === step) found = { start, end };
    index = skipWs(text, end);
    if (text.charAt(index) === "}") break;
    if (text.charAt(index) !== ",") throw new JsonSpanError(`expected ',' or '}' at offset ${index}`);
    index = skipWs(text, index + 1);
  }
  if (found === null) throw new JsonSpanError(`the object at offset ${at} has no member '${step}'`);
  return found;
}

/** The byte span of the value at `path` in the JSON `text`. */
export function locateJsonValue(text: string, path: readonly JsonStep[]): Span {
  let span: Span = { start: skipWs(text, 0), end: text.length };
  for (const step of path) span = stepInto(text, span.start, step);
  return { start: span.start, end: scanValue(text, span.start) };
}

export interface PinEdit {
  /** The pin as the file holds it now. */
  readonly before: string;
  readonly after: string;
  /** The whole file, with only the one value replaced. */
  readonly text: string;
  /** Where in the ORIGINAL text the replaced literal sat. */
  readonly span: Span;
  /** The 1-based line of that literal, for a human report. */
  readonly line: number;
}

/**
 * Replace `maintained_tools[index].pinned` in `text` with `tag`, touching no
 * other byte, and prove it: the new text must parse to the old document with
 * that one value changed. Throws `JsonSpanError` on any disagreement.
 */
export function rewritePin(text: string, index: number, tag: string, source: string): PinEdit {
  const path: readonly JsonStep[] = ["maintained_tools", index, "pinned"];
  // EACH MEMBER ON THE EDIT PATH ONCE (Feitan F3): a repeated
  // `maintained_tools`, or a row repeating `repo` or `pinned`, is a file in
  // which the value a reader sees and the value a reviewer reads can differ.
  const top = skipWs(text, 0);
  if (memberCount(text, top, "maintained_tools") > 1) {
    throw new JsonSpanError("maintained_tools appears more than once; JSON.parse keeps only the last, so the file must be fixed by hand first");
  }
  const rowSpan = locateJsonValue(text, ["maintained_tools", index]);
  for (const member of ["repo", "pinned"]) {
    if (memberCount(text, rowSpan.start, member) > 1) {
      throw new JsonSpanError(`maintained_tools[${index}] carries '${member}' more than once; JSON.parse keeps only the last, so the file must be fixed by hand first`);
    }
  }
  const span = locateJsonValue(text, path);
  const literal = text.slice(span.start, span.end);
  const current: unknown = JSON.parse(literal);
  if (typeof current !== "string") throw new JsonSpanError(`maintained_tools[${index}].pinned is not a string`);
  const next = `${text.slice(0, span.start)}${JSON.stringify(tag)}${text.slice(span.end)}`;

  const expected = JSON.parse(text) as Record<string, unknown>;
  const rows = expected["maintained_tools"];
  if (!Array.isArray(rows)) throw new JsonSpanError("maintained_tools is not an array");
  const row: unknown = rows[index];
  if (row === null || typeof row !== "object" || Array.isArray(row)) throw new JsonSpanError(`maintained_tools[${index}] is not an object`);
  // THE ROW IS THE SOURCE'S (Nobunaga N3): an index that names another tool's
  // row is refused, never edited.
  const repo = (row as Record<string, unknown>)["repo"];
  if (typeof repo !== "string" || repo.toLowerCase() !== source.toLowerCase()) {
    throw new JsonSpanError(`maintained_tools[${index}] is ${typeof repo === "string" ? `'${repo}'` : "a row with no repo"}, not ${source}`);
  }
  if ((row as Record<string, unknown>)["pinned"] !== current) {
    throw new JsonSpanError(`the scanned maintained_tools[${index}].pinned ('${current}') is not the value the parser reads`);
  }
  (row as Record<string, unknown>)["pinned"] = tag;
  if (JSON.stringify(JSON.parse(next)) !== JSON.stringify(expected)) {
    throw new JsonSpanError(`replacing maintained_tools[${index}].pinned changed more than that one value`);
  }
  const line = text.slice(0, span.start).split("\n").length;
  return { before: current, after: tag, text: next, span, line };
}

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
    const landed = lstatSync(target.path);
    if (landed.dev !== opened.dev || landed.ino !== opened.ino) {
      throw new TargetChangedError(`the new text landed elsewhere: ${target.path} is not the file this run wrote after the rename`);
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
