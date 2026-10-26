// src/run/manifest-command.test.ts -- `nen run start|append|verify|budget`
// through the real `runFamily`, with git and gh scripted.

import { describe, expect, it } from "vitest";
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
  readonly createdAt?: string;
}

function repo(): { root: string; common: string } {
  const root = mkdtempSync(join(tmpdir(), "nen-run-cmd-"));
  const common = join(root, ".git");
  mkdirSync(common);
  // The registry a <CODE>#<N> issue is normalised through (one spelling per issue).
  mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "repos.json"), JSON.stringify({ consumers: [{ repo: "zheref/nen", code: "NN", consumes: [] }], product_codes: { NN: "zheref/nen" } }));
  return { root, common };
}

async function capture(
  argv: readonly string[],
  options: { common: string | null; prs?: Record<number, Live | "fail">; repoFlag?: string | null; json?: boolean; now?: string; env?: (env: Readonly<Record<string, string | undefined>> | undefined) => void; platform?: NodeJS.Platform },
): Promise<{ code: number; out: string[]; err: string[]; calls: string[][] }> {
  const out: string[] = [];
  const err: string[] = [];
  const calls: string[][] = [];
  const io: Io = { out: (l): void => void out.push(l), err: (l): void => void err.push(l) };
  const seams: Seams = {
    run: (command, args, runOptions): CommandResult => {
      calls.push([command, ...args]);
      if (command === "git" && args.includes("--git-common-dir")) {
        options.env?.(runOptions?.env);
        return options.common === null ? failed("fatal: not a git repository") : ok(`${options.common}\n`);
      }
      if (command === "git" && args.includes("worktree") && args.includes("list")) return ok("");
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
          createdAt: live.createdAt ?? "2026-10-22T00:00:01Z",
        }));
      }
      throw new Error(`unexpected call: ${command} ${args.join(" ")}`);
    },
    now: (): Date => new Date(options.now ?? "2026-10-22T00:00:00Z"),
    env: {},
    probePort: noPortProbe,
    runInteractive: (): never => {
      throw new Error("no interactive form");
    },
    runStreamed: (): never => {
      throw new Error("no watched form");
    },
    platform: options.platform ?? "linux",
  };
  const code = await runFamily(runCommand, argv, options.repoFlag ?? null, options.json ?? false, io, seams);
  return { code, out, err, calls };
}

const append = (id: string, pr: number, extra: readonly string[] = []): string[] => [
  "run", "append", "--id", id, "--issue", `NN#${pr - 400}`, "--pr", String(pr), "--kind", "delivery", ...extra,
];
const START = ["run", "start", "--id", "r1", "--target", "zheref/nen"];
const OPEN_ALL: Record<number, Live> = { 480: { state: "OPEN" }, 481: { state: "OPEN" }, 482: { state: "OPEN" }, 483: { state: "OPEN", base: "main" } };

