// src/direct/registry-verb.ts -- `nen direct registry`.
//
// The cheapest question a skill asks of the registry: "is this file valid, and
// what does it say?". It reads ONE file, touches no taxonomy, no workflow and no
// network, so it runs anywhere -- which is why `--repo` is optional here and
// required by `direct resolve`, where it names the consumer whose workflow
// spells the aliases. A bad file is the loader's pointed SchemaError at exit 1,
// never a partial list. Everything printed is the registry's own words; the
// snapshot lines are quoted with the date they were taken (the registry carries
// no version a recommendation resolves through, and neither does nen).

import { requireValue, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { countRoutingCells, loadDirectRegistry, type DirectRegistry } from "./registry.js";

export const REGISTRY_CONTRACT = "nen.direct.registry/v0.1";

function snapshotText(registry: DirectRegistry, alias: string): string {
  const quote = registry.snapshot.aliases[alias];
  if (quote === undefined) return "snapshot: -";
  return `snapshot: ${quote.primary}${quote.modelId === null ? "" : ` (${quote.modelId})`}`;
}

function table(rows: readonly (readonly string[])[]): string[] {
  const widths = (rows[0] ?? []).map((_cell, column): number => Math.max(...rows.map((row): number => (row[column] ?? "").length)));
  return rows.map((row): string =>
    row
      .map((cell, column): string => (column === row.length - 1 ? cell : cell.padEnd(widths[column] ?? 0)))
      .join("  "),
  );
}

export function runRegistry(context: CommandContext): number {
  const flag = requireValue(
    context.args,
    "registry",
    "It is the model-direction registry file (relative paths resolve against --repo).",
  );
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const registry = loadDirectRegistry(root, flag);
  const counts = {
    aliases: Object.keys(registry.aliases).length,
    routingJobs: Object.keys(registry.routing).length,
    routingCells: countRoutingCells(registry),
  };

  if (context.json) {
    context.io.out(
      JSON.stringify(
        {
          contract: REGISTRY_CONTRACT,
          registry: registry.path,
          snapshot: registry.snapshot,
          aliases: registry.aliases,
          surfaces: registry.surfaces,
          liveLookup: registry.liveLookup,
          counts,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const lines: string[] = [`registry ${registry.path}`, `snapshot asOf ${registry.snapshot.asOf}`];
  lines.push(
    ...table(
      Object.entries(registry.aliases).map(([name, alias]): string[] => [
        name,
        alias.provider,
        alias.family,
        alias.surface === null ? "-" : `${alias.surface}${alias.tier === null ? "" : `/${alias.tier}`}`,
        `${snapshotText(registry, name)}${alias.reviewer ? " (reviewer)" : ""}`,
      ]),
    ),
  );
  lines.push("surfaces:");
  lines.push(
    ...table(
      Object.entries(registry.surfaces).map(([name, surface]): string[] => [
        name,
        surface.label,
        `models.${surface.modelsKey}`,
        `effort: ${surface.effortControl}`,
      ]),
    ),
  );
  lines.push("live lookup:");
  lines.push(
    ...table(
      Object.entries(registry.liveLookup).map(([provider, source]): string[] => [
        provider,
        `cli: ${source.cli ?? "-"}`,
        `docs: ${source.docs.join(", ")}`,
      ]),
    ),
  );
  lines.push(
    `${counts.aliases} alias(es), ${Object.keys(registry.surfaces).length} surface(s), ${counts.routingJobs} routed job(s), ${counts.routingCells} cell(s)`,
  );
  for (const line of lines) context.io.out(line);
  return 0;
}
