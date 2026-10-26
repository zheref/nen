// src/loop/fromrun.test.ts -- `nen loop slots --from-run`: the efforts
// document built from the manifest and live reads, no field caller-typed.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { RUN_CONTRACT, type RunManifest, type RunPr } from "../run/manifest.js";
import type { LiveRead } from "../run/verify.js";
import { loopCommand } from "./command.js";
import { effortsFromRun, markerForBranch, readinessInProcess, type FromRunDeps, type MarkerRead, type ReadinessRead } from "./fromrun.js";

const NOW = "2026-10-22T00:00:00.000Z";
const row = (pr: number, kind: RunPr["kind"] = "delivery"): RunPr => ({ issue: `NN#${pr - 400}`, pr, base: "integration/x", branch: `branch-${pr}`, kind, head: "abcdef1", effort: null, recordedAt: NOW });
const manifest = (prs: readonly RunPr[]): RunManifest => ({ contract: RUN_CONTRACT, id: "r1", repo: "o/n", startedAt: NOW, idleAnswers: null, prs, parked: [] });
const open = (base: string, headRef: string): LiveRead => ({ ok: true, pr: { state: "open", base, headRef, head: "abcdef1", createdAt: NOW } });

function deps(live: Record<number, LiveRead>, ready: Record<number, ReadinessRead>, markers: Record<string, MarkerRead>): FromRunDeps {
  return {
    readPr: (pr) => live[pr] ?? { ok: false, reason: "unscripted" },
    readiness: async (pr) => ready[pr] ?? { ok: false, reason: "unscripted" },
    marker: (branch) => markers[branch] ?? { ok: true, present: false, where: null },
  };
}

describe("effortsFromRun", () => {
  it("computes every field from the reads and leaves integration and release PRs out", async () => {
    const report = await effortsFromRun(
      manifest([row(480), row(481), row(482, "integration"), row(483, "release")]),
      deps(
        { 480: open("integration/x", "b480"), 481: open("b480", "b481"), 482: open("main", "integration/x"), 483: open("main", "rel") },
        { 480: { ok: true, ready: true }, 481: { ok: true, ready: false } },
        { b480: { ok: true, present: true, where: "/wt/.nen/last-stop.json" } },
      ),
    );
    expect(report.notEfforts).toEqual([482, 483]);
    expect(report.efforts.map((e) => [e.pr, e.prOpen, e.ready, e.prompted, e.merged, e.stacked])).toEqual([
      [480, true, true, true, false, false],
      [481, true, false, false, false, true],
    ]);
    expect(report.efforts[1]?.facts).toBe("open, not-ready, no stop marker, stacked on b480");
    expect(report.unread).toEqual([]);
  });

  it("frees a merged PR, drops a closed-unmerged one, and holds what it could not read", async () => {
    const report = await effortsFromRun(
      manifest([row(480), row(481), row(482), row(483)]),
      deps(
        {
          480: { ok: true, pr: { state: "merged", base: "integration/x", headRef: "b480", head: "x", createdAt: NOW } },
          481: { ok: true, pr: { state: "closed-unmerged", base: "integration/x", headRef: "b481", head: "x", createdAt: NOW } },
          482: { ok: false, reason: "gh exit 1" },
          483: open("integration/x", "b483"),
        },
        { 483: { ok: false, reason: "pr ready verdict \"unevaluated\"" } },
        { b483: { ok: false, reason: "marker is not JSON" } },
      ),
    );
    expect(report.closedUnmerged).toEqual([481]);
    expect(report.efforts.find((e) => e.pr === 480)).toMatchObject({ merged: true, ready: true, prompted: true });
    expect(report.efforts.find((e) => e.pr === 482)).toMatchObject({ prOpen: true, ready: false, prompted: false, facts: "unread -- held" });
    expect(report.efforts.find((e) => e.pr === 483)).toMatchObject({ ready: false, prompted: false });
    expect(report.unread.map((u) => u.pr)).toEqual([482, 483, 483]);
  });
});

