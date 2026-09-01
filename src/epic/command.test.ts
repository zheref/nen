import { describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { epicCommand } from "./command.js";

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
      throw new Error("epic next-wave makes no subprocess call");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(epicCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen epic next-wave -- CLI wiring", () => {
  it("requires --citation, never defaulted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--citation/);
  });

  it("computes without writing when --out is omitted", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "UZF-1"]);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/next wave: #1/);
  });

  it("writes the rewritten body to --out", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, "- [ ] #1");
    const result = await capture([
      "epic",
      "next-wave",
      "--body-file",
      bodyFile,
      "--citation",
      "UZF-1",
      "--completed",
      "1",
      "--out",
      outFile,
    ]);
    expect(result.code).toBe(0);
    expect(readFileSync(outFile, "utf8")).toMatch(/- \[x\] #1/);
  });

  it("reports a missing --body-file loudly rather than crashing", async () => {
    const result = await capture(["epic", "next-wave", "--body-file", "/nope/nope.md", "--citation", "UZF-1"]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read/);
  });

  // Review finding #18: exits 1 and never writes --out on a duplicated
  // checklist id, instead of silently picking a tie-break.
  it("exits 1 and does NOT write --out when the checklist has a duplicated child id", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-epic-"));
    const bodyFile = join(dir, "body.md");
    const outFile = join(dir, "out.md");
    writeFileSync(bodyFile, ["- [x] #5 **[alice]**", "- [ ] #5 **[bob]**"].join("\n"));
    const result = await capture(["epic", "next-wave", "--body-file", bodyFile, "--citation", "UZF-1", "--out", outFile]);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/duplicate child checklist id/);
    expect(result.err.join("\n")).toMatch(/#5/);
    expect(existsSync(outFile)).toBe(false);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["epic", "bogus"])).code).toBe(2);
  });
});
