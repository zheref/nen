import { afterEach, describe, expect, it } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { defaultSeams } from "../seam/exec.js";
import { cycleLock, cyclePath, runCycle } from "./ledger.js";
import { cycleMutexPath, withCycleMutex } from "./ledger-lock.js";

const roots: string[] = [], children: ChildProcess[] = [];
afterEach(async (): Promise<void> => {
  for (const child of children.splice(0)) if (child.exitCode === null && child.signalCode === null) { child.kill("SIGKILL"); await new Promise<void>((done) => child.once("exit", () => done())); }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "nen ledger mutex ")); roots.push(root); mkdirSync(join(root, "nen"));
  writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ review: { scopes: { one: { persona: "custom", tier: "deep", budget: 2, paths: ["**"] } } } }));
  return root;
}
const branch = "fixture/mutex";
async function until(predicate: () => boolean): Promise<void> {
  const end = performance.now() + 5_000;
  while (!predicate()) { if (performance.now() >= end) throw new Error("bounded worker handshake timed out"); await new Promise<void>((r) => setTimeout(r, 10)); }
}
function worker(root: string, mode: string, id: string): { child: ChildProcess; result: Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string; out: string }> } {
  const path = join(root, "worker.ts");
  writeFileSync(path, `
import {existsSync,writeFileSync} from "node:fs";
import {withCycleMutex} from ${JSON.stringify(pathToFileURL(resolve("src/review/ledger-lock.ts")).href)};
import {runCycle,cycleLock} from ${JSON.stringify(pathToFileURL(resolve("src/review/ledger.ts")).href)};
import {defaultSeams} from ${JSON.stringify(pathToFileURL(resolve("src/seam/exec.ts")).href)};
const [root,mode,id]=process.argv.slice(2);
writeFileSync(root+"/attempt-"+id,"attempt");
if(mode==="hold") await withCycleMutex(cycleLock(root,${JSON.stringify(branch)}),async()=>{
 writeFileSync(root+"/ready-"+id,"owned");
 const deadline=performance.now()+10000;
 while(!existsSync(root+"/release-"+id)){if(performance.now()>deadline)throw Error("holder timeout");await new Promise(r=>setTimeout(r,10));}
 if(existsSync(root+"/payload")) writeFileSync(root+"/"+${JSON.stringify(`.nen/hanten/${branch.replaceAll("/", "-")}.cycle.json`)},await Bun.file(root+"/payload").text());
});
else {const result=await runCycle(mode,{root,branch:${JSON.stringify(branch)},persona:"custom",outcome:"ran"},defaultSeams());console.log(JSON.stringify(result));}
`);
  const child = spawn("bun", [path, root, mode, id], { stdio: ["ignore", "pipe", "pipe"] }); children.push(child);
  let out = ""; child.stdout?.on("data", (chunk: Buffer): void => { out += chunk.toString(); });
  let err = ""; child.stderr?.on("data", (chunk: Buffer): void => { err += chunk.toString(); });
  const result = new Promise<{ code: number | null; signal: NodeJS.Signals | null; err: string; out: string }>((done, reject) => {
    child.once("error", reject); child.once("exit", (code, signal): void => done({ code, signal, err, out }));
  });
  return { child, result };
}

