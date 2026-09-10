import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderBoard } from "../board/render.js";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { MARKER_FILE, STOP_MARK_CONTRACT, stopCommand } from "./command.js";

// NEVER `defaultSeams()` HERE (review finding) -- see board/command.test.ts's
// own note on the same fix. A `run` that throws converts a future regression
// (this verb growing a real `gh` call) into an immediate red test instead of
// a silent live subprocess call.
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
  runInteractive: (): never => {
    throw new Error("this verb has no interactive form");
  },
  platform: "linux",
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding: several family test files
// re-implemented that mapping locally, which can silently drift from the
// real one). This is also what lets an UNDECLARED flag ('--from', review
// finding elsewhere in this file) surface as a real `UsageError` thrown by
// `runFamily`'s own `parseArgs` call, exactly as a live invocation would see
// it.
async function capture(argv: readonly string[], repoFlag: string | null = null): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(stopCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen stop --template", () => {
  it("renders a blank 5-column table and no signal line", async () => {
    const result = await capture(["stop", "--template"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toMatch(/YOUR INPUT IS NEEDED/);
    expect(result.out.join("\n")).toMatch(/Effort/);
    expect(result.out.join("\n")).toMatch(/Session \/ lane/);
  });
});

describe("nen stop", () => {
  it("carries no built-in persona name -- --who states it, or it is absent", async () => {
    const result = await capture(["stop"]);
    expect(result.out.join("\n")).toMatch(/YOUR INPUT IS NEEDED/);
    expect(result.out.join("\n")).not.toMatch(/who:/);
  });

  it("names the gate given by --gate", async () => {
    const result = await capture(["stop", "--gate", "G4"]);
    expect(result.out.join("\n")).toMatch(/G4 -- policy\/spec change/);
  });

  it("refuses an unknown gate", async () => {
    expect((await capture(["stop", "--gate", "G9"])).code).toBe(2);
  });

  it("reports rung 1's status honestly, and states rungs 2-3 are not fired", async () => {
    const notFired = await capture(["stop"]);
    expect(notFired.out.join("\n")).toMatch(/NOT fired/);
    const fired = await capture(["stop", "--notified"]);
    expect(fired.out.join("\n")).toMatch(/reported sent by the caller/);
    expect(fired.out.join("\n")).toMatch(/not fired by nen/);
  });

  it("renders an efforts table read from a file, padded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-stop-"));
    const file = join(dir, "efforts.md");
    writeFileSync(file, "| a | bb |\n| --- | --- |\n| x | yy |\n");
    const result = await capture(["stop", file], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\| a\s+\| bb\s+\|/);
  });

  it("parses a piped cell out of a board `nen board render` produced (zheref/nen#10 item 2)", async () => {
    // The exact producer/consumer pair the issue names: `nen board render`'s
    // output, fed back to `nen stop`. Before the escape, `rows[1]` came back
    // as five cells with every column past the title shifted one left.
    const dir = mkdtempSync(join(tmpdir(), "nen-stop-"));
    const file = join(dir, "efforts.md");
    const board = { repo: "o/r", generatedAt: "2026-01-01T00:00:00Z", rows: [{ id: "1", title: "feat: a | b", refs: ["XX-PR-#7"], gate: "G2", status: "ready", needs: null }] };
    writeFileSync(file, renderBoard(board).slice(2).join("\n") + "\n");

    const result = await capture(["stop", file, "--json"], dir);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { rows: string[][] };
    expect(parsed.rows).toEqual([
      ["Effort", "Refs", "Status (gate)", "Needs"],
      ["feat: a | b", "XX-PR-#7", "ready (G2)", ""],
    ]);
  });

  it("keeps a NEWLINE-carrying title in ONE row, flattened to a space (zheref/nen#10 item 2)", async () => {
    // The other half of the round trip, and the only LOSSY one. A raw `\n` in
    // a title used to end the row mid-table, so this parsed as a four-column
    // header followed by two junk rows and `nen stop --json` handed a caller
    // three blank fields with no error anywhere. The flattened title is
    // recoverable text in the right column; the line break is not recoverable
    // at all, because a markdown table row is one line by definition.
    const dir = mkdtempSync(join(tmpdir(), "nen-stop-"));
    const file = join(dir, "efforts.md");
    const board = { repo: "o/r", generatedAt: "2026-01-01T00:00:00Z", rows: [{ id: "1", title: "feat: a\nb", refs: ["XX-PR-#7"], gate: "G2", status: "ready", needs: null }] };
    writeFileSync(file, renderBoard(board).slice(2).join("\n") + "\n");

    const result = await capture(["stop", file, "--json"], dir);
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as { rows: string[][] };
    expect(parsed.rows).toHaveLength(2); // header + ONE data row, not three
    expect(parsed.rows[1]).toHaveLength(4); // FOUR cells, none of them blank filler
    expect(parsed.rows).toEqual([
      ["Effort", "Refs", "Status (gate)", "Needs"],
      ["feat: a b", "XX-PR-#7", "ready (G2)", ""],
    ]);
  });

  it("emits a stable --json contract", async () => {
    const result = await capture(["stop", "--gate", "G2", "--json"]);
    const parsed: unknown = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({ gate: "G2", who: null, notified: false });
  });

  it("refuses '--from' as an unknown option, rather than silently accepting it as a no-op (review finding)", async () => {
    // The efforts file is a POSITIONAL ('nen stop efforts.md'), never
    // '--from'. Declaring '--from' with no reader let this parse cleanly and
    // silently render no table at all -- a plausible typo given every other
    // family's convention is '--<noun>-from'.
    const result = await capture(["stop", "--from", "efforts.md", "--gate", "G2"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown option '--from'/);
  });
});

