// src/report/context.test.ts -- the derived context `nen report data` carries
// (zheref/nen#258): the worktree, the stage and its gate, the turn, the local
// clock. Driven through the real ../index.ts `runFamily`.
//
// NO LIVE GIT AND NO HOST CLOCK. Every git read is a ScriptedSeams entry; the
// zoneinfo database is a temp directory named by $TZDIR, holding files that
// carry (or do not carry) the TZif magic; the host's own zone is the seam's
// `hostTimeZone`. So no assertion here depends on the machine that runs it --
// which is also why each lane of the CI matrix proves the same thing.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { reportCommand } from "./command.js";
import { deriveTurn, isCompiledZone, localClock } from "./context.js";
import type { ReportPhase } from "./data.js";

const FIELD = "\u001f";
const LOG_FORMAT = `%H${FIELD}%s${FIELD}%an${FIELD}%aI`;
const NOW = new Date("2026-09-22T19:05:00.000Z");
const BRANCH = "opus/kurapika/nn-258";
const HEAD = "1111111111111111111111111111111111111111";
const PUSHED = "2222222222222222222222222222222222222222";
const WORKTREE_DIRS = "rev-parse --path-format=absolute --git-dir --git-common-dir --show-toplevel";

/** A zoneinfo database: compiled zones carry the TZif magic, metadata does not. */
function zoneinfo(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-zoneinfo-"));
  for (const zone of ["America/Bogota", "Asia/Tokyo", "Asia/Kolkata", "Europe/Madrid"]) {
    const [area = "", city = ""] = zone.split("/");
    mkdirSync(join(dir, area), { recursive: true });
    writeFileSync(join(dir, area, city), "TZif2\u0000\u0000\u0000rest-of-a-compiled-zone");
  }
  writeFileSync(join(dir, "zone.tab"), "# tz zone descriptions\nCO\t+0436-07405\tAmerica/Bogota\n");
  writeFileSync(join(dir, "TZ"), "TZ");
  return dir;
}

const TZDIR = zoneinfo();

interface Shape {
  readonly origin?: string | null;
  readonly worktree?: "core" | "linked" | "fails";
  readonly branch?: string | null;
  readonly pushed?: boolean;
}

function script(shape: Shape = {}): ScriptedCall[] {
  const branch = shape.branch === undefined ? BRANCH : shape.branch;
  const origin = shape.origin === undefined ? "https://github.com/zheref/nen.git" : shape.origin;
  const worktree = shape.worktree ?? "core";
  return [
    { match: "git rev-parse --verify --quiet main^{commit}", result: { code: 0, stdout: "0123456789abcdef\n" } },
    {
      match: "git symbolic-ref --short HEAD",
      result: branch === null ? { code: 128, stderr: "fatal: ref HEAD is not a symbolic ref\n" } : { code: 0, stdout: `${branch}\n` },
    },
    {
      match: "git remote get-url origin",
      result: origin === null ? { code: 2, stderr: "error: No such remote 'origin'\n" } : { code: 0, stdout: `${origin}\n` },
    },
    { match: `git log main..HEAD --format=${LOG_FORMAT}`, result: { code: 0, stdout: "" } },
    { match: "git diff --name-status main...HEAD", result: { code: 0, stdout: "" } },
    {
      match: `git ${WORKTREE_DIRS}`,
      result:
        worktree === "fails"
          ? { code: 128, stderr: "fatal: not a git repository\n" }
          : worktree === "linked"
            ? { code: 0, stdout: "/w/nen/.git/worktrees/quirky-chatterjee-88d5f6\n/w/nen/.git\n/w/wt/quirky-chatterjee-88d5f6\n" }
            : { code: 0, stdout: "/w/nen/.git\n/w/nen/.git\n/w/nen\n" },
    },
    {
      match: `git rev-parse --verify --quiet refs/remotes/origin/${branch ?? ""}`,
      result: shape.pushed === true ? { code: 0, stdout: `${PUSHED}\n` } : { code: 1, stdout: "" },
    },
    { match: "git rev-parse --verify --quiet HEAD", result: { code: 0, stdout: `${HEAD}\n` } },
  ];
}

