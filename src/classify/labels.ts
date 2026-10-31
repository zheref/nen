// src/classify/labels.ts -- `nen classify labels`.
//
// The cheapest question a skill asks of the taxonomy: "is this file valid, and
// what label set does it define?". It reads ONE file and touches neither the
// consumer's declaration nor GitHub, so it runs anywhere -- which is why `--repo`
// is optional here and required by the three verbs that do reach the consumer.
// A bad file is the loader's pointed SchemaError at exit 1, never a partial list.

import { requireValue, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { AXES, installLabels, loadClassifyTaxonomy } from "./taxonomy.js";

export function runLabels(context: CommandContext): number {
  const flag = requireValue(
    context.args,
    "taxonomy",
    "It is the classification taxonomy file the label set is read from (relative paths resolve against --repo).",
  );
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadClassifyTaxonomy(root, flag);
  const labels = installLabels(taxonomy);

  if (context.json) {
    const axes = Object.fromEntries(
      AXES.map((name): [string, { prefix: string; count: number }] => [
        name,
        { prefix: taxonomy.axes[name].prefix, count: taxonomy.axes[name].keys.length },
      ]),
    );
    const families = Object.fromEntries(
      taxonomy.families.map((family): [string, { prefix: string; count: number }] => [
        family.name,
        { prefix: family.prefix, count: family.keys.length },
      ]),
    );
    context.io.out(
      JSON.stringify(
        {
          contract: "nen.classify.labels/v0.1",
          taxonomy: taxonomy.path,
          axes,
          families,
          labels: labels.map((label): unknown => ({
            name: label.name,
            color: label.color,
            description: label.description,
            axis: label.axis,
            family: label.family,
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
  const counts = [
    ...AXES.map((name): string => `${taxonomy.axes[name].keys.length} ${name}`),
    ...taxonomy.families.map((family): string => `${family.keys.length} ${family.name}`),
  ].join(", ");
  context.io.out(`${labels.length} label(s): ${counts}`);
  return 0;
}
