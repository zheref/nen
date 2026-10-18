// Port of Hatsu's frozen bd6fd5ff ledger, with two explicit human rulings:
// Nen-only mutexes after migration; no hydration of uncertain/missing counts.
import { randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { isRecord } from "../schema/errors.js";
import { loadWorkflow, type Workflow } from "../schema/workflow.js";
import { GIT, type Seams } from "../seam/exec.js";
import { CYCLE_STALE_MS, withCycleMutex } from "./ledger-lock.js";

export const CYCLE_CONTRACT = "hatsu.hanten.cycle/v0.1";
export const CYCLE_COORDINATION = "nen.review.ledger.mutex/v0.1";
export type CycleAction = "init" | "ensure" | "decide" | "record" | "show" | "recover-first" | "migrate";
export interface CycleRequest {
  readonly root: string;
  readonly branch: string;
  readonly pr?: string | null;
  readonly base?: string;
  readonly applicable?: string;
  readonly persona?: string;
  readonly outcome?: string;
  readonly confirmedFirstCycle?: boolean;
  readonly confirmedNoLegacyWriters?: boolean;
}
interface Budget { readonly max: number; readonly source: string }
export type CycleBudgets = ReadonlyMap<string, Budget>;
interface Reviewer extends Record<string, unknown> { used: number; max: number; invocations: Record<string, unknown>[]; budgetSource: string }
export interface CycleDocument extends Record<string, unknown> {
  contract: string; branch: string; pr: number | null; slug: string;
  reviewers: Record<string, Reviewer>;
}
export interface CycleResult { readonly code: number; readonly document: Record<string, unknown> }

const refuse = (message: string): never => { throw new VerbUsageError(`review ledger: ${message}`); };
export function cyclePr(raw?: string | null): string | null {
  if (raw === undefined || raw === null || raw.trim() === "") return null;
  const n = raw.trim().replace(/^#+/, "");
  if (!/^\d+$/.test(n) || !Number.isSafeInteger(Number(n)) || Number(n) <= 0) return refuse(`--pr must be a positive PR number, got ${JSON.stringify(raw)}`);
  return String(Number(n));
}
export function cycleKey(branch: string, pr: string | null = null): string {
  // Slash is the legacy slug delimiter; backslash must never become a Windows path.
  if (/[\\\x00-\x1f\x7f]/.test(branch)) return refuse("--branch contains a path separator or control character that cannot form a safe ledger key");
  const key = branch.replaceAll("/", "-");
  if (key === "." || key === "..") return refuse("--branch cannot form a directory traversal key");
  return pr === null ? key : `${key}-pr${pr}`;
}
export function cyclePath(root: string, branch: string, pr: string | null = null): string { return join(root, ".nen", "hanten", `${cycleKey(branch, pr)}.cycle.json`); }
export function cycleLock(root: string, branch: string, pr: string | null = null): string { return join(root, ".nen", "hanten", `${cycleKey(branch, pr)}.cycle.lock`); }

/** No roster or budget is owned here: schema defaults come from loadWorkflow. */
export function cycleBudgets(workflow: Workflow): CycleBudgets {
  const found = new Map<string, { max: number; scopes: string[] }>();
  for (const [scope, row] of Object.entries(workflow.review.scopes)) {
    const persona = row.persona.toLowerCase();
    const old = found.get(persona);
    found.set(persona, { max: old === undefined ? row.budget : Math.min(old.max, row.budget), scopes: [...(old?.scopes ?? []), scope] });
  }
  return new Map([...found].map(([persona, row]) => [persona, {
    max: row.max,
    source: `nen/workflow.json review.scopes.${row.scopes.join("+")}.budget${row.scopes.length > 1 ? " (min of the scopes named)" : ""}`,
  }]));
}
function exists(path: string): boolean {
  try { lstatSync(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function regularText(path: string): string {
  if (!lstatSync(path).isFile()) return refuse(`'${path}' is not a regular ledger file; restore the original ledger`);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0) | (constants.O_NOFOLLOW ?? 0));
  try {
    if (!fstatSync(fd).isFile()) return refuse(`'${path}' changed to a non-regular ledger file`);
    return readFileSync(fd, "utf8");
  } finally { closeSync(fd); }
}
function readDocument(path: string): CycleDocument {
  let value: unknown;
  try { value = JSON.parse(regularText(path)); }
  catch (error) {
    if (error instanceof VerbUsageError) throw error;
    return refuse(`cannot read '${path}': ${error instanceof Error ? error.message : String(error)}. Restore the original ledger; never reset counts`);
  }
  if (!isRecord(value)) return refuse(`'${path}' is not a ledger object; restore it`);
  return value as CycleDocument;
}
/** Validate ALL retained rows, including reviewers no longer declared by policy. */
export function validateCycle(doc: CycleDocument, branch: string, pr: string | null, budgets: CycleBudgets): void {
  if (doc.contract !== CYCLE_CONTRACT) refuse(`ledger is not ${CYCLE_CONTRACT}`);
  if (doc.branch !== branch) refuse(`ledger branch ${JSON.stringify(doc.branch)} is not ${JSON.stringify(branch)}`);
  if (doc.pr !== (pr === null ? null : Number(pr))) refuse(`ledger pr ${JSON.stringify(doc.pr)} is not ${pr ?? "null"}`);
  if (doc.slug !== cycleKey(branch, pr)) refuse("ledger slug does not match its effort key; restore the original ledger");
  if (!isRecord(doc.reviewers)) refuse("ledger has no reviewer count map; restore the original ledger");
  for (const [persona, value] of Object.entries(doc.reviewers)) {
    if (!isRecord(value) || !Number.isSafeInteger(value.used) || value.used < 0 || !Array.isArray(value.invocations)) refuse(`no valid ${persona} review history; restore it without resetting used counts`);
    let used = 0;
    for (const entry of value.invocations) {
      if (!isRecord(entry) || (entry.outcome !== "ran" && entry.outcome !== "skipped-exhausted")) refuse(`inconsistent ${persona} invocation history; restore the original ledger`);
      if (entry.outcome === "ran") used += 1;
    }
    if (used !== value.used) refuse(`inconsistent ${persona} used count and invocation history; restore the original ledger`);
  }
  for (const persona of budgets.keys()) {
    if (!Object.hasOwn(doc.reviewers, persona)) refuse(`missing ${persona} review history; restore the original ledger. No synthetic zero row or uncertain late-persona hydration is permitted`);
  }
}
function applyBudgets(doc: CycleDocument, budgets: CycleBudgets): void {
  for (const [persona, budget] of budgets) {
    const row = doc.reviewers[persona]!;
    row.max = budget.max;
    row.budgetSource = budget.source;
  }
}
function adopted(doc: CycleDocument): boolean {
  const coordination: unknown = doc["nenCoordination"];
  if (coordination === undefined) return false;
  if (!isRecord(coordination) || coordination["contract"] !== CYCLE_COORDINATION) return refuse("unknown or malformed nenCoordination; restore the protocol metadata");
  return true;
}
function requireAdopted(doc: CycleDocument): void {
  if (!adopted(doc)) refuse("legacy ledger requires 'review ledger migrate --confirmed-no-legacy-writers'. Stop ALL Python writers first: Nen's mutex does not coordinate with their OS locks");
}
function atomicSave(path: string, doc: CycleDocument, now: string): void {
  mkdirSync(dirname(path), { recursive: true });
  doc["updatedAt"] = now;
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    const fd = openSync(temp, "wx", 0o600);
    try { writeFileSync(fd, `${JSON.stringify(doc, null, 2)}\n`); fsyncSync(fd); }
    finally { closeSync(fd); }
    renameSync(temp, path);
  } finally {
    try { unlinkSync(temp); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  }
}
function git(seams: Seams, root: string, args: readonly string[]): string | null {
  const result = seams.run(GIT, args, { cwd: root });
  return result.code === 0 ? result.stdout : null;
}
export function cycleTraceDir(seams: Seams, root: string): string | null {
  const lines = (git(seams, root, ["rev-parse", "--git-common-dir"]) ?? "").trim().split(/\r?\n/);
  if (lines.length !== 1 || lines[0]?.trim() === "") return null;
  const path = lines[0]!.trim();
  return join(resolve(root, path), "hatsu", "hanten");
}
function opened(seams: Seams, root: string, key: string, now: string): string | null {
  const dir = cycleTraceDir(seams, root);
  if (dir === null) return "no git common dir was readable here, so no durable trace exists for a later ensure";
  mkdirSync(dir, { recursive: true });
  const marker = join(dir, `${key}.opened`);
  if (exists(marker) && !lstatSync(marker).isFile()) refuse(`opened marker '${marker}' is not a regular file; restore it`);
  const fd = openSync(marker, constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0), 0o600);
  try {
    if (!fstatSync(fd).isFile()) refuse(`opened marker '${marker}' changed to a non-regular file`);
    writeFileSync(fd, `${now} ${root}\n`);
    fsyncSync(fd);
  } finally { closeSync(fd); }
  return null;
}
function names(dir: string): string[] {
  try { return readdirSync(dir).sort(); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
}
export function prKeyed(name: string, key: string, suffix: string): boolean {
  if (!name.startsWith(`${key}-pr`) || !name.endsWith(suffix)) return false;
  return /^\d+$/.test(name.slice(key.length + 3, -suffix.length));
}
function traces(seams: Seams, root: string, branch: string): string[] {
  const key = cycleKey(branch);
  const found: string[] = [];
  const durable = cycleTraceDir(seams, root);
  if (durable !== null) for (const name of names(durable)) {
    if (name === `${key}.opened` || prKeyed(name, key, ".opened")) found.push(`opened before under this repository's git dir (${name})`);
  }
  const here = join(root, ".nen", "hanten");
  for (const name of names(here)) if (prKeyed(name, key, ".cycle.json")) found.push(`a PR-keyed ledger for another PR exists here (${name})`);
  const worktrees = git(seams, root, ["worktree", "list", "--porcelain", "-z"]) ?? "";
  for (const entry of worktrees.split("\0")) {
    if (!entry.startsWith("worktree ")) continue;
    const raw = entry.slice(9);
    if (!isAbsolute(raw)) continue;
    const other = resolve(raw);
    if (realpathSync(other) === realpathSync(root)) continue;
    const dir = join(other, ".nen", "hanten");
    for (const name of names(dir)) {
      if (name === `${key}.cycle.json` || name === `${key}.cycle.lock` || prKeyed(name, key, ".cycle.json")) found.push(`another checkout of this repository holds ${join(dir, name)}`);
    }
  }
  return found;
}
function trunk(seams: Seams, root: string, workflow: Workflow, rawPolicy: Record<string, unknown>, explicit?: string): string {
  if (explicit?.trim()) return explicit.trim();
  if (isRecord(rawPolicy["branch"]) && typeof rawPolicy["branch"]["base"] === "string" && rawPolicy["branch"]["base"].trim()) return workflow.branch.base;
  const head = (git(seams, root, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]) ?? "").trim();
  return head.startsWith("origin/") && head !== "origin/" ? head.slice(7) : workflow.branch.base;
}
function stale(path: string, now: number): boolean {
  try { return now - statSync(path).mtimeMs > CYCLE_STALE_MS; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}
function newCycle(branch: string, pr: string | null, budgets: CycleBudgets, now: string, recovery: boolean): CycleDocument {
  return {
    contract: CYCLE_CONTRACT, branch, pr: pr === null ? null : Number(pr), slug: cycleKey(branch, pr),
    openedAt: now, updatedAt: now, personasAtOpen: [...budgets.keys()],
    nenCoordination: { contract: CYCLE_COORDINATION, adoptedAt: now, kind: "new" },
    ...(recovery ? { openedAs: "confirmed-first-cycle-recovery" } : {}),
    reviewers: Object.fromEntries([...budgets].map(([persona, budget]) => [persona, { max: budget.max, used: 0, budgetSource: budget.source, invocations: [] }])),
  };
}
function decision(doc: CycleDocument, budgets: CycleBudgets, raw: string): Record<string, unknown> {
  const applicable = [...new Set(raw.split(",").map((p) => p.trim().toLowerCase()).filter(Boolean))];
  for (const p of applicable) if (!budgets.has(p)) refuse(`persona ${JSON.stringify(p)} is not a declared cycle reviewer`);
  const reviewers = [...budgets.keys()].map((persona) => {
    const row = doc.reviewers[persona]!;
    const applies = applicable.includes(persona);
    return { persona, applicable: applies, used: row.used, max: row.max, remaining: Math.max(0, row.max - row.used), action: !applies ? "not-applicable" : row.used >= row.max ? "skip-exhausted" : "raise" };
  });
  return { contract: CYCLE_CONTRACT, branch: doc.branch, pr: doc.pr, reviewers,
    raise: reviewers.filter((r) => r.action === "raise").map((r) => r.persona),
    skippedExhausted: reviewers.filter((r) => r.action === "skip-exhausted").map((r) => r.persona) };
}

/** Every operation is local. Git is read only; Python writers must not cross adoption. */
export async function runCycle(action: CycleAction, request: CycleRequest, seams: Seams): Promise<CycleResult> {
  const { root, branch } = request;
  const pr = cyclePr(request.pr);
  const path = cyclePath(root, branch, pr);
  const lock = cycleLock(root, branch, pr);
  if (request.base !== undefined && action !== "ensure") refuse("--base is only valid with ensure");
  if (request.confirmedFirstCycle && action !== "recover-first") refuse("--confirmed-first-cycle is only valid with recover-first");
  if (request.confirmedNoLegacyWriters && action !== "migrate") refuse("--confirmed-no-legacy-writers is only valid with migrate");
  if (action === "recover-first" && !request.confirmedFirstCycle) refuse("recover-first requires --confirmed-first-cycle after the maintainer confirms no review ran under this effort key");
  if (action === "migrate" && !request.confirmedNoLegacyWriters) refuse("migrate requires --confirmed-no-legacy-writers; stop ALL legacy Python writers before crossing this boundary");
  const loaded = loadWorkflow(root);
  const budgets = cycleBudgets(loaded.workflow);
  if (budgets.size === 0) return { code: 1, document: { error: "nen/workflow.json review.scopes declares no reviewers; configure the repository's own personas and budgets first" } };
  const now = (): string => seams.now().toISOString();
  if (action === "ensure") {
    const base = trunk(seams, root, loaded.workflow, loaded.raw, request.base);
    const branchPath = cyclePath(root, branch);
    if (!branch.trim() || [base, "HEAD"].includes(branch.trim()) || branch.trim().startsWith("refs/")) return { code: 3, document: { ensure: "refused", reason: `${JSON.stringify(branch)} is the trunk (${base}) or not a branch: no ledger is opened`, path: branchPath } };
    const present = (): Record<string, unknown> | null => {
      const candidate = pr !== null && exists(path) ? path : exists(branchPath) ? branchPath : null;
      if (candidate === null) return null;
      const doc = readDocument(candidate);
      validateCycle(doc, branch, candidate === path && pr !== null ? pr : null, budgets);
      requireAdopted(doc);
      return { ensure: "present", ...(candidate === path && pr !== null ? { keyed: "pr" } : {}), path: candidate };
    };
    const existing = present();
    if (existing !== null) return { code: 0, document: existing };
    const old = stale(cycleLock(root, branch), seams.now().getTime()); // snapshot BEFORE waiting, never reaped/dropped
    return withCycleMutex(cycleLock(root, branch), () => {
      const concurrent = present();
      if (concurrent !== null) return { code: 0, document: concurrent };
      const found = traces(seams, root, branch);
      if (old) found.push("its lock file remains in this checkout (older than an init in flight)");
      if (found.length > 0) return { code: 4, document: { ensure: "lost", reason: "no ledger here, but a ledger was opened under this key before: recover it, never a fresh init", traces: found, path: branchPath } };
      const doc = newCycle(branch, null, budgets, now(), false);
      const note = opened(seams, root, cycleKey(branch), now());
      atomicSave(branchPath, doc, now());
      return { code: 0, document: { ensure: "opened", reason: "no trace of an earlier ledger was found", path: branchPath, ...(note === null ? {} : { note }) } };
    });
  }
  if (!branch.trim()) refuse("--branch is required");
  const wasStale = stale(lock, seams.now().getTime());
  const creating = action === "init" || action === "recover-first";
  if (!creating && !exists(path)) refuse(`no ledger at ${path} — init only for a new effort; lost review history must be restored, never replaced with a fresh budget`);
  if (!creating && action !== "migrate") requireAdopted(readDocument(path));
  return withCycleMutex(lock, () => {
    if (creating) {
      if (exists(path)) refuse(`ledger already exists at ${path}`);
      const dir = cycleTraceDir(seams, root);
      if (action === "init" && (wasStale || (dir !== null && exists(join(dir, `${cycleKey(branch, pr)}.opened`))))) refuse("this exact effort key was opened before; restore its lost ledger, or recover-first only after confirmed no reviews");
      const doc = newCycle(branch, pr, budgets, now(), action === "recover-first");
      const note = opened(seams, root, cycleKey(branch, pr), now());
      atomicSave(path, doc, now());
      return { code: 0, document: { path, branch, pr: doc.pr, contract: CYCLE_CONTRACT, openedAs: doc["openedAs"] ?? "normal-init",
        budgets: Object.fromEntries([...budgets].map(([p, b]) => [p, { max: b.max, source: b.source }])), ...(note === null ? {} : { note }) } };
    }
    const doc = readDocument(path);
    validateCycle(doc, branch, pr, budgets);
    if (action === "migrate") {
      if (adopted(doc)) return { code: 0, document: { path, migrated: false, reason: "already uses the Nen-only mutex protocol" } };
      const timestamp = doc["updatedAt"];
      if (typeof timestamp !== "string") return refuse("legacy ledger has no updatedAt timestamp; restore it");
      // Keep an exact byte backup before annotating; never discard unknown fields/rows.
      const backup = `${path}.legacy`;
      const text = regularText(path);
      if (exists(backup)) {
        if (regularText(backup) !== text) refuse(`legacy backup '${backup}' differs; inspect and restore it before migration`);
      } else writeFileSync(backup, text, { flag: "wx", mode: 0o600 });
      doc["nenCoordination"] = { contract: CYCLE_COORDINATION, adoptedAt: now(), kind: "legacy-migration", confirmedNoLegacyWriters: true, backup };
      // Migration itself does not rewrite historical maxima, budget sources or timestamps.
      opened(seams, root, cycleKey(branch, pr), now());
      atomicSave(path, doc, timestamp);
      return { code: 0, document: { path, migrated: true, backup, contract: CYCLE_CONTRACT } };
    }
    requireAdopted(doc);
    applyBudgets(doc, budgets);
    if (action === "show") return { code: 0, document: { ...doc, path } };
    if (action === "decide") return { code: 0, document: { ...decision(doc, budgets, request.applicable ?? ""), path } };
    const persona = request.persona?.toLowerCase() ?? "";
    if (!budgets.has(persona)) refuse(`persona ${JSON.stringify(persona)} is not a declared cycle reviewer`);
    const outcome = request.outcome;
    if (outcome !== "ran" && outcome !== "skipped-exhausted") refuse("--outcome is ran or skipped-exhausted");
    const row = doc.reviewers[persona]!;
    if (outcome === "ran" && row.used >= row.max) refuse(`${persona} is exhausted (${row.used}/${row.max}); record skipped-exhausted, do not raise`);
    if (outcome === "skipped-exhausted" && row.used < row.max) refuse(`${persona} still has budget (${row.used}/${row.max}); skipped-exhausted is only for used >= max`);
    if (outcome === "ran") row.used += 1;
    row.invocations.push({ at: now(), outcome });
    atomicSave(path, doc, now());
    return { code: 0, document: { path, persona, outcome, used: row.used, max: row.max } };
  });
}
