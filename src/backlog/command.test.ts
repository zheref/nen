import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, UsageError } from "../cli/args.js";
import { mergeFlags, VerbUsageError } from "../cli/command.js";
import type { Io } from "../index.js";
import { RepoRootError } from "../repo/root.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { backlogCommand } from "./command.js";

function capture(argv: readonly string[], run: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "[]", stderr: "", spawnFailed: false })): {
  code: number;
  out: string[];
  err: string[];
} {
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
  const args = parseArgs(argv, mergeFlags(backlogCommand.flags));
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  try {
    const code = backlogCommand.run({ args, repoFlag: null, json: args.booleans.has("json"), io, seams });
    return { code, out, err };
  } catch (error) {
    err.push(error instanceof Error ? error.message : String(error));
    const code = error instanceof VerbUsageError || error instanceof UsageError || error instanceof RepoRootError ? 2 : 1;
    return { code, out, err };
  }
}

describe("nen backlog fetch", () => {
  const issues = JSON.stringify([
    { number: 1, title: "an issue", labels: [{ name: "a" }], created_at: "2026-01-01T00:00:00Z" },
  ]);
  const prs = JSON.stringify([
    { number: 5, title: "fix #1", body: "closes #1", created_at: "2026-01-02T00:00:00Z" },
  ]);

  it("assembles one row per effort and reports no truncation under the limit", () => {
    const result = capture(["backlog", "fetch", "--repo-slug", "o/r"], (command, args): CommandResult => {
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: issues, stderr: "", spawnFailed: false };
      if (joined.includes("/pulls?")) return { code: 0, stdout: prs, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/1 row\(s\)/);
    expect(result.out.join("\n")).not.toMatch(/TRUNCATED/);
  });

  it("reports truncation explicitly rather than silently capping", () => {
    const result = capture(["backlog", "fetch", "--repo-slug", "o/r", "--limit", "1"], (command, args): CommandResult => {
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: issues, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/TRUNCATED at --limit 1/);
  });
});

describe("nen backlog order", () => {
  it("orders a pre-fetched row file by severity", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-backlog-"));
    const file = join(dir, "rows.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "low", severity: "low", createdAt: "2026-01-01T00:00:00Z", number: 1 },
        { id: "critical", severity: "critical", createdAt: "2026-01-01T00:00:00Z", number: 2 },
      ]),
    );
    const result = capture(["backlog", "order", "--rows-from", file, "--severity-order", "critical,high,medium,low"]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/1\. critical/);
    expect(result.out[1]).toMatch(/2\. low/);
  });
});
