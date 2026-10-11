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
// exactly how GitHub would schedule a job onto it. Every pool's set ends in its
// own `pool-<id>` (#340), so an interactive pool's `desktop` runner, which
// carries `pool-<its pool>`, is no longer counted in the plain pool of its os
// and arch: it takes none of that pool's jobs. A runner that matches no
// declared pool is `unpooled`, listed by name.
//
// A RUNNER REGISTERED BEFORE #340 carries the defaults and no pool label, so
// it matches no pool and takes none of the jobs a pool-labelled workflow
// sends. It is listed under the pool it would join -- `unlabelled` -- so the
// upgrade step (`nen runner relabel`) has its list. Which pool that is comes
// from `awaitingPools`: the pools whose declared labels it carries EXACTLY --
// every one of them, and no label outside them. `desktop` is reserved: a
// runner carrying it never fits a pool that does not declare it, so with only
// a plain pool declared, a desktop runner awaits nothing (#340, Nobunaga N1).

import type { Target } from "../github/target.js";
import type { Seams } from "../seam/exec.js";
import { renderPipeTable } from "../cli/table.js";
import { plainLine } from "../cli/plain.js";
import { shellWord } from "./shellword.js";
import { DESKTOP_LABEL, POOL_LABEL_PREFIX, poolOwnLabel, type RunnerPool, type RunnersPolicy } from "../schema/workflow.js";
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
  /** Runners that carry this pool's declared labels and no pool label yet: what `runner relabel` would add `pool-<id>` to (#340). */
  readonly unlabelled: readonly string[];
  /**
   * Present only when some `unlabelled` runner ALSO fits other pools -- two
   * pools declaring one label set: runner name -> the other pools' ids. Such a
   * runner is left out of the relabel hint (`runner relabel` refuses it).
   */
  readonly alsoFit?: Readonly<Record<string, readonly string[]>>;
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

/** Whether a runner carries every one of `labels`, compared as GitHub compares them. */
function carriesAll(runner: Pick<RunnerRow, "labels">, labels: readonly string[]): boolean {
  const carried = new Set(runner.labels.map((label): string => label.toLowerCase()));
  return labels.every((label): boolean => carried.has(label.toLowerCase()));
}

/** Whether a runner carries every one of a pool's labels, its own `pool-<id>` included. */
export function inPool(runner: Pick<RunnerRow, "labels">, pool: Pick<RunnerPool, "labels">): boolean {
  return carriesAll(runner, pool.labels);
}

/** A pool's DECLARED labels: its full set without its own `pool-<id>` (#340). */
export function declaredOf(pool: Pick<RunnerPool, "id" | "labels">): readonly string[] {
  const own = poolOwnLabel(pool.id).toLowerCase();
  return pool.labels.filter((label): boolean => label.toLowerCase() !== own);
}

/** Every `pool-*` label a runner carries, as it carries them. */
export function poolLabelsOf(runner: Pick<RunnerRow, "labels">): string[] {
  return runner.labels.filter((label): boolean => label.toLowerCase().startsWith(POOL_LABEL_PREFIX));
}

/**
 * Why a runner cannot be relabelled into `pool`, or null when it fits it
 * EXACTLY: it carries every one of the pool's declared labels and nothing
 * outside them but the pool's own label (#340). `desktop` is reserved for an
 * interactive pool and named as such. Names and labels are GitHub's, so the
 * sentence is made terminal-safe here: it is only ever printed.
 */
export function misfit(runner: Pick<RunnerRow, "name" | "labels">, pool: Pick<RunnerPool, "id" | "labels">): string | null {
  const declared = declaredOf(pool);
  const declaredLower = declared.map((label): string => label.toLowerCase());
  const own = poolOwnLabel(pool.id).toLowerCase();
  const carried = runner.labels.map((label): string => label.toLowerCase());
  const name = plainLine(runner.name);
  const missing = declared.filter((label): boolean => !carried.includes(label.toLowerCase()));
  if (missing.length > 0) {
    return `${name} lacks ${missing.join(", ")} of pool ${pool.id}'s labels [${declared.join(", ")}], so it is not a runner of that pool`;
  }
  const extra = runner.labels.filter((label): boolean => !declaredLower.includes(label.toLowerCase()) && label.toLowerCase() !== own);
  if (extra.some((label): boolean => label.toLowerCase() === DESKTOP_LABEL)) {
    return `${name} carries '${DESKTOP_LABEL}', which is reserved for an interactive pool, and pool ${pool.id} does not declare it: declare the interactive pool ("mode": "interactive") and relabel it into that one`;
  }
  if (extra.length > 0) {
    return `${name} carries ${extra.map((label): string => `'${plainLine(label)}'`).join(", ")}, which pool ${pool.id} does not declare: a pool's runners carry its declared labels and its own label, nothing else`;
  }
  return null;
}

