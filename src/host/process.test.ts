import { describe, expect, it } from "vitest";
import { belongsToGroup, descendsFrom, groupMembers, ownIdentity, parseProcesses, type HostProcess } from "./process.js";
const rows: readonly HostProcess[] = [
  { pid: 10, ppid: 1, pgid: 10, started: "Mon Oct 26 10:00:00 2026" },
  { pid: 11, ppid: 10, pgid: 10, started: "Mon Oct 26 10:00:01 2026" },
  { pid: 12, ppid: 11, pgid: 10, started: "Mon Oct 26 10:00:02 2026" },
  { pid: 50, ppid: 1, pgid: 50, started: "Mon Oct 26 10:00:03 2026" },
];
describe("host process-group evidence", (): void => {
  it("parses full POSIX process identities including a stable start stamp", (): void => {
    expect(parseProcesses(" 10 1 10 Mon Oct 26 10:00:00 2026\n")).toEqual([rows[0]]);
  });
  it("refuses empty, malformed and duplicate process evidence", (): void => {
    for (const text of ["", "bad", "1 x 1 date", "1 0 1 date\n1 0 1 date", "9007199254740992 0 1 date"]) expect((): unknown => parseProcesses(text)).toThrow(/snapshot/);
  });
  it("keeps orphan group descendants attributed even after the leader vanished", (): void => {
    expect(groupMembers(rows[0]!, (): readonly HostProcess[] => [{ ...rows[2]!, ppid: 1 }])).toHaveLength(1);
    expect(groupMembers(rows[0]!, (): readonly HostProcess[] => rows, rows[0])).toHaveLength(2);
  });
  it("never mistakes an unreadable snapshot or reused leader PID for quiescence", (): void => {
    expect((): unknown => groupMembers(rows[0]!, (): never => { throw new Error("denied"); })).toThrow(/denied/);
    expect((): unknown => groupMembers(rows[0]!, (): readonly HostProcess[] => [{ ...rows[0]!, started: "reused" }])).toThrow(/reused/);
  });
  it("accepts nested descendants only when both group and ancestry match", (): void => {
    expect(belongsToGroup(rows[0]!, rows[2]!, (): readonly HostProcess[] => rows)).toBe(true);
    expect(belongsToGroup(rows[0]!, rows[3]!, (): readonly HostProcess[] => rows)).toBe(false);
    expect(belongsToGroup(rows[0]!, { ...rows[3]!, pgid: 10 }, (): readonly HostProcess[] => [...rows, { ...rows[3]!, pid: 51, pgid: 10 }])).toBe(false);
    expect(belongsToGroup(rows[0]!, rows[2]!, (): readonly HostProcess[] => rows.slice(1))).toBe(false);
  });
  it("refuses an unrecorded own identity and never substitutes a PID-only identity", (): void => {
    expect(ownIdentity((): readonly HostProcess[] => rows, 12)).toEqual({ pid: 12, pgid: 10, started: rows[2]!.started });
    expect((): unknown => ownIdentity((): readonly HostProcess[] => rows, 99)).toThrow(/identity/);
  });
  it("binds a detached supervisor to its exact coordinator ancestry without requiring the same group", (): void => {
    const detached = { ...rows[1]!, pgid: 11 };
    expect(descendsFrom(rows[0]!, detached, (): readonly HostProcess[] => [rows[0]!, detached])).toBe(true);
    expect(descendsFrom({ ...rows[0]!, started: "reused coordinator" }, detached, (): readonly HostProcess[] => [rows[0]!, detached])).toBe(false);
    const unrelated = { ...detached, ppid: 1 };
    expect(descendsFrom(rows[0]!, unrelated, (): readonly HostProcess[] => [rows[0]!, unrelated])).toBe(false);
  });

});
