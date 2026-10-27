import { afterEach, describe, expect, it } from "vitest";
import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { initStore, readRegistration, readSlot, reserve, slots } from "./store.js";
import { prepareLaunch } from "./execute.js";
import { groupMembers, ownIdentity } from "./process.js";
const fixtures: string[] = [];
afterEach((): void => { for (const root of fixtures.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): ReturnType<typeof initStore> {
  const directory = mkdtempSync(join(tmpdir(), "nen-host-integration-")); fixtures.push(directory);
  return initStore(join(directory, "budget"));
}
const contender = fileURLToPath(new URL("./fixtures/contender.ts", import.meta.url));
const race = fileURLToPath(new URL("./fixtures/supervisor-race.ts", import.meta.url));
const entry = fileURLToPath(new URL("./entry.ts", import.meta.url));
function syntheticEnv(): NodeJS.ProcessEnv {
  // These tiny fixtures prove independent sessions against their own temp
  // budget; they never reuse or mutate a real CI/interactive store.
  const env = { ...process.env };
  delete env.NEN_HOST_CLAIM; delete env.NEN_HOST_SLOT;
  return env;
}
function lineQueue(child: ChildProcessWithoutNullStreams): () => Promise<string> {
  let buffer = ""; const ready: string[] = []; const pending: ((line: string) => void)[] = [];
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string): void => {
    buffer += chunk;
    let end: number;
    while ((end = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
      const receive = pending.shift(); if (receive === undefined) ready.push(line); else receive(line);
    }
  });
  child.once("close", (): void => { for (const receive of pending.splice(0)) receive("closed"); });
  return (): Promise<string> => {
    const line = ready.shift(); if (line !== undefined) return Promise.resolve(line);
    return new Promise<string>((resolve): void => { pending.push(resolve); });
  };
}
describe("host admission synthetic process fixtures", (): void => {
  it("AC1/SC1: two sessions compete for capacity one and at most one is admitted", async (): Promise<void> => {
    const store = fixture();
    const children = ["repository-A/session-A", "repository-B/CI"].map((owner): ChildProcessWithoutNullStreams => spawn("bun", [contender, store.root, owner], { stdio: "pipe" }));
    const closed = children.map((child): Promise<void> => new Promise((resolve): void => { child.once("close", (): void => resolve()); }));
    const next = children.map(lineQueue);
    try {
      expect(await Promise.all(next.map((read): Promise<string> => read()))).toEqual(["ready", "ready"]);
      for (const child of children) child.stdin.write("request\n");
      const verdicts = await Promise.all(next.map((read): Promise<string> => read()));
      expect(verdicts.filter((value): boolean => value === "admitted")).toHaveLength(1);
      expect(verdicts.filter((value): boolean => value.startsWith("refused:"))).toHaveLength(1);
      expect(slots(store)).toHaveLength(1);
      expect(verdicts.find((value): boolean => value.startsWith("refused:"))).toMatch(/repository-[AB]|unresolved/);
    } finally {
      for (const child of children) child.stdin.end("finish\n");
      await Promise.all(closed);
    }
  }, 10_000);
  it.skipIf(process.platform === "win32")("F1: barrier-replayed supervisors launch exactly one executable and preserve its immutable owner", async (): Promise<void> => {
    const store = fixture(); const marker = join(store.root, "payload.txt");
    const reservation = reserve(store, "barrier coordinator", ownIdentity());
    const args = ["-e", "require('node:fs').appendFileSync(process.argv[1], 'launched\\n')", marker];
    const step = prepareLaunch(reservation, "bun", args);
    const children = [0, 1].map((): ChildProcessWithoutNullStreams => spawn("bun", [race, store.root, "1", reservation.claim.id, step.id, marker], { stdio: "pipe", detached: true, env: syntheticEnv() }));
    const closed = children.map((child): Promise<number | null> => new Promise((resolve): void => { child.once("close", resolve); }));
    const next = children.map(lineQueue);
    // EOF releases a stranded synthetic barrier without signalling or leaving
    // a process behind, even when an assertion or startup fails.
    const deadline = setTimeout((): void => { for (const child of children) child.stdin.end(); }, 5_000);
    try {
      expect(await Promise.all(next.map((read): Promise<string> => read()))).toEqual(["ready", "ready"]);
      for (const child of children) child.stdin.write("go");
      const outcomes = await Promise.all(closed);
      expect(outcomes.filter((code): boolean => code === 0)).toHaveLength(1);
      expect(outcomes.filter((code): boolean => code === 1)).toHaveLength(1);
      expect(readFileSync(marker, "utf8")).toBe("launched\n");
      const registration = readRegistration(reservation, step); const claim = readSlot(store, 1);
      expect(claim.state).toBe("complete"); expect(claim.group).toEqual(registration.supervisor);
      expect(children.map((child): number | undefined => child.pid)).toContain(registration.supervisor.pid);
      expect(groupMembers(registration.supervisor)).toEqual([]);
    } finally {
      clearTimeout(deadline); for (const child of children) child.stdin.end(); await Promise.all(closed);
    }
  }, 10_000);
  it.skipIf(process.platform === "win32")("AC4: nested admission validates and reuses one descendant workload without deadlock", (): void => {
    const store = fixture();
    const result = spawnSync("bun", [entry, "run", "--store", store.root, "--", "bun", entry, "run", "--", "bun", "-e", "console.log('nested workload ran')"], { encoding: "utf8", timeout: 10_000, env: syntheticEnv() });
    expect(result.error).toBeUndefined(); expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("nested workload ran");
    expect(slots(store)).toEqual([]);
  });
  it("AC5: absent host state refuses before the requested executable runs", (): void => {
    const root = mkdtempSync(join(tmpdir(), "nen-host-missing-")); fixtures.push(root);
    const result = spawnSync("bun", [entry, "run", "--store", join(root, "absent"), "--", "bun", "-e", "console.log('UNSAFE-LAUNCH')"], { encoding: "utf8", timeout: 10_000, env: syntheticEnv() });
    expect(result.status).not.toBe(0); expect(result.stdout).not.toContain("UNSAFE-LAUNCH");
    expect(result.stderr).toMatch(/cannot read|process-group provider/);
  });
});
