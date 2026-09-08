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
  const code = await runFamily(warmupCommand, argv, repoFlag, false, io, STUB_SEAMS);
  return { code, out, err };
}

/** A fresh registry with ONE consumer already pinned to --current -- so the
 * pin check alone never fails, isolating the question-sweep contribution to
 * the exit code in the tests below. */
function cleanRegistryRepo(current: string): string {
  return registryRepo([{ repo: "o/r", pinned: current, consumes: ["build.yml"], code: "OR" }], current);
}

/** A fresh registry with exactly the consumer entries given. */
function registryRepo(consumers: readonly unknown[], latest: string): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-warmup-"));
  mkdirSync(join(dir, "nen"), { recursive: true });
  writeFileSync(
    join(dir, "nen", "repos.json"),
    JSON.stringify({ latest, consumers, product_codes: { OR: "r" } }),
  );
  return dir;
}

describe("nen warmup", () => {
  it("flags a stale pin, including a per-caller field, against --current", async () => {
    // The fixture's bankai-scaffold entry: pinned v0.10.0, db_migrate_pinned v0.9.7.
    const result = await capture(["warmup", "--current", "v0.11.2"]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/bankai-scaffold pinned: v0\.10\.0 -> v0\.11\.2/);
    expect(result.out.join("\n")).toMatch(/db_migrate_pinned: v0\.9\.7 -> v0\.11\.2/);
  });

  it("reports clean when every pin matches --current", async () => {
    const result = await capture(["warmup", "--current", "v0.10.0"]);
    // KroApple/KroAndroid are pinned v0.11.2 in the fixture, so this is still stale.
    expect(result.out.join("\n")).toMatch(/stale pin/);
  });

  // zheref/nen#17 (review minor): a `$`-prefixed key that also ends in
  // `_pinned` (e.g. `"$comment_pinned": "v0.1.0"`, the same shape a consumer
  // could nest beside a real `pinned` field) must not become a phantom
  // per-caller pin -- this is the same `$`-prefix skip as product_codes,
  // applied at the caller-pin walk in ../schema/repos.ts.
  it("does not report a stale pin for a $-prefixed key that ends in _pinned (zheref/nen#17)", async () => {
    const dir = cleanRegistryRepo("v1.0.0");
    writeFileSync(
      join(dir, "nen", "repos.json"),
      JSON.stringify({
        latest: "v1.0.0",
        consumers: [
          {
            repo: "o/r",
            pinned: "v1.0.0",
            $comment_pinned: "v0.1.0",
            consumes: ["build.yml"],
            code: "OR",
          },
        ],
        product_codes: { OR: "r" },
      }),
    );
    const result = await capture(["warmup", "--current", "v1.0.0"], dir);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/no stale pins/);
    expect(result.out.join("\n")).not.toContain("$comment_pinned");
  });

  describe("an unpinned consumer is a finding, not a clean read (zheref/nen#10 item 4)", () => {
    const UNPINNED = [
      { repo: "o/pinned", pinned: "v1.0.0", consumes: ["build.yml"], code: "OR" },
      { repo: "o/gap", consumes: ["build.yml"] }, // no `pinned` field at all
    ];

    it("names the gap in the human rendering, and FAILS the run", async () => {
      // Before: this printed "no stale pins" and exited 0 -- the registry gap
      // was indistinguishable from a consumer confirmed current.
      const result = await capture(["warmup", "--current", "v1.0.0"], registryRepo(UNPINNED, "v1.0.0"));
      const out = result.out.join("\n");
      expect(out).toMatch(/no stale pins/); // o/pinned genuinely is current
      expect(out).toMatch(/1 unpinned consumer\(s\)/);
      expect(out).toMatch(/o\/gap pinned: NOT PINNED/);
      expect(out).toMatch(/could not be checked against v1\.0\.0/);
      // FAIL-CLOSED: the check could not be performed, so it did not pass.
      expect(result.code).toBe(1);
    });

    it("carries the finding in --json with kind:'unpinned' and pinned:null", async () => {
      const result = await capture(["warmup", "--current", "v1.0.0", "--json"], registryRepo(UNPINNED, "v1.0.0"));
      const parsed = JSON.parse(result.out.join("\n")) as { pinFindings: unknown };
      // The SAME array a caller already fails on, so a caller checking
      // `pinFindings.length > 0` starts refusing a registry gap for free.
      expect(parsed.pinFindings).toEqual([
        { kind: "unpinned", repo: "o/gap", field: "pinned", pinned: null, current: "v1.0.0" },
      ]);
    });

    it("pins the --json BYTES for a PinFinding, key order included (PR #83 review)", async () => {
      // `.toEqual()` above is order-insensitive, so it would stay green even
      // if turning PinFinding into a discriminated union reordered the fields
      // TypeScript emits. This asserts the literal output text -- kind, repo,
      // field, pinned, current, in that order -- so the union's arms must
      // still construct their object literals in the same field order the
      // pre-union shape did.
      const result = await capture(["warmup", "--current", "v1.0.0", "--json"], registryRepo(UNPINNED, "v1.0.0"));
      expect(result.out.join("\n")).toBe(
        [
          "{",
          '  "current": "v1.0.0",',
          '  "pinFindings": [',
          "    {",
          '      "kind": "unpinned",',
          '      "repo": "o/gap",',
          '      "field": "pinned",',
          '      "pinned": null,',
          '      "current": "v1.0.0"',
          "    }",
          "  ],",
          '  "questionSweep": {',
          '    "checked": false',
          "  }",
          "}",
        ].join("\n"),
      );
    });

    it("says 'no unpinned consumers' when every consumer records one -- an unrun check never renders as a clean one", async () => {
      const result = await capture(["warmup", "--current", "v1.0.0"], cleanRegistryRepo("v1.0.0"));
      expect(result.out.join("\n")).toMatch(/no unpinned consumers/);
      expect(result.code).toBe(0);
    });

    it("leaves the stale case untouched: kind:'stale', the same line, the same exit 1", async () => {
      const dir = registryRepo([{ repo: "o/r", pinned: "v0.9.0", consumes: ["build.yml"], code: "OR" }], "v1.0.0");
      const result = await capture(["warmup", "--current", "v1.0.0"], dir);
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/1 stale pin\(s\)/);
      expect(result.out.join("\n")).toMatch(/o\/r pinned: v0\.9\.0 -> v1\.0\.0/);

      const jsonResult = await capture(["warmup", "--current", "v1.0.0", "--json"], dir);
      const parsed = JSON.parse(jsonResult.out.join("\n")) as { pinFindings: unknown };
      expect(parsed.pinFindings).toEqual([
        { kind: "stale", repo: "o/r", field: "pinned", pinned: "v0.9.0", current: "v1.0.0" },
      ]);
    });
  });

  describe("the handbook-question sweep's skip is explicit, never silent-clean (review finding)", () => {
    it("omitting --questions-from reports NOT CHECKED in human output and { checked: false } in --json, and does not fail the run on its own", async () => {
      const dir = cleanRegistryRepo("v1.0.0");
      const result = await capture(["warmup", "--current", "v1.0.0"], dir);
      expect(result.out.join("\n")).toMatch(/handbook-question sweep: NOT CHECKED/);
      expect(result.out.join("\n")).not.toMatch(/no unanswered handbook questions/);
      expect(result.code).toBe(0); // pins clean, question sweep merely unevaluated

      const jsonResult = await capture(["warmup", "--current", "v1.0.0", "--json"], dir);
      const parsed = JSON.parse(jsonResult.out.join("\n")) as { questionSweep: unknown };
      expect(parsed.questionSweep).toEqual({ checked: false });
    });

    it("a supplied sweep with zero gaps is distinguishable from 'not checked' -- { checked: true, gaps: [] }", async () => {
      const dir = cleanRegistryRepo("v1.0.0");
      const questionsPath = join(dir, "questions.json");
      const answersPath = join(dir, "answers.json");
      writeFileSync(questionsPath, JSON.stringify([{ id: "q1", text: "why?" }]));
      writeFileSync(answersPath, JSON.stringify({ "o/r": ["q1"] }));

      const result = await capture(
        ["warmup", "--current", "v1.0.0", "--questions-from", questionsPath, "--answers-from", answersPath, "--json"],
        dir,
      );
      expect(result.code).toBe(0);
      const parsed = JSON.parse(result.out.join("\n")) as { questionSweep: unknown };
      expect(parsed.questionSweep).toEqual({ checked: true, gaps: [] });
    });

    it("an unanswered question fails the run when checked, unlike the silent 'not checked' state", async () => {
      const dir = cleanRegistryRepo("v1.0.0");
      const questionsPath = join(dir, "questions.json");
      const answersPath = join(dir, "answers.json");
      writeFileSync(questionsPath, JSON.stringify([{ id: "q1", text: "why?" }]));
      writeFileSync(answersPath, JSON.stringify({}));

      const result = await capture(
        ["warmup", "--current", "v1.0.0", "--questions-from", questionsPath, "--answers-from", answersPath],
        dir,
      );
      expect(result.code).toBe(1);
      expect(result.out.join("\n")).toMatch(/1 unanswered handbook question\(s\)/);
    });
  });
});