interface Captured {
  readonly code: number;
  readonly out: string[];
  readonly err: string[];
  readonly seams: ScriptedSeams;
  readonly doc: Record<string, unknown>;
}

async function capture(
  argv: readonly string[],
  calls: readonly ScriptedCall[],
  options: { env?: Record<string, string>; hostTimeZone?: () => string | null } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(calls, {
    now: (): Date => NOW,
    platform: "linux",
    env: { TZDIR, ...options.env },
    ...(options.hostTimeZone === undefined ? {} : { hostTimeZone: options.hostTimeZone }),
  });
  const code = await runFamily(reportCommand, argv, null, false, io, seams);
  let doc: Record<string, unknown> = {};
  try {
    doc = JSON.parse(out.join("\n")) as Record<string, unknown>;
  } catch {
    // A human-rendered or refused run has no document.
  }
  return { code, out, err, seams, doc };
}

/** A checkout carrying the given registry (or none), and an objects file. */
function repo(registry: unknown = null): string {
  const root = mkdtempSync(join(tmpdir(), "nen-report-context-"));
  if (registry !== null) {
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "repos.json"), JSON.stringify(registry));
  }
  return root;
}

function objectsFile(root: string, rows: unknown[]): string {
  writeFileSync(join(root, "objects.json"), JSON.stringify(rows));
  return "objects.json";
}

function prRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    kind: "pr",
    number: 365,
    title: "feat(report): derive the context",
    url: "https://github.com/zheref/nen/pull/365",
    state: "OPEN",
    labels: [],
    head: PUSHED,
    mergeStateStatus: "CLEAN",
    checks: { total: 1, green: 1, red: 0, pending: 0 },
    threads: { total: 0, unresolved: 0 },
    reviewRequests: [],
    linked: [258],
    readiness: { verdict: "not-ready", reason: "not-ready: 1 unresolved thread", source: "computed" },
    ...overrides,
  };
}

const CANON = { maintained_tools: [{ repo: "zheref/nen", role: "the CLI" }], consumers: [] };
const CONSUMER = { consumers: [{ repo: "zheref/nen", consumes: [], code: "NN" }] };

function data(root: string, ...extra: string[]): string[] {
  return ["report", "data", "--repo", root, "--base", "main", ...extra, "--json"];
}

