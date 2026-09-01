import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { devCommand } from "./command.js";

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
  const seams: Seams = {
    run: (): CommandResult => {
      throw new Error("nen dev makes no subprocess call of its own");
    },
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
  };
  const code = await runFamily(devCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

describe("nen dev replay -- CLI wiring", () => {
  it("replays the imported slice and exits 0 when everything agrees", async () => {
    const sliceDir = join(process.cwd(), "tests", "fixtures", "dualrun-slice", "dedupe");
    const result = await capture(["dev", "replay", "--slice-dir", sliceDir], null);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/0 failed/);
  });

  it("defaults --slice-dir to <repo>/tests/fixtures/dualrun-slice/dedupe", async () => {
    // repoFlag null -> process.cwd(), the nen checkout itself
    const result = await capture(["dev", "replay"], null);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/replayed \d+ fixture/);
  });

  // Review finding #9: an empty --slice-dir used to exit 0 with "0 passed, 0 failed".
  it("exits 1 and refuses (never 0/0-pass) when --slice-dir is empty", async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), "nen-dev-replay-empty-"));
    const result = await capture(["dev", "replay", "--slice-dir", emptyDir], null);
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/contains no fixtures/);
  });

  it("exits 2 with a located message (not a raw stack trace) when --slice-dir does not exist", async () => {
    const missing = join(tmpdir(), "nen-dev-replay-missing-" + Date.now());
    const result = await capture(["dev", "replay", "--slice-dir", missing], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no such directory/);
  });
});

describe("nen dev test/lint -- CLI wiring refuses a checkout-less directory", () => {
  it("dev test reports no package.json rather than crashing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-dev-verb-"));
    const result = await capture(["dev", "test"], empty);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no package\.json/);
  });

  it("dev lint reports no package.json rather than crashing", async () => {
    const empty = mkdtempSync(join(tmpdir(), "nen-dev-verb-"));
    const result = await capture(["dev", "lint"], empty);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/no package\.json/);
  });
});

describe("nen dev -- refuses an unknown subcommand", () => {
  it("exits 2", async () => {
    expect((await capture(["dev", "bogus"], null)).code).toBe(2);
  });
});
