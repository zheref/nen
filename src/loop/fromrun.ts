// src/loop/fromrun.ts -- `nen loop slots --from-run`: the efforts document
// BUILT from a run's manifest and live reads, never typed by the caller (SDD
// plan finding D4, autonomy-loop#5).
//
// WHY. `--efforts` is a file the caller writes, and its `prompted` field is a
// fact the caller asserts. Three canon sites freed a slot at three different
// moments, so the seven-slot cap was an honour system. Under a run every field
// is computed:
//
//   * which efforts exist   -- the manifest's `delivery` PRs (../run/manifest.ts);
//                              integration and release PRs are not efforts and
//                              hold no slot, and are listed so;
//   * prOpen / merged       -- the PR's live state (gh pr view);
//   * ready                 -- `nen pr ready`'s own verdict, in process;
//   * prompted              -- a valid stop marker (`.nen/last-stop.json`,
//                              ../stop/marker.ts) in the worktree checked out
//                              on the PR's head branch: the bell rang there;
//   * stacked               -- the PR's live base is the head branch of another
//                              PR the run recorded.
//
// The rule that turns those facts into a free slot is still --repo's
// `monitor.localSlotFrees` (HR-5), read by the caller of this module.
//
// COULD NOT READ IS NEVER NOTHING FOUND. A PR that could not be read, a
// readiness that came back unevaluated, or a marker that will not parse keeps
// its effort OCCUPYING a slot -- the conservative count -- and is named under
// `unread`, so a reader can tell "held" from "held because unknown".

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { GIT, type Seams } from "../seam/exec.js";
import { MARKER_FILE, parseMarker } from "../stop/marker.js";
import type { RunManifest } from "../run/manifest.js";
import type { LiveRead } from "../run/verify.js";
import type { Effort } from "./slots.js";
import { prReady } from "../verbs/pr_ready.js";

export type ReadinessRead = { readonly ok: true; readonly ready: boolean } | { readonly ok: false; readonly reason: string };
export type MarkerRead = { readonly ok: true; readonly present: boolean; readonly where: string | null } | { readonly ok: false; readonly reason: string };

