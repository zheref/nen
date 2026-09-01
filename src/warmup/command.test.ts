import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { Seams } from "../seam/exec.js";
import { warmupCommand } from "./command.js";

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
// error-to-exit-code mapping (review finding).
function capture(argv: readonly string[]): { code: number; out: string[]; err: string[] } {
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
  const code = runFamily(warmupCommand, argv, BANKAI_REPO, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen warmup", () => {
  it("flags a stale pin, including a per-caller field, against --current", () => {
    // The fixture's bankai-scaffold entry: pinned v0.10.0, db_migrate_pinned v0.9.7.
    const result = capture(["warmup", "--current", "v0.11.2"]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/bankai-scaffold pinned: v0\.10\.0 -> v0\.11\.2/);
    expect(result.out.join("\n")).toMatch(/db_migrate_pinned: v0\.9\.7 -> v0\.11\.2/);
  });

  it("reports clean when every pin matches --current", () => {
    const result = capture(["warmup", "--current", "v0.10.0"]);
    // KroApple/KroAndroid are pinned v0.11.2 in the fixture, so this is still stale.
    expect(result.out.join("\n")).toMatch(/stale pin/);
  });
});
