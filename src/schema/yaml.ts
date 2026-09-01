// src/schema/yaml.ts -- a STRICT, REFUSING reader for the YAML subset the
// taxonomy files are written in.
//
// WHY NOT `yq`. D16 forbids it outright: "no make, no bats/pytest, no runtime
// python3, no jq/yq anywhere in an executed path". A machine gets one binary
// plus git and gh, so a colour lookup cannot shell out to a YAML processor that
// may not be installed and, when it is, may be one of two mutually incompatible
// programs with the same name.
//
// WHY NOT THE `yaml` PACKAGE. It would work and it is a reasonable alternative;
// it is not taken because this repo's whole P1 thesis is a supply chain a human
// can read (bankai-core#740: "a checksum-unverified download is not an
// acceptable end state"), and a full YAML 1.2 implementation is several thousand
// lines of behaviour nobody on this project will ever read, supporting a dozen
// constructs -- anchors, aliases, merge keys, tags, multi-document streams --
// that no taxonomy file uses and that a colour lookup must never be asked to
// resolve. This file is ~250 lines and REFUSES every one of them by name. The
// tradeoff is deliberate and is an open question for review, not a settled
// preference: if the maintainer would rather take the dependency, deleting this
// file and its tests is a mechanical change.
//
// THE SUBSET, exhaustively -- everything else is a LOUD error carrying the line
// number, never a silent skip and never a guess:
//
//   * block mappings, nested by indentation (SPACES only)
//   * block sequences (`- scalar`, `- key: value`)
//   * flow sequences `[a, b]` and flow mappings `{ a: 1, b: 2 }` of scalars
//   * block scalars `|`, `|-`, `|+`, `>`, `>-`, `>+`
//   * double-quoted, single-quoted and plain scalars
//   * `null` / `~` / an empty value -> null; `true`/`false`; numbers
//   * ONE optional leading `---`
//   * `#` comments, on their own line or after a value
//
// REFUSED, each with its own message: anchors (`&`), aliases (`*`), merge keys
// (`<<`), tags (`!`), explicit keys (`?`), directives (`%`), a second document,
// and a TAB anywhere in indentation. A refusal is the correct outcome for all of
// them -- a taxonomy value that depends on alias resolution is a taxonomy value
// two readers will disagree about.
//
// THE INVARIANT THAT MAKES IT SAFE: this parser never invents a value. Every
// path either produces the value the file states or throws naming the line. That
// is the same discipline ../github/parse.ts applies to GitHub's JSON, for the
// same reason -- an absent or unreadable datum must never arrive downstream
// wearing a default's clothes.

export class YamlError extends Error {
  readonly line: number;
  constructor(message: string, line: number) {
    super(`${message} (line ${line})`);
    this.name = "YamlError";
    this.line = line;
  }
}

export type YamlValue =
  | string
  | number
  | boolean
  | null
  | YamlValue[]
  | { [key: string]: YamlValue };

interface Line {
  readonly indent: number;
  readonly text: string;
  readonly number: number;
}

const BLOCK_SCALAR = /^([|>])([+-]?)$/;

