// src/wc/swap.ts -- `nen wc worktrees` and `nen wc swap`: list every checkout
// of a project, bring one worktree's COMMITTED tree into the core checkout, and
// put core back where it started (zheref/nen#241).
//
// WHY A VERB. A developer who debugs from an IDE opened on the CORE checkout --
// the one whose `.git` is the common git directory -- while efforts run in
// `git worktree`s wants to see a worktree's work in the IDE they already have
// open: its project path, derived data, signing and untracked local config stay
// put, and only the tree changes. That was a consumer's hand-written shell
// engine; it is deterministic git work, so it is a verb here, with the engine's
// exit codes and its fixtures (./swap.integration.test.ts).
//
// THE TWO MODES.
//   view (the default)  core checks out the worktree's HEAD commit DETACHED.
//                       The worktree keeps its branch, so a session working
//                       there is undisturbed; swapping again picks up its newer
//                       commits. Only COMMITTED work travels: a worktree with
//                       uncommitted changes is refused (exit 3), never guessed at.
//   take (--take)       the BRANCH moves: the worktree is detached at the same
//                       commit and core checks the branch out, so a commit made
//                       in core lands on it. `--return` hands the branch back.
//
// CORE'S OWN WORK IS PARKED, NEVER STASHED. The stash stack is shared by every
// worktree and every session, so a stash pushed here can be popped by somebody
// else. Uncommitted work in core -- untracked files included, ignored files
// never -- is written through a TEMPORARY INDEX into a commit object pinned at
// `refs/nen/wc-swap/parked` (so gc cannot take it), and only once that ref
// exists is core cleared (`reset --hard` + `clean -fd`, never `-x`: build
// products, IDE user data and local secrets are ignored and stay exactly where
// they are). `--return` restores modified, new and deleted paths exactly,
// nothing staged, and drops the ref.
//
// STATE LIVES IN THE COMMON GIT DIRECTORY (`nen-wc-swap.json`), never in the
// tree: it survives the checkout it describes and no `git clean` reaches it. A
// second swap while one is active keeps the FIRST swap's home, so `--return`
// always goes back to where the developer started.
//
// EXIT CODES -- the engine's own, kept:
//   0  done (or listed)
//   2  refused before anything moved: an unknown or ambiguous target, core
//      itself, no swap to return from, --take on a detached worktree, a bad
//      argument, not a checkout -- and a park ref left pinned by an interrupted
//      swap, which a second park would overwrite
//   3  a tree is dirty -- the target worktree on swap, or core on --return or
//      on a re-swap -- with every path listed; nothing moved
//   1  a git step failed part-way; the message says where, and the parked
//      commit is still pinned
// 3 IS NOT 2 on purpose, unlike `wc squash` / `wc catch-up`'s dirty refusal:
// the invocation was right, and what the caller owes is a decision about
// somebody's uncommitted work -- commit it, keep it with --take, or discard it
// -- which this verb never makes on their behalf.
//
// PATHS ARE COMPARED CANONICALLY. git prints each worktree's real path with
// forward slashes on every platform, while `--repo` and a path target arrive
// in whatever form the caller typed (a `/var` symlink on macOS, a backslash on
// Windows); ../shu/warmup.ts's samePath() states the same rule. Every path
// here goes through `resolve` and then `realpathSync.native` before it is
// compared, and git's own spelling is what is printed.

import { existsSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { ledgerLockPath, withLedgerLock, writeLedgerAtomically } from "../ledger/lock.js";
import { GIT, outputLines, type Seams } from "../seam/exec.js";
import { rawLines } from "../seam/lines.js";

export const SWAP_CONTRACT = "nen.wc.swap/v0.1";
export const WORKTREES_CONTRACT = "nen.wc.worktrees/v0.1";
export const SWAP_STATE_CONTRACT = "nen.wc.swap.state/v0.1";

/** Where core's parked work is pinned while a swap is active. */
export const PARK_REF = "refs/nen/wc-swap/parked";
/** The swap record, in the COMMON git directory. */
export const STATE_FILE = "nen-wc-swap.json";
/** The temporary index a park writes through, beside the state; removed on every path. */
const INDEX_FILE = "nen-wc-swap.index";

/** Files whose change after a swap means the IDE may ask to reload or re-resolve. */
export const RELOAD_HINT = /(^|\/)(Package\.resolved|project\.pbxproj|Podfile\.lock|Cartfile\.resolved)$/;

const PARK_MESSAGE = "nen wc swap: core's uncommitted work, parked";

/** Refused before anything moved: exit 2. */
export class SwapRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapRefusal";
  }
}

