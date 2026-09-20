// src/report/objects.test.ts -- `objects[]`: the offline read seam's
// validation, the two readiness authorities, and the flags that switch the
// register on.
//
// NO NETWORK, AND THE OFFLINE PATH IS WHY. `--objects-from` exists so the
// register can be exercised without a token, and these tests drive it through
// the real `runFamily` dispatcher with a ScriptedSeams that THROWS on any call
// nobody scripted -- so "the register flags reach no gh unless they must"
// is proved by the fixture rather than asserted in a comment.

import { describe, expect, it } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { reportCommand } from "./command.js";
import { countChecks, parseObjects, parseVerdictLine, renderObjects, type ReportObject } from "./objects.js";
import type { RollupEntry } from "../github/types.js";

const FIELD = "";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const COVERAGE_REPO = join(process.cwd(), "src", "schema", "fixtures", "shu-coverage-repo");

/** The four git reads `report data` makes, all answered, and nothing else. */
function script(): ScriptedCall[] {
  return [
    { match: "git rev-parse --verify --quiet main^{commit}", result: { code: 0, stdout: "0123456789abcdef\n" } },
    { match: "git symbolic-ref --short HEAD", result: { code: 0, stdout: "feat/register\n" } },
    { match: `git log main..HEAD --format=${LOG_FORMAT}`, result: { code: 0, stdout: "" } },
    { match: "git diff --name-status main...HEAD", result: { code: 0, stdout: "" } },
  ];
}

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
}

