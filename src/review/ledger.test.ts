// Port of Hatsu's ledger-guard cases: the roster is fixture data, never CLI
// policy. Git-backed fixtures and separate Node processes pin durable traces
// and read/modify/write serialization without network or a Python runtime.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { run, runFamily } from "../index.js";
import { defaultSeams } from "../seam/exec.js";
import { reviewCommand } from "./command.js";
import { cycleKey, cyclePath, cycleTraceDir, cycleTraceLock, ensureCycle, prKeyed, readBudgets, readCycle, runCycle, type Cycle, type CycleOptions } from "./ledger.js";

const roots: string[] = [];
const roster = { alpha: 2, beta: 1, gamma: 1, delta: 1, epsilon: 2, zeta: 3, eta: 1 };
function fixture(budgets: Record<string, number> = roster, git = false): CycleOptions {
  const root = mkdtempSync(join(tmpdir(), "nen-cycle-")); roots.push(root);
  policy(root, budgets);
  if (git) {
    gitRun(root, "init", "-q", "-b", "main");
    writeFileSync(join(root, ".gitignore"), ".nen/\n");
    gitRun(root, "add", ".");
    gitRun(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "initial");
    gitRun(root, "checkout", "-qb", "app/feature");
  }
  return { root, branch: "app/feature", seams: defaultSeams(), warn: (): void => {} };
}
function policy(root: string, budgets: Record<string, number>, base?: string): void {
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ ...(base === undefined ? {} : { branch: { base } }), review: { scopes: Object.fromEntries(Object.entries(budgets).map(([persona, budget], i): [string, unknown] => [`scope${i}`, { persona, budget, tier: "deep", paths: ["**"] }])) } }));
}
function gitRun(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout;
}
function act(o: CycleOptions, action: string, args: Parameters<typeof runCycle>[2] = {}): Record<string, unknown> {
  return runCycle(o, action, args);
}
function read(o: CycleOptions): Cycle { return readCycle(o, readBudgets(o.root)); }
function write(o: CycleOptions, doc: unknown): void { writeFileSync(cyclePath(o.root, o.branch, o.pr), JSON.stringify(doc)); }
function bytes(o: CycleOptions): string { return readFileSync(cyclePath(o.root, o.branch, o.pr), "utf8"); }
async function cli(o: CycleOptions, args: string[], json = true): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const code = await runFamily(reviewCommand, ["review", "ledger", ...args, "--repo", o.root, ...(json ? ["--json"] : [])], null, false, { out: (s): void => { out.push(s); }, err: (s): void => { err.push(s); } }, o.seams);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