/** A git step failed part-way: exit 1. */
export class SwapStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SwapStepError";
  }
}

export type SwapMode = "view" | "take";

/** The record in the common git directory. KEY ORDER IS THE CONTRACT. */
export interface SwapState {
  readonly contract: string;
  /** The swapped-in worktree's path, as git printed it. */
  readonly target: string;
  /** The worktree's branch, or null when it was detached (view only). */
  readonly branch: string | null;
  readonly mode: SwapMode;
  /** Core's home branch before the FIRST swap, or null when core was detached. */
  readonly home: string | null;
  /** Core's HEAD before the first swap -- where a detached home returns to. */
  readonly homeSha: string;
  /** The parked commit, or null when core was clean. */
  readonly parked: string | null;
}

/** What `wc swap` in any of its forms reports. KEY ORDER IS THE CONTRACT; ./command.test.ts pins it. */
export interface SwapReport {
  readonly contract: string;
  readonly action: "swap" | "promote" | "return" | "status";
  /** The core checkout, as git names it. */
  readonly core: string;
  /** The branch core is on after this run, or null when it is detached. */
  readonly coreBranch: string | null;
  /** Core's HEAD after this run. */
  readonly head: string;
  /** True when a swap is recorded after this run. */
  readonly active: boolean;
  readonly target: string | null;
  readonly branch: string | null;
  readonly mode: SwapMode | null;
  readonly home: string | null;
  readonly homeSha: string | null;
  readonly parked: string | null;
  /** Reload-worthy files that changed between core's HEAD before and after. */
  readonly reloadHints: readonly string[];
  /** Set only on the exit-3 refusal: which checkout is dirty, and every path. */
  readonly dirty: { readonly checkout: string; readonly paths: readonly string[] } | null;
}

export type SwapOutcome =
  | { readonly kind: "done"; readonly report: SwapReport; readonly lines: readonly string[] }
  | { readonly kind: "dirty"; readonly report: SwapReport; readonly message: string };

/** One row of `wc worktrees`. KEY ORDER IS THE CONTRACT. */
export interface WorktreeRow {
  readonly path: string;
  /** `core` for the core checkout, `in` for the swapped-in worktree, else null. */
  readonly mark: "core" | "in" | null;
  readonly branch: string | null;
  readonly head: string;
  /** Uncommitted paths (untracked included); null when status could not be read. */
  readonly dirty: number | null;
  /** Commits on HEAD not on origin/<base>; null when that range does not resolve. */
  readonly ahead: number | null;
  readonly behind: number | null;
  readonly lastSubject: string | null;
  /** git's own relative age of the last commit (`%cr`). */
  readonly lastAge: string | null;
}

export interface WorktreesReport {
  readonly contract: string;
  readonly core: string;
  readonly base: string;
  readonly swap: SwapState | null;
  readonly worktrees: readonly WorktreeRow[];
}

// ── git through the seam ────────────────────────────────────────────────────

interface GitCall {
  readonly code: number;
  readonly stdout: string;
  readonly error: string;
}

function runGit(seams: Seams, cwd: string, args: readonly string[], env?: Readonly<Record<string, string>>): GitCall {
  const result = seams.run(GIT, [...args], env === undefined ? { cwd } : { cwd, env });
  const error = result.spawnFailed
    ? `git could not be started (${result.stderr.trim()}); put it on PATH`
    : outputLines(result.stderr).join(" ") || `exit ${result.code}`;
  return { code: result.spawnFailed ? 127 : result.code, stdout: result.stdout, error };
}

function mustGit(
  seams: Seams,
  cwd: string,
  args: readonly string[],
  what: string,
  env?: Readonly<Record<string, string>>,
): string {
  const result = runGit(seams, cwd, args, env);
  if (result.code !== 0) throw new SwapStepError(`${what} ('git ${args.join(" ")}' failed: ${result.error})`);
  return result.stdout;
}

/** The first line of a git answer, newline removed and nothing else touched. */
function firstLine(text: string): string {
  return rawLines(text)[0] ?? "";
}

function canonical(path: string): string {
  const absolute = resolve(path);
  try {
    return realpathSync.native(absolute);
  } catch {
    return absolute;
  }
}

// ── resolution ──────────────────────────────────────────────────────────────

export interface Core {
  /** The core checkout, canonical. */
  readonly path: string;
  /** The common git directory, as git printed it. */
  readonly commonDir: string;
}

