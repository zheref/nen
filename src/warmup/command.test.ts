import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
function capture(argv: readonly string[], repoFlag: string = BANKAI_REPO): { code: number; out: string[]; err: string[] } {
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
  const code = runFamily(warmupCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

/** A fresh registry with ONE consumer already pinned to --current -- so the
 * pin check alone never fails, isolating the question-sweep contribution to
 * the exit code in the tests below. */
function cleanRegistryRepo(current: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-warmup-"));
  mkdirSync(join(dir, "schemas"), { recursive: true });
  writeFileSync(
    join(dir, "schemas", "repos.json"),
    JSON.stringify({
      latest: current,
      consumers: [{ repo: "o/r", pinned: current, consumes: ["build.yml"], code: "OR" }],
      product_codes: { OR: "r" },
    }),
  );
  return dir;
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

  describe("the handbook-question sweep's skip is explicit, never silent-clean (review finding)", () => {
    it("omitting --questions-from reports NOT CHECKED in human output and { checked: false } in --json, and does not fail the run on its own", () => {
      const dir = cleanRegistryRepo("v1.0.0");
      const result = capture(["warmup", "--current", "v1.0.0"], dir);
      expect(result.out.join("\n")).toMatch(/handbook-question sweep: NOT CHECKED/);
      expect(result.out.join("\n")).not.toMatch(/no unanswered handbook questions/);
      expect(result.code).toBe(0); // pins clean, question sweep merely unevaluated

      const jsonResult = capture(["warmup", "--current", "v1.0.0", "--json"], dir);
      const parsed = JSON.parse(jsonResult.out.join("\n")) as { questionSweep: unknown };
      expect(parsed.questionSweep).toEqual({ checked: false });
    });

    it("a supplied sweep with zero gaps is distinguishable from 'not checked' -- { checked: true, gaps: [] }", () => {
      const dir = cleanRegistryRepo("v1.0.0");
      const questionsPath = join(dir, "questions.json");
      const answersPath = join(dir, "answers.json");
      writeFileSync(questionsPath, JSON.stringify([{ id: "q1", text: "why?" }]));
      writeFileSync(answersPath, JSON.stringify({ "o/r": ["q1"] }));

      const result = capture(
        ["warmup", "--current", "v1.0.0", "--questions-from", questionsPath, "--answers-from", answersPath, "--json"],
        dir,
      );
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.out.join("\n")) as { questionSweep: unknown };
      expect(parsed.questionSweep).toEqual({ checked: true, gaps: [] });
    });

    it("an unanswered question fails the run when checked, unlike the silent 'not checked' state", () => {
      const dir = cleanRegistryRepo("v1.0.0");
      const questionsPath = join(dir, "questions.json");
      const answersPath = join(dir, "answers.json");
      writeFileSync(questionsPath, JSON.stringify([{ id: "q1", text: "why?" }]));
      writeFileSync(answersPath, JSON.stringify({}));

      const result = capture(
        ["warmup", "--current", "v1.0.0", "--questions-from", questionsPath, "--answers-from", answersPath],
        dir,
      );
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/1 unanswered handbook question\(s\)/);
    });
  });
});
