// src/run/manifest-command.test.ts -- `nen run start|append|verify|budget`
// through the real `runFamily`, with git and gh scripted.

import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily, type Io } from "../index.js";
import type { CommandResult, Seams } from "../seam/exec.js";
import { noPortProbe } from "../seam/scripted.js";
import { runCommand } from "./command.js";

const ok = (stdout: string): CommandResult => ({ code: 0, stdout, stderr: "", spawnFailed: false });
const failed = (stderr: string): CommandResult => ({ code: 1, stdout: "", stderr, spawnFailed: false });

interface Live {
  readonly state: "OPEN" | "MERGED" | "CLOSED";
  readonly base?: string;
  readonly headRef?: string;
  readonly head?: string;
}

function repo(): { root: string; common: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-run-cmd-"));
  const common = join(root, ".git");
  mkdirSync(common);
  return { root, common };
}

async function capture(
  argv: readonly string[],
  options: { common: string | null; prs?: Record<number, Live | "fail">; repoFlag?: string | null; json?: boolean },
): Promise<{ code: number; out: string[]; err: string[]; calls: string[][] }> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const seams: Seams = {
    run: (command, args): CommandResult => {
      calls.push([command, ...args]);
      if (command === "git" && args.includes("--git-common-dir")) return options.common === null ? failed("fatal: not a git repository") : ok(`${options.common}\n`);
      if (command === "gh" && args[0] === "pr" && args[1] === "view") {
        const number = Number(args[2]);
        const live = options.prs?.[number];
        if (live === undefined || live === "fail") return failed(`could not resolve to a PullRequest with the number of ${number}`);
        return ok(JSON.stringify({
          number,
          state: live.state,
          mergedAt: live.state === "MERGED" ? "2026-10-22T01:00:00Z" : null,
          baseRefName: live.base ?? "integration/x",
          headRefName: live.headRef ?? `branch-${number}`,
          headRefOid: live.head ?? "abcdef1000000000000000000000000000000000",
        }));
      }
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    },
    now: (): Date => new Date("2026-10-22T00:00:00Z"),
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
  const code = await runFamily(runCommand, argv, options.repoFlag ?? null, options.json ?? false, io, seams);
  return { code, out, err, calls };
}

const append = (id: string, pr: number, extra: readonly string[] = []): string[] => [
  "run", "append", "--id", id, "--issue", `NN#${pr - 400}`, "--pr", String(pr), "--base", "integration/x", "--kind", "delivery", "--head", "abcdef1", ...extra,
];

describe("nen run start", () => {
  it("writes <git-common-dir>/hatsu/runs/<id>.json, and a dry run writes nothing", async () => {
    const { root, common } = repo();
    const dry = await capture(["run", "start", "--id", "r1", "--dry-run"], { common, repoFlag: root, json: true });
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out.join("\n")).outcome).toBe("dry-run");
    expect(existsSync(join(common, "hatsu", "runs", "r1.json"))).toBe(false);

    const started = await capture(["run", "start", "--id", "r1", "--idle-answers", '{"direct-mismatch":"default"}'], { common, repoFlag: root });
    expect(started.code).toBe(0);
    expect(started.out[0]).toBe(`started: run r1 -- ${join(common, "hatsu", "runs", "r1.json")}`);
    const stored = JSON.parse(readFileSync(join(common, "hatsu", "runs", "r1.json"), "utf8"));
    expect(stored).toEqual({ contract: "nen.run/v0.1", id: "r1", startedAt: "2026-10-22T00:00:00.000Z", idleAnswers: { "direct-mismatch": "default" }, prs: [] });
  });

  it("is the resume on the same answers and refuses other answers at exit 1", async () => {
    const { root, common } = repo();
    await capture(["run", "start", "--id", "r1"], { common, repoFlag: root });
    expect((await capture(["run", "start", "--id", "r1"], { common, repoFlag: root })).out[0]).toMatch(/^existing:/);
    const changed = await capture(["run", "start", "--id", "r1", "--idle-answers", '{"a":"hold"}'], { common, repoFlag: root });
    expect(changed.code).toBe(1);
    expect(changed.out[0]).toMatch(/^refused: .*fixed at start/);
  });

  it("requires --repo and a usable id, and refuses malformed answers at exit 2", async () => {
    const { root, common } = repo();
    expect((await capture(["run", "start", "--id", "r1"], { common })).code).toBe(2);
    expect((await capture(["run", "start", "--id", "../up"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture(["run", "start", "--id", "r1", "--idle-answers", '{"a":"maybe"}'], { common, repoFlag: root })).code).toBe(2);
  });

  it("refuses a checkout git cannot name a common dir for, at exit 1, writing nowhere", async () => {
    const { root } = repo();
    const result = await capture(["run", "start", "--id", "r1"], { common: null, repoFlag: root });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read the git common dir/);
  });
});

