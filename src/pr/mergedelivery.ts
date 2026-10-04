// src/pr/mergedelivery.ts -- `nen pr merge <ref> --delivery`: a run's OWN
// pull request, merged into a NON-MAIN, UNPROTECTED base, and nothing wider
// (zheref/nen#286).
//
// NARROWED BY RULING (maintainer, 2026-10-03: "Narrow to non-main bases").
// zheref/nen#286 was filed on the 2026-09-29 ruling that a run merges the PR it
// authored at its terminus. The merge-authority ruling of 2026-09-30
// (zheref/hatsu docs/ROSTER.md § Rulings of 2026-09-30 -- En never merges)
// superseded it: a merge into the trunk is the maintainer's, and a run merges
// only into its own non-main integration branch (futon's). So this form
// REFUSES BY RULING -- exit 2, the whole transcript still printed and the
// `--json` document still emitted -- a pull request whose base is a PROTECTED
// NAME. There is no flag that widens it, and none will be added here.
//
// THE PROTECTED NAMES (hanten round 1 on NN#286, Feitan F2/F7):
//   * GitHub's default branch (`defaultBranchRef`);
//   * `branch.base` in THIS checkout's `nen/workflow.json`;
//   * `branch.base` in `nen/workflow.json` AT THE PR'S BASE COMMIT (the FEI-3
//     route ./mergeunit.ts takes for `release.unitPaths`) -- so a head that
//     edits `branch.base` cannot argue its own way past the refusal;
//   * `branch.base` in `nen/workflow.json` AT THE DEFAULT BRANCH;
//   * any branch GitHub reports `protected: true`, or that a ruleset targets.
// A `refs/heads/` prefix is stripped before any comparison. Every one of these
// reads that FAILS makes the base UNKNOWN: the base gate fails (exit 1),
// nothing is merged -- unless a name that WAS read already refuses (exit 2).
//
// AN AUTO-MERGE CHAIN IS REFUSED TOO (F4): an open pull request whose HEAD is
// this PR's base, aimed at a protected name with auto-merge enabled, would
// carry this merge into the trunk the moment it landed.
//
// A RUN'S OWN PR (F1) is the whose-pr gate's author/viewer check PLUS the head
// ref matching the run form of `branch.template` (base commit's policy):
// `{model}/{persona}/{descriptor}` reads as three non-empty segments.
//
// Every other gate is ../pr/mergeunit.ts's, reused rather than restated: `pr
// ready` IN-PROCESS (with `--require-head` passed through), the head pin
// against the ONE `gh pr view` this module makes, `pr body-check`, and the
// same `executeMerge` tail -- `gh pr merge <n> --merge --match-head-commit
// <judgedHead>`, never --admin, never --auto, `merged` only on a MERGED
// re-read.
//
// THE BASE IS READ THREE TIMES UNDER --run. `gh pr merge` pins the head but
// not the base, so the base is re-read immediately before the merge (a
// retarget onto a protected name is refused by ruling, any other retarget is
// a failed `base (re-read)` gate), and once more AFTER it: a merge that landed
// in a protected name, or in any base other than the one gated, is exit 7 --
// merged without authority, the maintainer must be told. The window between
// the pre-merge re-read and GitHub's own merge is the one nothing on this
// side can close; the post-merge read is what makes it loud when it bites.

import {
  runBodyCheckGate,
  computePinGate,
  executeMerge,
  resolveMergeRef,
  resolveTargetForMerge,
  runReadyGate,
  runWhoseGate,
  MergeUnitUsageError,
  type GateOutcome,
  type PrOnce,
} from "./mergeunit.js";
import type { BodyRequirement } from "./bodycheck.js";
import { DEFAULT_BASE, DEFAULT_BRANCH_TEMPLATE, loadWorkflow } from "../schema/workflow.js";
import { fetchJsonAtRef } from "../release/unitcheck.js";
import { SchemaError } from "../schema/errors.js";
import { GH, mustJson, redactRemoteCredentials, ToolError, type Seams } from "../seam/exec.js";
import type { PrReadyDeps } from "../verbs/pr_ready.js";
import type { Target } from "../github/target.js";