describe("worktree (zheref/nen#258)", () => {
  it("is the checkout's directory name in a linked worktree -- never its path", async () => {
    const captured = await capture(data(repo()), script({ worktree: "linked" }));
    expect(captured.code).toBe(0);
    expect(captured.doc["worktree"]).toBe("quirky-chatterjee-88d5f6");
    expect(captured.out.join("\n")).not.toContain("/w/wt");
    // And `repo` is the PROJECT, not the worktree's directory.
    expect(captured.doc["repo"]).toBe("zheref/nen");
  });

  it("is 'core' in the main checkout, where --git-dir and --git-common-dir agree", async () => {
    expect((await capture(data(repo()), script())).doc["worktree"]).toBe("core");
  });

  it("is null with the reason when git cannot say", async () => {
    const captured = await capture(data(repo()), script({ worktree: "fails" }));
    expect(captured.doc["worktree"]).toBeNull();
    expect(captured.err.join("\n")).toMatch(/worktree: could not read this checkout's git directories .*not a git repository/);
  });
});

describe("effortStage, gate and stageClass -- the documented table", () => {
  it("an UNPUSHED branch is authoring, gate 'none — local', info", async () => {
    const captured = await capture(data(repo()), script({ pushed: false }));
    expect(captured.doc).toMatchObject({ effortStage: "authoring", gate: "none — local", stageClass: "info" });
  });

  it("a PUBLISHED branch with no PR is published, gate 'none — pushed' -- and says no PR was looked for", async () => {
    const captured = await capture(data(repo()), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: "published", gate: "none — pushed", stageClass: "info" });
    expect(captured.err.join("\n")).toMatch(/'published' is read from origin alone -- no pull request was looked for/);
  });

  it("a published branch whose register holds no PR with its head is published, without that caveat", async () => {
    const root = repo();
    const captured = await capture(
      data(root, "--objects-from", objectsFile(root, [prRow({ head: "3333333333333333333333333333333333333333" })])),
      script({ pushed: true }),
    );
    expect(captured.doc["effortStage"]).toBe("published");
    expect(captured.err.join("\n")).not.toMatch(/looked for/);
  });

  it("an open PR that is not ready is in review, at the repository's own gate, pending", async () => {
    const consumer = repo(CONSUMER);
    const inReview = await capture(data(consumer, "--objects-from", objectsFile(consumer, [prRow()])), script({ pushed: true }));
    expect(inReview.doc).toMatchObject({ effortStage: "in review", gate: "G2 — pending", stageClass: "warn" });
    const canon = repo(CANON);
    const atG4 = await capture(data(canon, "--objects-from", objectsFile(canon, [prRow()])), script({ pushed: true }));
    expect(atG4.doc).toMatchObject({ effortStage: "in review", gate: "G4 — pending" });
  });

  it("matches the PR by HEAD too, when HEAD has moved past what was pushed", async () => {
    const root = repo(CONSUMER);
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ head: HEAD })])), script({ pushed: false }));
    expect(captured.doc["effortStage"]).toBe("in review");
  });

  it("an open PR whose verdict is 'ready' is ready, red -- the verdict's word, never a guess", async () => {
    const root = repo(CANON);
    const ready = prRow({ readiness: { verdict: "ready", reason: "ready", source: "check" } });
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [ready])), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: "ready", gate: "G4 — yours", stageClass: "red" });
  });

  it("an open PR with NO readiness read is in review, and says why it is not ready", async () => {
    const root = repo(CANON);
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ readiness: null })])), script({ pushed: true }));
    expect(captured.doc["effortStage"]).toBe("in review");
    expect(captured.err.join("\n")).toMatch(/readiness was not read .* 'ready' is only ever the verdict's word/);
  });

  it("a merged PR is landed, ok", async () => {
    const root = repo();
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ state: "MERGED" })])), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: "landed", gate: "none — landed", stageClass: "ok" });
  });

  it("--open-stop is blocked, 'G5 — yours', red -- and it is the only way there", async () => {
    const captured = await capture(data(repo(), "--open-stop"), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: "blocked", gate: "G5 — yours", stageClass: "red" });
  });

  it("an in-review stage whose repository the registry does not list keeps its stage and nulls only the gate", async () => {
    const root = repo({ consumers: [{ repo: "someone/else", consumes: [], code: "SE" }] });
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow()])), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: "in review", gate: null, stageClass: "warn" });
    expect(captured.err.join("\n")).toMatch(/gate: 'zheref\/nen' is not in this checkout's nen\/repos\.json/);
    const bare = repo();
    const noRegistry = await capture(data(bare, "--objects-from", objectsFile(bare, [prRow()])), script({ pushed: true }));
    expect(noRegistry.doc["gate"]).toBeNull();
    expect(noRegistry.err.join("\n")).toMatch(/gate: no readable nen\/repos\.json/);
  });

  it("is null with the reason when it has no single answer: detached, closed, two PRs on one head, an unreadable head", async () => {
    const detached = await capture(data(repo()), script({ branch: null }));
    expect(detached.doc).toMatchObject({ effortStage: null, gate: null, stageClass: null });
    expect(detached.err.join("\n")).toMatch(/effortStage: HEAD is detached/);

    const root = repo(CANON);
    const closed = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ state: "CLOSED" })])), script({ pushed: true }));
    expect(closed.doc["effortStage"]).toBeNull();
    expect(closed.err.join("\n")).toMatch(/is 'CLOSED', which no stage in the table describes/);

    const two = await capture(
      data(root, "--objects-from", objectsFile(root, [prRow(), prRow({ number: 366, url: "https://github.com/zheref/nen/pull/366" })])),
      script({ pushed: true }),
    );
    expect(two.doc["effortStage"]).toBeNull();
    expect(two.err.join("\n")).toMatch(/2 pull requests in scope \(#365, #366\) have this branch's head/);

    const unread = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ head: "" })])), script({ pushed: true }));
    expect(unread.doc["effortStage"]).toBeNull();
    expect(unread.err.join("\n")).toMatch(/#365 has a head that could not be read/);
  });

  it("never reads HEAD when no pull request is in scope", async () => {
    const captured = await capture(data(repo()), script({ pushed: true }));
    expect(captured.seams.calls.map((call): string => call.args.join(" "))).not.toContain("rev-parse --verify --quiet HEAD");
  });
});

