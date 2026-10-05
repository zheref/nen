// src/classify/install.ts -- `nen classify install`.
//
// WHY TWO STEPS, TWO LANDINGS. The maintainer's ruling (2026-10-04) is that the
// DECLARATION lands first and GitHub follows: a consumer's `nen/labels.json` is
// the one source of truth for the repository's labels (../schema/labels.ts), so
// the classification labels are added there, through a reviewed pull request,
// and only then created on GitHub. This verb makes that order mechanical:
//
//   report   compares the taxonomy's label set with the declaration. Exit 0 when
//            every label is present, 1 otherwise -- a skill reads "installed?"
//            from the exit code.
//   --write  rewrites `nen/labels.json` so every taxonomy label is present.
//   --sync   creates-or-updates the taxonomy's labels on GitHub through
//            ../labels/sync.ts, and REFUSES while the on-disk declaration is
//            not landed. `--write` and `--sync` never share an invocation.
//
// THE REWRITE TOUCHES NOTHING IT DOES NOT HAVE TO. Absent labels are appended
// after the existing entries in taxonomy order; a drifted label is updated in
// place; every other entry and every top-level key (`$comment` included) keeps
// its content and its key order. The file is re-serialised with two-space
// indent and a trailing newline -- the file is JSON and nothing else about its
// spelling is promised. When nothing differs the file is not rewritten at all,
// so a re-run leaves the working tree clean.
//
// A LABEL THE TAXONOMY DOES NOT CARRY BUT WHOSE NAME WEARS AN AXIS PREFIX is
// `foreign`: reported, never removed or changed. It may be a key the taxonomy
// retired; deleting a label that still sits on issues is not this verb's call.

import { writeFileSync } from "node:fs";
import type { Target } from "../github/target.js";
import { plainLine } from "../cli/plain.js";
import { GH, mustJson, type Seams } from "../seam/exec.js";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { isRecord, requireArray, requireRecord, SchemaError } from "../schema/errors.js";
import { loadLabelTaxonomy, parseLabelTaxonomy, type Label, type LabelTaxonomy } from "../schema/labels.js";
import { LABELS_FILE, readSchemaJson } from "../schema/source.js";
import { syncLabels, type SyncReport } from "../labels/sync.js";
import { loadRequiringRepo, requireTarget } from "./common.js";
import {
  axisOfLabel,
  taxonomyLabels,
  type ClassifyLabel,
  type ClassifyTaxonomy,
} from "./taxonomy.js";

export type InstallStatus = "present" | "drift" | "absent";

export interface InstallEntry {
  readonly name: string;
  readonly status: InstallStatus;
}

export interface InstallReport {
  readonly entries: readonly InstallEntry[];
  /** Declared labels wearing an axis prefix whose key the taxonomy does not carry. */
  readonly foreign: readonly string[];
}

