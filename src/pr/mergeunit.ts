// src/pr/mergeunit.ts -- `nen pr merge <ref> --release-unit`: the ONE bounded
// merge this binary performs, and the only one it ever will.
//
// "MADE DETERMINISTIC" (maintainer's ruling, 2026-09-26). Deciding whether a
// release-unit pull request is safe to merge used to mean a human re-reading
// three separate reports by eye -- readiness, body template, changed-path
// membership -- and then typing `gh pr merge` themselves. Each of those three
// is already a nen verb with its own deterministic verdict; this module is
// the conjunction of the three IN-PROCESS (never a subprocess re-invoking
// this same binary), gated behind `--release-unit` so it can never become a
// general-purpose merge command by accident.
//
// EVERY VERDICT LINE IS PRINTED VERBATIM. `pr ready`'s `gateLine`, `pr
// body-check`'s per-requirement lines, and `release unit-check`'s own
// rendering are quoted, not paraphrased -- a consumer reading this verb's
// output sees the exact sentence the underlying verb would have printed on
// its own.
//
// NEVER `--admin`, NEVER `--auto`. This verb's flag set declares no such
// flags, so passing either is an unknown-option refusal at the CLI's own
// parse stage (exit 2) before this module ever runs -- there is no code path
// here that could add them to the `gh pr merge` argv.
//
// PINNED TO ONE HEAD (Feitan F7). `pr ready`'s own verdict names the exact
// commit it judged (`judgedHead`); every OTHER gate in this composition (the
// body, the changed-path membership, whose pull request this is) reads the
// SAME commit's data, fetched in the ONE `gh pr view` call this module makes
// of its own -- never a second, independent read that could observe a push
// landing between two gates. `gh pr merge ... --match-head-commit
// <judgedHead>` then makes GitHub itself refuse the merge if the head moved
// again after this module's own read, which is the one moment this module
// cannot close by reading twice.
//
// THE RELEASE POLICY IS THE PR'S BASE'S, NOT THIS CHECKOUT'S (Feitan FEI-3).
// A local `nen/workflow.json` is whatever this checkout happens to have on
// disk -- possibly a stale clone, possibly a branch that edited the very
// policy it is being judged against. `release.unitPaths` is read from
// `nen/workflow.json` AT THE PULL REQUEST'S BASE COMMIT over the GitHub API,
// and a pull request that itself touches `nen/workflow.json` or
// `nen/gates.json` is refused outright -- the policy a merge is judged
// against must not be a policy that merge itself is changing.

import { checkBody, type BodyRequirement } from "./bodycheck.js";
import {
  assembleUnitCheck,
  fetchChangedFiles,
  renderUnitCheck,
  resolvePrRef,
  resolveUnitCheckTarget,
  UnitCheckRefError,
  UnitCheckTruncatedError,
  type ChangedFile,
  type ResolvedPrRef,
} from "../release/unitcheck.js";
import { parseWorkflow } from "../schema/workflow.js";
import { SchemaError } from "../schema/errors.js";
import { GH, must, mustJson, redactRemoteCredentials, ToolError, type Seams } from "../seam/exec.js";
import type { Io, PrReadyDeps, PrReadyInput } from "../verbs/pr_ready.js";
import { prReady, defaultDeps } from "../verbs/pr_ready.js";
import { targetFromRemote, TargetError, type Target } from "../github/target.js";

export const MERGE_UNIT_CONTRACT = "nen.pr.merge-unit/v0.1";

/** `gh pr merge` refused (branch protection, a required review, ...). Distinct from every other code this family uses. */
export const EXIT_GH_REFUSED = 5;

/**
 * `gh pr merge` could not be STARTED at all -- no `gh` on PATH, no
 * permission. Distinct from `EXIT_GH_REFUSED` (F8(b)): the first is "the tool
 * refused", the second is "the tool could not be run", and a caller's retry
 * policy needs to tell the two apart the same way every other family in this
 * binary already does (../shu/exit.ts's `EXIT_TOOL_NOT_INSTALLED`).
 */
export const EXIT_GH_NOT_RUNNABLE = 6;

export class MergeUnitUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MergeUnitUsageError";
  }
}

interface GateOutcome {
  readonly name: string;
  readonly ok: boolean;
  readonly lines: readonly string[];
}

