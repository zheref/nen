import { readJsonFile } from "../cli/inputs.js";
import { requireArray, requireRecord, requireString, SchemaError } from "../schema/errors.js";
// src/classify/labels.ts -- `nen classify labels`.
//
// The cheapest question a skill asks of the taxonomy: "is this file valid, and
// what label set does it define?". It reads ONE file and touches neither the
// consumer's declaration nor GitHub, so it runs anywhere -- which is why `--repo`
// is optional here and required by the three verbs that do reach the consumer.
// A bad file is the loader's pointed SchemaError at exit 1, never a partial list.

import { requireValue, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { AXES, loadClassifyTaxonomy, taxonomyLabels, validatePhaseCoverage } from "./taxonomy.js";

export function runLabels(context: CommandContext): number {
  const flag = requireValue(
    context.args,
    "taxonomy",
    "It is the classification taxonomy file the label set is read from (relative paths resolve against --repo).",
  );
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadClassifyTaxonomy(root, flag);
  const inventory = context.args.values["phase-inventory"];
  const registry = context.args.values["phase-registry"];
  if (inventory !== undefined && registry !== undefined) throw new SchemaError(taxonomy.path, "phase-inventory", "choose one independent inventory or registry");
  let expected: string[] | undefined;
  if (inventory !== undefined) expected = requireArray(inventory, "phases", readJsonFile<unknown>(inventory, root, "The independent document phase inventory is required.")).map((entry, index) => requireString(inventory, `phases[${index}]`, entry));
  if (registry !== undefined) {
    const document = requireRecord(registry, "registry", readJsonFile<unknown>(registry, root, "The independent registry phase universe is required."));
    expected = Object.keys(requireRecord(registry, "phases", document["phases"])).filter((key) => !key.startsWith("$"));
  }
  if (expected !== undefined && (expected.length === 0 || new Set(expected).size !== expected.length)) throw new SchemaError(taxonomy.path, "phases", "the independent inventory must be nonempty and unique");
  validatePhaseCoverage(taxonomy, expected);
  const labels = taxonomyLabels(taxonomy);

  if (context.json) {
    const axes = Object.fromEntries(
      AXES.map((name): [string, { prefix: string; count: number }] => [
        name,
        { prefix: taxonomy.axes[name].prefix, count: taxonomy.axes[name].keys.length },
      ]),
    );
    context.io.out(
      JSON.stringify(
        {
          contract: "nen.classify.labels/v0.1",
          taxonomy: taxonomy.path,
          axes,
          labels: labels.map((label): unknown => ({
            name: label.name,
            color: label.color,
            description: label.description,
            axis: label.axis,
            key: label.key,
          })),
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const width = Math.max(...labels.map((label): number => label.name.length));
  for (const label of labels) {
    context.io.out(`${label.name.padEnd(width)}  #${label.color}  ${label.description}`);
  }
  const counts = AXES.map((name): string => `${taxonomy.axes[name].keys.length} ${name}`).join(", ");
  context.io.out(`${labels.length} label(s): ${counts}`);
  return 0;
}
