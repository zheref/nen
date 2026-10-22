// src/wc/overlap.ts -- `nen wc overlap`: whether a set of efforts touch
// disjoint files, COMPUTED (SDD plan finding D4, autonomy-loop#3).
//
// WHY. Whether two parallel efforts may run side by side, or must stack, was
// the agent's judgement (WORKFLOW.md's "judged, never computed"). Observed runs
// published onto the wrong upstream and collided version bumps between
// delegates that each thought they were alone. This reads what each effort
// actually changed -- `git diff --name-only <base>...<effort>`, the merge-base
// diff, so a base that moved on since the effort branched does not paint the
// base's own changes onto the effort -- and reports which paths two or more
// efforts share.
//
// THE ALWAYS-OVERLAPPING LIST. Some paths every delivery touches sooner or
// later -- a plugin manifest's version, the CHANGELOG, generated mirrors --
// whether or not the branch has touched them yet: the bump happens at catch-up
// or release time. `--always-overlaps` names them, and each is counted as
// touched by EVERY effort. An entry ending in '/' is a directory prefix.
//
// THE VERDICT IS A FACT, NOT A PLAN. `disjoint`, `overlap` (with the shared
// paths and who shares each), or `unknown` (an effort whose diff could not be
// read -- never read as "touches nothing"). Which effort stacks on which is the
// caller's to decide; nen names no order.

import { GIT, outputLines, type Seams } from "../seam/exec.js";

export type OverlapVerdict = "disjoint" | "stack" | "overlap" | "unknown";

export interface EffortFiles {
  readonly effort: string;
  /** The changed paths, sorted; null when the diff could not be read. */
  readonly files: readonly string[] | null;
  readonly unreadReason: string | null;
}

/** KEY ORDER IS THE DOCUMENTED `--json` SHAPE. */
export interface OverlapReport {
  readonly verdict: OverlapVerdict;
  readonly base: string;
  readonly alwaysOverlaps: readonly string[];
  /** Each shared path and the efforts that share it, path-sorted. */
  readonly overlaps: readonly { readonly path: string; readonly efforts: readonly string[]; readonly always: boolean }[];
  readonly efforts: readonly EffortFiles[];
  readonly unread: readonly string[];
  /** The efforts in stack order (each contains the one before) when the verdict is `stack`; null otherwise. */
  readonly stack: readonly string[] | null;
}

/** Whether `ancestor` is an ancestor of `descendant`: true, false, or null when git could not say. */
export type AncestryRead = (ancestor: string, descendant: string) => boolean | null;

export function ancestryReader(seams: Seams, root: string): AncestryRead {
  return (ancestor, descendant) => {
    const result = seams.run(GIT, ["-C", root, "merge-base", "--is-ancestor", ancestor, descendant]);
    if (result.spawnFailed) return null;
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    return null;
  };
}

/**
 * The efforts in an order where each is an ancestor of the next, or null when
 * no such chain exists (or git could not answer one of the questions). Two
 * efforts at the same commit chain either way; the order given is kept.
 */
export function stackOrder(efforts: readonly string[], isAncestor: AncestryRead): readonly string[] | null {
  const order = [...efforts];
  // Insertion by ancestry: a chain is a total order, so a sort by "how many of
  // the others contain it" recovers it, and the check after confirms each link.
  const below = new Map<string, number>();
  for (const effort of order) {
    let count = 0;
    for (const other of order) {
      if (other === effort) continue;
      const answer = isAncestor(other, effort);
      if (answer === null) return null;
      if (answer) count += 1;
    }
    below.set(effort, count);
  }
  order.sort((a, b): number => (below.get(a) ?? 0) - (below.get(b) ?? 0));
  for (let at = 1; at < order.length; at += 1) {
    if (isAncestor(order[at - 1] as string, order[at] as string) !== true) return null;
  }
  return order;
}

export function diffArgv(root: string, base: string, effort: string): readonly string[] {
  return ["-C", root, "diff", "--name-only", "-z", `${base}...${effort}`, "--"];
}

export function readEffortFiles(seams: Seams, root: string, base: string, effort: string): EffortFiles {
  const result = seams.run(GIT, [...diffArgv(root, base, effort)]);
  if (result.spawnFailed) return { effort, files: null, unreadReason: "git could not be started" };
  if (result.code !== 0) {
    return { effort, files: null, unreadReason: outputLines(result.stderr).join(" ") || `git diff exit ${result.code}` };
  }
  const files = [...new Set(result.stdout.split("\0").filter((path): boolean => path !== ""))].sort();
  return { effort, files, unreadReason: null };
}

const matches = (entry: string, path: string): boolean => (entry.endsWith("/") ? path.startsWith(entry) : path === entry);

export function computeOverlap(base: string, efforts: readonly EffortFiles[], alwaysOverlaps: readonly string[], isAncestor: AncestryRead | null = null): OverlapReport {
  const unread = efforts.filter((row): boolean => row.files === null).map((row): string => row.effort);
  const owners = new Map<string, { efforts: string[]; always: boolean }>();
  const all = efforts.map((row): string => row.effort);
  for (const row of efforts) {
    for (const path of row.files ?? []) {
      const always = alwaysOverlaps.some((entry): boolean => matches(entry, path));
      const current = owners.get(path) ?? { efforts: [], always };
      if (!current.efforts.includes(row.effort)) current.efforts.push(row.effort);
      owners.set(path, current);
    }
  }
  // An always-overlapping path is everyone's, touched yet or not. A plain
  // entry counts by its own name; a directory prefix only through the paths
  // under it some effort actually changed, because the prefix is not a file.
  if (all.length > 1) {
    for (const entry of alwaysOverlaps) {
      if (!entry.endsWith("/")) owners.set(entry, { efforts: [...all], always: true });
    }
    for (const [path, owner] of owners) if (owner.always) owners.set(path, { efforts: [...all], always: true });
  }
  const overlaps = [...owners]
    .filter(([, owner]): boolean => owner.efforts.length > 1)
    .map(([path, owner]) => ({ path, efforts: all.filter((name): boolean => owner.efforts.includes(name)), always: owner.always }))
    .sort((a, b): number => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  const stack = unread.length === 0 && overlaps.length > 0 && isAncestor !== null ? stackOrder(all, isAncestor) : null;
  const verdict: OverlapVerdict = unread.length > 0 ? "unknown" : overlaps.length === 0 ? "disjoint" : stack !== null ? "stack" : "overlap";
  return { verdict, base, alwaysOverlaps: [...alwaysOverlaps], overlaps, efforts, unread, stack };
}

export function renderOverlap(report: OverlapReport): string[] {
  const lines: string[] = [];
  if (report.verdict === "unknown") lines.push(`verdict: unknown (could not read ${report.unread.join(", ")})`);
  else if (report.verdict === "stack") lines.push(`verdict: stack(${(report.stack ?? []).join(" <- ")})`);
  else if (report.verdict === "overlap") lines.push(`verdict: overlap(${report.overlaps.map((row): string => row.path).join(", ")})`);
  else lines.push("verdict: disjoint");
  lines.push(`base: ${report.base}`);
  for (const row of report.efforts) {
    lines.push(row.files === null ? `  ${row.effort}: unread -- ${row.unreadReason ?? ""}` : `  ${row.effort}: ${row.files.length} file(s)`);
  }
  for (const row of report.overlaps) lines.push(`  shared ${row.path}: ${row.efforts.join(", ")}${row.always ? " (always overlaps)" : ""}`);
  return lines;
}
