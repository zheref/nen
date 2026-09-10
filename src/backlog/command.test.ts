import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { backlogCommand } from "./command.js";
import { noPortProbe } from "../seam/scripted.js";

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
  const seams: Seams = {
    run,
    now: (): Date => new Date("2026-01-01T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("this verb has no interactive form");
    },
    platform: "linux",
  };
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

  it("does NOT let a row with a missing `number` make 'undefined' a matchable token (review finding on #64)", async () => {
    // --rows-from is unvalidated JSON (readJsonFile is a bare JSON.parse
    // cast), so a malformed row can arrive with no `number` at all --
    // String(undefined) is the perfectly matchable string "undefined", which
    // would both pass the refusal's known-set AND mark every number-less row.
    // Only digit-only stringifications may join the number-match path.
    const dir = mkdtempSync(join(tmpdir(), "nen-backlog-"));
    const file = join(dir, "rows.json");
    writeFileSync(
      file,
      JSON.stringify([
        { id: "XY-IS-#937", severity: "high", createdAt: "2026-09-01T22:55:36Z", number: 937 },
        { id: "XY-IS-#938", severity: "medium", createdAt: "2026-09-01T23:19:42Z" },
      ]),
    );
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--blocks", "undefined",
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const message = result.err.join("\n");
    expect(message).toMatch(/--blocks names no row with: 'undefined'/);
    // The roster advertises only tokens that WOULD match: the number-less row
    // is listed by id alone, never as "XY-IS-#938 (undefined)".
    expect(message).toMatch(/XY-IS-#937 \(937\), XY-IS-#938\./);
    expect(message).not.toMatch(/\(undefined\)/);
  });

  it("REFUSES a token against an EMPTY --rows-from file, naming the emptiness -- never fails open (review finding on #64)", async () => {
    // Pins the empty-roster branch of the refusal so a future early return on
    // rows.length === 0 (a plausible "nothing to order" shortcut) cannot
    // silently reintroduce #24's fail-open: a token the caller believed was
    // marking a row would once again order nothing and exit 0.
    const dir = mkdtempSync(join(tmpdir(), "nen-backlog-"));
    const file = join(dir, "rows.json");
    writeFileSync(file, "[]");
    const result = await capture([
      "backlog", "order", "--rows-from", file,
      "--severity-order", "critical,high,medium,low",
      "--blocks", "938",
    ]);
    expect(result.code).toBe(2);
    expect(result.out).toEqual([]);
    const message = result.err.join("\n");
    expect(message).toMatch(/--blocks names no row with: '938'/);
    expect(message).toMatch(/\(none -- the --rows-from file is empty\)/);
  });

  // #105: `--rows-from` used to be a bare `readJsonFile<readonly InRow[]>`
  // cast -- a compile-time assertion about runtime data that a wrong shape
  // sailed straight through. The worst case was `backlog fetch --json`'s OWN
  // output (an OBJECT, not the array `order` expects) reaching
  // `requireTokensMatch`'s `for (const row of rows)` as a bare object, which
  // crashed with the raw "nen backlog: {} is not iterable" at exit 1 -- an
  // input this verb's own --help already anticipated ("e.g. 'backlog fetch
  // --json' reshaped") but never actually checked for.
  describe("validates the row document at the read seam (#105)", () => {
    function writeFixture(content: string): string {
      const dir = mkdtempSync(join(tmpdir(), "nen-backlog-"));
      const file = join(dir, "rows.json");
      writeFileSync(file, content);
      return file;
    }

    it("REFUSES (exit 2) 'backlog fetch --json' output handed straight through, naming the mistake and 'backlog --help'", async () => {
      // `fetch`'s own emitted shape: `{ repo, truncated, ...assembly }` where
      // `assembly` is `fetch.ts`'s `Assembly` (`{ rows, issueCount, prCount }`)
      // -- exactly what `nen backlog fetch --repo-slug o/r --json > rows.json`
      // would write to disk, reproduced by hand here (never a live 'gh' call).
      const file = writeFixture(JSON.stringify({
        repo: "o/r",
        truncated: false,
        rows: [
          { issueNumber: 1, title: "an issue", labels: ["p2"], prNumbers: [5], createdAt: "2026-01-01T00:00:00Z" },
        ],
        issueCount: 1,
        prCount: 1,
      }));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      const message = result.err.join("\n");
      expect(message).toMatch(/looks like 'backlog fetch --json' output/);
      expect(message).toMatch(/Reshape it first/);
      expect(message).toMatch(/backlog --help/);
      expect(message).not.toMatch(/is not iterable/);
    });

    // Review finding (MAJOR, pre-merge): the refusal used to tell a caller to
    // reshape 'blocksOther'/'affectsConsumers' INTO each row -- but `order()`
    // never reads either field from JSON; they are computed below from the
    // --blocks/--affects-consumers CLI flags, matched by id or issue number.
    // A caller following the old wording's literal recipe got their
    // blocking/affecting judgement silently dropped: no error, exit 0, both
    // flags rendered as false. The message must instead point the caller at
    // the two flags, and must never present either field as something a row
    // in the JSON document carries.
    it("names --blocks/--affects-consumers as the way to mark a row, never as row fields to reshape in (review finding)", async () => {
      const file = writeFixture(JSON.stringify({
        repo: "o/r",
        truncated: false,
        rows: [
          { issueNumber: 1, title: "an issue", labels: ["p2"], prNumbers: [5], createdAt: "2026-01-01T00:00:00Z" },
        ],
        issueCount: 1,
        prCount: 1,
      }));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(2);
      const message = result.err.join("\n");
      expect(message).toMatch(/--blocks\/--affects-consumers/);
      // The old wording told the caller to reshape these INTO the row, as
      // the last item of the same recipe as 'id'/'number'/'severity'. The
      // corrected message may still name the fields (to say 'order' does
      // NOT read them from the file), but never as part of that recipe.
      expect(message).not.toMatch(/'blocksOther'\/'affectsConsumers' from your own/);
      const reshapeRecipe = message.split("-- then pass the reshaped array.")[0]!;
      expect(reshapeRecipe).not.toMatch(/blocksOther/);
      expect(message).toMatch(/does not read 'blocksOther'\/'affectsConsumers' from this file/);
    });

    it("REFUSES (exit 2) a non-array document with a generic 'must be a JSON ARRAY' message", async () => {
      const file = writeFixture(JSON.stringify({ foo: "bar" }));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      const message = result.err.join("\n");
      expect(message).toMatch(/must be a JSON ARRAY of rows/);
      expect(message).not.toMatch(/is not iterable/);
    });

    it("REFUSES (exit 2) a row missing 'severity', naming the file, the row and the field", async () => {
      const file = writeFixture(JSON.stringify([
        { id: "XY-IS-#1", createdAt: "2026-01-01T00:00:00Z", number: 1 },
      ]));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      const message = result.err.join("\n");
      // toContain, not a RegExp built from the path: on Windows `file` is
      // `C:\Users\RUNNER~1\...`, and backslashes read as regex escapes.
      expect(message).toContain(`'${file}'`);
      expect(message).toMatch(/row 'XY-IS-#1' needs a string 'severity'/);
      expect(message).toMatch(/got nothing \(the field is missing\)/);
    });

    it("REFUSES (exit 2) a row whose 'createdAt' is not a string, naming the file, the row and the field", async () => {
      const file = writeFixture(JSON.stringify([
        { id: "XY-IS-#1", severity: "high", createdAt: 12345, number: 1 },
      ]));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      const message = result.err.join("\n");
      // toContain, not a RegExp built from the path: on Windows `file` is
      // `C:\Users\RUNNER~1\...`, and backslashes read as regex escapes.
      expect(message).toContain(`'${file}'`);
      expect(message).toMatch(/row 'XY-IS-#1' needs a string 'createdAt', got a number/);
    });

    it("REFUSES (exit 2) a row that is not an object at all (e.g. a bare string)", async () => {
      const file = writeFixture(JSON.stringify(["not-a-row"]));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(2);
      expect(result.out).toEqual([]);
      const message = result.err.join("\n");
      expect(message).toMatch(/row at index 0 is the string 'not-a-row', not a row object/);
    });

    it("still accepts a null 'severity' (an untriaged row that ranks last) -- null is not the same refusal as missing", async () => {
      const file = writeFixture(JSON.stringify([
        { id: "untriaged", severity: null, createdAt: "2026-01-01T00:00:00Z", number: 1 },
        { id: "critical", severity: "critical", createdAt: "2026-01-01T00:00:00Z", number: 2 },
      ]));
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
      ]);
      expect(result.code).toBe(0);
      expect(result.out[0]).toMatch(/1\. critical/);
      expect(result.out[1]).toMatch(/2\. untriaged {2}severity=\(none\)/);
    });

    // BYTE-PARITY ON AN EXISTING FIXTURE'S OUTPUT: the unchanged happy path
    // from issue #24's own fixture, asserted as an exact array (not just
    // regex matches), so the new read-seam validation cannot be the thing
    // that quietly changes a byte of a well-formed call's output.
    it("does not change a single byte of the happy path's output (issue #24's fixture, byte-parity)", async () => {
      const file = writeIssue24Rows();
      const result = await capture([
        "backlog", "order", "--rows-from", file,
        "--severity-order", "critical,high,medium,low",
        "--blocks", "938,939",
      ]);
      expect(result.code).toBe(0);
      expect(result.out).toEqual([
        "1. XY-IS-#937  severity=high  2026-09-01T22:55:36Z",
        "2. XY-IS-#938  severity=medium blocks  2026-09-01T23:19:42Z",
        "3. XY-IS-#939  severity=medium blocks  2026-09-01T23:47:08Z",
      ]);
      expect(result.err).toEqual([]);
    });
  });
});

// Review finding (MAJOR, pre-merge): `--help`'s own `--rows-from` entry told
// a caller to reshape 'blocksOther'/'affectsConsumers' INTO each row -- an
// input `order()` never reads, since both are computed from the
// --blocks/--affects-consumers flags below, matched by id or issue number. A
// caller who followed that literal recipe got both flags rendered as false
// with no error at all. This pins the corrected text: the two flags are
// named as how a row is marked, and neither field is presented as something
// the row document itself carries.
describe("backlog --help names --blocks/--affects-consumers, never row fields to reshape in (review finding)", () => {
  it("'--rows-from's entry points at the two CLI flags, not at row keys", () => {
    expect(backlogCommand.usage).toMatch(/--blocks\/--affects-consumers/);
    expect(backlogCommand.usage).not.toMatch(/'blocksOther'\/'affectsConsumers' from your own/);
  });

  it("documents 'createdAt' as an ISO-8601 instant, since ordering compares it as plain text", () => {
    expect(backlogCommand.usage).toMatch(/ISO-8601/);
  });
});
