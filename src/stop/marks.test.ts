// One stop marker per gate (zheref/nen#513): seven marks keep seven markers,
// a clear removes one gate's only, list reads every unrung marker and an older
// single one, and a worktree removal loses none. Real git, real temp repos.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { run, type Io } from "../index.js";
import { parseMarker, STOP_MARK_CONTRACT, STOP_MARK_CONTRACT_V3 } from "./marker.js";

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
}

function repoWithWorktree(): { core: string; tree: string; marks: string } {
  const core = realpathSync(mkdtempSync(join(tmpdir(), "nen-marks-")));
  git(core, "init", "-q", "-b", "main");
  git(core, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "root");
  const tree = join(core, "wt");
  git(core, "worktree", "add", "-q", "-b", "effort", tree);
  return { core, tree, marks: join(core, ".git", ".nen", "marks") };
}

async function nen(argv: readonly string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } };
  const code = await run(argv, io);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

type Listed = { marks: { gate: string | null; effort: string | null; source: string; at: string }[]; unreadable: unknown[]; contract: string };
const list = async (repo: string): Promise<Listed> => JSON.parse((await nen(["stop", "list", "--repo", repo, "--json"])).out) as Listed;

describe("nen stop --mark keeps one marker per gate (zheref/nen#513)", () => {
  it("SC-1 / AC-1: a seven-gate run keeps 7 of 7 markers, and the single file still names the latest", async () => {
    const { tree, marks } = repoWithWorktree();
    const gates = ["G1", "G1-M", "G2", "G3", "G4", "G5"];
    for (const gate of gates) expect((await nen(["stop", "--gate", gate, "--mark", "--effort", "HA/1", "--repo", tree])).code).toBe(0);
    expect((await nen(["stop", "--mark", "--effort", "HA/1", "--repo", tree])).code).toBe(0);
    const listed = await list(tree);
    expect(listed.marks).toHaveLength(7);
    expect(listed.marks.map((mark): string => mark.gate ?? "none").sort()).toEqual([...gates, "none"].sort());
    expect(listed.marks.every((mark): boolean => mark.effort === "HA/1" && mark.source === "gate")).toBe(true);
    expect(existsSync(join(marks, "HA%2F1", "G1-M.json"))).toBe(true);
    const document = JSON.parse(readFileSync(join(marks, "HA%2F1", "G2.json"), "utf8")) as Record<string, unknown>;
    expect(document["contract"]).toBe(STOP_MARK_CONTRACT_V3);
    expect(parseMarker(document).ok).toBe(true);
    // backward compatible: the single file is still the latest stop, v0.1, unchanged in shape
    const single = JSON.parse(readFileSync(join(tree, ".nen", "last-stop.json"), "utf8")) as Record<string, unknown>;
    expect(Object.keys(single)).toEqual(["contract", "who", "gate", "notified", "at"]);
    expect(single["contract"]).toBe(STOP_MARK_CONTRACT);
  });

  it("AC-2: clear --gate removes only that gate's marker", async () => {
    const { tree } = repoWithWorktree();
    await nen(["stop", "--gate", "G2", "--mark", "--effort", "a", "--repo", tree]);
    await nen(["stop", "--gate", "G5", "--mark", "--effort", "a", "--repo", tree]);
    await nen(["stop", "--gate", "G5", "--mark", "--effort", "b", "--repo", tree]);
    const cleared = await nen(["stop", "clear", "--gate", "G5", "--effort", "a", "--repo", tree]);
    expect(cleared.code).toBe(0);
    const left = (await list(tree)).marks.map((mark): string => `${mark.effort}:${mark.gate}`).sort();
    expect(left).toEqual(["a:G2", "b:G5"]);
    // the single file recorded b's G5, a different stop, so it stays
    expect(existsSync(join(tree, ".nen", "last-stop.json"))).toBe(true);
    expect((await nen(["stop", "clear", "--gate", "G4", "--repo", tree])).out).toContain("nothing to clear");
  });

  it("AC-2: a bare clear consumes the single file and its own per-gate twin only", async () => {
    const { tree } = repoWithWorktree();
    await nen(["stop", "--gate", "G2", "--mark", "--repo", tree]);
    await nen(["stop", "--gate", "G5", "--mark", "--repo", tree]);
    expect((await nen(["stop", "clear", "--repo", tree])).code).toBe(0);
    expect(existsSync(join(tree, ".nen", "last-stop.json"))).toBe(false);
    expect((await list(tree)).marks.map((mark): string | null => mark.gate)).toEqual(["G2"]);
    expect((await nen(["stop", "clear", "--all", "--repo", tree])).code).toBe(0);
    expect((await list(tree)).marks).toEqual([]);
  });

  it("AC-3: an older single marker with no per-gate twin still lists, as legacy", async () => {
    const { tree } = repoWithWorktree();
    mkdirSync(join(tree, ".nen"), { recursive: true });
    writeFileSync(join(tree, ".nen", "last-stop.json"), JSON.stringify({ contract: STOP_MARK_CONTRACT, who: "old", gate: "G3", notified: false, at: "2026-01-01T00:00:00Z" }));
    const listed = await list(tree);
    expect(listed.marks).toEqual([expect.objectContaining({ source: "legacy", gate: "G3", effort: null, at: "2026-01-01T00:00:00Z" })]);
  });

  it("lists a marker it cannot read as unreadable at exit 1, never as no marker", async () => {
    const { tree, marks } = repoWithWorktree();
    mkdirSync(join(marks, "x"), { recursive: true });
    writeFileSync(join(marks, "x", "G2.json"), "{ not json");
    const result = await nen(["stop", "list", "--repo", tree, "--json"]);
    expect(result.code).toBe(1);
    expect((JSON.parse(result.out) as Listed).unreadable).toHaveLength(1);
  });

  it("SC-2 / AC-4: markers written in a worktree survive its removal", async () => {
    const { core, tree } = repoWithWorktree();
    for (const gate of ["G2", "G4", "G5"]) await nen(["stop", "--gate", gate, "--mark", "--effort", "e", "--repo", tree]);
    git(core, "worktree", "remove", "--force", tree);
    expect((await list(core)).marks).toHaveLength(3);
  });

  it("refuses --effort without --mark, and an --effort outside the grammar", async () => {
    const { tree } = repoWithWorktree();
    expect((await nen(["stop", "--gate", "G5", "--effort", "a", "--repo", tree])).code).toBe(2);
    expect((await nen(["stop", "--gate", "G5", "--mark", "--effort", "a b", "--repo", tree])).code).toBe(2);
    expect((await nen(["stop", "clear", "--effort", "a", "--repo", tree])).code).toBe(2);
    expect((await nen(["stop", "clear", "--all", "--gate", "G2", "--repo", tree])).code).toBe(2);
  });
});

