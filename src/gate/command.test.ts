import { describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { gateCommand } from "./command.js";

// NEVER `defaultSeams()` HERE -- see board/command.test.ts's own note.
const STUB_SEAMS: Seams = {
  run: (): never => {
    throw new Error("must not be called");
  },
  now: (): Date => new Date("2026-01-01T00:00:00Z"),
  env: {},
};

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
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
  const code = await runFamily(gateCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen gate derive", () => {
  const dir = mkdtempSync(join(tmpdir(), "nen-gate-"));

  it("derives G4 for a process-surface hit when both path sets are given", async () => {
    const result = await capture(
      ["gate", "derive", "--policy-paths", "CONSTITUTION.md", "--process-paths", "scripts/", "--files", "scripts/foo.sh"],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("G4");
  });

  describe("an ABSENT flag is a refusal, never a silent empty set (review finding)", () => {
    it("refuses when --process-paths is omitted -- a forgotten flag must NOT silently derive G2", async () => {
      // Reproduces the review's exact scenario: dropping only --process-paths
      // from an otherwise-G4-deriving invocation must refuse, not silently
      // derive G2 with a basis claiming both sets were checked.
      const result = await capture(
        ["gate", "derive", "--policy-paths", "CONSTITUTION.md", "--files", "scripts/foo.sh"],
        dir,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--process-paths is required/);
    });

    it("refuses when --policy-paths is omitted", async () => {
      const result = await capture(
        ["gate", "derive", "--process-paths", "scripts/", "--files", "scripts/foo.sh"],
        dir,
      );
      expect(result.code).toBe(2);
      expect(result.err.join("\n")).toMatch(/--policy-paths is required/);
    });

    it("an EXPLICITLY EMPTY --process-paths '' stays legal -- a caller's assertion, not an omission", async () => {
      const result = await capture(
        ["gate", "derive", "--policy-paths", "CONSTITUTION.md", "--process-paths", "", "--files", "src/a.ts"],
        dir,
      );
      expect(result.code).toBe(0);
      expect(result.out[0]).toBe("G2");
    });

    it("still refuses when BOTH sets are explicitly empty -- no default set is carried", async () => {
      const result = await capture(
        ["gate", "derive", "--policy-paths", "", "--process-paths", "", "--files", "src/a.ts"],
        dir,
      );
      expect(result.code).toBe(1);
      expect(result.err.join("\n")).toMatch(/no path sets were given/);
    });
  });
});
