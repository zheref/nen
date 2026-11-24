// src/phase/list.test.ts -- `nen phase list` (zheref/nen#583), AC-1..AC-4.

import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, readdirSync, rmSync, truncateSync, readFileSync, realpathSync, statSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { makeTempDir } from "../testing/tempdir.js";
import { runFamily, type Io } from "../index.js";
import { spawnRunner, type CommandResult, type Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { encodeEffortId } from "../ledger/effort.js";
import { phaseCommand } from "./command.js";
import { PHASE_CONTRACT } from "./ledger.js";
import { decodeLedgerFileName, LEDGER_READ_CAP_BYTES, listPhaseLedgers, openLedgerFile, PHASE_LIST_CONTRACT, PLAIN_LABEL_MAX, renderPhaseList, type PhaseListReport } from "./list.js";
import { localEffortHome } from "../ledger/home.js";

const NOW = "2026-03-01T12:00:00.000Z";
const at = (offsetMs: number): Date => new Date(Date.parse(NOW) + offsetMs);
const MIN = 60_000;

/** Git only, and only the two read-only asks the layout makes (common dir, worktree list); any write would throw. */
function seams(now = NOW): Seams {
  return {
    run: (command, args, options): CommandResult => {
      const readOnly = args.includes("--git-common-dir") || (args.includes("worktree") && args.includes("list"));
      if (command !== "git" || !readOnly) throw new Error(`must not be called: ${command} ${args.join(" ")}`);
      return spawnRunner(command, args, options);
    },
    now: (): Date => new Date(now),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: "linux",
  };
}

async function run(argv: readonly string[], repo: string, now = NOW): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (l): void => { out.push(l); }, err: (l): void => { err.push(l); } };
  const code = await runFamily(phaseCommand, argv, repo, false, io, seams(now));
  return { code, out, err };
}

async function list(repo: string, extra: readonly string[] = [], now = NOW): Promise<PhaseListReport> {
  const result = await run(["phase", "list", "--json", ...extra], repo, now);
  expect(result.code, result.err.join("\n")).toBe(0);
  return JSON.parse(result.out.join("\n")) as PhaseListReport;
}

const entry = (phase: string, startedAt: string, endedAt: string | null = null, exitCode: number | null = null): Record<string, unknown> => ({
  phase, startedAt, endedAt, durationMs: endedAt === null ? null : Date.parse(endedAt) - Date.parse(startedAt), exitCode, surface: null, model: null, note: null, steps: [], dial: null,
});