describe("markerForBranch", () => {
  const seams = (porcelain: string | null): Seams => ({
    run: (): CommandResult => (porcelain === null ? { code: 128, stdout: "", stderr: "fatal", spawnFailed: false } : { code: 0, stdout: porcelain, stderr: "", spawnFailed: false }),
    now: (): Date => new Date(NOW),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("none");
    },
    runStreamed: (): never => {
      throw new Error("none");
    },
    platform: "linux",
  });

  it("finds the worktree on the branch and reads a valid marker there as present", () => {
    const wt = mkdtempSync(join(tmpdir(), "nen-marker-"));
    mkdirSync(join(wt, ".nen"));
    writeFileSync(join(wt, ".nen", "last-stop.json"), JSON.stringify({ contract: "nen.stop.mark/v0.1", who: "kurapika", gate: "G2", notified: true, at: NOW }));
    const porcelain = `worktree /core\nHEAD 1\nbranch refs/heads/main\n\nworktree ${wt}\nHEAD 2\nbranch refs/heads/b480\n`;
    expect(markerForBranch(seams(porcelain), "/core", "b480")).toEqual({ ok: true, present: true, where: join(wt, ".nen", "last-stop.json") });
    expect(markerForBranch(seams(porcelain), "/core", "b999")).toEqual({ ok: true, present: false, where: null });
  });

  it("is unread on a marker that is not JSON", () => {
    const wt = mkdtempSync(join(tmpdir(), "nen-marker-"));
    mkdirSync(join(wt, ".nen"));
    writeFileSync(join(wt, ".nen", "last-stop.json"), "{");
    const read = markerForBranch(seams(`worktree ${wt}\nbranch refs/heads/b1\n`), "/core", "b1");
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.reason).toMatch(/is not JSON/);
  });

  it("is unread on a marker that will not parse and on a git that will not list", () => {
    const wt = mkdtempSync(join(tmpdir(), "nen-marker-"));
    mkdirSync(join(wt, ".nen"));
    writeFileSync(join(wt, ".nen", "last-stop.json"), JSON.stringify({ contract: "nen.stop.mark/v0.1" }));
    expect(markerForBranch(seams(`worktree ${wt}\nbranch refs/heads/b1\n`), "/core", "b1").ok).toBe(false);
    expect(markerForBranch(seams(null), "/core", "b1").ok).toBe(false);
  });
});

