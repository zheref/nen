import { createHash, randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";
import type { InteractiveResult, RunOptions, Seams } from "../seam/exec.js";
import { HostRefusal, assertOwner, openStore, readRegistration, readSlot, registerSupervisor, release, removeRegistration, reserve, sameIdentity, writeClaim, type LaunchStep, type ProcessIdentity, type Reservation } from "./store.js";
import { belongsToGroup, descendsFrom, groupMembers, ownIdentity, snapshot, type Snapshot } from "./process.js";

export const HOST_STORE_ENV = "NEN_HOST_STORE";
export const ACTIVATION_ENV = "NEN_HOST_ADMISSION";
export const CLAIM_ENV = "NEN_HOST_CLAIM";
export const SLOT_ENV = "NEN_HOST_SLOT";
export interface HostGuard { readonly seams: Seams; finish(): void }
export type HostAdmission = (seams: Seams, owner: string, notice?: (message: string) => void) => HostGuard;
/** Staged availability only: explicit host run never consults this switch. */
export function hostActivated(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env[ACTIVATION_ENV];
  if (value === undefined || value === "") return false;
  if (value !== "enabled") throw new HostRefusal(`${ACTIVATION_ENV} must be 'enabled' or unset; invalid activation refuses before launch`);
  return true;
}
export function hasClaimMarkers(env: Readonly<Record<string, string | undefined>>): boolean {
  return env[CLAIM_ENV] !== undefined || env[SLOT_ENV] !== undefined;
}
export function unavailableNotice(owner: string): string {
  return `host admission unavailable for ${owner}: NEN_HOST_ADMISSION is not enabled; serialized fallback required; this launch is unprotected.`;
}
export const admitConfiguredWorkload: HostAdmission = (seams, owner, notice = (message): void => { process.stderr.write(`${message}\n`); }): HostGuard => {
  // A child cannot turn off an inherited active claim by clearing activation.
  if (hostActivated(seams.env) || hasClaimMarkers(seams.env)) return admitWorkload(seams, owner);
  notice(unavailableNotice(owner));
  return { seams, finish(): void {} };
};
function storePath(env: Readonly<Record<string, string | undefined>>): string {
  const path = env[HOST_STORE_ENV];
  if (path === undefined || path === "") throw new HostRefusal("NEN_HOST_STORE is not configured. Provision one absolute host-shared budget for local and same-host CI accounts. Nothing was launched.");
  return path;
}
export function inheritedClaim(env: Readonly<Record<string, string | undefined>>, read: Snapshot = snapshot): Reservation | null {
  const id = env[CLAIM_ENV]; const slotText = env[SLOT_ENV];
  if (id === undefined && slotText === undefined) return null;
  if (id === undefined || slotText === undefined || !/^[1-9][0-9]*$/.test(slotText) || !Number.isSafeInteger(Number(slotText))) throw new HostRefusal("incomplete inherited host claim; no independent admission or launch is allowed");
  const store = openStore(storePath(env)); const slot = Number(slotText); const claim = readSlot(store, slot);
  if (slot > store.config.capacity || claim.id !== id || claim.state !== "running" || claim.group === null || claim.launch === undefined) throw new HostRefusal(`inherited host claim does not own this process/group; owner ${claim.owner} retains capacity. Nothing was launched.`);
  const reservation = { store, slot, claim };
  const registration = readRegistration(reservation, claim.launch);
  if (!sameIdentity(registration.supervisor, claim.group) || !belongsToGroup(claim.group, ownIdentity(read), read)) throw new HostRefusal(`inherited host claim does not own this process/group; owner ${claim.owner} retains capacity. Nothing was launched.`);
  return reservation;
}
// Re-exec the CURRENT source or compiled binary. No dependency on a globally
// installed Nen (which could predate host admission); CI's entry needs builtins only.
export function supervisorInvocation(): { exe: string; argv: readonly string[] } {
  const invoked = process.argv[1] ?? "";
  if (process.versions.bun !== undefined && !/\.(?:[cm]?js|ts)$/.test(invoked)) return { exe: process.execPath, argv: ["host", "_exec"] };
  const source = fileURLToPath(new URL("./entry.ts", import.meta.url));
  // Source development and the Node-hosted Vitest harness both use this repo's
  // declared Bun runtime; a published binary re-executes itself instead.
  if (existsSync(source)) return { exe: process.versions.bun === undefined ? "bun" : process.execPath, argv: [source, "_exec"] };
  return { exe: process.execPath, argv: ["host", "_exec"] };
}
function envFor(reservation: Reservation): Readonly<Record<string, string>> {
  return { [HOST_STORE_ENV]: reservation.store.root, [CLAIM_ENV]: reservation.claim.id, [SLOT_ENV]: String(reservation.slot) };
}
function launchOptions(options: RunOptions | undefined, reservation: Reservation): RunOptions {
  return { ...options, env: { ...options?.env, ...envFor(reservation) } };
}
function supervisorArgs(command: string, args: readonly string[], reservation: Reservation, step: LaunchStep): readonly string[] {
  return [...supervisorInvocation().argv, "--store", reservation.store.root, "--slot", String(reservation.slot), "--claim", reservation.claim.id, "--launch", step.id, "--", command, ...args];
}
function requestDigest(command: string, args: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify([command, args])).digest("hex");
}
export function prepareLaunch(reservation: Reservation, command: string, args: readonly string[]): LaunchStep {
  const claim = assertOwner(reservation);
  if (!sameIdentity(claim.coordinator, ownIdentity())) throw new HostRefusal("launch coordinator identity changed; slot retained");
  if (claim.state !== "reserved" || claim.group !== null || claim.launch !== undefined) throw new HostRefusal(`previous host step is ${claim.state} or already armed; owner ${claim.owner} retains its slot`);
  const launch = { id: randomUUID(), digest: requestDigest(command, args) };
  writeClaim(reservation, { ...claim, launch });
  return launch;
}
function afterStep(reservation: Reservation, step: LaunchStep): boolean {
  const claim = assertOwner(reservation);
  const registration = readRegistration(reservation, step);
  if (!sameIdentity(claim.coordinator, ownIdentity()) || claim.launch?.id !== step.id || claim.launch.digest !== step.digest || claim.state !== "complete" || claim.group === null || !sameIdentity(claim.group, registration.supervisor) || groupMembers(registration.supervisor).length !== 0) throw new HostRefusal(`workload ${claim.owner} has unresolved descendants or no matching supervisor completion receipt; slot retained`);
  writeClaim(reservation, { ...claim, state: "reserved", group: null, launch: undefined, reason: null, spawnFailed: undefined });
  return claim.spawnFailed === true;
}
export const admitWorkload: HostAdmission = (seams, owner): HostGuard => {
  if (inheritedClaim(seams.env) !== null) return { seams, finish(): void {} };
  const reservation = reserve(openStore(storePath(seams.env)), owner, ownIdentity());
  const invocation = supervisorInvocation();
  const steps: LaunchStep[] = [];
  // Every direct child is a tiny supervisor in a new POSIX process group. It
  // writes that group's identity BEFORE it starts the requested executable.
  const guarded: Seams = {
    ...seams,
    hostAdmission: undefined,
    run(command, args, options) {
      const step = prepareLaunch(reservation, command, args);
      steps.push(step);
      const result = seams.run(invocation.exe, supervisorArgs(command, args, reservation, step), { ...launchOptions(options, reservation), detached: true });
      const spawnFailed = afterStep(reservation, step);
      return { ...result, spawnFailed: result.spawnFailed || spawnFailed };
    },
    runInteractive(command, args, options) {
      const step = prepareLaunch(reservation, command, args);
      steps.push(step);
      const result = seams.runInteractive(invocation.exe, supervisorArgs(command, args, reservation, step), { ...launchOptions(options, reservation), detached: true });
      const spawnFailed = afterStep(reservation, step);
      return { ...result, spawnFailed: result.spawnFailed || spawnFailed };
    },
    async runStreamed(command, args, options) {
      const step = prepareLaunch(reservation, command, args);
      steps.push(step);
      const result = await seams.runStreamed(invocation.exe, supervisorArgs(command, args, reservation, step), { ...options, ...launchOptions(options, reservation), detached: true });
      const spawnFailed = afterStep(reservation, step);
      return { ...result, spawnFailed: result.spawnFailed || spawnFailed };
    },
  };
  return {
    seams: guarded,
    finish(): void {
      const claim = assertOwner(reservation);
      if (claim.state !== "reserved" || claim.group !== null || claim.launch !== undefined) throw new HostRefusal(`host claim ${claim.id} is unresolved (${claim.state}; ${claim.reason ?? "no terminal reason"}); owner ${claim.owner} retains capacity`);
      writeClaim(reservation, { ...claim, state: "complete" });
      release(reservation);
      for (const step of steps) removeRegistration(reservation, step);
    },
  };
};

