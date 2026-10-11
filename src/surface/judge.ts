// src/surface/judge.ts -- the ONE place a plugin judgement's inputs are read
// off the command line and turned into ./plugin.ts's JudgeContext.
//
// TWO VERBS JUDGE A CLAUDE CODE PLUGIN COPY: `surface mirror check --plugin`
// (zheref/nen#339), which judges every copy the host has recorded, and
// `surface status --surface claude-code --trees` (zheref/nen#298), which
// judges only the copies the host SERVES. Both must refuse the same bad
// --source, the same typo'd tree and the same unrelated --independent-source,
// in the same words -- so the reading lives here once, rather than as a second
// copy in the verb that came later.

import { resolve } from "node:path";
import { VerbUsageError, type CommandContext } from "../cli/command.js";
import { commaList } from "../cli/comma.js";
import { GIT } from "../seam/exec.js";
import {
  assertTreesInSource,
  identityOf,
  inspectManifest,
  pluginManifest,
  safe,
  Unreadable,
  validateTrees,
  type JudgeContext,
} from "./plugin.js";

/** The git probes run with none of a hook's repository variables (N13 of zheref/nen#339). */
const GIT_PROBE_ENV: Readonly<Record<string, undefined>> = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };

/** One read-only git probe of the checkout at `cwd`: its code and the first line of stdout. */
export function gitProbe(context: CommandContext): JudgeContext["git"] {
  return (cwd, args) => {
    const result = context.seams.run(GIT, [...args], { cwd, env: GIT_PROBE_ENV });
    return { code: result.spawnFailed ? 127 : result.code, stdout: result.stdout.split("\n")[0]?.trim() ?? "" };
  };
}

/** An optional path flag: absent, or present and non-empty. */
function optional(context: CommandContext, flag: string): string | null {
  const value = context.args.values[flag];
  if (value === undefined) return null;
  if (value.trim() === "") throw new VerbUsageError(`--${flag} was given an empty value. Omit it entirely, or name the directory.`);
  return value;
}

/**
 * `--source`, `--trees` and `--independent-source` read and refused exactly as
 * `mirror check --plugin` refuses them, into a JudgeContext for `plugin`.
 * Throws VerbUsageError (or ./plugin.ts's PluginCheckError) for every refusal.
 */
export function readJudgeContext(context: CommandContext, plugin: string, sourceFlag: string, configDir: string): JudgeContext {
  const trees = validateTrees(commaList(context.args.values["trees"]));
  const sourceManifest = inspectManifest(sourceFlag, plugin);
  if (sourceManifest.state === "unreadable") {
    throw new VerbUsageError(`--source '${safe(sourceFlag)}' could not be inspected: ${sourceManifest.reason}.`);
  }
  if (sourceManifest.state === "none") {
    throw new VerbUsageError(`--source '${safe(sourceFlag)}' is not a root of '${plugin}' (no regular .claude-plugin/plugin.json naming it).`);
  }
  const sourceId = identityOf(sourceFlag);
  /* c8 ignore next 3 -- inspectManifest above already proved the directory is there */
  if (sourceId === null) {
    throw new VerbUsageError(`--source '${safe(sourceFlag)}' cannot be resolved.`);
  }
  // Every tree a real directory in the source, every segment lstat'ed (N1):
  // a typo'd tree would otherwise compare as empty on both sides and read identical.
  try {
    assertTreesInSource(sourceId.real, trees);
  } catch (error) {
    // A segment that could not be READ is no claim that the tree is missing:
    // each copy's judgement reports it as wiring, with the report printed.
    if (!(error instanceof Unreadable)) throw error;
  }
  const independent = optional(context, "independent-source");
  if (independent !== null && pluginManifest(independent, plugin) === null) {
    throw new VerbUsageError(`--independent-source '${safe(independent)}' is not a root of '${plugin}' (no regular .claude-plugin/plugin.json naming it).`);
  }
  return {
    plugin,
    trees,
    source: sourceId.real,
    sourceId,
    independentSource: independent,
    configDir,
    standIn: resolve(context.repoFlag ?? process.cwd()),
    git: gitProbe(context),
  };
}

/** A plugin name: letters, digits, '.', '_' and '-'; not all dots, not starting with '.' or '-', not ending in '.' (F3/F4). */
const PLUGIN_NAME = /^(?!\.+$)[A-Za-z0-9_][A-Za-z0-9._-]*(?<!\.)$/;

/** A name Windows reserves for a device, in any case: never a directory a link can be named. */
const WINDOWS_RESERVED = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

/**
 * `--plugin`, refused unless it is a plain plugin name -- an ALLOWLIST (F4):
 * letters, digits, '.', '_' and '-', not starting with '.' or '-', not ending
 * in '.', and not a Windows reserved device name. So no '@', '/', '\', ':',
 * space or control character can reach a path or an argument.
 */
export function validatePluginName(plugin: string): string {
  if (!PLUGIN_NAME.test(plugin) || WINDOWS_RESERVED.test(plugin)) {
    throw new VerbUsageError(
      `--plugin '${safe(plugin)}' is not a plugin name (letters, digits, '.', '_' and '-' only, starting with a letter, digit or '_', not ending in '.', and not a Windows reserved name such as CON or LPT1).`,
    );
  }
  return plugin;
}
