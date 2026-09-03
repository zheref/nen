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
async function capture(argv: readonly string[], run: Seams["run"] = (): CommandResult => ({ code: 0, stdout: "[]", stderr: "", spawnFailed: false })): Promise<{
  code: number;
  out: string[];
  err: string[];
}> {
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
  const code = await runFamily(backlogCommand, argv, null, false, io, seams);
  return { code, out, err };
}

describe("nen backlog fetch", () => {
  const issues = JSON.stringify([
    { number: 1, title: "an issue", labels: [{ name: "a" }], created_at: "2026-01-01T00:00:00Z" },
  ]);
  const prs = JSON.stringify([
    { number: 5, title: "fix #1", body: "closes #1", created_at: "2026-01-02T00:00:00Z" },
  ]);

  it("assembles one row per effort and reports no truncation under the limit", async () => {
    const result = await capture(["backlog", "fetch", "--repo-slug", "o/r"], (command, args): CommandResult => {
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: issues, stderr: "", spawnFailed: false };
      if (joined.includes("/pulls?")) return { code: 0, stdout: prs, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toMatch(/1 row\(s\)/);
    expect(result.out.join("\n")).not.toMatch(/TRUNCATED/);
  });

  it("reports truncation explicitly, and NAMES A WORKING REMEDY, when --limit actually cuts something", async () => {
    const twoIssues = JSON.stringify([
      { number: 1, title: "a", labels: [], created_at: "2026-01-01T00:00:00Z" },
      { number: 2, title: "b", labels: [], created_at: "2026-01-01T00:00:00Z" },
    ]);
    const result = await capture(["backlog", "fetch", "--repo-slug", "o/r", "--limit", "1"], (command, args): CommandResult => {
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

  it("does NOT report truncation when --limit lands exactly on the true total (nothing was actually cut)", async () => {
    const result = await capture(["backlog", "fetch", "--repo-slug", "o/r", "--limit", "1"], (command, args): CommandResult => {
      const joined = args.join(" ");
      if (joined.includes("/issues?")) return { code: 0, stdout: issues, stderr: "", spawnFailed: false };
      return { code: 0, stdout: "[]", stderr: "", spawnFailed: false };
    });
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).not.toMatch(/TRUNCATED/);
  });

  it("PAGINATES past GitHub's 100-row page clamp -- a >100-issue repo is no longer capped with no way to lift it (review finding)", async () => {
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
    const result = await capture(["backlog", "fetch", "--repo-slug", "o/r"], (command, args): CommandResult => {
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
  it("orders a pre-fetched row file by severity", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-backlog-"));
    const file = join(dir, "rows.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "low", severity: "low", createdAt: "2026-01-01T00:00:00Z", number: 1 },
        { id: "critical", severity: "critical", createdAt: "2026-01-01T00:00:00Z", number: 2 },
      ]),
    );
    const result = await capture(["backlog", "order", "--rows-from", file, "--severity-order", "critical,high,medium,low"]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/1\. critical/);
    expect(result.out[1]).toMatch(/2\. low/);
  });

  // Issue #24's exact fixture: formatted-object-reference ids alongside bare
  // `number` fields. `--help` always documented `--blocks <n,n>` -- bare
  // numbers -- but the matching compared tokens against `row.id` verbatim, so
  // the documented form silently no-opped (exit 0, no `blocks` mark, no error).
  const issue24Rows = JSON.stringify([
    { id: "XY-IS-#937", severity: "high", createdAt: "2026-09-01T22:55:36Z", number: 937 },
    { id: "XY-IS-#938", severity: "medium", createdAt: "2026-09-01T23:19:42Z", number: 938 },
    { id: "XY-IS-#939", severity: "medium", createdAt: "2026-09-01T23:47:08Z", number: 939 },
  ]);

  function writeIssue24Rows(): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-backlog-"));
    const file = join(dir, "rows.json");
    writeFileSync(file, issue24Rows);
    return file;
  }

  it("marks blocks from BARE ISSUE NUMBERS, the form --help's <n,n> notation documents (issue #24)", async () => {
    const file = writeIssue24Rows();
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--blocks", "938,939",
    ]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/1\. XY-IS-#937 {2}severity=high/);
    expect(result.out[1]).toMatch(/2\. XY-IS-#938 {2}severity=medium blocks/);
    expect(result.out[2]).toMatch(/3\. XY-IS-#939 {2}severity=medium blocks/);
  });

  it("still accepts the row's own id-string form, which was the only working workaround pre-fix", async () => {
    const file = writeIssue24Rows();
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--blocks", "XY-IS-#938,XY-IS-#939",
    ]);
    expect(result.code).toBe(0);
    expect(result.out[1]).toMatch(/2\. XY-IS-#938 {2}severity=medium blocks/);
    expect(result.out[2]).toMatch(/3\. XY-IS-#939 {2}severity=medium blocks/);
  });

  it("matches bare numbers for --affects-consumers the same way as --blocks", async () => {
    const file = writeIssue24Rows();
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--affects-consumers", "937",
    ]);
    expect(result.code).toBe(0);
    expect(result.out[0]).toMatch(/1\. XY-IS-#937 {2}severity=high affects-consumers/);
  });

  it("REFUSES (exit 2) a token that names no row, instead of the silent no-op that was #24's core defect", async () => {
    const file = writeIssue24Rows();
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--blocks", "940",
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const message = result.err.join("\n");
    // The refusal is actionable on its own: it names the bad token, the flag
    // it arrived on, and the full roster of ids/numbers that WOULD match.
    expect(message).toMatch(/--blocks names no row with: '940'/);
    expect(message).toMatch(/id or its bare issue number/);
    expect(message).toMatch(/XY-IS-#937 \(937\), XY-IS-#938 \(938\), XY-IS-#939 \(939\)/);
  });

  it("names EVERY unmatched token across BOTH flags in one refusal, not one per round trip", async () => {
    const file = writeIssue24Rows();
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--blocks", "938,940,XY-IS-#999",
      "--affects-consumers", "941",
    ]);
    expect(result.code).toBe(2);
    const message = result.err.join("\n");
    expect(message).toMatch(/--blocks names no row with: '940', 'XY-IS-#999'/);
    expect(message).toMatch(/--affects-consumers names no row with: '941'/);
  });
});