describe("settle round on #516 (Nobunaga 3, 11)", () => {
  it("a twin whose single file a hook removed is not listed, and the next mark removes it; replaced ones stay", async () => {
    const { tree, marks } = repoWithWorktree();
    await nen(["stop", "--gate", "G2", "--mark", "--effort", "a", "--repo", tree]);
    await nen(["stop", "--gate", "G5", "--mark", "--effort", "a", "--repo", tree]);
    // the hook rings and removes the single file itself, as stop-bell.sh does
    execFileSync("rm", ["-f", join(tree, ".nen", "last-stop.json")]);
    expect((await list(tree)).marks.map((mark): string | null => mark.gate)).toEqual(["G2"]);
    await nen(["stop", "--gate", "G4", "--mark", "--effort", "a", "--repo", tree]);
    expect(existsSync(join(marks, "a", "G5.json"))).toBe(false);
    expect((await list(tree)).marks.map((mark): string | null => mark.gate)).toEqual(["G2", "G4"]);
  });

  it("clear --gate none removes a stop marked with no gate", async () => {
    const { tree, marks } = repoWithWorktree();
    await nen(["stop", "--mark", "--effort", "a", "--repo", tree]);
    expect(existsSync(join(marks, "a", "none.json"))).toBe(true);
    expect((await nen(["stop", "clear", "--gate", "none", "--effort", "a", "--repo", tree])).code).toBe(0);
    expect(existsSync(join(marks, "a", "none.json"))).toBe(false);
  });
});

it("clear --all removes an unreadable marker too, naming it (Bugbot on #516)", async () => {
  const { tree, marks } = repoWithWorktree();
  await nen(["stop", "--gate", "G2", "--mark", "--effort", "a", "--repo", tree]);
  mkdirSync(join(marks, "x"), { recursive: true });
  writeFileSync(join(marks, "x", "G5.json"), "{ not json");
  const result = await nen(["stop", "clear", "--all", "--repo", tree]);
  expect(result.code).toBe(0);
  expect(result.out).toMatch(/cleared .*G5\.json \(unreadable marker\)/);
  expect(existsSync(join(marks, "x", "G5.json"))).toBe(false);
  expect((await nen(["stop", "list", "--repo", tree])).code).toBe(0);
});
