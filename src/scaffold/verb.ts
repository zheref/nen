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

// A trailer key is interpolated into the hook both as an ERE inside a
// single-quoted shell string and inside a double-quoted echo string (see
// ../scaffold/hook.ts). Anything outside a git trailer key's own legal
// charset either changes what the hook matches (a regex metacharacter) or
// breaks out of the quoting (a quote character) -- refusing it here is both
// safer and more honest than trying to escape a key that was never a valid
// trailer key to begin with.
const TRAILER_KEY = /^[A-Za-z0-9][A-Za-z0-9-]*$/;
const MARKER_ENV_VAR = /^[A-Za-z_][A-Za-z0-9_]*$/;

const USAGE = `nen scaffold init -- directory layout, the commit-msg hook, a canon-values template.

usage:
  nen scaffold init --repo <path> [--directories src,tests,docs]
                    --agent-trailer <key> --run-trailer <key> --marker-env <VAR>
                    [--hook-path .git/hooks/commit-msg] [--force]
                    [--canon-values-path .claude/canon-values.yml] [--scenario <name>]

Creates every --directories entry that does not exist, installs the trailer-
enforcing commit-msg hook (a NEW mechanism -- see ../scaffold/hook.ts), and --
when --canon-values-path is given and nothing is there yet -- writes a
canon-values.yml template ready for 'nen canon mirror generate' to consume.
--agent-trailer/--run-trailer/--marker-env are caller data: which trailer
pair and which environment variable mark an automated commit is this
system's own convention, never a literal shipped here. Each must be a legal
git trailer key / shell identifier (--agent-trailer, --run-trailer:
[A-Za-z0-9][A-Za-z0-9-]*; --marker-env: [A-Za-z_][A-Za-z0-9_]*) -- refused
otherwise, since either is interpolated into the generated hook script.

--hook-path defaults to .git/hooks/commit-msg. When a DIFFERENT hook already
exists there, init REFUSES rather than overwriting it silently; pass --force
to replace it (the existing hook is backed up to '<path>.bak' first). A hook
with identical generated content is left alone either way (idempotent).

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
    booleans: ["force"],
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
    if (!TRAILER_KEY.test(agentTrailer)) {
      return usage(context.io, `--agent-trailer '${agentTrailer}' is not a legal trailer key ([A-Za-z0-9][A-Za-z0-9-]*).`);
    }
    if (!TRAILER_KEY.test(runTrailer)) {
      return usage(context.io, `--run-trailer '${runTrailer}' is not a legal trailer key ([A-Za-z0-9][A-Za-z0-9-]*).`);
    }
    if (!MARKER_ENV_VAR.test(markerEnv)) {
      return usage(context.io, `--marker-env '${markerEnv}' is not a legal shell identifier ([A-Za-z_][A-Za-z0-9_]*).`);
    }
    const root = assertRepoRoot({ repoFlag: context.repoFlag });

    const result = scaffoldInit({
      root,
      directories: commaList(context.values["directories"]),
      hook: { agentTrailer, runTrailer, markerEnvVar: markerEnv },
      hookPath: context.values["hook-path"],
      force: context.booleans.has("force"),
      canonValuesPath: context.values["canon-values-path"],
      scenario: context.values["scenario"],
    });

    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return result.hookOutcome === "refused" ? 1 : 0;
    }
    context.io.out(`created directories: ${result.createdDirectories.join(", ") || "(none -- all already existed)"}`);
    context.io.out(`hook: ${result.hookOutcome} (${result.hookWritten})`);
    if (result.canonValuesWritten !== null) context.io.out(`canon-values: ${result.canonValuesWritten}`);
    if (result.hookOutcome === "refused") {
      context.io.err(`nen: ${result.hookError ?? "hook install refused"}`);
      return 1;
    }
    return 0;
  },
};
