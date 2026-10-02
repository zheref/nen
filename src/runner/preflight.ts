// src/runner/preflight.ts -- `nen runner preflight`: dispatch the pool's
// preflight workflow and wait for its verdict.
//
// THE ONE CHECK THAT SEES WHAT THE RUNNER SEES. A preflight job runs AS the
// runner service, with the service's PATH and the service account's ACLs --
// bankai's rules W1 (machine-located AND machine-readable) and W2 (126 is not
// 127) are observable from nowhere else. So this verb's exit 0 is the only
// evidence `runner enable` accepts.
//
// WHICH RUN IS OURS, WITHOUT TRUSTING TWO CLOCKS. `gh workflow run` does not
// answer with the run it created, and a run appears asynchronously. Comparing
// `createdAt` with this host's clock would be comparing two clocks; instead
// the run list is read BEFORE the dispatch and the run we want is the newest
// `workflow_dispatch` run on `--ref` whose id was not in that list. The
// listing is retried for up to 60 s.
//
// A JOB STILL QUEUED AT THE DEADLINE IS NAMED FOR WHAT IT IS: no free runner
// with those labels picked it up -- the "PENDING forever" signature an empty
// or offline pool produces. It is a failure (exit 1), never a timeout nobody
// can read.

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import { renderPipeTable } from "../cli/table.js";
import { apiRefusal, asRecord, describeFailure, gh, ghJson, POLL_INTERVAL_MS, RunnerFailure, type Sleep } from "./github.js";

/** How long a dispatched run may take to appear in the run list. */
export const APPEAR_BUDGET_MS = 60_000;
export const APPEAR_POLL_MS = 5_000;

export interface PreflightJob {
  readonly name: string;
  readonly status: string;
  readonly conclusion: string | null;
  readonly runnerName: string | null;
  readonly labels: readonly string[];
}

export interface PreflightReport {
  readonly target: string;
  readonly workflow: string;
  readonly ref: string;
  readonly runId: number | null;
  readonly url: string | null;
  readonly status: string | null;
  readonly conclusion: string | null;
  readonly runnerName: string | null;
  readonly runnerOs: string | null;
  readonly jobs: readonly PreflightJob[];
  /** `success`, `failure`, `queued` (no runner took it), `timeout`, or `dry-run`. */
  readonly verdict: string;
  readonly detail: string;
  readonly dryRun: boolean;
}

export function defaultBranchArgv(target: Target): readonly string[] {
  return ["repo", "view", target.slug, "--json", "defaultBranchRef"];
}

export function dispatchArgv(target: Target, workflow: string, ref: string): readonly string[] {
  return ["workflow", "run", workflow, "--repo", target.slug, "--ref", ref];
}

export function runListArgv(target: Target, workflow: string): readonly string[] {
  return [
    "run",
    "list",
    "--workflow",
    workflow,
    "--repo",
    target.slug,
    "--json",
    "databaseId,createdAt,status,conclusion,headBranch,event",
    "--limit",
    "20",
  ];
}

export function runArgv(target: Target, runId: number): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/actions/runs/${runId}`];
}

export function jobsArgv(target: Target, runId: number): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/actions/runs/${runId}/jobs?per_page=100`];
}

/** A file's contents entry at one ref -- read for its blob `sha`, never its body. */
export function contentsArgv(target: Target, path: string, ref: string): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/contents/${path}?ref=${ref}`];
}

export function defaultBranch(seams: Seams, target: Target): string {
  const answer = asRecord(ghJson<unknown>(seams, defaultBranchArgv(target), target, "reading the default branch"));
  const name = asRecord(answer?.["defaultBranchRef"])?.["name"];
  if (typeof name !== "string" || name === "") {
    throw new RunnerFailure(1, `${target.slug} answered no default branch; pass --ref <branch>.`);
  }
  return name;
}

interface ListedRun {
  readonly id: number;
  readonly headBranch: string;
  readonly event: string;
}

function listRuns(seams: Seams, target: Target, workflow: string): ListedRun[] {
  const answer = ghJson<unknown>(seams, runListArgv(target, workflow), target, `listing ${workflow} runs`);
  if (!Array.isArray(answer)) throw new RunnerFailure(1, `listing ${workflow} runs on ${target.slug} answered something that is not a list.`);
  return answer
    .map((entry): ListedRun | null => {
      const row = asRecord(entry);
      const id = row?.["databaseId"];
      if (row === null || typeof id !== "number") return null;
      return {
        id,
        headBranch: typeof row["headBranch"] === "string" ? row["headBranch"] : "",
        event: typeof row["event"] === "string" ? row["event"] : "",
      };
    })
    .filter((run): run is ListedRun => run !== null);
}

export interface RunState {
  readonly id: number;
  readonly url: string | null;
  readonly status: string;
  readonly conclusion: string | null;
  readonly path: string;
  readonly event: string;
  readonly headBranch: string;
  readonly headSha: string;
  readonly jobs: readonly PreflightJob[];
}

/** One run and its jobs, over REST. */
export function readRun(seams: Seams, target: Target, runId: number): RunState {
  const run = asRecord(ghJson<unknown>(seams, runArgv(target, runId), target, `reading run ${runId}`));
  if (run === null) throw new RunnerFailure(1, `run ${runId} on ${target.slug} answered something that is not an object.`);
  const jobsAnswer = asRecord(ghJson<unknown>(seams, jobsArgv(target, runId), target, `reading run ${runId}'s jobs`));
  const jobsRaw = Array.isArray(jobsAnswer?.["jobs"]) ? (jobsAnswer?.["jobs"] as unknown[]) : [];
  const text = (record: Record<string, unknown> | null, key: string): string | null =>
    record !== null && typeof record[key] === "string" && record[key] !== "" ? (record[key] as string) : null;
  return {
    id: runId,
    url: text(run, "html_url"),
    status: text(run, "status") ?? "",
    conclusion: text(run, "conclusion"),
    path: text(run, "path") ?? "",
    event: text(run, "event") ?? "",
    headBranch: text(run, "head_branch") ?? "",
    headSha: text(run, "head_sha") ?? "",
    jobs: jobsRaw.map((entry): PreflightJob => {
      const job = asRecord(entry);
      return {
        name: text(job, "name") ?? "",
        status: text(job, "status") ?? "",
        conclusion: text(job, "conclusion"),
        runnerName: text(job, "runner_name"),
        labels: Array.isArray(job?.["labels"]) ? (job?.["labels"] as unknown[]).filter((label): label is string => typeof label === "string") : [],
      };
    }),
  };
}

