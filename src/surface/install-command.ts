// src/surface/install-command.ts -- the flags, text and --json of `nen surface
// install` and `nen surface status` (zheref/nen#298). The decisions live in
// ./install.ts; this file reads the invocation, refuses what it does not read,
// and renders the report.

import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import {
  install,
  INSTALL_CONTRACT,
  INSTALL_EXIT,
  INSTALL_SURFACES,
  STATUS_CONTRACT,
  STATUS_EXIT,
  claudeSelector,
  configDirIsExplicit,
  forbiddenRoots,
  status,
  surfaceConfigDir,
  validateRoot,
  validateSurfaceDir,
  type InstallReport,
  type InstallSurface,
  type Served,
  type StatusReport,
} from "./install.js";
import { readJudgeContext, validatePluginName } from "./judge.js";
import { checkRecordedCopies, identityOf, inspectManifest, safe, VERDICT_EXIT, type PluginCheckReport } from "./plugin.js";

/** The flags each verb reads. Anything else the family knows is refused, never ignored. */
export const INSTALL_FLAGS = { values: ["surface", "plugin", "root", "config-dir", "surface-dir"], booleans: ["dry-run"] } as const;
export const STATUS_FLAGS = {
  values: ["surface", "plugin", "root", "config-dir", "surface-dir", "trees", "source", "independent-source"],
  booleans: [] as readonly string[],
} as const;

export const INSTALL_USAGE = `  nen surface install --surface <claude-code|codex|antigravity> --plugin <name>
                      --root <checkout> [--config-dir <dir>]
                      [--surface-dir <dir>] [--dry-run] [--json]
  nen surface status  --surface <claude-code|codex|antigravity> --plugin <name>
                      [--root <checkout>] [--config-dir <dir>]
                      [--surface-dir <dir>] [--json]
  nen surface status  --surface claude-code --plugin <name> --trees <a,b,...>
                      [--source <plugin root>] [--root <checkout>]
                      [--independent-source <dir>] [--config-dir <dir>]
                      [--repo <path>] [--json]`;

export const INSTALL_HELP = `install (zheref/nen#298): makes, re-points or reports the host's FIRST-PARTY
install of a plugin from the checkout --root names, on one surface:
  claude-code  a link at <config>/skills/<name> (loaded in place as
               <name>@skills-dir); a prior <name>@<marketplace> install from
               the checkout's own marketplace (.claude-plugin/marketplace.json
               'name') is handed over -- claude plugin uninstall, then ONE
               claude plugin marketplace remove for the known entry -- and
               claude plugin list --json is read back. The SECOND remove
               that clears a settings.json declaration is an action owed,
               never run here.
  codex        the checkout added as its marketplace (codex plugin
               marketplace add), then codex plugin add <name>@<marketplace>;
               codex plugin list is read back, its version compared against
               .codex-plugin/plugin.json, else .claude-plugin/plugin.json.
  antigravity  a link at <config>/config/plugins/<name> to <root>/<surface-dir>
               (the checkout's generated Antigravity plugin; --surface-dir is
               REQUIRED here); the linked plugin.json and agy plugin validate
               are read back.
A LINK TO ANY ROOT OF THE SAME PLUGIN COUNTS AS OURS; ONLY A LINK IS EVER
REPLACED, NEVER DATA: a destination is written only when absent or such a link
(re-inspected right before the write, and lstat'ed once more right before a
re-point's rename -- a same-user race in the microseconds after that last
check is NOT defended); a real directory, a file, a dangling link or a link
elsewhere is refused (exit 3) and left as it was -- as is an installed copy
from another marketplace (Claude Code or Codex), a Codex marketplace of the
same name at another root, and a known Claude Code marketplace of the same name
whose recorded source is not this checkout. A known marketplace is removed only
when it is this checkout's, this plugin is installed from it, and nothing else
is; when other plugins are, removing it is an action owed, naming them. A
failed re-point on Windows tries to put the previous link back; if that also
fails, the report says the destination is absent. NEVER EDITS A SETTINGS FILE: a settings.json declaration
that would bring a marketplace copy back on the next reload is reported as an
action owed, with the command that clears it (exit 4). Every precondition is
read before anything is written; every write is previewed by --dry-run and
read back after it is made.
  --root <checkout>   REQUIRED for install: a directory whose regular
                      .claude-plugin/plugin.json names --plugin, the toplevel
                      of its own git checkout, never under plugins/cache/,
                      never inside any surface's own directory (real paths),
                      and never a marketplace's installLocation.
  --config-dir <dir>  the surface's own directory: claude-code
                      \$CLAUDE_CONFIG_DIR else ~/.claude; codex \$CODEX_HOME
                      else ~/.codex; antigravity \$GEMINI_CONFIG_DIR else
                      ~/.gemini. The surface CLI is run with the same one.
  --surface-dir <dir> antigravity: the checkout-relative directory holding the
                      generated plugin (a plugin.json naming --plugin).
Every suggested command and every 'would run:' line is quoted token by token
for a POSIX shell; a marketplace name outside [A-Za-z0-9._-], or starting with
'-', is refused (exit 2). The config directory is passed to the CLI only when
--config-dir or the surface's variable named it.
install exits: 0 ok (installed and read back, or a complete --dry-run plan);
1 failed (a CLI step or the read-back, its last line quoted); 2 usage or
wiring (a file that cannot be trusted, a bad --root); 3 refused (not ours to
replace); 4 owed (in place, a settings change the caller owes); 5 the surface's
CLI could not be started.

status: what the surface SERVES for --plugin, read back from claude plugin
list --json, codex plugin list, or the linked plugin.json -- with --root, also
whether that is this checkout at its version. With --trees (claude-code), the
copies Claude Code SERVES are judged as 'mirror check --plugin' judges them:
a marketplace copy only when settings.json enabledPlugins enables it, the
skills-directory copy unless enabledPlugins disables it or an enabled
marketplace copy takes precedence; --source defaults to --root.
status exits: 0 serving; 1 mismatch (not --root, another version, a shadowing
copy, more than one enabled Codex row, or agy plugin validate refused it); 2
wiring; 3 not installed; 5 the surface's CLI could not be started (nothing is
known to be served, or agy could not validate). With --trees the exit is the
judgement's ('mirror check --plugin''s six verdicts) -- or, when the status
itself is wiring or tool missing, the worse of the two in the order
2 > 1 > 5 > 4 > 0 > 3.`;

