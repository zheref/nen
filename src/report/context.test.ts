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
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { ownerNameFromRemote } from "../repo/resolve.js";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams, type ScriptedCall } from "../seam/scripted.js";
import { reportCommand } from "./command.js";
import { deriveStage, deriveTurn, isCompiledZone, localClock, type PrLookup } from "./context.js";
import { isHostedRemote } from "./data.js";
import { readHostZone } from "../seam/zone.js";
import type { PrObject } from "./objects.js";
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
  readonly pushed?: boolean | "fails";
  readonly worktreeLines?: string;
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
          : shape.worktreeLines !== undefined
            ? { code: 0, stdout: shape.worktreeLines }
            : worktree === "linked"
            ? { code: 0, stdout: "/w/nen/.git/worktrees/quirky-chatterjee-88d5f6\n/w/nen/.git\n/w/wt/quirky-chatterjee-88d5f6\n" }
            : { code: 0, stdout: "/w/nen/.git\n/w/nen/.git\n/w/nen\n" },
    },
    {
      match: `git rev-parse --verify --quiet refs/remotes/origin/${branch ?? ""}`,
      result:
        shape.pushed === "fails"
          ? { code: 128, stderr: "fatal: unable to read refs\n" }
          : shape.pushed === true
            ? { code: 0, stdout: `${PUSHED}\n` }
            : { code: 1, stdout: "" },
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
  options: { env?: Record<string, string>; hostTimeZone?: () => string | null; platform?: NodeJS.Platform } = {},
): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => void out.push(line), err: (line): void => void err.push(line) };
  const seams = new ScriptedSeams(calls, {
    now: (): Date => NOW,
    platform: options.platform ?? "linux",
    env: options.platform === "win32" ? { ...options.env } : { TZDIR, ...options.env },
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
    expect(captured.err.join("\n")).toMatch(/'authoring' is read from origin alone: no pull request was looked for/);
  });

  it("a branch ON ORIGIN with no PR lookup is null -- never 'published' on origin alone (N2)", async () => {
    const captured = await capture(data(repo()), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: null, gate: null, stageClass: null });
    expect(captured.err.join("\n")).toMatch(/origin\/opus\/kurapika\/nn-258 exists and no pull request was looked for — pass --target <owner\/name> --prs <n>/);
  });

  it("a PR in scope whose head matches NEITHER head is null, naming the PR and both heads (N1)", async () => {
    const root = repo();
    const other = "3333333333333333333333333333333333333333";
    for (const pushed of [true, false]) {
      const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ head: other })])), script({ pushed }));
      expect(captured.doc).toMatchObject({ effortStage: null, gate: null, stageClass: null });
      expect(captured.err.join("\n")).toContain(
        `pull request #365 is in scope and its head matches neither HEAD ${HEAD}, origin/${BRANCH} ${pushed ? PUSHED : "(not on origin)"} -- fetch, or the PR's head moved`,
      );
    }
  });

  it("says 'no PR row matched this branch' for --backlog and --issues-only scopes (N1)", () => {
    const run = (lookup: PrLookup, objects: readonly PrObject[], pushed: boolean): string[] => {
      const warn: string[] = [];
      const seams = new ScriptedSeams(script({ pushed }), { platform: "linux" });
      const stage = deriveStage(seams, { root: repo(), repo: "zheref/nen", branch: BRANCH, phases: [], objects, prLookup: lookup, openStop: false }, (l) => warn.push(l));
      expect(stage).toEqual({ effortStage: null, gate: null, stageClass: null });
      return warn;
    };
    expect(run("backlog", [prRow({ head: "3".repeat(40) }) as unknown as PrObject], true).join("\n")).toMatch(/no PR row matched this branch: none of the 1 open pull request\(s\) --backlog read \(#365\).* -- fetch, or the PR's head moved/);
    expect(run("backlog", [], true).join("\n")).toMatch(/no PR row matched this branch \(--backlog reads OPEN pull requests only/);
    expect(run("issues-only", [], true).join("\n")).toMatch(/no PR row matched this branch \(--issues reads no pull request\)/);
  });

  it("an open PR that is not ready is in review, at the repository's own gate, pending", async () => {
    const consumer = repo(CONSUMER);
    const inReview = await capture(data(consumer, "--objects-from", objectsFile(consumer, [prRow()])), script({ pushed: true }));
    expect(inReview.doc).toMatchObject({ effortStage: "in review", gate: "G2 — pending", stageClass: "warn" });
    const canon = repo(CANON);
    const atG4 = await capture(data(canon, "--objects-from", objectsFile(canon, [prRow()])), script({ pushed: true }));
    expect(atG4.doc).toMatchObject({ effortStage: "in review", gate: "G4 — pending" });
  });

  it("warns when the matched PR's head is origin/<branch> and HEAD has moved on (N12)", async () => {
    const root = repo(CONSUMER);
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow()])), script({ pushed: true }));
    expect(captured.err.join("\n")).toContain(`pull request #365's head ${PUSHED} is origin/${BRANCH}, not HEAD ${HEAD}`);
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

  it("an open PR with NO readiness read is null -- never 'in review' (N5)", async () => {
    const root = repo(CANON);
    const captured = await capture(data(root, "--objects-from", objectsFile(root, [prRow({ readiness: null })])), script({ pushed: true }));
    expect(captured.doc).toMatchObject({ effortStage: null, gate: null, stageClass: null });
    expect(captured.err.join("\n")).toMatch(/#365's readiness was not read \(its notes say why\), so whether it is 'ready' or 'in review' is not known/);
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

  it("counts the 'report' entries of the ledger named after the branch -- and only that one (N3)", () => {
    const warn: string[] = [];
    const phases = [phase("a", "report"), phase(BRANCH, "report"), phase(BRANCH, "rasengan"), phase(BRANCH, "report")];
    expect(deriveTurn(phases, BRANCH, (l) => warn.push(l))).toBe(2);
    expect(warn).toEqual([]);
  });

  it("never falls back to a lone ledger under another effort id (N3)", () => {
    const warn: string[] = [];
    expect(deriveTurn([phase("e", "report"), phase("e", "report")], BRANCH, (l) => warn.push(l))).toBeNull();
    expect(warn.join("\n")).toContain(`no .nen/phases/ ledger has the effort id '${BRANCH}'`);
  });

  it("is null, not 0, with no ledger, no 'report' entry, or no branch", () => {
    const warn: string[] = [];
    expect(deriveTurn([], BRANCH, (l) => warn.push(l))).toBeNull();
    expect(deriveTurn([phase(BRANCH, "rasengan")], BRANCH, (l) => warn.push(l))).toBeNull();
    expect(deriveTurn([phase(BRANCH, "report")], null, (l) => warn.push(l))).toBeNull();
    expect(warn.join("\n")).toMatch(/ledger records no 'report' phase/);
    expect(warn.join("\n")).toMatch(/turnNumber: HEAD is detached/);
  });

  it("reads the ledger end to end", async () => {
    const root = repo();
    mkdirSync(join(root, ".nen", "phases"), { recursive: true });
    const entry = { startedAt: "2026-09-22T18:00:00.000Z", endedAt: null, durationMs: null, exitCode: null, surface: null, model: null, note: null };
    writeFileSync(
      join(root, ".nen", "phases", `${encodeURIComponent(BRANCH)}.json`),
      JSON.stringify({ contract: "nen.phase.ledger/v0.1", effort: BRANCH, phases: [{ phase: "report", ...entry }, { phase: "kokusen", ...entry }, { phase: "report", ...entry }, { phase: "report", ...entry }] }),
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
    // A directory named like a zone is not a regular file (N13).
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
      expect(captured.err.join("\n")).toContain(`--tz '${tz}' is not a zone:`);
      expect(captured.seams.calls.every((call): boolean => call.command === "git")).toBe(true);
    }
    // A case mismatch would pass a case-insensitive file system and ICU both (N13).
    const cased = await capture(data(repo(), "--tz", "america/bogota"), script());
    expect(cased.code).toBe(2);
    expect(cased.err.join("\n")).toMatch(/--tz 'america\/bogota' is not a zone/);
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

  it("keeps the desk's page gate and generatedAtLocal fallback byte for byte, and appends the context after (N6)", async () => {
    const root = repo();
    writeFileSync(join(root, "desk.json"), JSON.stringify(DESK));
    const captured = await capture(data(root, "--register", "desk.json", "--tz", "America/Bogota", "--open-stop"), script());
    expect(captured.code, captured.err.join("\n")).toBe(0);
    expect(captured.doc["gate"]).toBe("G2");
    // Unchanged from NN-PR-#365: the desk's, else generatedAt -- never the derived clock.
    expect(captured.doc["generatedAtLocal"]).toBe("2026-09-22T19:05:00.000Z");
    expect(captured.doc).toMatchObject({ effortStage: "blocked", stageClass: "red", timeZone: "America/Bogota", generatedDateLocal: "2026-09-22", worktree: "core" });
  });

  it("nulls timeZone and generatedDateLocal when the desk set the clock, and says so (N6)", async () => {
    const root = repo();
    writeFileSync(join(root, "desk.json"), JSON.stringify({ ...DESK, generatedAtLocal: "the desk's own" }));
    const captured = await capture(data(root, "--register", "desk.json", "--tz", "America/Bogota"), script());
    expect(captured.doc).toMatchObject({ generatedAtLocal: "the desk's own", timeZone: null, generatedDateLocal: null });
    expect(captured.err.join("\n")).toMatch(/the register desk set generatedAtLocal, so the desk owns the page's clock/);
  });

  it("falls back to generatedAt, as before, when no zone can be named", async () => {
    const root = repo();
    writeFileSync(join(root, "desk.json"), JSON.stringify(DESK));
    const captured = await capture(data(root, "--register", "desk.json"), script());
    expect(captured.doc["generatedAtLocal"]).toBe("2026-09-22T19:05:00.000Z");
  });
});

describe("where no zoneinfo database exists (N7)", () => {
  it("checks --tz against ICU's zone list on win32, and says which authority answered", async () => {
    const ok = await capture(data(repo(), "--tz", "America/Bogota"), script(), { platform: "win32" });
    expect(ok.code, ok.err.join("\n")).toBe(0);
    expect(ok.doc["timeZone"]).toBe("America/Bogota");
    expect(ok.err.join("\n")).toContain("timeZone: this host (win32) has no zoneinfo database, so 'America/Bogota' was checked against the runtime's ICU zone list (Intl.supportedValuesOf), not a TZif file.");
    const bad = await capture(data(repo(), "--tz", "Mars/Olympus"), script(), { platform: "win32" });
    expect(bad.code).toBe(2);
    const meta = await capture(data(repo(), "--tz", "zone.tab"), script(), { platform: "win32" });
    expect(meta.code).toBe(2);
  });

  it("says so for a $TZDIR that is not a directory, too", async () => {
    const captured = await capture(data(repo(), "--tz", "America/Bogota"), script(), { env: { TZDIR: join(TZDIR, "nope") } });
    expect(captured.code).toBe(0);
    expect(captured.err.join("\n")).toMatch(/\$TZDIR '.*nope' is not a directory, so 'America\/Bogota' was checked against the runtime's ICU zone list/);
  });
});

describe("repo accepts only a hosted origin (N4)", () => {
  it("reads scp-style and scheme://host/ origins", () => {
    expect(isHostedRemote("git@github.com:zheref/nen.git")).toBe(true);
    expect(isHostedRemote("https://github.com/zheref/nen.git")).toBe(true);
    expect(isHostedRemote("ssh://git@github.com/zheref/nen.git")).toBe(true);
  });

  it("refuses a local path and a file:// origin", () => {
    for (const url of ["/Users/me/src/nen", "../nen", "C:/src/nen", "file:///Users/me/src/nen", "file://host/src/nen", "https:///nen", ""]) {
      expect(isHostedRemote(url), url).toBe(false);
    }
  });

  for (const [label, url] of [["a local path", "/Users/me/src/nen"], ["a file:// URL", "file:///Users/me/src/nen.git"]] as const) {
    it(`reports ${label} origin as a null repo, with the reason`, async () => {
      const captured = await capture(data(repo()), script({ origin: url }));
      expect(captured.code).toBe(0);
      expect(captured.doc["repo"]).toBeNull();
      expect(captured.err.join("\n")).toMatch(/repo: this checkout's 'origin' is not a hosted remote/);
      expect(captured.out.join("\n")).not.toContain("src/nen");
    });
  }

  it("reports an scp-style origin as owner/name", async () => {
    expect((await capture(data(repo()), script({ origin: "git@github.com:zheref/nen.git" }))).doc["repo"]).toBe("zheref/nen");
  });
});

describe("the host's own zone (N14)", () => {
  function host(): string {
    return mkdtempSync(join(tmpdir(), "nen-host-zone-"));
  }

  // A symlink needs a privilege Windows does not grant a CI job by default.
  it.skipIf(process.platform === "win32")("prefers the /etc/localtime symlink's target, relative or absolute", () => {
    const dir = host();
    symlinkSync("../usr/share/zoneinfo/America/Bogota", join(dir, "localtime"));
    writeFileSync(join(dir, "timezone"), "Europe/Madrid\n");
    expect(readHostZone({ localtime: join(dir, "localtime"), timezone: join(dir, "timezone") }, () => "Asia/Tokyo")).toBe("America/Bogota");
  });

  it("then /etc/timezone beside a copied localtime, then ICU's guess", () => {
    const dir = host();
    writeFileSync(join(dir, "localtime"), "TZif-copy");
    writeFileSync(join(dir, "timezone"), "  Europe/Madrid  \n");
    const paths = { localtime: join(dir, "localtime"), timezone: join(dir, "timezone") };
    expect(readHostZone(paths, () => "Asia/Tokyo")).toBe("Europe/Madrid");
    expect(readHostZone({ ...paths, timezone: join(dir, "none") }, () => "Asia/Tokyo")).toBe("Asia/Tokyo");
    expect(readHostZone({ ...paths, timezone: join(dir, "none") }, () => "Etc/Unknown")).toBeNull();
  });
});

describe("Copilot round 1 on NN-PR-#375", () => {
  it("context.ts:132 -- a FAILED origin probe nulls the stage with the failure; only exit 1 is absent", async () => {
    const captured = await capture(data(repo()), script({ pushed: "fails" }));
    expect(captured.doc).toMatchObject({ effortStage: null, gate: null, stageClass: null });
    expect(captured.err.join("\n")).toContain(`whether origin/${BRANCH} exists could not be read`);
    expect(captured.err.join("\n")).toContain("fatal: unable to read refs");
    expect((await capture(data(repo()), script({ pushed: false }))).doc["effortStage"]).toBe("authoring");
  });

  it.skipIf(process.platform === "win32")("context.ts:318 -- a TZif symlink under $TZDIR that leaves it is not a zone", () => {
    const outside = mkdtempSync(join(tmpdir(), "nen-zone-outside-"));
    writeFileSync(join(outside, "Evil"), "TZif2-outside-the-database");
    const db = mkdtempSync(join(tmpdir(), "nen-zone-db-"));
    mkdirSync(join(db, "America"));
    writeFileSync(join(db, "America", "Bogota"), "TZif2-inside");
    symlinkSync(join(outside, "Evil"), join(db, "America", "Lima"));
    symlinkSync("Bogota", join(db, "America", "Inside"));
    expect(isCompiledZone("America/Lima", [db])).toBe(false);
    expect(isCompiledZone("America/Inside", [db])).toBe(true);
    expect(isCompiledZone("America/Bogota", [db])).toBe(true);
  });

  it("data.ts:252 -- never publishes userinfo, a query or a fragment from origin (SECURITY)", async () => {
    const url = "https://x-access-token:ghp_userinfo@github.com/zheref/nen.git?access_token=s3cr3t#frag";
    expect(ownerNameFromRemote(url)).toBe("zheref/nen");
    expect(ownerNameFromRemote("https://github.com/zheref/nen.git?access_token=s3cr3t")).toBe("zheref/nen");
    expect(ownerNameFromRemote("https://github.com/zheref/nen/#frag")).toBe("zheref/nen");
    expect(ownerNameFromRemote("git@github.com:zheref/nen.git?x=1")).toBe("zheref/nen");
    for (const json of [true, false]) {
      const argv = data(repo());
      const captured = await capture(json ? argv : argv.filter((arg): boolean => arg !== "--json"), script({ origin: url }));
      const all = [...captured.out, ...captured.err].join("\n");
      expect(all).not.toContain("s3cr3t");
      expect(all).not.toContain("ghp_userinfo");
      expect(all).not.toContain("frag");
      if (json) expect(captured.doc["repo"]).toBe("zheref/nen");
    }
  });

  it("command.ts:409 -- --target alone is no lookup, so a branch on origin is 'not looked for'", async () => {
    const captured = await capture(data(repo(), "--target", "zheref/nen"), script({ pushed: true }));
    expect(captured.code, captured.err.join("\n")).toBe(0);
    expect(captured.doc["effortStage"]).toBeNull();
    expect(captured.err.join("\n")).toMatch(/no pull request was looked for — pass --target <owner\/name> --prs <n>/);
    expect(captured.err.join("\n")).not.toMatch(/--issues reads no pull request/);
  });

  it("command.ts:451 -- a desk that owns the clock silences the derived clock's diagnostics", async () => {
    const root = repo();
    writeFileSync(join(root, "desk.json"), JSON.stringify({ variant: "register", title: "t", scope: "s", gate: "G2", generatedAtLocal: "the desk's own", gates: [{ gate: "G2", label: "Merge", cleared: "Nothing.", asks: [] }] }));
    const captured = await capture(data(root, "--register", "desk.json"), script(), { hostTimeZone: () => "Mars/Olympus" });
    expect(captured.code).toBe(0);
    const err = captured.err.join("\n");
    expect(err).toMatch(/the register desk set generatedAtLocal, so the desk owns the page's clock/);
    expect(err).not.toMatch(/Mars\/Olympus/);
    // A typo in --tz is still refused when the desk owns the clock.
    expect((await capture(data(root, "--register", "desk.json", "--tz", "Mars/Olympus"), script())).code).toBe(2);
  });

  it("context.ts:116 -- git paths are raw lines: a worktree name ending in a space keeps it", async () => {
    const captured = await capture(data(repo()), script({ worktreeLines: "/w/nen/.git/worktrees/x\n/w/nen/.git\n/w/wt/odd name \n" }));
    expect(captured.doc["worktree"]).toBe("odd name ");
  });

  it("data.ts:669 -- the human repo line is plain; the JSON keeps the bytes", async () => {
    const origin = "git@github.com:zheref/n\u0007e\u001b[31mn.git";
    const text = await capture(data(repo()).filter((arg): boolean => arg !== "--json"), script({ origin }));
    expect(text.out[0]).toBe(`repo: zheref/ne[31mn on '${BRANCH}', base 'main'`);
    const json = await capture(data(repo()), script({ origin }));
    expect(json.doc["repo"]).toBe("zheref/n\u0007e\u001b[31mn");
  });
});