/**
 * The core checkout of whatever project `repo` sits in -- core itself or any
 * of its worktrees. Refused (exit 2) outside a checkout, in a bare
 * repository, and where the common directory is not a checkout's `.git`.
 */
export function resolveCore(seams: Seams, repo: string): Core {
  const common = runGit(seams, repo, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) throw new SwapRefusal(`'${repo}' is not inside a git checkout (${common.error}).`);
  const bare = runGit(seams, repo, ["rev-parse", "--is-bare-repository"]);
  if (bare.code === 0 && firstLine(bare.stdout) === "true") {
    throw new SwapRefusal("a bare repository has no core checkout to swap.");
  }
  const commonDir = firstLine(common.stdout);
  if (basename(commonDir) !== ".git") {
    throw new SwapRefusal(`the common git directory '${commonDir}' is not a checkout's .git; there is no core checkout to swap.`);
  }
  return { path: canonical(dirname(commonDir)), commonDir };
}

export interface Worktree {
  /** As git printed it. */
  readonly path: string;
  readonly canonical: string;
  readonly head: string;
  readonly branch: string | null;
}

/**
 * Every worktree, core first (git lists it first), off the PORCELAIN form --
 * never the aligned human one, which stops parsing at the first path with a
 * space. A `prunable` record (its directory is gone) is skipped, as is a
 * `bare` one.
 */
