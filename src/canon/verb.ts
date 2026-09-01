// src/canon/verb.ts -- `nen canon resolve`. `nen canon mirror` (scaffold's
// sync_canon.py port) joins this verb under issue #4's scaffold checkbox.

import { assertRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { parseTarget } from "../github/target.js";
import { resolveScenario } from "../repo/scenario.js";
import { resolveCanon } from "./resolve.js";

function commaList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}

const USAGE = `nen canon resolve -- always-load + exactly one stack handbook.

usage:
  nen canon resolve --repo <path> --target <owner/name>
                    --always-load <path,path,...> --stack-dir <dir>
                    [--leaf architecture.md]

  --always-load   repo-relative handbook paths loaded regardless of scenario.
                  Caller data -- the target repository's own canon manifest,
                  never a literal list shipped in this binary.
  --stack-dir     the directory each scenario's own subfolder lives under
                  (e.g. 'handbooks/stacks'). The scenario name IS the
                  subfolder name, so there is no scenario->stack table to
                  maintain: 'never load another stack's folder' is true by
                  construction.
  --leaf          the file within the scenario's folder. Default
                  'architecture.md'; quality resolution wants a different one.

Reads the scenario the same way 'nen repo scenario' does. Exits 1 when the
target repo is not a recorded consumer, or carries no scenario.`;

export const canonVerb: Verb = {
  name: "canon",
  summary: "Resolve a repo's always-load handbooks plus its one stack handbook.",
  usage: USAGE,
  flags: { values: ["target", "always-load", "stack-dir", "leaf"], booleans: [] },
  run(context: VerbContext): number {
    const [subcommand] = context.args;
    if (subcommand !== "resolve") {
      return usage(context.io, `unknown 'canon' subcommand '${subcommand ?? "(none)"}'. Try 'canon resolve'.`);
    }
    const targetRaw = context.values["target"];
    if (targetRaw === undefined) return usage(context.io, "--target owner/name is required.");
    const stackDir = context.values["stack-dir"];
    if (stackDir === undefined) return usage(context.io, "--stack-dir <dir> is required.");

    let root: string;
    let target;
    try {
      root = assertRepoRoot({ repoFlag: context.repoFlag });
      target = parseTarget(targetRaw);
    } catch (error) {
      context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
      return 1;
    }

    const registry = loadRepoRegistry(root);
    const scenarioResult = resolveScenario(registry, target.slug);
    if (!scenarioResult.ok) {
      context.io.err(`nen: ${scenarioResult.reason}`);
      return 1;
    }

    const resolution = resolveCanon({
      scenario: scenarioResult.scenario,
      alwaysLoad: commaList(context.values["always-load"]),
      stackDir,
      leaf: context.values["leaf"],
    });

    if (context.json) {
      context.io.out(JSON.stringify(resolution, null, 2));
      return 0;
    }
    context.io.out(`scenario: ${resolution.scenario}`);
    context.io.out(`always load: ${resolution.alwaysLoad.join(", ") || "(none)"}`);
    context.io.out(`stack handbook: ${resolution.stackHandbook}`);
    return 0;
  },
};