describe("review-cycle ledger — Hatsu lifecycle parity with a declared roster", () => {
  it("opens the same v0.1 path, stamps the roster and records budget sources", () => {
    const o = fixture(); const result = act(o, "init"); const doc = read(o);
    expect(doc.contract).toBe("hatsu.hanten.cycle/v0.1"); expect(doc.slug).toBe("app-feature"); expect(doc.pr).toBeNull();
    expect(doc.personasAtOpen).toEqual(Object.keys(roster)); expect(result["openedAs"]).toBe("normal-init");
    expect(doc.reviewers.alpha).toMatchObject({ max: 2, used: 0, invocations: [], budgetSource: "nen/workflow.json review.scopes.scope0.budget" });
  });
  it("runs all four passes, keeping counts across resumes and remediation", () => {
    const o = fixture(); act(o, "init"); const all = Object.keys(roster).join(",");
    expect(act(o, "decide", { applicable: all })["raise"]).toEqual(Object.keys(roster));
    for (const persona of Object.keys(roster)) act(o, "record", { persona, outcome: "ran" });
    expect(act(o, "decide", { applicable: all })["skippedExhausted"]).toEqual(["beta", "gamma", "delta", "eta"]);
    expect(act(o, "decide", { applicable: all })["raise"]).toEqual(["alpha", "epsilon", "zeta"]);
    for (const persona of ["alpha", "epsilon", "zeta"]) act(o, "record", { persona, outcome: "ran" });
    act(o, "record", { persona: "beta", outcome: "skipped-exhausted" });
    expect(act(o, "decide", { applicable: all })["raise"]).toEqual(["zeta"]);
    expect(read(o).reviewers.gamma!.used).toBe(1);
    act(o, "record", { persona: "zeta", outcome: "ran" });
    expect(act(o, "decide", { applicable: all })["raise"]).toEqual([]);
    expect(Object.fromEntries(Object.entries(read(o).reviewers).map(([p, r]): [string, number] => [p, r.used]))).toEqual(roster);
    expect(readdirSync(dirname(cyclePath(o.root, o.branch))).filter((n): boolean => n.endsWith(".tmp"))).toEqual([]);
  });
  it.each(["init", "recover-first"])("refuses a second %s without modifying history", (action): void => {
    const o = fixture(); act(o, "init"); const before = bytes(o);
    expect(() => act(o, action)).toThrow(/already exists/); expect(bytes(o)).toBe(before);
  });
  it("never treats a missing read as a new cycle or leaves a lock trace", () => {
    const o = fixture(); for (const action of ["show", "decide", "record"]) expect(() => act(o, action)).toThrow(/no ledger/);
    expect(existsSync(cycleTraceLock(o.root, o.branch))).toBe(false);
    expect(ensureCycle(o).report["ensure"]).toBe("opened");
  });
  it("leaves inapplicable budgets available for later entry", () => {
    const o = fixture(); act(o, "init");
    expect(act(o, "decide", { applicable: "epsilon" })["raise"]).toEqual(["epsilon"]);
    act(o, "record", { persona: "epsilon", outcome: "ran" });
    expect(act(o, "decide", { applicable: "gamma" })["raise"]).toEqual(["gamma"]);
  });
  it("normalizes and deduplicates applicable reviewers, and accepts an empty set", () => {
    const o = fixture(); act(o, "init");
    expect(act(o, "decide", { applicable: " ALPHA,,alpha, BETA " })["raise"]).toEqual(["alpha", "beta"]);
    expect(act(o, "decide")["raise"]).toEqual([]);
    expect(() => act(o, "decide", { applicable: "invented" })).toThrow(/not declared/);
  });
  it.each([
    ["unknown", "ran", /not declared/], ["alpha", "skipped-exhausted", /still has budget/], ["alpha", "invalid", /--outcome/],
  ] as const)("refuses record %s/%s without saving", (persona, outcome, message): void => {
    const o = fixture(); act(o, "init"); const before = bytes(o);
    expect(() => act(o, "record", { persona, outcome })).toThrow(message); expect(bytes(o)).toBe(before);
  });
  it("refuses ran past the cap and records only justified skips", () => {
    const o = fixture({ reviewer: 0 }); act(o, "init");
    expect(act(o, "decide", { applicable: "reviewer" })["skippedExhausted"]).toEqual(["reviewer"]);
    expect(() => act(o, "record", { persona: "reviewer", outcome: "ran" })).toThrow(/exhausted/);
    expect(act(o, "record", { persona: "reviewer", outcome: "skipped-exhausted" })["used"]).toBe(0);
  });
  it("a new branch or PR is a fresh cycle and never changes the original", () => {
    const o = fixture(); act(o, "init"); act(o, "record", { persona: "gamma", outcome: "ran" }); const before = bytes(o);
    for (const options of [{ ...o, branch: "app/new" }, { ...o, pr: 7 }, { ...o, pr: 8 }]) {
      act(options, "init"); expect(read(options).reviewers.gamma!.used).toBe(0);
      expect(cyclePath(options.root, options.branch, options.pr)).not.toBe(cyclePath(o.root, o.branch));
    }
    expect(bytes(o)).toBe(before);
    expect(() => act({ ...o, pr: 7 }, "init")).toThrow(/already exists/);
  });
});

