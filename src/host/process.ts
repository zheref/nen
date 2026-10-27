// POSIX process-group evidence. Failure to read the whole snapshot is UNKNOWN,
// never an empty group. No kill-by-name, PID expiry or pressure heuristics.
import { spawnSync } from "node:child_process";
import { HostRefusal, type ProcessIdentity } from "./store.js";
export interface HostProcess extends ProcessIdentity { readonly ppid: number }
export type Snapshot = () => readonly HostProcess[];
export function parseProcesses(text: string): readonly HostProcess[] {
  const rows = text.trim().split("\n").filter((line): boolean => line.trim() !== "");
  if (rows.length === 0) throw new HostRefusal("process snapshot was empty; ownership is unresolved");
  const seen = new Set<number>();
  return rows.map((line): HostProcess => {
    const match = /^\s*([0-9]+)\s+([0-9]+)\s+([0-9]+)\s+(.+?)\s*$/.exec(line);
    if (match === null) throw new HostRefusal("process snapshot is malformed; ownership is unresolved");
    const pid = Number(match[1]); const ppid = Number(match[2]); const pgid = Number(match[3]);
    if (![pid, ppid, pgid].every(Number.isSafeInteger) || pid < 1 || ppid < 0 || pgid < 0 || seen.has(pid)) throw new HostRefusal("process snapshot has invalid or repeated identities; ownership is unresolved");
    seen.add(pid);
    return { pid, ppid, pgid, started: match[4]! };
  });
}
export function snapshot(): readonly HostProcess[] {
  if (process.platform !== "darwin" && process.platform !== "linux") throw new HostRefusal(`host admission has no authoritative process-group provider for ${process.platform}; nothing was launched`);
  const result = spawnSync("ps", ["-axo", "pid=,ppid=,pgid=,lstart="], { encoding: "utf8", env: { ...process.env, LC_ALL: "C" }, timeout: 5_000, maxBuffer: 16 * 1024 * 1024 });
  if (result.error !== undefined || result.status !== 0 || result.signal !== null) throw new HostRefusal("cannot read complete process-group ownership with the host's ps; no capacity is freed and nothing new is launched");
  // ps observes itself while reading the snapshot. Its exact spawned PID is
  // probe infrastructure, already waited/reaped here, never a workload child.
  return parseProcesses(result.stdout).filter((row): boolean => row.pid !== result.pid);
}
export function ownIdentity(read: Snapshot = snapshot, pid = process.pid): ProcessIdentity {
  const own = read().find((entry): boolean => entry.pid === pid);
  if (own === undefined || own.pgid < 1) throw new HostRefusal("own process identity/group could not be established; nothing was launched");
  return { pid: own.pid, pgid: own.pgid, started: own.started };
}
export function groupMembers(group: ProcessIdentity, read: Snapshot = snapshot, excluding?: ProcessIdentity): readonly HostProcess[] {
  const processes = read();
  const leader = processes.find((row): boolean => row.pid === group.pid);
  if (leader !== undefined && (leader.started !== group.started || leader.pgid !== group.pgid)) throw new HostRefusal("recorded process-group leader identity was reused; ownership is unresolved");
  return processes.filter((row): boolean => row.pgid === group.pgid && !(excluding !== undefined && row.pid === excluding.pid && row.started === excluding.started));
}
export function belongsToGroup(group: ProcessIdentity, member: ProcessIdentity, read: Snapshot = snapshot): boolean {
  if (group.pgid !== member.pgid) return false;
  return descendsFrom(group, member, read);
}
export function descendsFrom(ancestor: ProcessIdentity, member: ProcessIdentity, read: Snapshot = snapshot): boolean {
  const processes = read();
  const root = processes.find((row): boolean => row.pid === ancestor.pid && row.started === ancestor.started && row.pgid === ancestor.pgid);
  const self = processes.find((row): boolean => row.pid === member.pid && row.started === member.started && row.pgid === member.pgid);
  if (root === undefined || self === undefined) return false;
  let cursor: HostProcess | undefined = self;
  const visited = new Set<number>();
  while (cursor !== undefined && !visited.has(cursor.pid)) {
    if (cursor.pid === root.pid) return true;
    visited.add(cursor.pid);
    cursor = processes.find((row): boolean => row.pid === cursor!.ppid);
  }
  return false;
}