/** Internal pre-exec handshake, shared by CLI and dependency-free CI entry. */
export interface SupervisorHooks { readonly beforeRegister?: () => void }
function ownsRegisteredStep(reservation: Reservation, step: LaunchStep, self: ProcessIdentity): ReturnType<typeof assertOwner> {
  const claim = assertOwner(reservation);
  const registration = readRegistration(reservation, step);
  if (claim.launch?.id !== step.id || claim.launch.digest !== step.digest || claim.state !== "running" || claim.group === null || !sameIdentity(claim.group, self) || !sameIdentity(registration.supervisor, self)) throw new HostRefusal("supervisor no longer owns this exact registered step; no completion overwrite is permitted");
  return claim;
}
export function supervise(storeRoot: string, slot: number, id: string, launchId: string, command: string, args: readonly string[], hooks: SupervisorHooks = {}): number {
  if (!isAbsolute(storeRoot)) throw new HostRefusal("supervisor store path must be absolute");
  const store = openStore(storeRoot); const claim = readSlot(store, slot); const reservation = { store, slot, claim };
  const step = claim.launch;
  if (claim.id !== id || claim.state !== "reserved" || claim.group !== null || step === undefined || step.id !== launchId || step.digest !== requestDigest(command, args)) throw new HostRefusal("supervisor claim changed or per-step capability/request changed; no executable was launched");
  const self = ownIdentity();
  if (self.pgid !== self.pid) throw new HostRefusal("supervisor does not own its dedicated process group; no executable was launched");
  if (!descendsFrom(claim.coordinator, self)) throw new HostRefusal("supervisor is not a descendant of the exact expected coordinator; no executable was launched");
  // Test-only deterministic barrier is not exposed by CLI. Both contenders can
  // prove reserved state before this atomic publication; exactly one may win.
  hooks.beforeRegister?.();
  registerSupervisor(reservation, step, self);
  const current = assertOwner(reservation);
  if (current.launch?.id !== step.id || current.launch.digest !== step.digest || current.state !== "reserved" || current.group !== null || !sameIdentity(current.coordinator, claim.coordinator) || !descendsFrom(claim.coordinator, self)) throw new HostRefusal("consumed launch no longer matches its reserved coordinator; slot retained");
  writeClaim(reservation, { ...current, state: "running", group: self });
  let result: InteractiveResult;
  try {
    const child = spawnSync(command, [...args], { stdio: "inherit", env: { ...process.env, ...envFor(reservation) } });
    result = { code: child.status ?? 1, signal: child.signal ?? null, spawnFailed: child.error !== undefined };
    if (child.error !== undefined) process.stderr.write(`host supervisor could not start requested executable: ${child.error.message}\n`);
    const remaining = groupMembers(self, snapshot, self);
    const owned = ownsRegisteredStep(reservation, step, self);
    if (result.signal !== null || remaining.length !== 0) {
      writeClaim(reservation, { ...owned, state: "unresolved", reason: result.signal === null ? `${remaining.length} process-group descendants remain` : `command ended on ${result.signal}` });
      return result.code === 0 ? 1 : result.code;
    }
    writeClaim(reservation, { ...owned, state: "complete", reason: null, spawnFailed: result.spawnFailed });
    return result.spawnFailed ? 127 : result.code;
  } catch (error) {
    const owned = ownsRegisteredStep(reservation, step, self);
    writeClaim(reservation, { ...owned, state: "unresolved", reason: error instanceof Error ? error.message : String(error) });
    throw error;
  }
}