export function parseYaml(source: string): YamlValue {
  const raw = source.split(/\r?\n/);
  const lines: Line[] = [];
  let sawDocumentStart = false;

  for (let index = 0; index < raw.length; index += 1) {
    const text = raw[index] ?? "";
    const number = index + 1;
    const trimmed = text.trim();

    if (trimmed === "" || trimmed.startsWith("#")) continue;

    if (trimmed === "---") {
      if (sawDocumentStart) {
        throw new YamlError(
          "a second '---' starts a second document; this reader accepts exactly one document, because a taxonomy file with two of them has two answers to every question",
          number,
        );
      }
      if (lines.length > 0) {
        throw new YamlError(
          "'---' appears after content; this reader accepts it only as the first line of the file",
          number,
        );
      }
      sawDocumentStart = true;
      continue;
    }
    if (trimmed === "...") continue;
    if (trimmed.startsWith("%")) {
      throw new YamlError(
        `YAML directives are not supported ('${trimmed}')`,
        number,
      );
    }

    const indentMatch = /^[ \t]*/.exec(text)?.[0] ?? "";
    if (indentMatch.includes("\t")) {
      throw new YamlError(
        "a TAB appears in this line's indentation; YAML forbids it and different editors render it as different depths, so it is refused rather than guessed at",
        number,
      );
    }
    lines.push({ indent: indentMatch.length, text: text.slice(indentMatch.length), number });
  }

  if (lines.length === 0) return null;

  const cursor = { index: 0 };
  const first = lines[0];
  if (first === undefined) return null;
  const value = parseBlock(lines, cursor, first.indent);
  const leftover = lines[cursor.index];
  if (leftover !== undefined) {
    throw new YamlError(
      `unexpected content at indentation ${leftover.indent}; this reader needs a document whose top level is one mapping or one sequence`,
      leftover.number,
    );
  }
  return value;
}

function parseBlock(lines: readonly Line[], cursor: { index: number }, indent: number): YamlValue {
  const line = lines[cursor.index];
  if (line === undefined) return null;
  return line.text.startsWith("- ") || line.text === "-"
    ? parseSequence(lines, cursor, indent)
    : parseMapping(lines, cursor, indent);
}

function parseSequence(
  lines: readonly Line[],
  cursor: { index: number },
  indent: number,
): YamlValue[] {
  const items: YamlValue[] = [];
  for (;;) {
    const line = lines[cursor.index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError(
        `this line is indented deeper than the sequence it belongs to (${line.indent} > ${indent})`,
        line.number,
      );
    }
    if (!line.text.startsWith("- ") && line.text !== "-") {
      throw new YamlError(
        "expected a '- ' sequence entry at this indentation",
        line.number,
      );
    }
    const inline = line.text === "-" ? "" : line.text.slice(2).trim();
    cursor.index += 1;

    if (inline === "") {
      items.push(parseNested(lines, cursor, indent));
      continue;
    }
    // `- key: value` opens a mapping whose FIRST key sits on the dash's own
    // line. Re-reading it as a mapping line at `indent + 2` is what YAML
    // specifies, and the synthetic line keeps the real line NUMBER so an error
    // inside it still points at the right place in the file.
    if (splitKey(inline) !== null) {
      const synthetic: Line[] = [{ indent: indent + 2, text: inline, number: line.number }];
      const rest = lines.slice(cursor.index);
      const merged = [...synthetic, ...rest];
      const innerCursor = { index: 0 };
      items.push(parseMapping(merged, innerCursor, indent + 2));
      cursor.index += innerCursor.index - 1;
      continue;
    }
    items.push(parseScalar(inline, line.number));
  }
  return items;
}

function parseMapping(
  lines: readonly Line[],
  cursor: { index: number },
  indent: number,
): Record<string, YamlValue> {
  const map: Record<string, YamlValue> = {};
  for (;;) {
    const line = lines[cursor.index];
    if (line === undefined || line.indent < indent) break;
    if (line.indent > indent) {
      throw new YamlError(
        `this line is indented deeper than the mapping it belongs to (${line.indent} > ${indent})`,
        line.number,
      );
    }
    if (line.text.startsWith("- ")) break;

    const split = splitKey(line.text);
    if (split === null) {
      throw new YamlError(
        `expected 'key: value' or 'key:' at this indentation, got '${line.text}'`,
        line.number,
      );
    }
    const { key, rest } = split;
    if (key === "<<") {
      throw new YamlError(
        "merge keys ('<<') are not supported -- a taxonomy value assembled by merge is a value two readers can disagree about",
        line.number,
      );
    }
    if (Object.prototype.hasOwnProperty.call(map, key)) {
      throw new YamlError(
        `duplicate key '${key}'; the later value would silently win, so this is refused`,
        line.number,
      );
    }
    cursor.index += 1;

    const blockScalar = BLOCK_SCALAR.exec(rest);
    if (blockScalar !== null) {
      map[key] = readBlockScalar(lines, cursor, indent, blockScalar[1] ?? ">", blockScalar[2] ?? "");
      continue;
    }
    map[key] = rest === "" ? parseNested(lines, cursor, indent) : parseScalar(rest, line.number);
  }
  return map;
}