export interface FromRunDeps {
  readonly readPr: (pr: number) => LiveRead;
  readonly readiness: (pr: number) => Promise<ReadinessRead>;
  readonly marker: (headBranch: string) => MarkerRead;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE (`fromRun`). */
export interface FromRunReport {
  readonly run: string;
  readonly efforts: readonly (Effort & { readonly pr: number; readonly issue: string; readonly facts: string })[];
  /** Integration and release PRs: recorded by the run, never a slot. */
  readonly notEfforts: readonly number[];
  /** Delivery PRs closed without a merge: no longer an effort, so no slot. */
  readonly closedUnmerged: readonly number[];
  readonly unread: readonly { readonly pr: number; readonly reason: string }[];
}

export async function effortsFromRun(manifest: RunManifest, deps: FromRunDeps): Promise<FromRunReport> {
  const live = new Map(manifest.prs.map((row) => [row.pr, deps.readPr(row.pr)] as const));
  // Another EFFORT's head branch: a delivery PR's. An integration branch is
  // also the head of the run's integration PR, and a PR based on it is not
  // stacked on an effort -- it is on the run's integration line.
  const headBranches = new Map<number, string>();
  for (const row of manifest.prs) {
    const read = live.get(row.pr);
    if (row.kind === "delivery" && read !== undefined && read.ok) headBranches.set(row.pr, read.pr.headRef);
  }

  const efforts: FromRunReport["efforts"][number][] = [];
  const notEfforts: number[] = [];
  const closedUnmerged: number[] = [];
  const unread: { pr: number; reason: string }[] = [];
  for (const row of manifest.prs) {
    if (row.kind !== "delivery") {
      notEfforts.push(row.pr);
      continue;
    }
    const id = `${row.issue} #${row.pr}`;
    const read = live.get(row.pr) as LiveRead;
    if (!read.ok) {
      unread.push({ pr: row.pr, reason: `PR not read: ${read.reason}` });
      efforts.push({ id, pr: row.pr, issue: row.issue, plane: "local", prOpen: true, ready: false, prompted: false, merged: false, stacked: false, facts: "unread -- held" });
      continue;
    }
    if (read.pr.state === "closed-unmerged") {
      closedUnmerged.push(row.pr);
      continue;
    }
    if (read.pr.state === "merged") {
      efforts.push({ id, pr: row.pr, issue: row.issue, plane: "local", prOpen: true, ready: true, prompted: true, merged: true, stacked: false, facts: "merged" });
      continue;
    }
    const stacked = [...headBranches].some(([other, branch]): boolean => other !== row.pr && branch === read.pr.base);
    const readiness = await deps.readiness(row.pr);
    if (!readiness.ok) unread.push({ pr: row.pr, reason: `readiness unevaluated: ${readiness.reason}` });
    const marker = deps.marker(read.pr.headRef);
    if (!marker.ok) unread.push({ pr: row.pr, reason: `stop marker unread: ${marker.reason}` });
    const ready = readiness.ok && readiness.ready;
    const prompted = marker.ok && marker.present;
    const facts = [
      "open",
      readiness.ok ? (readiness.ready ? "ready" : "not-ready") : "readiness unevaluated",
      marker.ok ? (marker.present ? `stop marker at ${marker.where ?? "?"}` : "no stop marker") : "stop marker unread",
      stacked ? `stacked on ${read.pr.base}` : `base ${read.pr.base}`,
    ].join(", ");
    efforts.push({ id, pr: row.pr, issue: row.issue, plane: "local", prOpen: true, ready, prompted, merged: false, stacked, facts });
  }
  return { run: manifest.id, efforts, notEfforts, closedUnmerged, unread };
}

/**
 * The worktree checked out on `branch`, from `git worktree list --porcelain`
 * under `root`, and whether a valid stop marker sits in it. No worktree on
 * the branch is a fact (`present: false`): the effort's bell cannot have rung
 * anywhere nen can see. A marker that is there and will not parse is unread.
 */
export function markerForBranch(seams: Seams, root: string, branch: string): MarkerRead {
  const listed = seams.run(GIT, ["-C", root, "worktree", "list", "--porcelain"]);
  if (listed.spawnFailed || listed.code !== 0) return { ok: false, reason: "git worktree list failed" };
  let path: string | null = null;
  let current: string | null = null;
  for (const line of listed.stdout.split(/\r?\n/)) {
    if (line.startsWith("worktree ")) current = line.slice("worktree ".length);
    else if (line === `branch refs/heads/${branch}` && current !== null) path = current;
  }
  if (path === null) return { ok: true, present: false, where: null };
  const file = join(path, ...MARKER_FILE.split("/"));
  if (!existsSync(file)) return { ok: true, present: false, where: null };
  let document: unknown;
  try {
    document = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { ok: false, reason: `${file} is not JSON (${error instanceof Error ? error.message : String(error)})` };
  }
  const parsed = parseMarker(document);
  if (!parsed.ok) return { ok: false, reason: `${file}: ${parsed.reason}` };
  return { ok: true, present: true, where: file };
}

/**
 * `nen pr ready <pr> --gh-repo <slug> --json`, IN PROCESS -- the same function
 * the verb runs (../report/objects.ts's `readinessFromGate` reads it the same
 * way), so a slot count and a `pr ready` asked of one snapshot cannot
 * disagree. `unevaluated`, or no report at all, is a failed read, never "not
 * ready": the effort stays held and the reason is named.
 */
export async function readinessInProcess(slug: string, pr: number, repoRoot: string): Promise<ReadinessRead> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await prReady(
    { positionals: ["pr", "ready", String(pr)], values: { "gh-repo": slug }, booleans: new Set(["json"]), repoFlag: repoRoot },
    { out: (line): void => void out.push(line), err: (line): void => void err.push(line) },
  );
  let report: { verdict?: unknown; remedy?: unknown };
  try {
    report = JSON.parse(out.join("\n")) as typeof report;
  } catch {
    return { ok: false, reason: `pr ready produced no report (exit ${code})${err.length === 0 ? "" : `: ${err.join(" ")}`}` };
  }
  if (report.verdict === "ready") return { ok: true, ready: true };
  if (report.verdict === "not-ready") return { ok: true, ready: false };
  return { ok: false, reason: `pr ready verdict ${JSON.stringify(report.verdict)}${typeof report.remedy === "string" && report.remedy !== "" ? ` (${report.remedy})` : ""}` };
}