export interface MergeUnitReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  readonly ready: boolean;
  readonly bodyOk: boolean;
  readonly unitOk: boolean;
  readonly pinOk: boolean;
  readonly wholeOk: boolean;
  readonly ok: boolean;
  readonly ran: boolean;
  /** True when `gh pr merge` could not be started at all (F8(b)); `ran` stays false either way. */
  readonly spawnFailed: boolean;
  readonly mergeArgv: readonly string[] | null;
  /** GitHub's head at the moment this module read it -- `null` when it was never resolved. */
  readonly judgedHead: string | null;
  /**
   * The pull request's state after a successful `gh pr merge` exit, read back
   * over a second `gh pr view` (Feitan FEI-5) -- `"MERGED"` only when GitHub
   * says so; `null` before a merge was attempted, or when the attempt did not
   * exit 0.
   */
  readonly state: string | null;
  readonly gates: readonly GateOutcome[];
}

/** `stderr`/thrown-error text, with any credential redacted, exactly as every other echo site in this binary does (Feitan FEI-6). */
function redact(text: string): string {
  return redactRemoteCredentials(text);
}

/** A capturing `Io`, so `pr ready`'s own `--json` rendering can be read back as a value rather than reparsed off real stdout. */
function captureIo(): { readonly io: Io; readonly outLines: string[]; readonly errLines: string[] } {
  const outLines: string[] = [];
  const errLines: string[] = [];
  return {
    io: { out: (line): void => void outLines.push(line), err: (line): void => void errLines.push(line) },
    outLines,
    errLines,
  };
}

export interface RunReadyGate {
  readonly target: Target;
  readonly prNumber: number;
  readonly repoFlag: string | null;
  readonly ghRepoFlag: string;
  readonly seams: Seams;
  readonly deps?: PrReadyDeps;
}

export interface ReadyGateOutcome extends GateOutcome {
  /** The head commit `pr ready` judged this pull request against, or `null` when it could not read one. */
  readonly judgedHead: string | null;
}

/**
 * Runs `pr ready` IN-PROCESS -- the same `prReady()` function
 * ../pr/command.ts's `ready()` adapter calls, never a re-spawned `nen pr
 * ready` subprocess -- and reads its `--json` report back as a value.
 *
 * The ref is passed as a BARE NUMBER with `--gh-repo` naming the repository
 * explicitly, which `resolveRef` (../verbs/pr_ready.ts) accepts without any
 * product-code lookup: this module already resolved the target and number
 * itself (../release/unitcheck.ts's `resolveUnitCheckTarget`), so a second,
 * independent code-registry resolution here would risk the two halves of
 * this one merge disagreeing about which pull request they mean.
 *
 * F8(c): `pr ready`'s own STDERR is captured too (not discarded), and every
 * line it printed rides along in this gate's own `lines` -- a caller reading
 * the merge gate's transcript sees exactly what `pr ready` would have printed
 * standalone, diagnostics included.
 */
export async function runReadyGate(options: RunReadyGate): Promise<ReadyGateOutcome> {
  const captured = captureIo();
  const input: PrReadyInput = {
    // A BARE NUMBER, with `--gh-repo` naming the repository explicitly: the
    // `<owner>/<name>#<n>` spelling is refused by `resolveRef`'s own grammar
    // (the code group admits no '/'), and this module already resolved the
    // target itself -- a second, independent code-registry resolution here
    // would risk disagreeing with the first about which pull request this is.
    positionals: ["pr", "ready", String(options.prNumber)],
    values: { "gh-repo": options.ghRepoFlag },
    booleans: new Set(["json"]),
    repoFlag: options.repoFlag,
  };
  await prReady(input, captured.io, options.deps ?? defaultDeps);
  const raw = captured.outLines.join("");
  let parsed: { readonly verdict?: string; readonly gateLine?: string; readonly message?: string; readonly judgedHead?: string | null };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return {
      name: "pr ready",
      ok: false,
      judgedHead: null,
      lines: [`pr ready: could not read its own --json report (${redact(raw)})`, ...captured.errLines.map(redact)],
    };
  }
  const line = parsed.gateLine ?? parsed.message ?? "(no verdict line)";
  return {
    name: "pr ready",
    ok: parsed.verdict === "ready",
    judgedHead: parsed.judgedHead ?? null,
    lines: [`pr ready: ${line}`, ...captured.errLines.map(redact)],
  };
}

