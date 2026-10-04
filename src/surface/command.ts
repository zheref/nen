// src/surface/command.ts -- `nen surface mirror generate|check`: one skills
// directory, rendered into the layout and frontmatter another agent surface
// documents for itself.
//
// WHY IT IS A FAMILY AND NOT A FLAG ON `canon mirror`. The two mirrors answer
// the same QUESTION ("is the committed copy still an image of its source?") and
// share none of its INPUTS: canon substitutes `{{TOKEN}}` bindings from a values
// file and pins a ref; this one filters frontmatter keys per a surface's own
// documentation and rewrites invocation spellings. Folding them together would
// have produced a verb with two disjoint halves of required flags and a
// `--kind` to say which -- the shape ../cli/registry.ts's header exists to keep
// out of this binary.
//
// NEITHER VERB DECIDES ANYTHING. `generate` writes the mirror the table
// describes; `check` says how the committed one differs. Neither opens a pull
// request, neither installs anything into a surface's real skills directory, and
// neither judges whether a skill is any good for the surface it is being
// mirrored into. `check --installed` reads a copy somebody else installed and
// says whether it is still the source's image; it copies nothing back.

import { join, resolve } from "node:path";
import {
  emit,
  requireSubcommand,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { isContained } from "../repo/contain.js";
import { assertRepoRoot } from "../repo/root.js";
import { resolveLinkOptions, type LinkOptions } from "./links.js";
import {
  checkSurfaceMirror,
  generateSurfaceMirrorReport,
  mirrorReportOk,
  readSourceAgentsReport,
  readSourceSkills,
  SurfaceMirrorError,
  writeSurfaceMirror,
  type GenerateReport,
} from "./mirror.js";
import {
  isVersion,
  readHooksManifest,
  readModelMaps,
  readPermissions,
  readPluginManifest,
  readRules,
  SurfacePackError,
} from "./packs.js";
import { commaList } from "../cli/comma.js";
import { GIT } from "../seam/exec.js";
import {
  assertTreesInSource,
  checkExplicitCopy,
  identityOf,
  checkRecordedCopies,
  PluginCheckError,
  pluginManifest,
  resolveConfigDir,
  safe,
  validateTrees,
  VERDICT_EXIT,
  type CopyJudgement,
  type Difference,
  type JudgeContext,
} from "./plugin.js";
import { findSurface, SURFACES, surfaceNames, type SurfaceRow } from "./rules.js";
import { CAPABILITIES, capabilityNames, findCapabilities, renderCapabilities } from "./capabilities.js";

export const GENERATE_CONTRACT = "nen.surface.mirror.generate/v0.1";
export const CHECK_CONTRACT = "nen.surface.mirror.check/v0.1";
export const CHECK_INSTALLED_CONTRACT = "nen.surface.mirror.check-installed/v0.1";
export const CHECK_PLUGIN_CONTRACT = "nen.surface.mirror.check-plugin/v0.1";

/**
 * The surface whose aliases the SOURCE personas carry in `model:` when the
 * caller does not say. A canonical skills tree is read directly by one
 * surface, so its personas name that surface's models; the one this binary's
 * first consumer writes for is Claude Code, and `claude` is the key every
 * real workflow (nen's own, its first consumer's) spells that row under --
 * `claude-code` named a row nobody declared (Nobunaga N8). Caller data all
 * the same -- the flag overrides it, and the value is only ever a key of the
 * caller's own `models` matrix; when the key is absent and exactly one
 * declared row resolves a persona's alias, the refusal names it.
 */
export const DEFAULT_SOURCE_SURFACE = "claude";

const SURFACE_LIST = SURFACES.map((row): string => `    ${row.surface.padEnd(12)} ${row.summary}`).join("\n");

const USAGE = `nen surface -- mirror a skills directory into another agent surface's own layout,
               and say what each surface can do.

usage:
  nen surface capabilities --surface <name> [--json]
  nen surface capabilities [--json]                 (every surface)
  nen surface mirror generate --source <dir> --surface <name> --out <dir>
                              [--agents <dir>] [--invocation-prefix <prefix>]
                              [--repo <path>]
                              [--hooks <hooks.json>] [--hooks-root <expr>]
                              [--manifest <plugin.json>] [--models <workflow.json>]
                              [--source-surface <name>]
                              [--rules <file.md>] [--permissions <permissions.json>]
                              [--stamp <version>] [--dry-run] [--json]
  nen surface mirror check    --source <dir> --surface <name> --out <dir>
                              [the same inputs] [--stamp <version>] [--json]
  nen surface mirror check    --source <dir> --surface <name> --installed <dir>
                              [the same inputs] [--stamp <version>] [--json]
  nen surface mirror check    --surface claude-code --plugin <name>
                              --source <plugin root> --installed <dir>|auto
                              --trees <dir,dir,...> [--config-dir <dir>]
                              [--independent-source <dir>] [--repo <path>]
                              [--json]

capabilities: the primitives a RUNNING SESSION on a surface has -- which
tool asks a human a multiple-choice question, which raises a subagent, which
hook events exist and the JSON key a PreToolUse hook answers with, whether a
subagent can be isolated in a worktree, whether a page can be published,
whether the surface notifies on its own, where a permission allowlist lives
and in what shape, the per-agent model key, the rules file and its limit, and
the description budget -- as data with a citation per row (zheref/nen #216,
#227), so a skill branches on a fact rather than on prose that was true when
it was written. Surfaces: ${capabilityNames().join(", ")}. An unknown one
exits 2 naming those.

mirror: for every '<name>/SKILL.md' under --source, writes '<out>/<name>/SKILL.md': the
body verbatim but for its relative links, the frontmatter reduced to the keys
the surface documents, and -- where the surface documents an explicit
invocation spelling -- every '<prefix><name>' mention rewritten into it. A
relative link in a skill, persona, AGENTS.md section, persona TOML or rules
file is re-aimed for the depth its copy lands at: one to another mirrored
skill, persona, include or the rules file lands on that item's copy (a
persona on codex on its AGENTS.md section, '#<anchor>'); any other lands on
the same file on disk, the fragment kept. Absolute, 'scheme:' and bare
'#fragment' links are carried as written. Every generated file carries a
one-line 'GENERATED by nen surface mirror' marker as its first MARKDOWN line
(after the frontmatter fence, because the surface needs that fence first); a
TOML file carries it as a '# ' first line and a JSON file as a top-level
'$generated' key.

surfaces (src/surface/rules.ts -- one row each, with the page every fact was
read from):
${SURFACE_LIST}

  --source <dir>              REQUIRED. The directory whose SUBDIRECTORIES are
                              the skills. One with no <name>/SKILL.md in it is
                              refused rather than mirrored as empty.
  --surface <name>            REQUIRED. A row in the table above; anything else
                              is refused, naming the ones that exist.
  --out <dir>                 REQUIRED (unless --installed). Where the mirror
                              goes. A path INSIDE --source is refused: the
                              mirror would become part of the source it is
                              generated from.
  --agents <dir>              A directory of '*.md' persona files. Where the
                              surface documents per-persona files they are
                              written one apiece; where it documents none, every
                              persona becomes a section of the one prose
                              document the row names. A '_'-prefixed file is a
                              shared include the personas cite by path, not a
                              persona: carried beside them as '_<stem>.md'
                              (or a '## _<stem>' section of the appendix),
                              never routed on, and listed under includes[].
  --invocation-prefix <p>     The SOURCE's own invocation namespace (e.g.
                              'myplugin:'). Caller data, never a literal in this
                              binary. Without it nothing is rewritten.
  --hooks <hooks.json>        A Claude-Code-shaped hook manifest (Stop,
                              PreToolUse, SessionStart groups, each with
                              commands). Emitted at the row's hook file with the
                              events renamed to the surface's own; a surface
                              with no hooks reports 'hooks: not supported'.
  --hooks-root <expr>         What '\${CLAUDE_PLUGIN_ROOT}' in a --hooks command
                              becomes, double-quoted inside the command when
                              it has whitespace or expands; a command still
                              carrying a '$' (or a quoted root) is wrapped as
                              sh -c 'exec <command>' -- so a surface with no
                              shell expands it. Refused on the verbatim row,
                              and for a root or command carrying '"', a
                              backtick, '$(', a backslash or a newline. The
                              scripts a command names
                              as <root>/hooks/<file> are copied beside the
                              manifest to <out>/hooks/<file> (mode 755, marker
                              on line 2 where the shebang implies '#'
                              comments; otherwise no marker, noted) on every
                              non-verbatim row.
  --manifest <plugin.json>    A Claude plugin manifest; a row that documents a
                              plugin manifest of its own (antigravity:
                              plugin.json with name, version, description)
                              gets one with those keys; the others report
                              'manifest: not supported'.
  --models <workflow.json>    A nen/workflow.json whose 'models.<surface>' maps
                              tiers to aliases. A persona's 'model:' is read as
                              a tier, else as an alias of --source-surface's
                              row (read back to its one tier), and rewritten to
                              the target alias; 'inherit' is carried where the
                              surface documents it and dropped (named)
                              elsewhere; anything else is refused by pointer.
                              Codex also gets config.toml.fragment
                              (default_subagent_model = the 'fast' alias) and
                              one agents/<name>.toml per persona.
  --source-surface <name>     The surface the SOURCE personas were written for
                              (default claude): their 'model:' values are
                              that surface's aliases, read back through
                              'models.<name>'. When the file has no such row
                              and exactly one declared row resolves the
                              alias, the refusal names it.
  --rules <file.md>           A rules document, emitted at the row's rules
                              directory as '<stem><ext>' with the surface's own
                              frontmatter; over the surface's documented
                              character limit it is REFUSED, never truncated.
  --permissions <file.json>   A permissions source ({ allow: [{exe, args}],
                              deny: [...], surfaces: { <name>: { allow, deny,
                              network_access } } }), emitted as the surface's
                              own pack -- Bash(exe args) for claude-code,
                              Shell(exe:args) for cursor, a config.toml with
                              writable_roots = [] for codex (the installer
                              fills it; the report says
                              writableRootsPlaceholder). A surfaces.<name>
                              block is transcribed verbatim after the shared
                              rows for that surface only; its network_access
                              (a boolean) is written into codex's sandbox
                              block ONLY when declared, and the report says
                              'network: not declared' otherwise. A surface
                              with no allowlist file reports 'permissions:
                              not supported'; a '(' or ')' in a row is
                              refused.
  --stamp <version>           MAJOR.MINOR.PATCH of the source, written into the
                              marker. 'check --stamp' then reports a file
                              carrying no stamp or another one as STALE.
  --repo <path>               The tree a re-aimed link may reach (default: the
                              working directory; the path flags themselves
                              still resolve against the working directory). A
                              link whose target or copy is outside it -- a
                              mirror written straight into an installed
                              surface -- is carried as written and listed
                              under linksVerbatim; a link to a mirrored item
                              is always re-aimed, since it moves with the
                              mirror. Give check the same --repo.
  --installed <dir>           check only, in place of --out: an installed copy
                              (a plugin cache directory, a consumer's .codex/,
                              .cursor/, .agents/) compared against a fresh
                              in-memory generation under the check-installed
                              contract.
  --plugin <name>             check only (zheref/nen#339): judge a Claude Code
                              PLUGIN install in the plugin's own layout -- a
                              plugin cache copy or a skills-directory install
                              -- rather than a mirror. --source is then the
                              plugin's source root (the directory holding
                              .claude-plugin/plugin.json naming <name>), and
                              --trees, plus the two manifests
                              .claude-plugin/plugin.json and marketplace.json,
                              are compared byte for byte, every differing path
                              named by side. A symlink is compared by its
                              target and never opened; a name with a control
                              character (or not UTF-8) is never compared or
                              printed raw; .DS_Store is ignored. The mirror
                              inputs (--agents, --hooks, --stamp, --out, ...)
                              are refused in this mode.
  --installed auto            with --plugin: every copy the host has recorded --
                              each installPath of each <name>@<marketplace>
                              entry of <config>/plugins/installed_plugins.json,
                              and <config>/skills/<name> when it exists -- each
                              judged once by real path; the verdict is the
                              worst (2 > 1 > 5 > 4 > 0).
  --trees <a,b,...>           with --plugin, REQUIRED: the directories the plugin
                              ships, relative to its root. Caller data: which
                              trees a plugin ships is the plugin's fact. Split
                              on '/' and '\\' on every host; ':' and '.'/'..'
                              refused; each must be a real directory in
                              --source, every segment lstat'ed (exit 2 if not).
  --config-dir <dir>          with --plugin: Claude Code's config directory
                              (default \$CLAUDE_CONFIG_DIR, else ~/.claude).
  --independent-source <dir>  with --plugin: a source root named independently
                              of the served copy. A COPY IS NEVER ITS OWN
                              EVIDENCE: when the copy and --source are the same
                              real path, the source is, in order, this flag,
                              the <name>@<marketplace> entry's 'directory'
                              source in known_marketplaces.json, then the
                              checkout --repo (else the working directory)
                              stands in -- only on its trunk (nen/workflow.json
                              branch.base, else origin/HEAD, else main) or on
                              the branch the served copy is at. When that source
                              IS the copy and the copy is a git checkout, it is
                              identical by link; with none it is NOT
                              COMPARABLE, never identical. Refused (exit 2) when
                              no judged copy is --source. A stand-in that IS
                              the copy counts only on its trunk.
  --dry-run                   generate only. Reports exactly what it would write
                              and writes nothing.

'check' regenerates in memory and diffs the committed mirror, writing nothing at
all. A file is MISSING (generated, not in --out), EXTRA (in --out's mirror
universe, with no source), STALE (marked, but for a different surface -- or,
with --stamp, for no stamp or a different one -- or byte for byte what a
build before links were re-aimed generated -- or a fresh generation's but for
links out of the mirror aimed from another location: a copied install, or a
generate run from another root), HAND_EDITED (marked for this
surface, bytes differ from a fresh generation -- or a hook script's mode is
not the 755 it was written with) or OK. Only '<name>/SKILL.md',
the row's own persona files and the row's hook, rules, permission and fragment
files are in that universe; anything else --out holds is neither checked nor
deleted.

Exit codes: 0 a completed generate, or a check with no drift; 1 a check with any
drift; 2 a missing or unknown flag, a --repo that is empty or does not exist,
an --out inside --source, a --source with no SKILL.md, a skill missing a key
the surface requires, a rules file over the surface's limit (its links
re-aimed), a tier --models does not declare, or a destination that exists and
carries no marker (this verb never overwrites a hand-written file).

check --plugin has six verdicts, each its own exit: 0 identical (or served by
link to a git checkout named independently); 1 different, every differing path
named; 2 wiring -- a bad flag, a --source or explicit --installed that is not a
copy of the plugin, or a file or directory that could not be read (never read
as missing); 3 not installed -- no <name>@ entry and no skills/<name>; 4 not
comparable -- the copy is the source given and no independent source exists;
5 broken install -- an entry with no usable installPath, a recorded path that
is gone, a dangling or looping link, a path with a control character (one
install, refused, never split), a recorded path that is not a directory, an
install record that is not JSON or is a dangling link, or a recorded copy of
another plugin. Every path is walked one segment at a time with lstat: a link
anywhere is an entry compared by target, never descended into.`;

/** `check --plugin`'s own flags (zheref/nen#339): read in that mode only, refused outside it. */
const PLUGIN_VALUES = ["plugin", "trees", "config-dir", "independent-source"];

/** The mirror inputs `check --plugin` does not read: the plugin's tree is compared as it ships. */
const MIRROR_ONLY_VALUES = ["agents", "invocation-prefix", "hooks", "hooks-root", "manifest", "models", "source-surface", "rules", "permissions", "stamp", "out"];

const INPUT_VALUES = ["source", "agents", "surface", "source-surface", "invocation-prefix", "hooks", "hooks-root", "manifest", "models", "rules", "permissions", "stamp"];

const SUBCOMMAND_FLAGS: Readonly<Record<string, { values: readonly string[]; booleans: readonly string[] }>> = {
  generate: { values: [...INPUT_VALUES, "out"], booleans: ["dry-run"] },
  check: { values: [...INPUT_VALUES, "out", "installed", ...PLUGIN_VALUES], booleans: [] },
};

const FAMILY_VALUES = [
  ...new Set(Object.values(SUBCOMMAND_FLAGS).flatMap((spec): readonly string[] => spec.values)),
].sort();
const FAMILY_BOOLEANS = [
  ...new Set(Object.values(SUBCOMMAND_FLAGS).flatMap((spec): readonly string[] => spec.booleans)),
].sort();

/** Refused rather than ignored -- ../report/command.ts's argument, verbatim. */
function refuseForeignFlags(subcommand: string, context: CommandContext): void {
  const spec = SUBCOMMAND_FLAGS[subcommand];
  /* c8 ignore next -- the subcommand was already checked against the same keys */
  if (spec === undefined) return;
  const known = new Set([...FAMILY_VALUES, ...FAMILY_BOOLEANS]);
  const mine = new Set([...spec.values, ...spec.booleans]);
  const foreign = [...Object.keys(context.args.values), ...context.args.booleans].filter(
    (flag): boolean => known.has(flag) && !mine.has(flag),
  );
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    `--${[...new Set(foreign)].sort().join(", --")} ${foreign.length === 1 ? "is" : "are"} not read by 'surface mirror ${subcommand}'. A flag accepted and ignored is worse than one refused: the ignored thing is the instruction you gave.`,
  );
}

