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

import { closeSync, fsyncSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, dirname, join } from "node:path";

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
export function rewritePin(text: string, index: number, tag: string): PinEdit {
  const path: readonly JsonStep[] = ["maintained_tools", index, "pinned"];
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

/**
 * Write `text` to `path` atomically: a temporary file beside the target (the
 * REAL target, when `path` is a symbolic link -- the link survives, and its
 * target is what is replaced), written and flushed, then renamed over it. The
 * target's permission bits carry over. The temporary file is removed on any
 * failure before the rename.
 */
export function writeFileAtomic(path: string, text: string): void {
  const target = realpathSync(path);
  const mode = statSync(target).mode & 0o777;
  const temp = join(dirname(target), `.${basename(target)}.nen-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  const fd = openSync(temp, "wx", mode);
  let renamed = false;
  try {
    try {
      writeFileSync(fd, text, "utf8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, target);
    renamed = true;
  } finally {
    if (!renamed) {
      try {
        unlinkSync(temp);
      } catch {
        // Already gone; the original is untouched either way.
      }
    }
  }
}