/**
 * The pools a runner WOULD join if it carried their own label (#340): none for
 * a runner that already carries any `pool-*` label; otherwise every pool it
 * fits EXACTLY (`misfit` is null). Two pools that declare one set are both
 * returned: which one the runner belongs to is the maintainer's to say.
 */
export function awaitingPools<P extends Pick<RunnerPool, "id" | "labels">>(runner: Pick<RunnerRow, "name" | "labels">, pools: readonly P[]): P[] {
  if (poolLabelsOf(runner).length > 0) return [];
  return pools.filter((pool): boolean => misfit(runner, pool) === null);
}

/** The unlabelled runners of `pool` that also fit other pools, as PoolRow's optional `alsoFit`. */
function alsoFitOf(runners: readonly RunnerRow[], pools: readonly RunnerPool[], pool: RunnerPool): { alsoFit?: Record<string, string[]> } {
  const shared: Record<string, string[]> = {};
  for (const runner of runners) {
    const fits = awaitingPools(runner, pools);
    if (!fits.includes(pool) || fits.length < 2) continue;
    shared[runner.name] = fits.filter((other): boolean => other !== pool).map((other): string => other.id);
  }
  return Object.keys(shared).length === 0 ? {} : { alsoFit: shared };
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
      unlabelled: runners.filter((runner): boolean => awaitingPools(runner, policy.pools).includes(pool)).map((runner): string => runner.name),
      ...alsoFitOf(runners, policy.pools, pool),
    };
  });
  // UNPOOLED IS MEASURED AGAINST EVERY DECLARED POOL, not only the one --pool
  // asked about: a runner is unpooled when the repository's policy has no
  // place for it, which a filter on the output does not change. A runner that
  // only lacks its pool label HAS a place -- it is listed as `unlabelled` under
  // the pool it awaits (#340) -- so it is not unpooled.
  const unpooled = runners
    .filter((runner): boolean => !policy.pools.some((pool): boolean => inPool(runner, pool)) && awaitingPools(runner, policy.pools).length === 0)
    .map((runner): string => runner.name);
  return { target: target.slug, runners, downloads, pools: rows, unpooled };
}

/**
 * The pool line's tail naming the runners that await its own label, and the
 * exact relabel line -- target, pool and every runner named (#340: `--run`
 * acts only on runners named). Runner names are GitHub's: plain here, raw in
 * `--json`.
 */
function unlabelledHint(target: string, pool: PoolRow): string {
  if (pool.unlabelled.length === 0) return "";
  const shared = pool.alsoFit ?? {};
  // A runner two pools fit is never put on the command (Nobunaga N2): relabel
  // refuses to name it. It is listed, with the fix, and the command is
  // omitted when no runner is left for it.
  const nameable = pool.unlabelled.filter((name): boolean => shared[name] === undefined).map(plainLine);
  const byOthers = new Map<string, string[]>();
  for (const name of pool.unlabelled) {
    const others = shared[name];
    if (others === undefined) continue;
    const key = others.join(", ");
    byOthers.set(key, [...(byOthers.get(key) ?? []), plainLine(name)]);
  }
  const notes = [...byOthers].map(([others, names]): string => `; ${names.join(", ")} also fit ${others}: make the declarations differ`);
  const command =
    nameable.length === 0
      ? ""
      : ` (nen runner relabel --target ${shellWord(target)} --pool ${shellWord(pool.id)} --runner ${shellWord(nameable.join(","))} --run)`;
  return `; without ${poolOwnLabel(pool.id)}: ${pool.unlabelled.map(plainLine).join(", ")}${command}${notes.join("")}`;
}

export function renderInventory(report: InventoryReport): string[] {
  const lines: string[] = [`${report.target}: ${report.runners.length} self-hosted runner(s)`];
  if (report.runners.length > 0) {
    lines.push(
      ...renderPipeTable([
        ["name", "status", "busy", "os", "labels", "machine", "consumer", "slot"],
        ...report.runners.map((runner): string[] => [
          plainLine(runner.name),
          plainLine(runner.status),
          runner.busy ? "busy" : "idle",
          plainLine(runner.os),
          runner.labels.map(plainLine).join(","),
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
          pool.runners.length === 0 ? "" : ` -- ${pool.runners.map(plainLine).join(", ")}`
        }${unlabelledHint(report.target, pool)}`,
      );
    }
    lines.push(`unpooled: ${report.unpooled === null || report.unpooled.length === 0 ? "(none)" : report.unpooled.map(plainLine).join(", ")}`);
  }
  return lines;
}