function required(context: CommandContext, flag: string, why: string): string {
  const value = context.args.values[flag];
  if (value === undefined || value.trim() === "") throw new VerbUsageError(`--${flag} is required. ${why}`);
  return value;
}

/** An optional path flag: absent, or present and non-empty. An empty value is refused, never read as absent. */
function optionalPath(context: CommandContext, flag: string): string | null {
  const value = context.args.values[flag];
  if (value === undefined) return null;
  if (value.trim() === "") {
    throw new VerbUsageError(`--${flag} was given an empty value. Omit it entirely, or name the file.`);
  }
  return value;
}

interface Inputs {
  readonly row: SurfaceRow;
  readonly sourceDir: string;
  /** `--out`, or `--installed` when that was given instead. */
  readonly outDir: string;
  readonly installed: boolean;
  readonly agentsDir: string | null;
  readonly stamp: string | null;
  readonly skippedAgents: readonly string[];
  readonly report: GenerateReport;
  /** Where the inputs and the mirror sit, as real paths; `links.root` is the tree a rewritten link may reach. */
  readonly links: LinkOptions;
}

/** What `--agents` holds when the flag is absent: no personas, no includes, nothing skipped. */
const NO_AGENTS = { agents: [], includes: [], skipped: [] } as const;

function readInputs(context: CommandContext, allowInstalled: boolean): Inputs {
  const sourceDir = required(
    context,
    "source",
    "It names the directory whose subdirectories are the skills to mirror.",
  );
  const installedFlag = allowInstalled ? optionalPath(context, "installed") : null;
  const outFlag = context.args.values["out"];
  if (installedFlag !== null && outFlag !== undefined) {
    throw new VerbUsageError(
      "--installed replaces --out: the installed copy IS the directory being checked. Give one or the other.",
    );
  }
  const outDir =
    installedFlag ?? required(context, "out", "It names the directory the mirror is written into.");
  const surfaceName = required(
    context,
    "surface",
    `It selects a row of the surface table. Known: ${surfaceNames().join(", ")}.`,
  );
  const row = findSurface(surfaceName);
  if (row === undefined) {
    throw new VerbUsageError(
      `--surface '${surfaceName}' is not in the table. Known: ${surfaceNames().join(", ")}. A surface nen has not read the documentation for cannot be guessed at: adding one is a row in src/surface/rules.ts carrying the page every field was read from.`,
    );
  }

  // BEFORE ANYTHING IS READ. A caller who pointed --out at a path inside
  // --source must hear about THAT, not about the eleventh skill's frontmatter
  // -- and on the second run the mirror would be inside the set being mirrored,
  // so the generator would start generating from its own output.
  const sourceAbs = resolve(sourceDir);
  const outAbs = resolve(outDir);
  if (installedFlag === null && isContained(sourceAbs, outAbs)) {
    throw new VerbUsageError(
      `--out '${outDir}' resolves inside --source '${sourceDir}' (${outAbs}). The mirror would become part of the source it is generated from, and the next run would mirror its own output. Point --out at a directory outside the source tree.`,
    );
  }

  const stamp = context.args.values["stamp"] ?? null;
  if (stamp !== null && !isVersion(stamp)) {
    throw new VerbUsageError(
      `--stamp '${stamp}' is not a MAJOR.MINOR.PATCH version. The stamp is compared as a version by 'check --stamp', so it has to be one.`,
    );
  }

  const agentsFlag = context.args.values["agents"];
  if (agentsFlag !== undefined && agentsFlag.trim() === "") {
    throw new VerbUsageError(
      "--agents was given an empty value. Omit it entirely to mirror the skills and no personas.",
    );
  }
  const agents = agentsFlag === undefined ? NO_AGENTS : readSourceAgentsReport(agentsFlag);
  const hooksPath = optionalPath(context, "hooks");
  const modelsPath = optionalPath(context, "models");
  const sourceSurface = context.args.values["source-surface"] ?? DEFAULT_SOURCE_SURFACE;
  if (sourceSurface.trim() === "") {
    throw new VerbUsageError("--source-surface was given an empty value. Omit it for the default, or name the surface the source personas were written for.");
  }
  const rulesPath = optionalPath(context, "rules");
  const permissionsPath = optionalPath(context, "permissions");
  const manifestPath = optionalPath(context, "manifest");
  const hooksRoot = context.args.values["hooks-root"] ?? null;
  if (hooksRoot !== null) {
    if (hooksRoot.trim() === "") {
      throw new VerbUsageError("--hooks-root was given an empty value. Omit it to carry the commands verbatim.");
    }
    if (hooksPath === null) {
      throw new VerbUsageError("--hooks-root rebases the commands of a --hooks manifest, and no --hooks was given.");
    }
    if (row.verbatim) {
      throw new VerbUsageError(
        `--hooks-root is refused on '${row.surface}': its manifest is carried byte for byte, and a rebased command would be a change to the file this row promises not to change.`,
      );
    }
  }

  // The tree a re-aimed link may reach is the invocation's own base -- --repo,
  // else the working directory (../repo/root.ts) -- and every end is a real
  // path, so a symlinked install regenerates to the committed bytes
  // (./links.ts).
  const links = resolveLinkOptions({
    root: assertRepoRoot({ repoFlag: context.repoFlag }),
    sourceDir,
    agentsDir: agentsFlag ?? null,
    rulesFile: rulesPath,
    outDir,
  });

  return {
    row,
    sourceDir,
    outDir,
    installed: installedFlag !== null,
    agentsDir: agentsFlag ?? null,
    stamp,
    skippedAgents: agents.skipped,
    links,
    report: generateSurfaceMirrorReport({
      row,
      skills: readSourceSkills(sourceDir),
      agents: agents.agents,
      includes: agents.includes,
      invocationPrefix: context.args.values["invocation-prefix"] ?? null,
      stamp,
      hooks: hooksPath === null ? null : readHooksManifest(hooksPath),
      hooksRoot,
      manifest: manifestPath === null ? null : readPluginManifest(manifestPath),
      models: modelsPath === null ? null : readModelMaps(modelsPath, row.surface, sourceSurface),
      rules: rulesPath === null ? null : readRules(rulesPath),
      permissions: permissionsPath === null ? null : readPermissions(permissionsPath),
      links,
    }),
  };
}