/** The one `gh pr view` fetch this module makes of the pull request itself (Feitan F7/FEI-4/FEI-5). */
export interface PrOnce {
  readonly headRefOid: string;
  readonly baseRefOid: string;
  readonly body: string;
  readonly isCrossRepository: boolean;
  readonly author: { readonly login: string } | null;
  readonly state: string;
}

const PR_ONCE_FIELDS = "headRefOid,baseRefOid,body,isCrossRepository,author,state";

/**
 * Fetches the pull request ONCE (Feitan F7): `headRefOid` (compared against
 * `pr ready`'s own `judgedHead`), `baseRefOid` (the commit `release.unitPaths`
 * is read at, Feitan FEI-3), `body` (`pr body-check`'s input, read live
 * rather than a second time later), `isCrossRepository` and `author`
 * (Feitan FEI-4), and `state` (the pre-merge state, so a post-merge re-read
 * has something to compare against for Feitan FEI-5).
 */
export function fetchPrOnce(seams: Seams, target: Target, prNumber: number): PrOnce {
  return mustJson<PrOnce>(seams, GH, ["pr", "view", String(prNumber), "--repo", target.slug, "--json", PR_ONCE_FIELDS]);
}

/**
 * The head-pin gate (Feitan F7/FEI-1): a `pr ready` verdict with no judged
 * head is never trusted, and a judged head that no longer matches the ONE
 * fetch this module made of the pull request is refused BY NAME -- both SHAs
 * printed, never just "the head moved".
 */
function computePinGate(judgedHead: string | null, prOnce: PrOnce | null, fetchFailure: string | null): GateOutcome {
  if (judgedHead === null) {
    return { name: "head pin", ok: false, lines: ["head pin: 'pr ready' reported no judged head -- refused rather than merging a commit nobody's verdict is about."] };
  }
  if (fetchFailure !== null) {
    return { name: "head pin", ok: false, lines: [`head pin: ${fetchFailure}`] };
  }
  if (prOnce === null) {
    return { name: "head pin", ok: false, lines: ["head pin: the pull request was never fetched."] };
  }
  if (prOnce.headRefOid !== judgedHead) {
    return {
      name: "head pin",
      ok: false,
      lines: [
        `head pin: 'pr ready' judged ${judgedHead}, but the pull request's head is now ${prOnce.headRefOid} -- refused rather than merging a commit no gate above was decided against.`,
      ],
    };
  }
  return { name: "head pin", ok: true, lines: [`head pin: pinned to ${judgedHead}`] };
}

export interface RunBodyCheckGate {
  readonly requirements: readonly BodyRequirement[];
}

/**
 * `pr body-check`'s own pure predicate (../pr/bodycheck.ts's `checkBody`),
 * fed the pull request's body from the ONE fetch this module made -- never a
 * second `gh pr view` call, so the body a merge is judged against is
 * provably the same commit's body the head-pin gate compared.
 */
export function runBodyCheckGate(prOnce: PrOnce | null, fetchFailure: string | null, options: RunBodyCheckGate): GateOutcome {
  if (prOnce === null) {
    return { name: "pr body-check", ok: false, lines: [`pr body-check: ${fetchFailure ?? "the pull request was never fetched."}`] };
  }
  const report = checkBody(prOnce.body, options.requirements);
  const satisfiedCount = report.results.filter((result): boolean => result.satisfied).length;
  return {
    name: "pr body-check",
    ok: report.ok,
    lines: [
      `pr body-check: ${satisfiedCount}/${report.results.length} requirement(s) satisfied`,
      ...report.results.map((result): string => `  ${result.satisfied ? "ok" : "MISSING"}  ${result.name}`),
    ],
  };
}

/** Refuses `isCrossRepository`, and refuses an author that is not the viewer (Feitan FEI-4). No branch-name rule. */
export function runWhoseGate(seams: Seams, prOnce: PrOnce | null, fetchFailure: string | null): GateOutcome {
  if (prOnce === null) {
    return { name: "whose pr", ok: false, lines: [`whose pr: ${fetchFailure ?? "the pull request was never fetched."}`] };
  }
  if (prOnce.isCrossRepository) {
    return { name: "whose pr", ok: false, lines: ["whose pr: this pull request is cross-repository (a fork's branch) -- refused."] };
  }
  let viewer: string;
  try {
    const result = must(seams, GH, ["api", "user", "--jq", ".login"]);
    viewer = result.stdout.trim();
  } catch (error) {
    if (error instanceof ToolError) return { name: "whose pr", ok: false, lines: [`whose pr: could not read the viewer's own login (${redact(error.message)})`] };
    throw error;
  }
  const authorLogin = prOnce.author?.login ?? null;
  if (authorLogin !== viewer) {
    return {
      name: "whose pr",
      ok: false,
      lines: [`whose pr: this pull request's author is '${authorLogin ?? "(none)"}', but the viewer authenticated as '${viewer}' -- refused.`],
    };
  }
  return { name: "whose pr", ok: true, lines: [`whose pr: authored by the viewer ('${viewer}'), same repository`] };
}