describe("repository policy and lossless legacy reads", () => {
  it("has no built-in persona roster when workflow or review is absent", () => {
    const o = fixture(); unlinkSync(join(o.root, "nen", "workflow.json"));
    expect(() => act(o, "init")).toThrow(/no built-in roster/);
    policy(o.root, {}); expect(() => act(o, "init")).toThrow(/no built-in roster/);
  });
  it.each([true, -1, 1.5, "two"])("refuses invalid workflow budget %s", (budget): void => {
    const o = fixture(); writeFileSync(join(o.root, "nen", "workflow.json"), JSON.stringify({ review: { scopes: { code: { persona: "alpha", budget, tier: "deep", paths: ["**"] } } } }));
    expect(() => act(o, "init")).toThrow();
  });
  it("uses the minimum budget across scopes irrespective of declaration order", () => {
    const o = fixture(); const file = join(o.root, "nen", "workflow.json");
    for (const budgets of [[4, 1], [1, 4]]) {
      writeFileSync(file, JSON.stringify({ review: { scopes: Object.fromEntries(budgets.map((budget, i): [string, unknown] => [`scope${i}`, { persona: "ALPHA", budget, tier: "deep", paths: ["**"] }])) } }));
      expect(readBudgets(o.root).alpha).toEqual({ max: 1, source: "nen/workflow.json review.scopes.scope0+scope1.budget (min of the scopes named)" });
    }
  });
  it("refreshes a changed maximum without resetting spent passes", () => {
    const o = fixture(); act(o, "init"); act(o, "record", { persona: "alpha", outcome: "ran" });
    policy(o.root, { alpha: 5 }); expect(read(o).reviewers.alpha).toMatchObject({ used: 1, max: 5 });
    policy(o.root, { alpha: 0 }); expect(act(o, "decide", { applicable: "alpha" })["raise"]).toEqual([]);
  });
  it("retains unknown historical reviewers and arbitrary document fields", () => {
    const o = fixture(); act(o, "init"); const doc = read(o); doc["legacyData"] = { unchanged: [1, 2] };
    doc.reviewers["retired"] = { max: 8, used: 1, invocations: [{ outcome: "ran", at: "old", extra: true }], other: "kept" }; write(o, doc);
    act(o, "record", { persona: "alpha", outcome: "ran" }); const after = read(o);
    expect(after["legacyData"]).toEqual(doc["legacyData"]); expect(after.reviewers["retired"]).toEqual(doc.reviewers["retired"]);
  });
  it("hydrates only a provably later persona and persists the audit on record", () => {
    const o = fixture({ alpha: 2 }); act(o, "init"); policy(o.root, { alpha: 2, newcomer: 1 }); const before = bytes(o);
    const doc = read(o); expect(doc.reviewers["newcomer"]).toMatchObject({ used: 0, hydratedAs: "persona-added-after-ledger-opened" });
    expect(doc.lateHydrated).toEqual(["newcomer"]); expect(bytes(o)).toBe(before);
    expect(act(o, "decide", { applicable: "newcomer" })["raise"]).toEqual(["newcomer"]);
    act(o, "record", { persona: "newcomer", outcome: "ran" }); expect(read(o).lateHydrated).toEqual(["newcomer"]);
    const lost = read(o); delete lost.reviewers["newcomer"]; write(o, lost); expect(() => read(o)).toThrow(/no valid newcomer/);
  });
  it("refuses ambiguous unstamped missing rows rather than minting counts", () => {
    const o = fixture(); act(o, "init"); const doc = read(o); delete doc.personasAtOpen; delete doc.reviewers.eta; write(o, doc);
    expect(() => read(o)).toThrow(/no valid eta/);
  });
  it("loads a complete unstamped legacy ledger losslessly", () => {
    const o = fixture(); act(o, "init"); const doc = read(o); delete doc.personasAtOpen; write(o, doc);
    expect(read(o).reviewers).toEqual(doc.reviewers);
  });
  it.each([
    ["contract", "other"], ["branch", "wrong"], ["pr", 7], ["reviewers", null], ["reviewers", []],
  ])("refuses wrong ledger %s=%s", (key, value): void => {
    const o = fixture(); act(o, "init"); const doc = read(o); doc[key as string] = value; write(o, doc); expect(() => read(o)).toThrow();
  });
  it.each([null, {}, { used: "one", invocations: [] }, { used: -1, max: 2, invocations: [] }, { used: true, max: 2, invocations: [] }, { used: 1.5, max: 2, invocations: [] }, { used: 0, max: 2, invocations: null }, { used: 0, max: 2, invocations: [{ outcome: "ran" }] }, { used: 1, max: 2, invocations: [] }, { used: 0, max: 2, invocations: [{ outcome: "unknown" }] }, { used: 0, max: 2, invocations: [null] }])("refuses malformed or inconsistent reviewer row %#", (row): void => {
    const o = fixture(); act(o, "init"); const doc = JSON.parse(bytes(o)) as Record<string, Record<string, unknown>>; doc["reviewers"]!["alpha"] = row; write(o, doc);
    expect(() => read(o)).toThrow();
  });
  it.each(["{bad", "null", "[]"])("refuses corrupt JSON document %s without rewriting it", (text): void => {
    const o = fixture(); act(o, "init"); writeFileSync(cyclePath(o.root, o.branch), text);
    expect(() => act(o, "show")).toThrow(); expect(bytes(o)).toBe(text);
  });
});

