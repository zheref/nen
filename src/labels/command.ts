// src/labels/command.ts -- `nen labels sync|rename --map`.

import { assertRepoRoot } from "../repo/root.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { parseTarget, type Target } from "../github/target.js";
import { requireRepoFlag, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { syncLabels } from "./sync.js";
import { parseRenameMap, renameLabels } from "./rename.js";

function requireTarget(context: CommandContext): Target {
  const raw = context.args.values["target"];
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

export const labelsCommand: Command = {
  name: "labels",
  summary: "Create-or-update sync, and rename-in-place migration.",
  usage: USAGE,
  flags: { values: ["target", "map"], booleans: ["dry-run"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("labels", context.args, ["sync", "rename"]);
    return subcommand === "sync" ? sync(context) : rename(context);
  },
};

function sync(context: CommandContext): number {
  const target = requireTarget(context);
  // Usage lists --repo unbracketed: omitting it is refused by name at exit 2 --
  // a sync that read whatever taxonomy the cwd held would push THAT repo's
  // labels at --target (zheref/nen#28).
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It is the checkout whose schemas/labels.json is the taxonomy being synced."),
  });
  const taxonomy = loadLabelTaxonomy(root);
  const report = syncLabels(context.seams, target, taxonomy, context.args.booleans.has("dry-run"));

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

function rename(context: CommandContext): number {
  const target = requireTarget(context);
  const mapRaw = context.args.values["map"];
  if (mapRaw === undefined) throw new VerbUsageError("--map from=to,from2=to2 is required.");
  const entries = parseRenameMap(mapRaw);
  if (entries.length === 0) throw new VerbUsageError("--map named no mappings.");

  const results = renameLabels(context.seams, target, entries, context.args.booleans.has("dry-run"));
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
