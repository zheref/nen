// src/runner/enable.ts -- `nen runner enable`: switch a pool's jobs on, and only
// after proof.
//
// FAIL-CLOSED ON THE EVIDENCE. The repository variable is the one switch that
// lets a consumer's gated jobs queue on the pool; set too early, every pull
// request's check waits on a pool that cannot run it (bankai's rollout cost a
// round trip exactly that way). So the variable is written only after the run
// named by `--after-run` reads, from GitHub, as ALL of: this pool's own
// preflight workflow (the run's `path`), completed, concluded `success`, every
// job in it requested THIS pool's labels, dispatched (`workflow_dispatch`) on
// the default branch, and running the default branch's own blob of the
// workflow (#319). A green run of another file, of the same file rendered for
// another pool, or of an edited copy on a branch, is refused by name.
//
// IDEMPOTENT, AND READ BACK. A variable already holding the value is left
// alone (`changed: false`); a write is followed by a read, and a read that
// disagrees is exit 1 -- "the API accepted it" is not the same fact as "the
// variable says it".

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { outputLines } from "../seam/exec.js";
import type { RunnerPool } from "../schema/workflow.js";
import { apiRefusal, asRecord, gh, RunnerFailure } from "./github.js";
import { contentsArgv, defaultBranch, readRun } from "./preflight.js";

export const VARIABLE_VALUE = /^[a-z0-9-]{1,32}$/;

export interface EnableReport {
  readonly target: string;
  readonly pool: string;
  readonly variable: string;
  readonly value: string;
  readonly previous: string | null;
  readonly runId: number;
  readonly changed: boolean;
  readonly dryRun: boolean;
}

export function variableGetArgv(target: Target, name: string): readonly string[] {
  return ["variable", "get", name, "--repo", target.slug];
}

export function variableSetArgv(target: Target, name: string, value: string): readonly string[] {
  return ["variable", "set", name, "--body", value, "--repo", target.slug];
}

function readVariable(seams: Seams, target: Target, name: string): string | null {
  const result = gh(seams, variableGetArgv(target, name));
  if (result.code === 0) return outputLines(result.stdout)[0] ?? "";
  if (/not found|\b404\b/i.test(result.stderr)) return null;
  throw apiRefusal(result, target, `reading the repository variable ${name}`);
}

/** One reason a run does not certify, named by the check that refused it. */
export interface CertificationProblem {
  readonly check: "workflow" | "status" | "conclusion" | "jobs" | "labels" | "job-conclusion" | "event" | "branch" | "blob";
  readonly detail: string;
}

/** A run that is not this pool's green preflight: exit 1, with every problem named for `--json`. */
export class CertificationRefusal extends RunnerFailure {
  readonly problems: readonly CertificationProblem[];

  constructor(message: string, problems: readonly CertificationProblem[]) {
    super(1, message);
    this.name = "CertificationRefusal";
    this.problems = problems;
  }
}

/** A workflow file's blob sha at one ref, or null when the ref does not carry it. */
function blobAt(seams: Seams, target: Target, path: string, ref: string): string | null {
  const result = gh(seams, contentsArgv(target, path, ref));
  if (result.code !== 0) {
    if (/not found|\b404\b/i.test(result.stderr)) return null;
    throw apiRefusal(result, target, `reading ${path} at ${ref}`);
  }
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw new RunnerFailure(1, `reading ${path} at ${ref} on ${target.slug} answered something that is not JSON.`);
  }
  const sha = asRecord(answer)?.["sha"];
  return typeof sha === "string" && sha !== "" ? sha : null;
}

/**
 * The run, re-read from GitHub, must be this pool's green preflight.
 *
 * THE PROOF IS THE DEFAULT BRANCH'S PREFLIGHT, DISPATCHED (#319). Green and
 * on the pool's labels is not enough: a run of an edited copy -- steps
 * removed, TOOLS emptied, `runs-on` kept -- on any branch would pass those.
 * So the run must also be a `workflow_dispatch` (what `nen runner preflight`
 * starts), on the default branch, and the workflow's blob at the run's
 * `head_sha` must be the default branch's own.
 */
