// src/pr/mergedelivery.ts -- `nen pr merge <ref> --delivery`: a run's OWN
// pull request, merged into a NON-MAIN base, and nothing wider (zheref/nen#286).
//
// NARROWED BY RULING (maintainer, 2026-10-03: "Narrow to non-main bases").
// zheref/nen#286 was filed on the 2026-09-29 ruling that a run merges the PR it
// authored at its terminus. The merge-authority ruling of 2026-09-30
// (zheref/hatsu docs/ROSTER.md § Rulings of 2026-09-30 -- En never merges)
// superseded it: a merge into the trunk is the maintainer's, and a run merges
// only into its own non-main integration branch (futon's). So this form
// REFUSES, by construction and at exit 2, a pull request whose base is the
// repository's default branch or `nen/workflow.json`'s `branch.base` -- there
// is no flag that widens it, and none will be added here.
//
// `branch.base` is read TWICE OVER: from this checkout and from
// `nen/workflow.json` at the pull request's base commit (the FEI-3 route), so
// a head that edits `branch.base` cannot argue its own way past the refusal;
// an unreadable base-commit copy is "configured base unknown", exit 1.
//
// Every other gate is ../pr/mergeunit.ts's, reused rather than restated: `pr
// ready` IN-PROCESS (with `--require-head` passed through), the head pin
// against the ONE `gh pr view` this module makes, whose-pr (author is the
// viewer, never cross-repository), optionally `pr body-check`, and the same
// `executeMerge` tail -- `gh pr merge <n> --merge --match-head-commit
// <judgedHead>`, never --admin, never --auto, `merged` only on a MERGED
// re-read.
//
// THE BASE IS READ TWICE UNDER --run, ON PURPOSE. `gh pr merge` carries a head
// pin (`--match-head-commit`) but no base pin, so a retarget onto the trunk
// between this module's first read and the merge would land a trunk merge no
// gate refused. The base is re-read immediately before `gh pr merge` runs and
// the refusal is re-applied; the window that remains is the one between that
// re-read and GitHub's own merge, which nothing on this side can close.

import { runBodyCheckGate, computePinGate, executeMerge, resolveMergeRef, resolveTargetForMerge, runReadyGate, runWhoseGate, MergeUnitUsageError, type GateOutcome, type PrOnce } from "./mergeunit.js";
import type { BodyRequirement } from "./bodycheck.js";
import { DEFAULT_BASE, loadWorkflow } from "../schema/workflow.js";
import { fetchJsonAtRef, type JValue } from "../release/unitcheck.js";
import { SchemaError } from "../schema/errors.js";
import { GH, mustJson, redactRemoteCredentials, ToolError, type Seams } from "../seam/exec.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { Target } from "../github/target.js";

export const MERGE_DELIVERY_CONTRACT = "nen.pr.merge-delivery/v0.1";

/** The ruling every base refusal names, verbatim, so a transcript can be traced back to it. */
export const MERGE_AUTHORITY_RULING =
  "the maintainer's merge-authority ruling of 2026-09-30: a merge into the trunk is the maintainer's, and a run merges only into a non-main integration branch";

const SHA_PREFIX = /^[0-9a-f]{7,40}$/i;

export interface MergeDeliveryReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  /** The pull request's base branch as read, or `null` when it could not be read. */
  readonly base: string | null;
  /** True when the base was read and is neither protected name below. */
  readonly baseOk: boolean;
  readonly defaultBranch: string | null;
  readonly configuredBase: string;
  /** `branch.base` at the pull request's base commit; `null` when it could not be read (a failed base gate). */
  readonly baseCommitBase: string | null;
  readonly ready: boolean;
  readonly pinOk: boolean;
  /** `null` when no `--requirements-from` was given -- the gate did not run, which is not a pass. */
  readonly bodyOk: boolean | null;
  readonly wholeOk: boolean;
  readonly ok: boolean;
  readonly ran: boolean;
  readonly spawnFailed: boolean;
  readonly mergeArgv: readonly string[] | null;
  readonly judgedHead: string | null;
  readonly requiredHead: string | null;
  readonly state: string | null;
  readonly gates: readonly GateOutcome[];
}

