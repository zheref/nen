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
