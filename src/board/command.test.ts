import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { boardCommand } from "./command.js";

// NEVER `defaultSeams()` HERE (review finding, src/seam/exec.ts's own header:
// "NO SHIPPED VERB IMPORTS `node:child_process`, and no test in this
// repository makes a network call"). None of board's covered paths spawns
// today, but that safety was incidental rather than structural -- the day
// this verb grows a `gh` call, `defaultSeams()` would silently start issuing
// real subprocess calls from this test rather than failing red. A `run` that
// throws converts that future regression into an immediate, loud test
// failure instead (mirrors src/repo/resolve.test.ts:84).
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding: several family test files
// re-implemented that mapping locally, which can silently drift from the
// real one).
async function capture(argv: readonly string[], repoFlag: string | null): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  const code = await runFamily(boardCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen board build/render/diff", () => {
  it("builds a board from a rows file and renders a padded table", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const rows = join(dir, "rows.json");
    writeFileSync(rows, JSON.stringify([{ id: "1", title: "t", refs: [], gate: "G2", status: "🟢 ready", needs: null }]));
    const result = await capture(["board", "build", "--repo-slug", "o/r", "--rows-from", rows], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/G2/);
  });

  it("diffs two board snapshots", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify({ repo: "o/r", generatedAt: "t", rows: [{ id: "1", title: "t", refs: [], gate: null, status: "a", needs: null }] }));
    writeFileSync(after, JSON.stringify({ repo: "o/r", generatedAt: "t", rows: [{ id: "1", title: "t", refs: [], gate: null, status: "b", needs: null }] }));
    const result = await capture(["board", "diff", "--before", before, "--after", after], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/changed\s+1:/);
  });
});

