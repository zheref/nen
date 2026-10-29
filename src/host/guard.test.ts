import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { admitConfiguredWorkload, admitWorkload, hostActivated, prepareLaunch, supervise } from "./execute.js";
import { initStore, readSlot, registerSupervisor, reserve, slots, writeClaim, type HostClaim, type HostStore } from "./store.js";
import { descendsFrom, groupMembers, ownIdentity } from "./process.js";
import type { Seams } from "../seam/exec.js";
vi.mock("./process.js", (): object => ({
  ownIdentity: vi.fn((): object => ({ pid: 100, pgid: 100, started: "synthetic" })),
  groupMembers: vi.fn((): readonly unknown[] => []),
  descendsFrom: vi.fn((): boolean => true),
  belongsToGroup: vi.fn((): boolean => false),
  snapshot: vi.fn((): readonly unknown[] => []),
}));
vi.mock("node:child_process", (): object => ({ spawnSync: vi.fn((): object => ({ status: 0, signal: null })) }));
const roots: string[] = [];
afterEach((): void => {
  vi.clearAllMocks(); vi.mocked(groupMembers).mockReturnValue([]); vi.mocked(descendsFrom).mockReturnValue(true); vi.mocked(ownIdentity).mockReturnValue({ pid: 100, pgid: 100, started: "synthetic" });
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture(): HostStore {
  const root = mkdtempSync(join(tmpdir(), "nen-host-guard-")); roots.push(root); return initStore(join(root, "budget"));
}
function finishStep(store: HostStore, state: HostClaim["state"] = "complete"): void {
  const claim = readSlot(store, 1);
  const supervisor = { pid: 200, pgid: 200, started: "supervisor" };
  registerSupervisor({ store, slot: 1, claim }, claim.launch!, supervisor);
  writeClaim({ store, slot: 1, claim }, { ...claim, state, group: supervisor });
}
function seams(store: HostStore, action: () => void): Seams {
  return {
    hostSupervisor: { exe: "/synthetic/current-runtime", argv: ["/synthetic/current-entry", "_exec"] },
    env: { NEN_HOST_STORE: store.root }, platform: "linux", now: (): Date => new Date(0),
    run: vi.fn(() => { action(); return { code: 0, stdout: "out", stderr: "", spawnFailed: false }; }),
    runInteractive: vi.fn(() => { action(); return { code: 0, signal: null, spawnFailed: false }; }),
    runStreamed: vi.fn(async () => { action(); return { code: 0, signal: null, spawnFailed: false, abandoned: false, durationMs: 0 }; }),
    probePort: async () => "refused",
  };
}
describe("host guard lifecycle with synthetic ownership", (): void => {
  it("refuses an absent entry adapter before acquiring capacity or spawning", (): void => {
    const store = fixture(); const original = seams(store, (): void => {});
    expect((): unknown => admitWorkload({ ...original, hostSupervisor: undefined }, "missing adapter")).toThrow(/entry adapter/);
    expect(slots(store)).toEqual([]); expect(original.run).not.toHaveBeenCalled();
  });
  it("stages local activation visibly and never treats an inactive launch as protected", (): void => {
    const store = fixture(); const original = seams(store, (): void => {}); const notices: string[] = [];
    const guard = admitConfiguredWorkload(original, "local test", (message): void => { notices.push(message); });
    expect(guard.seams).toBe(original); guard.finish(); expect(slots(store)).toEqual([]);
    expect(notices.join("\n")).toMatch(/admission unavailable.*serialized fallback required.*unprotected/);
    expect(hostActivated({ NEN_HOST_ADMISSION: "enabled" })).toBe(true);
    expect((): unknown => hostActivated({ NEN_HOST_ADMISSION: "enable" })).toThrow(/invalid activation/);
  });
  it("enforces an activated local guard and fails closed on absent state", (): void => {
    const store = fixture(); const original = seams(store, (): void => {});
    const guard = admitConfiguredWorkload({ ...original, env: { ...original.env, NEN_HOST_ADMISSION: "enabled" } }, "active");
    expect(slots(store)).toHaveLength(1); guard.finish();
    expect((): unknown => admitConfiguredWorkload({ ...original, env: { NEN_HOST_ADMISSION: "enabled" } }, "missing")).toThrow(/not configured/);
    expect(original.run).not.toHaveBeenCalled();
  });
  it("cannot bypass an inherited active claim by clearing activation", (): void => {
    const store = fixture(); const original = seams(store, (): void => {});
    expect((): unknown => admitConfiguredWorkload({ ...original, env: { ...original.env, NEN_HOST_CLAIM: "forged" } }, "nested")).toThrow(/incomplete inherited/);
    expect(original.run).not.toHaveBeenCalled();
  });
  it("guards captured, interactive and streamed steps and releases only after all quiesce", async (): Promise<void> => {
    const store = fixture(); const original = seams(store, (): void => finishStep(store)); const guard = admitWorkload(original, "fixture");
    expect(guard.seams.run("fixture-exe", ["argument"]).stdout).toBe("out");
    expect(guard.seams.runInteractive("fixture-exe", []).code).toBe(0);
    expect((await guard.seams.runStreamed("fixture-exe", [])).code).toBe(0);
    expect(original.run).toHaveBeenCalledWith(expect.any(String), expect.arrayContaining(["_exec", "--store", store.root, "--claim", expect.any(String), "--launch", expect.any(String), "--", "fixture-exe", "argument"]), expect.objectContaining({ detached: true, env: expect.objectContaining({ NEN_HOST_STORE: store.root }) }));
    expect(slots(store)).toHaveLength(1); guard.finish(); expect(slots(store)).toEqual([]);
  });
  it("retains the owner when a supervisor has no completion receipt", (): void => {
    const store = fixture(); const guard = admitWorkload(seams(store, (): void => finishStep(store, "unresolved")), "uncertain");
    expect((): unknown => guard.seams.run("fixture-exe", [])).toThrow(/unresolved/);
    expect((): unknown => guard.finish()).toThrow(/retains capacity/); expect(slots(store)).toHaveLength(1);
  });
  it("retains a completed claim if descendants remain or the full process snapshot cannot be read", (): void => {
    const store = fixture(); const guard = admitWorkload(seams(store, (): void => finishStep(store)), "descendants");
    vi.mocked(groupMembers).mockReturnValue([{ pid: 201, ppid: 1, pgid: 200, started: "child" }]);
    expect((): unknown => guard.seams.runInteractive("fixture-exe", [])).toThrow(/unresolved descendants/);
    expect((): unknown => guard.finish()).toThrow(); expect(slots(store)).toHaveLength(1);
  });
  it("never starts work without a configured host store", (): void => {
    const store = fixture(); const original = seams(store, (): void => {});
    expect((): unknown => admitWorkload({ ...original, env: {} }, "missing")).toThrow(/not configured/);
    expect(original.run).not.toHaveBeenCalled();
  });
  it("supervisor proves its own group and records it before starting the executable", (): void => {
    const store = fixture(); const guard = admitWorkload(seams(store, (): void => {}), "supervised"); const claim = readSlot(store, 1); const step = prepareLaunch({ store, slot: 1, claim }, "fixture-exe", []);
    expect(supervise(store.root, 1, claim.id, step.id, "fixture-exe", [])).toBe(0);
    expect(readSlot(store, 1).state).toBe("complete");
    expect((): unknown => guard.finish()).toThrow(/unresolved/); // Outer seam must also prove group exit.
  });
  it("refuses an unowned supervisor group and a changed claim before launching", (): void => {
    const store = fixture(); admitWorkload(seams(store, (): void => {}), "supervised"); const claim = readSlot(store, 1); const step = prepareLaunch({ store, slot: 1, claim }, "fixture-exe", []);
    expect((): unknown => supervise(store.root, 1, "forged", step.id, "fixture-exe", [])).toThrow(/claim changed/);
    vi.mocked(ownIdentity).mockReturnValue({ pid: 100, pgid: 99, started: "synthetic" });
    expect((): unknown => supervise(store.root, 1, claim.id, step.id, "fixture-exe", [])).toThrow(/dedicated process group/);
  });
  it("supervisor records unresolved ownership on surviving descendants or a failed ownership probe", (): void => {
    const store = fixture(); admitWorkload(seams(store, (): void => {}), "supervised"); const claim = readSlot(store, 1); const step = prepareLaunch({ store, slot: 1, claim }, "fixture-exe", []);
    vi.mocked(groupMembers).mockReturnValue([{ pid: 101, ppid: 1, pgid: 100, started: "child" }]);
    expect(supervise(store.root, 1, claim.id, step.id, "fixture-exe", [])).toBe(1); expect(readSlot(store, 1).state).toBe("unresolved");
  });
  it("binds the per-step capability to the request and exact coordinator ancestry", (): void => {
    const store = fixture(); const reservation = reserve(store, "coordinator", { pid: 100, pgid: 100, started: "synthetic" });
    const step = prepareLaunch(reservation, "fixture-exe", ["expected"]);
    expect((): unknown => supervise(store.root, 1, reservation.claim.id, step.id, "fixture-exe", ["changed"])).toThrow(/request changed/);
    vi.mocked(descendsFrom).mockReturnValue(false);
    expect((): unknown => supervise(store.root, 1, reservation.claim.id, step.id, "fixture-exe", ["expected"])).toThrow(/exact expected coordinator/);
    expect(readSlot(store, 1).state).toBe("reserved");
  });
  it("never overwrites immutable registration or accepts completion from a different group", (): void => {
    const store = fixture(); const reservation = reserve(store, "coordinator", { pid: 100, pgid: 100, started: "synthetic" });
    const step = prepareLaunch(reservation, "fixture-exe", []);
    const first = { pid: 200, pgid: 200, started: "first" };
    registerSupervisor(reservation, step, first);
    expect((): unknown => registerSupervisor(reservation, step, { pid: 201, pgid: 201, started: "replay" })).toThrow(/already consumed/);
    expect((): unknown => supervise(store.root, 1, reservation.claim.id, step.id, "fixture-exe", [])).toThrow(/already consumed/);
    expect(readSlot(store, 1).group).toBeNull();
  });

  it("rejects a completion whose group differs from the immutable registration", (): void => {
    const store = fixture();
    const guard = admitWorkload(seams(store, (): void => {
      finishStep(store);
      const current = readSlot(store, 1);
      writeClaim({ store, slot: 1, claim: current }, { ...current, group: { pid: 999, pgid: 999, started: "foreign" } });
    }), "mismatched completion");
    expect((): unknown => guard.seams.run("fixture-exe", [])).toThrow(/matching supervisor completion/);
    expect((): unknown => guard.finish()).toThrow(/retains capacity/);
  });
  it("does not let a stale earlier capability overwrite a later armed step", (): void => {
    const store = fixture(); const reservation = reserve(store, "coordinator", { pid: 100, pgid: 100, started: "synthetic" });
    const previous = prepareLaunch(reservation, "fixture-exe", []);
    const old = readSlot(store, 1); writeClaim(reservation, { ...old, launch: undefined });
    const current = prepareLaunch(reservation, "fixture-exe", []);
    expect((): unknown => supervise(store.root, 1, reservation.claim.id, previous.id, "fixture-exe", [])).toThrow(/claim changed/);
    expect(readSlot(store, 1).launch).toEqual(current);
  });

});
