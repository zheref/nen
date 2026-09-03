// src/repo/command.ts -- `nen repo resolve`, `nen repo inventory`, `nen repo
// scenario`.

import { emit, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { parseTarget, type Target } from "../github/target.js";
import { resolve, RepoResolutionError, type Resolution } from "./resolve.js";
import { assertRepoRoot, resolveRepoRoot } from "./root.js";
import { inventoryRepo } from "./inventory.js";
import { resolveScenario } from "./scenario.js";

function requireTarget(context: CommandContext): Target {
  const raw = context.args.values["target"];
  if (raw === undefined) throw new Error("--target owner/name is required.");
  return parseTarget(raw);
}

const USAGE = `nen repo resolve [<token>] [--repo <path>]
nen repo resolve [--from <dir>] [--repo <path>]
nen repo inventory --target <owner/name> --epic-label <label> --integration-prefix <prefix> [--trunk main]
nen repo scenario --repo <path> --target <owner/name>

resolve:
  Resolve a repository TOKEN against the target repository's schemas/repos.json.

  <token>          A product code (BC), an owner/name slug (owner/name), a
                   repository's short name, or 'all'. Matched EXACTLY and
                   case-insensitively -- never as a prefix. A token resolves
                   from EVERYTHING the registry records: consumers,
                   product_codes (keys and values), maintained_tools and
                   pending_onboarding.
  (no token)       Resolve the working directory's 'origin' remote instead.
  --repo <path>    The checkout whose schemas/repos.json is the registry
                   resolved against -- the same flag its siblings (repo
                   scenario, canon resolve) take, valid with and without a
                   token. Defaults to the current directory.
  --from <dir>     NO-TOKEN FORM ONLY: the directory whose 'origin' is read.
                   Defaults to the current directory. With a token there is no
                   origin to read, so the flag is refused rather than silently
                   ignored; to read another checkout's registry, use --repo.

An unknown token is an error that lists the registry's codes. It is never a
guess and never a widening to every repository.

inventory:
  senkei's live enumeration: every open issue carrying --epic-label with
  its children, every branch under --integration-prefix with its
  ahead/behind vs --trunk, and every open PR. Always fetched live.
  --integration-prefix has NO default: the naming convention for a live
  integration branch is the target repository's own, never a literal
  shipped in this binary.

scenario:
  The scenario recorded for --target in --repo's schemas/repos.json --
  the value canon-resolve/quality-tooling lookups read. Exits 1 when the
  repo is not a recorded consumer, or carries no scenario.`;

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
  summary: "Resolve a repository token, inventory a consumer's backlog, or read its recorded scenario.",
  usage: USAGE,
  flags: {
    values: ["from", "target", "epic-label", "integration-prefix", "trunk"],
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("repo", context.args, ["resolve", "inventory", "scenario"]);
    if (subcommand === "inventory") return inventory(context);
    if (subcommand === "scenario") return scenario(context);

    const token = context.args.positionals[2] ?? null;
    // `--from` FEEDS THE NO-TOKEN FORM ONLY: it names the directory whose
    // `origin` becomes the token, and a token given explicitly means no origin
    // is read at all. It used to be silently IGNORED next to a token, which
    // read as "resolve against that checkout's registry" and then resolved
    // against the wrong one (the cwd's) -- the exact failure ../cli/args.ts's
    // strictness exists to prevent, one flag deep (zheref/nen#27). Refused
    // loudly, naming the flag the caller actually wanted -- and refused BEFORE
    // the registry is opened, because a misuse of the flags must not be
    // reported as "the cwd has no schemas/repos.json" when the cwd was never
    // the checkout the caller meant.
    if (token !== null && context.args.values["from"] !== undefined) {
      throw new VerbUsageError(
        `--from applies only to the no-token form: it names the directory whose 'origin' is read, and the token '${token}' already names the subject. To resolve '${token}' against another checkout's registry, use --repo <path>.`,
      );
    }

    const taxonomy = openTaxonomy({ repoFlag: context.repoFlag });
    const registry = taxonomy.repos();
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

function inventory(context: CommandContext): number {
  const target = requireTarget(context);
  const epicLabel = context.args.values["epic-label"];
  if (epicLabel === undefined) throw new VerbUsageError("--epic-label <label> is required.");
  const integrationPrefix = context.args.values["integration-prefix"];
  if (integrationPrefix === undefined) {
    throw new VerbUsageError(
      "--integration-prefix <prefix> is required -- the naming convention for a live integration branch is the target repository's own, never a default shipped here.",
    );
  }
  const trunk = context.args.values["trunk"] ?? "main";

  const result = inventoryRepo(context.seams, target, epicLabel, integrationPrefix, trunk);
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

function scenario(context: CommandContext): number {
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

export { RepoResolutionError };
