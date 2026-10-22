// src/run/verify.ts -- `nen run verify`: every PR a run recorded, read LIVE.
//
// The `then` gate of a futon run, its resume and its final register all ask
// one question -- "what became of every PR this run opened?" -- and this is
// the answer read from GitHub, never from memory: open, merged, or closed
// without a merge, with the unmerged list. It decides nothing. Whether the gate
// passes on an empty unmerged list is the caller's rule.
//
// "COULD NOT READ" IS NEVER "NOTHING FOUND". A PR `gh` could not read is listed
// under `unread` with its reason and is in neither the open nor the merged
// count; one unread PR makes the whole verb exit 1, because a gate that read
// nine PRs merged and one PR unreadable has not read "all merged".

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import type { RunManifest, RunPr } from "./manifest.js";

export type LiveState = "open" | "merged" | "closed-unmerged";

export interface LivePr {
  readonly state: LiveState;
  readonly base: string;
  readonly headRef: string;
  readonly head: string;
  /** When the PR was opened; null when gh did not say. */
  readonly createdAt: string | null;
}

export type LiveRead = { readonly ok: true; readonly pr: LivePr } | { readonly ok: false; readonly reason: string };

export function prViewArgv(target: Target, pr: number): readonly string[] {
  return ["pr", "view", String(pr), "--repo", target.slug, "--json", "number,state,mergedAt,createdAt,baseRefName,headRefName,headRefOid"];
}

/** One PR, read live; every field validated, a malformed answer an unread with its reason. */
export function readLivePr(seams: Seams, target: Target, pr: number): LiveRead {
  const result = seams.run(GH, [...prViewArgv(target, pr)]);
  if (result.spawnFailed) return { ok: false, reason: "gh could not be started" };
  if (result.code !== 0) return { ok: false, reason: outputLines(result.stderr).join(" ") || `gh exit ${result.code}` };
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(result.stdout) as Record<string, unknown>;
  } catch {
    return { ok: false, reason: "gh answered with text that is not JSON" };
  }
  const state = raw["state"];
  const base = raw["baseRefName"];
  const headRef = raw["headRefName"];
  const head = raw["headRefOid"];
  if (raw["number"] !== pr) return { ok: false, reason: `gh answered for PR ${JSON.stringify(raw["number"])}, not #${pr}` };
  if (typeof base !== "string" || typeof headRef !== "string" || typeof head !== "string") {
    return { ok: false, reason: "gh's answer lacks baseRefName, headRefName or headRefOid" };
  }
  const createdAt = typeof raw["createdAt"] === "string" && !Number.isNaN(Date.parse(raw["createdAt"])) ? raw["createdAt"] : null;
  if (state === "OPEN") return { ok: true, pr: { state: "open", base, headRef, head, createdAt } };
  if (state === "MERGED") return { ok: true, pr: { state: "merged", base, headRef, head, createdAt } };
  if (state === "CLOSED") {
    // GitHub reports a merged PR as MERGED; a CLOSED one with a merge time is
    // not a shape it produces, so it is refused rather than guessed at.
    if (raw["mergedAt"] !== null && raw["mergedAt"] !== undefined) return { ok: false, reason: "state CLOSED with a mergedAt -- not a shape nen reads" };
    return { ok: true, pr: { state: "closed-unmerged", base, headRef, head, createdAt } };
  }
  return { ok: false, reason: `state ${JSON.stringify(state)} is not OPEN, MERGED or CLOSED` };
}

export interface VerifiedPr {
  readonly issue: string | null;
  readonly pr: number;
  readonly kind: RunPr["kind"];
  readonly recordedBase: string;
  readonly recordedHead: string;
  /** null when the PR could not be read. */
  readonly state: LiveState | null;
  readonly base: string | null;
  readonly headRef: string | null;
  readonly head: string | null;
  /** The live head is not the head last recorded; null when unread. */
  readonly headMoved: boolean | null;
  readonly unreadReason: string | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface VerifyReport {
  readonly run: string;
  readonly target: string;
  readonly recorded: number;
  readonly counts: { readonly open: number; readonly merged: number; readonly closedUnmerged: number; readonly unread: number };
  /** Open PRs, in record order. */
  readonly open: readonly number[];
  /**
   * Every PR read and not merged -- open or closed without a merge -- in record
   * order; NULL when any PR was unread, because an unread PR may be either and
   * a list that leaves it out is not the unmerged list.
   */
  readonly unmerged: readonly number[] | null;
  readonly unread: readonly { readonly pr: number; readonly reason: string }[];
  readonly prs: readonly VerifiedPr[];
  /** The efforts the run parked on an unanswered ask-once row (HR-5), as recorded. */
  readonly parked: RunManifest["parked"];
}

export function verifyRun(manifest: RunManifest, target: Target, read: (pr: number) => LiveRead): VerifyReport {
  const prs: VerifiedPr[] = manifest.prs.map((entry): VerifiedPr => {
    const live = read(entry.pr);
    const recorded = { issue: entry.issue, pr: entry.pr, kind: entry.kind, recordedBase: entry.base, recordedHead: entry.head };
    if (!live.ok) return { ...recorded, state: null, base: null, headRef: null, head: null, headMoved: null, unreadReason: live.reason };
    return {
      ...recorded,
      state: live.pr.state,
      base: live.pr.base,
      headRef: live.pr.headRef,
      head: live.pr.head,
      headMoved: !live.pr.head.toLowerCase().startsWith(entry.head.toLowerCase()),
      unreadReason: null,
    };
  });
  const of = (state: LiveState): readonly number[] => prs.filter((row): boolean => row.state === state).map((row): number => row.pr);
  const unread = prs.filter((row): boolean => row.state === null).map((row) => ({ pr: row.pr, reason: row.unreadReason as string }));
  return {
    run: manifest.id,
    target: target.slug,
    recorded: prs.length,
    counts: { open: of("open").length, merged: of("merged").length, closedUnmerged: of("closed-unmerged").length, unread: unread.length },
    open: of("open"),
    unmerged: unread.length > 0 ? null : prs.filter((row): boolean => row.state === "open" || row.state === "closed-unmerged").map((row): number => row.pr),
    unread,
    prs,
    parked: manifest.parked,
  };
}

export function renderVerify(report: VerifyReport): string[] {
  const lines = [
    `run ${report.run} on ${report.target}: ${report.recorded} PR(s) recorded -- ${report.counts.open} open, ${report.counts.merged} merged, ${report.counts.closedUnmerged} closed unmerged, ${report.counts.unread} unread`,
  ];
  for (const row of report.prs) {
    if (row.state === null) {
      lines.push(`  #${row.pr} ${row.issue ?? "-"} [${row.kind}] unread: ${row.unreadReason ?? ""}`);
      continue;
    }
    const moved = row.headMoved === true ? ` (head moved from ${row.recordedHead.slice(0, 8)})` : "";
    const rebased = row.base !== row.recordedBase ? ` (base now ${row.base}, recorded ${row.recordedBase})` : "";
    lines.push(`  #${row.pr} ${row.issue ?? "-"} [${row.kind}] ${row.state} -> ${row.base}${rebased}${moved}`);
  }
  for (const row of report.parked) lines.push(`  parked ${row.issue} on row ${row.row} since ${row.at}`);
  lines.push(
    report.unmerged === null
      ? `unmerged: unknown (${report.counts.unread} unread)`
      : `unmerged: ${report.unmerged.length === 0 ? "(none)" : report.unmerged.map((n): string => `#${n}`).join(", ")}`,
  );
  return lines;
}
