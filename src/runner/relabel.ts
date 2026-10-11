// src/runner/relabel.ts -- `nen runner relabel`: put a pool's own label
// (`pool-<id>`, #340) on runners that were registered before it existed.
//
// WHY A VERB. From #340 every pool's label set ends in `pool-<id>`, and a
// workflow nen renders targets that full set -- so a runner registered with
// GitHub's three defaults alone takes none of the pool's jobs until it carries
// the label. The host script registers new runners with it; this verb is the
// upgrade step for the ones already registered, through GitHub's own
// `POST /repos/{owner}/{repo}/actions/runners/{runner_id}/labels`. Nothing on
// the host changes: the label is the repository's record of the runner, and it
// prevents an ACCIDENTAL join -- it is not an authorization boundary.
//
// NO BULK ADMISSION (Feitan F1). `--run` writes only to runners named, every
// one, with `--runner <names>`: admitting a runner into a pool is the
// maintainer's act per runner, never a sweep over whatever happens to carry
// the defaults today. Without `--runner`, `--run` is refused at exit 2, and
// the dry run lists the runners that WOULD fit, as candidates to name.
//
// DRY-RUN BY DEFAULT, ACTING ONLY WITH `--run`, the shape `shu deploy`,
// `label apply` and `wake fire` share. Every write is READ BACK
// (`GET .../runners/{id}/labels`): "the API accepted it" is not the same fact
// as "the runner carries it", and a read-back that disagrees -- or fails after
// an accepted POST -- is reported as exactly that.
//
// A RUNNER THAT FITS TWO POOLS IS REFUSED, NOT CHOSEN (Nobunaga R1). Two pools
// may declare one label set, and a runner carrying it fits both: admitting it
// into either by name would leave the other pool's declaration claiming it
// too. The safe default is chosen over an acknowledgement flag -- a named
// runner that `awaitingPools` returns for more than one pool is refused at
// exit 2, dry run or not, and the dry run lists it as `candidate (also fits
// <pools>)`, off the `then:` line. Make the declarations differ first.
//
// A RUNNER FITS A POOL EXACTLY (./inventory.ts's `misfit`): it carries every
// declared label and nothing outside them but the pool's own label. `desktop`
// is reserved for an interactive pool. Every named runner is checked before
// any write, and one refusal refuses the call.
//
// GITHUB'S STRINGS ARE PRINTED PLAIN. Runner names and labels are what
// somebody registered; on the human path and in every failure message they go
// through ../cli/plain.ts's `plainLine`. `--json` carries them raw.
//
// ADMIN-ONLY, AND SAID SO. A runner's labels are a repository-admin surface;
// a 403 comes back through ./github.ts's `apiRefusal`, worded "needs admin".

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { VerbUsageError } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { renderPipeTable } from "../cli/table.js";
import { poolOwnLabel, type RunnerPool, type RunnersPolicy } from "../schema/workflow.js";
import { apiRefusal, asRecord, gh, RunnerFailure } from "./github.js";
import { awaitingPools, fetchRunners, inPool, misfit, poolLabelsOf, type RunnerRow } from "./inventory.js";
import { shellWord } from "./shellword.js";

/** `candidate`: eligible, listed by a dry run without `--runner`, to be named. */
export type RelabelVerdict = "added" | "would-add" | "already" | "candidate";

export interface RelabelRow {
  readonly name: string;
  readonly id: number;
  readonly verdict: RelabelVerdict;
  /**
   * A candidate that ALSO fits these other pools -- two pools declaring one
   * label set (Nobunaga R1). Present only then. Such a runner is never put on
   * the `then:` line, and naming it is refused: which pool it joins is a
   * declaration to fix, not a choice nen makes by order.
   */
  readonly alsoFits?: readonly string[];
}

