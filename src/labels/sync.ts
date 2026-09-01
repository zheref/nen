// src/labels/sync.ts -- ported from scripts/sync-labels.sh (create-or-update,
// per-label isolation).
//
// PORT SOURCE: scripts/sync-labels.sh, carried behaviourally intact --
//
//   create() first, edit() on failure. `gh label create` fails when the label
//   already exists, so the shell's own idiom -- try create, fall back to edit
//   -- IS the create-or-update logic, not a special case of it.
//
//   ONE BAD LABEL MUST NOT ABORT THE RUN (CON-38; bankai-core#333: one bad
//   entry previously killed the whole sync). A description over GitHub's
//   100-char limit -- caught earlier here, at schema load, by
//   ../schema/labels.ts's own guard, so a taxonomy that violates it never
//   reaches this module at all -- or any other per-label GitHub rejection is
//   isolated to that label; every other label still lands.
//
// THE TAXONOMY IS READ THROUGH ../schema/labels.ts, not re-parsed here. The
// original's `parse_labels` was jq over the raw file; this repository already
// has a validating loader for exactly that file, and re-deriving the same
// validation a second way is how the two quietly drift.

import { lines, type Runner } from "../exec/seam.js";
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

function syncOne(runner: Runner, target: Target, label: Label, dryRun: boolean): SyncEntry {
  if (dryRun) {
    return { name: label.name, status: "would-sync", message: `would sync: ${label.name} (#${label.color}) -- ${label.description}` };
  }
  const create = runner.run({ bin: "gh", args: [...createArgv(target, label)] });
  if (create.code === 0) return { name: label.name, status: "created", message: null };

  const edit = runner.run({ bin: "gh", args: [...editArgv(target, label)] });
  if (edit.code === 0) return { name: label.name, status: "updated", message: null };

  const reason = lines(edit.stderr).at(-1) ?? lines(create.stderr).at(-1) ?? `create and edit both failed`;
  return { name: label.name, status: "failed", message: reason };
}

export function syncLabels(runner: Runner, target: Target, taxonomy: LabelTaxonomy, dryRun: boolean): SyncReport {
  const entries = taxonomy.labels.map((label): SyncEntry => syncOne(runner, target, label, dryRun));
  const failed = entries.filter((entry): boolean => entry.status === "failed").map((entry): string => entry.name);
  return { entries, failed };
}
