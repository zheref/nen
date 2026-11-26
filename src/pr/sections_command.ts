import { emit, requireValue, VerbUsageError, type CommandContext } from "../cli/command.js";
import { readJsonFile } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { loadClassifyTaxonomy } from "../classify/taxonomy.js";
import { plainLine } from "../cli/plain.js";
import { parseSectionCatalogue, resolveSections, sectionFamily } from "./sections.js";

function list(value: string): string[] {
  const values = value.split(",").map((item): string => item.trim());
  if (values.some((item): boolean => item.length === 0)) throw new VerbUsageError("comma-separated lists must contain no empty item");
  return values;
}
export function sectionsCommand(context: CommandContext): number {
  const action = context.args.positionals[2];
  if ((action !== "resolve" && action !== "family") || context.args.positionals.length !== 3) throw new VerbUsageError("use 'pr sections resolve' or 'pr sections family'");
  const allowed = action === "resolve" ? ["catalogue", "kind", "family", "with", "overrides", "repo"] : ["catalogue", "taxonomy", "jobs", "repo"];
  for (const key of Object.keys(context.args.values)) if (!allowed.includes(key)) throw new VerbUsageError(`pr sections ${action} does not read --${key}`);
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const path = requireValue(context.args, "catalogue", "The caller's section catalogue.");
  const catalogue = parseSectionCatalogue(path, readJsonFile<unknown>(path, root));
  if (action === "family") {
    const taxonomy = loadClassifyTaxonomy(root, requireValue(context.args, "taxonomy", "The caller's job taxonomy."));
    const report = sectionFamily(catalogue, taxonomy, list(requireValue(context.args, "jobs", "The issue's job keys.")));
    emit(context.io, context.json, report, [report.family, report.rule].map(plainLine));
    return 0;
  }
  const report = resolveSections(catalogue,
    requireValue(context.args, "kind", "The repository kind."),
    requireValue(context.args, "family", "The resolved job family."),
    context.args.values["with"] === undefined ? [] : list(requireValue(context.args, "with", "The run's conditional facts.")),
    context.args.values["overrides"] === undefined ? undefined : readJsonFile<unknown>(requireValue(context.args, "overrides", "The consumer workflow."), root));
  emit(context.io, context.json, report, [
    `${report.cell}: ${report.sections.map((row): string => row.id).join(", ")} (${report.sections.length}/${report.max})`,
    ...[...report.sections, ...report.footer].map((row): string => `${row.id}: ${row.title}`),
    `requirements: ${JSON.stringify(report.requirements)}`,
  ].map(plainLine));
  return 0;
}
