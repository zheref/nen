import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { backlogCommand } from "./command.js";

// DRIVES THE REAL `runFamily` (../index.ts), not a hand-copy of its
// error-to-exit-code mapping (review finding: several family test files
// re-implemented that mapping locally, which can silently drift from the
// real one). This also exercises the real re-parse against
// `mergeFlags(family.flags)` and the real `--repo`/`--json` merge, the same
// path a live invocation takes.
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
  const seams: Seams = { run, now: (): Date => new Date("2026-01-01T00:00:00Z"), env: {} };
  const code = runFamily(backlogCommand, argv, null, false, io, seams);
  return { code, out, err };
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

  it("reports truncation explicitly, and NAMES A WORKING REMEDY, when --limit actually cuts something", () => {
    const twoIssues = JSON.stringify([
      { number: 1, title: "a", labels: [], created_at: "2026-01-01T00:00:00Z" },
      { number: 2, title: "b", labels: [], created_at: "2026-01-01T00:00:00Z" },
    ]);
    const result = capture(["backlog", "fetch", "--repo-slug", "o/r", "--limit", "1"], (command, args): CommandResult => {
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: twoIssues, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/TRUNCATED at --limit 1/);
    // "Raise --limit" is a working remedy now that --limit caps a TOTAL
    // across pages rather than the per_page a single 'gh api' call was
    // silently clamped to (review finding).
    expect(result.out.join("\n")).toMatch(/Raise --limit, or omit it/);
  });

  it("does NOT report truncation when --limit lands exactly on the true total (nothing was actually cut)", () => {
    const result = capture(["backlog", "fetch", "--repo-slug", "o/r", "--limit", "1"], (command, args): CommandResult => {
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: issues, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toMatch(/TRUNCATED/);
  });

  it("PAGINATES past GitHub's 100-row page clamp -- a >100-issue repo is no longer capped with no way to lift it (review finding)", () => {
    // Page 1 comes back FULL (100 rows, GitHub's own per_page maximum); page
    // 2 comes back short (30 rows) -- the true signal that there is no page
    // 3. Omitting --limit must fetch every row across both pages.
    const page1 = JSON.stringify(
      Array.from({ length: 100 }, (_unused, i): unknown => ({
        number: i + 1,
        title: `issue ${i + 1}`,
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
      })),
    );
    const page2 = JSON.stringify(
      Array.from({ length: 30 }, (_unused, i): unknown => ({
        number: 100 + i + 1,
        title: `issue ${100 + i + 1}`,
        labels: [],
        created_at: "2026-01-01T00:00:00Z",
      })),
    );
    const calls: string[] = [];
    const result = capture(["backlog", "fetch", "--repo-slug", "o/r"], (command, args): CommandResult => {
      const joined = args.join(" ");
      calls.push(joined);
      if (joined.includes("/issues?") && /[?&]page=1(&|$)/.test(joined)) return { code: 0, stdout: page1, stderr: "", spawnFailed: false };
      if (joined.includes("/issues?") && /[?&]page=2(&|$)/.test(joined)) return { code: 0, stdout: page2, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/130 row\(s\)/);
    expect(result.out.join("\n")).not.toMatch(/TRUNCATED/);
    expect(calls.some((c): boolean => c.includes("/issues?") && /[?&]page=2(&|$)/.test(c))).toBe(true);
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