/** GitHub spells colours lowercase; a declaration may not. Same colour either way. */
function sameColor(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function compareDeclaration(taxonomy: ClassifyTaxonomy, declared: LabelTaxonomy): InstallReport {
  const entries = taxonomyLabels(taxonomy).map((want): InstallEntry => {
    const have = declared.get(want.name);
    if (have === undefined) return { name: want.name, status: "absent" };
    const same = sameColor(have.color, want.color) && have.description === want.description;
    return { name: want.name, status: same ? "present" : "drift" };
  });
  const foreign = declared.labels
    .filter((label): boolean => {
      const found = axisOfLabel(taxonomy, label.name);
      return found !== null && !taxonomy.axes[found.axis].keys.some((entry): boolean => entry.key === found.key);
    })
    .map((label): string => label.name);
  return { entries, foreign };
}

export function notLanded(report: InstallReport): InstallEntry[] {
  return report.entries.filter((entry): boolean => entry.status !== "present");
}

/** What a human needs to see about a drifted label: what the declaration holds against what the taxonomy wants. */
function describeDrift(have: Label, want: Label): string {
  const parts: string[] = [];
  if (!sameColor(have.color, want.color)) parts.push(`colour #${have.color} -> #${want.color}`);
  if (have.description !== want.description) parts.push("description differs");
  return parts.join(", ");
}

export interface WriteResult {
  readonly added: number;
  readonly updated: number;
}

/**
 * The key order a NEW entry is written in: the first existing entry's, when it
 * carries exactly the three label fields, else name/color/description. A file
 * whose entries read `color, description, name` keeps reading that way.
 */
function entryKeyOrder(labels: readonly unknown[]): readonly string[] {
  const fallback = ["name", "color", "description"];
  const first = labels[0];
  if (!isRecord(first)) return fallback;
  const keys = Object.keys(first);
  return keys.length === 3 && fallback.every((key): boolean => keys.includes(key)) ? keys : fallback;
}

/**
 * Rewrite `nen/labels.json` so every taxonomy label is present. Returns the
 * counts; with `dryRun` nothing is written. The file is read raw (not through
 * the typed loader) so unknown top-level keys and entry fields survive.
 */
export function writeDeclaration(
  root: string,
  taxonomy: ClassifyTaxonomy,
  report: InstallReport,
  dryRun: boolean,
): WriteResult {
  const { path, value } = readSchemaJson(root, LABELS_FILE);
  const record = requireRecord(path, "$", value);
  const labels = requireArray(path, "labels", record["labels"]);
  const wanted = new Map(taxonomyLabels(taxonomy).map((label): [string, ClassifyLabel] => [label.name, label]));
  const order = entryKeyOrder(labels);

  let added = 0;
  let updated = 0;
  for (const entry of report.entries) {
    const want = wanted.get(entry.name);
    if (want === undefined || entry.status === "present") continue;
    if (entry.status === "drift") {
      const existing = labels.find((item): boolean => isRecord(item) && item["name"] === entry.name);
      if (!isRecord(existing)) throw new SchemaError(path, "labels", `lost '${entry.name}' between the comparison and the write`);
      existing["color"] = want.color;
      existing["description"] = want.description;
      updated += 1;
      continue;
    }
    const fresh: Record<string, string> = {};
    const source: Record<string, string> = { name: want.name, color: want.color, description: want.description };
    for (const key of order) fresh[key] = source[key] as string;
    labels.push(fresh);
    added += 1;
  }

  if (!dryRun && added + updated > 0) {
    writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  }
  return { added, updated };
}

/** The taxonomy's labels as the plain taxonomy `syncLabels` takes -- NEVER the whole declaration. */
function filteredTaxonomy(path: string, taxonomy: ClassifyTaxonomy): LabelTaxonomy {
  return parseLabelTaxonomy(path, {
    labels: taxonomyLabels(taxonomy).map((label): Label => ({
      name: label.name,
      color: label.color,
      description: label.description,
    })),
  });
}

export interface LandedState {
  readonly branch: string;
  /** Taxonomy labels absent or drifted on the target's default branch. */
  readonly missing: readonly string[];
}

/** The target repository's default-branch `nen/labels.json`, read through gh. */
export function readLanded(seams: Seams, target: Target): { branch: string; declaration: LabelTaxonomy } {
  const repository = mustJson<{ default_branch?: unknown }>(seams, GH, ["api", `repos/${target.slug}`]);
  const branch = repository.default_branch;
  if (typeof branch !== "string" || branch === "") {
    throw new Error(`could not read ${target.slug}'s default branch: the repository answered no default_branch.`);
  }
  const file = mustJson<{ content?: unknown; encoding?: unknown }>(seams, GH, [
    "api",
    `repos/${target.slug}/contents/nen/labels.json?ref=${encodeURIComponent(branch)}`,
  ]);
  if (typeof file.content !== "string" || file.encoding !== "base64") {
    throw new Error(`could not read nen/labels.json on ${target.slug}@${branch}: expected a base64 file, got something else.`);
  }
  const text = Buffer.from(file.content.replace(/\s/g, ""), "base64").toString("utf8");
  let value: unknown;
  try {
    value = JSON.parse(text) as unknown;
  } catch (error) {
    throw new Error(`nen/labels.json on ${target.slug}@${branch} is not valid JSON (${error instanceof Error ? error.message : String(error)})`);
  }
  return { branch, declaration: parseLabelTaxonomy(`${target.slug}@${branch}:nen/labels.json`, value) };
}

export const NOT_LANDED_MESSAGE =
  "the declaration is not landed: run `nen classify install --write`, land it through its PR, then sync";

export function runInstall(context: CommandContext): number {
  const write = context.args.booleans.has("write");
  const sync = context.args.booleans.has("sync");
  const dryRun = context.args.booleans.has("dry-run");
  if (write && sync) {
    throw new VerbUsageError(
      "--write and --sync cannot share an invocation: the declaration lands through its own pull request first, and GitHub is synced after it. Two steps, two landings.",
    );
  }
  if (!sync && context.args.values["target"] !== undefined) {
    throw new VerbUsageError("--target only applies with --sync; the other forms read the checkout, never GitHub.");
  }
  const target = sync ? requireTarget(context) : null;
  const { root, taxonomy } = loadRequiringRepo(context);
  const declared = loadLabelTaxonomy(root);
  const report = compareDeclaration(taxonomy, declared);
  const missing = notLanded(report);
  const mode = sync ? "sync" : write ? "write" : "report";
  // Every HUMAN line passes plainLine: label names and gh's own diagnostics are
  // text nen did not write. The --json document carries the raw data.
  const out = (line: string): void => context.io.out(plainLine(line));
  const err = (line: string): void => context.io.err(plainLine(line));
  const wanted = new Map(taxonomyLabels(taxonomy).map((label): [string, ClassifyLabel] => [label.name, label]));

  let landedState: LandedState | null = null;
  const body = (written: WriteResult | null, synced: SyncReport | null): unknown => ({
    contract: "nen.classify.install/v0.1",
    mode,
    labelsFile: declared.path,
    dryRun,
    entries: report.entries,
    foreign: report.foreign,
    written,
    sync: synced,
    landed: landedState,
  });
  const foreignLines = report.foreign.map((name): string => `foreign  ${name}  (declared, not in the taxonomy; left alone)`);

  if (mode === "report") {
    if (context.json) {
      context.io.out(JSON.stringify(body(null, null), null, 2));
      return missing.length === 0 ? 0 : 1;
    }
    for (const entry of report.entries) {
      const have = declared.get(entry.name);
      const want = wanted.get(entry.name);
      const detail = entry.status === "drift" && have !== undefined && want !== undefined ? `  (${describeDrift(have, want)})` : "";
      out(`${entry.status.padEnd(7)}  ${entry.name}${detail}`);
    }
    for (const line of foreignLines) out(line);
    if (missing.length === 0) {
      out(`installed: all ${report.entries.length} label(s) are declared in ${declared.path}`);
      return 0;
    }
    const absent = missing.filter((entry): boolean => entry.status === "absent").length;
    err(
      `nen: ${missing.length} of ${report.entries.length} label(s) not installed (${absent} absent, ${missing.length - absent} drift) -- run 'nen classify install --write'.`,
    );
    return 1;
  }

  if (mode === "write") {
    const result = writeDeclaration(root, taxonomy, report, dryRun);
    if (!dryRun) {
      // The file is re-read through the typed loader: a rewrite that produced a
      // declaration the rest of nen cannot read, or one still missing a label,
      // is a defect here and must not be reported as done.
      const after = notLanded(compareDeclaration(taxonomy, loadLabelTaxonomy(root)));
      if (after.length > 0) {
        throw new Error(`the rewrite of ${declared.path} left ${after.length} label(s) not installed: ${after.map((entry): string => entry.name).join(", ")}`);
      }
    }
    if (context.json) {
      context.io.out(JSON.stringify(body(result, null), null, 2));
      return 0;
    }
    for (const entry of missing) {
      const verb = entry.status === "absent" ? "add" : "update";
      out(`${dryRun ? "would " : ""}${verb}  ${entry.name}`);
    }
    for (const line of foreignLines) out(line);
    out(`${dryRun ? "would write" : "written"}: ${result.added} added, ${result.updated} updated${dryRun ? " (nothing was written)" : ""}`);
    return 0;
  }

  // --sync
  if (missing.length > 0) {
    if (context.json) context.io.out(JSON.stringify(body(null, null), null, 2));
    err(
      `nen: ${NOT_LANDED_MESSAGE} (${missing.length} label(s) absent or drifted in ${declared.path}: ${missing.map((entry): string => entry.name).join(", ")}).`,
    );
    return 1;
  }
  if (target === null) throw new Error("unreachable: --sync resolved no target");

  // THE LANDED DECLARATION IS THE GATE; the working-tree check above is only
  // necessary. `install --write` then `install --sync` in one uncommitted
  // checkout would otherwise change GitHub before any merge -- the exact order
  // the ruling forbids. So the target's CURRENT default-branch nen/labels.json
  // is read, and a read that fails is a refusal, never a pass. --dry-run reads
  // it too: it must predict the real run's verdict.
  const landed = readLanded(context.seams, target);
  const there = notLanded(compareDeclaration(taxonomy, landed.declaration));
  landedState = { branch: landed.branch, missing: there.map((entry): string => entry.name) };
  if (there.length > 0) {
    if (context.json) context.io.out(JSON.stringify(body(null, null), null, 2));
    err(
      `nen: the declaration is not landed on ${target.slug}'s default branch '${landed.branch}': ${there.length} label(s) absent or drifted there (${there.map((entry): string => entry.name).join(", ")}). Merge the pull request carrying 'nen classify install --write', then sync.`,
    );
    return 1;
  }
  const synced = syncLabels(context.seams, target, filteredTaxonomy(declared.path, taxonomy), dryRun);
  if (context.json) {
    context.io.out(JSON.stringify(body(null, synced), null, 2));
    return synced.failed.length === 0 ? 0 : 1;
  }
  for (const entry of synced.entries) out(entry.message ?? `${entry.status}: ${entry.name}`);
  if (synced.failed.length > 0) {
    err(`nen: ${synced.failed.length} label(s) failed to sync: ${synced.failed.join(", ")}`);
    return 1;
  }
  return 0;
}