export const MERGE_DELIVERY_CONTRACT = "nen.pr.merge-delivery/v0.1";

/** Refused by ruling: the base is a protected name. Shares 2 with usage, told apart by the transcript's own line and `refused: true`. */
export const EXIT_REFUSED_BY_RULING = 2;

/** gh merged the pull request into a protected name, or a base other than the one gated: merged WITHOUT authority. */
export const EXIT_MERGED_OUTSIDE_AUTHORITY = 7;

/** The ruling every base refusal names, verbatim, so a transcript can be traced back to it. */
export const MERGE_AUTHORITY_RULING =
  "the maintainer's merge-authority ruling of 2026-09-30: a merge into the trunk is the maintainer's, and a run merges only into a non-main integration branch";

const SHA_PREFIX = /^[0-9a-f]{7,40}$/i;
/** A full commit object id: SHA-1 (40) or SHA-256 (64) hex. */
const OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

export interface MergeDeliveryReport {
  readonly contract: string;
  readonly target: string;
  readonly pr: number;
  /** The pull request's base branch as read (`refs/heads/` stripped), or `null` when it could not be read. */
  readonly base: string | null;
  /** True only when every base read succeeded and the base is no protected name. */
  readonly baseOk: boolean;
  /** True when the base is a protected name: refused by ruling, exit 2. */
  readonly refused: boolean;
  readonly defaultBranch: string | null;
  readonly configuredBase: string;
  /** `branch.base` at the PR's base commit; `null` when it could not be read. */
  readonly baseCommitBase: string | null;
  /** `branch.base` at the default branch; `null` when it could not be read. */
  readonly defaultBranchBase: string | null;
  /** GitHub's `protected` for the base; `null` when unread. */
  readonly baseProtected: boolean | null;
  /** How many rulesets target the base; `null` when unread. */
  readonly baseRulesets: number | null;
  readonly ready: boolean;
  readonly pinOk: boolean;
  readonly bodyOk: boolean;
  readonly wholeOk: boolean;
  readonly ok: boolean;
  readonly ran: boolean;
  readonly spawnFailed: boolean;
  readonly mergeArgv: readonly string[] | null;
  readonly judgedHead: string | null;
  readonly requiredHead: string | null;
  readonly state: string | null;
  /** The base GitHub reports AFTER a merge; `null` when no merge was confirmed. */
  readonly mergedBase: string | null;
  /** True when the merge landed in a protected name or a base other than the one gated -- exit 7. */
  readonly outsideAuthority: boolean;
  readonly gates: readonly GateOutcome[];
}

export interface MergeDeliveryOutcome {
  readonly report: MergeDeliveryReport;
  readonly lines: readonly string[];
}

export interface MergeDeliveryOptions {
  readonly typedRef: string;
  readonly repoFlag: string | null;
  readonly requirements: readonly BodyRequirement[];
  readonly requireHead: string | null;
  readonly run: boolean;
  readonly seams: Seams;
  readonly root: string;
  readonly deps?: PrReadyDeps;
}

/** `PrOnce` plus the two NAMES the delivery form adds to the one fetch. */
interface DeliveryPrOnce extends PrOnce {
  readonly baseRefName?: unknown;
  readonly headRefName?: unknown;
}

const DELIVERY_PR_ONCE_FIELDS = "headRefOid,baseRefOid,baseRefName,headRefName,body,isCrossRepository,author,state";

/** `refs/heads/main` and `main` name one branch (F7). */
export function stripHeads(name: string): string {
  return name.startsWith("refs/heads/") ? name.slice("refs/heads/".length) : name;
}

