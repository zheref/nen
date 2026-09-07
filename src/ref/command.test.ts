import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import type { Seams } from "../seam/exec.js";
import { refCommand } from "./command.js";

// NEVER `defaultSeams()` HERE (see ../warmup/command.test.ts's own note on the
// same fix) -- a `run` that throws converts a future regression (this family
// growing a real subprocess call) into an immediate red test.
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding applied consistently across
// this family's siblings).
async function capture(argv: readonly string[], repoFlag: string = BANKAI_REPO): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(refCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen ref format", () => {
  it("formats a known code", async () => {
    const result = await capture(["ref", "format", "--code", "KP", "--kind", "IS", "--number", "460"]);
    expect(result.code).toBe(0);
  });

  // zheref/nen#17 (review minor): the bankai fixture's product_codes nests a
  // `$comment`, the same shape the live bankai-core file carries. `declared`
  // is built from `Object.keys(registry.productCodes)` PLUS every consumer's
  // `code` -- an unknown code's refusal renders that whole set under
  // "Declared:", and this roster was never tested against a real loaded
  // registry until now.
  it("an unknown code's refusal lists the Declared roster, never a nested $comment (zheref/nen#17)", async () => {
    const result = await capture(["ref", "format", "--code", "ZZ", "--kind", "IS", "--number", "1"]);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/Declared: BC, BS, KC, KN, KP, KW\./);
    expect(result.err.join("\n")).not.toContain("$comment");
  });
});

describe("nen ref parse", () => {
  it("parses a token", async () => {
    const result = await capture(["ref", "parse", "KP-IS-#460"]);
    expect(result.code).toBe(0);
    expect(result.out).toContain("code:   KP");
  });

  it("refuses a token with no positional argument", async () => {
    const result = await capture(["ref", "parse"]);
    expect(result.code).toBe(2);
  });
});