// #32: a `--rows-from` document was CAST to BoardRow[], never checked, so a
// string `refs` crashed downstream in render.ts as a raw
// "row.refs.join is not a function" TypeError (exit 1) instead of one of this
// CLI's own refusals. These tests pin the boundary: the issue's exact
// fixtures, one guard per field class, and the unchanged --json contract for
// the well-shaped form.
describe("nen board build row-shape validation (#32)", () => {
  // The issue's reproduction, verbatim: `refs` as the single joined string a
  // caller following the field's plural name reaches for first.
  const STRING_REFS_ROW = { id: "AB-IS-#877", title: "sample effort", refs: "AB-IS-#877", gate: "", status: "in_progress", needs: "Triage next move" };

  async function refuse(row: unknown): Promise<{ code: number; message: string }> {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const rows = join(dir, "rows.json");
    writeFileSync(rows, JSON.stringify(Array.isArray(row) ? row : [row]));
    const result = await capture(["board", "build", "--repo-slug", "o/r", "--rows-from", rows, "--json"], dir);
    return { code: result.code, message: result.err.join("\n") };
  }

  it("refuses the issue's string-refs fixture with a refusal, never a TypeError", async () => {
    const { code, message } = await refuse(STRING_REFS_ROW);
    // Exit 2 -- a designed usage refusal -- where the unguarded path exited 1
    // with an uncaught TypeError.
    expect(code).toBe(2);
    // The refusal names the row, the field, the expected shape and what
    // arrived instead.
    expect(message).toMatch(/row 'AB-IS-#877'/);
    expect(message).toMatch(/'refs'/);
    expect(message).toMatch(/ARRAY of ref strings, one per reference/);
    expect(message).toMatch(/one-element array/);
    expect(message).toMatch(/the string 'AB-IS-#877'/);
    // And it is this CLI's own message, not the raw crash the issue reported.
    expect(message).not.toMatch(/is not a function/);
    expect(message).not.toMatch(/TypeError/);
  });

  it("accepts the issue's array-refs fixture unchanged: exit 0 and the identical --json contract", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const rows = join(dir, "rows.json");
    const row = { ...STRING_REFS_ROW, refs: ["AB-IS-#877"] };
    writeFileSync(rows, JSON.stringify([row]));
    const result = await capture(["board", "build", "--repo-slug", "o/r", "--rows-from", rows, "--json"], dir);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toEqual({
      repo: "o/r",
      generatedAt: "2026-01-01T00:00:00.000Z",
      rows: [row],
    });
  });

  it("refuses a document that is not an array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const rows = join(dir, "rows.json");
    writeFileSync(rows, JSON.stringify(STRING_REFS_ROW));
    const result = await capture(["board", "build", "--repo-slug", "o/r", "--rows-from", rows, "--json"], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/must be a JSON ARRAY of BoardRow/);
    expect(result.err.join("\n")).toMatch(/one-element array, never a bare object/);
  });

  it("refuses a non-object element by index", async () => {
    const { code, message } = await refuse(["not a row"]);
    expect(code).toBe(2);
    expect(message).toMatch(/row at index 0 is the string 'not a row', not a BoardRow object/);
  });

  it("refuses a non-string id, naming the row by index since the id is unusable", async () => {
    const { code, message } = await refuse({ ...STRING_REFS_ROW, id: 877, refs: [] });
    expect(code).toBe(2);
    expect(message).toMatch(/row at index 0 needs a string 'id'/);
    expect(message).toMatch(/got a number/);
  });

  it("refuses a missing title, naming the row by id", async () => {
    const { code, message } = await refuse({ id: "AB-IS-#877", refs: [], gate: "", status: "in_progress", needs: null });
    expect(code).toBe(2);
    expect(message).toMatch(/row 'AB-IS-#877' needs a string 'title'/);
    expect(message).toMatch(/nothing \(the field is missing\)/);
  });

  it("refuses a non-string entry inside refs, naming every bad index at once", async () => {
    const { code, message } = await refuse({ ...STRING_REFS_ROW, refs: ["AB-IS-#877", 12, null] });
    expect(code).toBe(2);
    expect(message).toMatch(/row 'AB-IS-#877' has non-string entries in 'refs'/);
    expect(message).toMatch(/refs\[1\] is a number/);
    expect(message).toMatch(/refs\[2\] is null/);
  });

  it("refuses a missing gate: an omitted field is not the same statement as null", async () => {
    const { code, message } = await refuse({ id: "AB-IS-#877", title: "sample effort", refs: [], status: "in_progress", needs: null });
    expect(code).toBe(2);
    expect(message).toMatch(/row 'AB-IS-#877' has the wrong shape for 'gate'/);
    expect(message).toMatch(/a string, or null for a row that carries no gate/);
  });

  it("refuses a non-string status", async () => {
    const { code, message } = await refuse({ ...STRING_REFS_ROW, refs: [], status: true });
    expect(code).toBe(2);
    expect(message).toMatch(/row 'AB-IS-#877' needs a string 'status'/);
    expect(message).toMatch(/got a boolean/);
  });

  it("refuses a non-string, non-null needs", async () => {
    const { code, message } = await refuse({ ...STRING_REFS_ROW, refs: [], needs: 7 });
    expect(code).toBe(2);
    expect(message).toMatch(/row 'AB-IS-#877' has the wrong shape for 'needs'/);
    expect(message).toMatch(/one line as a string, or null when nothing is owed/);
  });

  it("describes a plain-object field as 'an object', never the ungrammatical 'a object'", async () => {
    // A plain object is the one typeof in JSON's vocabulary that starts with
    // a vowel; the bare `a ${typeof value}` fallback rendered it "a object".
    const { code, message } = await refuse({ ...STRING_REFS_ROW, refs: { ref: "AB-IS-#877" } });
    expect(code).toBe(2);
    expect(message).toMatch(/got an object/);
    expect(message).not.toMatch(/\ba object\b/);
  });

  it("still accepts null gate and null needs -- the declared no-gate/nothing-owed statements", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const rows = join(dir, "rows.json");
    writeFileSync(rows, JSON.stringify([{ ...STRING_REFS_ROW, refs: ["AB-IS-#877"], gate: null, needs: null }]));
    const result = await capture(["board", "build", "--repo-slug", "o/r", "--rows-from", rows, "--json"], dir);
    expect(result.code).toBe(0);
  });
});

// #92: `board build`'s validation covered only `--rows-from`. `board render
// --board-from` and `board diff --before/--after` each read a WHOLE Board
// document the same cast-not-checked way, so the identical malformed shapes
// still crashed one verb over -- a raw TypeError (exit 1) where `build` gave
// an actionable refusal (exit 2). These tests pin the read seam for all three
// of the issue's malformed shapes (a string `refs`, a missing `rows`, a row
// missing `title`) plus a not-JSON file, for BOTH remaining verbs, and pin
// the unchanged happy path byte-for-byte so the fix cannot silently change a
// genuine board's output.
const GOOD_ROW = { id: "1", title: "Effort one", refs: ["XX-IS-#1"], gate: "G2", status: "🟢 ready", needs: null };
const GOOD_BOARD = { repo: "o/r", generatedAt: "2026-01-01T00:00:00Z", rows: [GOOD_ROW] };
const ROW_WITHOUT_TITLE = { id: GOOD_ROW.id, refs: GOOD_ROW.refs, gate: GOOD_ROW.gate, status: GOOD_ROW.status, needs: GOOD_ROW.needs };

