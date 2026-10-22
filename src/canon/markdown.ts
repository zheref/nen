// src/canon/markdown.ts -- the Markdown reading that `nen canon lint` and
// `nen ref resolve` share: what a heading, an anchor, a bold paragraph lead and
// a RETIRED block are, so the lint's citation rule and the resolver can never
// disagree about whether a citation lands (zheref/nen#481, zheref/nen#482).
//
// PORTED, NOT REINVENTED. The reading is zheref/hatsu's interim guard
// (scripts/prose_ambiguity_check.mts, HR-13) carried across rule for rule,
// because the guard's fixture is the acceptance criteria of both verbs and a
// second reading of "what is a heading" is exactly the disagreement a port must
// not introduce:
//
//   * CRLF reads as LF; a line number is the file's own, frontmatter included.
//   * YAML frontmatter (`---` ... `---` at line 1) carries no heading, however
//     its folded lines look; each of its lines is a paragraph of kind `front`.
//   * A fenced block (``` or ~~~, closed by a fence of the same character and
//     at least the same length) is source data: no heading, anchor or lead, and
//     no paragraph a rule reads.
//   * An ATX heading (`#` .. `######`) is a heading; its GitHub slug is its
//     anchor, a repeated slug suffixed `-1`, `-2`, ...; `<a id|name="x">` is
//     an explicit anchor wherever it sits outside a fence.
//   * A paragraph's bold lead (`**Lead**` at its start, after an optional list
//     marker or blockquote) is citable by title or by number like a heading.
//   * A RETIRED block -- a `> **RETIRED` quote while lines start with `>`, or a
//     `**RETIRED` paragraph or list item up to the next blank line or heading --
//     records its lines so a rule may exempt them.

/** One paragraph a rule reads: prose, a heading line, a table row or a frontmatter line. */
export interface Para {
  readonly start: number;
  readonly lines: string[];
  text: string;
  readonly kind: "prose" | "heading" | "table" | "front";
}

export interface Doc {
  readonly path: string;
  readonly lines: readonly string[];
  readonly paras: readonly Para[];
  readonly anchors: ReadonlySet<string>;
  /** Heading texts with their 1-based line, in document order. */
  readonly headings: readonly { readonly text: string; readonly line: number; readonly anchor: string }[];
  /** Bold paragraph leads with their 1-based line, in document order. */
  readonly leads: readonly { readonly text: string; readonly line: number }[];
  /** 1-based line numbers inside a RETIRED block. */
  readonly retired: ReadonlySet<number>;
}

/** GitHub's heading slug, as the guard computes it. */
export function slug(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[`*_~]/g, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[^\p{L}\p{N} _-]/gu, "")
    .replace(/ /g, "-");
}

/**
 * The normalised text a baseline row and a title citation compare: links to
 * their text, emphasis and quotes dropped, whitespace folded, lower-cased,
 * leading punctuation and trailing `.:,;` stripped.
 */
export function norm(text: string): string {
  return text
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*`_"“”‘’']/g, "")
    .replace(/…/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}§]+/u, "")
    .replace(/[.:,;]+$/, "");
}

