import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import { defaultSeams } from "../seam/exec.js";
import { prCommand } from "./command.js";

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
  const args = parseArgs(argv, mergeFlags(prCommand.flags));
  try {
    const code = prCommand.run({ args, repoFlag, json: args.booleans.has("json"), io, seams: defaultSeams() });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
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
    expect(result.out).toEqual(["ok  summary", "MISSING  test-plan"]);
  });
});
