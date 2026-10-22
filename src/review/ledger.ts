// Review-cycle storage, preserving Hatsu's v0.1 document and durable traces.
// The repository supplies the roster; unknown historical rows are retained.
import { lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { VerbUsageError } from "../cli/command.js";
import { withLedgerLock, writeLedgerAtomically } from "../ledger/lock.js";
import { loadWorkflow } from "../schema/workflow.js";
import { SchemaError } from "../schema/errors.js";
import type { Seams } from "../seam/exec.js";
import { realContainment } from "../repo/contain.js";
import storage from "./storage.json";

export const CYCLE_CONTRACT = storage.contract;
export const CYCLE_MARKER_DIRECTORY = storage.markerDirectory;
export const CYCLE_STALE_MS = 30_000;
export interface Budget { max: number; source: string }
export type Budgets = Record<string, Budget>;
export interface Reviewer {
  used: number;
  max: number;
  budgetSource?: string;
  invocations: { outcome: "ran" | "skipped-exhausted"; at?: string; [key: string]: unknown }[];
  [key: string]: unknown;
}
export interface Cycle {
  contract: typeof CYCLE_CONTRACT;
  branch: string;
  pr: number | null;
  slug: string;
  openedAt: string;
  updatedAt: string;
  personasAtOpen?: string[];
  lateHydrated?: string[];
  reviewers: Record<string, Reviewer>;
  [key: string]: unknown;
}
export interface CycleOptions {
  root: string;
  branch: string;
  pr?: number;
  base?: string;
  seams: Seams;
  warn?: (line: string) => void;
}

function refuse(message: string): never {
  throw new VerbUsageError(`review ledger: ${message}`);
}
function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function integer(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function workflowAt(root: string): ReturnType<typeof loadWorkflow> {
  try { return loadWorkflow(root); } catch (error) {
    if (error instanceof SchemaError) throw new VerbUsageError(error.message);
    throw error;
  }
}

export function readBudgets(root: string): Budgets {
  const loaded = workflowAt(root);
  const budgets: Budgets = Object.create(null) as Budgets;
  const sources: Record<string, string[]> = Object.create(null) as Record<string, string[]>;
  for (const [scope, row] of Object.entries(loaded.workflow.review.scopes)) {
    const persona = row.persona.toLowerCase();
    const previous = budgets[persona];
    (sources[persona] ??= []).push(scope);
    const names = sources[persona]!;
    budgets[persona] = {
      max: previous === undefined ? row.budget : Math.min(previous.max, row.budget),
      source: `nen/workflow.json review.scopes.${names.join("+")}.budget${names.length > 1 ? " (min of the scopes named)" : ""}`,
    };
  }
  if (Object.keys(budgets).length === 0) refuse("nen/workflow.json must declare review.scopes with persona budgets; there is no built-in roster or default budget.");
  return budgets;
}

export function cycleKey(branch: string, pr?: number): string {
  // Preserve Hatsu's slash-to-dash key, but never admit path separators or
  // glob metacharacters into filesystem operations. Trace matching is literal.
  if (branch.includes("\\") || /[\x00-\x1f\x7f]/.test(branch)) refuse("--branch contains a control character or backslash.");
  const key = branch.replaceAll("/", "-");
  if (key === "." || key === "..") refuse("--branch must name a branch, not a path component.");
  return pr === undefined ? key : `${key}-pr${pr}`;
}
export function cyclePath(root: string, branch: string, pr?: number): string {
  const path = join(root, ".nen", "hanten", `${cycleKey(branch, pr)}.cycle.json`);
  if (!realContainment(root, path).contained) refuse(`ledger path leaves the target repository: ${path}.`);
  return path;
}
export function cycleTraceLock(root: string, branch: string, pr?: number): string {
  return join(root, ".nen", "hanten", `${cycleKey(branch, pr)}.cycle.lock`);
}
function present(path: string): boolean {
  // A dangling link is damaged state, never an absent ledger to overwrite.
  try { lstatSync(path); return true; } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}
function git(options: CycleOptions, args: readonly string[]): string | null {
  const result = options.seams.run("git", ["-C", options.root, ...args]);
  return result.code === 0 ? result.stdout : null;
}
export function cycleTraceDir(options: CycleOptions): string | null {
  const lines = (git(options, ["rev-parse", "--git-common-dir"]) ?? "").trim().split(/\r?\n/);
  const line = lines[0];
  return lines.length !== 1 || !line ? null : join(isAbsolute(line) ? line : resolve(options.root, line), ...CYCLE_MARKER_DIRECTORY);
}
function names(path: string): string[] {
  try { return readdirSync(path).sort(); } catch (error) {
    if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return [];
    throw error;
  }
}
export function prKeyed(name: string, key: string, suffix: string): boolean {
  const prefix = `${key}-pr`;
  return name.startsWith(prefix) && name.endsWith(suffix) && /^\d+$/.test(name.slice(prefix.length, -suffix.length));
}
function traces(options: CycleOptions): string[] {
  const key = cycleKey(options.branch);
  const found: string[] = [];
  const durable = cycleTraceDir(options);
  if (durable !== null) for (const name of names(durable)) {
    if (name === `${key}.opened` || prKeyed(name, key, ".opened")) found.push(`opened before under this repository's git dir (${name})`);
  }
  for (const name of names(join(options.root, ".nen", "hanten"))) {
    if (prKeyed(name, key, ".cycle.json")) found.push(`a PR-keyed ledger for another PR exists here (${name})`);
  }
  for (const line of (git(options, ["-c", "core.quotePath=false", "worktree", "list", "--porcelain", "-z"]) ?? "").split("\0")) {
    if (!line.startsWith("worktree ")) continue;
    const root = line.slice("worktree ".length);
    try { if (realpathSync(root) === realpathSync(options.root)) continue; } catch { continue; }
    const dir = join(root, ".nen", "hanten");
    for (const name of names(dir)) {
      if (name === `${key}.cycle.json` || name === `${key}.cycle.lock` || name === `${key}.cycle.json.lock` || prKeyed(name, key, ".cycle.json")) found.push(`another checkout of this repository holds ${join(dir, name)}`);
    }
  }
  return found;
}
function stampKnown(doc: Cycle, persona: string): boolean {
  return [doc.personasAtOpen, doc.lateHydrated].some((stamp): boolean => stamp !== undefined && (!Array.isArray(stamp) || stamp.includes(persona)));
}

export function readCycle(options: CycleOptions, budgets: Budgets): Cycle {
  const path = cyclePath(options.root, options.branch, options.pr);
  if (!present(path)) refuse(`no ledger at ${path} — init only for a new effort; a lost ledger must be restored without resetting used counts.`);
  let raw: unknown;
  try { raw = JSON.parse(readFileSync(path, "utf8")); } catch { refuse(`unreadable ledger at ${path}; restore the original ledger.`); }
  if (!object(raw) || raw["contract"] !== CYCLE_CONTRACT) refuse(`${path} is not ${CYCLE_CONTRACT}.`);
  if (raw["branch"] !== options.branch || raw["pr"] !== (options.pr ?? null)) refuse(`ledger branch or pr does not match the requested effort at ${path}.`);
  if (!object(raw["reviewers"])) refuse(`${path} has no reviewer count map; restore the original ledger.`);
  const doc = raw as unknown as Cycle;
  // Retain and validate historical reviewers even after their scope is removed.
  for (const [persona, row] of Object.entries(doc.reviewers)) {
    if (!object(row) || !integer(row.used) || !Array.isArray(row.invocations) || !integer(row.max)) refuse(`${path} has no valid ${persona} review history; restore it without resetting used counts.`);
    const outcomes = row.invocations.map((entry): unknown => object(entry) ? entry["outcome"] : undefined);
    if (outcomes.some((outcome): boolean => outcome !== "ran" && outcome !== "skipped-exhausted") || outcomes.filter((outcome): boolean => outcome === "ran").length !== row.used) refuse(`${path} has inconsistent ${persona} used count and invocation history; restore the original ledger.`);
  }
  for (const [persona, budget] of Object.entries(budgets)) {
    if (!Object.hasOwn(doc.reviewers, persona)) {
      // Only an explicit roster stamp can prove a reviewer was added later.
      // An unstamped ledger cannot safely distinguish an old roster from loss.
      if (!Array.isArray(doc.personasAtOpen) || stampKnown(doc, persona)) refuse(`${path} has no valid ${persona} review history; restore it without resetting used counts.`);
      Object.defineProperty(doc.reviewers, persona, { value: { used: 0, max: budget.max, invocations: [], hydratedAs: "persona-added-after-ledger-opened" }, enumerable: true, configurable: true, writable: true });
      doc.lateHydrated = [...new Set([...(doc.lateHydrated ?? []), persona])].sort();
    }
    doc.reviewers[persona]!.max = budget.max;
    doc.reviewers[persona]!.budgetSource = budget.source;
  }
  return doc;
}
function saveCycle(options: CycleOptions, doc: Cycle): void {
  doc.updatedAt = options.seams.now().toISOString();
  writeLedgerAtomically(cyclePath(options.root, options.branch, options.pr), doc);
}
function initCycle(options: CycleOptions, budgets: Budgets, recovery: boolean): Record<string, unknown> {
  const path = cyclePath(options.root, options.branch, options.pr);
  if (present(path)) refuse(`ledger already exists at ${path}.`);
  const now = options.seams.now().toISOString();
  const doc: Cycle = {
    contract: CYCLE_CONTRACT, branch: options.branch, pr: options.pr ?? null,
    slug: cycleKey(options.branch, options.pr), openedAt: now, updatedAt: now,
    personasAtOpen: Object.keys(budgets),
    reviewers: Object.fromEntries(Object.entries(budgets).map(([persona, budget]): [string, Reviewer] => [persona, { max: budget.max, used: 0, budgetSource: budget.source, invocations: [] }])),
    ...(recovery ? { openedAs: "confirmed-first-cycle-recovery" } : {}),
  };
  saveCycle(options, doc);
  const dir = cycleTraceDir(options);
  if (dir !== null) {
    try {
      const marker = join(dir, `${doc.slug}.opened`);
      const common = dirname(dirname(dir));
      if (!realContainment(common, marker).contained || (present(marker) && lstatSync(marker).isSymbolicLink())) throw new Error(`marker path is redirected: ${marker}`);
      mkdirSync(dir, { recursive: true });
      writeFileSync(marker, `${now} ${options.root}\n`);
    } catch (error) { options.warn?.(`review ledger: durable marker could not be written: ${String(error)}`); }
  }
  return { path, branch: doc.branch, pr: doc.pr, contract: CYCLE_CONTRACT, openedAs: doc["openedAs"] ?? "normal-init", budgets: Object.fromEntries(Object.entries(budgets).map(([persona, budget]): [string, unknown] => [persona, { max: budget.max, source: budget.source }])) };
}
function locked<T>(options: CycleOptions, body: () => T): T {
  const path = cyclePath(options.root, options.branch, options.pr);
  for (const candidate of [`${path}.lock`, cycleTraceLock(options.root, options.branch, options.pr)]) {
    if (!realContainment(options.root, candidate).contained || (present(candidate) && lstatSync(candidate).isSymbolicLink())) refuse(`lock path is redirected: ${candidate}.`);
  }
  return withLedgerLock(path, (): T => {
    const trace = cycleTraceLock(options.root, options.branch, options.pr);
    // The persistent legacy lock remains a trace. Nen's removable O_EXCL mutex
    // has its own path, so an unlocked legacy file never deadlocks a migration.
    if (!present(trace)) writeFileSync(trace, "", { flag: "wx" });
    return body();
  }, { warn: options.warn });
}
function trunk(options: CycleOptions): string {
  const loaded = workflowAt(options.root);
  if (options.base?.trim()) return options.base.trim();
  const base = loaded.workflow.branch.base;
  const raw = loaded.raw;
  if (object(raw["branch"]) && typeof raw["branch"]["base"] === "string") return base;
  const remote = git(options, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"])?.trim();
  return remote?.startsWith("origin/") && remote !== "origin/" ? remote.slice(7) : "main";
}
export function ensureCycle(options: CycleOptions): { code: number; report: Record<string, unknown> } {
  const path = cyclePath(options.root, options.branch);
  const base = trunk(options);
  if (!options.branch.trim() || [base, "HEAD"].includes(options.branch.trim()) || options.branch.startsWith("refs/")) return { code: 3, report: { ensure: "refused", reason: `${JSON.stringify(options.branch)} is the trunk (${base}) or not a branch: no ledger is opened`, path } };
  const existing = (): Record<string, unknown> | null => {
    if (options.pr !== undefined && present(cyclePath(options.root, options.branch, options.pr))) return { ensure: "present", keyed: "pr", path: cyclePath(options.root, options.branch, options.pr) };
    return present(path) ? { ensure: "present", path } : null;
  };
  const first = existing();
  if (first !== null) return { code: 0, report: first };
  // Capture age before waiting; another ensure must never erase a lost trace.
  const stale = [cycleTraceLock(options.root, options.branch), `${path}.lock`].some((lock): boolean => {
    try { return options.seams.now().getTime() - statSync(lock).mtimeMs > CYCLE_STALE_MS; } catch { return false; }
  });
  return locked({ ...options, pr: undefined }, (): { code: number; report: Record<string, unknown> } => {
    const current = existing();
    if (current !== null) return { code: 0, report: current };
    const found = traces(options);
    if (stale) found.push("its lock file remains in this checkout (older than an init in flight)");
    if (found.length > 0) return { code: 4, report: { ensure: "lost", reason: "no ledger here, but a ledger was opened under this key before: recover it, never a fresh init", traces: found, path } };
    initCycle({ ...options, pr: undefined }, readBudgets(options.root), false);
    return { code: 0, report: { ensure: "opened", reason: "no trace of an earlier ledger was found", path, ...(cycleTraceDir(options) === null ? { note: "no git common dir was readable here, so no durable trace exists for a later ensure" } : {}) } };
  });
}
export function runCycle(options: CycleOptions, action: string, args: { applicable?: string; persona?: string; outcome?: string; confirmed?: boolean }): Record<string, unknown> {
  const budgets = readBudgets(options.root);
  const path = cyclePath(options.root, options.branch, options.pr);
  if (["show", "record", "decide"].includes(action) && !present(path)) readCycle(options, budgets); // missing reads leave no lock trace
  return locked(options, (): Record<string, unknown> => {
    if (action === "init" || action === "recover-first") return initCycle(options, budgets, action === "recover-first");
    const doc = readCycle(options, budgets);
    if (action === "show") return { ...doc, path };
    if (action === "decide") {
      const applicable = [...new Set((args.applicable ?? "").split(",").map((p): string => p.trim().toLowerCase()).filter(Boolean))];
      for (const persona of applicable) if (!Object.hasOwn(budgets, persona)) refuse(`persona '${persona}' is not declared in review.scopes.`);
      const reviewers = Object.entries(budgets).map(([persona, budget]): Record<string, unknown> => {
        const used = doc.reviewers[persona]!.used;
        return { persona, applicable: applicable.includes(persona), used, max: budget.max, remaining: Math.max(0, budget.max - used), action: !applicable.includes(persona) ? "not-applicable" : used >= budget.max ? "skip-exhausted" : "raise" };
      });
      return { contract: CYCLE_CONTRACT, branch: doc.branch, pr: doc.pr, path, reviewers, raise: reviewers.filter((row): boolean => row["action"] === "raise").map((row): unknown => row["persona"]), skippedExhausted: reviewers.filter((row): boolean => row["action"] === "skip-exhausted").map((row): unknown => row["persona"]) };
    }
    const persona = args.persona!.toLowerCase();
    if (!Object.hasOwn(budgets, persona)) refuse(`persona '${persona}' is not declared in review.scopes.`);
    const row = doc.reviewers[persona]!;
    if (args.outcome !== "ran" && args.outcome !== "skipped-exhausted") refuse("--outcome is ran or skipped-exhausted.");
    if (args.outcome === "ran" && row.used >= row.max) refuse(`${persona} is exhausted (${row.used}/${row.max}); record skipped-exhausted, do not raise.`);
    if (args.outcome === "skipped-exhausted" && row.used < row.max) refuse(`${persona} still has budget (${row.used}/${row.max}); skipped-exhausted is only for used >= max.`);
    if (args.outcome === "ran") row.used += 1;
    row.invocations.push({ at: options.seams.now().toISOString(), outcome: args.outcome });
    saveCycle(options, doc);
    return { path, persona, outcome: args.outcome, used: row.used, max: row.max };
  });
}