describe("ensure parity — trunk, durable markers, exact PR keys and other worktrees", () => {
  it.each(["main", "HEAD", "", "refs/heads/topic"])("refuses trunk or non-branch %s at exit 3 without a lock", (branch): void => {
    const o = { ...fixture(), branch }; expect(ensureCycle(o).code).toBe(3); expect(existsSync(join(o.root, ".nen", "hanten"))).toBe(false);
  });
  it("reads explicit base, workflow base and origin/HEAD", () => {
    const o = fixture({}, true);
    expect(ensureCycle({ ...o, branch: "develop", base: "develop" }).code).toBe(3);
    policy(o.root, {}, "trunk"); expect(ensureCycle({ ...o, branch: "trunk" }).code).toBe(3);
    policy(o.root, {}); gitRun(o.root, "update-ref", "refs/remotes/origin/develop", "HEAD"); gitRun(o.root, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
    expect(ensureCycle({ ...o, branch: "develop" }).code).toBe(3);
  });
  it("opens app-created branches once and leaves an existing spent ledger byte-identical", () => {
    const o = fixture(); expect(ensureCycle(o).report).toMatchObject({ ensure: "opened", reason: expect.stringContaining("no trace") });
    act(o, "record", { persona: "alpha", outcome: "ran" }); const before = bytes(o);
    expect(ensureCycle(o).report["ensure"]).toBe("present"); expect(bytes(o)).toBe(before);
  });
  it("current PR is present without creating a branch-only lock", () => {
    const o = fixture(); act({ ...o, pr: 9 }, "init");
    expect(ensureCycle({ ...o, pr: 9 }).report).toMatchObject({ ensure: "present", keyed: "pr" });
    expect(existsSync(cycleTraceLock(o.root, o.branch))).toBe(false);
    expect(ensureCycle({ ...o, pr: 10 }).code).toBe(4);
  });
  it.each(["app/feature-preflight", "app/feature-pr2-notes", "app/feature-pr", "app/feature-prx"])("sibling branch %s is no trace", (branch): void => {
    const o = fixture(roster, true); act({ ...o, branch }, "init"); expect(ensureCycle(o).report["ensure"]).toBe("opened");
  });
  it.each(["app-feature-pr1.opened", "app-feature-pr123.opened"])("exact PR marker %s reports lost", (name): void => {
    const o = fixture(roster, true); const dir = cycleTraceDir(o)!; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, name), "old");
    expect(ensureCycle(o).code).toBe(4); expect(existsSync(cyclePath(o.root, o.branch))).toBe(false);
  });
  it("a marker outlives git clean and a removed worktree", () => {
    const o = fixture(roster, true); act(o, "init"); gitRun(o.root, "clean", "-fdxq"); policy(o.root, roster);
    expect(ensureCycle(o).report["ensure"]).toBe("lost");
    const other = fixture(roster, true); gitRun(other.root, "checkout", "-q", "main");
    const wt = join(other.root, ".nen", "worktrees", "feature"); gitRun(other.root, "worktree", "add", "-q", wt, "app/feature");
    const wo = { ...other, root: wt }; act(wo, "init"); expect(ensureCycle(wo).report["ensure"]).toBe("present");
    expect(ensureCycle(other).code).toBe(4);
    gitRun(other.root, "worktree", "remove", "--force", wt); expect(ensureCycle(other).report["traces"]).toEqual(expect.arrayContaining([expect.stringContaining(".opened")]));
  });
  it("another worktree's ledger or lock is a trace even without markers", () => {
    const o = fixture(roster, true); gitRun(o.root, "checkout", "-q", "main");
    const wt = join(o.root, ".nen", "worktrees", "feature"); gitRun(o.root, "worktree", "add", "-q", wt, "app/feature");
    act({ ...o, root: wt }, "init"); rmSync(cycleTraceDir(o)!, { recursive: true });
    expect(ensureCycle(o).report["traces"]).toEqual(expect.arrayContaining([expect.stringContaining("another checkout")]));
  });
  it.each([true, false])("lock age is a lost trace only when stale=%s", (stale): void => {
    const o = fixture(); const lock = cycleTraceLock(o.root, o.branch); mkdirSync(dirname(lock), { recursive: true }); writeFileSync(lock, "");
    if (stale) { const old = new Date(Date.now() - 120_000); utimesSync(lock, old, old); }
    expect(ensureCycle(o).report["ensure"]).toBe(stale ? "lost" : "opened");
  });
  it("the removable mutex's stale age survives recovery as a lost trace", () => {
    const o = fixture(); const path = `${cyclePath(o.root, o.branch)}.lock`; mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, "crashed");
    const old = new Date(Date.now() - 120_000); utimesSync(path, old, old);
    expect(ensureCycle(o).code).toBe(4); expect(existsSync(cyclePath(o.root, o.branch))).toBe(false);
  });
  it("reports no durable trace when git common dir cannot be read", () => {
    const o = fixture(); expect(ensureCycle(o).report["note"]).toMatch(/no git common dir/);
  });
  it("PR matching uses exactly digits and literal branch text", () => {
    expect(prKeyed("app-feature-pr9.cycle.json", "app-feature", ".cycle.json")).toBe(true);
    for (const name of ["app-feature-pr9-notes.cycle.json", "app-feature-pr.cycle.json", "app-feature-prx.cycle.json"]) expect(prKeyed(name, "app-feature", ".cycle.json")).toBe(false);
    expect(cycleKey("topic/a", 12)).toBe("topic-a-pr12");
  });
});

