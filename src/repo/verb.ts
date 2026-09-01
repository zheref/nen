// src/repo/verb.ts -- `nen repo inventory|scenario`, senkei's enumeration and
// the scenario lookup the quality/handbook-set resolution (canon resolve)
// reads.

import { assertRepoRoot } from "./root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { defaultRunner, type Runner } from "../exec/seam.js";
import { parseTarget, type Target } from "../github/target.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { inventoryRepo } from "./inventory.js";
import { resolveScenario } from "./scenario.js";

function requireTarget(context: VerbContext): Target {
  const raw = context.values["target"];
  if (raw === undefined) throw new Error("--target owner/name is required.");
  return parseTarget(raw);
}

const USAGE = `nen repo -- inventory a consumer's backlog, or read its scenario.

usage:
  nen repo inventory --target <owner/name> --epic-label <label>
                     --integration-prefix <prefix> [--trunk main]
      senkei's live enumeration: every open issue carrying --epic-label with
      its children, every branch under --integration-prefix with its
      ahead/behind vs --trunk, and every open PR. Always fetched live.
      --integration-prefix has NO default: the naming convention for a live
      integration branch is the target repository's own, never a literal
      shipped in this binary.

  nen repo scenario --repo <path> --target <owner/name>
      The scenario recorded for --target in --repo's schemas/repos.json --
      the value canon-resolve/quality-tooling lookups read. Exits 1 when the
      repo is not a recorded consumer, or carries no scenario.`;

export const repoVerb: Verb = {
  name: "repo",
  summary: "Inventory a consumer's backlog, or read its recorded scenario.",
  usage: USAGE,
  flags: {
    values: ["target", "epic-label", "integration-prefix", "trunk"],
    booleans: [],
  },
  run(context: VerbContext): number {
    return runRepo(context, defaultRunner);
  },
};

export function runRepo(context: VerbContext, runner: Runner): number {
  const [subcommand] = context.args;
  try {
    switch (subcommand) {
      case "inventory":
        return inventory(context, runner);
      case "scenario":
        return scenario(context);
      default:
        return usage(context.io, `unknown 'repo' subcommand '${subcommand ?? "(none)"}'. Run 'nen repo --help'.`);
    }
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

function inventory(context: VerbContext, runner: Runner): number {
  const target = requireTarget(context);
  const epicLabel = context.values["epic-label"];
  if (epicLabel === undefined) return usage(context.io, "--epic-label <label> is required.");
  const integrationPrefix = context.values["integration-prefix"];
  if (integrationPrefix === undefined) {
    return usage(
      context.io,
      "--integration-prefix <prefix> is required -- the naming convention for a live integration branch is the target repository's own, never a default shipped here.",
    );
  }
  const trunk = context.values["trunk"] ?? "main";

  const result = inventoryRepo(runner, target, epicLabel, integrationPrefix, trunk);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return 0;
  }
  context.io.out(`epics: ${result.epics.length}`);
  for (const entry of result.epics) {
    context.io.out(`  #${entry.epic.number} ${entry.epic.title} -- ${entry.children.length} child(ren)`);
    for (const child of entry.children) {
      context.io.out(`    #${child.number} ${child.state}  ${child.labels.join(", ")}  ${child.title}`);
    }
  }
  context.io.out(`integration branches: ${result.integrationBranches.length}`);
  for (const branch of result.integrationBranches) {
    context.io.out(`  ${branch.name}  +${branch.aheadOfTrunk}/-${branch.behindTrunk} vs trunk`);
  }
  context.io.out(`open PRs: ${result.openPrs.length}`);
  for (const pr of result.openPrs) {
    context.io.out(`  #${pr.number}${pr.isDraft ? " (draft)" : ""} -> ${pr.baseRefName}  ${pr.title}`);
  }
  return 0;
}

function scenario(context: VerbContext): number {
  const target = requireTarget(context);
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const registry = loadRepoRegistry(root);
  const result = resolveScenario(registry, target.slug);
  if (context.json) {
    context.io.out(JSON.stringify(result, null, 2));
    return result.ok ? 0 : 1;
  }
  if (!result.ok) {
    context.io.err(`nen: ${result.reason}`);
    return 1;
  }
  context.io.out(result.scenario);
  return 0;
}
