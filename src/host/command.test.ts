import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { run } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
const roots: string[] = [];
afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
async function capture(argv: readonly string[], env: Readonly<Record<string, string | undefined>> = {}): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await run(["host", ...argv], { out: (text): void => { out.push(text); }, err: (text): void => { err.push(text); } }, new ScriptedSeams([], { env }));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
describe("host CLI contract", (): void => {
  it("provisions only when explicitly asked and returns the same host budget through status", async (): Promise<void> => {
    const directory = mkdtempSync(join(tmpdir(), "nen-host-command-")); roots.push(directory); const store = join(directory, "budget");
    const init = await capture(["init", "--store", store, "--json"]);
    expect(init.code, init.err).toBe(0); expect(JSON.parse(init.out).config.capacity).toBe(1);
    const status = await capture(["status", "--json"], { NEN_HOST_STORE: store });
    expect(status.code, status.err).toBe(0); expect(JSON.parse(status.out).owners).toEqual([]);
    expect(JSON.parse(status.out).config.hostId).toBe(JSON.parse(init.out).config.hostId);
    expect((await capture(["init", "--store", store])).code).toBe(1);
  });
  it("refuses absent state and unsupported flags without running a workload", async (): Promise<void> => {
    expect((await capture(["status"])).err).toMatch(/missing/);
    expect((await capture(["status", "--capacity", "2"])).code).toBe(2);
    expect((await capture(["init", "--store", "/unused", "--capacity", "0"])).code).toBe(2);
    expect((await capture(["run", "command-before-separator"])).code).toBe(2);
    expect((await capture(["run", "--json", "--", "anything"])).code).toBe(2);
    expect((await capture(["run"])).code).toBe(2);
    expect((await capture(["_exec", "--slot", "0", "--claim", "x", "--", "anything"])).code).toBe(2);
    expect((await capture(["status", "--", "anything"])).code).toBe(2);
  });
  it("describes shared provisioning, nested validation, refusal and containment limits", async (): Promise<void> => {
    const result = await capture(["--help"]); expect(result.code).toBe(0);
    for (const text of ["NEN_HOST_STORE", "capacity 1", "wait 0ms", "coordinator", "Windows", "escaping"]) expect(result.out).toContain(text);
  });
});
