// src/runner/relabel.ts -- `nen runner relabel`: put a pool's own label
// (`pool-<id>`, #340) on runners that were registered before it existed.
//
// WHY A VERB. From #340 every pool's label set ends in `pool-<id>`, and a
// workflow nen renders targets that full set -- so a runner registered with
// GitHub's three defaults alone takes none of the pool's jobs until it carries
// the label. The host script registers new runners with it; this verb is the
// upgrade step for the ones already registered, through GitHub's own
// `POST /repos/{owner}/{repo}/actions/runners/{runner_id}/labels`. Nothing on
// the host changes: the label is the repository's record of the runner.
//
// DRY-RUN BY DEFAULT, ACTING ONLY WITH `--run`, the shape `shu deploy`,
// `label apply` and `wake fire` share: the bare form reads the runners list,
// selects and checks, and prints each write as `would add`; `--run` makes it.
// Every write is READ BACK (`GET .../runners/{id}/labels`): "the API accepted
// it" is not the same fact as "the runner carries it", and a read that
// disagrees is exit 1.
//
// WHICH RUNNERS. `--runner <names>` names them, and each is checked first --
// registered, carrying the pool's declared labels, carrying no other pool's
// label, and not claimed by a more specific pool (a `desktop` runner is never
// relabelled into the plain pool beside it). Any refusal refuses the whole
// call before anything is written. Without `--runner`, the runners the
// inventory lists as awaiting this pool's label are taken, and two pools that
// declare one label set make that choice the maintainer's: exit 2, name them.
//
// ADMIN-ONLY, AND SAID SO. A runner's labels are a repository-admin surface;
// a 403 comes back through ./github.ts's `apiRefusal`, worded "needs admin".

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import { renderPipeTable } from "../cli/table.js";
import { poolOwnLabel, type RunnerPool, type RunnersPolicy } from "../schema/workflow.js";
import { apiRefusal, asRecord, gh, RunnerFailure } from "./github.js";
import { awaitingPools, declaredOf, fetchRunners, inPool, poolLabelsOf, type RunnerRow } from "./inventory.js";

export type RelabelVerdict = "added" | "would-add" | "already";

export interface RelabelRow {
  readonly name: string;
  readonly id: number;
  readonly verdict: RelabelVerdict;
}

export interface RelabelReport {
  readonly target: string;
  readonly pool: string;
  readonly label: string;
  /** `named` when `--runner` chose the runners, `awaiting` when the inventory did. */
  readonly selection: "named" | "awaiting";
  readonly run: boolean;
  readonly runners: readonly RelabelRow[];
  /** How many runners gained the label (or, without `--run`, would). */
  readonly changed: number;
}

/** The one write: add `label` to runner `id`, GitHub's custom-label endpoint. */
export function addLabelArgv(target: Target, id: number, label: string): readonly string[] {
  return ["api", "--method", "POST", `repos/${target.slug}/actions/runners/${id}/labels`, "-f", `labels[]=${label}`];
}

/** The read-back: every label runner `id` carries now. */
export function runnerLabelsArgv(target: Target, id: number): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/actions/runners/${id}/labels`];
}

const lower = (labels: readonly string[]): string[] => labels.map((label): string => label.toLowerCase());

/** Why one named runner cannot take this pool's label, or null when it can. */
function refusal(runner: RunnerRow, pool: RunnerPool, pools: readonly RunnerPool[]): string | null {
  const own = poolOwnLabel(pool.id);
  const foreign = poolLabelsOf(runner).filter((label): boolean => label.toLowerCase() !== own.toLowerCase());
  if (foreign.length > 0) {
    return `${runner.name} already carries ${foreign.map((label): string => `'${label}'`).join(", ")}: a runner is in one pool, and moving it is a label to remove in GitHub first`;
  }
  const carried = lower(runner.labels);
  const missing = declaredOf(pool).filter((label): boolean => !carried.includes(label.toLowerCase()));
  if (missing.length > 0) {
    return `${runner.name} lacks ${missing.join(", ")} of pool ${pool.id}'s labels [${declaredOf(pool).join(", ")}], so it is not a runner of that pool`;
  }
  const claimants = awaitingPools(runner, pools).filter((other): boolean => other !== pool);
  if (!awaitingPools(runner, pools).includes(pool) && claimants.length > 0) {
    return `${runner.name} carries pool ${claimants.map((other): string => other.id).join(", ")}'s labels, a more specific set than pool ${pool.id}'s: label it into that pool instead`;
  }
  return null;
}