export interface RelabelReport {
  readonly target: string;
  readonly pool: string;
  readonly label: string;
  /** `named` when `--runner` chose the runners, `candidates` when a dry run listed the eligible ones. */
  readonly selection: "named" | "candidates";
  readonly run: boolean;
  readonly runners: readonly RelabelRow[];
  /** How many runners gained the label (or, named without `--run`, would). Candidates are not counted. */
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

export { shellWord };

const lower = (labels: readonly string[]): string[] => labels.map((label): string => label.toLowerCase());

/** Why one named runner cannot take this pool's label, or null when it can. Terminal-safe. */
function refusal(runner: RunnerRow, pool: RunnerPool): string | null {
  const own = poolOwnLabel(pool.id).toLowerCase();
  const foreign = poolLabelsOf(runner).filter((label): boolean => label.toLowerCase() !== own);
  if (foreign.length > 0) {
    return `${plainLine(runner.name)} already carries ${foreign.map((label): string => `'${plainLine(label)}'`).join(", ")}: a runner is in one pool, and moving it is a label to remove in GitHub first`;
  }
  return misfit(runner, pool);
}

/** The runners a `--runner` list names, each checked before anything is written. */
function namedRunners(runners: readonly RunnerRow[], policy: RunnersPolicy, pool: RunnerPool, names: readonly string[], target: Target): RunnerRow[] {
  const problems: string[] = [];
  const ambiguous: string[] = [];
  const chosen: RunnerRow[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    if (seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    const runner = runners.find((row): boolean => row.name.toLowerCase() === name.toLowerCase());
    if (runner === undefined) {
      problems.push(`${plainLine(name)} is not registered on ${target.slug}`);
      continue;
    }
    const why = inPool(runner, pool) ? null : refusal(runner, pool);
    if (why !== null) {
      problems.push(why);
      continue;
    }
    const others = inPool(runner, pool) ? [] : awaitingPools(runner, policy.pools).filter((other): boolean => other !== pool);
    if (others.length > 0) {
      ambiguous.push(`${plainLine(runner.name)} fits pool ${pool.id} and ${others.map((other): string => other.id).join(", ")}`);
      continue;
    }
    chosen.push(runner);
  }
  if (ambiguous.length > 0 && problems.length === 0) {
    throw new VerbUsageError(
      `no runner was relabelled for pool ${pool.id}: ${ambiguous.join("; ")} -- those pools declare one label set, so a runner carrying it would belong to both. Make their declared labels differ, then relabel.`,
    );
  }
  if (problems.length > 0) {
    throw new RunnerFailure(1, `no runner was relabelled for pool ${pool.id}: ${[...problems, ...ambiguous].join("; ")}.`);
  }
  return chosen;
}

/** The labels runner `id` carries now, read from GitHub. */
function readLabels(seams: Seams, target: Target, runner: RunnerRow): string[] {
  const result = gh(seams, runnerLabelsArgv(target, runner.id));
  if (result.code !== 0) throw apiRefusal(result, target, `reading runner ${plainLine(runner.name)}'s labels`);
  let answer: unknown;
  try {
    answer = JSON.parse(result.stdout);
  } catch {
    throw new RunnerFailure(1, `reading runner ${plainLine(runner.name)}'s labels on ${target.slug} answered something that is not JSON.`);
  }
  const list = asRecord(answer)?.["labels"];
  if (!Array.isArray(list)) throw new RunnerFailure(1, `reading runner ${plainLine(runner.name)}'s labels on ${target.slug} answered without a 'labels' list.`);
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
  if (names === null && run) {
    throw new VerbUsageError(
      `--run needs --runner <name>[,<name>...] naming every runner to label: nen never admits runners into pool ${pool.id} in bulk. Run without --run to list the eligible ones, then name them.`,
    );
  }
  const runners = fetchRunners(seams, target);
  if (names === null) {
    const rows = [
      ...runners.filter((runner): boolean => inPool(runner, pool)).map((runner): RelabelRow => ({ name: runner.name, id: runner.id, verdict: "already" })),
      ...runners
        .filter((runner): boolean => awaitingPools(runner, policy.pools).includes(pool))
        .map((runner): RelabelRow => {
          const others = awaitingPools(runner, policy.pools).filter((other): boolean => other !== pool).map((other): string => other.id);
          return others.length === 0 ? { name: runner.name, id: runner.id, verdict: "candidate" } : { name: runner.name, id: runner.id, verdict: "candidate", alsoFits: others };
        }),
    ];
    return { target: target.slug, pool: pool.id, label, selection: "candidates", run: false, runners: rows, changed: 0 };
  }
  const chosen = namedRunners(runners, policy, pool, names, target);
  const rows: RelabelRow[] = [];
  const done: string[] = [];
  const partial = (): string => (done.length === 0 ? "" : ` Already labelled by this run: ${done.map(plainLine).join(", ")}.`);
  /** A message, ended with a period before anything follows it (R4). */
  const ended = (message: string): string => (message.endsWith(".") ? message : `${message}.`);
  for (const runner of chosen) {
    if (inPool(runner, pool)) {
      rows.push({ name: runner.name, id: runner.id, verdict: "already" });
      continue;
    }
    if (!run) {
      rows.push({ name: runner.name, id: runner.id, verdict: "would-add" });
      continue;
    }
    const added = gh(seams, addLabelArgv(target, runner.id, label));
    if (added.code !== 0) {
      const failure = apiRefusal(added, target, `adding ${label} to runner ${plainLine(runner.name)}`);
      throw new RunnerFailure(failure.exitCode, `${ended(failure.message)}${partial()}`);
    }
    let after: string[];
    try {
      after = readLabels(seams, target, runner);
    } catch (error) {
      if (!(error instanceof RunnerFailure)) throw error;
      // The write happened; only the proof of it is missing. Said as such, at
      // the read's own exit code, so nobody re-reads "failed" as "not written".
      throw new RunnerFailure(error.exitCode, `the POST for ${plainLine(runner.name)} was accepted; its read-back failed: ${ended(error.message)}${partial()}`);
    }
    if (!lower(after).includes(label.toLowerCase())) {
      throw new RunnerFailure(
        1,
        `added ${label} to runner ${plainLine(runner.name)} on ${target.slug}, and reading its labels back answered [${after.map(plainLine).join(", ")}].${partial()}`,
      );
    }
    done.push(runner.name);
    rows.push({ name: runner.name, id: runner.id, verdict: "added" });
  }
  return {
    target: target.slug,
    pool: pool.id,
    label,
    selection: "named",
    run,
    runners: rows,
    changed: rows.filter((row): boolean => row.verdict !== "already").length,
  };
}

export function renderRelabel(report: RelabelReport, target: Target): string[] {
  const verdict = (row: RelabelRow): string => (row.alsoFits === undefined ? row.verdict : `${row.verdict} (also fits ${row.alsoFits.join(", ")})`);
  const table = (): string[] => renderPipeTable([["name", "verdict"], ...report.runners.map((row): string[] => [plainLine(row.name), verdict(row)])]);
  if (report.selection === "candidates") {
    const all = report.runners.filter((row): boolean => row.verdict === "candidate");
    const candidates = all.filter((row): boolean => row.alsoFits === undefined).map((row): string => plainLine(row.name));
    const shared = all.length - candidates.length;
    const sharedNote = shared === 0 ? [] : [`${shared} runner(s) fit more than one pool and cannot be named: make those pools' declared labels differ first.`];
    if (all.length === 0) {
      return [
        `no runner on ${report.target} is a candidate for ${report.label}: none fits pool ${report.pool}'s declared labels exactly without a pool label. Nothing to do.`,
        ...(report.runners.length === 0 ? [] : table()),
      ];
    }
    return [
      `(dry run) ${all.length} runner(s) on ${report.target} could take ${report.label} (pool ${report.pool}); nothing is admitted in bulk -- name each one you mean:`,
      ...table(),
      ...sharedNote,
      ...(candidates.length === 0
        ? []
        : [`then: nen runner relabel --target ${shellWord(report.target)} --pool ${shellWord(report.pool)} --runner ${shellWord(candidates.join(","))} --run`]),
    ];
  }
  if (report.changed === 0) {
    return [`every selected runner already carries ${report.label}; nothing written.`, ...table()];
  }
  const head = report.run
    ? `${report.changed} runner(s) on ${report.target} now carry ${report.label} (pool ${report.pool}); each read back.`
    : `(dry run) would add ${report.label} to ${report.changed} runner(s) on ${report.target} (pool ${report.pool}); pass --run to write.`;
  return [
    head,
    ...table(),
    ...(report.run
      ? []
      : report.runners
          .filter((row): boolean => row.verdict === "would-add")
          .map((row): string => `would run: gh ${addLabelArgv(target, row.id, report.label).map(shellWord).join(" ")}`)),
  ];
}
