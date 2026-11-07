// ============================================================================
// PORTED FROM bankai-core `scripts/sync-labels.sh` (zheref/nen#4, Akatsuki
// migration P1).
//
// The comment blocks below this one are the ORIGINAL script's own, carried
// VERBATIM (the BC-IS-#737 discipline). `parse_labels` is NOT reproduced as a
// function -- its job (validate the taxonomy file, emit name/color/description
// triples) is exactly what ../schema/labels.ts's loadLabelTaxonomy() already
// does, through a real validating parser rather than jq over raw JSON, and
// re-deriving the same validation a second way here is how the two would
// quietly drift. Issue #391 replaces create-then-edit retries with a remote
// diff: fetch all pages once, skip identical labels, and make one mutation per
// difference. A failed label remains isolated; no remote label is deleted.
// ============================================================================
// sync-labels.sh — install/update the Bankai label taxonomy on a GitHub repo.
//
// Usage:
//   ./scripts/sync-labels.sh --repo owner/name [--file nen/labels.json] [--dry-run]
//
// Requirements: jq; gh (authenticated) unless --dry-run.
// Idempotent: existing labels are updated (color/description), missing ones created.
//
// --- sync_label REPO NAME COLOR DESC ---------------------------------------
// Creates the label, or updates it if it already exists (gh exits non-zero on dupes).
// Returns 1 (never exits — see the `set -e` note on its caller) when BOTH the
// create and the update attempt fail, e.g. a description GitHub rejects.
//
// A label that fails to sync (e.g. a description over GitHub's 100-char
// limit) must not abort the run — every OTHER good label still lands
// (CON-38; bankai-core#333: one bad entry previously killed the whole sync).
// ============================================================================

import { GH, mustJson, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import type { Label, LabelTaxonomy } from "../schema/labels.js";

export function createArgv(target: Target, label: Label): readonly string[] {
  return ["label", "create", label.name, "--repo", target.slug, "--color", label.color, "--description", label.description];
}

export function editArgv(target: Target, label: Label): readonly string[] {
  return ["label", "edit", label.name, "--repo", target.slug, "--color", label.color, "--description", label.description];
}

export type SyncStatus = "created" | "updated" | "unchanged" | "would-sync" | "failed";

export interface SyncEntry {
  readonly name: string;
  readonly status: SyncStatus;
  readonly message: string | null;
}

export interface SyncReport {
  readonly entries: readonly SyncEntry[];
  readonly failed: readonly string[];
}

/** Slurping paginated arrays avoids both truncation and concatenated JSON. */
export function listLabelsArgv(target: Target): readonly string[] {
  return ["api", `repos/${target.slug}/labels?per_page=100`, "--paginate", "--slurp"];
}

function readLabels(seams: Seams, target: Target): ReadonlyMap<string, Label> {
  const pages = mustJson<unknown>(seams, GH, [...listLabelsArgv(target)]);
  if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("could not read remote labels: expected paginated label arrays; nothing was synced.");
  const labels = new Map<string, Label>();
  for (const value of pages.flat() as unknown[]) {
    if (typeof value !== "object" || value === null) throw new Error("could not read remote labels: malformed label; nothing was synced.");
    const row = value as Record<string, unknown>;
    if (typeof row["name"] !== "string" || row["name"] === "" || typeof row["color"] !== "string" || (row["description"] !== null && typeof row["description"] !== "string")) throw new Error("could not read remote labels: malformed label; nothing was synced.");
    const key = row["name"].toLowerCase();
    if (labels.has(key)) throw new Error("could not read remote labels: duplicate label name; nothing was synced.");
    labels.set(key, { name: row["name"], color: row["color"], description: row["description"] ?? "" });
  }
  return labels;
}

/** The dry-run diff of an update: only the fields that differ, as the remote has them now (zheref/nen#591). */
function wasClause(remote: Label, label: Label): string {
  const was: string[] = [];
  if (remote.color.toLowerCase() !== label.color.toLowerCase()) was.push(`color #${remote.color}`);
  if (remote.description !== label.description) was.push(`description ${JSON.stringify(remote.description)}`);
  return `  (was: ${was.join("; ")})`;
}

export function syncLabels(
  seams: Seams, target: Target, taxonomy: LabelTaxonomy, dryRun: boolean,
  progress: (entry: SyncEntry, completed: number, total: number) => void = (): void => {},
): SyncReport {
  const existing = readLabels(seams, target);
  const entries: SyncEntry[] = [];
  for (const label of taxonomy.labels) {
    const remote = existing.get(label.name.toLowerCase());
    let entry: SyncEntry;
    if (remote !== undefined && remote.color.toLowerCase() === label.color.toLowerCase() && remote.description === label.description) {
      entry = { name: label.name, status: "unchanged", message: null };
    } else if (dryRun) {
      entry = { name: label.name, status: "would-sync", message: `would ${remote === undefined ? "create" : "update"}: ${label.name} (#${label.color}) -- ${label.description}${remote === undefined ? "" : wasClause(remote, label)}` };
    } else {
      const argv = remote === undefined ? createArgv(target, label) : editArgv(target, label);
      const result = seams.run(GH, [...argv]);
      entry = result.code === 0 && !result.spawnFailed
        ? { name: label.name, status: remote === undefined ? "created" : "updated", message: null }
        : { name: label.name, status: "failed", message: outputLines(result.stderr).at(-1) ?? `exit ${result.code}` };
    }
    entries.push(entry);
    progress(entry, entries.length, taxonomy.labels.length);
  }
  return { entries, failed: entries.filter((entry) => entry.status === "failed").map((entry) => entry.name) };
}