interface ContentsResponse {
  readonly content?: string;
  readonly encoding?: string;
}

/**
 * `release.unitPaths` read from `nen/workflow.json` AT THE PULL REQUEST'S
 * BASE COMMIT (Feitan FEI-3), never this checkout's own local file -- a local
 * clone may be stale, and a branch that itself edits the release policy must
 * not be judged against its own edit. Reuses ../schema/workflow.ts's own
 * `parseWorkflow`, which already takes a parsed value rather than a path, so
 * no second policy parser exists anywhere in this binary.
 */
function fetchBaseReleasePolicy(
  seams: Seams,
  target: Target,
  baseRefOid: string,
): { readonly ok: true; readonly unitPaths: readonly string[] } | { readonly ok: false; readonly message: string } {
  let response;
  try {
    response = must(seams, GH, ["api", `repos/${target.slug}/contents/nen/workflow.json?ref=${baseRefOid}`]);
  } catch (error) {
    if (error instanceof ToolError) {
      return {
        ok: false,
        message: `could not read 'nen/workflow.json' at the pull request's base (${baseRefOid}) -- ${redact(error.message)}`,
      };
    }
    throw error;
  }
  let parsed: ContentsResponse;
  try {
    parsed = JSON.parse(response.stdout) as ContentsResponse;
  } catch {
    return { ok: false, message: "gh answered something that is not JSON for 'nen/workflow.json' at the base." };
  }
  if (parsed.content === undefined) {
    return { ok: false, message: "'nen/workflow.json' at the base has no readable content (it may be a directory or a submodule entry)." };
  }
  let text: string;
  try {
    text = Buffer.from(parsed.content, "base64").toString("utf8");
  } catch {
    return { ok: false, message: "'nen/workflow.json' at the base could not be base64-decoded." };
  }
  let rawJson: unknown;
  try {
    rawJson = JSON.parse(text);
  } catch (error) {
    return { ok: false, message: `'nen/workflow.json' at the base (${baseRefOid}) is not valid JSON (${error instanceof Error ? error.message : String(error)}).` };
  }
  let workflow;
  try {
    workflow = parseWorkflow(`${target.slug}@${baseRefOid}:nen/workflow.json`, rawJson);
  } catch (error) {
    if (error instanceof SchemaError) return { ok: false, message: error.message };
    throw error;
  }
  if (workflow.release.unitPaths === null) {
    return {
      ok: false,
      message: `'nen/workflow.json' at the base (${baseRefOid}) declares no 'release.unitPaths' -- add it, e.g. {"release": {"unitPaths": ["src/my-unit/**"]}}.`,
    };
  }
  return { ok: true, unitPaths: workflow.release.unitPaths };
}

/**
 * The recursive git trees API silently caps its response and reports
 * `truncated: true` rather than an error -- a mode check run over a
 * truncated tree could miss the very entry it exists to catch, so this is
 * refused rather than treated as "no bad mode found" (Feitan FEI-8 / gate
 * failing closed).
 */
export class TreeTruncatedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeTruncatedError";
  }
}

/** `repos/{slug}/git/trees/<sha>?recursive=1`, keyed by path, for the mode check FEI-8 wants. */
function fetchTreeModes(seams: Seams, target: Target, sha: string): ReadonlyMap<string, string> {
  const tree = mustJson<{
    readonly tree?: readonly { readonly path?: string; readonly mode?: string }[];
    readonly truncated?: boolean;
  }>(seams, GH, ["api", `repos/${target.slug}/git/trees/${sha}?recursive=1`]);
  if (tree.truncated === true) {
    throw new TreeTruncatedError(
      `'${target.slug}'@${sha}'s recursive tree is truncated (GitHub's own cap on this endpoint) -- a mode check over an incomplete tree could miss the very entry it exists to catch, so this is refused rather than reported as clean.`,
    );
  }
  const modes = new Map<string, string>();
  for (const entry of tree.tree ?? []) {
    if (entry.path !== undefined && entry.mode !== undefined) modes.set(entry.path, entry.mode);
  }
  return modes;
}

