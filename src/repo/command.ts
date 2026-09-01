// src/repo/command.ts -- `nen repo resolve`.

import { emit, requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { resolve, RepoResolutionError, type Resolution } from "./resolve.js";
import { resolveRepoRoot } from "./root.js";

const USAGE = `nen repo resolve [<token>] [--from <dir>]

Resolve a repository TOKEN against the target repository's schemas/repos.json.

  <token>          A product code (BC), an owner/name slug (owner/name), a
                   repository's short name, or 'all'. Matched EXACTLY and
                   case-insensitively -- never as a prefix.
  (no token)       Resolve the working directory's 'origin' remote instead.
  --from <dir>     The directory whose 'origin' the no-token form reads.
                   Defaults to the current directory.

An unknown token is an error that lists the registry's codes. It is never a
guess and never a widening to every repository.`;

function render(resolution: Resolution): string[] {
  const lines: string[] = [];
  if (resolution.origin !== null) {
    lines.push(`origin: ${resolution.origin}`);
  }
  for (const item of resolution.repos) {
    lines.push(`${item.repo}${item.code === null ? "" : `  (${item.code})`}  via ${item.kind}`);
  }
  return lines;
}

export const repoCommand: Command = {
  name: "repo",
  summary: "Resolve a repository token against the registry.",
  usage: USAGE,
  flags: { values: ["from"] },
  run(context: CommandContext): number {
    requireSubcommand("repo", context.args, ["resolve"]);
    const taxonomy = openTaxonomy({ repoFlag: context.repoFlag });
    const registry = taxonomy.repos();
    const token = context.args.positionals[2] ?? null;
    // `--from` defaults to the CALL SITE's cwd, not to the target repository:
    // "which repository am I standing in" and "whose taxonomy am I reading" are
    // different questions, and a verb that answered the first with the second
    // would report the target repo's origin no matter where it was run.
    const from = context.args.values["from"] ?? resolveRepoRoot({});

    const resolution = resolve({ registry, seams: context.seams, token, cwd: from });
    emit(context.io, context.json, resolution, render(resolution));
    return 0;
  },
};

export { RepoResolutionError };