describe("nen loop slots --from-run (CLI)", () => {
  async function capture(argv: readonly string[], common: string, live: Record<number, string>, json = true): Promise<{ code: number; out: string[]; err: string[] }> {
    const out: string[] = [];
    const err: string[] = [];
    const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
    const seams: Seams = {
      run: (command, args): CommandResult => {
        if (command === "git" && args.includes("--git-common-dir")) return { code: 0, stdout: `${common}\n`, stderr: "", spawnFailed: false };
        if (command === "git" && args.includes("worktree")) return { code: 0, stdout: "", stderr: "", spawnFailed: false };
        if (command === "gh") {
          const n = Number(args[2]);
          return { code: 0, stdout: JSON.stringify({ number: n, state: live[n], mergedAt: live[n] === "MERGED" ? NOW : null, baseRefName: "integration/x", headRefName: `b${n}`, headRefOid: "abcdef1" }), stderr: "", spawnFailed: false };
        }
        throw new Error(`unexpected ${command} ${args.join(" ")}`);
      },
      now: (): Date => new Date(NOW),
      env: {},
      probePort: noPortProbe,
      runInteractive: (): never => {
        throw new Error("none");
      },
      runStreamed: (): never => {
        throw new Error("none");
      },
      platform: "linux",
    };
    const root = join(common, "..");
    const code = await runFamily(loopCommand, argv, root, json, io, seams);
    return { code, out, err };
  }

  function seeded(prs: readonly RunPr[]): string {
    const root = mkdtempSync(join(tmpdir(), "nen-slots-run-"));
    const common = join(root, ".git");
    mkdirSync(join(common, "hatsu", "runs"), { recursive: true });
    // Seeded at the spelling an earlier build used: a counter reads it in place and never moves it (zheref/nen#522 AC-2).
    writeFileSync(join(common, "hatsu", "runs", "r1.json"), JSON.stringify({ ...manifest(prs), repo: "zheref/nen" }));
    return common;
  }

  it("counts from the manifest: a merged PR frees, a closed one is gone, the rule is --repo's", async () => {
    const common = seeded([row(480), row(481), row(482, "integration")]);
    const result = await capture(["loop", "slots", "--from-run", "r1", "--target", "zheref/nen", "--local-cap", "1"], common, { 480: "MERGED", 481: "CLOSED", 482: "OPEN" });
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc.local).toMatchObject({ occupied: 0, free: 1 });
    expect(doc.localSlotFrees.rule).toBe("ready+prompted");
    expect(doc.fromRun).toMatchObject({ run: "r1", notEfforts: [482], closedUnmerged: [481], unread: [] });
    expect(doc.done).toEqual(["NN#80 #480"]);
    expect(existsSync(join(common, ".nen", "runs", "r1.json"))).toBe(false);
    expect(existsSync(join(common, ".nen", "runs"))).toBe(false);
    expect(existsSync(join(common, "hatsu", "runs", "r1.json"))).toBe(true);
    expect(result.err.join("\n")).toMatch(/read run manifest 'r1' in place at .*hatsu.runs.r1\.json; not moved to .* -- 'nen run verify --id r1 --target zheref\/nen' moves it/);
    const other = await capture(["loop", "slots", "--from-run", "r1", "--target", "o/other", "--local-cap", "1"], common, {});
    expect(other.code).toBe(2);
  });

  it.skipIf(process.platform === "win32")("refuses a runs directory that is a link, at exit 1, counting nothing through it (zheref/nen#522 N8)", async () => {
    const root = mkdtempSync(join(tmpdir(), "nen-slots-run-"));
    const common = join(root, ".git");
    const elsewhere = mkdtempSync(join(tmpdir(), "nen-slots-elsewhere-"));
    writeFileSync(join(elsewhere, "r1.json"), JSON.stringify({ ...manifest([row(480)]), repo: "zheref/nen" }));
    mkdirSync(join(common, ".nen"), { recursive: true });
    symlinkSync(elsewhere, join(common, ".nen", "runs"));
    const result = await capture(["loop", "slots", "--from-run", "r1", "--target", "zheref/nen", "--local-cap", "1"], common, { 480: "OPEN" }, false);
    expect(result.code).toBe(1);
    expect(result.out).toEqual([]);
    expect(result.err.join("\n")).toMatch(/\.nen.runs' is a symbolic link; nen keeps run manifests only in a real directory/);
  });

  it("refuses --efforts beside --from-run, --target without it, and a run nobody started", async () => {
    const common = seeded([]);
    expect((await capture(["loop", "slots", "--from-run", "r1", "--efforts", "e.json", "--target", "o/n", "--local-cap", "1"], common, {})).code).toBe(2);
    expect((await capture(["loop", "slots", "--efforts", "e.json", "--target", "o/n", "--local-cap", "1"], common, {})).code).toBe(2);
    expect((await capture(["loop", "slots", "--from-run", "r1", "--local-cap", "1"], common, {})).code).toBe(2);
    expect((await capture(["loop", "iterate", "--id", "x", "--from-run", "r1", "--line", "a until b up to 2"], common, {})).code).toBe(2);
    const missing = await capture(["loop", "slots", "--from-run", "r9", "--target", "o/n", "--local-cap", "1"], common, {}, false);
    expect(missing.code).toBe(1);
    expect(missing.err.join("\n")).toMatch(/no run 'r9'/);
  });
});

describe("readinessInProcess", () => {
  it("is a failed read, never 'not ready', when pr ready produces no verdict", async () => {
    // A checkout with no nen/gates.json and no --reviewers: pr ready refuses
    // before any network read, so this needs no token and no GitHub.
    const root = mkdtempSync(join(tmpdir(), "nen-ready-"));
    const read = await readinessInProcess("o/r", 7, root);
    expect(read.ok).toBe(false);
    expect(read.ok ? "" : read.reason).toMatch(/^pr ready produced no report \(exit 2\): .*no reviewer identities/);
  });
});
