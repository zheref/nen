import { describe, expect, it } from "vitest";
import { parsePipeTable } from "../cli/table.js";
import { buildBoard } from "./build.js";
import { renderBoard } from "./render.js";

describe("renderBoard", () => {
  it("renders a padded markdown table with the gate parenthesized after status", () => {
    const board = buildBoard("o/r", "2026-01-01T00:00:00Z", [
      { id: "1", title: "Effort one", refs: ["XX-IS-#1"], gate: "G2", status: "🟢 ready", needs: null },
    ]);
    const lines = renderBoard(board);
    expect(lines[0]).toBe("o/r -- generated 2026-01-01T00:00:00Z");
    expect(lines.join("\n")).toMatch(/🟢 ready \(G2\)/);
  });

  it("keeps a PIPED title inside its own column (zheref/nen#10 item 2)", () => {
    // A PR title like `feat: a | b` used to split into a fifth cell and shift
    // Refs/Status/Needs one column left of where the header says they are --
    // silently, in the rendered board AND in `nen stop`'s re-parse of it.
    const board = buildBoard("o/r", "2026-01-01T00:00:00Z", [
      { id: "1", title: "feat: a | b", refs: ["XX-PR-#7"], gate: "G2", status: "ready", needs: null },
    ]);
    const rendered = renderBoard(board).slice(2).join("\n");
    expect(rendered).toMatch(/feat: a \\\| b/);
    expect(parsePipeTable(rendered)).toEqual([
      ["Effort", "Refs", "Status (gate)", "Needs"],
      ["feat: a | b", "XX-PR-#7", "ready (G2)", ""],
    ]);
  });
});