function malformedBoardFixtures(): ReadonlyArray<{ readonly label: string; readonly write: (path: string) => void }> {
  return [
    {
      label: "a row's refs given as a pre-joined string",
      write: (path): void =>
        writeFileSync(
          path,
          JSON.stringify({
            ...GOOD_BOARD,
            rows: [{ ...GOOD_ROW, refs: "XX-IS-#1" }],
          }),
        ),
    },
    {
      label: "rows missing entirely",
      write: (path): void => writeFileSync(path, JSON.stringify({ repo: "o/r", generatedAt: "t" })),
    },
    {
      label: "a row missing title",
      write: (path): void => writeFileSync(path, JSON.stringify({ ...GOOD_BOARD, rows: [ROW_WITHOUT_TITLE] })),
    },
  ];
}

describe("nen board render board-shape validation (#92)", () => {
  it("renders a genuine board byte-identically to before this fix (byte-parity pin)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const boardPath = join(dir, "board.json");
    writeFileSync(boardPath, JSON.stringify(GOOD_BOARD));
    const result = await capture(["board", "render", "--board-from", boardPath], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toBe(
      [
        "o/r -- generated 2026-01-01T00:00:00Z",
        "",
        "| Effort     | Refs     | Status (gate) | Needs |",
        "| ---------- | -------- | ------------- | ----- |",
        "| Effort one | XX-IS-#1 | 🟢 ready (G2) |       |",
      ].join("\n"),
    );
  });

  for (const fixture of malformedBoardFixtures()) {
    it(`refuses ${fixture.label} with an exit-2 refusal, never a TypeError`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
      const boardPath = join(dir, "board.json");
      fixture.write(boardPath);
      const result = await capture(["board", "render", "--board-from", boardPath], dir);
      expect(result.code).toBe(2);
      const message = result.err.join("\n");
      expect(message).toMatch(new RegExp(boardPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(message).not.toMatch(/is not a function/);
      expect(message).not.toMatch(/TypeError/);
      expect(message).not.toMatch(/evaluating/);
    });
  }

  it("refuses a not-JSON file actionably, never a TypeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const boardPath = join(dir, "board.json");
    writeFileSync(boardPath, "this is not json at all {{{");
    const result = await capture(["board", "render", "--board-from", boardPath], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is not valid JSON/);
  });

  it("refuses an unreadable file actionably, never a TypeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const missing = join(dir, "does-not-exist.json");
    const result = await capture(["board", "render", "--board-from", missing], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });
});

describe("nen board diff board-shape validation (#92)", () => {
  it("diffs two genuine boards unchanged (happy path)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, JSON.stringify(GOOD_BOARD));
    writeFileSync(
      after,
      JSON.stringify({ ...GOOD_BOARD, rows: [{ ...GOOD_BOARD.rows[0], status: "🔴 blocked" }] }),
    );
    const result = await capture(["board", "diff", "--before", before, "--after", after], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/changed\s+1: status '🟢 ready' -> '🔴 blocked'/);
  });

  for (const fixture of malformedBoardFixtures()) {
    it(`refuses ${fixture.label} in --before with an exit-2 refusal, never a TypeError`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
      const before = join(dir, "before.json");
      const after = join(dir, "after.json");
      fixture.write(before);
      writeFileSync(after, JSON.stringify(GOOD_BOARD));
      const result = await capture(["board", "diff", "--before", before, "--after", after], dir);
      expect(result.code).toBe(2);
      const message = result.err.join("\n");
      expect(message).toMatch(new RegExp(before.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(message).not.toMatch(/is not a function/);
      expect(message).not.toMatch(/TypeError/);
      expect(message).not.toMatch(/evaluating/);
    });

    it(`refuses ${fixture.label} in --after with an exit-2 refusal, never a TypeError`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
      const before = join(dir, "before.json");
      const after = join(dir, "after.json");
      writeFileSync(before, JSON.stringify(GOOD_BOARD));
      fixture.write(after);
      const result = await capture(["board", "diff", "--before", before, "--after", after], dir);
      expect(result.code).toBe(2);
      const message = result.err.join("\n");
      expect(message).toMatch(new RegExp(after.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      expect(message).not.toMatch(/is not a function/);
      expect(message).not.toMatch(/TypeError/);
      expect(message).not.toMatch(/evaluating/);
    });
  }

  it("refuses a not-JSON file actionably, never a TypeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const before = join(dir, "before.json");
    const after = join(dir, "after.json");
    writeFileSync(before, "this is not json at all {{{");
    writeFileSync(after, JSON.stringify(GOOD_BOARD));
    const result = await capture(["board", "diff", "--before", before, "--after", after], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/is not valid JSON/);
  });

  it("refuses an unreadable file actionably, never a TypeError", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-board-"));
    const missing = join(dir, "does-not-exist.json");
    const after = join(dir, "after.json");
    writeFileSync(after, JSON.stringify(GOOD_BOARD));
    const result = await capture(["board", "diff", "--before", missing, "--after", after], dir);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });
});
