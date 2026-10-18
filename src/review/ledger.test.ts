// Frozen bd6fd5ff's 79 assertions, grouped by behavior; dynamic policy and the
// explicit human migration/restoration rulings replace its built-in roster,
// Python flock and late-persona zero hydration. No Hatsu checkout is required.
import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { runFamily, type Io } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { reviewCommand } from "./command.js";
import { CYCLE_CONTRACT, cycleKey, cycleLock, cyclePath, cyclePr, cycleTraceDir, prKeyed, runCycle, type CycleAction, type CycleDocument, type CycleRequest } from "./ledger.js";

const roots: string[] = [];
afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const maxima = { nobunaga: 2, feitan: 1, chrollo: 1, phinks: 1, hisoka: 2, uvogin: 3, leorio: 1 };
const roster = Object.keys(maxima);
const branch = "test/ledger";
function policy(root: string, scopes: unknown = Object.fromEntries(Object.entries(maxima).map(([persona, budget]) => [persona, { persona, budget, tier: "deep", paths: ["**"] }])) , base?: string): void {
  mkdirSync(join(root, "nen"), { recursive: true });
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ ...(base ? { branch: { base } } : {}), review: { scopes } }));
}
function repo(): string { const root = mkdtempSync(join(tmpdir(), "nen-cycle-")); roots.push(root); policy(root); return root; }
function seams(): Seams { return new ScriptedSeams(["rev-parse --git-common-dir", "worktree list --porcelain -z", "symbolic-ref --quiet --short refs/remotes/origin/HEAD"].map((args) => ({ match: `git ${args}`, result: { code: 1, stdout: "" } })), { now: (): Date => new Date() }); }
function call(root: string, action: CycleAction, options: Partial<CycleRequest> = {}, seam = seams()): ReturnType<typeof runCycle> { return runCycle(action, { root, branch, ...options }, seam); }
function doc(root: string, br = branch, pr: string | null = null): CycleDocument { return JSON.parse(readFileSync(cyclePath(root, br, pr), "utf8")) as CycleDocument; }
function save(root: string, value: CycleDocument, br = branch, pr: string | null = null): void { writeFileSync(cyclePath(root, br, pr), JSON.stringify(value)); }
async function spend(root: string, persona: string, br = branch, pr: string | null = null): Promise<void> { await call(root, "record", { branch: br, pr, persona, outcome: "ran" }); }
async function capture(root: string, action: string, flags: readonly string[] = [], seam = seams()): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const io: Io = { out: (s): void => { out.push(s); }, err: (s): void => { err.push(s); } };
  const code = await runFamily(reviewCommand, ["review", "ledger", action, "--repo", root, "--branch", branch, "--json", ...flags], null, false, io, seam);
  return { code, out: out.join("\n"), err: err.join("\n") };
}
function git(root: string, ...args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", timeout: 10_000 });
  expect(result.status, result.stderr).toBe(0); return result.stdout.trim();
}
function gitRepo(): string {
  const root = repo(); git(root, "init", "-q", "-b", "main");
  writeFileSync(join(root, ".gitignore"), ".nen/\n");
  git(root, "add", "nen/workflow.json", ".gitignore");
  git(root, "-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "fixture");
  return root;
}

describe("frozen review-cycle budget and PR-key contract", () => {
  it("no workflow has no invented default roster (explicit dynamic-policy disposition)", async () => {
    const root = repo(); unlinkSync(join(root, "nen", "workflow.json"));
    const result = await capture(root, "init"); expect(result.code).toBe(1); expect(result.err).toContain("review.scopes"); expect(existsSync(cyclePath(root, branch))).toBe(false);
  });
  it.each(["show", "decide", "record"] as const)("refused missing %s creates no lock or ledger", async (action) => {
    const root = repo(); await expect(call(root, action)).rejects.toThrow("no ledger");
    expect(existsSync(cycleLock(root, branch))).toBe(false);
    expect((await call(root, "ensure")).document["ensure"]).toBe("opened");
  });
  it("initializes the exact contract, slug, roster and policy maxima once", async () => {
    const root = repo(); await call(root, "init"); const d = doc(root);
    expect(d.contract).toBe(CYCLE_CONTRACT); expect(d.slug).toBe("test-ledger"); expect(d.pr).toBeNull();
    expect(Object.keys(d.reviewers)).toEqual(roster);
    expect(Object.fromEntries(Object.entries(d.reviewers).map(([p, r]) => [p, r.max]))).toEqual(maxima);
    await expect(call(root, "init")).rejects.toThrow("already exists");
  });
  it("entries 1–4 retain used counts, skip exhausted reviewers, and never exceed caps", async () => {
    const root = repo(); await call(root, "init");
    const decide = async (): Promise<Record<string, unknown>> => (await call(root, "decide", { applicable: roster.join(",") })).document;
    expect((await decide())["raise"]).toEqual(roster);
    for (const p of roster) await spend(root, p);
    expect(Object.values(doc(root).reviewers).every((r) => r.used === 1)).toBe(true);
    await expect(call(root, "record", { persona: "hisoka", outcome: "skipped-exhausted" })).rejects.toThrow("still has budget");
    expect((await decide())["skippedExhausted"]).toEqual(["feitan", "chrollo", "phinks", "leorio"]);
    expect((await decide())["raise"]).toEqual(["nobunaga", "hisoka", "uvogin"]);
    await call(root, "record", { persona: "feitan", outcome: "skipped-exhausted" });
    for (const p of ["nobunaga", "hisoka", "uvogin"]) await spend(root, p);
    expect((await decide())["raise"]).toEqual(["uvogin"]);
    expect((await decide())["skippedExhausted"]).toContain("hisoka");
    expect(doc(root).reviewers["chrollo"]?.used).toBe(1);
    await spend(root, "uvogin"); expect((await decide())["raise"]).toEqual([]); expect((await decide())["skippedExhausted"]).toContain("uvogin");
    expect(Object.fromEntries(Object.entries(doc(root).reviewers).map(([p, r]) => [p, r.used]))).toEqual(maxima);
    await expect(spend(root, "chrollo")).rejects.toThrow("exhausted");
    expect(doc(root).reviewers["feitan"]?.invocations.map((i) => i["outcome"])).toEqual(["ran", "skipped-exhausted"]);
    expect(readdirSync(join(root, ".nen", "hanten")).filter((p) => p.endsWith(".tmp"))).toEqual([]);
    expect((await call(root, "show")).document["reviewers"]).toEqual(doc(root).reviewers);
  });
  it("inapplicable reviewers keep their budget for later applicability; CSV is normalized and deduplicated", async () => {
    const root = repo(); await call(root, "init");
    const first = (await call(root, "decide", { applicable: " HISOKA,hisoka,, " })).document;
    expect(first["raise"]).toEqual(["hisoka"]);
    expect((first["reviewers"] as { persona: string; action: string }[]).find((r) => r.persona === "chrollo")?.action).toBe("not-applicable");
    await spend(root, "hisoka"); expect((await call(root, "decide", { applicable: "chrollo" })).document["raise"]).toEqual(["chrollo"]);
    expect((await call(root, "decide", { applicable: "" })).document["raise"]).toEqual([]);
    expect(JSON.parse((await capture(root, "decide")).out)["raise"]).toEqual([]);
    await expect(call(root, "decide", { applicable: "invented" })).rejects.toThrow("not a declared");
  });
  it("new branch and new PR numbers are fresh efforts; same PR cannot reset", async () => {
    const root = repo(); await call(root, "init"); await spend(root, "chrollo"); const before = readFileSync(cyclePath(root, branch));
    await call(root, "init", { branch: "other/effort" });
    expect(doc(root, "other/effort").reviewers["chrollo"]?.used).toBe(0);
    await call(root, "init", { pr: "#7" }); await spend(root, "chrollo", branch, "7");
    await call(root, "init", { pr: "8" }); expect(doc(root, branch, "8").reviewers["chrollo"]?.used).toBe(0);
    expect(doc(root, branch, "7").slug).toBe("test-ledger-pr7"); expect(doc(root, branch, "7").pr).toBe(7);
    expect(readFileSync(cyclePath(root, branch))).toEqual(before);
    await expect(call(root, "init", { pr: "8" })).rejects.toThrow("already exists");
    const wrong = doc(root, branch, "7"); wrong.pr = 8; save(root, wrong, branch, "7");
    await expect(call(root, "show", { pr: "7" })).rejects.toThrow("ledger pr");
  });
  it.each(["seven", "0", "-1", "1.2", "9007199254740992", "#"])("refuses invalid PR %s", (pr) => { expect(() => cyclePr(pr)).toThrow("positive PR"); });
  it("normalizes hash-prefixed PRs and preserves exact numeric key boundaries", () => {
    expect(cyclePr(" ##0012 ")).toBe("12"); expect(cyclePr(" ")).toBeNull();
    expect(cycleKey("a/b", "12")).toBe("a-b-pr12");
    for (const name of ["x-ten-preflight.opened", "x-ten-pr2-notes.opened", "x-ten-pr.opened", "x-ten-pr2.opened.extra"]) expect(prKeyed(name, "x-ten", ".opened")).toBe(false);
    expect(prKeyed("x-ten-pr20.opened", "x-ten", ".opened")).toBe(true);
    for (const br of ["..", ".", "a\\b", "a\nb"]) expect(() => cycleKey(br)).toThrow();
  });
});

describe("repository-owned dynamic review budgets", () => {
  it("supports entirely new personas, schema defaults and zero budgets, using the minimum repeated declaration", async () => {
    const root = repo(); policy(root, {
      first: { persona: "DYNAMIC", tier: "deep", budget: 5, paths: ["**"] },
      second: { persona: "dynamic", tier: "deep", budget: 2, paths: ["**"] },
      defaulted: { persona: "custom", tier: "deep", paths: ["**"] },
      zero: { persona: "none", tier: "deep", budget: 0, paths: ["**"] },
    });
    await call(root, "init"); const d = doc(root);
    expect(Object.keys(d.reviewers)).toEqual(["dynamic", "custom", "none"]);
    expect(d.reviewers["dynamic"]?.max).toBe(2); expect(d.reviewers["custom"]?.max).toBe(1);
    expect(d.reviewers["dynamic"]?.budgetSource).toBe("nen/workflow.json review.scopes.first+second.budget (min of the scopes named)");
    expect((await call(root, "decide", { applicable: "dynamic,none" })).document).toMatchObject({ raise: ["dynamic"], skippedExhausted: ["none"] });
    await expect(spend(root, "none")).rejects.toThrow("exhausted");
  });
  it("policy changes refresh maxima without rewriting historical sources or counts on a read", async () => {
    const root = repo(); await call(root, "init"); await spend(root, "nobunaga");
    const before = readFileSync(cyclePath(root, branch));
    policy(root, { lower: { persona: "nobunaga", tier: "deep", budget: 0, paths: ["**"] } });
    const shown = (await call(root, "show")).document as unknown as CycleDocument;
    expect(shown.reviewers["nobunaga"]).toMatchObject({ max: 0, used: 1 });
    expect(shown.reviewers["chrollo"]?.max).toBe(1);
    expect(readFileSync(cyclePath(root, branch))).toEqual(before);
    await call(root, "record", { persona: "nobunaga", outcome: "skipped-exhausted" });
    expect(doc(root).reviewers["nobunaga"]?.used).toBe(1);
  });
  it("malformed target policy is a schema refusal, never a silent default budget", async () => {
    const root = repo(); policy(root, { broken: { persona: "one", tier: "deep", budget: "two", paths: ["**"] } });
    expect((await capture(root, "init")).code).toBe(2); expect(existsSync(cyclePath(root, branch))).toBe(false);
  });
});

describe("lossless legacy migration and fail-closed history", () => {
  async function legacy(root: string): Promise<CycleDocument> {
    await call(root, "init"); await spend(root, "chrollo"); const d = doc(root);
    delete d["nenCoordination"]; d["unknownMetadata"] = { important: ["retained"] };
    d.reviewers["retired"] = { max: 2, used: 1, budgetSource: "old", invocations: [{ outcome: "ran", unknown: "retained" }], custom: 42 };
    save(root, d); return d;
  }
  it("requires a deliberate stopped-writer boundary; preserves exact backup, metadata and history", async () => {
    const root = repo(); const old = await legacy(root); const bytes = readFileSync(cyclePath(root, branch));
    for (const action of ["show", "decide", "record", "ensure"] as const) await expect(call(root, action)).rejects.toThrow("Stop ALL Python writers");
    await expect(call(root, "migrate")).rejects.toThrow("--confirmed-no-legacy-writers");
    expect(readFileSync(cyclePath(root, branch))).toEqual(bytes);
    expect((await call(root, "migrate", { confirmedNoLegacyWriters: true })).document["migrated"]).toBe(true);
    expect(readFileSync(`${cyclePath(root, branch)}.legacy`)).toEqual(bytes);
    const adopted = doc(root); delete adopted["nenCoordination"]; expect(adopted).toEqual(old);
    expect((await call(root, "show")).document["unknownMetadata"]).toEqual(old["unknownMetadata"]);
    const after = readFileSync(cyclePath(root, branch));
    expect((await call(root, "migrate", { confirmedNoLegacyWriters: true })).document["migrated"]).toBe(false);
    expect(readFileSync(cyclePath(root, branch))).toEqual(after);
  });
  it.each([undefined, { personasAtOpen: roster }, { lateHydrated: ["leorio"] }, { personasAtOpen: "malformed" }])("never hydrates a missing row regardless of old stamps %j", async (stamps) => {
    const root = repo(); const old = await legacy(root); delete old.reviewers["leorio"]; delete old["personasAtOpen"]; Object.assign(old, stamps); save(root, old);
    const before = readFileSync(cyclePath(root, branch));
    await expect(call(root, "migrate", { confirmedNoLegacyWriters: true })).rejects.toThrow("missing leorio review history");
    expect(readFileSync(cyclePath(root, branch))).toEqual(before); expect(existsSync(`${cyclePath(root, branch)}.legacy`)).toBe(false);
  });
  it.each(["deleted", "recased", "hydrated-then-deleted"])("later frozen spent-row fixture: %s refuses without minting", async (mode) => {
    const root = repo(); await call(root, "init"); await spend(root, "leorio"); const d = doc(root);
    if (mode === "recased") d.reviewers["Leorio"] = d.reviewers["leorio"]!;
    if (mode === "hydrated-then-deleted") { delete d["personasAtOpen"]; d["lateHydrated"] = ["leorio"]; }
    delete d.reviewers["leorio"]; save(root, d); const before = readFileSync(cyclePath(root, branch));
    await expect(call(root, "decide", { applicable: "leorio" })).rejects.toThrow("missing leorio");
    expect(readFileSync(cyclePath(root, branch))).toEqual(before);
  });
  it("refuses re-cased and missing non-late reviewers without reconstructing rows", async () => {
    const root = repo(); const d = await legacy(root); d.reviewers["FEITAN"] = d.reviewers["feitan"]!; delete d.reviewers["feitan"]; save(root, d);
    await expect(call(root, "migrate", { confirmedNoLegacyWriters: true })).rejects.toThrow("missing feitan");
  });
  it.each([
    ["used string", { used: "one", invocations: [] }], ["negative", { used: -1, invocations: [] }],
    ["boolean", { used: true, invocations: [] }], ["fraction", { used: 0.5, invocations: [] }],
    ["ran mismatch", { used: 1, invocations: [] }], ["unaccounted ran", { used: 0, invocations: [{ outcome: "ran" }] }],
    ["bad outcome", { used: 0, invocations: [{ outcome: "other" }] }], ["bad invocation", { used: 0, invocations: [null] }],
    ["no invocations", { used: 0 }], ["null row", null],
  ])("refuses inconsistent %s history", async (_label, row) => {
    const root = repo(); await call(root, "init"); const d = doc(root); (d.reviewers as Record<string, unknown>)["leorio"] = row; save(root, d);
    const before = readFileSync(cyclePath(root, branch)); await expect(call(root, "show")).rejects.toThrow(/history|count/);
    expect(readFileSync(cyclePath(root, branch))).toEqual(before);
  });
  it.each(["contract", "branch", "pr", "slug", "reviewers", "nenCoordination"])("refuses malformed %s without replacing the file", async (field) => {
    const root = repo(); await call(root, "init"); const d = doc(root); d[field] = "wrong"; save(root, d);
    await expect(call(root, "show")).rejects.toThrow();
  });
  it("a differing backup cannot be overwritten, and malformed JSON cannot be migrated", async () => {
    const root = repo(); await legacy(root); const path = cyclePath(root, branch);
    writeFileSync(`${path}.legacy`, "original evidence");
    await expect(call(root, "migrate", { confirmedNoLegacyWriters: true })).rejects.toThrow("differs");
    expect(readFileSync(`${path}.legacy`, "utf8")).toBe("original evidence");
    writeFileSync(path, "{"); await expect(call(root, "migrate", { confirmedNoLegacyWriters: true })).rejects.toThrow("Restore the original");
  });
  it("refuses non-files before reading, including a dangling ledger link", async () => {
    const root = repo(); const path = cyclePath(root, branch); mkdirSync(path, { recursive: true });
    await expect(call(root, "show")).rejects.toThrow("regular ledger");
    if (process.platform !== "win32") {
      rmSync(path, { recursive: true }); symlinkSync(join(root, "absent"), path);
      await expect(call(root, "init")).rejects.toThrow("already exists"); await expect(call(root, "show")).rejects.toThrow("regular ledger");
    }
  });
});

describe("recovery and ensure's persistent loss evidence (HA-169)", () => {
  it("recover-first is explicitly confirmed, audited, and never overwrites a ledger", async () => {
    const root = repo(); await expect(call(root, "recover-first")).rejects.toThrow("--confirmed-first-cycle");
    expect(existsSync(cyclePath(root, branch))).toBe(false);
    await call(root, "recover-first", { confirmedFirstCycle: true });
    expect(doc(root)["openedAs"]).toBe("confirmed-first-cycle-recovery");
    await expect(call(root, "recover-first", { confirmedFirstCycle: true })).rejects.toThrow("already exists");
  });
  it.each(["main", "HEAD", "", "refs/heads/feature"])("ensure refuses trunk/not-branch %j at exit 3 without opening", async (br) => {
    const root = repo(); const result = await call(root, "ensure", { branch: br }); expect(result.code).toBe(3); expect(existsSync(cycleLock(root, br))).toBe(false);
  });
  it("resolves trunk by explicit base, declared base, origin HEAD, then main", async () => {
    const root = repo(); policy(root, undefined, "trunk"); expect((await call(root, "ensure", { branch: "trunk" })).code).toBe(3);
    expect((await call(root, "ensure", { branch: "develop", base: "develop" })).code).toBe(3);
    policy(root);
    const scripted = new ScriptedSeams([{ match: "git symbolic-ref --quiet --short refs/remotes/origin/HEAD", result: { code: 0, stdout: "origin/develop\n" } }]);
    expect((await call(root, "ensure", { branch: "develop" }, scripted)).code).toBe(3);
  });
  it("opens an app-created branch, is byte-idempotent, preserves spent Breath ledger", async () => {
    const root = repo(); expect((await call(root, "ensure")).document).toMatchObject({ ensure: "opened", reason: "no trace of an earlier ledger was found" });
    await spend(root, "nobunaga"); const before = readFileSync(cyclePath(root, branch));
    expect((await call(root, "ensure")).document["ensure"]).toBe("present"); expect(readFileSync(cyclePath(root, branch))).toEqual(before);
  });
  it("uses current PR's ledger without creating a branch lock; another PR is a loss trace", async () => {
    const root = repo(); await call(root, "init", { pr: "9" });
    expect((await call(root, "ensure", { pr: "9" })).document).toMatchObject({ ensure: "present", keyed: "pr" });
    expect(existsSync(cycleLock(root, branch))).toBe(false);
    expect((await call(root, "ensure", { pr: "10" })).code).toBe(4); expect(existsSync(cyclePath(root, branch))).toBe(false);
  });
  it.each(["test/ledger-preflight", "test/ledger-pr2-notes", "test/ledger-pr", "test/ledger-pr2x"])("longer branch %s is never another PR's trace", async (sibling) => {
    const root = repo(); await call(root, "init", { branch: sibling });
    expect((await call(root, "ensure")).document["ensure"]).toBe("opened");
  });
  it("reports stale lock loss repeatedly without touching its inode or mtime; confirmed first-cycle is the only recovery", async () => {
    const root = repo(); const lock = cycleLock(root, branch); mkdirSync(join(root, ".nen", "hanten"), { recursive: true }); writeFileSync(lock, "evidence");
    const old = new Date(Date.now() - 90_000); utimesSync(lock, old, old); const before = statSync(lock);
    for (let i = 0; i < 3; i++) expect((await call(root, "ensure")).code).toBe(4);
    expect(statSync(lock).mtimeMs).toBe(before.mtimeMs); expect(statSync(lock).ino).toBe(before.ino); expect(readFileSync(lock, "utf8")).toBe("evidence");
    await expect(call(root, "init")).rejects.toThrow("opened before");
    await call(root, "recover-first", { confirmedFirstCycle: true }); expect(doc(root)["openedAs"]).toBe("confirmed-first-cycle-recovery");
  });
  it("no-git opening explicitly names the missing durable trace", async () => {
    const root = repo(); expect((await call(root, "ensure")).document["note"]).toContain("no durable trace");
  });
  it("git-common-dir markers survive removal of all .nen data and prohibit init/reset", async () => {
    const root = gitRepo(); const real = defaultSeams(); await call(root, "ensure", {}, real); await call(root, "record", { persona: "phinks", outcome: "ran" }, real);
    const dir = cycleTraceDir(real, root)!; expect(existsSync(join(dir, `${cycleKey(branch)}.opened`))).toBe(true);
    rmSync(join(root, ".nen"), { recursive: true });
    expect((await call(root, "ensure", {}, real)).code).toBe(4);
    await expect(call(root, "init", {}, real)).rejects.toThrow("opened before");
  });
  it("confirmed recovery refuses a non-file marker without publishing a new ledger", async () => {
    const root = gitRepo(), real = defaultSeams(), dir = cycleTraceDir(real, root)!;
    mkdirSync(join(dir, `${cycleKey(branch)}.opened`), { recursive: true });
    await expect(call(root, "recover-first", { confirmedFirstCycle: true }, real)).rejects.toThrow("not a regular file");
    expect(existsSync(cyclePath(root, branch))).toBe(false);
  });
  it("common markers distinguish exact PR keys from sibling branch prefixes", async () => {
    const root = gitRepo(); const real = defaultSeams(); const dir = cycleTraceDir(real, root)!; mkdirSync(dir, { recursive: true });
    for (const key of ["test-ledger-preflight", "test-ledger-pr2-notes"]) writeFileSync(join(dir, `${key}.opened`), "older");
    expect((await call(root, "ensure", {}, real)).code).toBe(0);
    const other = "other/key"; writeFileSync(join(dir, `${cycleKey(other)}-pr12.opened`), "older");
    expect((await call(root, "ensure", { branch: other }, real)).code).toBe(4);
  });
  it("worktree traces survive removal and do not confuse sibling ledgers, including paths with newlines", async () => {
    const root = gitRepo(); const real = defaultSeams(); const wt = join(root, process.platform === "win32" ? "other checkout" : "other\ncheckout");
    git(root, "worktree", "add", "-qb", "fixture/other", wt); policy(wt);
    // No durable markers: prove discovery of another checkout's exact ledger/lock.
    await call(wt, "init", {}, seams());
    expect((await call(wt, "ensure", {}, real)).document["ensure"]).toBe("present");
    expect((await call(root, "ensure", {}, real)).document["traces"]).toEqual(expect.arrayContaining([expect.stringContaining("another checkout")]));
    await call(wt, "show", {}, real); // take a real common-dir read for marker creation below
    const dir = cycleTraceDir(real, root)!; mkdirSync(dir, { recursive: true }); writeFileSync(join(dir, `${cycleKey(branch)}.opened`), "opened elsewhere");
    git(root, "worktree", "remove", "--force", wt);
    expect((await call(root, "ensure", {}, real)).code).toBe(4);
    const siblingWt = join(root, "sibling"); git(root, "worktree", "add", "-qb", "fixture/sibling", siblingWt); policy(siblingWt);
    await call(siblingWt, "init", { branch: "prefix/key-pr2-notes" }, seams());
    expect((await call(root, "ensure", { branch: "prefix/key" }, real)).document["ensure"]).toBe("opened");
  });
  it("resolves relative common-dir answers and refuses multiline answers as an absent trace", () => {
    const root = repo();
    expect(cycleTraceDir(new ScriptedSeams([{ match: "git rev-parse --git-common-dir", result: { code: 0, stdout: ".git\n" } }]), root)).toBe(join(root, ".git", "hatsu", "hanten"));
    expect(cycleTraceDir(new ScriptedSeams([{ match: "git rev-parse --git-common-dir", result: { code: 0, stdout: ".git\nother\n" } }]), root)).toBeNull();
  });
});

describe("ledger CLI strict flags, outcomes, help and exit codes", () => {
  it("CLI init/decide/record/show and ensure --pr produce machine documents", async () => {
    const root = repo(); expect((await capture(root, "init", ["--pr", "9"])).code).toBe(0);
    expect(JSON.parse((await capture(root, "ensure", ["--pr", "9"])).out)).toMatchObject({ ensure: "present", keyed: "pr" });
    expect((await capture(root, "record", ["--pr", "9", "--persona", "chrollo", "--outcome", "ran"])).code).toBe(0);
    expect(JSON.parse((await capture(root, "decide", ["--pr", "9", "--applicable", "chrollo"])).out)).toMatchObject({ raise: [], skippedExhausted: ["chrollo"] });
    expect(JSON.parse((await capture(root, "show", ["--pr", "9"])).out)["pr"]).toBe(9);
  });
  it.each([
    ["show", ["--base", "main"]], ["init", ["--applicable", "a"]], 
    ["record", []], ["init", ["--confirmed-first-cycle"]], ["init", ["--confirmed-no-legacy-writers"]],
    ["recover-first", []], ["migrate", []], ["bad", []], ["show", ["extra"]], ["init", ["--mispelled"]],
  ] as const)("refuses %s %j at exit 2 before creating a ledger", async (action, flags) => {
    const root = repo(); expect((await capture(root, action, flags)).code).toBe(2); expect(existsSync(cyclePath(root, branch))).toBe(false);
  });
  it("help explains migration, restoration, all actions and exits", async () => {
    const root = repo(); const out = await capture(root, "show", ["--help"]); expect(out.code).toBe(0);
    for (const term of ["recover-first", "migrate", "Nen", "Python", "never reset", "3 trunk", "4 lost"]) expect(out.out).toContain(term);
  });
  it("scopes refuses ledger flags instead of ignoring them", async () => {
    const out: string[] = []; const io: Io = { out: (): void => {}, err: (s): void => { out.push(s); } };
    expect(await runFamily(reviewCommand, ["review", "scopes", "--persona", "one"], null, false, io, seams())).toBe(2);
    expect(out.join("\n")).toContain("only accepts");
  });
});

describe("POSIX special-file regression", () => {
  it.skipIf(process.platform === "win32")("a FIFO ledger refuses in a bounded real subprocess instead of hanging", () => {
    const root = repo(); const path = cyclePath(root, branch); mkdirSync(join(root, ".nen", "hanten"), { recursive: true });
    const fifo = spawnSync("mkfifo", [path], { encoding: "utf8", timeout: 2_000 }); expect(fifo.status, fifo.stderr).toBe(0);
    const result = spawnSync("bun", [join(process.cwd(), "src", "index.ts"), "review", "ledger", "show", "--branch", branch, "--repo", root], { encoding: "utf8", timeout: 5_000 });
    expect(result.error).toBeUndefined(); expect(result.signal).toBeNull(); expect(result.status).toBe(2); expect(result.stderr).toContain("regular ledger file");
  });
});