export function certifyRun(seams: Seams, target: Target, pool: RunnerPool, runId: number): void {
  const run = readRun(seams, target, runId);
  const file = (run.path.split("@")[0] ?? "").split("/").pop() ?? "";
  const workflowPath = `.github/workflows/${pool.preflightWorkflow}`;
  const problems: CertificationProblem[] = [];
  if (file !== pool.preflightWorkflow) problems.push({ check: "workflow", detail: `it is a run of '${run.path || "(no path)"}', not ${workflowPath}` });
  if (run.status !== "completed") problems.push({ check: "status", detail: `it is '${run.status || "(no status)"}', not completed` });
  else if (run.conclusion !== "success") problems.push({ check: "conclusion", detail: `it concluded '${run.conclusion ?? "(none)"}', not success` });
  if (run.jobs.length === 0) problems.push({ check: "jobs", detail: "it has no jobs" });
  for (const job of run.jobs) {
    const carried = new Set(job.labels.map((label): string => label.toLowerCase()));
    const missing = pool.labels.filter((label): boolean => !carried.has(label.toLowerCase()));
    if (missing.length > 0) problems.push({ check: "labels", detail: `job '${job.name}' did not ask for pool ${pool.id}'s labels (missing ${missing.join(", ")})` });
    if (job.conclusion !== "success") problems.push({ check: "job-conclusion", detail: `job '${job.name}' concluded '${job.conclusion ?? "(none)"}'` });
  }
  if (run.event !== "workflow_dispatch") problems.push({ check: "event", detail: `it was triggered by '${run.event || "(no event)"}', not workflow_dispatch` });
  const main = defaultBranch(seams, target);
  if (run.headBranch !== main) problems.push({ check: "branch", detail: `it ran on '${run.headBranch || "(no branch)"}', not the default branch '${main}'` });
  if (run.headSha === "") {
    problems.push({ check: "blob", detail: "it names no head_sha, so its workflow cannot be compared with the default branch's" });
  } else {
    const ran = blobAt(seams, target, workflowPath, run.headSha);
    const expected = blobAt(seams, target, workflowPath, main);
    if (expected === null) problems.push({ check: "blob", detail: `${workflowPath} is not on the default branch '${main}'` });
    else if (ran !== expected) {
      problems.push({ check: "blob", detail: `${workflowPath} at ${run.headSha.slice(0, 12)} is ${ran === null ? "absent" : `blob ${ran.slice(0, 12)}`}, not the default branch's blob ${expected.slice(0, 12)}` });
    }
  }
  if (problems.length > 0) {
    throw new CertificationRefusal(
      `run ${runId} on ${target.slug} is not a green preflight of pool ${pool.id}: ${problems.map((problem): string => problem.detail).join("; ")}. Nothing was set -- run 'nen runner preflight' (it dispatches on the default branch) and pass the run id it reports.`,
      problems,
    );
  }
}

export function enablePool(
  seams: Seams,
  target: Target,
  pool: RunnerPool & { readonly enableVariable: string },
  runId: number,
  value: string,
  dryRun: boolean,
): EnableReport {
  certifyRun(seams, target, pool, runId);
  const variable = pool.enableVariable;
  const previous = readVariable(seams, target, variable);
  const base = { target: target.slug, pool: pool.id, variable, value, previous, runId, dryRun };
  if (previous === value) return { ...base, changed: false };
  if (dryRun) return { ...base, changed: true };
  const set = gh(seams, variableSetArgv(target, variable, value));
  if (set.code !== 0) throw apiRefusal(set, target, `setting the repository variable ${variable}`);
  const after = readVariable(seams, target, variable);
  if (after !== value) {
    throw new RunnerFailure(1, `set ${variable}=${value} on ${target.slug}, and reading it back answered ${after === null ? "no variable" : `'${after}'`}.`);
  }
  return { ...base, changed: true };
}

export function renderEnable(report: EnableReport): string[] {
  if (!report.changed) return [`${report.variable} on ${report.target} already reads '${report.value}' (pool ${report.pool}, run ${report.runId}) -- nothing to change.`];
  if (report.dryRun) {
    return [
      `(dry run) would set ${report.variable}=${report.value} on ${report.target} (was ${report.previous === null ? "unset" : `'${report.previous}'`}); run ${report.runId} is a green preflight of pool ${report.pool}.`,
      `would run: gh ${variableSetArgv({ owner: "", repo: "", slug: report.target }, report.variable, report.value).join(" ")}`,
    ];
  }
  return [`${report.variable}=${report.value} on ${report.target} (was ${report.previous === null ? "unset" : `'${report.previous}'`}); pool ${report.pool} proved by run ${report.runId}.`];
}