export function parseDoc(path: string, raw: string): Doc {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const paras: Para[] = [];
  const anchors = new Set<string>();
  const headings: { text: string; line: number; anchor: string }[] = [];
  const leads: { text: string; line: number }[] = [];
  const retired = new Set<number>();
  const slugCount = new Map<string, number>();
  let i = 0;
  if (lines[0] === "---") {
    let j = 1;
    while (j < lines.length && lines[j] !== "---") j++;
    for (let k = 1; k < j; k++) {
      const text = lines[k] ?? "";
      paras.push({ start: k + 1, lines: [text], text, kind: "front" });
    }
    i = j + 1;
  }
  let fence: string | null = null;
  let cur: Para | null = null;
  let retiredKind: "quote" | "para" | null = null;
  const flush = (): void => {
    if (cur !== null) {
      cur.text = cur.lines.join("\n");
      paras.push(cur);
      cur = null;
    }
  };
  for (; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const opener = /^\s*(`{3,}|~{3,})/.exec(line);
    if (fence !== null) {
      if (opener !== null && opener[1]?.[0] === fence[0] && (opener[1]?.length ?? 0) >= fence.length && /^\s*[`~]+\s*$/.test(line)) fence = null;
      continue;
    }
    if (opener !== null) {
      flush();
      fence = opener[1] ?? "```";
      continue;
    }
    for (const match of line.matchAll(/<a\s+(?:id|name)="([^"]+)"/g)) anchors.add(match[1] ?? "");
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    if (/^\s*>\s*(?:#+\s*)?\**\s*RETIRED/.test(line)) retiredKind = "quote";
    else if (/^\s*(?:\d+\.\s+|-\s+)?\*\*RETIRED/.test(line)) retiredKind = "para";
    else if (retiredKind === "quote" && !/^\s*>/.test(line)) retiredKind = null;
    else if (retiredKind === "para" && (line.trim() === "" || heading !== null)) retiredKind = null;
    if (retiredKind !== null) retired.add(i + 1);
    if (heading !== null) {
      flush();
      const text = heading[2] ?? "";
      const base = slug(text);
      const n = slugCount.get(base) ?? 0;
      const anchor = n === 0 ? base : `${base}-${n}`;
      anchors.add(anchor);
      slugCount.set(base, n + 1);
      headings.push({ text, line: i + 1, anchor });
      paras.push({ start: i + 1, lines: [line], text: line, kind: "heading" });
      continue;
    }
    if (line.trim() === "") {
      flush();
      continue;
    }
    if (/^\s*\|/.test(line)) {
      flush();
      paras.push({ start: i + 1, lines: [line], text: line, kind: "table" });
      continue;
    }
    if (cur !== null && /^\s*(?:[-*+]|\d+\.)\s+/.test(line)) flush();
    if (cur === null) {
      cur = { start: i + 1, lines: [], text: "", kind: "prose" };
      const lead = /^\s*(?:>\s*)*(?:[-*+]\s+|\d+\.\s+)?\*\*([^*]+?)\*\*/.exec(line);
      if (lead !== null) leads.push({ text: lead[1] ?? "", line: i + 1 });
    }
    (cur as Para).lines.push(line);
  }
  flush();
  return { path, lines, paras, anchors, headings, leads, retired };
}

/** The 1-based line a character offset in a paragraph's joined text falls on. */
export function lineAt(para: Para, offset: number): number {
  let line = para.start;
  let acc = 0;
  for (const text of para.lines) {
    if (offset <= acc + text.length) return line;
    acc += text.length + 1;
    line++;
  }
  return para.start + para.lines.length - 1;
}

/** The section number a heading or lead opens with (`2`, `2a`, `3.1`, `§ 1a`), or null. */
export function headingNumber(heading: string): string | null {
  const match = /^(?:§\s*)?(\d+[a-z]?(?:\.\d+)*)(?=$|[\s.·:)—–-])/.exec(heading.replace(/[*`]/g, "").trim());
  return match === null ? null : (match[1] ?? null);
}

/**
 * Whether a heading or lead answers a `§ *Title*` citation: its normalised
 * text, with or without a leading section number, equals the title or starts
 * with it at a word boundary.
 */
export function titleMatches(candidate: string, title: string): boolean {
  const full = norm(candidate);
  const bare = full.replace(/^(?:§\s*)?\d+[a-z]?(?:\.\d+)*[.·:)]?\s*(?:[·—–-]\s*)?/, "");
  const wanted = norm(title);
  if (wanted === "") return false;
  const prefix = (text: string): boolean => text === wanted || (text.startsWith(wanted) && /^[\s.,:;·—–(-]/.test(text.slice(wanted.length)));
  return prefix(bare) || prefix(full);
}

/** A glob over `/`-separated relative paths: `*` one segment's worth, `**` any depth. */
export function globToRegex(glob: string): RegExp {
  let source = "";
  for (let i = 0; i < glob.length; i++) {
    const ch = glob[i] ?? "";
    if (ch === "*" && glob[i + 1] === "*") {
      source += ".*";
      i++;
      if (glob[i + 1] === "/") {
        source = `${source.slice(0, -2)}(?:.*/)?`;
        i++;
      }
    } else if (ch === "*") source += "[^/]*";
    else source += ch.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${source}$`);
}