function value(context: CommandContext, flag: string): string | null {
  const raw = context.args.values[flag];
  if (raw === undefined) return null;
  if (raw.trim() === "") throw new VerbUsageError(`--${flag} was given an empty value. Omit it entirely, or give one.`);
  // F6: a directory this verb links into, or hands a CLI, carries no control character.
  if (flag === "config-dir" && /[\x00-\x1f\x7f-\x9f]/.test(raw)) throw new VerbUsageError(`--config-dir carries a control character.`);
  return raw;
}

function requiredValue(context: CommandContext, flag: string, why: string): string {
  const raw = value(context, flag);
  if (raw === null) throw new VerbUsageError(`--${flag} is required. ${why}`);
  return raw;
}

/** Every family flag this verb does not read, refused by name. */
function refuseOthers(verb: string, context: CommandContext, spec: { readonly values: readonly string[]; readonly booleans: readonly string[] }): void {
  const mine = new Set<string>([...spec.values, ...spec.booleans]);
  const foreign = [...Object.keys(context.args.values), ...context.args.booleans].filter((flag): boolean => !mine.has(flag) && flag !== "repo" && flag !== "json" && flag !== "help");
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    `--${[...new Set(foreign)].sort().join(", --")} ${foreign.length === 1 ? "is" : "are"} not read by 'surface ${verb}'. A flag accepted and ignored is worse than one refused.`,
  );
}

function readSurface(context: CommandContext): InstallSurface {
  const name = requiredValue(context, "surface", `It names the surface: ${INSTALL_SURFACES.join(", ")}.`);
  if (!(INSTALL_SURFACES as readonly string[]).includes(name)) {
    throw new VerbUsageError(`--surface '${safe(name)}' has no first-party install this verb knows. Known: ${INSTALL_SURFACES.join(", ")}.`);
  }
  return name as InstallSurface;
}

function servedLine(entry: Served): string {
  return plainLine(`${entry.id} ${entry.version ?? "(no version)"}${entry.status === null ? "" : ` [${entry.status}]`}${entry.enabled ? "" : " (not enabled)"} at ${entry.path ?? "(no path)"}`);
}