// The value of a `key:` with nothing after it: the nested block if one follows
// at a deeper indentation, otherwise `null`.
function parseNested(
  lines: readonly Line[],
  cursor: { index: number },
  indent: number,
): YamlValue {
  const next = lines[cursor.index];
  if (next === undefined || next.indent <= indent) return null;
  return parseBlock(lines, cursor, next.indent);
}

// `|`/`>` with an optional chomping indicator. The content is every following
// line indented deeper than the key.
//
// `>` FOLDS on blank lines and joins the rest with single spaces -- which is how
// every `means:`/`scope:` paragraph in a colours file is written, and reading it
// literally would put newlines into a one-line label.
function readBlockScalar(
  lines: readonly Line[],
  cursor: { index: number },
  indent: number,
  style: string,
  chomp: string,
): string {
  const collected: string[] = [];
  let contentIndent: number | null = null;
  for (;;) {
    const line = lines[cursor.index];
    if (line === undefined || line.indent <= indent) break;
    contentIndent ??= line.indent;
    if (line.indent < contentIndent) break;
    collected.push(" ".repeat(line.indent - contentIndent) + line.text);
    cursor.index += 1;
  }

  // Blank lines were dropped during tokenization, so a folded scalar's paragraph
  // breaks are not recoverable. That is a documented limitation of the subset
  // rather than a silent one: every taxonomy string this reader is pointed at is
  // a single paragraph, and a multi-paragraph one would come back joined. It is
  // asserted by test rather than left to be discovered.
  const body = style === "|" ? collected.join("\n") : collected.join(" ");
  if (chomp === "+") return `${body}\n`;
  if (chomp === "-") return body;
  return body === "" ? "" : `${body}\n`;
}

// Split `key: value` at the first `:` that is followed by a space or ends the
// line, skipping colons inside quotes and inside flow collections.
//
// THE COLON-SPACE RULE IS LOAD-BEARING, not pedantry: `label:
// bankai:severity/critical` is a key `label` whose VALUE contains a colon, and a
// reader that split on the first `:` would produce the key `label` and the value
// `severity/critical` -- a taxonomy value silently truncated at a character the
// taxonomy itself uses as a namespace separator.
export function splitKey(text: string): { key: string; rest: string } | null {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === ":" && depth === 0) {
      const next = text[index + 1];
      if (next === undefined || next === " ") {
        const key = unquote(text.slice(0, index).trim());
        return { key, rest: stripComment(text.slice(index + 1)).trim() };
      }
    }
  }
  return null;
}

// Remove a trailing `# comment`, respecting quotes. A `#` that is not preceded
// by whitespace is part of the value -- which is exactly the case that matters
// here, because every colour is written `hex: "#0e8a16"` and an over-eager
// stripper would turn the palette into empty strings.
function stripComment(text: string): string {
  let quote: string | null = null;
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (quote !== null) {
      if (char === "\\" && quote === '"') index += 1;
      else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") quote = char;
    else if (char === "[" || char === "{") depth += 1;
    else if (char === "]" || char === "}") depth -= 1;
    else if (char === "#" && depth === 0) {
      const previous = text[index - 1];
      if (previous === undefined || previous === " " || previous === "\t") {
        return text.slice(0, index);
      }
    }
  }
  return text;
}

function unquote(text: string): string {
  if (text.length >= 2 && text.startsWith('"') && text.endsWith('"')) {
    return decodeDoubleQuoted(text.slice(1, -1));
  }
  if (text.length >= 2 && text.startsWith("'") && text.endsWith("'")) {
    return text.slice(1, -1).replace(/''/g, "'");
  }
  return text;
}

