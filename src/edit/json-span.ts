// src/edit/json-span.ts -- where a value sits in a JSON TEXT, without
// re-serialising the text (zheref/nen#338; shared by `canon pin --write` and
// `schema set`). The locator -- `locateJsonValue`, `memberCount` and the scan
// under them -- is moved from ../canon/pin-write.ts without a behavioural
// change; `objectMembers`, `indentUnit` and `insertMember` are new here.
//
// A DECLARATION IS A HAND-MAINTAINED FILE: its indentation, its key order, its
// other members, its `$`-prefixed notes and its trailing newline are the
// author's. Parsing it and serialising it back would reflow all of that, and
// the diff a reviewer reads for "set one value" would be the whole file. So an
// edit is SURGICAL: the text is scanned to find the byte span of one value
// (or the end of one object), and only that span is replaced.
//
// THE SCAN AGREES WITH `JSON.parse` ON DUPLICATES. A JSON object may carry a
// key twice, and `JSON.parse` -- which is how every loader under ../schema
// reads these files -- keeps the LAST. The scanner therefore answers with the
// last member of a given name too, at every level, so the span it edits is the
// value the loader reads, not one the loader ignores. A caller that edits
// still refuses a repeated member on its path (`memberCount`), because there
// the value a reader sees and the value a reviewer reads can differ.
//
// THE SCANNER IS NOT A VALIDATOR. It assumes text `JSON.parse` accepts; a
// caller parses first and proves its splice by parsing again (see
// `setJsonPointer` in ./json-pointer.ts and `rewritePin` in
// ../canon/pin-write.ts).

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

