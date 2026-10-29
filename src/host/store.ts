// One host-owned budget, independent of a repository, checkout or login account.
// A complete owner record is linked into a numbered slot atomically. Claims
// never expire; unreadable state stays occupied. There is no PID/TTL reap.
import { closeSync, constants, fchmodSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { randomUUID } from "node:crypto";

export const HOST_CONFIG = "nen.host/v0.1";
export const CLAIM_CONTRACT = "nen.host.claim/v0.1";
export const DEFAULT_CAPACITY = 1;
export class HostRefusal extends Error {
  constructor(message: string) { super(message); this.name = "HostRefusal"; }
}
export interface HostConfig { readonly contract: typeof HOST_CONFIG; readonly hostId: string; readonly capacity: number }
export interface ProcessIdentity { readonly pid: number; readonly pgid: number; readonly started: string }
export interface HostClaim {
  readonly contract: typeof CLAIM_CONTRACT;
  readonly id: string;
  readonly owner: string;
  readonly createdAt: string;
  readonly coordinator: ProcessIdentity;
  readonly group: ProcessIdentity | null;
  readonly state: "reserved" | "running" | "complete" | "unresolved";
  readonly reason: string | null;
  /** Supervisor handshake result, preserving the execution seam's spawn-failure distinction. */
  readonly spawnFailed?: boolean;
  readonly launch?: LaunchStep;
}
export interface LaunchStep { readonly id: string; readonly digest: string }
export interface SupervisorRegistration { readonly claimId: string; readonly launch: LaunchStep; readonly coordinator: ProcessIdentity; readonly supervisor: ProcessIdentity }
export interface Slot { readonly slot: number; readonly claim: HostClaim | null; readonly problem: string | null }
export interface HostStore { readonly root: string; readonly config: HostConfig }
export interface Reservation { readonly store: HostStore; readonly slot: number; readonly claim: HostClaim }
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
function object(value: unknown): value is Record<string, unknown> { return typeof value === "object" && value !== null && !Array.isArray(value); }
function identity(value: unknown): value is ProcessIdentity {
  return object(value) && Number.isSafeInteger(value.pid) && Number(value.pid) > 0 && Number.isSafeInteger(value.pgid) && Number(value.pgid) > 0 && typeof value.started === "string" && value.started.length > 0;
}
function launchStep(value: unknown): value is LaunchStep {
  return object(value) && typeof value.id === "string" && UUID.test(value.id) && typeof value.digest === "string" && /^[0-9a-f]{64}$/.test(value.digest);
}
export function sameIdentity(left: ProcessIdentity, right: ProcessIdentity): boolean {
  return left.pid === right.pid && left.pgid === right.pgid && left.started === right.started;
}
export function parseConfig(value: unknown): HostConfig {
  if (!object(value) || Object.keys(value).some((key): boolean => !["contract", "hostId", "capacity"].includes(key)) || value.contract !== HOST_CONFIG || typeof value.hostId !== "string" || !UUID.test(value.hostId) || !Number.isSafeInteger(value.capacity) || Number(value.capacity) < 1 || Number(value.capacity) > 64) {
    throw new HostRefusal("host config must name nen.host/v0.1, a UUID hostId and integer capacity 1..64; default capacity is 1. Nothing was launched.");
  }
  return value as unknown as HostConfig;
}
export function parseClaim(value: unknown): HostClaim {
  if (!object(value) || (value.launch !== undefined && !launchStep(value.launch)) || (value.spawnFailed !== undefined && typeof value.spawnFailed !== "boolean") || value.contract !== CLAIM_CONTRACT || typeof value.id !== "string" || !UUID.test(value.id) || typeof value.owner !== "string" || value.owner.length === 0 || value.owner.length > 256 || typeof value.createdAt !== "string" || !identity(value.coordinator) || !(value.group === null || identity(value.group)) || !["reserved", "running", "complete", "unresolved"].includes(String(value.state)) || !(value.reason === null || typeof value.reason === "string")) {
    throw new HostRefusal("unreadable claim shape; its slot remains occupied");
  }
  return value as unknown as HostClaim;
}
function noLink(path: string, directory: boolean): void {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new HostRefusal(`host state is not a ${directory ? "directory" : "regular file"}: ${path}`);
}
function readJson(path: string): unknown {
  noLink(path, false);
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try { return JSON.parse(readFileSync(fd, "utf8")) as unknown; } finally { closeSync(fd); }
}
export function openStore(root: string): HostStore {
  if (!isAbsolute(root)) throw new HostRefusal("NEN_HOST_STORE / --store must be an absolute host-shared path; no checkout or per-user fallback is used. Nothing was launched.");
  try {
    noLink(root, true);
    const canonical = realpathSync(root);
    noLink(join(canonical, "slots"), true);
    return { root: canonical, config: parseConfig(readJson(join(canonical, "config.json"))) };
  } catch (error) { throw new HostRefusal(`cannot read host budget at ${root}: ${error instanceof Error ? error.message : String(error)}. Provision one shared store for interactive and CI accounts; nothing was launched.`); }
}
// Explicit provisioning only. Heavy execution never creates its own budget.
export function initStore(root: string, capacity = DEFAULT_CAPACITY): HostStore {
  if (!isAbsolute(root)) throw new HostRefusal("--store must be absolute");
  const config = parseConfig({ contract: HOST_CONFIG, hostId: randomUUID(), capacity });
  mkdirSync(root, { recursive: true, mode: 0o770 });
  noLink(root, true);
  const fd = openSync(join(root, "config.json"), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o660);
  try { fchmodSync(fd, 0o660); writeFileSync(fd, `${JSON.stringify(config, null, 2)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  mkdirSync(join(root, "slots"), { mode: 0o770 });
  return openStore(root);
}
function slotPath(store: HostStore, slot: number): string { return join(store.root, "slots", `${slot}.json`); }
export function readSlot(store: HostStore, slot: number): HostClaim {
  return parseClaim(readJson(slotPath(store, slot)));
}
export function slots(store: HostStore): readonly Slot[] {
  try {
    return readdirSync(join(store.root, "slots")).map((name): Slot => {
      if (!/^[1-9][0-9]*\.json$/.test(name) || !Number.isSafeInteger(Number(name.slice(0, -5)))) throw new HostRefusal(`unknown entry in host slots: ${name}; admission refused`);
      const slot = Number(name.slice(0, -5));
      try { return { slot, claim: readSlot(store, slot), problem: null }; }
      catch (error) { return { slot, claim: null, problem: error instanceof Error ? error.message : String(error) }; }
    });
  } catch (error) { throw new HostRefusal(`cannot examine host capacity: ${error instanceof Error ? error.message : String(error)}; nothing was launched`); }
}
export function writeClaim(reservation: Reservation, claim: HostClaim): void {
  const directory = reservation.store.root;
  const next = join(directory, `next-${randomUUID()}.json`);
  const fd = openSync(next, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o660);
  try { fchmodSync(fd, 0o660); writeFileSync(fd, `${JSON.stringify(claim)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(next, slotPath(reservation.store, reservation.slot));
}
export function assertOwner(reservation: Reservation): HostClaim {
  const current = readSlot(reservation.store, reservation.slot);
  if (current.id !== reservation.claim.id || !sameIdentity(current.coordinator, reservation.claim.coordinator)) throw new HostRefusal("host claim identity changed; no release or launch is permitted");
  return current;
}
export function reserve(store: HostStore, owner: string, coordinator: ProcessIdentity): Reservation {
  if (owner.length === 0 || owner.length > 256 || /[\x00-\x1f\x7f]/.test(owner)) throw new HostRefusal("owner must be 1..256 printable characters");
  // Read the COMPLETE set first: lowering a budget never hides old slots.
  const occupied = slots(store);
  if (occupied.some((slot): boolean => slot.problem !== null || slot.slot > store.config.capacity)) throw new HostRefusal(`host capacity unresolved: ${describeSlots(occupied)}; nothing was launched`);
  const claim: HostClaim = { contract: CLAIM_CONTRACT, id: randomUUID(), owner, createdAt: new Date().toISOString(), coordinator, group: null, state: "reserved", reason: null };
  const prepared = join(store.root, `reservation-${claim.id}.json`);
  const fd = openSync(prepared, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o660);
  try { fchmodSync(fd, 0o660); writeFileSync(fd, `${JSON.stringify(claim)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    for (let slot = 1; slot <= store.config.capacity; slot += 1) {
      try { linkSync(prepared, slotPath(store, slot)); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") continue; throw new HostRefusal(`cannot reserve host capacity: ${String(error)}; nothing was launched`); }
      return { store, slot, claim };
    }
  } finally { unlinkSync(prepared); }
  throw new HostRefusal(`host capacity ${store.config.capacity} occupied: ${describeSlots(slots(store))}. Refused immediately (wait 0ms); retry after the owner proves quiescence.`);
}
export function describeSlots(entries: readonly Slot[]): string {
  return entries.map((entry): string => `slot ${entry.slot}: ${entry.claim === null ? `unresolved owner (${entry.problem})` : `${entry.claim.owner} [${entry.claim.id}] ${entry.claim.state}${entry.claim.reason === null ? "" : ` (${entry.claim.reason})`}`}`).join("; ");
}
export function release(reservation: Reservation): void {
  const claim = assertOwner(reservation);
  if (claim.state !== "complete") throw new HostRefusal(`owner ${claim.owner} has no completion/quiescence receipt; slot retained`);
  unlinkSync(slotPath(reservation.store, reservation.slot));
}

function registrationPath(reservation: Reservation, step: LaunchStep): string {
  if (!launchStep(step)) throw new HostRefusal("malformed per-step launch capability");
  return join(reservation.store.root, `supervisor-${reservation.claim.id}-${step.id}.json`);
}
/** Atomic single-use consumption publishes the COMPLETE supervisor identity. */
export function registerSupervisor(reservation: Reservation, step: LaunchStep, supervisor: ProcessIdentity): void {
  const record: SupervisorRegistration = { claimId: reservation.claim.id, launch: step, coordinator: reservation.claim.coordinator, supervisor };
  const prepared = join(reservation.store.root, `registration-${randomUUID()}.json`);
  const fd = openSync(prepared, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o660);
  try { fchmodSync(fd, 0o660); writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  try {
    try { linkSync(prepared, registrationPath(reservation, step)); }
    catch (error) { throw new HostRefusal(`per-step launch capability already consumed or registration unavailable; no executable was launched: ${String(error)}`); }
  } finally { unlinkSync(prepared); }
}
export function readRegistration(reservation: Reservation, step: LaunchStep): SupervisorRegistration {
  const value = readJson(registrationPath(reservation, step));
  if (!object(value) || value.claimId !== reservation.claim.id || !launchStep(value.launch) || value.launch.id !== step.id || value.launch.digest !== step.digest || !identity(value.coordinator) || !sameIdentity(value.coordinator, reservation.claim.coordinator) || !identity(value.supervisor)) throw new HostRefusal("supervisor registration does not match this claim, step and coordinator; ownership retained");
  return value as unknown as SupervisorRegistration;
}
export function removeRegistration(reservation: Reservation, step: LaunchStep): void {
  unlinkSync(registrationPath(reservation, step));
}