function decodeDoubleQuoted(body: string): string {
  return body.replace(/\\(u[0-9a-fA-F]{4}|.)/g, (_match, escape: string): string => {
    if (escape.startsWith("u")) return String.fromCharCode(parseInt(escape.slice(1), 16));
    switch (escape) {
      case "n":
        return "\n";
      case "t":
        return "\t";
      case "r":
        return "\r";
      case "0":
        return "\0";
      case "\\":
        return "\\";
      case '"':
        return '"';
      default:
        return escape;
    }
  });
}

export function parseScalar(text: string, line: number): YamlValue {
  const value = stripComment(text).trim();
  if (value === "") return null;

  if (value.startsWith("&") || value.startsWith("*")) {
    throw new YamlError(
      `anchors and aliases are not supported ('${value}') -- a taxonomy value that must be resolved through a reference is a value two readers can disagree about`,
      line,
    );
  }
  if (value.startsWith("!")) {
    throw new YamlError(`tags are not supported ('${value}')`, line);
  }
  if (value.startsWith("?")) {
    throw new YamlError("explicit keys ('? ') are not supported", line);
  }

  if (value.startsWith("[")) return parseFlow(value, line, "]");
  if (value.startsWith("{")) return parseFlow(value, line, "}");

  if (value.startsWith('"') || value.startsWith("'")) {
    const closing = value[value.length - 1];
    if (value.length < 2 || closing !== value[0]) {
      throw new YamlError(`unterminated quoted scalar (${value})`, line);
    }
    return unquote(value);
  }

  if (value === "null" || value === "~" || value === "Null" || value === "NULL") return null;
  if (value === "true" || value === "True" || value === "TRUE") return true;
  if (value === "false" || value === "False" || value === "FALSE") return false;
  if (/^[+-]?\d+$/.test(value)) return Number.parseInt(value, 10);
  if (/^[+-]?(\d+\.\d*|\.\d+)([eE][+-]?\d+)?$/.test(value)) return Number.parseFloat(value);
  return value;
}

// A flow collection of SCALARS ONLY. Nested flow collections are refused rather
// than parsed: no taxonomy file uses one, and the depth-tracking a correct
// implementation needs is the part of a YAML reader that goes subtly wrong.
function parseFlow(text: string, line: number, closing: string): YamlValue {
  if (!text.endsWith(closing)) {
    throw new YamlError(`unterminated flow collection, expected '${closing}'`, line);
  }
  const body = text.slice(1, -1);
  const items = splitFlowItems(body, line);

  if (closing === "]") {
    return items.map((item): YamlValue => parseScalar(item, line));
  }
  const map: Record<string, YamlValue> = {};
  for (const item of items) {
    const split = splitKey(item);
    if (split === null) {
      throw new YamlError(`expected 'key: value' inside a flow mapping, got '${item}'`, line);
    }
    if (Object.prototype.hasOwnProperty.call(map, split.key)) {
      throw new YamlError(`duplicate key '${split.key}' inside a flow mapping`, line);
    }
    map[split.key] = parseScalar(split.rest, line);
  }
  return map;
}

function splitFlowItems(body: string, line: number): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index] ?? "";
    if (quote !== null) {
      current += char;
      if (char === "\\" && quote === '"') {
        current += body[index + 1] ?? "";
        index += 1;
      } else if (char === quote) quote = null;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      current += char;
      continue;
    }
    if (char === "[" || char === "{") {
      throw new YamlError(
        "nested flow collections are not supported; write the inner collection as a block",
        line,
      );
    }
    if (char === ",") {
      items.push(current.trim());
      current = "";
      continue;
    }
    current += char;
  }
  if (quote !== null) throw new YamlError("unterminated quoted scalar in a flow collection", line);
  const last = current.trim();
  if (last !== "") items.push(last);
  else if (items.length > 0) {
    throw new YamlError("a trailing comma leaves an empty flow entry", line);
  }
  return items;
}