describe("command contract and recovery authority", () => {
  it.each([false, true])("malformed ensure policy exits 2 with existing ledger=%s", async (existing): Promise<void> => {
    const o = fixture(); if (existing) act(o, "init");
    const before = existing ? bytes(o) : null;
    policy(o.root, { alpha: -1 });
    const result = await cli(o, ["ensure", "--branch", o.branch]);
    expect(result.code).toBe(2); expect(result.err).toContain("budget");
    if (existing) expect(bytes(o)).toBe(before);
    else expect(existsSync(join(o.root, ".nen", "hanten"))).toBe(false);
  });
  it.each(["zero", "0", "-1", "1.5", "9007199254740992"])("rejects PR %s before writing", async (pr): Promise<void> => {
    const o = fixture(); expect((await cli(o, ["init", "--branch", o.branch, "--pr", pr])).code).toBe(2);
  });
  it("accepts and normalizes #12 and reports JSON", async (): Promise<void> => {
    const o = fixture(); const result = await cli(o, ["init", "--branch", o.branch, "--pr", "#0012"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.out).pr).toBe(12);
  });
  it.each([
    [], ["unknown"], ["init"], ["init", "--branch", "a", "extra"], ["init", "--branch", "a", "--", "extra"],
    ["show", "--branch", "a", "--base", "main"], ["show", "--branch", "a", "--confirmed-first-cycle"],
    ["init", "--branch", "a", "--applicable", "alpha"], ["record", "--branch", "a"],
    ["recover-first", "--branch", "a"],
  ].map((args): { args: string[] } => ({ args })))("refuses invalid arguments %# without creating a trace", async ({ args }): Promise<void> => {
    const o = fixture(); expect((await cli(o, args)).code).toBe(2); expect(existsSync(join(o.root, ".nen", "hanten"))).toBe(false);
  });
  it("recover-first requires the flag and audits the opened ledger", async (): Promise<void> => {
    const o = fixture(); const result = await cli(o, ["recover-first", "--branch", o.branch, "--confirmed-first-cycle"]);
    expect(result.code).toBe(0); expect(read(o)["openedAs"]).toBe("confirmed-first-cycle-recovery");
    expect((await cli(o, ["recover-first", "--branch", o.branch, "--confirmed-first-cycle"])).code).toBe(2);
  });
  it("ensure relays present, opened, trunk and lost exit codes", async (): Promise<void> => {
    const o = fixture(roster, true);
    expect((await cli(o, ["ensure", "--branch", o.branch])).code).toBe(0);
    expect(JSON.parse((await cli(o, ["ensure", "--branch", o.branch])).out).ensure).toBe("present");
    expect((await cli(o, ["ensure", "--branch", "main"])).code).toBe(3);
    unlinkSync(cyclePath(o.root, o.branch)); expect((await cli(o, ["ensure", "--branch", o.branch])).code).toBe(4);
  });
  it("prints readable decisions and full help through the CLI entry point", async (): Promise<void> => {
    const o = fixture(); act(o, "init"); const result = await cli(o, ["decide", "--branch", o.branch, "--applicable", "alpha"], false);
    expect(result.out).toContain("alpha: 0/2 raise");
    const out: string[] = []; expect(await run(["review", "ledger", "--help"], { out: (s): void => { out.push(s); }, err: (): void => {} }, o.seams)).toBe(0);
    expect(out.join("\n")).toContain("4 ensure lost");
  });
  it.each(["..", "topic\\escape", "a\nb"])("refuses unsafe branch %s", (branch): void => {
    const o = fixture(); expect(() => act({ ...o, branch }, "init")).toThrow();
  });
  it.skipIf(process.platform === "win32")("refuses a symlinked ledger directory and lock without touching the target", () => {
    const o = fixture(), outside = fixture(); mkdirSync(join(o.root, ".nen")); symlinkSync(outside.root, join(o.root, ".nen", "hanten"));
    expect(() => act(o, "init")).toThrow(/leaves/);
    rmSync(join(o.root, ".nen", "hanten")); mkdirSync(join(o.root, ".nen", "hanten"));
    const target = join(outside.root, "untouched"); writeFileSync(target, "keep"); symlinkSync(target, cycleTraceLock(o.root, o.branch));
    expect(() => act(o, "init")).toThrow(/redirected/); expect(readFileSync(target, "utf8")).toBe("keep");
  });
});

