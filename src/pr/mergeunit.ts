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

import { checkBody, type BodyRequirement } from "./bodycheck.js";
import {
  assembleUnitCheck,
  fetchChangedFiles,
  renderUnitCheck,
  resolvePrRef,
  resolveUnitCheckTarget,
  UnitCheckRefError,
  type ResolvedPrRef,
} from "../release/unitcheck.js";
import { loadWorkflow } from "../schema/workflow.js";
import { GH, type Seams } from "../seam/exec.js";
import type { Io, PrReadyDeps, PrReadyInput } from "../verbs/pr_ready.js";
import { prReady, defaultDeps } from "../verbs/pr_ready.js";
import type { Target } from "../github/target.js";

export const MERGE_UNIT_CONTRACT = "nen.pr.merge-unit/v0.1";

/** `gh pr merge` refused (branch protection, a required review, ...). Distinct from every other code this family uses. */
export const EXIT_GH_REFUSED = 5;

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
  readonly ok: boolean;
  readonly ran: boolean;
  readonly mergeArgv: readonly string[] | null;
  readonly gates: readonly GateOutcome[];
}

/** A capturing `Io`, so `pr ready`'s own `--json` rendering can be read back as a value rather than reparsed off real stdout. */
function captureIo(): { readonly io: Io; readonly lines: string[] } {
  const lines: string[] = [];
  return { io: { out: (line): void => void lines.push(line), err: (): void => {} }, lines };
}

