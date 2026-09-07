import { describe, expect, it } from "vitest";
import { parsePipeTable, renderPipeTable, visibleWidth } from "./table.js";

describe("visibleWidth", () => {
  it("counts ASCII as 1 per character", () => {
    expect(visibleWidth("abc")).toBe(3);
  });

  it("counts an emoji as 2", () => {
    expect(visibleWidth("🟢")).toBe(2);
  });

  it("does not count a variation selector", () => {
    expect(visibleWidth("✅️")).toBe(2);
  });
});

describe("parsePipeTable / renderPipeTable", () => {
  it("drops the separator row and pads columns to the widest visible cell", () => {
    const rows = parsePipeTable(
      "| a | bb |\n| --- | --- |\n| 🟢 | x |\n",
    );
    expect(rows).toEqual([
      ["a", "bb"],
      ["🟢", "x"],
    ]);
    const rendered = renderPipeTable(rows);
    // "🟢" is visible-width 2, so its column floors at 3 (the markdown minimum),
    // and every data row in that column pads to 3.
    expect(rendered[0]).toBe("| a   | bb  |");
    expect(rendered[1]).toBe("| --- | --- |");
    expect(rendered[2]).toBe("| 🟢  | x   |");
  });

  it("floors every column at 3 even for single-character content", () => {
    const rendered = renderPipeTable([["h"], ["x"]]);
    expect(rendered).toEqual(["| h   |", "| --- |", "| x   |"]);
  });

  it("evens ragged rows with empty cells", () => {
    const rendered = renderPipeTable([["a", "b"], ["only"]]);
    expect(rendered[2]).toBe("| only |     |");
  });

  it("returns nothing for no rows", () => {
    expect(renderPipeTable([])).toEqual([]);
  });
});

// zheref/nen#10 item 2. `nen board render` PRODUCES the table `nen stop`
// RE-PARSES, so the two functions have to be each other's inverse: a PR title
// carrying a `|` used to split into an extra cell and shift every later
// column, silently, in both the rendered board and `nen stop --json`.
describe("parsePipeTable / renderPipeTable round-trip an escaped pipe (zheref/nen#10)", () => {
  const CASES: ReadonlyArray<readonly [string, readonly (readonly string[])[]]> = [
    ["a pipe in a cell", [["Effort", "Refs"], ["feat: a | b", "XX-PR-#7"]]],
    ["a pipe in the HEADER", [["a | b", "c"], ["1", "2"]]],
    ["a backslash with no pipe", [["h1", "h2"], ["C:\\path\\to", "x"]]],
    ["a cell that is already `\\|`", [["h1", "h2"], ["a\\|b", "x"]]],
    ["a trailing backslash", [["h1", "h2"], ["ends\\", "x"]]],
    ["several pipes and an empty cell", [["h1", "h2", "h3"], ["a|b|c", "", "d"]]],
    ["a lone pipe", [["h1", "h2"], ["|", "x"]]],
  ];

  for (const [name, rows] of CASES) {
    it(`round-trips ${name}`, () => {
      const rendered = renderPipeTable(rows).join("\n");
      expect(parsePipeTable(rendered)).toEqual(rows.map((row): string[] => [...row]));
    });
  }

  it("writes a literal pipe as markdown's `\\|` so the column count is preserved", () => {
    const rendered = renderPipeTable([["Effort", "Refs"], ["feat: a | b", "XX-PR-#7"]]);
    expect(rendered[2]).toContain("feat: a \\| b");
    // Three DELIMITERS (two columns, opened and closed), not four: the escaped
    // pipe is content. The header row is the reference -- it has no pipe to
    // escape, so its delimiter count is the count this row must match.
    const delimiters = (line: string): number => line.match(/(?<!\\)\|/g)?.length ?? 0;
    expect(delimiters(rendered[2] ?? "")).toBe(3);
    expect(delimiters(rendered[2] ?? "")).toBe(delimiters(rendered[0] ?? ""));
  });

  it("pads a SHORT row to the header's width instead of shifting its columns", () => {
    // A malformed row degrades one cell; the columns to its left stay where
    // the header says they are.
    expect(parsePipeTable("| a | b | c |\n| --- | --- | --- |\n| 1 | 2 |\n")).toEqual([
      ["a", "b", "c"],
      ["1", "2", ""],
    ]);
  });

  it("keeps a genuinely empty LAST column, and a row written without a closing pipe", () => {
    expect(parsePipeTable("| a | b |\n| 1 |   |\n")).toEqual([["a", "b"], ["1", ""]]);
    expect(parsePipeTable("| a | b |\n| 1 | 2\n")).toEqual([["a", "b"], ["1", "2"]]);
  });

  it("keeps an empty last column on a row LONGER than the header, where padding cannot mask it", () => {
    // The two assertions above pass whether the closing delimiter's element is
    // dropped ONCE or in a loop -- a short row's missing cell is put back by
    // the padding, so both spellings agree from outside. A row longer than the
    // header is never padded, so this is the case that actually pins the rule:
    // three cells, the third empty, not two.
    expect(parsePipeTable("| a | b |\n| --- | --- |\n| 1 | 2 |   |\n")).toEqual([
      ["a", "b"],
      ["1", "2", ""],
    ]);
  });

  it("flattens a newline in a cell to a space -- LOSSY, and the only lossy case", () => {
    // A markdown table row is one line by definition, so a raw `\n` in a cell
    // used to end the row mid-table: `nen stop --json` came back with three
    // blank fields for a four-column board row and no error anywhere. The
    // round trip returns the title with the break replaced by a space, which
    // is the honest answer rather than the silent one.
    const rendered = renderPipeTable([["Effort", "Refs"], ["feat: a\nb", "XX-PR-#7"]]);
    expect(rendered).toHaveLength(3); // header, separator, ONE data row
    expect(rendered[2]).toContain("feat: a b");
    expect(rendered.every((line): boolean => !line.includes("\n"))).toBe(true);
    expect(parsePipeTable(rendered.join("\n"))).toEqual([
      ["Effort", "Refs"],
      ["feat: a b", "XX-PR-#7"],
    ]);
  });

  it("flattens a CRLF the same way, and measures the flattened width", () => {
    const rendered = renderPipeTable([["h1", "h2"], ["a\r\nb", "x"]]);
    expect(parsePipeTable(rendered.join("\n"))).toEqual([["h1", "h2"], ["a b", "x"]]);
    // The first column is measured on the FLATTENED cell (`a b`, 3 wide, the
    // markdown floor) rather than on the raw `a\r\nb`, which visibleWidth
    // would have counted as 4 -- so the row is not over-padded by the
    // characters that never reach the output.
    expect(rendered[0]).toBe("| h1  | h2  |");
  });

  it("is byte-identical to the unescaped rendering when no cell holds a pipe", () => {
    // The parity guarantee for every existing caller: escaping is the
    // identity on a table that never needed it.
    const rows = [["Effort", "Refs", "Status (gate)", "Needs"], ["t", "XX-IS-#1", "🟢 ready (G2)", ""]];
    expect(renderPipeTable(rows)).toEqual([
      "| Effort | Refs     | Status (gate) | Needs |",
      "| ------ | -------- | ------------- | ----- |",
      "| t      | XX-IS-#1 | 🟢 ready (G2) |       |",
    ]);
  });
});