/** Which runners this call acts on, checked, before anything is written. */
export function selectRunners(runners: readonly RunnerRow[], policy: RunnersPolicy, pool: RunnerPool, names: readonly string[] | null, target: Target): RunnerRow[] {
  if (names === null) {
    const awaiting = runners.filter((runner): boolean => awaitingPools(runner, policy.pools).includes(pool));
    const shared = awaiting.filter((runner): boolean => awaitingPools(runner, policy.pools).length > 1);
    if (shared.length > 0) {
      const others = [...new Set(shared.flatMap((runner): string[] => awaitingPools(runner, policy.pools).filter((other): boolean => other !== pool).map((other): string => other.id)))];
      throw new VerbUsageError(
        `${shared.map((runner): string => runner.name).join(", ")} could join pool ${pool.id} or ${others.join(", ")}: they declare one label set, so which pool a runner is in is yours to say. Name the runners with --runner <name>[,<name>...].`,
      );
    }
    return [...runners.filter((runner): boolean => inPool(runner, pool)), ...awaiting];
  }
  const problems: string[] = [];
  const chosen: RunnerRow[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const runner = runners.find((row): boolean => row.name.toLowerCase() === name.toLowerCase());
    if (runner === undefined) {
      problems.push(`${name} is not registered on ${target.slug}`);
      continue;
    }
    if (!inPool(runner, pool)) {
      const why = refusal(runner, pool, policy.pools);
      if (why !== null) {
        problems.push(why);
        continue;
      }
    }
    chosen.push(runner);
  }
  if (problems.length > 0) {
    throw new RunnerFailure(1, `no runner was relabelled for pool ${pool.id}: ${problems.join("; ")}.`);
  }
  return chosen;
}

/** The labels runner `id` carries now, read from GitHub. */
function readLabels(seams: Seams, target: Target, runner: RunnerRow): string[] {
  const result = gh(seams, runnerLabelsArgv(target, runner.id));
  if (result.code !== 0) throw apiRefusal(result, target, `reading runner ${runner.name}'s labels`);
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw new RunnerFailure(1, `reading runner ${runner.name}'s labels on ${target.slug} answered something that is not JSON.`);
  }
  const list = asRecord(answer)?.["labels"];
  if (!Array.isArray(list)) throw new RunnerFailure(1, `reading runner ${runner.name}'s labels on ${target.slug} answered without a 'labels' list.`);
  return list
    .map((entry): string | null => {
      const name = asRecord(entry)?.["name"];
      return typeof name === "string" ? name : null;
    })
    .filter((name): name is string => name !== null);
}

export function relabelPool(
  seams: Seams,
  target: Target,
  policy: RunnersPolicy,
  pool: RunnerPool,
  names: readonly string[] | null,
  run: boolean,
): RelabelReport {
  const label = poolOwnLabel(pool.id);
  const chosen = selectRunners(fetchRunners(seams, target), policy, pool, names, target);
  const rows: RelabelRow[] = [];
  const done: string[] = [];
  for (const runner of chosen) {
    if (inPool(runner, pool)) {
      rows.push({ name: runner.name, id: runner.id, verdict: "already" });
      continue;
    }
    if (!run) {
      rows.push({ name: runner.name, id: runner.id, verdict: "would-add" });
      continue;
    }
    const partial = done.length === 0 ? "" : ` Already labelled by this run: ${done.join(", ")}.`;
    const added = gh(seams, addLabelArgv(target, runner.id, label));
    if (added.code !== 0) {
      const failure = apiRefusal(added, target, `adding ${label} to runner ${runner.name}`);
      throw new RunnerFailure(failure.exitCode, `${failure.message}${partial}`);
    }
    const after = readLabels(seams, target, runner);
    if (!lower(after).includes(label.toLowerCase())) {
      throw new RunnerFailure(1, `added ${label} to runner ${runner.name} on ${target.slug}, and reading its labels back answered [${after.join(", ")}].${partial}`);
    }
    done.push(runner.name);
    rows.push({ name: runner.name, id: runner.id, verdict: "added" });
  }
  return {
    target: target.slug,
    pool: pool.id,
    label,
    selection: names === null ? "awaiting" : "named",
    run,
    runners: rows,
    changed: rows.filter((row): boolean => row.verdict !== "already").length,
  };
}

export function renderRelabel(report: RelabelReport, target: Target): string[] {
  if (report.runners.length === 0) {
    return [`no runner on ${report.target} awaits ${report.label}: none carries pool ${report.pool}'s declared labels without a pool label. Nothing to do.`];
  }
  const head = report.run
    ? `${report.changed} runner(s) on ${report.target} now carry ${report.label} (pool ${report.pool}); each read back.`
    : `(dry run) would add ${report.label} to ${report.changed} runner(s) on ${report.target} (pool ${report.pool}); pass --run to write.`;
  return [
    head,
    ...renderPipeTable([["name", "verdict"], ...report.runners.map((row): string[] => [row.name, row.verdict])]),
    ...(report.run
      ? []
      : report.runners.filter((row): boolean => row.verdict === "would-add").map((row): string => `would run: gh ${addLabelArgv(target, row.id, report.label).join(" ")}`)),
  ];
}
