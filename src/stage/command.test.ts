import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import { BANKAI_REPO } from "../schema/fixtures/paths.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import type { Seams } from "../seam/exec.js";
import { stageCommand } from "./command.js";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

async function capture(
  argv: readonly string[],
  script: readonly ScriptedCall[] = [],
  // `null` is a real case: the invocation that never typed --repo (zheref/nen#28).
  repoFlag: string | null = BANKAI_REPO,
): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = new ScriptedSeams(script);
  const code = await runFamily(stageCommand, argv, repoFlag, false, io, seams);
  return { code, out, err };
}

/** The same harness with `--json` on, for a case that reads the document. */
async function captureJson(
  argv: readonly string[],
  script: readonly ScriptedCall[],
  repoFlag: string,
): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const code = await runFamily(stageCommand, argv, repoFlag, true, io, new ScriptedSeams(script));
  return { code, out, err };
}

describe("nen stage triage -- CLI wiring", () => {
  // zheref/nen#28: the usage line lists --repo unbracketed, so omitting it is
  // refused by name -- never silently pointed at the process's own cwd.
  it("refuses an OMITTED --repo at the parser (exit 2), naming the flag", async () => {
    const result = await capture(["stage", "triage"], [], null);
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toMatch(/--repo <path> is required/);
  });

  it("exits 0 when nothing is flagged", async () => {
    const result = await capture(["stage", "triage"], [
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/a.ts\0" } },
    ]);
    expect(result.code).toBe(0);
  });

  it("exits 1 and lists the reason(s) when something is flagged", async () => {
    const result = await capture(["stage", "triage"], [
      { match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: "?? .env\0" } },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("passes --scope and --mentions through to the triage", async () => {
    const result = await capture(
      ["stage", "triage", "--scope", "src/", "--mentions", "renames src/old.ts"],
      [{ match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall", result: { stdout: " M src/old.ts\0" } }],
    );
    expect(result.code).toBe(0);
  });

  it("flags a real secret file even at a non-ASCII path (BLOCKER #3)", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: "?? secrëts/.env\0" },
      },
    ]);
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/secrëts\/\.env {2}\[secret-shape\]/);
  });

  it("refuses an unknown subcommand", async () => {
    expect((await capture(["stage", "bogus"])).code).toBe(2);
  });
});

// zheref/nen#169: a git-ignored path leaves 'flagged' for its own bucket --
// a count in text (this verb has no --verbose flag, so the paths themselves
// are never listed there), a full array under --json, and it never moves the
// exit code.
describe("nen stage triage -- the ignored bucket (zheref/nen#169)", () => {
  it("on a mixed tree, counts ignored separately from clean and flagged, and never lists ignored paths in text", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: " M src/a.ts\0?? .env\0!! node_modules/x\0!! node_modules/y/.env\0" },
      },
    ]);
    expect(result.code).toBe(1);
    const out = result.out.join("\n");
    expect(out).toMatch(/clean: 1 file\(s\)/);
    expect(out).toMatch(/ {2}src\/a\.ts/);
    expect(out).toMatch(/ignored: 2 file\(s\), not listed/);
    expect(out).not.toMatch(/node_modules/);
    expect(out).toMatch(/flagged: 1 file\(s\)/);
    expect(out).toMatch(/\.env {2}\[secret-shape\]/);
  });

  it("on a tree with only ignored rows, exits 0 -- the exit code follows 'flagged' only", async () => {
    const result = await capture(["stage", "triage"], [
      {
        match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
        result: { stdout: "!! node_modules/x\0!! node_modules/y/.env\0" },
      },
    ]);
    expect(result.code).toBe(0);
    const out = result.out.join("\n");
    expect(out).toMatch(/clean: 0 file\(s\)/);
    expect(out).toMatch(/ignored: 2 file\(s\), not listed/);
    expect(out).not.toMatch(/flagged/);
    expect(out).not.toMatch(/node_modules/);
  });

  it("--json carries the full ignored array, with a secret-shape reason preserved and never inside flagged", async () => {
    const result = await capture(
      ["stage", "triage", "--json"],
      [
        {
          match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
          result: { stdout: "!! node_modules/y/.env\0" },
        },
      ],
    );
    expect(result.code).toBe(0);
    const parsed = JSON.parse(result.out.join("\n")) as {
      clean: string[];
      flagged: unknown[];
      ignored: { path: string; reasons: string[] }[];
    };
    expect(parsed.flagged).toEqual([]);
    expect(parsed.ignored).toEqual([{ path: "node_modules/y/.env", reasons: ["ignored", "secret-shape"] }]);
  });
});

// Copilot, PR #189: the size measurement used to stat every `git status` entry,
// ignored ones included -- thousands of synchronous stats on a repository with
// a `node_modules/` tree, buying one `--json` field nothing reads.
describe("nen stage triage -- an ignored path is never measured", () => {
  it("stats no ignored path, and still reports it in the ignored bucket", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-stage-"));
    mkdirSync(join(root, "node_modules"), { recursive: true });
    writeFileSync(join(root, "node_modules", "huge.js"), "x".repeat(2_000_000), "utf8");
    writeFileSync(join(root, "src.txt"), "ok\n", "utf8");
    const result = await captureJson(
      ["stage", "triage"],
      [
        {
          match: "git -c core.quotePath=false status --porcelain=v1 -z --ignored -uall",
          result: { stdout: "!! node_modules/huge.js\0?? src.txt\0" },
        },
      ],
      root,
    );
    expect(result.code).toBe(0);
    const triage = JSON.parse(result.out.join("\n")) as {
      ignored: { path: string; reasons: string[] }[];
      clean: string[];
    };
    // Present as a FACT, with the reason it always carried -- and with no
    // `large`, because its size was never asked for. A 2 MB file is well over
    // the default threshold, so this asserts the skip and not merely the size.
    expect(triage.ignored).toEqual([{ path: "node_modules/huge.js", reasons: ["ignored"] }]);
    expect(triage.clean).toEqual(["src.txt"]);
  });
});