export interface MergeDeliveryOutcome {
  readonly report: MergeDeliveryReport;
  readonly lines: readonly string[];
}

export interface MergeDeliveryOptions {
  readonly typedRef: string;
  readonly repoFlag: string | null;
  /** `null`: no body gate. A delivery's body is checked where it is composed; this gate is opt-in. */
  readonly requirements: readonly BodyRequirement[] | null;
  readonly requireHead: string | null;
  readonly run: boolean;
  readonly seams: Seams;
  readonly root: string;
  readonly deps?: PrReadyDeps;
}

/** `PrOnce` plus the base's NAME -- the one field the delivery form adds to the one fetch. */
interface DeliveryPrOnce extends PrOnce {
  readonly baseRefName: string;
}

const DELIVERY_PR_ONCE_FIELDS = "headRefOid,baseRefOid,baseRefName,body,isCrossRepository,author,state";

function fetchDeliveryPrOnce(seams: Seams, target: Target, prNumber: number): DeliveryPrOnce {
  return mustJson<DeliveryPrOnce>(seams, GH, ["pr", "view", String(prNumber), "--repo", target.slug, "--json", DELIVERY_PR_ONCE_FIELDS]);
}

/** GitHub answered, but named no default branch -- refused as unread, never treated as "none, so anything goes". */
class NoDefaultBranchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoDefaultBranchError";
  }
}

/** GitHub's own default branch -- the same `gh repo view` read ../runner/preflight.ts makes. */
function fetchDefaultBranch(seams: Seams, target: Target): string {
  const answer = mustJson<{ readonly defaultBranchRef?: { readonly name?: unknown } | null }>(seams, GH, [
    "repo",
    "view",
    target.slug,
    "--json",
    "defaultBranchRef",
  ]);
  const name = answer.defaultBranchRef?.name;
  if (typeof name !== "string" || name === "") throw new NoDefaultBranchError(`${target.slug} answered no default branch`);
  return name;
}

/** The protected names a base equals, in the order they are named -- empty when it equals neither. */
function protectedMatches(base: string, defaultBranch: string | null, configuredBase: string, baseCommitBase: string | null): string[] {
  const reasons: string[] = [];
  if (defaultBranch !== null && base === defaultBranch) reasons.push(`the repository's default branch ('${defaultBranch}')`);
  if (base === configuredBase) reasons.push(`this checkout's nen/workflow.json branch.base ('${configuredBase}')`);
  if (baseCommitBase !== null && base === baseCommitBase) reasons.push(`the base commit's nen/workflow.json branch.base ('${baseCommitBase}')`);
  return reasons;
}

/**
 * `branch.base` as `nen/workflow.json` states it AT THE PULL REQUEST'S BASE
 * COMMIT -- the FEI-3 route ./mergeunit.ts takes for `release.unitPaths`,
 * through ../release/unitcheck.ts's `fetchJsonAtRef`. A local checkout of the
 * head may carry an edit to `branch.base` made precisely to dodge the
 * refusal; the base commit's copy is the policy the merge would land under.
 *
 * `null` is UNKNOWN, never a pass: the file could not be read (an absent file
 * included -- the contents route answers both alike), was not JSON, or its
 * `branch.base` is not a string. Only a file that was read and states no
 * `branch.base` falls back to the schema's own default, exactly as
 * ../schema/workflow.ts's loader does.
 */
function readBaseCommitBranchBase(seams: Seams, target: Target, baseRefOid: string): string | null {
  const root = fetchJsonAtRef(seams, target, "nen/workflow.json", baseRefOid);
  if (root === null || root.kind !== "object") return null;
  const branch: JValue | undefined = root.entries.get("branch");
  if (branch === undefined) return DEFAULT_BASE;
  if (branch.kind !== "object") return null;
  const base = branch.entries.get("base");
  if (base === undefined) return DEFAULT_BASE;
  return base.kind === "string" && base.value !== "" ? base.value : null;
}