describe("turnNumber", () => {
  function phase(effort: string, name: string): ReportPhase {
    return { effort, phase: name, startedAt: "", endedAt: null, durationMs: null, exitCode: null, surface: null, model: null, note: null, steps: [] };
  }

  it("counts the 'report' entries of the one effort that records them", () => {
    const warn: string[] = [];
    expect(deriveTurn([phase("e", "report"), phase("e", "rasengan"), phase("e", "report")], "b", (l) => warn.push(l))).toBe(2);
    expect(warn).toEqual([]);
  });

  it("picks the effort named after the branch when several record turns, and is null when none is", () => {
    const phases = [phase("a", "report"), phase(BRANCH, "report"), phase(BRANCH, "report")];
    expect(deriveTurn(phases, BRANCH, () => undefined)).toBe(2);
    const warn: string[] = [];
    expect(deriveTurn(phases, "other", (l) => warn.push(l))).toBeNull();
    expect(warn.join("\n")).toMatch(/2 efforts record 'report' phases/);
  });

  it("is null, not 0, with no 'report' entry recorded", () => {
    const warn: string[] = [];
    expect(deriveTurn([phase("e", "rasengan")], "b", (l) => warn.push(l))).toBeNull();
    expect(warn.join("\n")).toMatch(/turnNumber: no 'report' phase is recorded/);
  });

  it("reads the ledger end to end", async () => {
    const root = repo();
    mkdirSync(join(root, ".nen", "phases"), { recursive: true });
    const entry = { startedAt: "2026-09-22T18:00:00.000Z", endedAt: null, durationMs: null, exitCode: null, surface: null, model: null, note: null };
    writeFileSync(
      join(root, ".nen", "phases", "e.json"),
      JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: "e", phases: [{ phase: "report", ...entry }, { phase: "kokusen", ...entry }, { phase: "report", ...entry }, { phase: "report", ...entry }] }),
    );
    expect((await capture(data(root), script())).doc["turnNumber"]).toBe(3);
  });
});

