// src/canon/pin-write.ts -- moving a canon pin is a verb, not an editor
// (zheref/nen#291).
//
// ONE KEY CHANGES, AND NOTHING ELSE. A consumer's `nen/repos.json` is a
// hand-maintained file: its indentation, its key order, its other rows, its
// `$comment`s and its trailing newline are the author's. The edit is
// SURGICAL: the text is scanned (never re-serialised) to find the byte span of
// the one string value at `maintained_tools[<index>].pinned`, and only that
// span is replaced.
//
// AND THE RESULT IS PROVED, NOT ASSUMED. Before anything touches the disk, the
// new text is parsed and compared with the old parse with that one value
// changed: any other difference -- a scanner bug, an escape the splice broke
// -- refuses the write.
//
// THE MACHINERY IS SHARED (zheref/nen#338). The raw-text locator lives in
// ../edit/json-span.ts and the checked, atomic write -- containment and
// identity re-checks, the temporary file given its mode by `fchmod`, the
// signal guard -- in ../edit/atomic.ts, where `nen schema set` uses them too.
// They are re-exported below so this module's callers and tests keep their
// imports; what stays here is the pin's own rule.

import { JsonSpanError, locateJsonValue, memberCount, skipWs, type JsonStep, type Span } from "../edit/json-span.js";

export { JsonSpanError, locateJsonValue, memberCount, type JsonStep, type Span } from "../edit/json-span.js";
export {
  guardTempFile,
  TargetChangedError,
  TEMP_PATTERN,
  writeFileAtomic,
  WrittenButUnverifiedError,
  type AtomicHooks,
  type CheckedTarget,
} from "../edit/atomic.js";

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