async function capture(argv: readonly string[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams(script(), { now: (): Date => NOW, platform: "linux" });
  const code = await runFamily(reportCommand, argv, null, false, io, seams);
  return { code, out, err, seams };
}

function objectsFile(rows: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-objects-"));
  const path = join(dir, "objects.json");
  writeFileSync(path, JSON.stringify(rows), "utf8");
  return path;
}

const PR_ROW = {
  kind: "pr",
  number: 87,
  title: "feat(report): the register",
  url: "https://github.com/zheref/hatsu/pull/87",
  state: "OPEN",
  labels: ["hatsu:severity/high"],
  head: "2a6539c0000000000000000000000000000000aa",
  mergeStateStatus: "CLEAN",
  checks: { total: 4, green: 4, red: 0, pending: 0 },
  threads: { total: 7, unresolved: 0 },
  reviewRequests: ["copilot-pull-request-reviewer[bot]"],
  linked: [85],
  readiness: { verdict: "ready", reason: "ready", source: "check" },
};

const ISSUE_ROW = {
  kind: "issue",
  number: 85,
  title: "The report register",
  url: "https://github.com/zheref/hatsu/issues/85",
  state: "OPEN",
  labels: [],
  linked: [87],
  readiness: null,
};

describe("parseObjects -- the read seam", () => {
  it("re-emits every row in the CONTRACT's key order, whatever order the file spelled them", () => {
    const shuffled = { readiness: null, linked: [87], labels: [], state: "OPEN", url: "u", title: "t", number: 85, kind: "issue" };
    const rows = parseObjects([shuffled, PR_ROW], "objects.json");
    expect(Object.keys(rows[0] as object)).toEqual([
      "kind",
      "number",
      "title",
      "url",
      "state",
      "labels",
      "linked",
      "readiness",
    ]);
    expect(Object.keys(rows[1] as object)).toEqual([
      "kind",
      "number",
      "title",
      "url",
      "state",
      "labels",
      "head",
      "mergeStateStatus",
      "checks",
      "threads",
      "reviewRequests",
      "linked",
      "readiness",
    ]);
  });

  it("refuses BY ROW INDEX, naming the field", () => {
    expect(() => parseObjects([ISSUE_ROW, { ...PR_ROW, head: 12 }], "o.json")).toThrow(
      /'o\.json': row 1 has 'head' of type a number, not a string/,
    );
    expect(() => parseObjects([{ ...ISSUE_ROW, number: 0 }], "o.json")).toThrow(
      /row 0 has 'number' of a number, not a positive whole number/,
    );
    expect(() => parseObjects([{ ...ISSUE_ROW, kind: "epic" }], "o.json")).toThrow(
      /row 0 has 'kind' of 'epic' -- it is 'pr' or 'issue'/,
    );
    expect(() => parseObjects([{ ...PR_ROW, checks: { total: 4, green: 4, red: 0 } }], "o.json")).toThrow(
      /row 0 has 'checks\.pending' of nothing, not a whole count/,
    );
    expect(() => parseObjects([{ ...PR_ROW, labels: ["ok", 3] }], "o.json")).toThrow(
      /row 0 has 'labels' that is not a list of strings/,
    );
    expect(() => parseObjects("not a list", "o.json")).toThrow(/is not a JSON array of object rows/);
  });

  it("refuses an ISSUE carrying a readiness -- CON-32 is a statement about a pull request", () => {
    expect(() =>
      parseObjects([{ ...ISSUE_ROW, readiness: { verdict: "ready", reason: "r", source: "check" } }], "o.json"),
    ).toThrow(/row 0 is an issue carrying a 'readiness'/);
  });

  it("refuses a readiness whose `source` is not one of the two authorities", () => {
    expect(() =>
      parseObjects([{ ...PR_ROW, readiness: { verdict: "ready", reason: "r", source: "guessed" } }], "o.json"),
    ).toThrow(/row 0 has 'readiness\.source' of 'guessed'/);
  });
});

describe("parseVerdictLine", () => {
  it("reads an anchored verdict word and never one found inside prose", () => {
    expect(parseVerdictLine("ready")).toEqual({ verdict: "ready", reason: "ready" });
    expect(parseVerdictLine("not-ready: two checks are red")?.verdict).toBe("not-ready");
    // The word inside a sentence is NOT a verdict: this is the substring
    // accident the anchoring exists to refuse.
    expect(parseVerdictLine("this readiness run is still deciding")).toBeNull();
    expect(parseVerdictLine("## Summary\nnot-ready: one thread is unresolved")?.reason).toBe(
      "not-ready: one thread is unresolved",
    );
  });
});

describe("countChecks", () => {
  const run = (name: string, conclusion: string | null, startedAt: string): RollupEntry => ({
    kind: "check_run",
    name,
    status: conclusion === null ? "IN_PROGRESS" : "COMPLETED",
    conclusion: conclusion as never,
    startedAt,
    completedAt: null,
    detailsUrl: null,
  });

  it("counts the LATEST run per name, and never folds a missing conclusion into green", () => {
    const counted = countChecks([
      run("build", "FAILURE", "2026-09-20T09:00:00Z"),
      run("build", "SUCCESS", "2026-09-20T10:00:00Z"),
      run("lint", null, "2026-09-20T10:00:00Z"),
      run("test", "SKIPPED", "2026-09-20T10:00:00Z"),
      run("audit", "TIMED_OUT", "2026-09-20T10:00:00Z"),
    ]);
    expect(counted).toEqual({ total: 4, green: 2, red: 1, pending: 1 });
  });
});

describe("nen report data --objects-from", () => {
  it("appends `objects` at the END of the key order, filled from the file", async () => {
    const captured = await capture([
      "report",
      "data",
      "--repo",
      COVERAGE_REPO,
      "--base",
      "main",
      "--objects-from",
      objectsFile([ISSUE_ROW, PR_ROW]),
      "--json",
    ]);
    expect(captured.code).toBe(0);
    const document = JSON.parse(captured.out.join("\n")) as Record<string, unknown>;
    expect(Object.keys(document).at(-1)).toBe("objects");
    const objects = document["objects"] as ReportObject[];
    expect(objects.map((row): number => row.number)).toEqual([85, 87]);
    // And no gh call was made: the offline path is offline.
    expect(captured.seams.calls.every((call): boolean => call.command === "git")).toBe(true);
  });

  it("is `[]` when no register flag is given -- the v0.11 document, byte for byte", async () => {
    const captured = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--json"]);
    expect(captured.code).toBe(0);
    expect((JSON.parse(captured.out.join("\n")) as Record<string, unknown>)["objects"]).toEqual([]);
    expect(captured.out.join("\n")).not.toMatch(/gh /);
  });

  it("refuses a file whose rows are malformed, at exit 2, before anything is printed", async () => {
    const captured = await capture([
      "report",
      "data",
      "--repo",
      COVERAGE_REPO,
      "--base",
      "main",
      "--objects-from",
      objectsFile([ISSUE_ROW, { ...PR_ROW, threads: { total: 7 } }]),
      "--json",
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/row 1 has 'threads\.unresolved' of nothing/);
    expect(captured.out).toEqual([]);
  });

  it("refuses mixing the file with the live flags -- one authority per run", async () => {
    const captured = await capture([
      "report",
      "data",
      "--repo",
      COVERAGE_REPO,
      "--base",
      "main",
      "--objects-from",
      objectsFile([]),
      "--backlog",
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/Give one or the other/);
  });

  it("refuses --prs without --target, and a non-numeric --prs entry, at exit 2", async () => {
    const noTarget = await capture(["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--prs", "87"]);
    expect(noTarget.code).toBe(2);
    expect(noTarget.err.join("\n")).toMatch(/--target owner\/name is required/);
    const bad = await capture([
      "report",
      "data",
      "--repo",
      COVERAGE_REPO,
      "--base",
      "main",
      "--target",
      "zheref/hatsu",
      "--prs",
      "87,eighty-eight",
    ]);
    expect(bad.code).toBe(2);
    expect(bad.err.join("\n")).toMatch(/--prs takes a comma-separated list/);
  });

  it("refuses a malformed --target as a typo (exit 2), not as a failure", async () => {
    const captured = await capture([
      "report",
      "data",
      "--repo",
      COVERAGE_REPO,
      "--base",
      "main",
      "--target",
      "not-a-slug",
      "--backlog",
    ]);
    expect(captured.code).toBe(2);
  });
});

describe("renderObjects", () => {
  it("says WHICH authority answered each readiness, and names the absence of a register", () => {
    expect(renderObjects([])[0]).toMatch(/objects: none \(no --target/);
    const lines = renderObjects(parseObjects([ISSUE_ROW, PR_ROW], "o.json")).join("\n");
    expect(lines).toContain("IS #85  OPEN  The report register");
    expect(lines).toContain("[ready (check)]");
    expect(lines).toContain("checks 4/4 green, 0 red, 0 pending  threads 0/7 unresolved");
    expect(lines).toContain("linked: #87");
  });
});