const listOr = (items: readonly string[]): string => (items.length === 0 ? "(none)" : items.join(", "));

function runGenerate(context: CommandContext): number {
  const inputs = readInputs(context, false);
  const dryRun = context.args.booleans.has("dry-run");
  const report = inputs.report;
  const result = writeSurfaceMirror(inputs.outDir, report.files, inputs.row, dryRun);
  context.io.err(`nen: note: ${inputs.row.surface}: ${inputs.row.caveat}.`);
  const rulesLine =
    typeof report.rules === "string"
      ? report.rules
      : `${report.rules.path} (${report.rules.chars} chars, ${report.rules.bytes} bytes${report.rules.limit === null ? "" : ` of ${report.rules.limit}`})`;
  emit(
    context.io,
    context.json,
    {
      contract: GENERATE_CONTRACT,
      surface: inputs.row.surface,
      skillsPath: inputs.row.skillsPath,
      out: inputs.outDir,
      dryRun,
      written: result.written,
      unchanged: result.unchanged,
      deleted: result.deleted,
      stamp: inputs.stamp,
      skippedAgents: inputs.skippedAgents,
      truncated: report.truncated,
      droppedInherit: report.droppedInherit,
      undocumentedAliases: report.undocumentedAliases,
      modelMapped: report.modelMapped,
      hooks: report.hooks,
      rules: report.rules,
      permissions: report.permissions,
      manifest: report.manifest,
      notes: report.notes,
      permissionSurfaceRows: report.permissionSurfaceRows,
      writableRootsPlaceholder: report.writableRootsPlaceholder,
      permissionNetworkAccess: report.permissionSandbox?.networkAccess ?? null,
      includes: report.includes,
      linkRoot: inputs.links.root,
      linksRewritten: report.linksRewritten,
      linksVerbatim: report.linksVerbatim,
    },
    [
      `surface: ${inputs.row.surface} (${inputs.row.skillsPath})`,
      `out: ${inputs.outDir}${dryRun ? " (--dry-run: nothing written)" : ""}`,
      ...(inputs.stamp === null ? [] : [`stamp: ${inputs.stamp}`]),
      `written: ${listOr(result.written)}`,
      `unchanged: ${listOr(result.unchanged)}`,
      `deleted (orphaned): ${listOr(result.deleted)}`,
      ...(report.includes.length === 0
        ? []
        : [`includes (shared, carried beside the personas, not personas): ${report.includes.join(", ")}`]),
      ...(inputs.skippedAgents.length === 0
        ? []
        : [`skipped (not a regular file): ${inputs.skippedAgents.join(", ")}`]),
      ...(report.truncated.length === 0
        ? []
        : [`truncated (description over the ${inputs.row.descriptionBudget ?? 0}-char budget; summary: added): ${report.truncated.join(", ")}`]),
      ...(report.droppedInherit.length === 0
        ? []
        : [`model: inherit dropped (the surface documents no inherit): ${report.droppedInherit.join(", ")}`]),
      ...(report.undocumentedAliases.length === 0
        ? []
        : [`model alias outside the surface's documented set (${(inputs.row.modelAliases ?? []).join("|")}): ${report.undocumentedAliases.join(", ")}`]),
      ...(report.modelMapped.length === 0
        ? []
        : [`modelMapped: ${report.modelMapped.join(", ")} (${inputs.row.surface} writes no model id)`]),
      `hooks: ${report.hooks}`,
      `rules: ${rulesLine}`,
      `permissions: ${report.permissions}${report.permissionSurfaceRows > 0 ? ` (+${report.permissionSurfaceRows} surface rows)` : ""}`,
      ...(report.permissionSandbox === null
        ? []
        : [
            report.permissionSandbox.networkAccess === null
              ? "network: not declared (no network_access line; the surface's own default applies)"
              : `network: declared (network_access = ${report.permissionSandbox.networkAccess})`,
          ]),
      `manifest: ${report.manifest}`,
      ...(report.linksRewritten === 0 ? [] : [`links re-aimed for this mirror's depth: ${report.linksRewritten}`]),
      ...(report.linksVerbatim.length === 0
        ? []
        : [
            `links left as written (the target or the copy is outside ${inputs.links.root}, the tree --repo names): ${report.linksVerbatim.join(", ")}`,
          ]),
      ...report.notes.map((note): string => `note: ${note}`),
    ],
  );
  return 0;
}

