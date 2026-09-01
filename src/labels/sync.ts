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
// quietly drift. `sync_label` and the per-entry loop are ported behaviourally
// intact: create() first, edit() as the fallback -- gh's own
// fails-on-duplicate idiom for create IS the create-or-update logic, not a
// special case of it -- and a label's failure is isolated to that label,
// never aborting the run.
// ============================================================================
// sync-labels.sh — install/update the Bankai label taxonomy on a GitHub repo.
//
// Usage:
//   ./scripts/sync-labels.sh --repo owner/name [--file schemas/labels.json] [--dry-run]
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

import { GH, outputLines, type Seams } from "../seam/exec.js";
import type { Target } from "../github/target.js";
import type { Label, LabelTaxonomy } from "../schema/labels.js";

export function createArgv(target: Target, label: Label): readonly string[] {
  return ["label", "create", label.name, "--repo", target.slug, "--color", label.color, "--description", label.description];
}

export function editArgv(target: Target, label: Label): readonly string[] {
  return ["label", "edit", label.name, "--repo", target.slug, "--color", label.color, "--description", label.description];
}

export type SyncStatus = "created" | "updated" | "would-sync" | "failed";

export interface SyncEntry {
  readonly name: string;
  readonly status: SyncStatus;
  readonly message: string | null;
}

export interface SyncReport {
  readonly entries: readonly SyncEntry[];
  readonly failed: readonly string[];
}

function syncOne(seams: Seams, target: Target, label: Label, dryRun: boolean): SyncEntry {
  if (dryRun) {
    return { name: label.name, status: "would-sync", message: `would sync: ${label.name} (#${label.color}) -- ${label.description}` };
  }
  const create = seams.run(GH, [...createArgv(target, label)]);
  if (create.code === 0) return { name: label.name, status: "created", message: null };

  const edit = seams.run(GH, [...editArgv(target, label)]);
  if (edit.code === 0) return { name: label.name, status: "updated", message: null };

  const reason = outputLines(edit.stderr).at(-1) ?? outputLines(create.stderr).at(-1) ?? `create and edit both failed`;
  return { name: label.name, status: "failed", message: reason };
}

export function syncLabels(seams: Seams, target: Target, taxonomy: LabelTaxonomy, dryRun: boolean): SyncReport {
  const entries = taxonomy.labels.map((label): SyncEntry => syncOne(seams, target, label, dryRun));
  const failed = entries.filter((entry): boolean => entry.status === "failed").map((entry): string => entry.name);
  return { entries, failed };
}
