import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { stopCommand } from "./command.js";

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
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding: several family test files
// re-implemented that mapping locally, which can silently drift from the
// real one). This is also what lets an UNDECLARED flag ('--from', review
// finding elsewhere in this file) surface as a real `UsageError` thrown by
// `runFamily`'s own `parseArgs` call, exactly as a live invocation would see
// it.
function capture(argv: readonly string[], repoFlag: string | null = null): { code: number; out: string[]; err: string[] } {
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
  const code = runFamily(stopCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen stop --template", () => {
  it("renders a blank 5-column table and no signal line", () => {
    const result = capture(["stop", "--template"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toMatch(/YOUR INPUT IS NEEDED/);
    expect(result.out.join("\n")).toMatch(/Effort/);
    expect(result.out.join("\n")).toMatch(/Session \/ lane/);
  });
});

describe("nen stop", () => {
  it("carries no built-in persona name -- --who states it, or it is absent", () => {
    const result = capture(["stop"]);
    expect(result.out.join("\n")).toMatch(/YOUR INPUT IS NEEDED/);
    expect(result.out.join("\n")).not.toMatch(/who:/);
  });

  it("names the gate given by --gate", () => {
    const result = capture(["stop", "--gate", "G4"]);
    expect(result.out.join("\n")).toMatch(/G4 -- policy\/spec change/);
  });

  it("refuses an unknown gate", () => {
    expect(capture(["stop", "--gate", "G9"]).code).toBe(2);
  });

  it("reports rung 1's status honestly, and states rungs 2-3 are not fired", () => {
    const notFired = capture(["stop"]);
    expect(notFired.out.join("\n")).toMatch(/NOT fired/);
    const fired = capture(["stop", "--notified"]);
    expect(fired.out.join("\n")).toMatch(/reported sent by the caller/);
    expect(fired.out.join("\n")).toMatch(/not fired by nen/);
  });

  it("renders an efforts table read from a file, padded", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-stop-"));
    const file = join(dir, "efforts.md");
    writeFileSync(file, "| a | bb |\n| --- | --- |\n| x | yy |\n");
    const result = capture(["stop", file], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/\| a\s+\| bb\s+\|/);
  });

  it("emits a stable --json contract", () => {
    const result = capture(["stop", "--gate", "G2", "--json"]);
    const parsed: unknown = JSON.parse(result.out.join("\n"));
    expect(parsed).toMatchObject({ gate: "G2", who: null, notified: false });
  });

  it("refuses '--from' as an unknown option, rather than silently accepting it as a no-op (review finding)", () => {
    // The efforts file is a POSITIONAL ('nen stop efforts.md'), never
    // '--from'. Declaring '--from' with no reader let this parse cleanly and
    // silently render no table at all -- a plausible typo given every other
    // family's convention is '--<noun>-from'.
    const result = capture(["stop", "--from", "efforts.md", "--gate", "G2"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/unknown option '--from'/);
  });
});
