// src/surface/frontmatter.ts -- split a `---`-fenced markdown document into its
// frontmatter KEYS and its body, and put the kept keys back exactly as they were
// written.
//
// IT IS A LINE FILTER, NOT A YAML ROUND TRIP, and that is the whole design.
// ./mirror.ts's job is "keep two keys, drop the rest"; a parse-then-re-serialize
// would also rewrite the keys it KEEPS -- refold a wrapped `description:` onto
// one line, requote a value, reorder a mapping, normalise a list from block
// style to flow style -- and every one of those is a change to somebody's
// authored text that nobody asked for. Worse, it would do it silently: the
// mirror still loads, so the drift only shows up as an unreadable diff the next
// time the source is edited. So a key OWNS ITS LINES: its own `key:` line plus
// every following line until the next `key:` line or the closing fence, carried
// through verbatim, and dropping a key means dropping exactly those lines.
//
// THE SPLIT IS LOSSLESS. `text.split("\n")` then `join("\n")` reproduces the
// original bytes, a CRLF checkout's trailing `\r` included -- it stays on the
// end of the line it was on, and the body is handed back untouched. Nothing here
// normalises line endings, because the output file is the source file's own
// bytes with a header added and some keys removed (../report/render.ts makes the
// same choice, for the same reason).
//
// A KEY IS `^[A-Za-z0-9_][A-Za-z0-9_.-]*:` AT COLUMN ZERO. Anything else inside
// the fence -- an indented mapping, a `- ` list item, a blank line, a `#`
// comment -- continues the key above it. A continuation line that appears
// BEFORE any key (a leading comment) belongs to no key, so it lands under the
// empty-string key, which no surface's kept-key list can name and which is
// therefore always dropped.

const KEY_LINE = /^([A-Za-z0-9_][A-Za-z0-9_.-]*):/;

/** A frontmatter key together with every line that belongs to it. */
export interface FrontmatterEntry {
  /** The key, or "" for lines that precede the first key. */
  readonly key: string;
  /** The key's own line plus its continuations, verbatim, without line breaks. */
  readonly lines: readonly string[];
}

export interface SplitDocument {
  /** True when the document opened AND closed a `---` fence. */
  readonly hasFrontmatter: boolean;
  /** The entries, in the source's own order. Empty when `hasFrontmatter` is false. */
  readonly entries: readonly FrontmatterEntry[];
  /**
   * Everything after the closing fence, verbatim. With no frontmatter this is
   * the whole document -- so a caller that renders `frontmatter + body` never
   * has to ask which case it is in.
   */
  readonly body: string;
}

/** A `---` fence line, tolerating the `\r` a CRLF checkout leaves on it. */
function isFence(line: string): boolean {
  return line === "---" || line === "---\r";
}

export function splitDocument(text: string): SplitDocument {
  const lines = text.split("\n");
  if (lines.length === 0 || !isFence(lines[0] ?? "")) {
    return { hasFrontmatter: false, entries: [], body: text };
  }
  const close = lines.findIndex((line, index): boolean => index > 0 && isFence(line));
  if (close === -1) {
    // An opening fence with no closing one is not frontmatter -- it is a
    // horizontal rule, or a truncated file. Either way there is no block to
    // filter, and guessing where it ends would silently eat the document.
    return { hasFrontmatter: false, entries: [], body: text };
  }

  const entries: FrontmatterEntry[] = [];
  let current: { key: string; lines: string[] } | null = null;
  for (const line of lines.slice(1, close)) {
    const match = KEY_LINE.exec(line);
    if (match?.[1] !== undefined) {
      if (current !== null) entries.push({ key: current.key, lines: current.lines });
      current = { key: match[1], lines: [line] };
      continue;
    }
    if (current === null) current = { key: "", lines: [] };
    current.lines.push(line);
  }
  if (current !== null) entries.push({ key: current.key, lines: current.lines });

  return { hasFrontmatter: true, entries, body: lines.slice(close + 1).join("\n") };
}

/** The value on a key's own line, trimmed -- enough to tell present from empty. */
export function inlineValue(entry: FrontmatterEntry): string {
  const first = entry.lines[0] ?? "";
  const colon = first.indexOf(":");
  return colon === -1 ? "" : first.slice(colon + 1).trim();
}

/**
 * A key is PRESENT when it appears at all and carries something -- a value on
 * its own line, or at least one continuation line under it (a wrapped
 * `description:`, a block list). `description:` with nothing after it anywhere
 * is an absent description however the YAML reads.
 */
export function hasValue(entries: readonly FrontmatterEntry[], key: string): boolean {
  const entry = entries.find((candidate): boolean => candidate.key === key);
  if (entry === undefined) return false;
  return inlineValue(entry) !== "" || entry.lines.slice(1).some((line): boolean => line.trim() !== "");
}

/**
 * The kept entries rendered back as a fenced block, IN THE SOURCE'S OWN ORDER.
 *
 * Source order rather than the kept-key list's order: the list is a SET of what
 * a surface reads, and reordering an author's frontmatter to match the order
 * somebody happened to type into a table is the same unasked-for rewrite this
 * module exists to avoid.
 */
export function renderFrontmatter(entries: readonly FrontmatterEntry[], keep: ReadonlySet<string>): string {
  const kept = entries.filter((entry): boolean => keep.has(entry.key));
  if (kept.length === 0) return "";
  return `---\n${kept.flatMap((entry): readonly string[] => entry.lines).join("\n")}\n---\n`;
}
