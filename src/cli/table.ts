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
//
// A PIPE INSIDE A CELL IS ESCAPED, AND THE PAIR ROUND-TRIPS (zheref/nen#10,
// item 2 -- a defect PRESERVED from the porting source, scripts/
// ichigo_prompt.sh:261, rather than introduced here). These two functions are
// each other's inverse FOR PIPES, and lossy for exactly one other character --
// see the newline paragraph below. `nen board render` PRODUCES the table that
// `nen stop` RE-PARSES, and a PR title like `feat: a | b` used to split into an
// extra cell that shifted every later column -- so the rendered board claimed
// `Refs: b`, `Status: XX-PR-#7`, and `nen stop --json` handed an automated
// caller those wrong values with no error anywhere. `renderPipeTable` now
// writes a literal `|` as markdown's own `\|`, and `parsePipeTable` splits only
// on UNESCAPED pipes and folds `\|` back to `|`.
//
// A NEWLINE INSIDE A CELL IS FLATTENED TO A SPACE, AND THAT IS LOSSY -- the one
// place the pair is NOT an inverse. A markdown table row IS one line by
// definition (this file's own header, two paragraphs up), so there is no
// rendering of a line break that survives the round trip: a raw `\n` written
// into a cell ends the row mid-table, and everything after it parses as
// whatever the leftover text looks like -- for a four-column board row, three
// blank fields out of `nen stop --json` with no error anywhere. Flattening is
// therefore not a choice between lossless and lossy but between LOSSY AND
// VISIBLE (`a b` in one cell) and CORRUPT AND SILENT. The precedent is
// ../shadow/run.ts:328, whose own table emitter has flattened newlines
// alongside its pipe escape from the start. A caller that needs the exact
// original bytes back must not put them through a markdown table.
//
// THE SPACE BEFORE EVERY DELIMITER IS WHAT MAKES THE ESCAPE UNAMBIGUOUS on the
// way back: `emit` always writes `| cell | cell |`, so a cell ENDING in a
// backslash can never sit flush against the delimiter that follows it and be
// misread as escaping it. Only a hand-written table could construct that case,
// and only by writing a trailing backslash with no padding -- which markdown
// itself reads the same ambiguous way.
//
// BACKSLASHES ARE NOT DOUBLED. Escaping only the pipe is the convention the
// issue asks for, and it still round-trips a cell that already contains the two
// characters `\|`: rendering writes `\\|` (backslash, then the escaped pipe),
// and the parse's single left-to-right scan consumes the `\|` at the END of
// that run, handing back `\|` unchanged.

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

/**
 * A literal `|` written as markdown's `\|`, and any newline flattened to a
 * single space, so the cell's content stays INSIDE its cell.
 *
 * THE PAIR WITH parsePipeTable IS AN INVERSE FOR PIPES AND LOSSY FOR NEWLINES:
 * `\|` folds back to `|` exactly, while a `\n` (or `\r\n`) is GONE -- a
 * rendered markdown table row cannot carry a line break, so there is nothing
 * for the parse to fold it back from. See the file header.
 */
export function escapeCell(cell: string): string {
  return cell.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
}

// Split one already-leading-pipe-stripped row on its UNESCAPED delimiters,
// unescaping `\|` back to `|` in the SAME left-to-right pass.
function splitEscapedCells(row: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let index = 0; index < row.length; index += 1) {
    if (row[index] === "\\" && row[index + 1] === "|") {
      cell += "|";
      index += 1; // the backslash is the escape, never content
      continue;
    }
    if (row[index] === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += row[index] ?? "";
  }
  cells.push(cell);
  return cells;
}

/** A parsed markdown pipe table: header + data rows, separator rows dropped. */
export function parsePipeTable(text: string): string[][] {
  const rows: string[][] = [];
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line.startsWith("|")) continue;
    // The leading `|` is punctuation, never an escape (nothing precedes it).
    const raw = splitEscapedCells(line.slice(1));
    // A row's CLOSING delimiter leaves one empty trailing element behind, and
    // EXACTLY ONE is dropped -- never a loop. That is what keeps a genuinely
    // empty last COLUMN (`| a |   |` -> two cells, the second empty): the
    // closing delimiter's element is the one that goes, and the empty column's
    // own element stays. A row written without a closing pipe (`| a | b`)
    // keeps its last cell for the same reason. `length > 1` keeps a lone `|`
    // parsing exactly as it always did.
    //
    // ONLY OBSERVABLE ON A ROW AT LEAST AS LONG AS THE HEADER, which is why
    // the test for it uses a LONGER one: the short-row padding below would
    // otherwise re-add a cell a greedier pop had eaten, and the two spellings
    // would be indistinguishable from outside.
    if (raw.length > 1 && raw[raw.length - 1] === "") raw.pop();
    const cells = raw.map((cell): string => cell.trim());
    if (cells.every((cell): boolean => /^:?-{3,}:?$/.test(cell))) continue; // the separator row
    // SHORT ROWS ARE PADDED TO THE HEADER'S WIDTH so a malformed row degrades
    // one CELL rather than the whole table: an emitted row shorter than the
    // header would otherwise slide every column left of where the header says
    // it is. A row LONGER than the header is left alone -- dropping cells
    // would throw away content, and renderPipeTable already evens up to the
    // widest row it is given.
    const header = rows[0];
    if (header !== undefined) {
      while (cells.length < header.length) cells.push("");
    }
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
  // ESCAPED BEFORE THE WIDTHS ARE MEASURED, because the escape is what gets
  // emitted: measuring the raw cell would under-pad every column holding a
  // pipe by exactly the backslashes it grew, and would measure a newline --
  // which visibleWidth counts as one column and a terminal renders as a line
  // break -- instead of the space it is emitted as.
  const evened = rows.map((row): string[] => {
    const out = row.map((cell): string => escapeCell(cell));
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