function refuseBase(target: Target, prNumber: number, base: string, reasons: readonly string[], head: string): MergeUnitUsageError {
  return new MergeUnitUsageError(
    `'pr merge --delivery' refuses ${target.slug}#${prNumber}: its base '${base}' is ${reasons.join(" and ")}. ` +
      `Per ${MERGE_AUTHORITY_RULING}. --delivery merges a run's own pull request into a non-main base only. ` +
      `The merge is the maintainer's to run: gh pr merge ${prNumber} --repo ${target.slug} --merge --match-head-commit ${head}`,
  );
}

/**
 * The `--require-head` half of the head pin: `pr ready` already refuses a
 * mismatch (no verdict, no judged head), so this only restates, on the pin
 * gate's own line, which commit the caller pinned.
 */
function pinWithRequiredHead(pin: GateOutcome, requireHead: string | null, judgedHead: string | null): GateOutcome {
  if (requireHead === null) return pin;
  if (judgedHead === null || !judgedHead.toLowerCase().startsWith(requireHead.toLowerCase())) {
    return {
      name: pin.name,
      ok: false,
      lines: [...pin.lines, `head pin: --require-head ${requireHead} is not the head 'pr ready' judged (${judgedHead ?? "none"}) -- refused.`],
    };
  }
  return { name: pin.name, ok: pin.ok, lines: [...pin.lines, `head pin: --require-head ${requireHead} matches`] };
}

/**
 * Runs the delivery form. A base equal to a protected name THROWS
 * `MergeUnitUsageError` (exit 2) before any other gate runs; a base that
 * could not be read is an ordinary failed gate (exit 1), every other gate
 * still evaluated, because "could not tell" is not the ruling's refusal.
 */