describe("the local clock", () => {
  it("renders the instant in the zone, as Hatsu's report_time.sh did", () => {
    expect(localClock("America/Bogota", NOW)).toEqual({
      generatedAtLocal: "Tue 22 Sep 2026 · 14:05 America/Bogota (UTC-05:00)",
      generatedDateLocal: "2026-09-22",
      timeZone: "America/Bogota",
    });
    // Past UTC midnight is still yesterday in Bogota; fractions are dropped.
    expect(localClock("America/Bogota", new Date("2026-09-23T02:30:00.267Z"))?.generatedAtLocal).toBe(
      "Tue 22 Sep 2026 · 21:30 America/Bogota (UTC-05:00)",
    );
    // Ahead of UTC flips to tomorrow; a single-digit day is unpadded.
    expect(localClock("Asia/Tokyo", new Date("2026-10-01T19:05:00Z"))).toMatchObject({
      generatedAtLocal: "Fri 2 Oct 2026 · 04:05 Asia/Tokyo (UTC+09:00)",
      generatedDateLocal: "2026-10-02",
    });
    expect(localClock("Asia/Kolkata", NOW)?.generatedAtLocal).toBe("Wed 23 Sep 2026 · 00:35 Asia/Kolkata (UTC+05:30)");
    expect(localClock("Etc/UTC", NOW)?.generatedAtLocal).toBe("Tue 22 Sep 2026 · 19:05 Etc/UTC (UTC+00:00)");
  });

  it("validates a zone against a real TZif file, never the directory listing", () => {
    expect(isCompiledZone("America/Bogota", [TZDIR])).toBe(true);
    expect(isCompiledZone("UTC", [])).toBe(true);
    for (const notAZone of ["zone.tab", "TZ", "Mars/Olympus", "America", "../../etc/passwd", "/etc/passwd", "", "C:/x"]) {
      expect(isCompiledZone(notAZone, [TZDIR]), notAZone).toBe(false);
    }
  });

  it("takes --tz, and stamps the same instant as generatedAt", async () => {
    const captured = await capture(data(repo(), "--tz", "America/Bogota"), script());
    expect(captured.doc).toMatchObject({
      generatedAt: "2026-09-22T19:05:00.000Z",
      generatedAtLocal: "Tue 22 Sep 2026 · 14:05 America/Bogota (UTC-05:00)",
      generatedDateLocal: "2026-09-22",
      timeZone: "America/Bogota",
    });
  });

  it("REFUSES an impossible --tz at exit 2, naming it, before any GitHub read", async () => {
    for (const tz of ["Mars/Olympus", "zone.tab", "../../etc/passwd"]) {
      const captured = await capture(data(repo(), "--tz", tz, "--target", "zheref/nen", "--prs", "365"), script());
      expect(captured.code, tz).toBe(2);
      expect(captured.err.join("\n")).toContain(`--tz '${tz}' is not a zone in this host's zoneinfo database`);
      expect(captured.seams.calls.every((call): boolean => call.command === "git")).toBe(true);
    }
    const empty = await capture(data(repo(), "--tz", " "), script());
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/--tz was given an empty value/);
  });

  it("falls back to $TZ, then to the zone the host names", async () => {
    const fromEnv = await capture(data(repo()), script(), { env: { TZ: ":Europe/Madrid" }, hostTimeZone: () => "Asia/Tokyo" });
    expect(fromEnv.doc["timeZone"]).toBe("Europe/Madrid");
    const fromHost = await capture(data(repo()), script(), { hostTimeZone: () => "Asia/Tokyo" });
    expect(fromHost.doc).toMatchObject({ timeZone: "Asia/Tokyo", generatedDateLocal: "2026-09-23" });
  });

  it("is null with the reason when the host names no zone, or one the database does not hold -- never UTC by default", async () => {
    const none = await capture(data(repo()), script());
    expect(none.code).toBe(0);
    expect(none.doc).toMatchObject({ generatedAtLocal: null, generatedDateLocal: null, timeZone: null });
    expect(none.err.join("\n")).toMatch(/timeZone: this host does not name its zone; pass --tz/);
    const unknown = await capture(data(repo()), script(), { hostTimeZone: () => "Mars/Olympus" });
    expect(unknown.code).toBe(0);
    expect(unknown.doc["timeZone"]).toBeNull();
    expect(unknown.err.join("\n")).toMatch(/timeZone: the host names 'Mars\/Olympus', which is not a zone/);
  });
});

describe("the --register path stays consistent", () => {
  const DESK = {
    variant: "register",
    title: "nen · bug",
    scope: "zheref/nen",
    gate: "G2",
    gates: [{ gate: "G2", label: "Merge", cleared: "Nothing to merge.", asks: [] }],
  };

  it("keeps the desk's page gate, and stamps the derived local clock where the desk wrote none", async () => {
    const root = repo();
    writeFileSync(join(root, "desk.json"), JSON.stringify(DESK));
    const captured = await capture(data(root, "--register", "desk.json", "--tz", "America/Bogota", "--open-stop"), script());
    expect(captured.code, captured.err.join("\n")).toBe(0);
    expect(captured.doc["gate"]).toBe("G2");
    expect(captured.doc["generatedAtLocal"]).toBe("Tue 22 Sep 2026 · 14:05 America/Bogota (UTC-05:00)");
    expect(captured.doc).toMatchObject({ effortStage: "blocked", stageClass: "red", timeZone: "America/Bogota", worktree: "core" });

    writeFileSync(join(root, "desk.json"), JSON.stringify({ ...DESK, generatedAtLocal: "the desk's own" }));
    const deskWins = await capture(data(root, "--register", "desk.json", "--tz", "America/Bogota"), script());
    expect(deskWins.doc["generatedAtLocal"]).toBe("the desk's own");
  });

  it("falls back to generatedAt, as before, when no zone can be named", async () => {
    const root = repo();
    writeFileSync(join(root, "desk.json"), JSON.stringify(DESK));
    const captured = await capture(data(root, "--register", "desk.json"), script());
    expect(captured.doc["generatedAtLocal"]).toBe("2026-09-22T19:05:00.000Z");
  });
});