/** GitHub's own git object modes for a symlink and a submodule (gitlink) entry (Feitan FEI-8). */
const SYMLINK_MODE = "120000";
const SUBMODULE_MODE = "160000";

export interface RunUnitCheckGate {
  readonly target: Target;
  readonly prNumber: number;
  readonly seams: Seams;
  readonly prOnce: PrOnce | null;
  readonly fetchFailure: string | null;
}

/**
 * `release unit-check`'s own composition (../release/unitcheck.ts), reused
 * whole, except the policy is the PR's base's (Feitan FEI-3, `fetchBaseReleasePolicy`
 * above) rather than this checkout's local file, the policy files themselves
 * are refused as changed paths (Feitan FEI-3 item 5), and a changed path
 * whose git mode is a symlink or a submodule is refused (Feitan FEI-8).
 */
export function runUnitCheckGate(options: RunUnitCheckGate): GateOutcome {
  if (options.prOnce === null) {
    return { name: "release unit-check", ok: false, lines: [`release unit-check: ${options.fetchFailure ?? "the pull request was never fetched."}`] };
  }
  const policy = fetchBaseReleasePolicy(options.seams, options.target, options.prOnce.baseRefOid);
  if (!policy.ok) {
    return { name: "release unit-check", ok: false, lines: [`release unit-check: ${policy.message}`] };
  }
  const unitPaths = policy.unitPaths;

  // F8(a): a thrown ToolError/UnitCheckTruncatedError here once escaped this
  // gate entirely and aborted the WHOLE merge run before the other gates
  // ever printed their verdict -- caught and reported as an ordinary failed
  // gate instead, so `pr ready` and `pr body-check` still run and still
  // surface whatever they found.
  let changedFiles: readonly ChangedFile[];
  try {
    changedFiles = fetchChangedFiles(options.seams, options.target, options.prNumber);
  } catch (error) {
    if (error instanceof UnitCheckTruncatedError || error instanceof ToolError) {
      return { name: "release unit-check", ok: false, lines: [`release unit-check: ${redact(error.message)}`] };
    }
    throw error;
  }

  // FEI-3 item 5: the policy this merge is judged against must not itself be
  // a file the merge changes.
  const policyFiles = new Set(["nen/workflow.json", "nen/gates.json"]);
  const touchesPolicy = changedFiles.some(
    (file): boolean => policyFiles.has(file.path) || (file.previousPath !== null && policyFiles.has(file.previousPath)),
  );
  if (touchesPolicy) {
    return {
      name: "release unit-check",
      ok: false,
      lines: ["release unit-check: this pull request changes 'nen/workflow.json' or 'nen/gates.json' -- refused. The policy a merge is judged against must not be the policy this same merge is changing."],
    };
  }

  const report = assembleUnitCheck(options.target, options.prNumber, unitPaths, changedFiles);
  const lines = renderUnitCheck(report).map((line): string => `release unit-check: ${line}`);

  // FEI-8: a changed path the unit claims by NAME may still be a symlink or a
  // submodule entry rather than an ordinary file -- neither is something
  // `outsideReleaseUnit`'s path-pattern comparison can see, since both are a
  // property of the git tree, not the path string. Both the HEAD tree and the
  // BASE tree are read: a PR that DELETES a symlink or gitlink inside the
  // unit leaves no trace of the forbidden mode at HEAD, only at BASE, and a
  // rename's PREVIOUS path is checked against the base tree the same way its
  // new path is checked against head.
  let headModes: ReadonlyMap<string, string>;
  let baseModes: ReadonlyMap<string, string>;
  try {
    headModes = fetchTreeModes(options.seams, options.target, options.prOnce.headRefOid);
    baseModes = fetchTreeModes(options.seams, options.target, options.prOnce.baseRefOid);
  } catch (error) {
    if (error instanceof ToolError || error instanceof TreeTruncatedError) {
      return { name: "release unit-check", ok: false, lines: [...lines, `release unit-check: could not read a commit's tree to check for a symlink or submodule (${redact(error.message)})`] };
    }
    throw error;
  }
  const insideUnit = changedFiles.filter((file): boolean => !report.outsideUnit.includes(file.path));
  const modeLabel = (mode: string): string => (mode === SYMLINK_MODE ? "symlink" : "submodule");
  const badModePaths: { readonly path: string; readonly mode: string }[] = [];
  for (const file of insideUnit) {
    const headMode = headModes.get(file.path);
    if (headMode === SYMLINK_MODE || headMode === SUBMODULE_MODE) badModePaths.push({ path: file.path, mode: headMode });
    const baseMode = baseModes.get(file.path);
    if (baseMode === SYMLINK_MODE || baseMode === SUBMODULE_MODE) badModePaths.push({ path: file.path, mode: baseMode });
    if (file.previousPath !== null) {
      const previousBaseMode = baseModes.get(file.previousPath);
      if (previousBaseMode === SYMLINK_MODE || previousBaseMode === SUBMODULE_MODE) {
        badModePaths.push({ path: file.previousPath, mode: previousBaseMode });
      }
    }
  }
  if (badModePaths.length > 0) {
    return {
      name: "release unit-check",
      ok: false,
      lines: [
        ...lines,
        ...badModePaths.map(
          (entry): string =>
            `release unit-check: ${JSON.stringify(entry.path)} inside the release unit is a ${modeLabel(entry.mode)} (mode ${entry.mode}), not an ordinary file -- refused.`,
        ),
      ],
    };
  }

  return { name: "release unit-check", ok: report.ok, lines };
}

