// src/edit/json-pointer.ts -- set ONE value in a JSON text, addressed by an
// RFC 6901 JSON pointer, touching no other byte (zheref/nen#338).
//
// FOUR EDITS, AND ONLY FOUR. An existing SCALAR (a string, a number, a
// boolean or null) is replaced in place; a member an existing OBJECT does not
// carry is added as its last member, in the object's own style
// (./json-span.ts's `insertMember`); an item is APPENDED to an existing array
// by a final `-` (RFC 6901's "past the end", as JSON Patch's `add` reads it),
// in the array's own style (`insertItem`); and an existing OBJECT or ARRAY is
// REPLACED WHOLE by a value of the same kind, written in the layout the old
// value had -- expanded when it spanned lines, inline when it did not -- in
// the document's own indentation, line break and colon (`renderJson`)
// (zheref/nen#587). Changing a value's kind (a scalar for a structure, an
// object for an array, or the reverse), inserting before an index, and
// creating an object on the way are refused: each changes the document's
// shape in a way a reviewer reads as more than one edit.
//
// EACH MEMBER ON THE PATH ONCE. `JSON.parse` keeps the last of two equal keys;
// a path through an object that repeats the member it names is refused,
// because there the value a reader sees and the value a reviewer reads can
// differ. (A member that is added is, by definition, carried by its object
// zero times, so the rule has nothing to say about it.)
//
// THE RESULT IS PROVED, NOT ASSUMED. The new text is parsed and compared with
// the old parse with that one value set: any other difference refuses the
// edit. Nothing here touches a disk.

import { insertItem, insertMember, JsonSpanError, layoutAt, locateJsonValue, memberCount, objectMembers, renderJson, type JsonStep, type Span } from "./json-span.js";

/** Thrown for a pointer that is not RFC 6901 syntax: a usage error, not a fact about the file. */
export class JsonPointerSyntaxError extends Error {}

/**
 * The unescaped segments of an RFC 6901 pointer. `""` (the whole document) is
 * returned as `[]`; a pointer that does not start with `/`, or carries a `~`
 * not followed by `0` or `1`, is refused.
 */
export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) {
    throw new JsonPointerSyntaxError(`'${pointer}' is not a JSON pointer: one starts with '/' (RFC 6901), e.g. /coverage/minimum`);
  }
  return pointer
    .slice(1)
    .split("/")
    .map((segment): string => {
      if (/~(?![01])/.test(segment)) {
        throw new JsonPointerSyntaxError(`'${pointer}' carries a '~' that is not '~0' or '~1' (RFC 6901 escapes '~' as ~0 and '/' as ~1)`);
      }
      return segment.replace(/~1/g, "/").replace(/~0/g, "~");
    });
}

/** The pointer for `segments`, escaped. */
export function formatPointer(segments: readonly string[]): string {
  return segments.map((segment): string => `/${segment.replace(/~/g, "~0").replace(/\//g, "~1")}`).join("");
}

const INDEX = /^(0|[1-9][0-9]*)$/;

export type JsonScalar = string | number | boolean | null;

