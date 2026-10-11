// src/runner/verify.ts -- `nen runner verify`: are the runners a script just
// registered present, online, and carrying the labels they were meant to?
//
// NEVER A PARTIAL PASS. Every expected name is judged on every attempt, and
// the verdict is their conjunction: two of three online is exit 1 with a row
// per runner, exactly as `pr ready` reports every conjunct rather than the
// first. `--wait` polls the inventory every 10 s until all pass or the budget
// is spent; `--wait 0` (the default) asks once.
//
// THE POOL'S OWN LABEL IS CHECKED LIKE ANY OTHER (#340). `--pool <id>` adds the
// pool's full set -- `pool-<id>` included -- to `--labels`, and a runner that
// lacks only that label is named with the step that gives it one: a runner
// registered before #340, which no pool-labelled workflow will schedule onto.
//
// ONLINE IS NOT CAPABLE. A runner that passes here has a live runner process
// talking to GitHub -- bankai's rule W3: registration is not capability. The
// pool is proved by `runner preflight`, a job running AS the service, and
// never by this verb.

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { renderPipeTable } from "../cli/table.js";
import { POOL_LABEL_PREFIX } from "../schema/workflow.js";
import { POLL_INTERVAL_MS, type Sleep } from "./github.js";
import { fetchRunners, type RunnerRow } from "./inventory.js";

export type VerifyVerdict = "ok" | "missing" | "offline" | "labels";

export interface VerifyRow {
  readonly name: string;
  readonly verdict: VerifyVerdict;
  readonly status: string | null;
  readonly missingLabels: readonly string[];
  /** `missing | offline | labels: missing <x>`, or `ok`. */
  readonly detail: string;
}

export interface VerifyReport {
  readonly target: string;
  readonly ok: boolean;
  readonly attempts: number;
  readonly waitedSeconds: number;
  readonly runners: readonly VerifyRow[];
}

export function judge(runners: readonly RunnerRow[], expect: readonly string[], labels: readonly string[]): VerifyRow[] {
  return expect.map((name): VerifyRow => {
    const runner = runners.find((row): boolean => row.name.toLowerCase() === name.toLowerCase());
    if (runner === undefined) return { name, verdict: "missing", status: null, missingLabels: [], detail: "missing" };
    if (runner.status !== "online") {
      return { name, verdict: "offline", status: runner.status, missingLabels: [], detail: runner.status === "" ? "offline" : runner.status };
    }
    const carried = new Set(runner.labels.map((label): string => label.toLowerCase()));
    const missingLabels = labels.filter((label): boolean => !carried.has(label.toLowerCase()));
    if (missingLabels.length > 0) {
      const own = missingLabels.find((label): boolean => label.toLowerCase().startsWith(POOL_LABEL_PREFIX));
      const remedy = own === undefined ? "" : ` -- registered without its pool label: nen runner relabel --pool ${own.slice(POOL_LABEL_PREFIX.length)} --runner ${runner.name} --run`;
      return { name, verdict: "labels", status: runner.status, missingLabels, detail: `labels: missing ${missingLabels.join(", ")}${remedy}` };
    }
    return { name, verdict: "ok", status: runner.status, missingLabels: [], detail: "ok" };
  });
}

export function verifyRunners(
  seams: Seams,
  target: Target,
  expect: readonly string[],
  labels: readonly string[],
  waitSeconds: number,
  sleep: Sleep,
): VerifyReport {
  let waitedMs = 0;
  for (let attempt = 1; ; attempt += 1) {
    const rows = judge(fetchRunners(seams, target), expect, labels);
    const ok = rows.every((row): boolean => row.verdict === "ok");
    if (ok || waitedMs + POLL_INTERVAL_MS > waitSeconds * 1000) {
      return { target: target.slug, ok, attempts: attempt, waitedSeconds: waitedMs / 1000, runners: rows };
    }
    sleep(POLL_INTERVAL_MS);
    waitedMs += POLL_INTERVAL_MS;
  }
}

export function renderVerify(report: VerifyReport): string[] {
  return [
    `${report.ok ? "ok" : "NOT READY"}: ${report.runners.filter((row): boolean => row.verdict === "ok").length}/${report.runners.length} runner(s) online on ${report.target} (${report.attempts} attempt(s), waited ${report.waitedSeconds}s)`,
    ...renderPipeTable([["name", "verdict"], ...report.runners.map((row): string[] => [row.name, row.detail])]),
  ];
}