export interface MergeUnitOptions {
  readonly typedRef: string;
  readonly repoFlag: string | null;
  readonly requirements: readonly BodyRequirement[];
  readonly run: boolean;
  readonly seams: Seams;
  readonly root: string;
  readonly deps?: PrReadyDeps;
}

/** Resolves `<ref>` to a target and PR number, sharing `release unit-check`'s own grammar rather than a second one. */
export function resolveMergeRef(typedRef: string): ResolvedPrRef {
  try {
    return resolvePrRef(typedRef);
  } catch (error) {
    if (error instanceof UnitCheckRefError) throw new MergeUnitUsageError(error.message);
    throw error;
  }
}

/**
 * Resolves the ref's target AND asserts (Feitan FEI-9 / item 7) that
 * `--repo`'s own `origin` remote names the SAME repository the ref names --
 * a typed `owner/name#n` that does not match the checkout `--repo` points at
 * is a caller error (which checkout did you mean?), not a merge-gate
 * failure.
 */
function resolveTargetForMerge(seams: Seams, root: string, ref: ResolvedPrRef): Target {
  const target = ((): Target => {
    try {
      return resolveUnitCheckTarget(seams, root, ref);
    } catch (error) {
      if (error instanceof UnitCheckRefError) throw new MergeUnitUsageError(error.message);
      throw error;
    }
  })();
  if (ref.slug === null) return target;
  let origin: Target;
  try {
    origin = targetFromRemote(seams, root);
  } catch (error) {
    if (error instanceof TargetError) throw new MergeUnitUsageError(error.message);
    throw error;
  }
  if (origin.slug !== target.slug) {
    throw new MergeUnitUsageError(
      `'--repo' at '${root}' has an origin of '${origin.slug}', but the ref names '${target.slug}' -- these must be the same repository. Point --repo at a checkout of '${target.slug}', or drop the owner/name and let the ref resolve against this checkout's own origin.`,
    );
  }
  return target;
}

export interface MergeUnitOutcome {
  readonly report: MergeUnitReport;
  readonly lines: readonly string[];
}

/**
 * Runs every gate, in order, EVERY ONE evaluated even after an earlier one
 * fails -- the same "report the whole table" discipline
 * ../release/preflight.ts and ../pr/bodycheck.ts already hold to, so a caller
 * sees every blocker in one pass rather than fixing them one at a time.
 *
 * `gh pr merge <n> --merge --match-head-commit <judgedHead>` runs ONLY when
 * every gate passed AND `--run` was given. No other flag ever reaches that
 * argv -- see this file's header.
 */
