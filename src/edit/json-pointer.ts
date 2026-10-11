// src/edit/json-pointer.ts -- set ONE value in a JSON text, addressed by an
// RFC 6901 JSON pointer, touching no other byte (zheref/nen#338).
//
// TWO EDITS, AND ONLY TWO. An existing SCALAR (a string, a number, a boolean
// or null) is replaced in place; a member an existing OBJECT does not carry is
// added as its last member, in the object's own style (./json-span.ts's
// `insertMember`). Replacing an object or an array, appending to an array
// (`-`) and creating an object on the way are refused: each is a structural
// edit whose formatting this module would have to invent.
//
// EACH MEMBER ON THE PATH ONCE. `JSON.parse` keeps the last of two equal keys;
// a path through an object that repeats the member it names -- or an added
// member the object already repeats -- is refused, because there the value a
// reader sees and the value a reviewer reads can differ.
//
// THE RESULT IS PROVED, NOT ASSUMED. The new text is parsed and compared with
// the old parse with that one value set: any other difference refuses the
// edit. Nothing here touches a disk.

import { insertMember, JsonSpanError, locateJsonValue, memberCount, type JsonStep, type Span } from "./json-span.js";

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
  /** `replace` an existing scalar, or `add` a member the object did not carry. */
  readonly op: "replace" | "add";
  /** The value the file holds there now; `undefined` for an `add`. */
  readonly before: JsonScalar | undefined;
  readonly after: unknown;
  /** The whole new text. */
  readonly text: string;
  /** Where the replaced literal sat in the ORIGINAL text, or where the added member sits in the NEW one. */
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
  const shown = (count: number): string => formatPointer(segments.slice(0, count)) || "(root)";
  for (const [position, segment] of segments.entries()) {
    const last = position === segments.length - 1;
    if (Array.isArray(node)) {
      if (segment === "-") throw new JsonSpanError(`${shown(position)} is an array, and appending to one ('-') is not an edit this verb makes`);
      if (!INDEX.test(segment)) throw new JsonSpanError(`${shown(position)} is an array, and '${segment}' is not an index`);
      const index = Number(segment);
      if (index >= node.length) throw new JsonSpanError(`${shown(position + 1)} is past the end of the array at ${shown(position)} (${node.length} item(s)); adding to an array is not an edit this verb makes`);
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
  let before: JsonScalar | undefined;
  if (node === undefined) {
    op = "add";
    before = undefined;
    const parent = locateJsonValue(text, parentSteps);
    const inserted = insertMember(text, parent.start, String(finalStep), literal);
    next = inserted.text;
    span = inserted.span;
  } else {
    if (!isScalar(node)) {
      throw new JsonSpanError(`${formatPointer(segments)} holds ${Array.isArray(node) ? "an array" : "an object"}; this verb replaces a scalar (a string, a number, a boolean or null) or adds a member, never a whole structure`);
    }
    op = "replace";
    before = node;
    span = locateJsonValue(text, steps);
    next = `${text.slice(0, span.start)}${literal}${text.slice(span.end)}`;
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
  const changed = op === "add" || JSON.stringify(before) !== literal;
  const line = (op === "add" ? next : text).slice(0, span.start).split("\n").length;
  return { op, before, after: JSON.parse(literal) as unknown, text: changed ? next : text, span, line, changed };
}
