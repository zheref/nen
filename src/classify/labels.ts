// src/classify/labels.ts -- `nen classify labels`.
//
// The cheapest question a skill asks of the taxonomy: "is this file valid, and
// what label set does it define?". It reads ONE file and touches neither the
// consumer's declaration nor GitHub, so it runs anywhere -- which is why `--repo`
// is optional here and required by the three verbs that do reach the consumer.
// A bad file is the loader's pointed SchemaError at exit 1, never a partial list.

import { requireValue, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { AXES, loadClassifyTaxonomy, taxonomyLabels } from "./taxonomy.js";

export function runLabels(context: CommandContext): number {
  const flag = requireValue(
    context.args,
    "taxonomy",
    "It is the classification taxonomy file the label set is read from (relative paths resolve against --repo).",
  );
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const taxonomy = loadClassifyTaxonomy(root, flag);
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
