import { describe, expect, it } from "vitest";
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
});