/** A branch name as GitHub answered it: a non-empty string, `refs/heads/` stripped -- or `null` (F5). */
function branchName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = stripHeads(raw.trim());
  return name === "" ? null : name;
}

/** A branch name as one URL path, each segment encoded the way ../release/unitcheck.ts encodes a contents path. */
function branchPath(name: string): string {
  return name
    .split("/")
    .map((segment): string => encodeURIComponent(segment))
    .join("/");
}

/** GitHub's own default branch -- the same `gh repo view` read ../runner/preflight.ts makes. `null` when it named none. */
function fetchDefaultBranch(seams: Seams, target: Target): string | null {
  const answer = mustJson<{ readonly defaultBranchRef?: { readonly name?: unknown } | null }>(seams, GH, [
    "repo",
    "view",
    target.slug,
    "--json",
    "defaultBranchRef",
  ]);
  return branchName(answer?.defaultBranchRef?.name);
}

/** What `nen/workflow.json` at one ref says; each field `null` when UNKNOWN, never a pass. */
interface PolicyAtRef {
  readonly branchBase: string | null;
  readonly template: string | null;
}

/**
 * `branch.base` and `branch.template` as `nen/workflow.json` states them AT
 * ONE REF, through ../release/unitcheck.ts's `fetchJsonAtRef` (the FEI-3
 * route). A file that could not be read -- an absent file included, since the
 * contents route answers both alike -- is UNKNOWN for both. A file that was
 * read and states no `branch` (or a `branch` with no such key) takes the
 * schema's own default, exactly as ../schema/workflow.ts's loader does; a
 * `branch` that is not an object, or a value that is not a non-empty string,
 * is UNKNOWN.
 */
function readPolicyAt(seams: Seams, target: Target, ref: string): PolicyAtRef {
  const root = fetchJsonAtRef(seams, target, "nen/workflow.json", encodeURIComponent(ref));
  if (root === null || root.kind !== "object") return { branchBase: null, template: null };
  const branch = root.entries.get("branch");
  if (branch === undefined) return { branchBase: DEFAULT_BASE, template: DEFAULT_BRANCH_TEMPLATE };
  if (branch.kind !== "object") return { branchBase: null, template: null };
  const base = branch.entries.get("base");
  const template = branch.entries.get("template");
  return {
    branchBase: base === undefined ? DEFAULT_BASE : base.kind === "string" ? branchName(base.value) : null,
    template: template === undefined ? DEFAULT_BRANCH_TEMPLATE : template.kind === "string" && template.value !== "" ? template.value : null,
  };
}

/**
 * The run form of a `branch.template` as an anchored pattern (F1): every
 * `{token}` is one non-empty segment with no '/', every literal is itself.
 * `{model}/{persona}/{descriptor}` therefore reads as three non-empty segments.
 */
export function runBranchPattern(template: string): RegExp {
  const source = template
    .split(/(\{[^}]*\})/)
    .map((part): string => (/^\{[^}]*\}$/.test(part) ? "[^/]+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("");
  return new RegExp(`^${source}$`);
}

/** GitHub's protection for one branch (F2): the classic flag and the rulesets that target it. */
type Protection =
  | { readonly ok: true; readonly protected: boolean; readonly rulesets: number }
  | { readonly ok: false; readonly message: string };

function readProtection(seams: Seams, target: Target, base: string): Protection {
  try {
    const branch = mustJson<{ readonly protected?: unknown } | null>(seams, GH, ["api", `repos/${target.slug}/branches/${branchPath(base)}`]);
    if (typeof branch?.protected !== "boolean") return { ok: false, message: `GitHub answered no 'protected' flag for '${base}'` };
    const rules = mustJson<unknown>(seams, GH, ["api", `repos/${target.slug}/rules/branches/${branchPath(base)}`]);
    if (!Array.isArray(rules)) return { ok: false, message: `GitHub's rules for '${base}' are not a list` };
    return { ok: true, protected: branch.protected, rulesets: rules.length };
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, message: redactRemoteCredentials(error.message) };
    throw error;
  }
}