// ── --mark: the one form of this verb that writes ───────────────────────────

describe("nen stop --mark -- the marker a host hook rings off", () => {
  function marker(root: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(root, ".nen", "last-stop.json"), "utf8")) as Record<
      string,
      unknown
    >;
  }

  it("writes nothing at all without the flag", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    const result = await capture(["stop", "--gate", "G5"], root);
    expect(result.code).toBe(0);
    expect(existsSync(join(root, ".nen"))).toBe(false);
  });

  it("records who, which gate, whether rung 1 fired, and when -- creating .nen/", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    const result = await capture(["stop", "--who", "someone", "--gate", "G5", "--mark"], root);
    expect(result.code).toBe(0);
    expect(marker(root)).toEqual({
      contract: STOP_MARK_CONTRACT,
      who: "someone",
      gate: "G5",
      notified: false,
      // The INSTANT comes from the seam, which is why this is an equality and
      // not a "roughly now": a freshness window a host hook checks has to be
      // provable rather than raced.
      at: "2026-01-01T00:00:00.000Z",
    });
  });

  it("goes under the GENERATED '.nen/', never the committed 'nen/'", async () => {
    // The one-character difference is what keeps `git add nen/` after a stop
    // from staging this file.
    expect(MARKER_FILE).toBe(".nen/last-stop.json");
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    await capture(["stop", "--mark"], root);
    expect(existsSync(join(root, "nen"))).toBe(false);
  });

  it("carries --notified through, so a hook knows which rungs are left", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    await capture(["stop", "--gate", "G2", "--notified", "--mark"], root);
    expect(marker(root)["notified"]).toBe(true);
  });

  it("replaces an existing marker: the LATEST stop is the one to ring for", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    await capture(["stop", "--gate", "G2", "--mark"], root);
    await capture(["stop", "--gate", "G5", "--mark"], root);
    expect(marker(root)["gate"]).toBe("G5");
  });

  it("says on screen that it marked, and publishes the marker in --json", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    const text = await capture(["stop", "--gate", "G5", "--mark"], root);
    expect(text.out.join("\n")).toContain("marked:");
    const json = await capture(["stop", "--gate", "G5", "--mark", "--json"], root);
    const parsed = JSON.parse(json.out.join("\n")) as { marker: { gate: string } | null };
    expect(parsed.marker?.gate).toBe("G5");
  });

  it("publishes marker:null when the flag was not given, so the field is always there", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    const result = await capture(["stop", "--gate", "G5", "--json"], root);
    expect((JSON.parse(result.out.join("\n")) as { marker: unknown }).marker).toBeNull();
  });

  it("refuses --mark with --template, which waits on nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    const result = await capture(["stop", "--template", "--mark"], root);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/contradict/);
    expect(existsSync(join(root, ".nen"))).toBe(false);
  });

  it("exits 1 with the errno when the marker cannot be written", async () => {
    // A caller who typed --mark asked for a rung to be armed; "the banner
    // rendered and the marker did not" is where somebody waits for a bell that
    // will never ring. A FILE where the directory has to go fails mkdir on
    // every platform.
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    writeFileSync(join(root, ".nen"), "not a directory\n", "utf8");
    const result = await capture(["stop", "--gate", "G5", "--mark"], root);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not write/);
    expect(result.err.join("\n")).toMatch(/EEXIST|ENOTDIR|EACCES|EPERM/);
  });

  it("does not mark when the efforts file could not be read", async () => {
    // The marker is written LAST, after every refusal: a hook ringing for a
    // banner nobody saw is worse than one that never rang.
    const root = mkdtempSync(join(tmpdir(), "nen-stop-mark-"));
    const result = await capture(["stop", "--gate", "G5", "--mark", "no-such-efforts.md"], root);
    expect(result.code).not.toBe(0);
    expect(existsSync(join(root, ".nen", "last-stop.json"))).toBe(false);
  });
});