describe("Nen-only mutex: never shared with Python and never broken by age", () => {
  it("serializes callers in the same process and releases after ordinary exceptions", async () => {
    const root = repo(), lock = cycleLock(root, branch); const order: string[] = [];
    let release!: () => void;
    const held = withCycleMutex(lock, async (): Promise<void> => { order.push("first"); await new Promise<void>((r) => { release = r; }); order.push("released"); });
    const waiting = withCycleMutex(lock, (): void => { order.push("second"); });
    expect(order).toEqual(["first"]); release(); await Promise.all([held, waiting]); expect(order).toEqual(["first", "released", "second"]);
    await expect(withCycleMutex(lock, (): never => { throw Error("operation failed"); })).rejects.toThrow("operation failed");
    expect(existsSync(cycleMutexPath(lock))).toBe(false); await withCycleMutex(lock, (): void => {});
  });
  it("does not reap an old mutex; refusal retains every ownership and lock-age byte", async () => {
    const root = repo(), lock = cycleLock(root, branch), mutex = cycleMutexPath(lock); mkdirSync(mutex, { recursive: true });
    writeFileSync(join(mutex, "owner-evidence"), "do not delete"); writeFileSync(lock, "legacy witness");
    const old = new Date(Date.now() - 86_400_000); utimesSync(mutex, old, old); utimesSync(lock, old, old);
    const before = statSync(lock);
    await expect(withCycleMutex(lock, (): never => { throw Error("must not enter"); }, 20)).rejects.toThrow("No lock is removed by age");
    expect(readFileSync(join(mutex, "owner-evidence"), "utf8")).toBe("do not delete");
    expect(statSync(lock).mtimeMs).toBe(before.mtimeMs); expect(statSync(lock).ino).toBe(before.ino);
  });
  it("refuses a non-regular persistent lock instead of truncating or blocking on it", async () => {
    const root = repo(), lock = cycleLock(root, branch); mkdirSync(lock, { recursive: true });
    await expect(withCycleMutex(lock, (): void => {})).rejects.toThrow("not a regular lock"); expect(existsSync(cycleMutexPath(lock))).toBe(false);
  });
  it("two independent writers wait on an established owner, then both actual RMW records land", async () => {
    const root = repo(); await runCycle("init", { root, branch }, defaultSeams());
    const holder = worker(root, "hold", "owner"); await until(() => existsSync(join(root, "ready-owner")));
    const a = worker(root, "record", "a"), b = worker(root, "record", "b");
    await until(() => existsSync(join(root, "attempt-a")) && existsSync(join(root, "attempt-b")));
    expect(a.child.exitCode).toBeNull(); expect(b.child.exitCode).toBeNull();
    const before = JSON.parse(readFileSync(cyclePath(root, branch), "utf8")) as { reviewers: { custom: { used: number } } }; expect(before.reviewers.custom.used).toBe(0);
    writeFileSync(join(root, "release-owner"), "release");
    for (const result of await Promise.all([holder.result, a.result, b.result])) expect(result, result.err).toMatchObject({ code: 0, signal: null });
    const result = await runCycle("show", { root, branch }, defaultSeams());
    expect((result.document["reviewers"] as Record<string, unknown>)["custom"]).toMatchObject({ used: 2, invocations: [{ outcome: "ran" }, { outcome: "ran" }] });
    expect(existsSync(cycleMutexPath(cycleLock(root, branch)))).toBe(false);
  }, 15_000);
  it("interruption leaves ownership evidence and cannot silently create a fresh budget", async () => {
    const root = repo(), lock = cycleLock(root, branch); const holder = worker(root, "hold", "interrupted");
    await until(() => existsSync(join(root, "ready-interrupted"))); const evidence = readdirSync(cycleMutexPath(lock)); expect(evidence).toHaveLength(1);
    holder.child.kill("SIGKILL"); await holder.result;
    expect(readdirSync(cycleMutexPath(lock))).toEqual(evidence);
    await expect(runCycle("ensure", { root, branch }, defaultSeams())).rejects.toThrow("remains held");
    expect(existsSync(cyclePath(root, branch))).toBe(false); expect(readdirSync(cycleMutexPath(lock))).toEqual(evidence);
  }, 10_000);
  it.each([false, true])("ensure waits for a Nen in-flight owner and re-reads its ledger (writes=%s)", async (writes) => {
    const root = repo();
    if (writes) {
      await runCycle("init", { root, branch }, defaultSeams()); writeFileSync(join(root, "payload"), readFileSync(cyclePath(root, branch)));
      unlinkSync(cyclePath(root, branch));
      // Use no-git fixture for ensure, so this case isolates in-flight locking.
    }
    const held = worker(root, "hold", "inflight"); await until(() => existsSync(join(root, "ready-inflight")));
    const waiter = worker(root, "ensure", "ensure"); await until(() => existsSync(join(root, "attempt-ensure")));
    expect(waiter.child.exitCode).toBeNull(); writeFileSync(join(root, "release-inflight"), "release");
    expect((await held.result).code).toBe(0); const result = await waiter.result; expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out)["document"]["ensure"]).toBe(writes ? "present" : "opened");
    expect(existsSync(cyclePath(root, branch))).toBe(true);
  }, 10_000);
  it("stale and fresh ensure races preserve the original thirty-trial contract", async () => {
    for (let trial = 0; trial < 30; trial++) {
      const root = repo(), staleBranch = `stale/${trial}`, lock = cycleLock(root, staleBranch); mkdirSync(dirname(lock), { recursive: true }); writeFileSync(lock, "old");
      const old = new Date(Date.now() - 90_000); utimesSync(lock, old, old);
      const stale = await Promise.all([runCycle("ensure", { root, branch: staleBranch }, defaultSeams()), runCycle("ensure", { root, branch: staleBranch }, defaultSeams())]);
      expect(stale.map((r) => r.code)).toEqual([4, 4]); expect(existsSync(cyclePath(root, staleBranch))).toBe(false);
      const fresh = await Promise.all([runCycle("ensure", { root, branch: `fresh/${trial}` }, defaultSeams()), runCycle("ensure", { root, branch: `fresh/${trial}` }, defaultSeams())]);
      expect(fresh.map((r) => r.document["ensure"]).sort()).toEqual(["opened", "present"]); expect(fresh.map((r) => r.code)).toEqual([0, 0]);
    }
  });
});