/** The OS a job's requested labels name, in GitHub's case. */
export function osOfLabels(labels: readonly string[]): string | null {
  for (const os of ["Windows", "Linux", "macOS"]) {
    if (labels.some((label): boolean => label.toLowerCase() === os.toLowerCase())) return os;
  }
  return null;
}

export interface PreflightOptions {
  readonly workflow: string;
  readonly ref: string | null;
  readonly waitSeconds: number;
  readonly dryRun: boolean;
  readonly sleep: Sleep;
}

export function runPreflight(seams: Seams, target: Target, options: PreflightOptions): PreflightReport {
  const ref = options.ref ?? defaultBranch(seams, target);
  const base = { target: target.slug, workflow: options.workflow, ref };
  if (options.dryRun) {
    return {
      ...base,
      runId: null,
      url: null,
      status: null,
      conclusion: null,
      runnerName: null,
      runnerOs: null,
      jobs: [],
      verdict: "dry-run",
      detail: `would run: gh ${dispatchArgv(target, options.workflow, ref).join(" ")}`,
      dryRun: true,
    };
  }

  const before = new Set(listRuns(seams, target, options.workflow).map((run): number => run.id));
  const dispatched = gh(seams, dispatchArgv(target, options.workflow, ref));
  if (dispatched.code !== 0) {
    if (/\b404\b|could not find any workflows|not found/i.test(dispatched.stderr)) {
      throw new VerbUsageError(
        `${options.workflow} is not present on '${ref}' of ${target.slug} (gh: ${describeFailure(dispatched)}). Merge the preflight workflow first -- a workflow_dispatch run can only start from a file the ref already carries.`,
      );
    }
    throw apiRefusal(dispatched, target, `dispatching ${options.workflow}`);
  }

  let runId: number | null = null;
  for (let waited = 0; ; waited += APPEAR_POLL_MS) {
    const fresh = listRuns(seams, target, options.workflow).find(
      (run): boolean => !before.has(run.id) && run.event === "workflow_dispatch" && run.headBranch === ref,
    );
    if (fresh !== undefined) {
      runId = fresh.id;
      break;
    }
    if (waited + APPEAR_POLL_MS > APPEAR_BUDGET_MS) {
      throw new RunnerFailure(
        1,
        `dispatched ${options.workflow} on '${ref}', and no new workflow_dispatch run appeared in ${APPEAR_BUDGET_MS / 1000}s. Check the Actions tab of ${target.slug}.`,
      );
    }
    options.sleep(APPEAR_POLL_MS);
  }

  let waitedMs = 0;
  let state = readRun(seams, target, runId);
  while (state.status !== "completed" && waitedMs + POLL_INTERVAL_MS <= options.waitSeconds * 1000) {
    options.sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
    state = readRun(seams, target, runId);
  }

  const picked = state.jobs.find((job): boolean => job.runnerName !== null) ?? null;
  const common = {
    ...base,
    runId,
    url: state.url,
    status: state.status,
    conclusion: state.conclusion,
    runnerName: picked?.runnerName ?? null,
    runnerOs: osOfLabels(picked?.labels ?? state.jobs[0]?.labels ?? []),
    jobs: state.jobs,
    dryRun: false,
  };
  if (state.status === "completed") {
    return state.conclusion === "success"
      ? { ...common, verdict: "success", detail: `run ${runId} succeeded${picked === null ? "" : ` on ${picked.runnerName ?? "?"}`}` }
      : { ...common, verdict: "failure", detail: `run ${runId} completed '${state.conclusion ?? "(no conclusion)"}'` };
  }
  const queued = state.jobs.filter((job): boolean => job.status === "queued" || job.status === "waiting" || job.status === "pending");
  if (state.jobs.length === 0 || queued.length > 0) {
    return {
      ...common,
      verdict: "queued",
      detail: `queued ${waitedMs / 1000}s -- no free runner picked it up (${(queued[0]?.labels ?? []).join(", ") || "no job yet"}). An offline or empty pool leaves a job PENDING forever; check 'nen runner inventory'.`,
    };
  }
  return { ...common, verdict: "timeout", detail: `run ${runId} was still '${state.status}' after ${waitedMs / 1000}s (--wait ${options.waitSeconds})` };
}

export function renderPreflight(report: PreflightReport): string[] {
  const lines = [
    `${report.verdict}: ${report.workflow} on ${report.target}@${report.ref} -- ${report.detail}`,
  ];
  if (report.url !== null) lines.push(`run: ${report.url}`);
  if (report.jobs.length > 0) {
    lines.push(
      ...renderPipeTable([
        ["job", "status", "conclusion", "runner", "labels"],
        ...report.jobs.map((job): string[] => [job.name, job.status, job.conclusion ?? "", job.runnerName ?? "", job.labels.join(",")]),
      ]),
    );
  }
  return lines;
}
