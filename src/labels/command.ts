// src/labels/command.ts -- `nen labels sync|rename --map`.

import { assertRepoRoot } from "../repo/root.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { parseTarget, type Target , TargetError} from "../github/target.js";
import { requireRepoFlag, requireSubcommand, VerbUsageError, type Command, type CommandContext, requireTargetFlag, parseCallerToken } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { syncLabels } from "./sync.js";
import { checkRef, loadLabelTaxonomyAtRef } from "./source.js";
import { parseRenameMap, renameLabels } from "./rename.js";

function requireTarget(context: CommandContext): Target {
  const raw = requireTargetFlag(context, "It is the GitHub side of the pair; --repo names a checkout on disk and is never used to address the API.");
  // A MALFORMED value is the same mistake as a missing one -- a typo in a flag
  // -- so `parseTarget`'s own refusal is re-raised as a usage error and exits 2
  // rather than 1 (zheref/nen#93; Copilot, PR #195).
  return parseCallerToken(
    (): Target => parseTarget(raw),
    (error: unknown): boolean => error instanceof TargetError,
  );
}

const USAGE = `nen labels -- create-or-update sync, and rename-in-place migration.

usage:
  nen labels sync --target <owner/name> --repo <path> [--dry-run]
  nen labels sync --target <owner/name> --repo <path> (--ref <ref> | --working-tree) [--apply]
      Read every page of remote labels once; create missing labels and update
      only differing colors/descriptions. Identical labels are unchanged.
      --dry-run still reads GitHub but mutates nothing. Progress counts go
      to stderr as labels finish, including with --json. One bad label (a description GitHub rejects) never
      aborts the run -- every other good label still lands. The <=100-char
      description guard is enforced earlier, at schema load
      (../schema/labels.ts), so a taxonomy that violates it never reaches
      this verb at all.

      --ref <ref> reads nen/labels.json as <ref> (a branch, tag or commit the
      --repo checkout holds) has it, so a pull request that adds or changes the
      labels file can diff it against --target before it merges (zheref/nen#591).
      --working-tree reads the checkout's own file, as the plain form does.
      Either mode is a DRY-RUN DIFF BY DEFAULT: nothing is mutated unless
      --apply is given. --apply is refused without one of them (the plain
      form already applies), and beside --dry-run.

  nen labels rename --target <owner/name> --map from=to,from2=to2 [--dry-run]
      Rename-in-place: 'gh label edit <from> --name <to>' preserves every
      issue association (open and closed) because it is one API call against
      the label's existing id. IDEMPOTENT: a mapping already applied (the new
      name exists, the old one is gone) is reported done, not retried or
      failed. DRY-RUN FIRST is the recommended workflow -- run --dry-run,
      review the log, then run for real.`;

export const labelsCommand: Command = {
  name: "labels",
  subcommands: ["sync", "rename"],
  summary: "Create-or-update sync, and rename-in-place migration.",
  usage: USAGE,
  flags: { values: ["target", "map", "ref"], booleans: ["dry-run", "working-tree", "apply"] },
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
    repoFlag: requireRepoFlag(context, "It is the checkout whose nen/labels.json is the taxonomy being synced."),
  });
  const source = syncSource(context);
  const taxonomy = source.ref === null ? loadLabelTaxonomy(root) : loadLabelTaxonomyAtRef(context.seams, root, source.ref);
  if (source.mode !== "plain") context.io.err(plainLine(`source: ${taxonomy.path}${source.dryRun ? " (dry run; --apply syncs)" : ""}`));
  context.io.err(`[0/${taxonomy.labels.length}] reading remote labels`);
  const report = syncLabels(context.seams, target, taxonomy, source.dryRun,
    (entry, completed, total): void => context.io.err(plainLine(`[${completed}/${total}] ${entry.status}: ${entry.name}`)));

  if (context.json) {
    context.io.out(JSON.stringify(report, null, 2));
    return report.failed.length === 0 ? 0 : 1;
  }
  for (const entry of report.entries) {
    context.io.out(plainLine(entry.message ?? `${entry.status}: ${entry.name}`));
  }
  if (report.failed.length > 0) {
    context.io.err(plainLine(`nen: ${report.failed.length} label(s) failed to sync: ${report.failed.join(", ")}`));
    return 1;
  }
  return 0;
}

interface SyncSource {
  readonly mode: "plain" | "ref" | "working-tree";
  readonly ref: string | null;
  readonly dryRun: boolean;
}

/**
 * The plain form keeps its behaviour (apply unless --dry-run); the two named
 * modes added for zheref/nen#591 invert it, previewing unless --apply.
 */
function syncSource(context: CommandContext): SyncSource {
  const rawRef = context.args.values["ref"];
  const workingTree = context.args.booleans.has("working-tree");
  const apply = context.args.booleans.has("apply");
  const dryRunFlag = context.args.booleans.has("dry-run");
  if (rawRef !== undefined && workingTree) {
    throw new VerbUsageError("--ref and --working-tree name two different sources for nen/labels.json; give one.");
  }
  if (apply && dryRunFlag) throw new VerbUsageError("--apply and --dry-run contradict each other; give one.");
  if (rawRef === undefined && !workingTree) {
    if (apply) throw new VerbUsageError("--apply only applies with --ref <ref> or --working-tree, which preview by default; the plain form already syncs unless --dry-run.");
    return { mode: "plain", ref: null, dryRun: dryRunFlag };
  }
  return rawRef !== undefined
    ? { mode: "ref", ref: checkRef(rawRef), dryRun: !apply }
    : { mode: "working-tree", ref: null, dryRun: !apply };
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