/** One ledger file at `dir`, its mtime set to `mtime`. */
function ledger(dir: string, effort: string, phases: readonly Record<string, unknown>[], mtime: Date, overrides: Record<string, unknown> = {}): string {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${encodeEffortId(effort)}.json`);
  writeFileSync(path, JSON.stringify({ contract: PHASE_CONTRACT, effort, phases, ...overrides }));
  utimesSync(path, mtime, mtime);
  return path;
}

const plainDir = (): string => realpathSync(makeTempDir("nen-phase-list-"));
const phasesOf = (root: string): string => join(root, ".nen", "phases");

function git(cwd: string, ...args: string[]): void {
  const result = spawnRunner("git", args, { cwd, env: { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_COMMON_DIR: undefined } });
  if (result.code !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
}

/** A repository with one commit and a linked worktree beside it. */
function repoWithWorktree(): { main: string; linked: string; common: string } {
  const base = plainDir();
  const main = join(base, "main");
  mkdirSync(main);
  git(main, "init", "-q", "-b", "main");
  git(main, "-c", "user.name=t", "-c", "user.email=t@example.invalid", "commit", "-q", "--allow-empty", "-m", "init");
  const linked = join(base, "linked");
  git(main, "worktree", "add", "-q", "-b", "side", linked);
  return { main, linked, common: join(main, ".git") };
}

/** Every path under `root` with its bytes (files) or a marker (directories): the read-only proof's snapshot. */
function snapshot(root: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      const key = relative(root, path);
      if (entry.isDirectory()) {
        out[key] = "<dir>";
        walk(path);
      } else if (entry.isFile()) {
        out[key] = `${readFileSync(path).toString("base64")}@${statSync(path).mtimeMs}`;
      } else {
        out[key] = "<other>";
      }
    }
  };
  walk(root);
  return out;
}

describe("decodeLedgerFileName -- the inverse of the one encoder, on its image only", () => {
  it("round-trips ids carrying '/', '#' and ':' (and the plain ones)", () => {
    for (const id of ["HA/85", "HA-IS-#12", "inline-2026-01-01T00:00:00Z", "zheref/nen#583:retry", "plain.id_1-2"]) {
      const name = `${encodeEffortId(id)}.json`;
      expect(name).not.toMatch(/[/#:]/);
      expect(decodeLedgerFileName(name)).toBe(id);
    }
    expect(encodeEffortId("HA/85#1:2")).toBe("HA%2F85%231%3A2");
  });

  it("refuses a '%' the encoder never wrote: a stray one, a double-encoded one, a lower-case or needless escape", () => {
    // '%' itself is not in the effort-id grammar, so an id never carries one;
    // a name whose '%' decodes to one (HA%252F85 -> 'HA%2F85') is no ledger name.
    expect(decodeLedgerFileName("a%zz.json")).toBeNull();
    expect(decodeLedgerFileName("HA%252F85.json")).toBeNull();
    expect(decodeLedgerFileName("HA%2f85.json")).toBeNull();
    expect(decodeLedgerFileName("HA%2D85.json")).toBeNull();
    expect(decodeLedgerFileName("%2E%2E.json")).toBeNull();
    expect(decodeLedgerFileName("x.json.lock")).toBeNull();
    expect(decodeLedgerFileName(".json")).toBeNull();
  });
});

describe("nen phase list -- AC-1: one row per effort, the newest phase and the mtime", () => {
  it("lists every effort with its decoded id, the LAST phases[] entry and the file's mtime, newest modification first, ties by effort id", async () => {
    const root = plainDir();
    const dir = phasesOf(root);
    ledger(dir, "HA/85", [entry("breath", "2026-03-01T10:00:00.000Z", "2026-03-01T10:01:00.000Z", 0), entry("rasengan", "2026-03-01T10:02:00.000Z")], at(-5 * MIN));
    ledger(dir, "b-tie", [entry("kokusen", "2026-03-01T09:00:00.000Z", "2026-03-01T09:00:05.000Z", 1)], at(-20 * MIN));
    ledger(dir, "a-tie", [], at(-20 * MIN));
    const report = await list(root);
    expect(report.contract).toBe(PHASE_LIST_CONTRACT);
    expect(report.home).toBe(".nen/phases");
    expect(report.now).toBe(NOW);
    expect(report.efforts.map((row) => row.effort)).toEqual(["HA/85", "a-tie", "b-tie"]);
    const first = report.efforts[0];
    expect(first).toEqual({
      effort: "HA/85",
      file: "HA%2F85.json",
      path: join(dir, "HA%2F85.json"),
      location: "repo",
      state: "ok",
      modifiedAt: at(-5 * MIN).toISOString(),
      phaseCount: 2,
      newest: { phase: "rasengan", startedAt: "2026-03-01T10:02:00.000Z", endedAt: null, exitCode: null },
      reason: null,
      copies: [{ path: join(dir, "HA%2F85.json"), location: "repo", modifiedAt: at(-5 * MIN).toISOString() }],
    });
    // Keys in the documented order (docs/USAGE.md § nen phase list).
    expect(Object.keys(report)).toEqual(["contract", "repo", "home", "locations", "since", "now", "efforts"]);
    expect(Object.keys(first ?? {})).toEqual(["effort", "file", "path", "location", "state", "modifiedAt", "phaseCount", "newest", "reason", "copies"]);
    expect(report.efforts[1]).toMatchObject({ effort: "a-tie", state: "ok", phaseCount: 0, newest: null });
    expect(report.efforts[2]?.newest).toEqual({ phase: "kokusen", startedAt: "2026-03-01T09:00:00.000Z", endedAt: "2026-03-01T09:00:05.000Z", exitCode: 1 });
  });

  it("the newest phase is the last entry of phases[] -- the order begin appends in -- even when an earlier entry started later", async () => {
    const root = plainDir();
    ledger(phasesOf(root), "skew", [entry("later-clock", "2026-03-01T11:00:00.000Z"), entry("appended-last", "2026-03-01T08:00:00.000Z")], at(-MIN));
    expect((await list(root)).efforts[0]?.newest?.phase).toBe("appended-last");
  });

  it("reads what begin and end wrote: the verb and the ledger agree", async () => {
    const root = plainDir();
    expect((await run(["phase", "begin", "--effort", "HA-IS-#9", "--phase", "breath"], root, "2026-03-01T11:00:00Z")).code).toBe(0);
    expect((await run(["phase", "end", "--effort", "HA-IS-#9", "--exit", "0"], root, "2026-03-01T11:00:02Z")).code).toBe(0);
    const row = (await list(root)).efforts[0];
    expect(row).toMatchObject({ effort: "HA-IS-#9", file: "HA-IS-%239.json", state: "ok", newest: { phase: "breath", endedAt: "2026-03-01T11:00:02.000Z", exitCode: 0 } });
  });

  it("prints one aligned line per effort in plain output", async () => {
    const root = plainDir();
    const dir = phasesOf(root);
    ledger(dir, "HA/85", [entry("rasengan", "2026-03-01T10:02:00.000Z")], at(-5 * MIN));
    ledger(dir, "x", [entry("breath", "2026-03-01T09:00:00.000Z", "2026-03-01T09:00:05.000Z", 0)], at(-9 * MIN));
    writeFileSync(join(dir, "broken.json"), "{");
    utimesSync(join(dir, "broken.json"), at(-30 * MIN), at(-30 * MIN));
    const result = await run(["phase", "list"], root);
    expect(result.code).toBe(0);
    expect(result.out).toEqual([
      "3 efforts with a phase ledger under .nen/phases:",
      `  HA/85   ${at(-5 * MIN).toISOString()}  rasengan  started 2026-03-01T10:02:00.000Z  open`,
      `  x       ${at(-9 * MIN).toISOString()}  breath  started 2026-03-01T09:00:00.000Z  ended 2026-03-01T09:00:05.000Z exit 0`,
      `  broken  ${at(-30 * MIN).toISOString()}  UNREADABLE broken.json: not readable JSON`,
    ]);
  });
});

describe("nen phase list -- AC-2: --since <minutes> against the seam's clock", () => {
  it("keeps a ledger modified exactly at the window's edge and drops one a second past it", async () => {
    const root = plainDir();
    const dir = phasesOf(root);
    ledger(dir, "edge", [], at(-10 * MIN));
    ledger(dir, "past", [], at(-10 * MIN - 1000));
    ledger(dir, "fresh", [], at(-1000));
    ledger(dir, "future", [], at(5 * MIN));
    expect((await list(root, ["--since", "10"])).efforts.map((row) => row.effort)).toEqual(["future", "fresh", "edge"]);
    expect((await list(root, ["--since", "11"])).efforts.map((row) => row.effort)).toEqual(["future", "fresh", "edge", "past"]);
    expect((await list(root, ["--since", "1"])).efforts.map((row) => row.effort)).toEqual(["future", "fresh"]);
    expect((await list(root)).since).toBeNull();
    expect((await list(root, ["--since", "10"])).since).toBe(10);
    // The window moves with the clock, never with the host's.
    expect((await list(root, ["--since", "10"], "2026-03-01T12:00:01.000Z")).efforts.map((row) => row.effort)).toEqual(["future", "fresh"]);
    const plain = await run(["phase", "list", "--since", "1"], root, "2027-01-01T00:00:00Z");
    expect(plain.out).toEqual(["no phase ledgers modified in the last 1 min under .nen/phases (1 location looked in)"]);
  });

  it("refuses a non-positive or non-integer --since at exit 2, and --since on another verb", async () => {
    const root = plainDir();
    for (const bad of ["0", "-1", "1.5", "abc", "", "1e3", "007x"]) {
      const result = await run(["phase", "list", "--since", bad], root);
      expect(result.code, bad).toBe(2);
    }
    expect((await run(["phase", "list", "--since", "0"], root)).err.join("\n")).toMatch(/--since takes a positive whole number of minutes/);
    expect((await run(["phase", "show", "--effort", "x", "--since", "5"], root)).code).toBe(2);
    expect((await run(["phase", "list", "--effort", "x"], root)).code).toBe(2);
    expect((await run(["phase", "list", "--resume"], root)).code).toBe(2);
  });
});

describe("nen phase list -- AC-3: an unreadable ledger is one row, never the whole run", () => {
  it("marks each unreadable variant with its file name and a reason, and still prints the readable one, exit 0", async () => {
    const root = plainDir();
    const dir = phasesOf(root);
    ledger(dir, "good", [entry("breath", "2026-03-01T10:00:00.000Z")], at(-MIN));
    const write = (name: string, text: string): void => {
      writeFileSync(join(dir, name), text);
    };
    write("bad-json.json", "{ not json");
    write("array.json", "[]");
    write("foreign.json", JSON.stringify({ contract: "nen.usage.ledger/v0.1", effort: "foreign", phases: [] }));
    write("newer.json", JSON.stringify({ contract: "nen.phase.ledger/v0.2", effort: "newer", phases: [] }));
    write("newer-major.json", JSON.stringify({ contract: "nen.phase.ledger/v1", effort: "newer-major", phases: [] }));
    write("mismatch.json", JSON.stringify({ contract: PHASE_CONTRACT, effort: "someone-else", phases: [] }));
    write("no-effort.json", JSON.stringify({ contract: PHASE_CONTRACT, phases: [] }));
    write("no-phases.json", JSON.stringify({ contract: PHASE_CONTRACT, effort: "no-phases", phases: {} }));
    write("bad-entry.json", JSON.stringify({ contract: PHASE_CONTRACT, effort: "bad-entry", phases: [{ phase: 3 }] }));
    write("HA%2f85.json", JSON.stringify({ contract: PHASE_CONTRACT, effort: "HA/85", phases: [] }));
    // POSIX only, as the other link tests in this repository are: Windows needs a
    // privilege to make a link, and its chmod cannot take read permission away.
    const posix = process.platform !== "win32";
    const lockable = posix && process.getuid?.() !== 0;
    if (posix) symlinkSync(join(dir, "good.json"), join(dir, "link.json"));
    mkdirSync(join(dir, "dir.json"));
    write("locked.json", JSON.stringify({ contract: PHASE_CONTRACT, effort: "locked", phases: [] }));
    if (lockable) chmodSync(join(dir, "locked.json"), 0o000);
    // Not ledgers at all: the lock and a temp file an atomic write leaves are not listed.
    write("good.json.lock", "");
    write("good.json.123.abc.tmp", "");
    const report = await list(root);
    const reasons = Object.fromEntries(report.efforts.map((row) => [row.file, row.reason]));
    expect(report.efforts.find((row) => row.effort === "good")).toMatchObject({ state: "ok", reason: null });
    expect(report.efforts.filter((row) => row.state === "unreadable").map((row) => row.file).sort()).toEqual(
      ["HA%2f85.json", "array.json", "bad-entry.json", "bad-json.json", "dir.json", "foreign.json", ...(posix ? ["link.json"] : []), "mismatch.json", "newer-major.json", "newer.json", "no-effort.json", "no-phases.json", ...(lockable ? ["locked.json"] : [])].sort(),
    );
    expect(reasons["bad-json.json"]).toBe("not readable JSON");
    expect(reasons["array.json"]).toBe("not a JSON object");
    expect(reasons["foreign.json"]).toBe(`does not carry contract '${PHASE_CONTRACT}'`);
    expect(reasons["newer.json"]).toBe(`written under the newer contract 'nen.phase.ledger/v0.2'; this build reads '${PHASE_CONTRACT}'`);
    expect(reasons["newer-major.json"]).toMatch(/newer contract 'nen\.phase\.ledger\/v1'/);
    expect(reasons["mismatch.json"]).toBe("names effort 'someone-else', but its file name decodes to 'mismatch'");
    expect(reasons["no-effort.json"]).toBe("carries no effort id");
    expect(reasons["no-phases.json"]).toBe("'phases' is not an array");
    expect(reasons["bad-entry.json"]).toBe("its newest phase entry is not a phase entry");
    expect(reasons["HA%2f85.json"]).toBe("the file name is not an encoded effort id");
    if (posix) expect(reasons["link.json"]).toMatch(/^a symbolic link; .* not read$/);
    expect(reasons["dir.json"]).toMatch(/^not a regular file/);
    if (lockable) expect(reasons["locked.json"]).toBe("could not be read (EACCES)");
    expect(report.efforts.find((row) => row.file === "HA%2f85.json")?.effort).toBeNull();
    expect(report.efforts.some((row) => row.file.endsWith(".lock") || row.file.endsWith(".tmp"))).toBe(false);
    if (lockable) chmodSync(join(dir, "locked.json"), 0o600);
  });

  it("an absent or empty ledger directory is an empty list, exit 0", async () => {
    const root = plainDir();
    expect((await list(root)).efforts).toEqual([]);
    const plain = await run(["phase", "list"], root);
    expect(plain).toMatchObject({ code: 0, out: ["no phase ledgers under .nen/phases (1 location looked in)"] });
    mkdirSync(phasesOf(root), { recursive: true });
    expect((await list(root)).efforts).toEqual([]);
  });
});

describe("nen phase list -- AC-4: every location `show` reads, each effort once", () => {
  it("lists the durable common-dir home and every checkout's older .nen/phases/, marking the older copy", async () => {
    const { main, linked, common } = repoWithWorktree();
    const durable = join(common, ".nen", "phases");
    ledger(durable, "HA/1", [entry("breath", "2026-03-01T10:00:00.000Z")], at(-MIN));
    ledger(phasesOf(main), "old-main", [entry("rasengan", "2026-03-01T09:00:00.000Z")], at(-2 * MIN));
    ledger(phasesOf(linked), "old-linked", [entry("kokusen", "2026-03-01T08:00:00.000Z")], at(-3 * MIN));
    for (const from of [main, linked]) {
      const report = await list(from);
      expect(report.home).toBe("<git-common-dir>/.nen/phases");
      expect(report.locations.map((l) => l.location)).toEqual(["common-dir", "worktree", "worktree"]);
      expect(report.efforts.map((row) => [row.effort, row.location, row.state])).toEqual([
        ["HA/1", "common-dir", "ok"],
        ["old-main", "worktree", "ok"],
        ["old-linked", "worktree", "ok"],
      ]);
    }
    const plain = await run(["phase", "list"], linked);
    expect(plain.out[0]).toBe("3 efforts with a phase ledger under <git-common-dir>/.nen/phases:");
    expect(plain.out[3]).toMatch(/kokusen .* \(older worktree-local: .*linked[\\/]\.nen[\\/]phases[\\/]old-linked\.json\)$/);
    // show reads the same older copy in place -- the same set of locations.
    expect((await run(["phase", "show", "--effort", "old-linked", "--json"], main)).code).toBe(0);
  });

  it("an effort in both places is ONE conflict row naming every copy, as show refuses it", async () => {
    const { main, linked, common } = repoWithWorktree();
    const a = ledger(join(common, ".nen", "phases"), "dup", [entry("breath", "2026-03-01T10:00:00.000Z")], at(-4 * MIN));
    const b = ledger(phasesOf(linked), "dup", [entry("rasengan", "2026-03-01T11:00:00.000Z")], at(-MIN));
    const report = await list(main);
    expect(report.efforts).toHaveLength(1);
    expect(report.efforts[0]).toMatchObject({
      effort: "dup",
      location: "multiple",
      state: "conflict",
      modifiedAt: at(-MIN).toISOString(),
      newest: null,
      phaseCount: null,
      copies: [
        { path: a, location: "common-dir", modifiedAt: at(-4 * MIN).toISOString() },
        { path: b, location: "worktree", modifiedAt: at(-MIN).toISOString() },
      ],
    });
    expect(report.efforts[0]?.reason).toMatch(/in 2 places .*nen will not choose.*'nen phase show' refuses it/);
    const show = await run(["phase", "show", "--effort", "dup"], main);
    expect(show.code).toBe(1);
    expect(show.err.join("\n")).toMatch(/more than one place/);
    expect((await run(["phase", "list"], main)).out[1]).toMatch(/dup .*CONFLICT   in 2 places: .* -- 'phase show' refuses it$/);
  });

  it.skipIf(process.platform === "win32")("a symlinked older .nen directory is reported as one unreadable row and never followed (POSIX only: a link needs a privilege on Windows)", async () => {
    const { main, linked } = repoWithWorktree();
    const elsewhere = plainDir();
    ledger(phasesOf(elsewhere), "planted", [], at(-MIN));
    symlinkSync(join(elsewhere, ".nen"), join(linked, ".nen"));
    const report = await list(main);
    expect(report.efforts.some((row) => row.effort === "planted")).toBe(false);
    expect(report.efforts).toHaveLength(1);
    expect(report.efforts[0]).toMatchObject({ effort: null, state: "unreadable", location: "worktree" });
    expect(report.efforts[0]?.reason).toMatch(/is a symbolic link; a ledger directory is listed only when it is a real directory/);
  });
});

describe("nen phase list -- reads only", () => {
  it("moves nothing, writes nothing, takes no lock and creates no directory", async () => {
    const { main, linked, common } = repoWithWorktree();
    ledger(join(common, ".nen", "phases"), "durable", [entry("breath", "2026-03-01T10:00:00.000Z")], at(-MIN));
    ledger(phasesOf(linked), "older", [entry("rasengan", "2026-03-01T10:00:00.000Z")], at(-2 * MIN));
    writeFileSync(join(phasesOf(linked), "bad.json"), "{");
    const before = { main: snapshot(main), linked: snapshot(linked) };
    await list(main);
    await list(linked, ["--since", "5"]);
    expect((await run(["phase", "list"], main)).code).toBe(0);
    expect({ main: snapshot(main), linked: snapshot(linked) }).toEqual(before);
    expect(Object.keys(before.main).some((key) => key.endsWith(".lock"))).toBe(false);
    // The older copy is still where it was: a list never migrates it.
    expect(readdirSync(phasesOf(linked)).sort()).toEqual(["bad.json", "older.json"]);
  });

  it("creates no ledger directory where none exists", async () => {
    const { main, linked, common } = repoWithWorktree();
    const before = { main: snapshot(main), linked: snapshot(linked) };
    expect((await list(linked)).efforts).toEqual([]);
    expect({ main: snapshot(main), linked: snapshot(linked) }).toEqual(before);
    expect(readdirSync(common)).not.toContain(".nen");
  });
});

describe("nen phase list -- hanten round 1 (SEC-7 and the read path)", () => {
  it("strips ESC, CR and OSC from every ledger string in plain output, and --json still carries them escaped", async () => {
    const root = plainDir();
    const hostile = "2026-03-01T10:00:00.000Z\u001b[2J\r\u001b]0;pwned\u0007";
    ledger(phasesOf(root), "evil", [entry("p\u001b[31mhase", hostile, `${hostile}-end`, 0)], at(-MIN));
    const plain = await run(["phase", "list"], root);
    expect(plain.code).toBe(0);
    for (const line of plain.out) expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
    expect(plain.out[1]).toMatch(/p\[31mhase  started 2026-03-01T10:00:00\.000Z\[2J\]0;pwned  ended 2026-03-01T10:00:00\.000Z\[2J\]0;pwned-end exit 0$/);
    const json = await run(["phase", "list", "--json"], root);
    expect(json.out.join("\n")).toContain("\\u001b]0;pwned\\u0007");
    const report = JSON.parse(json.out.join("\n")) as PhaseListReport;
    expect(report.efforts[0]?.newest).toMatchObject({ startedAt: hostile, endedAt: `${hostile}-end` });
  });

  it("a ledger over the read cap is one unreadable row; a FIFO is never opened for a blocking read", async () => {
    const root = plainDir();
    const dir = phasesOf(root);
    ledger(dir, "fine", [], at(-MIN));
    writeFileSync(join(dir, "huge.json"), "");
    truncateSync(join(dir, "huge.json"), LEDGER_READ_CAP_BYTES + 1);
    if (process.platform !== "win32") {
      const made = spawnRunner("mkfifo", [join(dir, "fifo.json")], { cwd: dir });
      expect(made.code, made.stderr).toBe(0);
    }
    const report = await list(root);
    const reasons = Object.fromEntries(report.efforts.map((row) => [row.file, row.reason]));
    expect(reasons["huge.json"]).toBe(`larger than ${LEDGER_READ_CAP_BYTES} bytes; not read`);
    expect(reasons["fine.json"]).toBeNull();
    if (process.platform !== "win32") expect(reasons["fifo.json"]).toMatch(/^not a regular file/);
    // The cap is the descriptor's, and bounded on a smaller one too.
    writeFileSync(join(dir, "small.json"), "x".repeat(11));
    expect(openLedgerFile(join(dir, "small.json"), 10)?.problem).toBe("larger than 10 bytes; not read");
    expect(openLedgerFile(join(dir, "small.json"), 11)?.text).toBe("x".repeat(11));
  });

  it("a ledger gone between the listing and the open is no row at all (ENOENT is not unreadable)", () => {
    const root = plainDir();
    const dir = phasesOf(root);
    ledger(dir, "stays", [], at(-MIN));
    ledger(dir, "moved", [], at(-MIN));
    expect(openLedgerFile(join(dir, "never-there.json"))).toBeNull();
    const report = listPhaseLedgers(root, localEffortHome(root, "phases"), new Date(NOW), null, {
      afterReaddir: (_dir, names): void => {
        expect(names).toEqual(["moved.json", "stays.json"]);
        rmSync(join(dir, "moved.json"));
      },
    });
    expect(report.efforts.map((row) => [row.effort, row.state])).toEqual([["stays", "ok"]]);
  });

  it("caps the plain label width with an ellipsis; --json keeps the full name", async () => {
    const root = plainDir();
    const dir = phasesOf(root);
    // 120, not 240: the whole path must stay under Windows' 260-character limit.
    const long = `${"x".repeat(120)}%zz.json`;
    ledger(dir, "short", [], at(-MIN));
    writeFileSync(join(dir, long), "{}");
    const report = await list(root);
    expect(report.efforts.find((row) => row.file === long)?.file).toBe(long);
    const lines = renderPhaseList(report);
    const cut = `${"x".repeat(PLAIN_LABEL_MAX - 1)}…`;
    expect(lines.some((line) => line.startsWith(`  ${cut}  `))).toBe(true);
    expect(lines.find((line) => line.includes("short"))?.startsWith(`  ${"short".padEnd(PLAIN_LABEL_MAX)}  `)).toBe(true);
    expect(Math.max(...lines.slice(1).map((line) => line.indexOf(" 20")))).toBeLessThanOrEqual(PLAIN_LABEL_MAX + 4);
  });
});
