import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { defaultSeams } from "../seam/exec.js";
import { warmupCommand } from "./command.js";

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
  const args = parseArgs(argv, mergeFlags(warmupCommand.flags));
  try {
    const code = warmupCommand.run({ args, repoFlag: BANKAI_REPO, json: args.booleans.has("json"), io, seams: defaultSeams() });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
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
