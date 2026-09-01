import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { loopCommand } from "./command.js";

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("loop slots makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(loopCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen loop slots -- CLI wiring", () => {
  it("exits 1 when a budget is fully occupied", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "a", plane: "ci", prOpen: false },
      { id: "b", plane: "ci", prOpen: false },
    ]));
    const result = await capture(["loop", "slots", "--efforts", path]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/BINDING/);
  });

  it("exits 0 with free slots on both planes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path]);
    expect(result.code).toBe(0);
  });

  it("reports a schema error from the efforts file loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    const result = await capture(["loop", "slots", "--efforts", path]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/must be "ci" or "local"/);
  });

  it("requires --efforts", async () => {
    expect((await capture(["loop", "slots"])).code).toBe(2);
  });
});
