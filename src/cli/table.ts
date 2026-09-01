// src/cli/table.ts -- the ONE padded-markdown-table renderer, shared by
// `nen stop` (the efforts table) and `nen board render` (the gate board).
//
// PORTED FROM scripts/ichigo_prompt.sh's python3 table emitter (bankai-core#653)
// and scripts/ichigo_board.sh's identical convention. Padding is the ONLY
// transformation: no wrapping (a markdown table row is one line by definition),
// no truncation, no delinking. Padding is insignificant whitespace to a markdown
// parser, so a GUI surface that renders markdown tables sees the same content
// either way, while a plain terminal gets a clean aligned monospace table
// instead of ragged pipes.
//
// WIDTH IS VISIBLE WIDTH, not character count. Every mandated status glyph
// (the colour circles this repository's schemas/colors.yml assigns) is a wide
// codepoint -- an emoji or an East-Asian-wide character -- and measuring it as
// one column is what made the original's borders zigzag (bankai-core#648). This
// is a pragmatic approximation of Unicode East Asian Width (no ICU in a Bun
// binary): emoji and the common CJK/fullwidth ranges count as 2, everything
// else as 1. It will not be exactly right for every codepoint in Unicode, but
// it is right for the glyphs this repository's own schemas emit, which is the
// only alphabet this renderer has to serve.
//
// THE FLOOR OF 3 is markdown's own requirement: a separator row needs at least
// three dashes per column, and a one-character column would otherwise emit
// `| - |`, which several parsers refuse to read as a table (the source's own
// finding). Flooring the COLUMN, not just the separator, keeps every emitted
// line the same display width.
//
// NO COLOUR AND NO HYPERLINK ESCAPES, ever, in this renderer's output. Escape
// codes would corrupt the markdown a caller pastes elsewhere; an object
// reference that wants to be a link is already a markdown link
// (`[label](url)`), which is plain text this renderer treats like any other
// cell.

const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], // Hangul Jamo
  [0x2e80, 0x303e], // CJK radicals, symbols and punctuation
  [0x3041, 0x33ff], // Hiragana .. CJK compatibility
  [0x3400, 0x4dbf], // CJK extension A
  [0x4e00, 0x9fff], // CJK unified ideographs
  [0xa000, 0xa4cf], // Yi
  [0xac00, 0xd7a3], // Hangul syllables
  [0xf900, 0xfaff], // CJK compatibility ideographs
  [0xfe30, 0xfe4f], // CJK compatibility forms
  [0xff00, 0xff60], // Fullwidth forms
  [0xffe0, 0xffe6],
  [0x2600, 0x27bf], // Misc symbols and Dingbats -- ✅ ❌ ⭐ and the rest of this
  // repository's own status-glyph alphabet (schemas/colors.yml) live here.
  [0x2b00, 0x2bff], // Misc symbols and arrows
  [0x1f000, 0x1ffff], // Emoji / symbol blocks (mahjong through flags)
  [0x20000, 0x3fffd], // CJK extension B and beyond
];

function isWide(codePoint: number): boolean {
  return WIDE_RANGES.some(([lo, hi]): boolean => codePoint >= lo && codePoint <= hi);
}

/** Visible width: variation selectors and combining marks count as 0, wide codepoints as 2. */
export function visibleWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const codePoint = char.codePointAt(0) ?? 0;
    // Variation selectors (text/emoji presentation, U+FE0E/FE0F) and the zero
    // width joiner render nothing on their own.
    if (codePoint === 0xfe0e || codePoint === 0xfe0f || codePoint === 0x200d) continue;
    width += isWide(codePoint) ? 2 : 1;
  }
  return width;
}

function pad(cell: string, width: number): string {
  const gap = Math.max(0, width - visibleWidth(cell));
  return cell + " ".repeat(gap);
}

/** A parsed markdown pipe table: header + data rows, separator rows dropped. */
export function parsePipeTable(text: string): string[][] {
  const rows: string[][] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    const cells = line
      .replace(/^\|/, "")
      .replace(/\|$/, "")
      .split("|")
      .map((cell): string => cell.trim());
    if (cells.every((cell): boolean => /^:?-{3,}:?$/.test(cell))) continue; // the separator row
    rows.push(cells);
  }
  return rows;
}

/**
 * Render rows (header first) as a PADDED markdown table. The MINIMUM floor is
 * 3, for markdown's own separator-row requirement.
 */
export function renderPipeTable(rows: readonly (readonly string[])[]): string[] {
  if (rows.length === 0) return [];
  const columnCount = Math.max(...rows.map((row): number => row.length));
  const evened = rows.map((row): string[] => {
    const out = [...row];
    while (out.length < columnCount) out.push("");
    return out;
  });
  const widths = Array.from({ length: columnCount }, (_unused, index): number =>
    Math.max(3, ...evened.map((row): number => visibleWidth(row[index] ?? ""))),
  );
  const emit = (row: readonly string[]): string =>
    `| ${row.map((cell, index): string => pad(cell, widths[index] ?? 3)).join(" | ")} |`;

  const out: string[] = [];
  const header = evened[0];
  if (header === undefined) return out;
  out.push(emit(header));
  out.push(`| ${widths.map((width): string => "-".repeat(width)).join(" | ")} |`);
  for (const row of evened.slice(1)) out.push(emit(row));
  return out;
}
