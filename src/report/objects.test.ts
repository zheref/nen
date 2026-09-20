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
import {
  checkRunsArgv,
  countChecks,
  issueArgv,
  parseObjects,
  parseVerdictLine,
  renderObjects,
  type ReportObject,
} from "./objects.js";
import { viewArgv } from "../pr/fetch.js";
import { listArgv } from "../pr/threads.js";
import { parseTarget } from "../github/target.js";
import type { RollupEntry } from "../github/types.js";

const FIELD = "";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;
const NOW = new Date("2026-09-20T12:00:00.000Z");
const COVERAGE_REPO = join(process.cwd(), "src", "schema", "fixtures", "shu-coverage-repo");
const TARGET = parseTarget("zheref/nen");
const HEAD_SHA = "7db8de509dfb8623125e9d523220c69d3c8dbad1";

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

const PR_ROW: Record<string, unknown> = {
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
      "notes",
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
      "notes",
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

// ── the LIVE path (Nobunaga N1, N2, N5; Feitan F1, F4) ─────────────────────
//
// Every `gh` call is scripted, and ScriptedSeams throws on one nobody wrote --
// so the number of calls this path makes is pinned by construction, and a
// register that reached for the network somewhere new is a red test rather
// than a surprise on a live run.

const PR_VIEW = {
  number: 217,
  headRefOid: "7db8de509dfb8623125e9d523220c69d3c8dbad1",
  baseRefName: "main",
  headRefName: "feat/x",
  author: { login: "zheref" },
  labels: [{ name: "nen:severity/high" }, { name: "nen:lane/cli" }],
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  isDraft: false,
  body: "Closes #215 and refs #220.",
  url: "https://github.com/zheref/nen/pull/217",
  title: "feat(pr): review threads",
  state: "OPEN",
  statusCheckRollup: [
    { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-20T10:00:00Z", completedAt: null, detailsUrl: null },
    { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE", startedAt: "2026-09-20T10:00:00Z", completedAt: null, detailsUrl: null },
  ],
  reviewRequests: [{ login: "copilot-pull-request-reviewer" }],
};

function viewCall(overrides: Record<string, unknown> = {}): ScriptedCall {
  return {
    match: `gh ${viewArgv(TARGET, 217).join(" ")}`,
    result: { code: 0, stdout: JSON.stringify({ ...PR_VIEW, ...overrides }) },
  };
}

function threadsCall(nodes: readonly unknown[]): ScriptedCall {
  return {
    match: `gh ${listArgv(TARGET, 217).join(" ")}`,
    result: {
      code: 0,
      stdout: JSON.stringify({
        data: { repository: { pullRequest: { headRefOid: "7db8de50", reviewThreads: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } },
      }),
    },
  };
}

function checkRunsCall(runs: readonly unknown[]): ScriptedCall {
  return {
    match: `gh ${checkRunsArgv(TARGET, HEAD_SHA).join(" ")}`,
    result: { code: 0, stdout: JSON.stringify({ check_runs: runs }) },
  };
}

const THREAD_NODES = [
  { id: "T1", isResolved: true, path: "a.ts", line: 1, comments: { nodes: [{ author: { login: "a" }, body: "b", url: "u" }] } },
  { id: "T2", isResolved: false, path: "b.ts", line: 2, comments: { nodes: [{ author: { login: "a" }, body: "b", url: "u" }] } },
];

function readinessRun(over: Record<string, unknown> = {}): unknown {
  return {
    name: "readiness",
    status: "completed",
    conclusion: "SUCCESS",
    started_at: "2026-09-20T10:00:00Z",
    output: { title: "Readiness", summary: "ready", text: null },
    ...over,
  };
}

async function live(argv: readonly string[], calls: readonly ScriptedCall[]): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => void out.push(line),
    err: (line): void => void err.push(line),
  };
  const seams = new ScriptedSeams([...script(), ...calls], { now: (): Date => NOW, platform: "linux" });
  const code = await runFamily(reportCommand, argv, null, false, io, seams);
  return { code, out, err, seams };
}

const LIVE_PR = [
  "report",
  "data",
  "--repo",
  COVERAGE_REPO,
  "--base",
  "main",
  "--target",
  "zheref/nen",
  "--prs",
  "217",
  "--json",
];

describe("the live register", () => {
  it("reads one pull request whole, with readiness from the head's own check run", async () => {
    const captured = await live(LIVE_PR, [viewCall(), checkRunsCall([readinessRun()]), threadsCall(THREAD_NODES)]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    expect(Object.keys(row)).toEqual([
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
      "notes",
    ]);
    expect(row["labels"]).toEqual(["nen:severity/high", "nen:lane/cli"]);
    expect(row["mergeStateStatus"]).toBe("CLEAN");
    expect(row["checks"]).toEqual({ total: 2, green: 1, red: 1, pending: 0 });
    expect(row["threads"]).toEqual({ total: 2, unresolved: 1 });
    expect(row["reviewRequests"]).toEqual(["copilot-pull-request-reviewer"]);
    // `linked` is back-filled from the body's closing keywords and bare refs.
    expect(row["linked"]).toEqual([215, 220]);
    expect(row["readiness"]).toEqual({ verdict: "ready", reason: "ready", source: "check" });
    expect(row["notes"]).toEqual([]);
  });

  it("KEEPS THE ROW when the rollup will not validate, and names the degradation (N2)", async () => {
    // The reproducer: an in-flight check run whose `conclusion` came back as
    // the empty string deleted the whole pull request the caller had named,
    // at exit 0, with an empty register.
    const captured = await live(LIVE_PR, [
      viewCall({
        statusCheckRollup: [
          { __typename: "CheckRun", name: "build", status: "COMPLETED", conclusion: "SUCCESS", startedAt: "2026-09-20T10:00:00Z", completedAt: null, detailsUrl: null },
          { __typename: "CheckRun", name: "flight", status: "IN_PROGRESS", conclusion: "", startedAt: "2026-09-20T10:00:00Z", completedAt: null, detailsUrl: null },
        ],
      }),
      checkRunsCall([readinessRun()]),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code).toBe(0);
    const objects = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects;
    // THE ROW SURVIVES...
    expect(objects).toHaveLength(1);
    const row = objects[0] as unknown as Record<string, unknown>;
    expect(row["number"]).toBe(217);
    // ...its unreadable field degrades, with the unreadable entry counted
    // pending and never green...
    expect(row["checks"]).toEqual({ total: 2, green: 1, red: 0, pending: 1 });
    // ...and the degradation is named in the row AND on stderr.
    expect((row["notes"] as string[])[0]).toMatch(/check rollup did not validate/);
    expect(captured.err.join("\n")).toMatch(/check rollup did not validate/);
    // Everything else is untouched.
    expect(row["readiness"]).toEqual({ verdict: "ready", reason: "ready", source: "check" });
  });

  it("degrades the thread counts to 0/0 and says they mean 'not read'", async () => {
    const captured = await live(LIVE_PR, [
      viewCall(),
      checkRunsCall([readinessRun()]),
      {
        match: `gh ${listArgv(TARGET, 217).join(" ")}`,
        result: { code: 1, stderr: "HTTP 502\n" },
      },
    ]);
    expect(captured.code).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    expect(row["threads"]).toEqual({ total: 0, unresolved: 0 });
    expect((row["notes"] as string[]).join(" ")).toMatch(/mean 'not read' rather than 'none'/);
  });

  it("REFUSES rather than losing an object the caller named", async () => {
    const captured = await live(LIVE_PR, [
      { match: `gh ${viewArgv(TARGET, 217).join(" ")}`, result: { code: 1, stderr: "HTTP 404: Not Found\n" } },
    ]);
    // Exit 1, not a short register at exit 0: a field may degrade, an OBJECT
    // may not go missing.
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toMatch(/Refusing to publish a register that silently leaves out an object you asked for/);
  });
});

describe("readiness, and which authority answered it", () => {
  const withRuns = async (runs: readonly unknown[]): Promise<Captured> =>
    live(LIVE_PR, [viewCall(), checkRunsCall(runs), threadsCall(THREAD_NODES)]);

  const readinessOf = (captured: Captured): unknown =>
    ((JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>)["readiness"];

  it("takes the LATEST run of that name, never the first the array carries (N5)", async () => {
    const captured = await withRuns([
      readinessRun({ started_at: "2026-09-20T09:00:00Z", output: { summary: "ready" } }),
      readinessRun({ started_at: "2026-09-20T11:00:00Z", output: { summary: "not-ready: one thread is unresolved" } }),
    ]);
    expect(readinessOf(captured)).toEqual({
      verdict: "not-ready",
      reason: "not-ready: one thread is unresolved",
      source: "check",
    });
  });

  it("refuses a run that is still IN PROGRESS, and falls through (F1)", async () => {
    const captured = await withRuns([readinessRun({ status: "in_progress", conclusion: null })]);
    expect(readinessOf(captured)).toBeNull();
    expect(captured.err.join("\n")).toMatch(/is 'in_progress', not 'completed'/);
  });

  it("accepts a verdict ONLY from a run that concluded SUCCESS (F1, Copilot #221)", async () => {
    // An ALLOWLIST, not a denylist: the first cut listed the terminal
    // failures, and an absent/null/empty/unfamiliar conclusion stringified to
    // "" -- in no denylist -- so a malformed run saying `ready` was trusted.
    for (const conclusion of ["FAILURE", "CANCELLED", "NEUTRAL", "", null, undefined, "SOMETHING_NEW"]) {
      const captured = await withRuns([readinessRun({ conclusion, output: { summary: "ready" } })]);
      expect(readinessOf(captured), `conclusion ${String(conclusion)} published a verdict`).toBeNull();
      expect(captured.err.join("\n")).toMatch(/not SUCCESS -- only a run that succeeded may publish a readiness verdict/);
    }
    // And SUCCESS still does.
    const good = await withRuns([readinessRun({ conclusion: "SUCCESS", output: { summary: "ready" } })]);
    expect(readinessOf(good)).toEqual({ verdict: "ready", reason: "ready", source: "check" });
  });

  it("never reads output.TITLE as a verdict -- 'Ready to merge' is not a verdict (F1)", async () => {
    const captured = await withRuns([
      readinessRun({ output: { title: "Ready to merge", summary: "See the job log.", text: null } }),
    ]);
    expect(readinessOf(captured)).toBeNull();
    expect(captured.err.join("\n")).toMatch(/names no verdict line/);
  });

  it("is null WITH THE REASON when neither authority can be read", async () => {
    const captured = await live(LIVE_PR, [
      viewCall(),
      { match: `gh ${checkRunsArgv(TARGET, HEAD_SHA).join(" ")}`, result: { code: 1, stderr: "HTTP 403\n" } },
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code).toBe(0);
    // No check run readable, and the in-process gate has no token here.
    expect(readinessOf(captured)).toBeNull();
    expect(captured.err.join("\n")).toMatch(/objects: the readiness gate/);
  });
});

describe("--backlog", () => {
  const BACKLOG = ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--target", "zheref/nen", "--backlog", "--json"];

  function openPage(items: readonly unknown[]): ScriptedCall {
    return {
      match: "gh api --method GET repos/zheref/nen/issues?state=open&per_page=100&page=1",
      result: { code: 0, stdout: JSON.stringify(items) },
    };
  }

  it("splits pull_request rows from issues, and back-fills each issue's linked PRs", async () => {
    const captured = await live(BACKLOG, [
      openPage([
        { number: 215, title: "pr threads", labels: [{ name: "nen:severity/high" }], state: "open", html_url: "https://github.com/zheref/nen/issues/215", body: "" },
        { number: 220, title: "reports and reviewers", labels: [], state: "open", html_url: "https://github.com/zheref/nen/issues/220", body: "" },
        { number: 217, title: "the PR", labels: [], state: "open", html_url: "https://github.com/zheref/nen/pull/217", body: "", pull_request: { url: "x" } },
      ]),
      viewCall(),
      checkRunsCall([readinessRun()]),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const objects = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects;
    // Issues first, ascending, then the pull requests -- a stated order, so
    // two reads of an unchanged repository produce a register you can diff.
    expect(objects.map((row): string => `${row.kind}#${row.number}`)).toEqual(["issue#215", "issue#220", "pr#217"]);
    const issue = objects[0] as unknown as Record<string, unknown>;
    expect(issue["state"]).toBe("OPEN");
    expect(issue["labels"]).toEqual(["nen:severity/high"]);
    // The PR's body closes #215 and refs #220, so BOTH issues carry it back.
    expect(issue["linked"]).toEqual([217]);
    expect((objects[1] as unknown as Record<string, unknown>)["linked"]).toEqual([217]);
    expect(issue["readiness"]).toBeNull();
    expect(issue["notes"]).toEqual([]);
  });

  it("reads a named issue on its own through the issues endpoint", async () => {
    const captured = await live(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--target", "zheref/nen", "--issues", "215", "--json"],
      [
        {
          match: `gh ${issueArgv(TARGET, 215).join(" ")}`,
          result: { code: 0, stdout: JSON.stringify({ number: 215, title: "pr threads", labels: [], state: "open", html_url: "u", body: "" }) },
        },
      ],
    );
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const objects = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects;
    expect(objects).toHaveLength(1);
    expect(objects[0]?.kind).toBe("issue");
  });

  it("REFUSES when an issue the caller named cannot be read", async () => {
    const captured = await live(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--target", "zheref/nen", "--issues", "215"],
      [{ match: `gh ${issueArgv(TARGET, 215).join(" ")}`, result: { code: 1, stderr: "HTTP 404\n" } }],
    );
    expect(captured.code).toBe(1);
    expect(captured.err.join("\n")).toMatch(/--issues named/);
  });
});

describe("the human rendering (Feitan F4)", () => {
  it("strips control characters from GitHub-controlled text, and --json keeps them", () => {
    const hostile = `${String.fromCharCode(27)}[2Kerased${String.fromCharCode(7)}`;
    const rows = parseObjects(
      [{ ...PR_ROW, title: hostile, state: `OPEN${hostile}`, notes: [`note ${hostile}`] }],
      "o.json",
    );
    const rendered = renderObjects(rows).join("\n");
    // The terminal never sees the escape...
    expect(rendered).not.toContain(String.fromCharCode(27));
    expect(rendered).not.toContain(String.fromCharCode(7));
    expect(rendered).toContain("erased");
    // ...and the document still holds the real bytes, for the consumer that
    // is about to compare or store the field.
    expect((rows[0] as { title: string }).title).toBe(hostile);
  });
});

// ── the degraded readers, one branch at a time (Nobunaga N1) ───────────────
//
// Every reader on the live path has a fallback, and a fallback nobody has run
// is a fallback nobody knows the shape of. These drive each one through the
// real dispatcher rather than calling it directly, so what is pinned is what a
// caller would see.

describe("every field degrades on its own", () => {
  it("survives a `gh pr view` payload in which almost nothing is the right type", async () => {
    const captured = await live(LIVE_PR, [
      viewCall({
        number: "217",
        headRefOid: null,
        title: 42,
        url: null,
        state: undefined,
        mergeStateStatus: null,
        labels: "not-a-list",
        reviewRequests: [{ name: "zheref/reviewers" }, { neither: true }, "nonsense"],
        body: null,
        statusCheckRollup: null,
      }),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    // The NUMBER falls back to the one the caller asked for, which is the only
    // value that can be trusted when the payload cannot.
    expect(row["number"]).toBe(217);
    expect(row["title"]).toBe("");
    expect(row["url"]).toBe("");
    expect(row["state"]).toBe("");
    expect(row["mergeStateStatus"]).toBe("UNKNOWN");
    expect(row["labels"]).toEqual([]);
    // A team request has `name` and no `login`; the third two are neither.
    expect(row["reviewRequests"]).toEqual(["zheref/reviewers"]);
    expect(row["linked"]).toEqual([]);
    // No head SHA means no readiness -- a verdict is the one thing that must
    // not be computed from a degraded read -- and it says so.
    expect(row["readiness"]).toBeNull();
    expect((row["notes"] as string[]).join(" ")).toMatch(/head SHA could not be read/);
    // And NO check-run call was made, because there was no SHA to ask about:
    // an unscripted call here would have thrown.
    expect(row["checks"]).toEqual({ total: 0, green: 0, red: 0, pending: 0 });
  });

  it("counts a lenient rollup by conclusion, then by legacy state, and pends what it cannot read", async () => {
    const captured = await live(LIVE_PR, [
      viewCall({
        statusCheckRollup: [
          // Unreadable `conclusion` -- the case that used to delete the row.
          { __typename: "CheckRun", name: "flight", conclusion: "" },
          { __typename: "CheckRun", name: "ok", conclusion: "SUCCESS" },
          { __typename: "CheckRun", name: "skipped", conclusion: "SKIPPED" },
          { __typename: "CheckRun", name: "bad", conclusion: "FAILURE" },
          { __typename: "CheckRun", name: "queued", conclusion: "QUEUED" },
          // A legacy StatusContext carries `state`, never `conclusion`.
          { __typename: "StatusContext", context: "legacy-green", state: "SUCCESS" },
          { __typename: "StatusContext", context: "legacy-waiting", state: "PENDING" },
          { __typename: "StatusContext", context: "legacy-bad", state: "ERROR" },
          // A word nen has never heard of is pending, never green.
          { __typename: "CheckRun", name: "novel", conclusion: "SOMETHING_NEW" },
          "not even an object",
        ],
      }),
      checkRunsCall([readinessRun()]),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    // green: ok, skipped, legacy-green. red: bad, legacy-bad, novel.
    // pending: flight, queued, legacy-waiting, the non-object.
    expect(row["checks"]).toEqual({ total: 10, green: 3, red: 3, pending: 4 });
  });

  it("takes a check-runs answer that is not JSON, or carries no list, as no check run", async () => {
    const captured = await live(LIVE_PR, [
      viewCall(),
      { match: `gh ${checkRunsArgv(TARGET, HEAD_SHA).join(" ")}`, result: { code: 0, stdout: "<html>not json" } },
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    // It falls through to the gate, which has no token here, so null with the
    // gate's own reason -- never a verdict invented from an unreadable answer.
    expect(row["readiness"]).toBeNull();
  });

  it("takes a check-runs answer with no `readiness` run as nothing to read", async () => {
    const captured = await live(LIVE_PR, [
      viewCall(),
      checkRunsCall([{ name: "build", status: "completed", conclusion: "SUCCESS" }]),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    expect(row["readiness"]).toBeNull();
    // No complaint about a check run that simply is not there: a repository
    // that publishes none is the ordinary case, not a degradation.
    expect(row["notes"]).toEqual([]);
  });
});

describe("the read seam's remaining refusals", () => {
  const bad = (over: Record<string, unknown>): (() => unknown) => (): unknown =>
    parseObjects([{ ...PR_ROW, ...over }], "o.json");

  it("refuses a `linked` that is not a list of whole numbers", () => {
    expect(bad({ linked: [85, 1.5] })).toThrow(/has 'linked' that is not a list of whole numbers/);
    expect(bad({ linked: "85" })).toThrow(/has 'linked' that is not a list of whole numbers/);
  });

  it("refuses a `readiness` that is a list, and one missing its verdict or reason", () => {
    expect(bad({ readiness: ["ready"] })).toThrow(/which is neither null nor a verdict object/);
    expect(bad({ readiness: { verdict: "ready", source: "check" } })).toThrow(
      /without a string 'verdict' and 'reason'/,
    );
  });

  it("refuses a `notes` that is there and is not a list of strings, and accepts an absent one", () => {
    expect(bad({ notes: "one note" })).toThrow(/has 'notes' that is not a list of strings/);
    expect(bad({ notes: [1, 2] })).toThrow(/has 'notes' that is not a list of strings/);
    // Absent is the empty list: a row written before this field existed is a
    // valid row.
    const without = { ...PR_ROW };
    delete (without as Record<string, unknown>)["notes"];
    expect((parseObjects([without], "o.json")[0] as { notes: readonly string[] }).notes).toEqual([]);
  });

  it("refuses a `checks` that is not an object of counts, and a negative count", () => {
    expect(bad({ checks: [4, 4, 0, 0] })).toThrow(/not an object of counts/);
    expect(bad({ checks: { total: 4, green: -1, red: 0, pending: 0 } })).toThrow(
      /has 'checks\.green' of a number, not a whole count/,
    );
  });

  it("refuses a row that is not an object at all, naming its index", () => {
    expect(() => parseObjects([PR_ROW, null], "o.json")).toThrow(/row 1 is null, not an object/);
    expect(() => parseObjects([["pr", 87]], "o.json")).toThrow(/row 0 is a list of 2, not an object/);
  });
});

// ── Copilot #221: the register's remaining holes ──────────────────────────

describe("--prs / --issues take POSITIVE numbers (thread …ctb)", () => {
  it("refuses 0 at the boundary, before any call", async () => {
    for (const flag of ["--prs", "--issues"]) {
      const captured = await capture([
        "report",
        "data",
        "--repo",
        COVERAGE_REPO,
        "--base",
        "main",
        "--target",
        "zheref/nen",
        flag,
        "0",
      ]);
      expect(captured.code, `${flag} 0 was accepted`).toBe(2);
      expect(captured.err.join("\n")).toMatch(/which is not an object: GitHub numbers issues and pull requests from 1/);
      // Nothing was read: no gh call is scripted, and an unscripted one throws.
      expect(captured.seams.calls.every((call): boolean => call.command === "git")).toBe(true);
    }
  });

  it("names every offending entry in a list, not just the first", async () => {
    const captured = await capture([
      "report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--target", "zheref/nen", "--prs", "0,87,0",
    ]);
    expect(captured.code).toBe(2);
    expect(captured.err.join("\n")).toMatch(/numbers that are not an object/);
  });
});

describe("the check-runs read is paginated (thread …ctf)", () => {
  function page(runs: readonly unknown[], pageNumber: number): ScriptedCall {
    return {
      match: `gh ${checkRunsArgv(TARGET, HEAD_SHA, pageNumber).join(" ")}`,
      result: { code: 0, stdout: JSON.stringify({ check_runs: runs }) },
    };
  }

  /** 100 filler runs, so the first page comes back FULL and the walk goes on. */
  const FULL_PAGE = Array.from({ length: 100 }, (_, index): unknown => ({
    name: `filler-${index}`,
    status: "completed",
    conclusion: "SUCCESS",
    started_at: "2026-09-20T08:00:00Z",
  }));

  it("finds a newer readiness run that is not on the first page", async () => {
    // The defect: page one carries an OLD readiness run, page two the current
    // one -- and reading one page published the stale verdict as though it
    // were the head's own.
    const captured = await live(LIVE_PR, [
      viewCall(),
      page([...FULL_PAGE.slice(0, 99), readinessRun({ started_at: "2026-09-20T09:00:00Z", output: { summary: "ready" } })], 1),
      page([readinessRun({ started_at: "2026-09-20T11:00:00Z", output: { summary: "not-ready: a thread is unresolved" } })], 2),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    expect(row["readiness"]).toEqual({
      verdict: "not-ready",
      reason: "not-ready: a thread is unresolved",
      source: "check",
    });
  });

  it("stops at the first SHORT page, without asking for one more", async () => {
    // A second page is not scripted, so requesting one would throw.
    const captured = await live(LIVE_PR, [viewCall(), page([readinessRun()], 1), threadsCall(THREAD_NODES)]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
  });

  it("FAILS CLOSED to the gate when a later page cannot be read", async () => {
    const captured = await live(LIVE_PR, [
      viewCall(),
      page(FULL_PAGE, 1),
      { match: `gh ${checkRunsArgv(TARGET, HEAD_SHA, 2).join(" ")}`, result: { code: 1, stderr: "HTTP 502\n" } },
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    // A partial set is as untrustworthy as none for a question decided by
    // recency, so the check-run route is abandoned rather than answered from.
    expect(row["readiness"]).toBeNull();
  });
});

describe("every degraded field is named (threads …ctk and …ctq)", () => {
  it("names each coerced PR field in notes[] and on stderr", async () => {
    const captured = await live(LIVE_PR, [
      viewCall({
        title: 42,
        url: { href: "x" },
        state: ["OPEN"],
        mergeStateStatus: 7,
        labels: "not-a-list",
        reviewRequests: [{ login: "ok" }, { neither: true }],
      }),
      checkRunsCall([readinessRun()]),
      threadsCall(THREAD_NODES),
    ]);
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    const notes = (row["notes"] as string[]).join("\n");
    for (const field of ["title", "url", "state", "mergeStateStatus", "labels", "reviewRequests"]) {
      expect(notes, `'${field}' was coerced without saying so`).toContain(`'${field}'`);
    }
    // And the operator watching the run sees the same lines.
    expect(captured.err.join("\n")).toMatch(/'title' was not a string/);
    // A row with missing GitHub data no longer looks complete.
    expect(row["title"]).toBe("");
    expect(row["reviewRequests"]).toEqual(["ok"]);
  });

  it("requires the object NUMBER to be a positive whole number (Copilot #221 round 2)", async () => {
    // `typeof value === "number"` admitted 0, -1, 1.5, NaN and Infinity --
    // none of which GitHub numbers an object with, and every one of which
    // would become this row's identity: the key `linked[]` points at and the
    // key a reader looks it up by. The CLI boundary refuses exactly this
    // shape on `--prs`; so does the payload now.
    for (const number of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "217"]) {
      const captured = await live(LIVE_PR, [
        viewCall({ number }),
        checkRunsCall([readinessRun()]),
        threadsCall(THREAD_NODES),
      ]);
      expect(captured.code, captured.err.join("\n")).toBe(0);
      const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
      // It falls back to the number the invocation named...
      expect(row["number"], `number ${String(number)} was published as the row's identity`).toBe(217);
      // ...and says so, in the row and on stderr.
      expect((row["notes"] as string[]).join("\n")).toMatch(/'number' was not a positive whole number/);
      expect(captured.err.join("\n")).toMatch(/'number' was not a positive whole number/);
    }
  });

  it("stays quiet about a field that is legitimately absent", async () => {
    // A pull request with no body carries `body: null`, which is not a
    // degradation -- only a value of the WRONG TYPE is announced.
    const captured = await live(LIVE_PR, [viewCall({ body: null }), checkRunsCall([readinessRun()]), threadsCall(THREAD_NODES)]);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    expect(row["notes"]).toEqual([]);
  });

  it("gives an ISSUE row the same field-by-field contract as a pull request", async () => {
    // It used to be a cast: a `labels` that was not a list THREW on `.map`,
    // taking the whole verb down over a display field.
    const captured = await live(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--target", "zheref/nen", "--issues", "215", "--json"],
      [
        {
          match: `gh ${issueArgv(TARGET, 215).join(" ")}`,
          result: {
            code: 0,
            stdout: JSON.stringify({
              number: "215",
              title: null,
              html_url: 9,
              state: { open: true },
              labels: [{ name: "ok" }, { name: 7 }, "nonsense"],
            }),
          },
        },
      ],
    );
    expect(captured.code, captured.err.join("\n")).toBe(0);
    const row = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects[0] as unknown as Record<string, unknown>;
    // The row SURVIVES, keyed by the number the caller named...
    expect(row["number"]).toBe(215);
    // ...a non-string label name is dropped rather than published as a
    // non-string under a key the contract says is a list of strings...
    expect(row["labels"]).toEqual(["ok"]);
    // ...and every coercion is named, in the row and on stderr.
    const notes = (row["notes"] as string[]).join("\n");
    expect(notes).toContain("'number'");
    expect(notes).toContain("'html_url'");
    expect(notes).toContain("'state'");
    expect(notes).toMatch(/2 of 3 'labels'/);
    expect(captured.err.join("\n")).toMatch(/zheref\/nen#215: 'html_url' was not a string/);
  });

  it("leaves a backlog row with no numeric number out, naming it on stderr", async () => {
    const captured = await live(
      ["report", "data", "--repo", COVERAGE_REPO, "--base", "main", "--target", "zheref/nen", "--backlog", "--json"],
      [
        {
          match: "gh api --method GET repos/zheref/nen/issues?state=open&per_page=100&page=1",
          result: {
            code: 0,
            stdout: JSON.stringify([
              { number: 215, title: "ok", labels: [], state: "open", html_url: "u" },
              { title: "no number at all", labels: [], state: "open", html_url: "u" },
            ]),
          },
        },
      ],
    );
    expect(captured.code).toBe(0);
    const objects = (JSON.parse(captured.out.join("\n")) as { objects: ReportObject[] }).objects;
    // The number is the identity every other field is keyed by, and it is the
    // one field there is no degrading around.
    expect(objects.map((row): number => row.number)).toEqual([215]);
    expect(captured.err.join("\n")).toMatch(/carried no numeric 'number' and could not be identified/);
  });
});