/** The index of the first non-whitespace character at or after `at`. */
export function skipWs(text: string, at: number): number {
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

/** One member of an object, as the text spells it. */
export interface JsonMember {
  readonly key: string;
  /** The span of the key's string literal, quotes included. */
  readonly keySpan: Span;
  /** The span of the member's value. */
  readonly valueSpan: Span;
}

/** Every member of the object whose value starts at `at`, in text order (duplicates included). */
export function objectMembers(text: string, at: number): JsonMember[] {
  if (text.charAt(at) !== "{") throw new JsonSpanError(`expected an object at offset ${at}`);
  const members: JsonMember[] = [];
  let index = skipWs(text, at + 1);
  if (text.charAt(index) === "}") return members;
  for (;;) {
    const keyEnd = scanString(text, index);
    const key = JSON.parse(text.slice(index, keyEnd)) as string;
    const keySpan = { start: index, end: keyEnd };
    index = skipWs(text, keyEnd);
    if (text.charAt(index) !== ":") throw new JsonSpanError(`expected ':' at offset ${index}`);
    const start = skipWs(text, index + 1);
    const end = scanValue(text, start);
    members.push({ key, keySpan, valueSpan: { start, end } });
    index = skipWs(text, end);
    if (text.charAt(index) === "}") return members;
    if (text.charAt(index) !== ",") throw new JsonSpanError(`expected ',' or '}' at offset ${index}`);
    index = skipWs(text, index + 1);
  }
}

/** The line break the text already uses: CRLF when it carries one, else LF. */
function lineBreak(text: string): string {
  return text.includes("\r\n") ? "\r\n" : "\n";
}

/**
 * The text's own indentation unit: a tab when most indented lines start with
 * one, else the smallest positive run of leading spaces, else two spaces.
 */
export function indentUnit(text: string): string {
  let tabs = 0;
  let spaces = 0;
  let smallest = 0;
  for (const line of text.split(/\r?\n/)) {
    const lead = /^[ \t]*/.exec(line)?.[0] ?? "";
    if (lead === "" || lead.length === line.length) continue;
    if (lead.startsWith("\t")) {
      tabs += 1;
      continue;
    }
    spaces += 1;
    if (smallest === 0 || lead.length < smallest) smallest = lead.length;
  }
  if (tabs > spaces) return "\t";
  return smallest === 0 ? "  " : " ".repeat(smallest);
}

/** The leading whitespace of the line `at` sits on. */
function lineIndent(text: string, at: number): string {
  const lineStart = text.lastIndexOf("\n", at - 1) + 1;
  return /^[ \t]*/.exec(text.slice(lineStart, at))?.[0] ?? "";
}

/** How the text separates a key from its value: the first member's own spelling, else `": "`'s tail. */
function colonStyle(text: string, members: readonly JsonMember[]): string {
  const sample = members[0];
  if (sample !== undefined) return text.slice(sample.keySpan.end, sample.valueSpan.start);
  const root = skipWs(text, 0);
  if (text.charAt(root) === "{") {
    const first = objectMembers(text, root)[0];
    if (first !== undefined) return text.slice(first.keySpan.end, first.valueSpan.start);
  }
  return ": ";
}

/** An insertion: the whole new text, and the span the new member occupies in it. */
export interface MemberInsertion {
  readonly text: string;
  readonly span: Span;
}

/**
 * Add `"<key>": <literal>` as the LAST member of the object whose value starts
 * at `at`, written in the object's own style and touching no other byte.
 *
 * A NON-EMPTY OBJECT lends its own spelling: the whitespace around the comma
 * before its last member (or, with one member, after its brace) and the
 * separator between its first member's key and value. AN EMPTY ONE holding
 * spaces on one line (`{ }`) keeps them on both sides of the new member; an
 * empty `{}` is written the way the document is written: expanded, one
 * indentation unit past the line the brace sits on, when the document is
 * multi-line or the braces already hold a line break; inline otherwise. The literal is spliced as given; the caller proves the
 * result by parsing it.
 */
export function insertMember(text: string, at: number, key: string, literal: string): MemberInsertion {
  const members = objectMembers(text, at);
  const close = scanValue(text, at) - 1;
  const colon = colonStyle(text, members);
  const entry = `${JSON.stringify(key)}${colon}${literal}`;
  const last = members[members.length - 1];
  if (last !== undefined) {
    const previous = members[members.length - 2];
    // The object's own comma spacing: the whitespace BEFORE the comma that
    // precedes its last member and the whitespace AFTER it (after the brace,
    // when there is only one member, and nothing before).
    const comma = previous === undefined ? -1 : text.indexOf(",", previous.valueSpan.end);
    const before = previous === undefined ? "" : text.slice(previous.valueSpan.end, comma);
    const opened = text.slice(at + 1, last.keySpan.start);
    // ONE MEMBER, NO COMMA TO COPY, AND THE BRACE HUGS IT (`{"a": 1}`): the
    // colon's own spacing decides -- `, ` after a spaced colon, `,` after a tight one.
    const lead = previous === undefined ? (opened === "" && /:[ \t]+$/.test(colon) ? " " : opened) : text.slice(comma + 1, last.keySpan.start);
    const insert = `${before},${lead}${entry}`;
    const offset = last.valueSpan.end;
    const start = offset + before.length + 1 + lead.length;
    return { text: `${text.slice(0, offset)}${insert}${text.slice(offset)}`, span: { start, end: start + entry.length } };
  }
  const interior = text.slice(at + 1, close);
  // `{ }` KEEPS ITS INNER SPACE, on both sides of the new member, wherever it sits.
  if (interior !== "" && !interior.includes("\n")) {
    const start = at + 1 + interior.length;
    return { text: `${text.slice(0, at + 1)}${interior}${entry}${interior}${text.slice(close)}`, span: { start, end: start + entry.length } };
  }
  const expanded = interior.includes("\n") || text.trimEnd().includes("\n");
  if (!expanded) {
    const start = at + 1;
    return { text: `${text.slice(0, at + 1)}${entry}${text.slice(close)}`, span: { start, end: start + entry.length } };
  }
  const br = lineBreak(text);
  const base = lineIndent(text, at);
  const lead = `${br}${base}${indentUnit(text)}`;
  const start = at + 1 + lead.length;
  return {
    text: `${text.slice(0, at + 1)}${lead}${entry}${br}${base}${text.slice(close)}`,
    span: { start, end: start + entry.length },
  };
}
