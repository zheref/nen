import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { Seams } from "../seam/exec.js";
import { prCommand } from "./command.js";

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
function capture(argv: readonly string[], repoFlag: string | null): { code: number; out: string[]; err: string[] } {
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
  const code = runFamily(prCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

describe("nen pr staleness", () => {
  it("reports stale from a wakes file", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const wakes = join(dir, "wakes.json");
    writeFileSync(wakes, JSON.stringify([{ at: "a", noCommit: true }, { at: "b", noCommit: true }]));
    const result = capture(
      ["pr", "staleness", "--wakes-from", wakes, "--last-activity", "2026-01-01T00:00:00Z", "--now", "2026-01-01T01:00:00Z"],
      dir,
    );
    expect(result.code).toBe(0);
    expect(result.out[0]).toBe("stale");
  });

  it("refuses a wakes file whose noCommit is a truthy non-boolean (review finding)", () => {
    // The string "false" is truthy in JavaScript -- a hand-assembled or
    // mis-serialized wakes file must never count it toward the threshold
    // that authorizes the one merge a non-human actor may make.
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const wakes = join(dir, "wakes.json");
    writeFileSync(wakes, JSON.stringify([{ at: "a", noCommit: "false" }, { at: "b", noCommit: "no" }]));
    const result = capture(
      ["pr", "staleness", "--wakes-from", wakes, "--last-activity", "2026-01-01T00:00:00Z", "--now", "2026-01-01T05:00:00Z", "--ready"],
      dir,
    );
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/noCommit.*boolean/);
  });

  it("refuses an unparseable --now or --last-activity as a usage error, not a silent NaN (review finding)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const wakes = join(dir, "wakes.json");
    writeFileSync(wakes, JSON.stringify([{ at: "a", noCommit: true }, { at: "b", noCommit: true }]));
    const result = capture(
      ["pr", "staleness", "--wakes-from", wakes, "--last-activity", "yesterday", "--now", "now", "--ready", "--json"],
      dir,
    );
    // NOT exit 0 with `"idleMinutes": null` -- a machine consumer must never
    // be handed a null it cannot distinguish from a genuinely computed value.
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--last-activity 'yesterday' is not a parseable ISO-8601 instant/);
  });
});

describe("nen pr body-check", () => {
  it("exits 1 when a requirement is missing, listing every requirement", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const body = join(dir, "body.md");
    const requirements = join(dir, "req.json");
    writeFileSync(body, "## Summary\nok\n");
    writeFileSync(requirements, JSON.stringify([{ name: "summary", pattern: "## Summary" }, { name: "test-plan", pattern: "## Test plan" }]));
    const result = capture(["pr", "body-check", "--body-from", body, "--requirements-from", requirements], dir);
    expect(result.code).toBe(1);
    expect(result.out).toEqual(["1/2 requirement(s) satisfied", "ok  summary", "MISSING  test-plan"]);
  });

  it("refuses an empty requirements file rather than reporting a vacuous pass (review finding)", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-pr-"));
    const body = join(dir, "body.md");
    const requirements = join(dir, "req.json");
    writeFileSync(body, "anything at all\n");
    writeFileSync(requirements, "[]");
    const result = capture(["pr", "body-check", "--body-from", body, "--requirements-from", requirements], dir);
    // NOT exit 0 with no output -- `nen pr body-check ... && gh pr merge`
    // must never get a green light from an empty requirements file.
    expect(result.code).not.toBe(0);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/empty/);
  });
});
