// src/runner/inventory.ts -- `nen runner inventory`: every self-hosted runner a
// repository has, parsed against the naming convention, grouped by the pools
// its own `runners` block declares.
//
// TWO READS, BOTH REPOSITORY-SCOPED. `GET /repos/{o}/{r}/actions/runners`
// (paginated to completion -- a runner list is never truncated silently, for
// ../backlog/fetch.ts's "no silent caps" reason) and `GET .../runners/downloads`,
// which is the runner package GitHub will hand THIS repository today, with its
// SHA-256. The second is carried in the report because `runner plan` needs it
// and a plan built from a second, later read could name a version the
// inventory never showed.
//
// THE NAME IS PARSED, NEVER TRUSTED. `<machine>-<consumer>R<slot>` is the one
// convention (../schema/workflow.ts's RUNNER_NAMING); a name that does not
// read as it is "runner 0" -- a pre-existing, grandfathered runner, reported
// and never renamed, and never counted as holding a slot.
//
// POOL MATCHING IS A SUPERSET TEST. A runner belongs to a pool when it carries
// every one of the pool's labels (case-insensitively, the way GitHub's
// scheduler compares them). A runner with an extra label still matches: that is
// exactly how GitHub would schedule a job onto it -- so an interactive pool's
// `desktop` runner is counted in the plain pool of its os and arch as well,
// because it takes that pool's jobs too (#333). A runner that matches no
// declared pool is `unpooled`, listed by name.

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { renderPipeTable } from "../cli/table.js";
import type { RunnerPool, RunnersPolicy } from "../schema/workflow.js";
import { asRecord, ghJson, RunnerFailure } from "./github.js";

/** `<MachineCode>-<ConsumerCode>R<N>`, the spec's own pattern. */
export const RUNNER_NAME = /^([A-Za-z0-9]+)-([A-Za-z0-9]+)R([1-9][0-9]*)$/;

/** GitHub's REST clamp on one page. A page size, never a cap. */
const PAGE_SIZE = 100;
/** A defensive ceiling against a looping answer: 100 pages of 100 runners. */
const MAX_PAGES = 100;

export interface ParsedName {
  readonly convention: "named" | "runner-0";
  readonly machine: string | null;
  readonly consumer: string | null;
  readonly slot: number | null;
}

export function parseRunnerName(name: string): ParsedName {
  const match = RUNNER_NAME.exec(name);
  if (match === null) return { convention: "runner-0", machine: null, consumer: null, slot: null };
  return {
    convention: "named",
    machine: match[1] as string,
    consumer: match[2] as string,
    slot: Number.parseInt(match[3] as string, 10),
  };
}

export interface RunnerRow extends ParsedName {
  readonly name: string;
  readonly id: number;
  readonly os: string;
  readonly status: string;
  readonly busy: boolean;
  readonly labels: readonly string[];
}

/** One row of `GET .../actions/runners/downloads`, in the API's own spelling. */
export interface DownloadRow {
  readonly os: string;
  readonly architecture: string;
  readonly filename: string;
  readonly download_url: string;
  readonly sha256_checksum: string;
}

export interface PoolRow {
  readonly id: string;
  readonly labels: readonly string[];
  /** Runner names, in the API's order. */
  readonly runners: readonly string[];
  readonly online: number;
  /** Online and not busy: what a job queued right now could land on. */
  readonly free: number;
}

export interface InventoryReport {
  readonly target: string;
  readonly runners: readonly RunnerRow[];
  readonly downloads: readonly DownloadRow[];
  /** Null when no `runners` block was read (no --repo policy to group by). */
  readonly pools: readonly PoolRow[] | null;
  readonly unpooled: readonly string[] | null;
}

function parseRunner(value: unknown, target: Target): RunnerRow {
  const row = asRecord(value);
  const name = row?.["name"];
  const id = row?.["id"];
  if (row === null || typeof name !== "string" || typeof id !== "number") {
    throw new RunnerFailure(1, `the runners list on ${target.slug} carried a row this verb cannot read (no name or id): ${JSON.stringify(value)}`);
  }
  const labels = Array.isArray(row["labels"])
    ? row["labels"]
        .map((label): string | null => {
          const record = asRecord(label);
          return record !== null && typeof record["name"] === "string" ? record["name"] : null;
        })
        .filter((label): label is string => label !== null)
    : [];
  return {
    name,
    id,
    os: typeof row["os"] === "string" ? row["os"] : "",
    status: typeof row["status"] === "string" ? row["status"] : "",
    busy: row["busy"] === true,
    labels,
    ...parseRunnerName(name),
  };
}

