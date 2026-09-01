import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { effortCommand } from "./command.js";

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
      throw new Error("effort classify makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(effortCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen effort classify -- CLI wiring", () => {
  it("classifies every entry in the input array", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-effort-"));
    const path = join(dir, "efforts.json");
    writeFileSync(
      path,
      JSON.stringify([
        { kind: "child", issueState: "open", stageLabels: ["building"], modeLabelPresent: false, hasPr: false, prOpen: false, prIsDelivery: false, integrationBranchAlive: false },
      ]),
    );
    const result = await capture(["effort", "classify", "--input", path]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("stalled");
  });

  it("requires --input", async () => {
    expect((await capture(["effort", "classify"])).code).toBe(2);
  });

  it("reports an unreadable input loudly", async () => {
    const result = await capture(["effort", "classify", "--input", "/nope.json"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["effort", "bogus"])).code).toBe(2);
  });
});
