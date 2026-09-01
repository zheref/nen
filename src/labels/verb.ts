// src/labels/verb.ts -- `nen labels sync|rename --map`.

import { assertRepoRoot } from "../repo/root.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { parseTarget, type Target } from "../github/target.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { syncLabels } from "./sync.js";
import { parseRenameMap, renameLabels } from "./rename.js";

function requireTarget(context: VerbContext): Target {
  const raw = context.values["target"];
  if (raw === undefined) throw new Error("--target owner/name is required.");
  return parseTarget(raw);
}

const USAGE = `nen labels -- create-or-update sync, and rename-in-place migration.

usage:
  nen labels sync --target <owner/name> --repo <path> [--dry-run]
      Ported from scripts/sync-labels.sh: create each label, or update it if
      it already exists. One bad label (a description GitHub rejects) never
      aborts the run -- every other good label still lands. The <=100-char
      description guard is enforced earlier, at schema load
      (../schema/labels.ts), so a taxonomy that violates it never reaches
      this verb at all.

  nen labels rename --target <owner/name> --map from=to,from2=to2 [--dry-run]
      Rename-in-place: 'gh label edit <from> --name <to>' preserves every
      issue association (open and closed) because it is one API call against
      the label's existing id. IDEMPOTENT: a mapping already applied (the new
      name exists, the old one is gone) is reported done, not retried or
      failed. DRY-RUN FIRST is the recommended workflow -- run --dry-run,
      review the log, then run for real.`;

export const labelsVerb: Verb = {
  name: "labels",
  summary: "Create-or-update sync, and rename-in-place migration.",
  usage: USAGE,
  flags: { values: ["target", "map"], booleans: ["dry-run"] },
  run(context: VerbContext): number {
    return runLabels(context, defaultRunner);
  },
};

export function runLabels(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  try {
    switch (subcommand) {
      case "sync":
        return sync(context, runner);
      case "rename":
        return rename(context, runner);
      default:
        return usage(context.io, `unknown 'labels' subcommand '${subcommand ?? "(none)"}'. Run 'nen labels --help'.`);
    }
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function sync(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadLabelTaxonomy(root);
  const report = syncLabels(runner, target, taxonomy, context.booleans.has("dry-run"));

  if (context.json) {
    context.io.out(JSON.stringify(report, null, 2));
    return report.failed.length === 0 ? 0 : 1;
  }
  for (const entry of report.entries) {
    context.io.out(entry.message ?? `${entry.status}: ${entry.name}`);
  }
  if (report.failed.length > 0) {
    context.io.err(`nen: ${report.failed.length} label(s) failed to sync: ${report.failed.join(", ")}`);
    return 1;
  }
  return 0;
}

function rename(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const mapRaw = context.values["map"];
  if (mapRaw === undefined) return usage(context.io, "--map from=to,from2=to2 is required.");
  const entries = parseRenameMap(mapRaw);
  if (entries.length === 0) return usage(context.io, "--map named no mappings.");

  const results = renameLabels(runner, target, entries, context.booleans.has("dry-run"));
  const failed = results.filter((result): boolean => result.status === "failed");

  if (context.json) {
    context.io.out(JSON.stringify(results, null, 2));
    return failed.length === 0 ? 0 : 1;
  }
  for (const result of results) {
    context.io.out(`${result.from} -> ${result.to}: ${result.status} -- ${result.message}`);
  }
  if (failed.length > 0) {
    context.io.err(`nen: ${failed.length} mapping(s) failed.`);
    return 1;
  }
  return 0;
}
