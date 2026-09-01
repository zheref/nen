// src/scaffold/verb.ts -- `nen scaffold init`. See ./init.ts's header for
// this pass's honestly-stated scope: the deterministic, scenario-agnostic
// half of bankai-scaffold's role, not the seven scenario generators.

import { assertRepoRoot } from "../repo/root.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { scaffoldInit } from "./init.js";

function commaList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}

const USAGE = `nen scaffold init -- directory layout, the commit-msg hook, a canon-values template.

usage:
  nen scaffold init --repo <path> [--directories src,tests,docs]
                    --agent-trailer <key> --run-trailer <key> --marker-env <VAR>
                    [--hook-path .git/hooks/commit-msg]
                    [--canon-values-path .claude/canon-values.yml] [--scenario <name>]

Creates every --directories entry that does not exist, installs the trailer-
enforcing commit-msg hook (a NEW mechanism -- see ../scaffold/hook.ts), and --
when --canon-values-path is given and nothing is there yet -- writes a
canon-values.yml template ready for 'nen canon mirror generate' to consume.
--agent-trailer/--run-trailer/--marker-env are caller data: which trailer
pair and which environment variable mark an automated commit is this
system's own convention, never a literal shipped here.

SCOPE: this is the deterministic, scenario-agnostic half of a full project
scaffolder's role -- directory skeleton, hook, canon-values template. Scenario-
specific project generators (mobile-web, mobile-desktop, cross-apple, ...)
are NOT ported by this verb; see ../scaffold/init.ts's header.`;

export const scaffoldVerb: Verb = {
  name: "scaffold",
  summary: "Deterministic scaffold: directories, the commit-msg hook, a canon-values template.",
  usage: USAGE,
  flags: {
    values: [
      "directories",
      "agent-trailer",
      "run-trailer",
      "marker-env",
      "hook-path",
      "canon-values-path",
      "scenario",
    ],
    booleans: [],
  },
  run(context: VerbContext): number {
    const [subcommand] = context.args;
    if (subcommand !== "init") {
      return usage(context.io, `unknown 'scaffold' subcommand '${subcommand ?? "(none)"}'. Try 'scaffold init'.`);
    }
    const agentTrailer = context.values["agent-trailer"];
    const runTrailer = context.values["run-trailer"];
    const markerEnv = context.values["marker-env"];
    if (agentTrailer === undefined || runTrailer === undefined || markerEnv === undefined) {
      return usage(context.io, "scaffold init takes --agent-trailer, --run-trailer and --marker-env.");
    }
    const root = assertRepoRoot({ repoFlag: context.repoFlag });

    const result = scaffoldInit({
      root,
      directories: commaList(context.values["directories"]),
      hook: { agentTrailer, runTrailer, markerEnvVar: markerEnv },
      hookPath: context.values["hook-path"],
      canonValuesPath: context.values["canon-values-path"],
      scenario: context.values["scenario"],
    });

    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    context.io.out(`created directories: ${result.createdDirectories.join(", ") || "(none -- all already existed)"}`);
    context.io.out(`hook written: ${result.hookWritten}`);
    if (result.canonValuesWritten !== null) context.io.out(`canon-values: ${result.canonValuesWritten}`);
    return 0;
  },
};
