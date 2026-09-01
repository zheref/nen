import { describe, expect, it } from "vitest";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { wakeCommand } from "./command.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding).
async function capture(argv: readonly string[], run: Seams["run"]): Promise<{ code: number; out: string[]; err: string[] }> {
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
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  const code = await runFamily(wakeCommand, argv, null, false, io, seams);
  return { code, out, err };
}

function ok(stdout: string): CommandResult {
  return { code: 0, stdout, stderr: "", spawnFailed: false };
}

describe("nen wake fire", () => {
  it("is a dry run by default and mutates nothing", async () => {
    let calls = 0;
    const result = await capture(
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

  it("removes then re-applies the label when --run is given", async () => {
    const seen: string[][] = [];
    await capture(["wake", "fire", "--repo-slug", "o/r", "--ref", "XX-PR-#12", "--label", "wake", "--run"], (command, args): CommandResult => {
      seen.push([command, ...args]);
      return ok("");
    });
    expect(seen).toEqual([
      ["gh", "issue", "edit", "12", "--repo", "o/r", "--remove-label", "wake"],
      ["gh", "issue", "edit", "12", "--repo", "o/r", "--add-label", "wake"],
    ]);
  });

  it("refuses a ref carrying no #<N>", async () => {
    const result = await capture(["wake", "fire", "--repo-slug", "o/r", "--ref", "not-a-ref", "--label", "wake"], (): CommandResult => ok(""));
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

  it("is a dry run by default and mutates nothing (review finding: was write-by-default)", async () => {
    const mutations: string[][] = [];
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$"],
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && (args[0] === "run" || joined.includes("/comments"))) mutations.push([command, ...args]);
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(mutations).toEqual([]);
    expect(result.out.join("\n")).toMatch(/redrive/);
  });

  it("redrives a swallowed run and posts the FULL, conclusion-selected body when --run is given", async () => {
    const calls: string[][] = [];
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--run"],
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
    const commentCall = calls.find((call): boolean => call.join(" ").includes("/issues/7/comments") && call.includes("-f"));
    expect(commentCall).toBeDefined();
    const body = commentCall?.find((arg): boolean => arg.startsWith("body="))?.slice("body=".length) ?? "";
    // The full conclusion-selected message, not only the idempotency stamp
    // (review finding: the port had dropped bankai-core#273/#398's prose and
    // posted an empty-reading HTML-comment-only body).
    expect(body).toContain("Swallowed wake auto-redriven");
    expect(body).toContain("gh run rerun 100");
    expect(body).toContain("<!-- nen-wake-redrive run_id=100");
  });

  it("falls back to a human flag, and warns, rather than aborting the sweep, when the rerun fails", async () => {
    const calls: string[][] = [];
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--run"],
      (command, args): CommandResult => {
        calls.push([command, ...args]);
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/comments")) return ok("[]");
        if (command === "gh" && args[0] === "run") return { code: 1, stdout: "", stderr: "HTTP 403: rerun refused", spawnFailed: false };
        return ok("");
      },
    );
    // The sweep completes (exit 0), not a thrown ToolError -- a failed rerun
    // must not strand every PR after this one unscanned (bankai-core#398/PR
    // #411, review finding).
    expect(result.code).toBe(0);
    const commentCall = calls.find((call): boolean => call.join(" ").includes("/issues/7/comments") && call.includes("-f"));
    const body = commentCall?.find((arg): boolean => arg.startsWith("body="))?.slice("body=".length) ?? "";
    expect(body).toContain("gh run rerun 100");
    expect(body).toContain("<!-- nen-wake-guard run_id=100");
    expect(result.out.join("\n")).toMatch(/warning:.*gh run rerun 100 failed/);
  });

  it("warns rather than aborting when the follow-up comment POST fails", async () => {
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "bankai\\[bot\\]$", "--run"],
      (command, args): CommandResult => {
        const joined = args.join(" ");
        if (joined.includes("/pulls?")) return ok(openPr);
        if (joined.includes("/actions/runs")) return ok(runsWithSwallow);
        if (joined.includes("/issues/7/comments") && args.includes("-f")) {
          return { code: 1, stdout: "", stderr: "HTTP 500", spawnFailed: false };
        }
        if (joined.includes("/comments")) return ok("[]");
        return ok("");
      },
    );
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/warning:.*posting its follow-up comment failed/);
  });

  it("refuses an unparseable --author-pattern as a usage error", async () => {
    const result = await capture(
      ["wake", "verify", "--repo-slug", "o/r", "--now", "2026-01-01T00:00:00Z", "--author-pattern", "("],
      (): CommandResult => ok("[]"),
    );
    expect(result.code).toBe(2);
  });
});