export function runnersArgv(target: Target, page: number): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/actions/runners?per_page=${PAGE_SIZE}&page=${page}`];
}

export function downloadsArgv(target: Target): readonly string[] {
  return ["api", "--method", "GET", `repos/${target.slug}/actions/runners/downloads`];
}

/** Every registered runner, every page. */
export function fetchRunners(seams: Seams, target: Target): RunnerRow[] {
  const rows: RunnerRow[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const answer = asRecord(ghJson<unknown>(seams, runnersArgv(target, page), target, "listing self-hosted runners"));
    const batch = answer?.["runners"];
    if (answer === null || !Array.isArray(batch)) {
      throw new RunnerFailure(1, `listing self-hosted runners on ${target.slug} answered without a 'runners' list.`);
    }
    rows.push(...batch.map((entry): RunnerRow => parseRunner(entry, target)));
    const total = typeof answer["total_count"] === "number" ? answer["total_count"] : null;
    if (batch.length < PAGE_SIZE || (total !== null && rows.length >= total)) return rows;
  }
  throw new RunnerFailure(1, `listing self-hosted runners on ${target.slug} did not end after ${MAX_PAGES} pages; refusing to report a list this verb could not finish reading.`);
}

/** The runner packages GitHub offers this repository today. */
export function fetchDownloads(seams: Seams, target: Target): DownloadRow[] {
  const answer = ghJson<unknown>(seams, downloadsArgv(target), target, "reading the runner downloads");
  if (!Array.isArray(answer)) {
    throw new RunnerFailure(1, `reading the runner downloads on ${target.slug} answered something that is not a list.`);
  }
  return answer.map((entry): DownloadRow => {
    const row = asRecord(entry);
    const field = (key: string): string => (row !== null && typeof row[key] === "string" ? row[key] : "");
    return {
      os: field("os"),
      architecture: field("architecture"),
      filename: field("filename"),
      download_url: field("download_url"),
      sha256_checksum: field("sha256_checksum"),
    };
  });
}

/** Whether a runner carries every one of a pool's labels, compared as GitHub compares them. */
export function inPool(runner: RunnerRow, pool: Pick<RunnerPool, "labels">): boolean {
  const carried = new Set(runner.labels.map((label): string => label.toLowerCase()));
  return pool.labels.every((label): boolean => carried.has(label.toLowerCase()));
}

export function assembleInventory(
  target: Target,
  runners: readonly RunnerRow[],
  downloads: readonly DownloadRow[],
  policy: RunnersPolicy | null,
  poolFilter: string | null,
): InventoryReport {
  if (policy === null) {
    return { target: target.slug, runners, downloads, pools: null, unpooled: null };
  }
  const pools = policy.pools.filter((pool): boolean => poolFilter === null || pool.id === poolFilter);
  const rows = pools.map((pool): PoolRow => {
    const members = runners.filter((runner): boolean => inPool(runner, pool));
    return {
      id: pool.id,
      labels: pool.labels,
      runners: members.map((runner): string => runner.name),
      online: members.filter((runner): boolean => runner.status === "online").length,
      free: members.filter((runner): boolean => runner.status === "online" && !runner.busy).length,
    };
  });
  // UNPOOLED IS MEASURED AGAINST EVERY DECLARED POOL, not only the one --pool
  // asked about: a runner is unpooled when the repository's policy has no
  // place for it, which a filter on the output does not change.
  const unpooled = runners
    .filter((runner): boolean => !policy.pools.some((pool): boolean => inPool(runner, pool)))
    .map((runner): string => runner.name);
  return { target: target.slug, runners, downloads, pools: rows, unpooled };
}

export function renderInventory(report: InventoryReport): string[] {
  const lines: string[] = [`${report.target}: ${report.runners.length} self-hosted runner(s)`];
  if (report.runners.length > 0) {
    lines.push(
      ...renderPipeTable([
        ["name", "status", "busy", "os", "labels", "machine", "consumer", "slot"],
        ...report.runners.map((runner): string[] => [
          runner.name,
          runner.status,
          runner.busy ? "busy" : "idle",
          runner.os,
          runner.labels.join(","),
          runner.machine ?? "(runner 0)",
          runner.consumer ?? "",
          runner.slot === null ? "" : String(runner.slot),
        ]),
      ]),
    );
  }
  if (report.pools !== null) {
    for (const pool of report.pools) {
      lines.push(
        `pool ${pool.id} [${pool.labels.join(", ")}]: ${pool.runners.length} runner(s), ${pool.online} online, ${pool.free} free${
          pool.runners.length === 0 ? "" : ` -- ${pool.runners.join(", ")}`
        }`,
      );
    }
    lines.push(`unpooled: ${report.unpooled === null || report.unpooled.length === 0 ? "(none)" : report.unpooled.join(", ")}`);
  }
  return lines;
}