export async function mergeDelivery(options: MergeDeliveryOptions): Promise<MergeDeliveryOutcome> {
  if (options.requireHead !== null && !SHA_PREFIX.test(options.requireHead)) {
    throw new MergeUnitUsageError(`--require-head takes a commit SHA of 7 to 40 hex digits (got '${options.requireHead}').`);
  }
  const ref = resolveMergeRef(options.typedRef);
  const target = resolveTargetForMerge(options.seams, options.root, ref);

  let configuredBase: string;
  try {
    configuredBase = loadWorkflow(options.root).workflow.branch.base;
  } catch (error) {
    if (error instanceof SchemaError) throw new MergeUnitUsageError(error.message);
    throw error;
  }

  let prOnce: DeliveryPrOnce | null = null;
  let fetchFailure: string | null = null;
  try {
    prOnce = fetchDeliveryPrOnce(options.seams, target, ref.number);
  } catch (error) {
    if (error instanceof ToolError) fetchFailure = `could not fetch the pull request (${redactRemoteCredentials(error.message)})`;
    else throw error;
  }

  let defaultBranch: string | null = null;
  let defaultFailure: string | null = null;
  try {
    defaultBranch = fetchDefaultBranch(options.seams, target);
  } catch (error) {
    if (error instanceof ToolError || error instanceof NoDefaultBranchError) defaultFailure = `could not read the repository's default branch (${redactRemoteCredentials(error.message)})`;
    else throw error;
  }

  const baseCommitBase = prOnce === null ? null : readBaseCommitBranchBase(options.seams, target, prOnce.baseRefOid);

  // Any protected name the base matches refuses at exit 2 -- even when another
  // read failed, because one match is already the ruling's refusal.
  const base = prOnce?.baseRefName ?? null;
  if (prOnce !== null && base !== null) {
    const reasons = protectedMatches(base, defaultBranch, configuredBase, baseCommitBase);
    if (reasons.length > 0) throw refuseBase(target, ref.number, base, reasons, prOnce.headRefOid);
  }
  const baseGate: GateOutcome =
    fetchFailure !== null
      ? { name: "base", ok: false, lines: [`base: ${fetchFailure} -- refused rather than merging into a base nobody read.`] }
      : defaultFailure !== null
        ? { name: "base", ok: false, lines: [`base: ${defaultFailure} -- refused rather than merging into what may be the trunk.`] }
        : baseCommitBase === null
          ? {
              name: "base",
              ok: false,
              lines: [
                `base: could not read branch.base from nen/workflow.json at the pull request's base commit (${prOnce?.baseRefOid ?? "unread"}) -- the configured base is unknown, refused rather than merging into what may be the trunk.`,
              ],
            }
          : {
              name: "base",
              ok: true,
              lines: [
                `base: '${base}' is neither the default branch ('${defaultBranch}'), this checkout's branch.base ('${configuredBase}') nor the base commit's branch.base ('${baseCommitBase}') -- a non-main base`,
              ],
            };

  const readyGate = await runReadyGate({
    target,
    prNumber: ref.number,
    repoFlag: options.repoFlag,
    ghRepoFlag: target.slug,
    seams: options.seams,
    deps: options.deps,
    ...(options.requireHead === null ? {} : { requireHead: options.requireHead }),
  });
  const pinGate = pinWithRequiredHead(computePinGate(readyGate.judgedHead, prOnce, fetchFailure), options.requireHead, readyGate.judgedHead);
  const bodyGate = options.requirements === null ? null : runBodyCheckGate(prOnce, fetchFailure, { requirements: options.requirements });
  const whoseGate = runWhoseGate(options.seams, prOnce, fetchFailure);

  const gates: GateOutcome[] = [baseGate, readyGate, pinGate, ...(bodyGate === null ? [] : [bodyGate]), whoseGate];
  const ok = gates.every((gate): boolean => gate.ok);
  const judgedHead = readyGate.judgedHead;
  const mergeArgv =
    judgedHead === null
      ? ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge"]
      : ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge", "--match-head-commit", judgedHead];

  const lines: string[] = [];
  for (const gate of gates) lines.push(...gate.lines);

  const baseReport = {
    contract: MERGE_DELIVERY_CONTRACT,
    target: target.slug,
    pr: ref.number,
    base,
    baseOk: baseGate.ok,
    defaultBranch,
    configuredBase,
    baseCommitBase,
    ready: readyGate.ok,
    pinOk: pinGate.ok,
    bodyOk: bodyGate === null ? null : bodyGate.ok,
    wholeOk: whoseGate.ok,
    judgedHead,
    requiredHead: options.requireHead,
  };

  if (!ok) {
    lines.push("nen pr merge: not merged -- at least one gate above did not pass.");
    return { report: { ...baseReport, ok: false, ran: false, spawnFailed: false, mergeArgv: null, state: null, gates }, lines };
  }

  if (!options.run) {
    lines.push(`plan only (pass --run to execute): gh ${mergeArgv.join(" ")}`);
    return { report: { ...baseReport, ok: true, ran: false, spawnFailed: false, mergeArgv, state: null, gates }, lines };
  }

  // The base re-read (this file's header): `gh pr merge` has no base pin.
  let baseNow: string;
  try {
    baseNow = mustJson<{ readonly baseRefName?: string }>(options.seams, GH, [
      "pr",
      "view",
      String(ref.number),
      "--repo",
      target.slug,
      "--json",
      "baseRefName",
    ]).baseRefName ?? "";
  } catch (error) {
    if (error instanceof ToolError) {
      lines.push(`base: could not re-read the base before merging (${redactRemoteCredentials(error.message)}) -- refused.`);
      lines.push("nen pr merge: not merged -- at least one gate above did not pass.");
      return { report: { ...baseReport, baseOk: false, ok: false, ran: false, spawnFailed: false, mergeArgv: null, state: null, gates }, lines };
    }
    throw error;
  }
  const reasonsNow = protectedMatches(baseNow, defaultBranch, configuredBase, baseCommitBase);
  if (reasonsNow.length > 0) throw refuseBase(target, ref.number, baseNow, reasonsNow, judgedHead ?? "<head>");
  if (baseNow !== base) {
    lines.push(`base: the pull request was retargeted from '${base}' to '${baseNow}' after the gates above read it -- refused; run again so every gate judges the same base.`);
    lines.push("nen pr merge: not merged -- at least one gate above did not pass.");
    return { report: { ...baseReport, baseOk: false, ok: false, ran: false, spawnFailed: false, mergeArgv: null, state: null, gates }, lines };
  }

  const executed = executeMerge(options.seams, target, ref.number, mergeArgv);
  lines.push(...executed.lines);
  return {
    report: { ...baseReport, ok: executed.ok, ran: executed.ran, spawnFailed: executed.spawnFailed, mergeArgv, state: executed.state, gates },
    lines,
  };
}