function runCheck(context: CommandContext): number {
  if (context.args.values["plugin"] !== undefined) return runPluginCheck(context);
  const pluginOnly = PLUGIN_VALUES.filter((flag): boolean => context.args.values[flag] !== undefined);
  if (pluginOnly.length > 0) {
    throw new VerbUsageError(
      `--${pluginOnly.join(", --")} ${pluginOnly.length === 1 ? "is" : "are"} read only with --plugin <name>, which judges a Claude Code plugin install in its own layout. Give --plugin, or drop ${pluginOnly.length === 1 ? "it" : "them"}.`,
    );
  }
  if (context.args.values["installed"] === "auto") {
    throw new VerbUsageError(
      "--installed auto reads the host's install record, which only --plugin <name> mode does. Give --plugin <name> (and --trees), or name the installed directory.",
    );
  }
  const inputs = readInputs(context, true);
  const { relocated, ...report } = checkSurfaceMirror(inputs.outDir, inputs.report.files, inputs.row, inputs.stamp);
  const contract = inputs.installed ? CHECK_INSTALLED_CONTRACT : CHECK_CONTRACT;
  // `relocated` is a reason, not a drift class: it reaches the text report
  // only, so the --json shape (and its contract) is exactly what it was.
  emit(
    context.io,
    context.json,
    inputs.installed
      ? { contract, ...report, installed: inputs.outDir, stamp: inputs.stamp }
      : { contract, ...report, stamp: inputs.stamp },
    [
      `surface: ${report.surface}`,
      ...(inputs.installed ? [`installed: ${inputs.outDir}`] : []),
      ...(inputs.stamp === null ? [] : [`stamp: ${inputs.stamp}`]),
      `ok: ${report.ok.length}`,
      `missing: ${listOr(report.missing)}`,
      `extra: ${listOr(report.extra)}`,
      `stale: ${listOr(report.stale)}`,
      ...(relocated.length === 0
        ? []
        : [
            `stale because their links out of the mirror are aimed from another location (a copied install, or a generate run from another root or --repo; regenerate here to heal): ${relocated.join(", ")}`,
          ]),
      `hand-edited: ${listOr(report.handEdited)}`,
    ],
  );
  return mirrorReportOk(report) ? 0 : 1;
}

