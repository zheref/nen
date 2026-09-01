import { describe, expect, it } from "vitest";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { wakeCommand } from "./command.js";

// Mirrors ../index.ts's own runFamily() error-to-exit-code mapping, so a test
// calling a family's run() directly still sees the same contract a real
// invocation would.
function capture(argv: readonly string[], run: Seams["run"]): { code: number; out: string[]; err: string[] } {
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
  const args = parseArgs(argv, mergeFlags(wakeCommand.flags));
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  try {
    const code = wakeCommand.run({ args, repoFlag: null, json: args.booleans.has("json"), io, seams });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "", spawnFailed: false };
}

describe("nen wake fire", () => {
  it("is a dry run by default and mutates nothing", () => {
    let calls = 0;
    const result = capture(
      ["wake", "fire", "--repo-slug", "o/r", "--ref", "XX-PR-#12", "--label", "wake"],
      (): CommandResult => {
        calls += 1;
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(calls).toBe(0);
    expect(result.out.join("\n")).toMatch(/dry run/);
  });

  it("removes then re-applies the label when --run is given", () => {
    const seen: string[][] = [];
    capture(["wake", "fire", "--repo-slug", "o/r", "--ref", "XX-PR-#12", "--label", "wake", "--run"], (command, args): CommandResult => {
      seen.push([command, ...args]);
      return ok("");
    });
    expect(seen).toEqual([
      ["gh", "issue", "edit", "12", "--repo", "o/r", "--remove-label", "wake"],
      ["gh", "issue", "edit", "12", "--repo", "o/r", "--add-label", "wake"],
    ]);
  });

  it("refuses a ref carrying no #<N>", () => {
    const result = capture(["wake", "fire", "--repo-slug", "o/r", "--ref", "not-a-ref", "--label", "wake"], (): CommandResult => ok(""));
    expect(result.code).toBe(2);
  });
});

describe("nen wake verify", () => {
  const openPr = JSON.stringify([
    {
      number: 7,
      draft: false,
      user: { login: "kisuke-bankai[bot]" },
      head: { ref: "feature/x", repo: { id: 1 } },
      base: { repo: { id: 1 } },
    },
  ]);
  const runsWithSwallow = JSON.stringify({
    workflow_runs: [
      {
        id: 100,
        conclusion: "action_required",
        html_url: "https://example.invalid/100",
        event: "pull_request",
        created_at: "2025-12-31T00:00:00Z",
        workflow_id: 5,
        status: "completed",
      },
    ],
  });

  it("redrives a swallowed run and posts the redrive stamp", () => {
    const calls: string[][] = [];
    const result = capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$"],
      (command, args): CommandResult => {
        calls.push([command, ...args]);
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && args[0] === "run") return ok("");
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(calls.some((call): boolean => call[0] === "gh" && call[1] === "run" && call[2] === "rerun" && call[3] === "100")).toBe(true);
    expect(calls.some((call): boolean => call.join(" ").includes("/issues/7/comments") && call.includes("-f"))).toBe(true);
  });

  it("--dry-run reports the plan and writes nothing", () => {
    const mutations: string[][] = [];
    const result = capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--dry-run"],
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && args[0] === "run") mutations.push([command, ...args]);
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(mutations).toEqual([]);
    expect(result.out.join("\n")).toMatch(/redrive/);
  });

  it("refuses an unparseable --author-pattern as a usage error", () => {
    const result = capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "("],
      (): CommandResult => ok("[]"),
    );
    expect(result.code).toBe(2);
  });
});