export async function mergeUnit(options: MergeUnitOptions): Promise<MergeUnitOutcome> {
  const ref = resolveMergeRef(options.typedRef);
  const target = resolveTargetForMerge(options.seams, options.root, ref);

  const readyGate = await runReadyGate({
    target,
    prNumber: ref.number,
    repoFlag: options.repoFlag,
    ghRepoFlag: target.slug,
    seams: options.seams,
    deps: options.deps,
  });

  let prOnce: PrOnce | null = null;
  let fetchFailure: string | null = null;
  try {
    prOnce = fetchPrOnce(options.seams, target, ref.number);
  } catch (error) {
    if (error instanceof ToolError) fetchFailure = `could not fetch the pull request (${redact(error.message)})`;
    else throw error;
  }

  const pinGate = computePinGate(readyGate.judgedHead, prOnce, fetchFailure);
  const bodyGate = runBodyCheckGate(prOnce, fetchFailure, { requirements: options.requirements });
  const unitGate = runUnitCheckGate({ target, prNumber: ref.number, seams: options.seams, prOnce, fetchFailure });
  const whoseGate = runWhoseGate(options.seams, prOnce, fetchFailure);

  const gates = [readyGate, pinGate, bodyGate, unitGate, whoseGate];
  const ok = gates.every((gate): boolean => gate.ok);
  const judgedHead = readyGate.judgedHead;
  const mergeArgv =
    judgedHead === null
      ? ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge"]
      : ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge", "--match-head-commit", judgedHead];

  const lines: string[] = [];
  for (const gate of gates) lines.push(...gate.lines);

  const baseReport = {
    contract: MERGE_UNIT_CONTRACT,
    target: target.slug,
    pr: ref.number,
    ready: readyGate.ok,
    bodyOk: bodyGate.ok,
    unitOk: unitGate.ok,
    pinOk: pinGate.ok,
    wholeOk: whoseGate.ok,
    judgedHead,
  };

  if (!ok) {
    lines.push("nen pr merge: not merged -- at least one gate above did not pass.");
    return {
      report: { ...baseReport, ok: false, ran: false, spawnFailed: false, mergeArgv: null, state: null, gates },
      lines,
    };
  }

  if (!options.run) {
    lines.push(`plan only (pass --run to execute): gh ${mergeArgv.join(" ")}`);
    return {
      report: { ...baseReport, ok: true, ran: false, spawnFailed: false, mergeArgv, state: null, gates },
      lines,
    };
  }

  const result = options.seams.run(GH, mergeArgv);
  if (result.spawnFailed) {
    // F8(b): 'gh' could not be RUN at all -- distinct from gh running and
    // refusing (EXIT_GH_REFUSED below).
    lines.push(`nen pr merge: gh could not be run -- ${redact(result.stderr)}`);
    return {
      report: { ...baseReport, ok: false, ran: false, spawnFailed: true, mergeArgv, state: null, gates },
      lines,
    };
  }
  if (result.code !== 0) {
    lines.push(`nen pr merge: gh refused -- ${result.stderr.trim() === "" ? `exit ${result.code}` : redact(result.stderr.trim())}`);
    lines.push(`the exact command for a human to run once the refusal is resolved: gh ${mergeArgv.join(" ")}`);
    return {
      report: { ...baseReport, ok: false, ran: false, spawnFailed: false, mergeArgv, state: null, gates },
      lines,
    };
  }

  // Feitan FEI-5: `gh pr merge` exiting 0 is not itself proof the pull
  // request MERGED -- auto-merge and a merge queue both accept the request
  // and exit 0 immediately, before the merge itself happens. The pull
  // request's own state is re-read, and only `MERGED` is reported as merged.
  let state: string | null = null;
  try {
    const reread = mustJson<{ readonly state?: string; readonly mergedAt?: string | null }>(
      options.seams,
      GH,
      ["pr", "view", String(ref.number), "--repo", target.slug, "--json", "state,mergedAt"],
    );
    state = reread.state ?? null;
  } catch (error) {
    if (error instanceof ToolError) {
      lines.push(`nen pr merge: gh accepted the merge, but its outcome could not be confirmed (${redact(error.message)}).`);
      return {
        report: { ...baseReport, ok: true, ran: true, spawnFailed: false, mergeArgv, state: null, gates },
        lines,
      };
    }
    throw error;
  }

  if (state === "MERGED") {
    lines.push(`merged: gh ${mergeArgv.join(" ")}`);
  } else {
    lines.push(`queued (auto-merge or merge queue): gh accepted 'gh ${mergeArgv.join(" ")}', but the pull request's state is '${state ?? "(unknown)"}', not MERGED yet.`);
  }

  return {
    report: { ...baseReport, ok: true, ran: true, spawnFailed: false, mergeArgv, state, gates },
    lines,
  };
}