export const surfaceCommand: Command = {
  name: "surface",
  subcommands: ["mirror", "capabilities"],
  summary: "Mirror a skills directory into another agent surface's layout, and check it for drift.",
  usage: USAGE,
  flags: { values: FAMILY_VALUES, booleans: FAMILY_BOOLEANS },
  run(context: CommandContext): number {
    const family = requireSubcommand("surface", context.args, ["mirror", "capabilities"]);
    if (family === "capabilities") return runCapabilities(context);
    const sub = context.args.positionals[2];
    if (sub !== "generate" && sub !== "check") {
      throw new VerbUsageError(
        `unknown 'surface mirror' subcommand '${sub ?? "(none)"}'. Try 'generate' or 'check'.`,
      );
    }
    refuseForeignFlags(sub, context);
    try {
      return sub === "generate" ? runGenerate(context) : runCheck(context);
    } catch (error) {
      // A refusal the mirror raised is a refusal the CALLER made -- a source
      // with no skills, a required key the surface documents and the file has
      // not got, a destination somebody wrote by hand. It exits 2 like every
      // other "you asked for something that cannot be done", carrying its own
      // message whole (../cli/command.ts's parseCallerToken makes the same
      // trade for the same reason).
      if (error instanceof SurfaceMirrorError || error instanceof SurfacePackError || error instanceof PluginCheckError) {
        throw new VerbUsageError(error.message);
      }
      throw error;
    }
  },
};