interface ChainEntry {
  readonly number?: unknown;
  readonly baseRefName?: unknown;
  readonly autoMergeRequest?: unknown;
}

/** F4: the open pull requests whose HEAD is this PR's base. */
function readChain(seams: Seams, target: Target, base: string): { readonly ok: true; readonly entries: readonly ChainEntry[] } | { readonly ok: false; readonly message: string } {
  let entries: unknown;
  try {
    entries = mustJson<unknown>(seams, GH, ["pr", "list", "--repo", target.slug, "--head", base, "--state", "open", "--json", "number,baseRefName,autoMergeRequest"]);
  } catch (error) {
    if (error instanceof ToolError) return { ok: false, message: redactRemoteCredentials(error.message) };
    throw error;
  }
  if (!Array.isArray(entries)) return { ok: false, message: "gh pr list answered something that is not a list" };
  return { ok: true, entries: entries as readonly ChainEntry[] };
}

function protectedReasons(name: string, names: ReadonlyMap<string, readonly string[]>, protection: Protection | null): string[] {
  const reasons = [...(names.get(name) ?? [])];
  if (protection !== null && protection.ok) {
    if (protection.protected) reasons.push("a protected branch (GitHub branch protection)");
    if (protection.rulesets > 0) reasons.push(`targeted by ${protection.rulesets} ruleset(s)`);
  }
  return reasons;
}