export interface RunReadyGate {
  readonly target: Target;
  readonly prNumber: number;
  readonly repoFlag: string | null;
  readonly ghRepoFlag: string;
  readonly seams: Seams;
  readonly deps?: PrReadyDeps;
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
 */
export async function runReadyGate(options: RunReadyGate): Promise<GateOutcome> {
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
  const raw = captured.lines.join("");
  let parsed: { readonly verdict?: string; readonly gateLine?: string; readonly message?: string };
  try {
    parsed = JSON.parse(raw) as typeof parsed;
  } catch {
    return { name: "pr ready", ok: false, lines: [`pr ready: could not read its own --json report (${raw})`] };
  }
  const line = parsed.gateLine ?? parsed.message ?? "(no verdict line)";
  return { name: "pr ready", ok: parsed.verdict === "ready", lines: [`pr ready: ${line}`] };
}

export interface RunBodyCheckGate {
  readonly target: Target;
  readonly prNumber: number;
  readonly requirements: readonly BodyRequirement[];
  readonly seams: Seams;
}

/**
 * `pr body-check`'s own pure predicate (../pr/bodycheck.ts's `checkBody`),
 * fed the pull request's LIVE body over `gh` rather than a `--body-from`
 * file: a merge gate must check the body GitHub will actually merge, not a
 * draft on disk that may have drifted from it.
 */
export function runBodyCheckGate(options: RunBodyCheckGate): GateOutcome {
  const response = options.seams.run(
    GH,
    ["pr", "view", String(options.prNumber), "--repo", options.target.slug, "--json", "body"],
  );
  if (response.spawnFailed || response.code !== 0) {
    return {
      name: "pr body-check",
      ok: false,
      lines: [`pr body-check: could not read the pull request's body (${response.spawnFailed ? response.stderr : response.stderr.trim() || `exit ${response.code}`})`],
    };
  }
  let body = "";
  try {
    body = (JSON.parse(response.stdout) as { readonly body?: string }).body ?? "";
  } catch {
    return { name: "pr body-check", ok: false, lines: ["pr body-check: gh answered something that is not JSON"] };
  }
  const report = checkBody(body, options.requirements);
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

export interface RunUnitCheckGate {
  readonly root: string;
  readonly target: Target;
  readonly prNumber: number;
  readonly seams: Seams;
}

/** `release unit-check`'s own composition (../release/unitcheck.ts), reused whole. */
export function runUnitCheckGate(options: RunUnitCheckGate): GateOutcome {
  const loaded = loadWorkflow(options.root);
  const unitPaths = loaded.workflow.release.unitPaths;
  if (unitPaths === null) {
    return {
      name: "release unit-check",
      ok: false,
      lines: [
        `release unit-check: '${loaded.path}' declares no 'release.unitPaths' -- add it, e.g. {"release": {"unitPaths": ["src/my-unit/**"]}}.`,
      ],
    };
  }
  const changedFiles = fetchChangedFiles(options.seams, options.target, options.prNumber);
  const report = assembleUnitCheck(options.target, options.prNumber, unitPaths, changedFiles);
  return { name: "release unit-check", ok: report.ok, lines: renderUnitCheck(report).map((line): string => `release unit-check: ${line}`) };
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

export interface MergeUnitOutcome {
  readonly report: MergeUnitReport;
  readonly lines: readonly string[];
}

/**
 * Runs the three gates, in order, EVERY ONE evaluated even after an earlier
 * one fails -- the same "report the whole table" discipline
 * ../release/preflight.ts and ../pr/bodycheck.ts already hold to, so a caller
 * sees every blocker in one pass rather than fixing them one at a time.
 *
 * `gh pr merge <n> --merge` runs ONLY when every gate passed AND `--run` was
 * given. No other flag ever reaches that argv -- see this file's header.
 */
export async function mergeUnit(options: MergeUnitOptions): Promise<MergeUnitOutcome> {
  const ref = resolveMergeRef(options.typedRef);
  const target = ((): Target => {
    try {
      return resolveUnitCheckTarget(options.seams, options.root, ref);
    } catch (error) {
      if (error instanceof UnitCheckRefError) throw new MergeUnitUsageError(error.message);
      throw error;
    }
  })();

  const readyGate = await runReadyGate({
    target,
    prNumber: ref.number,
    repoFlag: options.repoFlag,
    ghRepoFlag: target.slug,
    seams: options.seams,
    deps: options.deps,
  });
  const bodyGate = runBodyCheckGate({ target, prNumber: ref.number, requirements: options.requirements, seams: options.seams });
  const unitGate = runUnitCheckGate({ root: options.root, target, prNumber: ref.number, seams: options.seams });

  const gates = [readyGate, bodyGate, unitGate];
  const ok = gates.every((gate): boolean => gate.ok);
  const mergeArgv = ["pr", "merge", String(ref.number), "--repo", target.slug, "--merge"];

  const lines: string[] = [];
  for (const gate of gates) lines.push(...gate.lines);

  if (!ok) {
    lines.push("nen pr merge: not merged -- at least one gate above did not pass.");
    return {
      report: {
        contract: MERGE_UNIT_CONTRACT,
        target: target.slug,
        pr: ref.number,
        ready: readyGate.ok,
        bodyOk: bodyGate.ok,
        unitOk: unitGate.ok,
        ok: false,
        ran: false,
        mergeArgv: null,
        gates,
      },
      lines,
    };
  }

  if (!options.run) {
    lines.push(`plan only (pass --run to execute): gh ${mergeArgv.join(" ")}`);
    return {
      report: {
        contract: MERGE_UNIT_CONTRACT,
        target: target.slug,
        pr: ref.number,
        ready: true,
        bodyOk: true,
        unitOk: true,
        ok: true,
        ran: false,
        mergeArgv,
        gates,
      },
      lines,
    };
  }

  const result = options.seams.run(GH, mergeArgv);
  if (result.spawnFailed || result.code !== 0) {
    lines.push(`nen pr merge: gh refused -- ${result.spawnFailed ? result.stderr : result.stderr.trim() || `exit ${result.code}`}`);
    lines.push(`the exact command for a human to run once the refusal is resolved: gh ${mergeArgv.join(" ")}`);
    return {
      report: {
        contract: MERGE_UNIT_CONTRACT,
        target: target.slug,
        pr: ref.number,
        ready: true,
        bodyOk: true,
        unitOk: true,
        ok: false,
        ran: false,
        mergeArgv,
        gates,
      },
      lines,
    };
  }

  lines.push(`merged: gh ${mergeArgv.join(" ")}`);
  return {
    report: {
      contract: MERGE_UNIT_CONTRACT,
      target: target.slug,
      pr: ref.number,
      ready: true,
      bodyOk: true,
      unitOk: true,
      ok: true,
      ran: true,
      mergeArgv,
      gates,
    },
    lines,
  };
}
