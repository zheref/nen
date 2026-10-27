import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAIM_ENV, HOST_STORE_ENV, inheritedClaim, SLOT_ENV } from "./execute.js";
import { initStore, registerSupervisor, reserve, writeClaim } from "./store.js";
import type { HostProcess } from "./process.js";
const roots: string[] = [];
afterEach((): void => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture(): { env: Record<string, string>; rows: readonly HostProcess[]; reservation: ReturnType<typeof reserve> } {
  const directory = mkdtempSync(join(tmpdir(), "nen-host-inherited-")); roots.push(directory);
  const store = initStore(join(directory, "budget"));
  const root = { pid: 100, ppid: 1, pgid: 100, started: "root" };
  const rows = [root, { pid: process.pid, ppid: 100, pgid: 100, started: "nested" }];
  const reservation = reserve(store, "outer workload", root);
  const launch = { id: "00000000-0000-4000-8000-000000000001", digest: "0".repeat(64) };
  registerSupervisor(reservation, launch, root);
  writeClaim(reservation, { ...reservation.claim, state: "running", group: root, launch });
  return { env: { [HOST_STORE_ENV]: store.root, [CLAIM_ENV]: reservation.claim.id, [SLOT_ENV]: "1" }, rows, reservation };
}
describe("inherited host ownership", (): void => {
  it("distinguishes a fresh request from an inherited claim", (): void => { expect(inheritedClaim({})).toBeNull(); });
  it("accepts a real nested descendant without allocating a second slot", (): void => {
    const { env, rows, reservation } = fixture();
    expect(inheritedClaim(env, (): readonly HostProcess[] => rows)?.claim.id).toBe(reservation.claim.id);
  });
  it("refuses incomplete, forged and stale inherited tokens instead of falling back to a fresh admission", (): void => {
    const { env, rows, reservation } = fixture();
    expect((): unknown => inheritedClaim({ [CLAIM_ENV]: "x" }, (): readonly HostProcess[] => rows)).toThrow(/incomplete/);
    expect((): unknown => inheritedClaim({ ...env, [CLAIM_ENV]: "forged" }, (): readonly HostProcess[] => rows)).toThrow(/does not own/);
    writeClaim(reservation, { ...reservation.claim, state: "complete" });
    expect((): unknown => inheritedClaim(env, (): readonly HostProcess[] => rows)).toThrow(/does not own/);
  });
  it("refuses wrong groups, unrelated same-group processes and unreadable ownership", (): void => {
    const { env, rows } = fixture();
    expect((): unknown => inheritedClaim(env, (): readonly HostProcess[] => [rows[0]!, { ...rows[1]!, pgid: 900 }])).toThrow(/does not own/);
    expect((): unknown => inheritedClaim(env, (): readonly HostProcess[] => [rows[0]!, { ...rows[1]!, ppid: 1 }])).toThrow(/does not own/);
    expect((): unknown => inheritedClaim(env, (): never => { throw new Error("denied"); })).toThrow(/denied/);
  });
});