// Separate Bun processes exercise the shipped TS modules. Bun is this lane's
// declared runtime; no undeclared minimum Node version is needed.
function child(o: CycleOptions, action: string, args: object = {}): Promise<string> {
  const module = new URL("./ledger.ts", import.meta.url).href;
  const seamsModule = new URL("../seam/exec.ts", import.meta.url).href;
  const call = action === "ensure" ? "m.ensureCycle(o)" : `m.runCycle(o,${JSON.stringify(action)},${JSON.stringify(args)})`;
  const program = `const m=await import(${JSON.stringify(module)}); const e=await import(${JSON.stringify(seamsModule)}); const o={root:${JSON.stringify(o.root)},branch:${JSON.stringify(o.branch)},seams:e.defaultSeams()};console.log(JSON.stringify(${call}));`;
  return new Promise((ok, fail): void => {
    const p = spawn("bun", ["--eval", program], { cwd: process.cwd() }); let out = "", err = "";
    p.stdout.on("data", (s): void => { out += String(s); }); p.stderr.on("data", (s): void => { err += String(s); });
    p.on("error", fail); p.on("exit", (code): void => { if (code === 0) ok(out); else fail(new Error(err)); });
  });
}
describe("cross-process concurrency", () => {
  it("concurrent records preserve both spent passes", async (): Promise<void> => {
    const o = fixture(); act(o, "init"); await Promise.all([child(o, "record", { persona: "beta", outcome: "ran" }), child(o, "record", { persona: "gamma", outcome: "ran" })]);
    expect(read(o).reviewers.beta!.used).toBe(1); expect(read(o).reviewers.gamma!.used).toBe(1);
  }, 15000);
  it("fresh ensures open exactly once and stale locks never mint a budget", async (): Promise<void> => {
    const o = fixture(); const results = await Promise.all([child(o, "ensure"), child(o, "ensure")]);
    expect(results.map((text): string => JSON.parse(text).report.ensure).sort()).toEqual(["opened", "present"]);
    const lost = { ...o, branch: "app/lost" }; const lock = cycleTraceLock(lost.root, lost.branch); writeFileSync(lock, ""); const old = new Date(Date.now() - 120000); utimesSync(lock, old, old);
    const refused = await Promise.all([child(lost, "ensure"), child(lost, "ensure")]); expect(refused.map((text): number => JSON.parse(text).code)).toEqual([4, 4]);
  }, 15000);
});
