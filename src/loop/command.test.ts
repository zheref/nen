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
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/BINDING/);
  });

  it("exits 0 with free slots on both planes", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(0);
  });

  it("reports a schema error from the efforts file loudly", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([{ id: "a" }]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/must be "ci" or "local"/);
  });

  it("requires --efforts", async () => {
    expect((await capture(["loop", "slots"])).code).toBe(2);
  });
});

// Issue #52: --local-cap used to default to 7 -- more than three times looser
// than every real caller's own policy of 2, and loose-by-default is the wrong
// direction for a safety cap. The flag is now required, and the refusal follows
// the required-flag convention (exit 2, actionable message).
describe("nen loop slots -- --local-cap is required (issue #52)", () => {
  it("refuses an omitted --local-cap with exit 2 and an actionable message", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    // The refusal must name the flag, say the old default was removed, and say
    // why -- a guard is chosen, not inherited -- so a caller knows the next step.
    expect(message).toMatch(/--local-cap is required/);
    expect(message).toMatch(/default of 7 was removed/);
    expect(message).toMatch(/chosen, not inherited/);
  });

  it("refuses before reading the efforts file -- a wrong invocation is not masked by file content", async () => {
    const result = await capture(["loop", "slots", "--efforts", "does-not-exist.json"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--local-cap is required/);
  });

  it("honors an explicit --local-cap end-to-end, in the report and the exit code", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([
      { id: "local-1", plane: "local", prOpen: false },
      { id: "local-2", plane: "local", prOpen: false },
    ]));
    // Under the old default of 7 these two efforts left 5 free and exit 0;
    // under the caller's actual policy of 2 the budget is BINDING and exit 1.
    const bound = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2", "--json"]);
    expect(bound.code).toBe(1);
    const report = JSON.parse(bound.out.join("\n")) as { local: { cap: number; binding: boolean } };
    expect(report.local).toMatchObject({ cap: 2, occupied: 2, free: 0, binding: true });

    const roomy = await capture(["loop", "slots", "--efforts", path, "--local-cap", "3"]);
    expect(roomy.code).toBe(0);
  });

  it("still defaults --ci-cap to 2 -- the omission errs tight, not loose", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-loop-"));
    const path = join(dir, "efforts.json");
    writeFileSync(path, JSON.stringify([]));
    const result = await capture(["loop", "slots", "--efforts", path, "--local-cap", "2", "--json"]);
    expect(result.code).toBe(0);
    const report = JSON.parse(result.out.join("\n")) as { ci: { cap: number } };
    expect(report.ci.cap).toBe(2);
  });
});