export function runInstall(context: CommandContext): number {
  refuseOthers("install", context, INSTALL_FLAGS);
  const surface = readSurface(context);
  const plugin = validatePluginName(requiredValue(context, "plugin", "It names the plugin whose install is made."));
  const rootFlag = requiredValue(context, "root", "It names the checkout the surface is pointed at.");
  const surfaceDirFlag = value(context, "surface-dir");
  if (surface === "antigravity" && surfaceDirFlag === null) {
    throw new VerbUsageError("--surface-dir is required with --surface antigravity: it names the checkout-relative directory holding the generated Antigravity plugin. Which directory that is, is the plugin's own fact.");
  }
  if (surface !== "antigravity" && surfaceDirFlag !== null) {
    throw new VerbUsageError(`--surface-dir is read only with --surface antigravity; ${surface} links the checkout root itself.`);
  }
  const configFlag = value(context, "config-dir");
  const configDir = surfaceConfigDir(surface, configFlag, context.seams.env);
  const root = validateRoot(rootFlag, plugin, context.seams, forbiddenRoots(surface, configDir, context.seams.env));
  const surfaceDir = surfaceDirFlag === null ? null : validateSurfaceDir(root, surfaceDirFlag, plugin);
  const configExplicit = configDirIsExplicit(surface, configFlag, context.seams.env);
  const report = install({ surface, plugin, root, configDir, configExplicit, surfaceDir, dryRun: context.args.booleans.has("dry-run"), seams: context.seams });
  const exit = INSTALL_EXIT[report.verdict];
  emit(context.io, context.json, { contract: INSTALL_CONTRACT, ...report, exit }, installLines(report));
  return exit;
}

function installLines(report: InstallReport): string[] {
  return [
    `surface: ${report.surface} (plugin ${report.plugin})`,
    plainLine(`root: ${report.root}`),
    plainLine(`config: ${report.configDir}`),
    ...(report.destination === null ? [] : [plainLine(`destination: ${report.destination}${report.link === null ? "" : ` (${report.link})`}`)]),
    ...report.steps.map((step): string => plainLine(`${step.outcome === "failed" ? "FAILED " : step.outcome === "planned" ? (report.dryRun ? "would " : "not reached: ") : ""}${step.kind}: ${step.detail}`)),
    ...report.actions.flatMap((action): string[] => [plainLine(`action owed: ${action.what}`), ...(action.command === null ? [] : [plainLine(`  run: ${action.command}`)])]),
    plainLine(`read back: ${report.readBack.checked ? report.readBack.detail : `NOT CHECKED (${report.readBack.detail})`}`),
    ...(report.served === null ? [] : [`serves: ${servedLine(report.served)}`]),
    plainLine(`verdict: ${report.verdict} -- ${report.reason}`),
    `apply: ${report.apply}`,
  ];
}

/** status's --root: a directory holding the plugin's manifest. Read-only, so no git proof is asked for. */
function statusRoot(rootFlag: string, plugin: string): string {
  const id = identityOf(rootFlag);
  if (id === null) throw new VerbUsageError(`--root '${safe(rootFlag)}' cannot be resolved.`);
  const manifest = inspectManifest(id.real, plugin);
  if (manifest.state === "unreadable") throw new VerbUsageError(`--root '${safe(rootFlag)}' could not be inspected: ${manifest.reason}.`);
  if (manifest.state === "none") throw new VerbUsageError(`--root '${safe(rootFlag)}' is not a root of '${plugin}' (no regular .claude-plugin/plugin.json naming it).`);
  return id.real;
}

