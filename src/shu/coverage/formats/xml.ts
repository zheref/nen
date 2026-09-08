// src/shu/coverage/formats/xml.ts -- the smallest XML reader two of the five
// formats need, and nothing more. Pure: text in, elements out.
//
// WHY A HAND-ROLLED SCANNER AND NOT A LIBRARY. This repository has two runtime
// dependencies and neither parses XML; adding a third to read two attributes
// off a `<counter>` element would put a parser with its own entity-expansion
// and DTD surface on the path that reads a file written by somebody else's
// build. This reader expands five named entities, ignores every processing
// instruction, comment, DOCTYPE and CDATA section, and resolves no external
// anything -- which is the whole reason it is small enough to read.
//
// WHAT IT PRODUCES IS AN ELEMENT LIST WITH ANCESTRY, not a tree, and that is
// what both callers actually want: JaCoCo's totals are `<counter>` elements
// whose PARENT says what they count (`report` for the whole run, `package` for
// one row), and Cobertura's rows are `<line>` elements whose ancestor `<package>`
// says which row they belong to. A tree would be built and then walked back
// down to the same question.
//
// IT IS NOT A VALIDATOR. An unbalanced close tag is ignored rather than
// refused: this reader's job is to answer "what does this file say about
// coverage", and the caller refuses a file that says nothing it recognises --
// one refusal, in the format module, naming the counter or attribute it wanted.

/** One start tag (or self-closing tag), with the tag names enclosing it. */
export interface XmlElement {
  readonly name: string;
  readonly attributes: Readonly<Record<string, string>>;
  /** Enclosing tag names, outermost first. The parent is the last entry. */
  readonly ancestors: readonly string[];
}

const ENTITIES: Readonly<Record<string, string>> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
};

/** The five named entities plus numeric ones. Everything else is left alone. */
export function decodeEntities(text: string): string {
  // The decimal and hex branches match their OWN digit sets rather than
  // sharing one greedy `#x?[0-9a-fA-F]+`: that shared pattern let a decimal
  // reference absorb hex digits (`&#1a;` matched, and `Number.parseInt("1a",
  // 10)` silently parsed just the "1"), decoding to the wrong code point
  // instead of being left alone as this comment promises. Splitting the
  // alternatives means `&#1a;` matches neither and is left untouched by
  // `replace` itself -- no special-casing needed. The hex branch also takes
  // `X` as well as `x`, matching the case the code below has always checked.
  return text.replace(/&(#[0-9]+|#[xX][0-9a-fA-F]+|[a-zA-Z]+);/g, (whole, body: string): string => {
    if (body.startsWith("#")) {
      const isHex = body[1] === "x" || body[1] === "X";
      const code = Number.parseInt(body.slice(isHex ? 2 : 1), isHex ? 16 : 10);
      // Code 0 and the surrogate range (0xD800-0xDFFF) are not valid Unicode
      // scalar values on their own -- `String.fromCodePoint` would still
      // hand back a NUL or a lone surrogate for them -- so both are left
      // alone rather than "decoded" into something no reader wants.
      const isSurrogate = code >= 0xd800 && code <= 0xdfff;
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff && !isSurrogate
        ? String.fromCodePoint(code)
        : whole;
    }
    return ENTITIES[body.toLowerCase()] ?? whole;
  });
}

function readAttributes(source: string): Record<string, string> {
  const attributes: Record<string, string> = {};
  // NAME="VALUE" or NAME='VALUE'. An attribute with no value is skipped rather
  // than recorded as an empty string: no coverage format writes one, and
  // guessing what it meant is not this reader's business.
  for (const match of source.matchAll(/([A-Za-z_:][-A-Za-z0-9_:.]*)\s*=\s*("([^"]*)"|'([^']*)')/g)) {
    const name = match[1];
    const value = match[3] ?? match[4] ?? "";
    if (name !== undefined) attributes[name] = decodeEntities(value);
  }
  return attributes;
}

/**
 * Every start tag in document order, each carrying its ancestor chain.
 *
 * A self-closing tag appears once and encloses nothing, which is what makes
 * `<counter .../>` a child of the element it is written inside rather than of
 * the counter before it.
 */
export function scanXml(text: string): readonly XmlElement[] {
  const elements: XmlElement[] = [];
  const open: string[] = [];
  let index = 0;
  while (index < text.length) {
    const start = text.indexOf("<", index);
    if (start === -1) break;
    // The three things that are not elements, each skipped whole so a `>`
    // inside one of them cannot end a tag that never started.
    if (text.startsWith("<!--", start)) {
      const end = text.indexOf("-->", start + 4);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<![CDATA[", start)) {
      const end = text.indexOf("]]>", start + 9);
      index = end === -1 ? text.length : end + 3;
      continue;
    }
    if (text.startsWith("<?", start) || text.startsWith("<!", start)) {
      const end = text.indexOf(">", start + 2);
      index = end === -1 ? text.length : end + 1;
      continue;
    }
    const end = text.indexOf(">", start + 1);
    if (end === -1) break;
    const body = text.slice(start + 1, end);
    index = end + 1;
    if (body.startsWith("/")) {
      // A close tag pops the matching open tag if there is one. An unbalanced
      // close is ignored: see the header -- this is a reader, not a validator.
      const name = body.slice(1).trim();
      const at = open.lastIndexOf(name);
      if (at !== -1) open.length = at;
      continue;
    }
    const selfClosing = body.endsWith("/");
    const inner = selfClosing ? body.slice(0, -1) : body;
    const name = /^[^\s/>]+/.exec(inner)?.[0];
    if (name === undefined) continue;
    elements.push({
      name,
      attributes: readAttributes(inner.slice(name.length)),
      ancestors: [...open],
    });
    if (!selfClosing) open.push(name);
  }
  return elements;
}

/** The tag one element is written inside, or null at the root. */
export function parentOf(element: XmlElement): string | null {
  return element.ancestors[element.ancestors.length - 1] ?? null;
}

/** An attribute read as a number, or null when it is absent or not one. */
export function numberAttribute(element: XmlElement, name: string): number | null {
  const raw = element.attributes[name];
  if (raw === undefined) return null;
  const value = Number(raw.trim());
  return Number.isFinite(value) ? value : null;
}