const DIFFERENCE_LABEL: Readonly<Record<Difference["kind"], string>> = {
  "only-in-source": "only in source:",
  "only-in-copy": "only in copy:  ",
  differs: "differs:       ",
  "differs-symlink": "differs:       ",
  "unexpected-in-copy": "unexpected:    ",
  "unexpected-in-source": "unexpected in source:",
};

function differenceLine(difference: Difference): string {
  const tail =
    difference.kind === "differs-symlink"
      ? " (symlink; never opened)"
      : difference.kind === "unexpected-in-copy" || difference.kind === "unexpected-in-source"
        ? " (a name with a control character, or not UTF-8, is never compared)"
        : "";
  return `  ${DIFFERENCE_LABEL[difference.kind]} ${difference.path}${tail}`;
}

function copyLines(copy: CopyJudgement): string[] {
  return [`${copy.verdict} -- ${copy.reason}`, ...copy.differences.map(differenceLine)];
}

/**
 * `check --plugin <name> --installed <dir|auto>` (zheref/nen#339): a Claude
 * Code plugin install judged in the plugin's OWN layout against --source,
 * under ./plugin.ts's independence rule. Six verdicts, six exits.
 */
function runPluginCheck(context: CommandContext): number {
  const plugin = required(context, "plugin", "It names the plugin whose install is judged.");
  if (CONTROL_CHAR.test(plugin) || /[@/\\]/.test(plugin) || plugin === "." || plugin === "..") {
    throw new VerbUsageError(`--plugin '${safe(plugin)}' is not a plugin name (no '@', '/' or '\\', not '.' or '..', no control character).`);
  }
  const surfaceName = required(context, "surface", "--plugin judges a Claude Code plugin install: give --surface claude-code.");
  if (surfaceName !== "claude-code") {
    throw new VerbUsageError(
      `--plugin judges a Claude Code plugin install in its own layout; --surface '${safe(surfaceName)}' has no plugin cache. Give --surface claude-code, or drop --plugin to check a mirror.`,
    );
  }
  const foreign = MIRROR_ONLY_VALUES.filter((flag): boolean => context.args.values[flag] !== undefined);
  if (foreign.length > 0) {
    throw new VerbUsageError(
      `--${foreign.join(", --")} ${foreign.length === 1 ? "is" : "are"} not read with --plugin: the plugin's tree is compared byte for byte as it ships, so nothing is generated from mirror inputs. A flag accepted and ignored is worse than one refused.`,
    );
  }
  const installed = required(context, "installed", "It names the installed copy to judge, or 'auto' for every copy the host has recorded.");
  const trees = validateTrees(commaList(context.args.values["trees"]));
  const sourceFlag = required(context, "source", "With --plugin it names the plugin's source root: the directory holding .claude-plugin/plugin.json.");
  if (pluginManifest(sourceFlag, plugin) === null) {
    throw new VerbUsageError(
      `--source '${safe(sourceFlag)}' is not a root of '${plugin}' (no regular .claude-plugin/plugin.json naming it).`,
    );
  }
  const sourceId = identityOf(sourceFlag);
  /* c8 ignore next 3 -- pluginManifest above already proved the directory is there */
  if (sourceId === null) {
    throw new VerbUsageError(`--source '${safe(sourceFlag)}' cannot be resolved.`);
  }
  // Every tree a real directory in the source, every segment lstat'ed (N1):
  // a typo'd tree would otherwise compare as empty on both sides and read identical.
  assertTreesInSource(sourceId.real, trees);
  const independent = optionalPath(context, "independent-source");
  if (independent !== null && pluginManifest(independent, plugin) === null) {
    throw new VerbUsageError(
      `--independent-source '${safe(independent)}' is not a root of '${plugin}' (no regular .claude-plugin/plugin.json naming it).`,
    );
  }
  const configDir = resolveConfigDir(optionalPath(context, "config-dir"), context.seams.env);
  const judge: JudgeContext = {
    plugin,
    trees,
    source: sourceId.real,
    sourceId,
    independentSource: independent,
    configDir,
    standIn: resolve(context.repoFlag ?? process.cwd()),
    git: (cwd, args) => {
      // Read-only probes of the checkout named by cwd: a GIT_DIR, GIT_WORK_TREE
      // or GIT_INDEX_FILE inherited from a hook must not redirect them (N13).
      const result = context.seams.run(GIT, [...args], { cwd, env: GIT_PROBE_ENV });
      return { code: result.spawnFailed ? 127 : result.code, stdout: result.stdout.split("\n")[0]?.trim() ?? "" };
    },
  };
  const report = installed === "auto" ? checkRecordedCopies(judge) : checkExplicitCopy(installed, judge);
  const notInstalled =
    report.verdict === "not installed"
      ? [`not installed -- no ${plugin}@ entry in ${safe(join(configDir, "plugins", "installed_plugins.json"))} and no ${safe(join(configDir, "skills", plugin))}`]
      : [];
  emit(
    context.io,
    context.json,
    {
      contract: CHECK_PLUGIN_CONTRACT,
      surface: "claude-code",
      plugin,
      source: judge.source,
      installed: installed === "auto" ? "auto" : safe(installed),
      configDir: safe(configDir),
      trees,
      record: report.record,
      verdict: report.verdict,
      exit: VERDICT_EXIT[report.verdict],
      copies: report.copies,
    },
    [
      `surface: claude-code (plugin ${plugin})`,
      `source: ${safe(judge.source)}`,
      `installed: ${installed === "auto" ? `auto (${safe(configDir)})` : safe(installed)}`,
      `trees: ${trees.join(", ")} + ${PLUGIN_MANIFESTS_LINE}`,
      ...(report.record === "not read" ? [] : [`install record: ${report.record}`]),
      ...report.copies.flatMap(copyLines),
      ...notInstalled,
      `verdict: ${report.verdict}`,
    ],
  );
  return VERDICT_EXIT[report.verdict];
}

const GIT_PROBE_ENV: Readonly<Record<string, undefined>> = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };
const CONTROL_CHAR = /[\x00-\x1f\x7f-\x9f]/;
const PLUGIN_MANIFESTS_LINE = ".claude-plugin/plugin.json, .claude-plugin/marketplace.json";

function runCapabilities(context: CommandContext): number {
  const name = context.args.values["surface"] ?? null;
  if (name === null) {
    const lines = CAPABILITIES.flatMap((row): string[] => [...renderCapabilities(row), ""]);
    emit(context.io, context.json, { contract: "nen.surface.capabilities/v0.1", surfaces: CAPABILITIES }, lines);
    return 0;
  }
  const row = findCapabilities(name);
  if (row === undefined) {
    throw new VerbUsageError(`unknown surface '${name}'. This build knows: ${capabilityNames().join(", ")}.`);
  }
  emit(context.io, context.json, { contract: "nen.surface.capabilities/v0.1", ...row }, renderCapabilities(row));
  return 0;
}