export function parseWorktrees(porcelain: string): Worktree[] {
  const rows: Worktree[] = [];
  let path: string | null = null;
  let head = "";
  let branch: string | null = null;
  let skip = false;
  const flush = (): void => {
    if (path !== null && !skip) rows.push({ path, canonical: canonical(path), head, branch });
    path = null;
    head = "";
    branch = null;
    skip = false;
  };
  for (const line of rawLines(porcelain)) {
    if (line.startsWith("worktree ")) {
      flush();
      path = line.slice("worktree ".length);
    } else if (line.startsWith("HEAD ")) {
      head = line.slice("HEAD ".length);
    } else if (line.startsWith("branch ")) {
      branch = line.slice("branch ".length).replace(/^refs\/heads\//, "");
    } else if (line === "bare" || line.startsWith("prunable")) {
      skip = true;
    }
  }
  flush();
  return rows;
}

function worktrees(seams: Seams, core: Core): Worktree[] {
  return parseWorktrees(mustGit(seams, core.path, ["worktree", "list", "--porcelain"], "could not list the worktrees"));
}

/**
 * The worktree `token` names: a path (compared canonically, relative ones
 * resolved against `--repo`), else a branch or a worktree directory name.
 * A name that matches more than one worktree is refused -- pass its path.
 */
export function findTarget(rows: readonly Worktree[], token: string, repoRoot: string): Worktree {
  const asPath = isAbsolute(token) ? token : resolve(repoRoot, token);
  let pathHit: string | null = null;
  try {
    if (statSync(asPath).isDirectory()) pathHit = canonical(asPath);
  } catch {
    pathHit = null;
  }
  let hit: Worktree | null = null;
  for (const row of rows) {
    if (pathHit !== null && row.canonical === pathHit) return row;
    if (row.branch === token || basename(row.path) === token) {
      if (hit !== null) throw new SwapRefusal(`'${token}' names more than one worktree; pass its path.`);
      hit = row;
    }
  }
  if (hit === null) {
    throw new SwapRefusal(
      `no worktree matches '${token}' (a path, a branch or a worktree directory name); see 'nen wc worktrees'.`,
    );
  }
  return hit;
}

// ── state ───────────────────────────────────────────────────────────────────

function statePath(core: Core): string {
  return join(core.commonDir, STATE_FILE);
}

export function readState(core: Core): SwapState | null {
  const file = statePath(core);
  if (!existsSync(file)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    throw new SwapStepError(`the swap record '${file}' is not JSON (${error instanceof Error ? error.message : String(error)}); read it, put core back by hand, and delete it.`);
  }
  const record = parsed as Partial<SwapState>;
  if (
    record.contract !== SWAP_STATE_CONTRACT ||
    typeof record.target !== "string" ||
    (record.mode !== "view" && record.mode !== "take") ||
    typeof record.homeSha !== "string" ||
    // OPTIONAL FIELDS ARE A STRING OR null, NEVER COERCED (Copilot on #242):
    // a damaged `parked: 123` read as null would skip the unpark and drop the
    // record with the parked ref still pinned, and a damaged `home` would
    // return core somewhere it never was.
    !stringOrNull(record.branch) ||
    !stringOrNull(record.home) ||
    !stringOrNull(record.parked)
  ) {
    throw new SwapStepError(`the swap record '${file}' is not a ${SWAP_STATE_CONTRACT} document; read it, put core back by hand, and delete it.`);
  }
  return {
    contract: SWAP_STATE_CONTRACT,
    target: record.target,
    branch: record.branch ?? null,
    mode: record.mode,
    home: record.home ?? null,
    homeSha: record.homeSha,
    parked: record.parked ?? null,
  };
}

function stringOrNull(value: unknown): value is string | null {
  return value === null || typeof value === "string";
}

/** Through a temp file and a rename, so a reader never sees a torn record (../ledger/lock.ts). */
function writeState(core: Core, state: SwapState): void {
  writeLedgerAtomically(statePath(core), state);
}

function clearState(core: Core): void {
  rmSync(statePath(core), { force: true });
}

// ── reads ───────────────────────────────────────────────────────────────────

/** Every uncommitted path (untracked included), as `git status --porcelain` lines. */
export function dirtyPaths(seams: Seams, cwd: string): string[] {
  const status = mustGit(
    seams,
    cwd,
    ["-c", "core.quotePath=false", "status", "--porcelain", "--untracked-files=all"],
    `could not read the status of '${cwd}'`,
  );
  return rawLines(status);
}

function headOf(seams: Seams, cwd: string): string {
  return firstLine(mustGit(seams, cwd, ["rev-parse", "HEAD"], `could not read HEAD in '${cwd}'`));
}

function branchOf(seams: Seams, cwd: string): string | null {
  const ref = runGit(seams, cwd, ["symbolic-ref", "-q", "--short", "HEAD"]);
  return ref.code === 0 ? firstLine(ref.stdout) || null : null;
}

function parkRefExists(seams: Seams, core: Core): string | null {
  const ref = runGit(seams, core.path, ["rev-parse", "-q", "--verify", PARK_REF]);
  return ref.code === 0 ? firstLine(ref.stdout) : null;
}

// ── parking ─────────────────────────────────────────────────────────────────

/**
 * Write core's uncommitted work to a commit pinned at PARK_REF; null when
 * core is clean. Through a TEMPORARY index, so core's own index is never
 * touched here, and `add -A` honours .gitignore -- an ignored file is never
 * parked, and so never cleared.
 */
export function park(seams: Seams, core: Core): string | null {
  if (dirtyPaths(seams, core.path).length === 0) return null;
  const index = join(core.commonDir, INDEX_FILE);
  rmSync(index, { force: true });
  const env = { GIT_INDEX_FILE: index };
  let tree: string;
  try {
    mustGit(seams, core.path, ["read-tree", "HEAD"], "could not seed the temporary index", env);
    mustGit(seams, core.path, ["add", "-A", "."], "could not add core's work to the temporary index", env);
    tree = firstLine(mustGit(seams, core.path, ["write-tree"], "could not write the parked tree", env));
  } finally {
    rmSync(index, { force: true });
  }
  const sha = firstLine(
    mustGit(seams, core.path, ["commit-tree", tree, "-p", "HEAD", "-m", PARK_MESSAGE], "could not write the parked commit"),
  );
  mustGit(seams, core.path, ["update-ref", PARK_REF, sha], `could not pin the parked commit ${sha} at ${PARK_REF}`);
  return sha;
}

/** Only once the parked commit is pinned: drop core's uncommitted work. Ignored files stay (no -x). */
function clearCore(seams: Seams, core: Core, parked: string): void {
  const why = `core's work is parked at ${parked} (${PARK_REF}) but the tree could not be cleared`;
  mustGit(seams, core.path, ["reset", "-q", "--hard"], why);
  mustGit(seams, core.path, ["clean", "-fdq"], why);
}

/** Put a parked commit's work back into core exactly: modified, new and deleted paths, nothing staged. */
export function unpark(seams: Seams, core: Core, parked: string): void {
  const base = firstLine(mustGit(seams, core.path, ["rev-parse", `${parked}^`], `could not read the parked commit's parent`));
  mustGit(seams, core.path, ["checkout", parked, "--", "."], `could not restore the parked tree`);
  const deleted = mustGit(
    seams,
    core.path,
    ["-c", "core.quotePath=false", "diff", "--name-only", "-z", "--diff-filter=D", base, parked],
    "could not list the parked deletions",
  )
    .split("\0")
    .filter((path): boolean => path !== "");
  for (const path of deleted) {
    mustGit(seams, core.path, ["rm", "-q", "--cached", "--", path], `could not re-delete '${path}'`);
    rmSync(join(core.path, path), { force: true });
  }
  mustGit(seams, core.path, ["reset", "-q"], "could not unstage the restored work");
  mustGit(seams, core.path, ["update-ref", "-d", PARK_REF], `could not drop ${PARK_REF}`);
}

// ── reports ─────────────────────────────────────────────────────────────────

function report(
  seams: Seams,
  core: Core,
  action: SwapReport["action"],
  state: SwapState | null,
  extra: { reloadHints?: readonly string[]; dirty?: SwapReport["dirty"] } = {},
): SwapReport {
  return {
    contract: SWAP_CONTRACT,
    action,
    core: core.path,
    coreBranch: branchOf(seams, core.path),
    head: headOf(seams, core.path),
    active: state !== null,
    target: state?.target ?? null,
    branch: state?.branch ?? null,
    mode: state?.mode ?? null,
    home: state?.home ?? null,
    homeSha: state?.homeSha ?? null,
    parked: state?.parked ?? null,
    reloadHints: extra.reloadHints ?? [],
    dirty: extra.dirty ?? null,
  };
}

function homeLabel(state: SwapState): string {
  return state.home ?? `(detached at ${state.homeSha.slice(0, 9)})`;
}

function dirtyOutcome(
  seams: Seams,
  core: Core,
  action: SwapReport["action"],
  state: SwapState | null,
  checkout: string,
  paths: readonly string[],
  message: string,
): SwapOutcome {
  return { kind: "dirty", report: report(seams, core, action, state, { dirty: { checkout, paths } }), message };
}

// ── the verbs ───────────────────────────────────────────────────────────────

/** `wc swap --status`: the recorded swap, or "no swap active". */
export function swapStatus(seams: Seams, repo: string): SwapOutcome {
  const core = resolveCore(seams, repo);
  const state = readState(core);
  const done = report(seams, core, "status", state);
  const lines =
    state === null
      ? [`no swap active; core is on ${done.coreBranch ?? `(detached at ${done.head.slice(0, 9)})`}`]
      : [
          `target:  ${state.target}`,
          `branch:  ${state.branch ?? "(detached)"}`,
          `mode:    ${state.mode}`,
          `home:    ${homeLabel(state)}`,
          `homeSha: ${state.homeSha}`,
          `parked:  ${state.parked ?? "(nothing)"}`,
        ];
  return { kind: "done", report: done, lines };
}

/** Hand a taken branch back to its worktree and detach core on the same commit. */
function handBranchBack(seams: Seams, core: Core, state: SwapState): void {
  const branch = state.branch ?? "";
  mustGit(seams, core.path, ["checkout", "-q", "--detach"], `could not release '${branch}' from core`);
  mustGit(seams, state.target, ["checkout", "-q", branch], `could not hand '${branch}' back to ${state.target}; core is detached on it`);
}

/** A lock older than this is a crashed swap's; a real one on a large tree can take minutes. */
const SWAP_LOCK_STALE_MS = 600_000;

/**
 * THE WHOLE TRANSITION RUNS UNDER ONE LOCK in the common git directory
 * (Copilot on #242): the temporary index, PARK_REF and the record are shared
 * by every checkout of the project, and two swaps that both read "no swap
 * recorded" would race on all three. ../ledger/lock.ts's advisory lock is
 * reused rather than a second one written; a swap that finds it held is
 * refused at exit 2 -- nothing moved. The readers (--status, worktrees) take
 * no lock: the record is written through a rename, so they read the old
 * document or the new one, never half of one.
 */
function locked<T>(core: Core, body: () => T): T {
  try {
    return withLedgerLock(statePath(core), body, { staleMs: SWAP_LOCK_STALE_MS });
  } catch (error) {
    if (
      error instanceof Error &&
      !(error instanceof SwapRefusal) &&
      !(error instanceof SwapStepError) &&
      error.message.includes("is held by another nen run")
    ) {
      throw new SwapRefusal(
        `another 'nen wc swap' holds '${ledgerLockPath(statePath(core))}'; nothing moved. Run again once it finishes, or remove the lock if nothing holds it.`,
      );
    }
    throw error;
  }
}

/**
 * Submodules whose OWN tree is dirty (`git status --porcelain=v2`'s `S<c><m><u>`
 * field with any flag set). The park snapshots the superproject only -- a
 * gitlink, never the submodule's edits -- and the non-recursive reset/clean
 * would leave them in place, so a dirty submodule in core is refused before
 * anything moves (Copilot on #242).
 */
export function dirtySubmodules(seams: Seams, cwd: string): string[] {
  const status = mustGit(
    seams,
    cwd,
    ["-c", "core.quotePath=false", "status", "--porcelain=v2", "--untracked-files=no"],
    `could not read the submodule status of '${cwd}'`,
  );
  const paths: string[] = [];
  for (const line of rawLines(status)) {
    const fields = line.split(" ");
    const kind = fields[0];
    const sub = fields[2] ?? "";
    if ((kind !== "1" && kind !== "2") || !sub.startsWith("S") || sub === "S...") continue;
    const rest = fields.slice(kind === "1" ? 8 : 9).join(" ");
    paths.push(kind === "2" ? (rest.split("\t")[0] ?? rest) : rest);
  }
  return paths;
}

/** `wc swap <target> [--take]`. */
export function swap(seams: Seams, repo: string, token: string, take: boolean): SwapOutcome {
  const core = resolveCore(seams, repo);
  return locked(core, () => swapLocked(seams, core, repo, token, take));
}

function swapLocked(seams: Seams, core: Core, repo: string, token: string, take: boolean): SwapOutcome {
  let state = readState(core);
  const rows = worktrees(seams, core);
  let hit = findTarget(rows, token, resolve(repo));
  // WHILE A TAKE IS ACTIVE THE BRANCH IS CORE'S and the worktree it came from
  // is detached (Copilot on #242). Its branch name then resolves to core, and
  // the worktree itself reads as detached; both mean the take's own target,
  // which holds the branch again the moment it is handed back below.
  if (state !== null && state.mode === "take") {
    const taken = canonical(state.target);
    const home = rows.find((row): boolean => row.canonical === taken);
    if (home !== undefined && (hit.canonical === taken || (hit.canonical === core.path && token === state.branch))) {
      hit = { ...home, branch: state.branch };
    }
  }
  if (hit.canonical === core.path) {
    throw new SwapRefusal(`'${token}' is the core checkout itself; there is nothing to swap in.`);
  }
  if (take && hit.branch === null) {
    throw new SwapRefusal(`--take moves a branch, and '${hit.path}' is detached.`);
  }

  const targetDirty = dirtyPaths(seams, hit.path);
  if (targetDirty.length > 0) {
    return dirtyOutcome(
      seams,
      core,
      "swap",
      state,
      hit.path,
      targetDirty,
      `the worktree '${hit.path}' has uncommitted changes; only committed work travels. Commit them there, then swap again:`,
    );
  }

  let home: string | null;
  let homeSha: string;
  let parked: string | null;
  let reloadFrom: string | null = null;
  if (state !== null) {
    // A RE-SWAP: core must hold nothing new, and the home stays the first swap's.
    const coreDirty = dirtyPaths(seams, core.path);
    if (coreDirty.length > 0 && take && state.mode === "view" && headOf(seams, core.path) === hit.head) {
      // PROMOTE A VIEW TO A TAKE IN PLACE: the same commit, so the checkout keeps core's edits.
      const branch = hit.branch ?? "";
      mustGit(seams, hit.path, ["checkout", "-q", "--detach"], `could not detach '${hit.path}' to hand its branch over`);
      const moved = runGit(seams, core.path, ["checkout", "-q", branch]);
      if (moved.code !== 0) {
        runGit(seams, hit.path, ["checkout", "-q", branch]);
        throw new SwapStepError(`could not check '${branch}' out in core (${moved.error}); the worktree has it back.`);
      }
      const promoted: SwapState = { ...state, target: hit.path, branch, mode: "take" };
      writeState(core, promoted);
      return {
        kind: "done",
        report: report(seams, core, "promote", promoted),
        lines: [
          `core now holds '${branch}' from ${hit.path} (take, promoted in place; your uncommitted edits stay and will commit onto '${branch}').`,
        ],
      };
    }
    if (coreDirty.length > 0) {
      return dirtyOutcome(
        seams,
        core,
        "swap",
        state,
        core.path,
        coreDirty,
        `core has uncommitted changes made while swapped; they belong to no branch. Keep them with 'nen wc swap ${hit.branch ?? hit.path} --take' (same commit, promoted in place) or discard them, then swap again:`,
      );
    }
    if (state.mode === "take") {
      handBranchBack(seams, core, state);
      state = { ...state, mode: "view" };
      writeState(core, state);
      // The branch is back in its worktree -- with any commit made in core on
      // it -- so the target's HEAD is re-read, never the pre-hand-back one.
      const fresh = worktrees(seams, core).find((row): boolean => row.canonical === hit.canonical);
      if (fresh !== undefined) hit = fresh;
    }
    home = state.home;
    homeSha = state.homeSha;
    parked = state.parked;
  } else {
    // A FIRST SWAP. A park ref with no swap recorded is an interrupted swap's
    // parked work, and parking again would overwrite the only pointer to it.
    const stranded = parkRefExists(seams, core);
    if (stranded !== null) {
      throw new SwapRefusal(
        `${PARK_REF} already pins ${stranded}, and no swap is recorded: an earlier swap stopped part-way. Recover that work with 'git checkout ${stranded} -- .' in core, then 'git update-ref -d ${PARK_REF}', and swap again.`,
      );
    }
    const submodules = dirtySubmodules(seams, core.path);
    if (submodules.length > 0) {
      return dirtyOutcome(
        seams,
        core,
        "swap",
        null,
        core.path,
        submodules,
        "core has a submodule with uncommitted changes inside it; a park holds the superproject only, so they could be neither kept nor cleared. Commit or discard them inside the submodule, then swap again:",
      );
    }
    home = branchOf(seams, core.path);
    homeSha = headOf(seams, core.path);
    parked = park(seams, core);
    if (parked !== null) {
      clearCore(seams, core, parked);
      const left = dirtyPaths(seams, core.path);
      if (left.length > 0) {
        throw new SwapStepError(
          `core's work is parked at ${parked} (${PARK_REF}) but core is still dirty after clearing (${left.join(", ")}); nothing was checked out. 'git checkout ${parked} -- .' restores the parked work.`,
        );
      }
      // What the IDE saw before the swap was the parked tree, not HEAD's.
      reloadFrom = parked;
    }
  }

  const before = headOf(seams, core.path);
  reloadFrom ??= before;
  let mode: SwapMode;
  if (take) {
    const branch = hit.branch ?? "";
    mustGit(seams, hit.path, ["checkout", "-q", "--detach"], `could not detach '${hit.path}' to hand its branch over`);
    const moved = runGit(seams, core.path, ["checkout", "-q", branch]);
    if (moved.code !== 0) {
      runGit(seams, hit.path, ["checkout", "-q", branch]);
      throw new SwapStepError(
        `could not check '${branch}' out in core (${moved.error}); the worktree has it back.${parked === null ? "" : ` Core's work is parked at ${parked} (${PARK_REF}).`}`,
      );
    }
    mode = "take";
  } else {
    mustGit(
      seams,
      core.path,
      ["checkout", "-q", "--detach", hit.head],
      `could not check out ${hit.head} in core${parked === null ? "" : `; core's work is parked at ${parked} (${PARK_REF})`}`,
    );
    mode = "view";
  }
  const next: SwapState = { contract: SWAP_STATE_CONTRACT, target: hit.path, branch: hit.branch, mode, home, homeSha, parked };
  writeState(core, next);

  // RELOAD HINTS ARE WHAT THE IDE SAW CHANGE (Copilot on #242): from the tree
  // it had open -- the parked one on a first swap from a dirty core, HEAD
  // otherwise -- to the tree it has now.
  const after = headOf(seams, core.path);
  const reloadHints = reloadFrom === after
    ? []
    : rawLines(
        mustGit(seams, core.path, ["-c", "core.quotePath=false", "diff", "--name-only", reloadFrom, after], "could not list what the swap changed"),
      ).filter((path): boolean => RELOAD_HINT.test(path));
  const done = report(seams, core, "swap", next, { reloadHints });
  const lines = [`core now holds '${hit.branch ?? hit.head}' from ${hit.path} (${mode}, ${done.head.slice(0, 9)}).`];
  if (parked !== null) lines.push(`core's uncommitted work is parked at ${parked.slice(0, 9)} (${PARK_REF}); 'nen wc swap --return' restores it.`);
  if (reloadHints.length > 0) {
    lines.push("project or dependency files changed -- the IDE may ask to reload or re-resolve packages:");
    for (const path of reloadHints) lines.push(`  ${path}`);
  }
  return { kind: "done", report: done, lines };
}

/** `wc swap --return`. */
export function swapReturn(seams: Seams, repo: string): SwapOutcome {
  const core = resolveCore(seams, repo);
  return locked(core, () => swapReturnLocked(seams, core));
}

function swapReturnLocked(seams: Seams, core: Core): SwapOutcome {
  const state = readState(core);
  if (state === null) {
    const branch = branchOf(seams, core.path);
    throw new SwapRefusal(`no swap is active; core is on ${branch ?? `(detached at ${headOf(seams, core.path).slice(0, 9)})`}.`);
  }
  const coreDirty = dirtyPaths(seams, core.path);
  if (coreDirty.length > 0) {
    const branch = state.branch ?? state.target;
    const message =
      state.mode === "take"
        ? `core has uncommitted changes on '${branch}'. Commit them (they land on '${branch}') or discard them, then return:`
        : `core has uncommitted changes made while viewing '${branch}'; they belong to no branch. Discard them, or 'nen wc swap ${branch} --take' and commit, then return:`;
    return dirtyOutcome(seams, core, "return", state, core.path, coreDirty, message);
  }
  if (state.mode === "take") handBranchBack(seams, core, state);
  if (state.home === null) {
    mustGit(seams, core.path, ["checkout", "-q", "--detach", state.homeSha], `could not return core to ${state.homeSha}`);
  } else {
    mustGit(seams, core.path, ["checkout", "-q", state.home], `could not return core to '${state.home}'`);
  }
  if (state.parked !== null) {
    try {
      unpark(seams, core, state.parked);
    } catch (error) {
      throw new SwapStepError(
        `core is home but its parked work at ${state.parked} (${PARK_REF}) did not restore (${error instanceof Error ? error.message : String(error)}); 'git checkout ${state.parked} -- .' recovers it.`,
      );
    }
  }
  clearState(core);
  const done = report(seams, core, "return", null);
  // The report after a return carries what WAS undone, so a caller can say it.
  const returned: SwapReport = { ...done, target: state.target, branch: state.branch, mode: state.mode, home: state.home, homeSha: state.homeSha, parked: state.parked };
  return {
    kind: "done",
    report: returned,
    lines: [`core is back on '${homeLabel(state)}'${state.parked === null ? "" : ", its uncommitted work restored"}.`],
  };
}

/** `wc worktrees`. */
export function listWorktrees(seams: Seams, repo: string, base: string): { report: WorktreesReport; lines: string[] } {
  const core = resolveCore(seams, repo);
  const state = readState(core);
  const target = state === null ? null : canonical(state.target);
  const rows: WorktreeRow[] = worktrees(seams, core).map((row): WorktreeRow => {
    const status = runGit(seams, row.path, ["status", "--porcelain", "--untracked-files=all"]);
    const counts = runGit(seams, row.path, ["rev-list", "--left-right", "--count", `origin/${base}...${row.head}`]);
    const split = /^(\d+)\s+(\d+)$/.exec(firstLine(counts.stdout));
    const last = runGit(seams, row.path, ["log", "-1", "--format=%s%x00%cr", row.head]);
    const [subject, age] = last.code === 0 ? firstLine(last.stdout).split("\0") : [];
    return {
      path: row.path,
      mark: row.canonical === core.path ? "core" : row.canonical === target ? "in" : null,
      branch: row.branch,
      head: row.head,
      dirty: status.code === 0 ? rawLines(status.stdout).length : null,
      ahead: counts.code === 0 && split !== null ? Number(split[2]) : null,
      behind: counts.code === 0 && split !== null ? Number(split[1]) : null,
      lastSubject: subject ?? null,
      lastAge: age ?? null,
    };
  });
  const pad = (text: string, width: number): string => text.padEnd(width);
  const lines = [
    `${pad("", 4)} ${pad("BRANCH", 44)} ${pad("DIRTY", 9)} ${pad(`±${base}`, 7)} ${pad("HEAD", 9)} LAST COMMIT · PATH`,
    ...rows.map((row): string => {
      const distance = row.ahead === null || row.behind === null ? "?" : `+${row.ahead}/-${row.behind}`;
      const last = row.lastSubject === null ? "?" : `${row.lastSubject} (${row.lastAge ?? "?"})`;
      return `${pad(row.mark ?? "", 4)} ${pad(row.branch ?? "(detached)", 44)} ${pad(row.dirty === null ? "?" : String(row.dirty), 9)} ${pad(distance, 7)} ${pad(row.head.slice(0, 9), 9)} ${last} · ${row.path}`;
    }),
  ];
  if (state !== null) lines.push(`core is holding ${state.target} (${state.mode}); home: ${homeLabel(state)}`);
  return { report: { contract: WORKTREES_CONTRACT, core: core.path, base, swap: state, worktrees: rows }, lines };
}