describe("nen run start", () => {
  it("writes <git-common-dir>/.nen/runs/<id>.json with the run's repo, and a dry run writes nothing", async () => {
    const { root, common } = repo();
    const dry = await capture([...START, "--dry-run"], { common, repoFlag: root, json: true });
    expect(dry.code).toBe(0);
    expect(JSON.parse(dry.out.join("\n")).outcome).toBe("dry-run");
    expect(existsSync(join(common, ".nen", "runs", "r1.json"))).toBe(false);

    const started = await capture([...START, "--idle-answers", '{"direct-mismatch":"default"}'], { common, repoFlag: root });
    expect(started.code).toBe(0);
    expect(started.out[0]).toBe(`started: run r1 -- ${join(common, ".nen", "runs", "r1.json")}`);
    const stored = JSON.parse(readFileSync(join(common, ".nen", "runs", "r1.json"), "utf8"));
    expect(stored).toEqual({ contract: "nen.run/v0.1", id: "r1", repo: "zheref/nen", startedAt: "2026-10-22T00:00:00.000Z", idleAnswers: { "direct-mismatch": "default" }, prs: [], parked: [] });
  });

  it("is the resume on the same answers and refuses other answers at exit 1", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    expect((await capture(START, { common, repoFlag: root })).out[0]).toMatch(/^existing:/);
    const changed = await capture([...START, "--idle-answers", '{"a":"hold"}'], { common, repoFlag: root });
    expect(changed.code).toBe(1);
    expect(changed.out[0]).toMatch(/^refused: .*fixed at start/);
  });

  it("requires --repo, --target and a usable id, and refuses malformed answers at exit 2", async () => {
    const { root, common } = repo();
    expect((await capture(START, { common })).code).toBe(2);
    expect((await capture(["run", "start", "--id", "r1"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture(["run", "start", "--id", "../up", "--target", "o/n"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture([...START, "--idle-answers", '{"a":"maybe"}'], { common, repoFlag: root })).code).toBe(2);
  });

  it("refuses a checkout git cannot name a common dir for, at exit 1, writing nowhere", async () => {
    const { root } = repo();
    const result = await capture(START, { common: null, repoFlag: root });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read the git common dir/);
  });

  it("asks git with an inherited GIT_DIR, GIT_COMMON_DIR and GIT_WORK_TREE dropped, so a hook's environment cannot steer it", async () => {
    const { root, common } = repo();
    let seen: Readonly<Record<string, string | undefined>> | undefined;
    await capture(START, { common, repoFlag: root, env: (env) => (seen = env) });
    for (const key of ["GIT_DIR", "GIT_COMMON_DIR", "GIT_WORK_TREE"]) {
      expect(seen !== undefined && key in seen && seen[key] === undefined, key).toBe(true);
    }
    expect(seen).toMatchObject({ LC_ALL: "C" });
  });

  it("moves a manifest an earlier build wrote at <common>/hatsu/runs/ to <common>/.nen/runs/ once", async () => {
    const { root, common } = repo();
    mkdirSync(join(common, "hatsu", "runs"), { recursive: true });
    writeFileSync(join(common, "hatsu", "runs", "r1.json"), JSON.stringify({ contract: "nen.run/v0.1", id: "r1", repo: "zheref/nen", startedAt: "2026-10-22T00:00:00.000Z", idleAnswers: null, prs: [], parked: [] }));
    const result = await capture(START, { common, repoFlag: root });
    expect(result.out[0]).toMatch(/^existing:/);
    expect(result.err.join("\n")).toMatch(/moved run manifest 'r1'/);
    expect(existsSync(join(common, ".nen", "runs", "r1.json"))).toBe(true);
    expect(existsSync(join(common, "hatsu", "runs", "r1.json"))).toBe(false);
  });
});

describe("nen run append", () => {
  it("records a PR read live, is unchanged on a retry, and refuses a run nobody started", async () => {
    const { root, common } = repo();
    expect((await capture(append("r1", 480), { common, repoFlag: root, prs: OPEN_ALL })).code).toBe(1);
    await capture(START, { common, repoFlag: root });
    const first = await capture(append("r1", 480, ["--effort", "opus/kurapika/x"]), { common, repoFlag: root, json: true, prs: OPEN_ALL });
    expect(first.code).toBe(0);
    const doc = JSON.parse(first.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["outcome", "path", "reason", "entry", "previous", "mode"]);
    expect(doc.outcome).toBe("appended");
    expect(doc.entry).toMatchObject({ issue: "zheref/nen#80", base: "integration/x", branch: "branch-480", head: "abcdef1000000000000000000000000000000000" });
    expect((await capture(append("r1", 480), { common, repoFlag: root, prs: OPEN_ALL })).out[0]).toMatch(/^unchanged:/);
  });

  it("refuses a PR created before the run started, one gh could not read, and --base or --head that disagree with the live PR", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    const early = await capture(append("r1", 480), { common, repoFlag: root, prs: { 480: { state: "OPEN", createdAt: "2026-10-21T23:59:59Z" } } });
    expect(early.code).toBe(1);
    expect(early.err.join("\n")).toMatch(/before run 'r1' started/);
    expect((await capture(append("r1", 480), { common, repoFlag: root, prs: { 480: "fail" } })).code).toBe(1);
    expect((await capture(append("r1", 480, ["--base", "main"]), { common, repoFlag: root, prs: OPEN_ALL })).code).toBe(1);
    expect((await capture(append("r1", 480, ["--head", "1234567"]), { common, repoFlag: root, prs: OPEN_ALL })).code).toBe(1);
    expect(existsSync(join(common, ".nen", "runs", "r1.json")) && JSON.parse(readFileSync(join(common, ".nen", "runs", "r1.json"), "utf8")).prs).toEqual([]);
  });

  it("records an integration PR with no issue (null), and requires --issue for a delivery PR", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    const integration = await capture(["run", "append", "--id", "r1", "--pr", "483", "--kind", "integration"], { common, repoFlag: root, prs: OPEN_ALL, json: true });
    expect(integration.code).toBe(0);
    expect(JSON.parse(integration.out.join("\n")).entry).toMatchObject({ issue: null, base: "main", kind: "integration" });
    expect((await capture(["run", "append", "--id", "r1", "--pr", "480", "--kind", "delivery"], { common, repoFlag: root, prs: OPEN_ALL })).code).toBe(2);
  });

  it("previews an update under --dry-run and writes it without", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    await capture(append("r1", 480), { common, repoFlag: root, prs: OPEN_ALL });
    const moved: Record<number, Live> = { 480: { state: "OPEN", base: "main", head: "1234567000000000000000000000000000000000" } };
    const dry = await capture([...append("r1", 480), "--dry-run"], { common, repoFlag: root, prs: moved });
    expect(dry.out[0]).toMatch(/^dry-run \(would be updated\):/);
    const path = join(common, ".nen", "runs", "r1.json");
    expect(JSON.parse(readFileSync(path, "utf8")).prs[0].base).toBe("integration/x");
    expect((await capture(append("r1", 480), { common, repoFlag: root, prs: moved })).out[0]).toMatch(/^updated:/);
    expect(JSON.parse(readFileSync(path, "utf8")).prs[0]).toMatchObject({ base: "main", head: "1234567000000000000000000000000000000000" });
  });

  it("refuses another issue for a recorded PR at exit 1, and malformed flags at exit 2", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    await capture(append("r1", 480), { common, repoFlag: root, prs: OPEN_ALL });
    const clash = await capture(["run", "append", "--id", "r1", "--issue", "NN#99", "--pr", "480", "--kind", "delivery"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(clash.code).toBe(1);
    expect(clash.out[0]).toMatch(/^refused: PR #480 is already recorded/);
    for (const [flag, value] of [["--kind", "hotfix"], ["--head", "xyz"], ["--issue", "twelve"], ["--pr", "0"], ["--base", "-x"], ["--effort", "#bad"]]) {
      const argv = append("r1", 481);
      const at = argv.indexOf(flag as string);
      const next = at === -1 ? [...argv, flag as string, value as string] : argv.map((v, i): string => (i === at + 1 ? (value as string) : v));
      expect((await capture(next, { common, repoFlag: root, prs: OPEN_ALL })).code, `${flag} ${value}`).toBe(2);
    }
  });

  it("refuses a flag another subcommand owns", async () => {
    const { root, common } = repo();
    expect((await capture([...append("r1", 480), "--target", "o/n"], { common, repoFlag: root })).code).toBe(2);
    // --dry-run is verify's own since zheref/nen#522 (the legacy move's dry form); --claim stays budget's.
    expect((await capture(["run", "verify", "--id", "r1", "--target", "o/n", "--claim"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture(["run", "rerun-failed", "--target", "o/n", "--run-id", "4", "--id", "r1"], { common, repoFlag: root })).code).toBe(2);
    expect((await capture(["run", "append", "--id", "r1", "--pr", "480", "--kind", "integration", "--row", "x"], { common, repoFlag: root })).code).toBe(2);
  });
});

describe("nen run park", () => {
  it("records parked[] { issue, row, at } once, and refuses a run nobody started and a malformed row", async () => {
    const { root, common } = repo();
    expect((await capture(["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "direct-mismatch"], { common, repoFlag: root })).code).toBe(1);
    await capture(START, { common, repoFlag: root });
    const parked = await capture(["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "direct-mismatch"], { common, repoFlag: root, json: true });
    expect(parked.code).toBe(0);
    expect(JSON.parse(parked.out.join("\n"))).toMatchObject({ outcome: "parked", entry: { issue: "zheref/nen#80", row: "direct-mismatch", at: "2026-10-22T00:00:00.000Z" } });
    expect((await capture(["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "direct-mismatch"], { common, repoFlag: root })).out[0]).toMatch(/^unchanged:/);
    const verified = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen"], { common, repoFlag: root, json: true });
    expect(JSON.parse(verified.out.join("\n")).parked).toEqual([{ issue: "zheref/nen#80", row: "direct-mismatch", at: "2026-10-22T00:00:00.000Z" }]);
    expect(JSON.parse(readFileSync(join(common, ".nen", "runs", "r1.json"), "utf8")).parked).toHaveLength(1);
    expect((await capture(["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "Bad Row"], { common, repoFlag: root })).code).toBe(2);
  });
});

describe("nen run verify", () => {
  async function seeded(): Promise<{ root: string; common: string }> {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    for (const pr of [480, 481, 482]) await capture(append("r1", pr), { common, repoFlag: root, prs: OPEN_ALL });
    await capture(["run", "append", "--id", "r1", "--issue", "NN#90", "--pr", "483", "--kind", "integration"], { common, repoFlag: root, prs: OPEN_ALL });
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
    expect(Object.keys(doc)).toEqual(["run", "target", "recorded", "counts", "open", "unmerged", "unread", "prs", "parked"]);
    expect(doc.counts).toEqual({ open: 2, merged: 1, closedUnmerged: 1, unread: 0 });
    expect(doc.open).toEqual([481, 483]);
    expect(doc.unmerged).toEqual([481, 482, 483]);
    expect(doc.prs[1].headMoved).toBe(true);
    expect(result.calls.filter((call): boolean => call[0] === "gh").map((call): string => call[3] as string)).toEqual(["480", "481", "482", "483"]);
  });

  it("exits 1 when any PR could not be read, counts it nowhere, and says the unmerged list is unknown", async () => {
    const { root, common } = await seeded();
    const result = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen"], {
      common,
      repoFlag: root,
      prs: { 480: { state: "MERGED" }, 481: "fail", 482: { state: "MERGED" }, 483: { state: "MERGED" } },
    });
    expect(result.code).toBe(1);
    expect(result.out[0]).toBe("run r1 on zheref/nen: 4 PR(s) recorded -- 0 open, 3 merged, 0 closed unmerged, 1 unread");
    expect(result.out.join("\n")).toMatch(/#481 zheref\/nen#81 \[delivery\] unread:/);
    expect(result.out.at(-1)).toBe("unmerged: unknown (1 unread)");
    const json = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen"], { common, repoFlag: root, json: true, prs: { 480: { state: "MERGED" }, 481: "fail", 482: { state: "MERGED" }, 483: { state: "MERGED" } } });
    expect(JSON.parse(json.out.join("\n")).unmerged).toBeNull();
  });

  it("refuses a --target that is not the run's repository at exit 2, reading nothing", async () => {
    const { root, common } = await seeded();
    const result = await capture(["run", "verify", "--id", "r1", "--target", "o/other"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(result.code).toBe(2);
    expect(result.calls.filter((call): boolean => call[0] === "gh")).toEqual([]);
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
  const entry = (minutes: number, input: number, output: number, notReported = false): Record<string, unknown> => ({
    recordedAt: "2026-10-22T00:00:00Z", surface: "claude-code", model: "opus", input, output, cacheRead: 10, cacheWrite: 0, minutes, source: "test", note: null, notReported, dial: "medium",
  });
  const AFTER = (minutes: number): string => new Date(Date.parse("2026-10-22T00:00:00Z") + minutes * 60_000).toISOString();

  async function seeded(): Promise<{ root: string; common: string }> {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    await capture(append("r1", 480, ["--effort", "opus/kurapika/a"]), { common, repoFlag: root, prs: OPEN_ALL });
    await capture(append("r1", 481, ["--effort", "opus/kurapika/b"]), { common, repoFlag: root, prs: OPEN_ALL });
    return { root, common };
  }

  it("counts minutes as wall-clock since startedAt, prints the efforts' own minutes as effortMinutes, and refuses a claim once reached", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/a", [entry(30, 100, 50)]);
    ledger(root, "opus/kurapika/b", [entry(45, 1, 1)]);
    const under = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "60", "--max-tokens", "1000"], { common, repoFlag: root, json: true, now: AFTER(20) });
    expect(under.code).toBe(0);
    const doc = JSON.parse(under.out.join("\n"));
    expect(Object.keys(doc)).toEqual(["run", "claim", "verdict", "granted", "ceiling", "spent", "remaining", "effortMinutes", "efforts", "noLedger", "unread", "tokensUnread", "reasons"]);
    expect(doc).toMatchObject({ verdict: "within", granted: true, spent: { minutes: 20, tokens: 172 }, remaining: { minutes: 40, tokens: 828 }, effortMinutes: 75, noLedger: [] });

    const at = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "60", "--max-tokens", "1000"], { common, repoFlag: root, now: AFTER(60) });
    expect(at.code).toBe(1);
    expect(at.out.at(-1)).toBe("claim: refused (reached) -- minutes 60 since 2026-10-22T00:00:00.000Z >= 60 (--max-minutes)");
  });

  it("fails closed when a delivery PR's effort has no ledger: tokens unread, verdict unevaluated, claim refused, exit 1", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/a", [entry(30, 100, 50)]);
    const result = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "600", "--max-tokens", "100000"], { common, repoFlag: root, json: true });
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc).toMatchObject({ verdict: "unevaluated", granted: false, spent: { tokens: null } });
    expect(doc.tokensUnread).toEqual(["delivery PR #481's effort opus/kurapika/b has no usage ledger"]);
  });

  it("fails closed when an --effort id has no ledger: tokens unread, verdict unevaluated, claim refused, exit 1", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/a", [entry(1, 1, 1)]);
    ledger(root, "opus/kurapika/b", [entry(1, 1, 1)]);
    const result = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "1000", "--max-tokens", "1000000", "--effort", "opus/kurapika/e2"], { common, repoFlag: root, json: true });
    expect(result.code).toBe(1);
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc).toMatchObject({ verdict: "unevaluated", granted: false, spent: { tokens: null }, noLedger: ["opus/kurapika/e2"] });
    expect(doc.tokensUnread).toEqual(["effort opus/kurapika/e2 (named by --effort) has no usage ledger"]);
  });

  it("fails closed when an entry was recorded --not-reported", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/a", [entry(30, 100, 50)]);
    ledger(root, "opus/kurapika/b", [entry(0, 0, 0, true)]);
    const result = await capture(["run", "budget", "--id", "r1", "--claim", "--max-minutes", "600", "--max-tokens", "100000"], { common, repoFlag: root });
    expect(result.code).toBe(1);
    expect(result.out.at(-1)).toMatch(/^claim: refused \(unevaluated\) -- token sum unread: opus\/kurapika\/b has 1 entry recorded --not-reported/);
  });

  it("reports without --claim at exit 0 even when reached, and counts --effort efforts with no PR yet", async () => {
    const { root, common } = await seeded();
    ledger(root, "opus/kurapika/a", [entry(1, 1, 1)]);
    ledger(root, "opus/kurapika/b", [entry(1, 1, 1)]);
    ledger(root, "opus/kurapika/c", [entry(5, 2000, 0)]);
    const result = await capture(["run", "budget", "--id", "r1", "--max-minutes", "60", "--max-tokens", "1000", "--effort", "opus/kurapika/c"], { common, repoFlag: root });
    expect(result.code).toBe(0);
    expect(result.out.at(-1)).toMatch(/^budget: reached -- tokens 2034 >= 1000/);
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
    ledger(root, "opus/kurapika/a", [entry(1, 1, 1)]);
    ledger(root, "opus/kurapika/b", [entry(1, 1, 1)]);
    expect((await capture(["run", "budget", "--id", "r1", "--claim"], { common, repoFlag: root })).code).toBe(2);
    mkdirSync(join(root, "nen"), { recursive: true });
    writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ idle: { budget: { minutes: 90, tokens: 5000 } } }));
    const result = await capture(["run", "budget", "--id", "r1", "--claim", "--max-tokens", "100"], { common, repoFlag: root, json: true });
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc.ceiling).toEqual({ minutes: 90, tokens: 100, source: { minutes: expect.stringMatching(/idle\.budget\.minutes$/), tokens: "--max-tokens" } });
    expect(result.code).toBe(0);
    expect((await capture(["run", "budget", "--id", "r1", "--max-minutes", "0", "--max-tokens", "10"], { common, repoFlag: root })).code).toBe(2);
  });
});

describe("nen run import -- Hatsu's futon run manifest into nen's (zheref/nen#486 AC-5)", () => {
  const HATSU_ID = "0123456789abcdef0123456789abcdef";
  function hatsuRun(common: string, overrides: Record<string, unknown> = {}): string {
    const dir = join(common, "hatsu", "futon");
    mkdirSync(dir, { recursive: true });
    const path = join(dir, `run-${HATSU_ID}.json`);
    writeFileSync(path, JSON.stringify({
      contract: "hatsu.futon.run/v0.2", id: HATSU_ID, repo: "zheref/nen", invocation: "hatsu:futon nen@bug", selector: "nen@bug",
      startedAt: "2026-10-22T00:00:00.000Z",
      idle: { decisions: [{ row: "direct-mismatch", resolution: "default" }, { row: "publish-offer", resolution: "refuse" }], localSlotFrees: "merged", terminal: "ready-at-prompt", budget: { minutes: 60, tokens: 1000 }, source: { ref: "origin/main", commit: "abc" } },
      prs: [{ issue: 480, pr: 480, base: "integration/x", kind: "delivery", head: "branch-480" }, { issue: null, pr: 483, base: "main", kind: "integration", head: "branch-483" }],
      parked: [{ issue: 482, row: "direct-mismatch", at: "2026-10-22T00:30:00.000Z" }],
      ...overrides,
    }));
    return path;
  }
  const IMPORT = ["run", "import", "--id", HATSU_ID];

  it("imports the start, every PR read live and every parked row, leaving the Hatsu file untouched", async () => {
    const { root, common } = repo();
    const source = hatsuRun(common);
    const before = readFileSync(source, "utf8");
    const result = await capture([...IMPORT, "--json"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n")).outcome).toBe("imported");
    const stored = JSON.parse(readFileSync(join(common, ".nen", "runs", `${HATSU_ID}.json`), "utf8"));
    expect(stored.repo).toBe("zheref/nen");
    expect(stored.startedAt).toBe("2026-10-22T00:00:00.000Z");
    expect(stored.idleAnswers).toEqual({ "direct-mismatch": "default", "publish-offer": "refuse" });
    expect(stored.prs.map((row: { pr: number; issue: string | null; kind: string; base: string; branch: string }) => [row.pr, row.issue, row.kind, row.base, row.branch])).toEqual([
      [480, "zheref/nen#480", "delivery", "integration/x", "branch-480"],
      [483, null, "integration", "main", "branch-483"],
    ]);
    expect(stored.parked).toEqual([{ issue: "zheref/nen#482", row: "direct-mismatch", at: "2026-10-22T00:30:00.000Z" }]);
    expect(readFileSync(source, "utf8")).toBe(before);
    // verify reads the imported manifest, main-based PR included
    const verified = await capture(["run", "verify", "--id", HATSU_ID, "--target", "zheref/nen", "--json"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(verified.code).toBe(0);
  });

  it("--dry-run over a legacy-path manifest moves nothing, creates no .nen and prints the mode it would set (N6 on #522)", async () => {
    const { root, common } = repo();
    hatsuRun(common);
    const legacy = join(common, "hatsu", "runs", `${HATSU_ID}.json`);
    mkdirSync(dirname(legacy), { recursive: true });
    const seeded = JSON.stringify({ contract: "nen.run/v0.1", id: HATSU_ID, repo: "zheref/nen", startedAt: "2026-10-22T00:00:00.000Z", idleAnswers: { "direct-mismatch": "default", "publish-offer": "refuse" }, prs: [], parked: [] });
    writeFileSync(legacy, seeded);
    if (process.platform !== "win32") chmodSync(legacy, 0o644);
    const dry = await capture([...IMPORT, "--dry-run"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(dry.code).toBe(0);
    expect(dry.out[0]).toMatch(/^dry-run: run /);
    expect(dry.err.join("\n")).toMatch(/would move run manifest '0123456789abcdef0123456789abcdef' .*dry run: nothing moved/);
    const modeLine = "mode: would set file 0600, directory 0700 (would narrow: file 0644 -> 0600) -- dry run, nothing written";
    if (process.platform !== "win32") {
      expect(dry.out.at(-1)).toBe(modeLine);
      // N5: the move's line on stderr and the plan's on stdout agree.
      expect(dry.err).toContain(`nen: ${modeLine}`);
    }
    expect(readFileSync(legacy, "utf8")).toBe(seeded);
    expect(existsSync(join(common, ".nen"))).toBe(false);
  });

  it("is idempotent, and a dry run writes nothing", async () => {
    const { root, common } = repo();
    hatsuRun(common);
    const dry = await capture([...IMPORT, "--dry-run", "--json"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(JSON.parse(dry.out.join("\n")).outcome).toBe("dry-run");
    expect(existsSync(join(common, ".nen", "runs", `${HATSU_ID}.json`))).toBe(false);
    await capture(IMPORT, { common, repoFlag: root, prs: OPEN_ALL });
    const again = await capture([...IMPORT, "--json"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(again.code).toBe(0);
    expect(JSON.parse(again.out.join("\n")).outcome).toBe("unchanged");
  });

  it("refuses the whole import at exit 1 when a PR cannot be read, writing nothing", async () => {
    const { root, common } = repo();
    hatsuRun(common);
    const result = await capture(IMPORT, { common, repoFlag: root, prs: { 480: { state: "OPEN" }, 483: "fail" } });
    expect(result.code).toBe(1);
    expect(result.err.join("\n")).toMatch(/could not read zheref\/nen#483/);
    expect(existsSync(join(common, ".nen", "runs", `${HATSU_ID}.json`))).toBe(false);
  });

  it("refuses a missing or malformed Hatsu manifest at exit 1, and reads --from", async () => {
    const { root, common } = repo();
    expect((await capture(IMPORT, { common, repoFlag: root })).code).toBe(1);
    hatsuRun(common, { contract: "hatsu.futon.run/v9" });
    const bad = await capture(IMPORT, { common, repoFlag: root, prs: OPEN_ALL });
    expect(bad.code).toBe(1);
    expect(bad.err.join("\n")).toMatch(/not a consumer run manifest/);
    const elsewhere = join(root, "copy.json");
    writeFileSync(elsewhere, JSON.stringify({ contract: "hatsu.futon.run/v0.1", id: HATSU_ID, repo: "zheref/nen", invocation: "x", selector: "x", startedAt: "2026-10-22T00:00:00.000Z" }));
    const v1 = await capture([...IMPORT, "--from", "copy.json", "--json"], { common, repoFlag: root });
    expect(v1.code).toBe(0);
    expect(JSON.parse(v1.out.join("\n")).manifest.prs).toEqual([]);
  });

  it("refuses an import that contradicts the manifest nen already holds", async () => {
    const { root, common } = repo();
    hatsuRun(common);
    await capture(["run", "start", "--id", HATSU_ID, "--target", "zheref/nen", "--idle-answers", '{"direct-mismatch":"hold"}'], { common, repoFlag: root });
    const result = await capture(IMPORT, { common, repoFlag: root, prs: OPEN_ALL });
    expect(result.code).toBe(1);
    expect(result.out.join("\n")).toMatch(/refused: .*fixed at start/);
  });
});

describe("one issue spelling per manifest (Nobunaga on #516)", () => {
  it("records a <CODE>#<N> as <owner/name>#<N>, so an append after an import names the same issue", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    await capture(["run", "append", "--id", "r1", "--issue", "NN#80", "--pr", "480", "--kind", "delivery"], { common, repoFlag: root, prs: OPEN_ALL });
    const again = await capture(["run", "append", "--id", "r1", "--issue", "zheref/nen#80", "--pr", "480", "--kind", "delivery"], { common, repoFlag: root, prs: OPEN_ALL });
    expect(again.code).toBe(0);
    expect(again.out[0]).toMatch(/^unchanged:/);
  });

  it("refuses a code the registry does not resolve, at exit 2", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    expect((await capture(["run", "append", "--id", "r1", "--issue", "ZZ#1", "--pr", "480", "--kind", "delivery"], { common, repoFlag: root, prs: OPEN_ALL })).code).toBe(2);
  });
});

it("an import over rows nen holds in the code spelling dedupes them rather than parking twice (Bugbot on #516)", async () => {
  const { root, common } = repo();
  const id = "0123456789abcdef0123456789abcdef";
  mkdirSync(join(common, ".nen", "runs"), { recursive: true });
  writeFileSync(join(common, ".nen", "runs", `${id}.json`), JSON.stringify({ contract: "nen.run/v0.1", id, repo: "zheref/nen", startedAt: "2026-10-22T00:00:00.000Z", idleAnswers: null, prs: [], parked: [{ issue: "NN#482", row: "direct-mismatch", at: "2026-10-22T00:30:00.000Z" }] }));
  mkdirSync(join(common, "hatsu", "futon"), { recursive: true });
  writeFileSync(join(common, "hatsu", "futon", `run-${id}.json`), JSON.stringify({ contract: "hatsu.futon.run/v0.2", id, repo: "zheref/nen", invocation: "x", selector: "x", startedAt: "2026-10-22T00:00:00.000Z", idle: null, prs: [], parked: [{ issue: 482, row: "direct-mismatch", at: "2026-10-22T00:30:00.000Z" }] }));
  const result = await capture(["run", "import", "--id", id, "--json"], { common, repoFlag: root });
  expect(result.code).toBe(0);
  const stored = JSON.parse(readFileSync(join(common, ".nen", "runs", `${id}.json`), "utf8"));
  expect(stored.parked).toEqual([{ issue: "zheref/nen#482", row: "direct-mismatch", at: "2026-10-22T00:30:00.000Z" }]);
});

describe("manifest modes and dry forms through the verbs (zheref/nen#522)", () => {
  const POSIX = process.platform !== "win32";
  const bits = (path: string): number => statSync(path).mode & 0o777;
  const LEGACY = { contract: "nen.run/v0.1", id: "r1", repo: "zheref/nen", startedAt: "2026-10-22T00:00:00.000Z", idleAnswers: null, prs: [], parked: [] };
  function legacy(common: string): string {
    const path = join(common, "hatsu", "runs", "r1.json");
    mkdirSync(join(common, "hatsu", "runs"), { recursive: true });
    writeFileSync(path, JSON.stringify(LEGACY));
    return path;
  }

  it.runIf(POSIX)("run start writes the manifest 0600 under 0700, prints the read-back line, and --json carries mode (AC-1)", async () => {
    const { root, common } = repo();
    const text = await capture(START, { common, repoFlag: root });
    const path = join(common, ".nen", "runs", "r1.json");
    expect(bits(path)).toBe(0o600);
    expect(bits(join(common, ".nen", "runs"))).toBe(0o700);
    expect(text.out).toEqual([`started: run r1 -- ${path}`, "mode: file 0600, directory 0700"]);
    const again = await capture(["run", "start", "--id", "r2", "--target", "zheref/nen"], { common, repoFlag: root, json: true });
    expect(JSON.parse(again.out.join("\n")).mode).toEqual({ verdict: "set", file: "0600", directory: "0700", repaired: [], reason: null });
    const resumed = await capture(START, { common, repoFlag: root, json: true });
    expect(JSON.parse(resumed.out.join("\n")).mode).toBeNull();
  });

  it("run start --dry-run creates no directory, no file and no mode, and says what it would set (AC-2)", async () => {
    const { root, common } = repo();
    const dry = await capture([...START, "--dry-run"], { common, repoFlag: root });
    expect(dry.out[1]).toBe("mode: would set file 0600, directory 0700 -- dry run, nothing written");
    expect(existsSync(join(common, ".nen"))).toBe(false);
  });

  it.runIf(POSIX)("append and park narrow a manifest an earlier build left wide, and say so (AC-1 repair)", async () => {
    const { root, common } = repo();
    await capture(START, { common, repoFlag: root });
    const path = join(common, ".nen", "runs", "r1.json");
    chmodSync(path, 0o644);
    chmodSync(join(common, ".nen", "runs"), 0o755);
    const parked = await capture(["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "direct-mismatch"], { common, repoFlag: root });
    expect(parked.out[1]).toBe("mode: file 0600, directory 0700 (narrowed: directory 0755 -> 0700, file 0644 -> 0600)");
    expect(bits(path)).toBe(0o600);
    chmodSync(path, 0o664);
    const appended = await capture(append("r1", 480), { common, repoFlag: root, prs: OPEN_ALL, json: true });
    expect(JSON.parse(appended.out.join("\n")).mode).toMatchObject({ verdict: "set", repaired: ["file 0664 -> 0600"] });
    expect(bits(path)).toBe(0o600);
  });

  it("run verify --dry-run prints the legacy move and moves nothing; the bare form moves it (AC-2)", async () => {
    const { root, common } = repo();
    const old = legacy(common);
    const dry = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen", "--dry-run"], { common, repoFlag: root });
    expect(dry.code).toBe(0);
    expect(dry.err.join("\n")).toMatch(/would move run manifest 'r1' from .*hatsu.runs.r1\.json to .*\.nen.runs.r1\.json \(dry run: nothing moved; read where it is\)/);
    expect(dry.out[0]).toMatch(/^run r1 on zheref\/nen: 0 PR\(s\) recorded/);
    expect(existsSync(old)).toBe(true);
    expect(existsSync(join(common, ".nen"))).toBe(false);
    const real = await capture(["run", "verify", "--id", "r1", "--target", "zheref/nen"], { common, repoFlag: root });
    expect(real.err.join("\n")).toMatch(/moved run manifest 'r1'/);
    expect(existsSync(old)).toBe(false);
    if (POSIX) {
      expect(bits(join(common, ".nen", "runs", "r1.json"))).toBe(0o600);
      expect(real.err.join("\n")).toMatch(/mode: file 0600, directory 0700/);
    }
  });

  it("run budget --dry-run and every writing verb's --dry-run leave a legacy manifest where it is (AC-2)", async () => {
    const { root, common } = repo();
    const old = legacy(common);
    const budget = await capture(["run", "budget", "--id", "r1", "--max-minutes", "60", "--max-tokens", "100", "--dry-run"], { common, repoFlag: root });
    expect(budget.code).not.toBe(2);
    expect(budget.err.join("\n")).toMatch(/would move run manifest 'r1'/);
    const start = await capture([...START, "--dry-run"], { common, repoFlag: root });
    expect(start.out[0]).toMatch(/^existing:/);
    const park = await capture(["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "direct-mismatch", "--dry-run"], { common, repoFlag: root });
    expect(park.out[0]).toMatch(/^dry-run:/);
    expect(park.err.join("\n")).toMatch(/would move run manifest 'r1'/);
    expect(existsSync(old)).toBe(true);
    expect(JSON.parse(readFileSync(old, "utf8")).parked).toEqual([]);
    expect(existsSync(join(common, ".nen"))).toBe(false);
  });

  it.runIf(POSIX)("a legacy move followed by a plan that writes nothing still reports the move's modes in --json (N5)", async () => {
    const { root, common } = repo();
    const old = legacy(common);
    chmodSync(old, 0o644);
    const result = await capture(START, { common, repoFlag: root, json: true });
    const doc = JSON.parse(result.out.join("\n"));
    expect(doc.outcome).toBe("existing");
    expect(doc.mode).toEqual({ verdict: "set", file: "0600", directory: "0700", repaired: ["file 0644 -> 0600"], reason: null });
  });

  it.runIf(POSIX)("a symlinked legacy manifest is refused by every verb, and the link's target keeps its mode (N1)", async () => {
    const { root, common } = repo();
    const victim = join(mkdtempSync(join(tmpdir(), "nen-run-victim-")), "victim.txt");
    writeFileSync(victim, JSON.stringify(LEGACY));
    chmodSync(victim, 0o644);
    mkdirSync(join(common, "hatsu", "runs"), { recursive: true });
    const link = join(common, "hatsu", "runs", "r1.json");
    symlinkSync(victim, link);
    for (const argv of [START, ["run", "verify", "--id", "r1", "--target", "zheref/nen"], ["run", "verify", "--id", "r1", "--target", "zheref/nen", "--dry-run"]]) {
      const result = await capture(argv, { common, repoFlag: root });
      expect(result.code, argv.join(" ")).toBe(1);
      expect(result.err.join("\n")).toMatch(/is a symbolic link; nen reads, moves and writes a run manifest only as a regular file/);
    }
    expect(bits(victim)).toBe(0o644);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(existsSync(join(common, ".nen", "runs", "r1.json"))).toBe(false);
  });

  it.runIf(POSIX)("a legacy 0644 manifest then a writing park keeps the move's narrowing in --json mode, and the dry form agrees (N9)", async () => {
    const PARK = ["run", "park", "--id", "r1", "--issue", "NN#80", "--row", "direct-mismatch"];
    const narrowing = ["file 0644 -> 0600"];
    const { root, common } = repo();
    chmodSync(legacy(common), 0o644);
    const dry = await capture([...PARK, "--dry-run"], { common, repoFlag: root, json: true });
    expect(JSON.parse(dry.out.join("\n")).mode).toEqual({ verdict: "would-set", file: "0600", directory: "0700", repaired: narrowing, reason: null });
    const real = await capture(PARK, { common, repoFlag: root, json: true });
    const doc = JSON.parse(real.out.join("\n"));
    expect(doc.outcome).toBe("parked");
    expect(doc.mode).toEqual({ verdict: "set", file: "0600", directory: "0700", repaired: narrowing, reason: null });
    expect(bits(join(common, ".nen", "runs", "r1.json"))).toBe(0o600);
  });

  it.runIf(POSIX)("a reader refuses a runs directory that is a link, at exit 1 naming it, and reads nothing through it (N8)", async () => {
    const { root, common } = repo();
    const elsewhere = mkdtempSync(join(tmpdir(), "nen-run-elsewhere-"));
    writeFileSync(join(elsewhere, "r1.json"), JSON.stringify(LEGACY));
    mkdirSync(join(common, ".nen"), { recursive: true });
    symlinkSync(elsewhere, join(common, ".nen", "runs"));
    for (const argv of [
      ["run", "budget", "--id", "r1", "--max-minutes", "60", "--max-tokens", "100", "--dry-run"],
      ["run", "budget", "--id", "r1", "--max-minutes", "60", "--max-tokens", "100"],
      ["run", "verify", "--id", "r1", "--target", "zheref/nen", "--dry-run"],
    ]) {
      const result = await capture(argv, { common, repoFlag: root });
      expect(result.code, argv.join(" ")).toBe(1);
      expect(result.out, argv.join(" ")).toEqual([]);
      expect(result.err.join("\n")).toMatch(/\.nen.runs' is a symbolic link; nen keeps run manifests only in a real directory/);
    }
  });

  it("a win32 host: the write stands and the verb says the mode was not set, in text and --json (AC-3)", async () => {
    const { root, common } = repo();
    const text = await capture(START, { common, repoFlag: root, platform: "win32" });
    expect(text.code).toBe(0);
    expect(text.out[1]).toMatch(/^mode: not set \(this host \(win32\) has no POSIX file modes/);
    const json = await capture(["run", "start", "--id", "r2", "--target", "zheref/nen"], { common, repoFlag: root, platform: "win32", json: true });
    expect(JSON.parse(json.out.join("\n")).mode).toMatchObject({ verdict: "not-set", file: null, directory: null });
    expect(existsSync(join(common, ".nen", "runs", "r2.json"))).toBe(true);
  });
});