describe("nen run append", () => {
  it("records a PR, is unchanged on a retry, and refuses a run nobody started", async () => {
    const { root, common } = repo();
    expect((await capture(append("r1", 480), { common, repoFlag: root })).code).toBe(1);
    await capture(["run", "start", "--id", "r1"], { common, repoFlag: root });
    const first = await capture(append("r1", 480, ["--effort", "opus/kurapika/x"]), { common, repoFlag: root, json: true });
    expect(first.code).toBe(0);
    const doc = JSON.parse(first.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["outcome", "path", "reason", "entry", "previous"]);
    expect(doc.outcome).toBe("appended");
    expect((await capture(append("r1", 480), { common, repoFlag: root })).out[0]).toMatch(/^unchanged:/);
  });

  it("previews an update under --dry-run and writes it without", async () => {
    const { root, common } = repo();
    await capture(["run", "start", "--id", "r1"], { common, repoFlag: root });
    await capture(append("r1", 480), { common, repoFlag: root });
    const moved = ["run", "append", "--id", "r1", "--issue", "NN#80", "--pr", "480", "--base", "main", "--kind", "delivery", "--head", "1234567"];
    const dry = await capture([...moved, "--dry-run"], { common, repoFlag: root });
    expect(dry.out[0]).toMatch(/^dry-run \(would be updated\):/);
    const path = join(common, "hatsu", "runs", "r1.json");
    expect(JSON.parse(readFileSync(path, "utf8")).prs[0].base).toBe("integration/x");
    expect((await capture(moved, { common, repoFlag: root })).out[0]).toMatch(/^updated:/);
    expect(JSON.parse(readFileSync(path, "utf8")).prs[0]).toMatchObject({ base: "main", head: "1234567" });
  });

  it("refuses another issue for a recorded PR at exit 1, and malformed flags at exit 2", async () => {
    const { root, common } = repo();
    await capture(["run", "start", "--id", "r1"], { common, repoFlag: root });
    await capture(append("r1", 480), { common, repoFlag: root });
    const clash = await capture(["run", "append", "--id", "r1", "--issue", "NN#99", "--pr", "480", "--base", "integration/x", "--kind", "delivery", "--head", "abcdef1"], { common, repoFlag: root });
    expect(clash.code).toBe(1);
    expect(clash.out[0]).toMatch(/^refused: PR #480 is already recorded/);
    for (const [flag, value] of [["--kind", "hotfix"], ["--head", "xyz"], ["--issue", "twelve"], ["--pr", "0"], ["--base", "-x"], ["--effort", "#bad"]]) {
      const argv = append("r1", 481);
      const at = argv.indexOf(flag as string);
      const next = at === -1 ? [...argv, flag as string, value as string] : argv.map((v, i): string => (i === at + 1 ? (value as string) : v));
      expect((await capture(next, { common, repoFlag: root })).code, `${flag} ${value}`).toBe(2);
    }
  });

  it("refuses a flag another subcommand owns", async () => {
    const { root, common } = repo();
    expect((await capture([...append("r1", 480), "--target", "o/n"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture(["run", "verify", "--id", "r1", "--target", "o/n", "--dry-run"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture(["run", "rerun-failed", "--target", "o/n", "--run-id", "4", "--id", "r1"], { common, repoFlag: root })).code).toBe(2);
  });
});

describe("nen run verify", () => {
  async function seeded(): Promise<{ root: string; common: string }> {
    const { root, common } = repo();
    await capture(["run", "start", "--id", "r1"], { common, repoFlag: root });
    for (const pr of [480, 481, 482]) await capture(append("r1", pr), { common, repoFlag: root });
    await capture(["run", "append", "--id", "r1", "--issue", "NN#90", "--pr", "483", "--base", "main", "--kind", "integration", "--head", "abcdef1"], { common, repoFlag: root });
    return { root, common };
  }

  it("reads every recorded PR live, PRs into main included, and lists the unmerged", async () => {
    const { root, common } = await seeded();
    const prs: Record<number, Live> = {
      480: { state: "MERGED" },
      481: { state: "OPEN", head: "fedcba9000000000000000000000000000000000" },
      482: { state: "CLOSED" },
      483: { state: "OPEN", base: "main" },
    };
    const result = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen"], { common, repoFlag: root, prs, json: true });
    expect(result.code).toBe(0);
    const doc = JSON.parse(result.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["run", "target", "recorded", "counts", "open", "unmerged", "unread", "prs"]);
    expect(doc.counts).toEqual({ open: 2, merged: 1, closedUnmerged: 1, unread: 0 });
    expect(doc.open).toEqual([481, 483]);
    expect(doc.unmerged).toEqual([481, 482, 483]);
    expect(doc.prs[1].headMoved).toBe(true);
    expect(result.calls.filter((call): boolean => call[0] === "gh").map((call): string => call[3] as string)).toEqual(["480", "481", "482", "483"]);
  });

  it("exits 1 when any PR could not be read, and counts it nowhere", async () => {
    const { root, common } = await seeded();
    const result = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen"], {
      common,
      repoFlag: root,
      prs: { 480: { state: "MERGED" }, 481: "fail", 482: { state: "MERGED" }, 483: { state: "MERGED" } },
    });
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("run r1 on zheref/nen: 4 PR(s) recorded -- 0 open, 3 merged, 0 closed unmerged, 1 unread");
    expect(result.out.join("\n")).toMatch(/#481 NN#81 \[delivery\] unread:/);
  });

  it("exits 1 for a run that was never started -- never 'all merged'", async () => {
    const { root, common } = repo();
    const result = await capture(["run", "verify", "--id", "nope", "--target", "zheref/nen"], { common, repoFlag: root });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/no run 'nope'/);
  });

  it("refuses a malformed target at exit 2", async () => {
    const { root, common } = repo();
    expect((await capture(["run", "verify", "--id", "r1", "--target", "not-a-slug"], { common, repoFlag: root })).code).toBe(2);
  });
});

describe("nen run budget", () => {
  function ledger(root: string, effort: string, entries: readonly Record<string, unknown>[]): void {
    const dir = join(root, ".nen", "usage");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${encodeURIComponent(effort)}.json`), JSON.stringify({ contract: "nen.usage.ledger/v0.1", effort, entries }));
  }
  const entry = (minutes: number, input: number, output: number): Record<string, unknown> => ({
    recordedAt: "2026-10-22T00:00:00Z", surface: "claude-code", model: "opus", input, output, cacheRead: 10, cacheWrite: 0, minutes, source: "test", note: null, notReported: false, dial: "medium",
  });

  async function seeded(): Promise<{ root: string; common: string }> {
    const { root, common } = repo();
    await capture(["run", "start", "--id", "r1"], { common, repoFlag: root });
    await capture(append("r1", 480, ["--effort", "opus/kurapika/a"]), { common, repoFlag: root });
    await capture(append("r1", 481, ["--effort", "opus/kurapika/b"]), { common, repoFlag: root });
    return { root, common };
  }

  it("grants a claim under the ceiling and refuses it at exit 1 once reached", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/a", [entry(30, 100, 50)]);
    const under = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "60", "--max-tokens", "1000"], { common, repoFlag: root, json: true });
    expect(under.code).toBe(0);
    const doc = JSON.parse(under.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["run", "claim", "verdict", "granted", "ceiling", "spent", "efforts", "noLedger", "unread", "reasons"]);
    expect(doc).toMatchObject({ verdict: "within", granted: true, spent: { minutes: 30, tokens: 160 }, noLedger: ["opus/kurapika/b"] });

    ledger(root, "opus/kurapika/b", [entry(30, 1, 1)]);
    const at = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "60", "--max-tokens", "1000"], { common, repoFlag: root });
    expect(at.code).toBe(1);
    expect(at.out.at(-1)).toBe("claim: refused (reached) -- minutes 60 >= 60 (--max-minutes)");
  });

  it("reports without --claim at exit 0 even when reached, and counts --effort efforts with no PR yet", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/c", [entry(5, 2000, 0)]);
    const result = await capture(["run", "budget", "--id", "r1", "--max-minutes", "60", "--max-tokens", "1000", "--effort", "opus/kurapika/c"], { common, repoFlag: root });
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toMatch(/^budget: reached -- tokens 2010 >= 1000/);
  });

  it("is unevaluated, exit 1, on a ledger that will not read -- never a zero", async () => {
    const { root, common } = await seeded();
    mkdirSync(join(root, ".nen", "usage"), { recursive: true });
    writeFileSync(join(root, ".nen", "usage", `${encodeURIComponent("opus/kurapika/a")}.json`), "{");
    const result = await capture(["run", "budget", "--id", "r1", "--max-minutes", "60", "--max-tokens", "1000"], { common, repoFlag: root, json: true });
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out.join("\n")).verdict).toBe("unevaluated");
  });

  it("takes the ceiling from nen/workflow.json idle.budget, and refuses at exit 2 when neither states one", async () => {
    const { root, common } = await seeded();
    expect((await capture(["run", "budget", "--id", "r1", "--claim"], { common, repoFlag: root })).code).toBe(2);
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ idle: { budget: { minutes: 90, tokens: 5000 } } }));
    const result = await capture(["run", "budget", "--id", "r1", "--claim", "--max-tokens", "10"], { common, repoFlag: root, json: true });
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc.ceiling).toEqual({ minutes: 90, tokens: 10, source: { minutes: expect.stringMatching(/idle\.budget\.minutes$/), tokens: "--max-tokens" } });
    expect(result.code).toBe(0);
    expect((await capture(["run", "budget", "--id", "r1", "--max-minutes", "0", "--max-tokens", "10"], { common, repoFlag: root })).code).toBe(2);
  });
});
