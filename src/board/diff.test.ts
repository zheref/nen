import { describe, expect, it } from "vitest";
import { buildBoard } from "./build.js";
import { diffBoards } from "./diff.js";

function row(id: string, status: string): { id: string; title: string; refs: string[]; gate: string | null; status: string; needs: string | null } {
  return { id, title: `t${id}`, refs: [], gate: null, status, needs: null };
}

describe("diffBoards", () => {
  it("reports no change for identical boards", () => {
    const board = buildBoard("o/r", "t", [row("1", "🟢 ready")]);
    expect(diffBoards(board, board).changed).toBe(false);
  });

  it("reports added and removed rows by id", () => {
    const before = buildBoard("o/r", "t", [row("1", "🟢 ready")]);
    const after = buildBoard("o/r", "t", [row("2", "🟢 ready")]);
    const result = diffBoards(before, after);
    expect(result.rows).toEqual([
      { id: "1", kind: "removed", changes: [] },
      { id: "2", kind: "added", changes: [] },
    ]);
  });

  it("reports a field-level change for the same row id", () => {
    const before = buildBoard("o/r", "t", [row("1", "🟡 blocked")]);
    const after = buildBoard("o/r", "t", [row("1", "🟢 ready")]);
    const result = diffBoards(before, after);
    expect(result.rows).toEqual([
      { id: "1", kind: "changed", changes: [{ field: "status", before: "🟡 blocked", after: "🟢 ready" }] },
    ]);
  });
});