export function runStatus(context: CommandContext): number {
  refuseOthers("status", context, STATUS_FLAGS);
  const surface = readSurface(context);
  const plugin = validatePluginName(requiredValue(context, "plugin", "It names the plugin whose install is reported."));
  const rootFlag = value(context, "root");
  const root = rootFlag === null ? null : statusRoot(rootFlag, plugin);
  const surfaceDirFlag = value(context, "surface-dir");
  if (surface !== "antigravity" && surfaceDirFlag !== null) {
    throw new VerbUsageError(`--surface-dir is read only with --surface antigravity.`);
  }
  if (surface === "antigravity" && root !== null && surfaceDirFlag === null) {
    throw new VerbUsageError("--root with --surface antigravity needs --surface-dir: the link is compared against <root>/<surface-dir>, never guessed.");
  }
  const surfaceDir = surfaceDirFlag === null ? null : root === null ? validateRelative(surfaceDirFlag) : validateSurfaceDir(root, surfaceDirFlag, plugin);
  const judging = context.args.values["trees"] !== undefined;
  const judgeOnly = ["source", "independent-source"].filter((flag): boolean => context.args.values[flag] !== undefined);
  if (!judging && judgeOnly.length > 0) {
    throw new VerbUsageError(`--${judgeOnly.join(", --")} ${judgeOnly.length === 1 ? "is" : "are"} read only with --trees, which judges the served copies.`);
  }
  if (judging && surface !== "claude-code") {
    throw new VerbUsageError(`--trees judges a Claude Code plugin copy in its own layout; --surface ${surface} has none. Drop --trees.`);
  }
  const configFlag = value(context, "config-dir");
  const configDir = surfaceConfigDir(surface, configFlag, context.seams.env);
  const configExplicit = configDirIsExplicit(surface, configFlag, context.seams.env);
  let judgement: PluginCheckReport | null = null;
  if (judging) {
    const source = value(context, "source") ?? rootFlag;
    if (source === null) throw new VerbUsageError("--trees compares the served copies against a source: give --source <plugin root>, or --root.");
    const judge = readJudgeContext(context, plugin, source, configDir);
    judgement = checkRecordedCopies(judge, claudeSelector(configDir, plugin));
  }
  const report = status({ surface, plugin, root, configDir, configExplicit, surfaceDir, seams: context.seams });
  const exit = judgement === null ? STATUS_EXIT[report.verdict] : statusTreesExit(report, judgement);
  emit(
    context.io,
    context.json,
    {
      contract: STATUS_CONTRACT,
      ...report,
      exit,
      ...(judgement === null ? {} : { judgement: { ...judgement, exit: VERDICT_EXIT[judgement.verdict] } }),
    },
    statusLines(report, judgement),
  );
  return exit;
}

/**
 * The exit of `status --trees`: the judgement's, unless the status itself
 * could not read the surface (`wiring`, `tool missing`) -- then the WORSE of
 * the two, in `check --plugin`'s order 2 > 1 > 5 > 4 > 0 > 3, so an unread
 * surface is never hidden behind an identical copy.
 */
const EXIT_RANK: Readonly<Record<number, number>> = { 2: 5, 1: 4, 5: 3, 4: 2, 0: 1, 3: 0 };

export function statusTreesExit(report: Pick<StatusReport, "verdict">, judgement: Pick<PluginCheckReport, "verdict">): number {
  const judged = VERDICT_EXIT[judgement.verdict];
  if (report.verdict !== "wiring" && report.verdict !== "tool missing") return judged;
  const own = STATUS_EXIT[report.verdict];
  return (EXIT_RANK[own] ?? 0) > (EXIT_RANK[judged] ?? 0) ? own : judged;
}

function validateRelative(surfaceDir: string): string {
  if (/[\x00-\x1f\x7f-\x9f:]/.test(surfaceDir) || surfaceDir.startsWith("/") || surfaceDir.split(/[\\/]/).some((part): boolean => part === "" || part === "." || part === "..")) {
    throw new VerbUsageError(`--surface-dir entry '${safe(surfaceDir)}' is not a plain relative path inside the plugin root.`);
  }
  return surfaceDir.split(/[\\/]/).join("/");
}

function statusLines(report: StatusReport, judgement: PluginCheckReport | null): string[] {
  return [
    `surface: ${report.surface} (plugin ${report.plugin})`,
    ...(report.root === null ? [] : [plainLine(`root: ${report.root}`)]),
    plainLine(`config: ${report.configDir}`),
    ...(report.destination === null ? [] : [plainLine(`destination: ${report.destination} (${report.link ?? "?"})`)]),
    ...report.listed.map((entry): string => `${entry.enabled ? "serves" : "listed"}: ${servedLine(entry)}`),
    plainLine(`read back: ${report.readBack.checked ? report.readBack.detail : `NOT CHECKED (${report.readBack.detail})`}`),
    ...report.warnings.map((warning): string => plainLine(`warning: ${warning}`)),
    ...(judgement === null
      ? []
      : [
          `judged (the served copies only):`,
          ...judgement.copies.map((copy): string => plainLine(`  ${copy.verdict} -- ${copy.reason}`)),
          ...(judgement.skipped ?? []).map((skip): string => plainLine(`  skipped -- ${skip.label}: ${skip.reason}`)),
          `  judgement: ${judgement.verdict}`,
        ]),
    plainLine(`verdict: ${report.verdict} -- ${report.reason}`),
  ];
}

/** For the family's flag spec: every flag either verb reads. */
export const INSTALL_FAMILY_VALUES: readonly string[] = [...new Set([...INSTALL_FLAGS.values, ...STATUS_FLAGS.values])];
export const INSTALL_FAMILY_BOOLEANS: readonly string[] = [...INSTALL_FLAGS.booleans];