export function isScalar(value: unknown): value is JsonScalar {
  return value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export interface PointerEdit {
  /** `replace` an existing value (a scalar, or a structure by one of its kind), `add` a member the object did not carry, or `append` an item to an array. */
  readonly op: "replace" | "add" | "append";
  /** The value the file holds there now; `undefined` for an `add` or an `append`. */
  readonly before: unknown;
  /** The segments of the value written: the given ones, with an append's `-` resolved to the new item's index. */
  readonly segments: readonly string[];
  readonly after: unknown;
  /** The whole new text. */
  readonly text: string;
  /** Where the replaced value sat in the ORIGINAL text, or where the added member or appended item sits in the NEW one. */
  readonly span: Span;
  /** The 1-based line of that span, for a human report. */
  readonly line: number;
  /** Whether the document changes at all (a replace with an equal value does not). */
  readonly changed: boolean;
}

/**
 * Set the value at `segments` in the JSON `text` to `value` (spliced as
 * `JSON.stringify(value)`), under the rules in this file's header. Throws
 * `JsonSpanError` with the reason on any refusal.
 */
export function setJsonPointer(text: string, segments: readonly string[], value: unknown): PointerEdit {
  if (segments.length === 0) throw new JsonSpanError("the pointer names the whole document; name one member to set");
  const literal = JSON.stringify(value);
  if (literal === undefined) throw new JsonSpanError("the value is not JSON");
  const document = JSON.parse(text) as unknown;

  // WALK THE PARSE to turn segments into steps and learn every container's kind.
  const steps: JsonStep[] = [];
  let node: unknown = document;
  let appending = false;
  const shown = (count: number): string => formatPointer(segments.slice(0, count)) || "(root)";
  for (const [position, segment] of segments.entries()) {
    const last = position === segments.length - 1;
    if (Array.isArray(node)) {
      if (segment === "-") {
        if (!last) throw new JsonSpanError(`${shown(position + 1)} names the item past the end of ${shown(position)}, which does not exist yet; only a LAST '-' appends`);
        steps.push(node.length);
        node = undefined;
        appending = true;
        continue;
      }
      if (!INDEX.test(segment)) throw new JsonSpanError(`${shown(position)} is an array, and '${segment}' is not an index`);
      const index = Number(segment);
      if (index >= node.length) throw new JsonSpanError(`${shown(position + 1)} is past the end of the array at ${shown(position)} (${node.length} item(s)); append with ${formatPointer([...segments.slice(0, position), "-"])}`);
      steps.push(index);
      node = node[index];
      continue;
    }
    if (!isObject(node)) {
      throw new JsonSpanError(`${shown(position)} is ${node === null ? "null" : typeof node}, not an object or an array, so it has no '${segment}'`);
    }
    steps.push(segment);
    if (!Object.prototype.hasOwnProperty.call(node, segment)) {
      if (!last) throw new JsonSpanError(`${shown(position + 1)} does not exist; only the LAST step may name a member that is not there yet, and only in an existing object`);
      node = undefined;
      continue;
    }
    node = node[segment];
  }

  // EACH MEMBER ON THE PATH ONCE, checked on the TEXT (the parse has already collapsed repeats).
  for (const [position, step] of steps.entries()) {
    if (typeof step === "number") continue;
    const parent = locateJsonValue(text, steps.slice(0, position));
    if (memberCount(text, parent.start, step) > 1) {
      throw new JsonSpanError(`${shown(position)} carries '${step}' more than once; JSON.parse keeps only the last, so the file must be fixed by hand first`);
    }
  }

  const parentSteps = steps.slice(0, -1);
  const finalStep = steps[steps.length - 1] as JsonStep;
  let next: string;
  let span: Span;
  let op: PointerEdit["op"];
  let before: unknown;
  let after: string = literal;
  const structure = value !== null && typeof value === "object";
  if (appending) {
    op = "append";
    before = undefined;
    const parent = locateJsonValue(text, parentSteps);
    const inserted = insertItem(text, parent.start, (layout): string => (after = renderJson(value, layout)), structure);
    next = inserted.text;
    span = inserted.span;
  } else if (node === undefined) {
    op = "add";
    before = undefined;
    const parent = locateJsonValue(text, parentSteps);
    const inserted = insertMember(text, parent.start, String(finalStep), literal);
    next = inserted.text;
    span = inserted.span;
  } else {
    const kind = (held: unknown): string => (Array.isArray(held) ? "an array" : held !== null && typeof held === "object" ? "an object" : "a scalar");
    if (kind(node) !== kind(value)) {
      throw new JsonSpanError(
        `${formatPointer(segments)} holds ${kind(node)}, and replacing it with ${kind(value)} changes its kind, which this verb never does; it replaces a scalar by a scalar, an object by an object and an array by an array${Array.isArray(node) ? `, and appends with ${formatPointer([...segments, "-"])}` : ""}`,
      );
    }
    op = "replace";
    before = node;
    span = locateJsonValue(text, steps);
    if (structure) {
      const old = text.slice(span.start, span.end);
      // An EMPTY old structure has no layout of its own: it takes the document's, as an added member or appended item does.
      const empty = old.replace(/\s/g, "").length === 2;
      const expanded = old.includes("\n") || (empty && text.trimEnd().includes("\n"));
      after = renderJson(value, layoutAt(text, span.start, expanded, Array.isArray(node) ? [] : objectMembers(text, span.start)));
      // AN INLINE STRUCTURE KEEPS ITS BRACKETS' INNER SPACE (`{ "a": 1 }`), as an added member does.
      const pad = expanded ? "" : (/^[[{]([ \t]*)/.exec(old)?.[1] ?? "");
      if (pad !== "" && after.length > 2) after = `${after.charAt(0)}${pad}${after.slice(1, -1)}${pad}${after.charAt(after.length - 1)}`;
    }
    next = `${text.slice(0, span.start)}${after}${text.slice(span.end)}`;
  }

  // THE PROOF: the new text parses to the old document with that one value set.
  const expected = JSON.parse(text) as unknown;
  let holder: unknown = expected;
  for (const step of parentSteps) holder = (holder as Record<string | number, unknown>)[step];
  (holder as Record<string | number, unknown>)[finalStep] = JSON.parse(literal) as unknown;
  let parsed: unknown;
  try {
    parsed = JSON.parse(next) as unknown;
  } catch (error) {
    /* c8 ignore next -- the splice is of a JSON literal at a value or member boundary */
    throw new JsonSpanError(`setting ${formatPointer(segments)} broke the document (${error instanceof Error ? error.message : String(error)})`);
  }
  if (JSON.stringify(parsed) !== JSON.stringify(expected)) {
    /* c8 ignore next -- the scan agrees with JSON.parse; this is the guard against it not */
    throw new JsonSpanError(`setting ${formatPointer(segments)} changed more than that one value`);
  }
  const changed = op !== "replace" || JSON.stringify(before) !== literal;
  const line = (op === "replace" ? text : next).slice(0, span.start).split("\n").length;
  const written = steps.map(String);
  return { op, before, segments: written, after: JSON.parse(literal) as unknown, text: changed ? next : text, span, line, changed };
}