/** The maintainer's own lines (N9): `pr ready` was NOT evaluated, so the check comes before the merge. */
function handOver(target: Target, prNumber: number, head: string): string[] {
  return [
    "'pr ready' was NOT evaluated -- the maintainer's own check, then the merge:",
    `  nen pr ready ${prNumber} --gh-repo ${target.slug} --require-head ${head}`,
    `  gh pr merge ${prNumber} --repo ${target.slug} --merge --match-head-commit ${head}`,
  ];
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

/** F1: the author/viewer gate, plus the head ref in the run form of the base commit's `branch.template`. */
function runOwnGate(seams: Seams, prOnce: DeliveryPrOnce | null, fetchFailure: string | null, template: string | null): GateOutcome {
  const whose = runWhoseGate(seams, prOnce, fetchFailure);
  if (prOnce === null) return whose;
  const head = branchName(prOnce.headRefName);
  let line: string;
  let ok = false;
  if (template === null) {
    line = "whose pr: branch.template at the pull request's base commit could not be read -- a run's own branch cannot be recognised, refused.";
  } else if (head === null) {
    line = "whose pr: the pull request answered no head branch name -- refused.";
  } else if (!runBranchPattern(template).test(head)) {
    line = `whose pr: head '${head}' is not in the run form of branch.template '${template}' -- not a run's own pull request, refused.`;
  } else {
    ok = true;
    line = `whose pr: head '${head}' is in the run form of branch.template '${template}'`;
  }
  return { name: whose.name, ok: whose.ok && ok, lines: [...whose.lines, line] };
}

/**
 * Runs the delivery form. A base that is a protected name is REFUSED BY
 * RULING: the outcome carries `refused: true` and the adapter exits 2, the
 * transcript and `--json` document still emitted. A base that could not be
 * established is an ordinary failed gate (exit 1), every other gate still
 * evaluated, because "could not tell" is not the ruling's refusal.
 */
export async function mergeDelivery(options: MergeDeliveryOptions): Promise<MergeDeliveryOutcome> {
  if (options.requireHead !== null && !SHA_PREFIX.test(options.requireHead)) {
    throw new MergeUnitUsageError(`--require-head takes a commit SHA of 7 to 40 hex digits (got '${options.requireHead}').`);
  }
  const ref = resolveMergeRef(options.typedRef);
  const target = resolveTargetForMerge(options.seams, options.root, ref);

  let configuredBase: string;
  try {
    configuredBase = stripHeads(loadWorkflow(options.root).workflow.branch.base);
  } catch (error) {
    if (error instanceof SchemaError) throw new MergeUnitUsageError(error.message);
    throw error;
  }

  const unknowns: string[] = [];
  let prOnce: DeliveryPrOnce | null = null;
  let fetchFailure: string | null = null;
  try {
    prOnce = mustJson<DeliveryPrOnce>(options.seams, GH, ["pr", "view", String(ref.number), "--repo", target.slug, "--json", DELIVERY_PR_ONCE_FIELDS]);
  } catch (error) {
    if (error instanceof ToolError) fetchFailure = `could not fetch the pull request (${redactRemoteCredentials(error.message)})`;
    else throw error;
  }
  if (fetchFailure !== null) unknowns.push(fetchFailure);

  const base = prOnce === null ? null : branchName(prOnce.baseRefName);
  if (prOnce !== null && base === null) unknowns.push("the pull request answered no base branch name");
  const baseOid = prOnce !== null && typeof prOnce.baseRefOid === "string" && OBJECT_ID.test(prOnce.baseRefOid) ? prOnce.baseRefOid : null;
  if (prOnce !== null && baseOid === null) unknowns.push(`the pull request's baseRefOid '${String(prOnce.baseRefOid)}' is not a commit SHA`);

  let defaultBranch: string | null = null;
  try {
    defaultBranch = fetchDefaultBranch(options.seams, target);
    if (defaultBranch === null) unknowns.push(`${target.slug} answered no default branch`);
  } catch (error) {
    if (error instanceof ToolError) unknowns.push(`could not read the repository's default branch (${redactRemoteCredentials(error.message)})`);
    else throw error;
  }

  const baseCommitPolicy: PolicyAtRef = baseOid === null ? { branchBase: null, template: null } : readPolicyAt(options.seams, target, baseOid);
  if (baseOid !== null && baseCommitPolicy.branchBase === null) {
    unknowns.push(`could not read branch.base from nen/workflow.json at the pull request's base commit (${baseOid}) -- the configured base is unknown`);
  }
  const defaultBranchBase = defaultBranch === null ? null : readPolicyAt(options.seams, target, defaultBranch).branchBase;
  if (defaultBranch !== null && defaultBranchBase === null) {
    unknowns.push(`could not read branch.base from nen/workflow.json at the default branch ('${defaultBranch}')`);
  }
  const protection = base === null ? null : readProtection(options.seams, target, base);
  if (protection !== null && !protection.ok) unknowns.push(`could not read GitHub's protection for '${base}' (${protection.message})`);

  // Every protected NAME, each with what makes it one.
  const names = new Map<string, string[]>();
  const add = (name: string | null, why: string): void => {
    if (name !== null) names.set(name, [...(names.get(name) ?? []), why]);
  };
  add(defaultBranch, `the repository's default branch ('${defaultBranch}')`);
  add(configuredBase, `this checkout's nen/workflow.json branch.base ('${configuredBase}')`);
  add(baseCommitPolicy.branchBase, `the base commit's nen/workflow.json branch.base ('${baseCommitPolicy.branchBase}')`);
  add(defaultBranchBase, `the default branch's nen/workflow.json branch.base ('${defaultBranchBase}')`);

  const readHead = prOnce !== null && typeof prOnce.headRefOid === "string" ? prOnce.headRefOid : "<head>";
  const facts = {
    contract: MERGE_DELIVERY_CONTRACT,
    target: target.slug,
    pr: ref.number,
    base,
    defaultBranch,
    configuredBase,
    baseCommitBase: baseCommitPolicy.branchBase,
    defaultBranchBase,
    baseProtected: protection !== null && protection.ok ? protection.protected : null,
    baseRulesets: protection !== null && protection.ok ? protection.rulesets : null,
    requiredHead: options.requireHead,
  };

  /** Refused by ruling (N6): the gates so far plus the refusal, exit 2, the document still emitted. */
  const refuse = (refusal: string, gatesSoFar: readonly GateOutcome[], partial: Partial<MergeDeliveryReport> = {}): MergeDeliveryOutcome => {
    const refusalGate: GateOutcome = {
      name: gatesSoFar.length === 0 ? "base" : "base (re-read)",
      ok: false,
      lines: [refusal, ...handOver(target, ref.number, partial.judgedHead ?? readHead)],
    };
    const gates = [...gatesSoFar, refusalGate];
    const lines = gates.flatMap((gate): readonly string[] => gate.lines);
    lines.push(`nen pr merge: refused by ruling -- not merged (exit ${EXIT_REFUSED_BY_RULING}). Per ${MERGE_AUTHORITY_RULING}.`);
    return {
      report: {
        ready: false,
        pinOk: false,
        bodyOk: false,
        wholeOk: false,
        judgedHead: null,
        ...facts,
        ...partial,
        baseOk: false,
        refused: true,
        ok: false,
        ran: false,
        spawnFailed: false,
        mergeArgv: null,
        state: null,
        mergedBase: null,
        outsideAuthority: false,
        gates,
      },
      lines,
    };
  };

  if (base !== null) {
    const reasons = protectedReasons(base, names, protection);
    if (reasons.length > 0) {
      return refuse(`base: '${base}' is ${reasons.join(" and ")} -- --delivery merges a run's own pull request into a non-main, unprotected base only.`, []);
    }
    const chain = readChain(options.seams, target, base);
    if (!chain.ok) {
      unknowns.push(`could not list the open pull requests whose head is '${base}' (${chain.message})`);
    } else {
      const carried = chain.entries
        .filter((entry): boolean => entry.autoMergeRequest !== null && entry.autoMergeRequest !== undefined)
        .filter((entry): boolean => {
          const into = branchName(entry.baseRefName);
          return into === null || names.has(into);
        });
      if (carried.length > 0) {
        const named = carried.map((entry): string => `#${String(entry.number)} into '${branchName(entry.baseRefName) ?? "(unnamed)"}'`).join(", ");
        return refuse(`base: '${base}' is the head of ${named} with auto-merge enabled -- merging here would carry this pull request into a protected name.`, []);
      }
    }
  }

  const baseGate: GateOutcome =
    unknowns.length > 0
      ? { name: "base", ok: false, lines: unknowns.map((why): string => `base: ${why} -- refused rather than merging into what may be the trunk.`) }
      : {
          name: "base",
          ok: true,
          lines: [
            `base: '${base}' is none of the protected names (${[...names.keys()].map((name): string => `'${name}'`).join(", ")}), is not protected, no ruleset targets it, and no auto-merge chain carries it -- a non-main base`,
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
  const bodyGate = runBodyCheckGate(prOnce, fetchFailure, { requirements: options.requirements });
  const ownGate = runOwnGate(options.seams, prOnce, fetchFailure, baseCommitPolicy.template);

  const gates: GateOutcome[] = [baseGate, readyGate, pinGate, bodyGate, ownGate];
  const ok = gates.every((gate): boolean => gate.ok);
  const judgedHead = readyGate.judgedHead;
  const mergeArgv =
    judgedHead === null
      ? ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge"]
      : ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge", "--match-head-commit", judgedHead];

  const lines: string[] = gates.flatMap((gate): readonly string[] => gate.lines);
  const gateFacts = {
    ...facts,
    refused: false,
    baseOk: baseGate.ok,
    ready: readyGate.ok,
    pinOk: pinGate.ok,
    bodyOk: bodyGate.ok,
    wholeOk: ownGate.ok,
    judgedHead,
    mergedBase: null,
    outsideAuthority: false,
  };

  if (!ok) {
    lines.push("nen pr merge: not merged -- at least one gate above did not pass.");
    return { report: { ...gateFacts, ok: false, ran: false, spawnFailed: false, mergeArgv: null, state: null, gates }, lines };
  }

  if (!options.run) {
    lines.push(`plan only (pass --run to execute): gh ${mergeArgv.join(" ")}`);
    return { report: { ...gateFacts, ok: true, ran: false, spawnFailed: false, mergeArgv, state: null, gates }, lines };
  }

  // The pre-merge re-read (this file's header): `gh pr merge` has no base pin.
  // A failure or a retarget appends a FAILED 'base (re-read)' gate, so `gates`
  // and `baseOk` never disagree (N7).
  const failReread = (why: string): MergeDeliveryOutcome => {
    const rereadGate: GateOutcome = { name: "base (re-read)", ok: false, lines: [`base (re-read): ${why} -- refused.`] };
    return {
      report: { ...gateFacts, baseOk: false, ok: false, ran: false, spawnFailed: false, mergeArgv: null, state: null, gates: [...gates, rereadGate] },
      lines: [...lines, ...rereadGate.lines, "nen pr merge: not merged -- at least one gate above did not pass."],
    };
  };
  let baseNow: string | null;
  try {
    baseNow = branchName(
      mustJson<{ readonly baseRefName?: unknown } | null>(options.seams, GH, ["pr", "view", String(ref.number), "--repo", target.slug, "--json", "baseRefName"])
        ?.baseRefName,
    );
  } catch (error) {
    if (error instanceof ToolError) return failReread(`could not re-read the base before merging (${redactRemoteCredentials(error.message)})`);
    throw error;
  }
  if (baseNow === null) return failReread("the pull request answered no base branch name on the re-read");
  const reasonsNow = protectedReasons(baseNow, names, baseNow === base ? protection : null);
  if (reasonsNow.length > 0) {
    return refuse(`base (re-read): the pull request was retargeted onto '${baseNow}', which is ${reasonsNow.join(" and ")}.`, gates, gateFacts);
  }
  if (baseNow !== base) {
    return failReread(`the pull request was retargeted from '${base}' to '${baseNow}' after the gates above read it; run again so every gate judges the same base`);
  }
  const rereadOk: GateOutcome = { name: "base (re-read)", ok: true, lines: [`base (re-read): still '${baseNow}'`] };
  lines.push(...rereadOk.lines);

  const executed = executeMerge(options.seams, target, ref.number, mergeArgv, "state,mergedAt,baseRefName");
  lines.push(...executed.lines);
  let mergedBase: string | null = null;
  let outsideAuthority = false;
  if (executed.state === "MERGED") {
    mergedBase = branchName(executed.reread?.["baseRefName"]);
    if (mergedBase === null || names.has(mergedBase) || mergedBase !== base) {
      outsideAuthority = true;
      lines.push(
        `nen pr merge: MERGED INTO ${mergedBase === null ? "AN UNCONFIRMED BASE" : `'${mergedBase}'`} WITHOUT AUTHORITY -- the gates above judged '${base}'. Tell the maintainer now (exit ${EXIT_MERGED_OUTSIDE_AUTHORITY}). Per ${MERGE_AUTHORITY_RULING}.`,
      );
    }
  }
  return {
    report: {
      ...gateFacts,
      ok: executed.ok && !outsideAuthority,
      ran: executed.ran,
      spawnFailed: executed.spawnFailed,
      mergeArgv,
      state: executed.state,
      mergedBase,
      outsideAuthority,
      gates: [...gates, rereadOk],
    },
    lines,
  };
}

/**
 * The delivery form's exit code: 2 refused by ruling, 7 merged without
 * authority, otherwise the code both merge forms share (0 / 1 / 5 / 6).
 */
export function deliveryExit(report: MergeDeliveryReport, shared: (report: MergeDeliveryReport) => number): number {
  if (report.refused) return EXIT_REFUSED_BY_RULING;
  if (report.outsideAuthority) return EXIT_MERGED_OUTSIDE_AUTHORITY;
  return shared(report);
}
