// src/surface/install.ts -- `nen surface install|status` (zheref/nen#298): a
// host's FIRST-PARTY install of a plugin, made, re-pointed or reported on each
// agent surface, from a checkout the caller names.
//
// WHAT "FIRST-PARTY" MEANS, per surface (each fact observed live and recorded
// by the first consumer, 2026-09-29; the surface CLIs' own behaviour, never a
// guess of this binary):
//
//   claude-code  a symlink at `<config>/skills/<plugin>` loads the checkout IN
//                PLACE as `<plugin>@skills-dir`. An installed marketplace copy
//                `<plugin>@<marketplace>` takes precedence over it, so a prior
//                one from the checkout's OWN marketplace is handed over:
//                `claude plugin uninstall`, then ONE `claude plugin marketplace
//                remove` for the known entry -- only when its recorded source
//                is this checkout, this plugin was installed from it, and no
//                other plugin is (removing it uninstalls them all). That remove does not clear a
//                settings.json declaration of the same marketplace; the SECOND
//                remove that would is never run here -- it is an action owed
//                (below). `claude plugin list --json` is the read-back.
//   codex        `codex plugin marketplace add <checkout>` reads the checkout's
//                `.claude-plugin/marketplace.json`; `codex plugin add
//                <plugin>@<marketplace>` installs from it; `codex plugin list`
//                is the read-back, its version compared against the manifest
//                Codex keys the slot on (`.codex-plugin/plugin.json`, else
//                `.claude-plugin/plugin.json`).
//   antigravity  a plugin folder at `<gemini>/config/plugins/<plugin>`
//                activates across all workspaces; a symlink into the checkout's
//                generated Antigravity plugin keeps it live (`agy plugin
//                install` COPIES, so it is never used), and the linked
//                `plugin.json` plus `agy plugin validate` are the read-back.
//
// NAMES ARE DATA. The plugin, the checkout, the marketplace (read from the
// checkout's own marketplace.json) and the directory holding the generated
// Antigravity plugin (`--surface-dir`) are the caller's; nothing here names
// any one plugin.
//
// THE OWNERSHIP RULE: A LINK TO ANY ROOT OF THE SAME PLUGIN COUNTS AS OURS;
// ONLY A LINK IS EVER REPLACED, NEVER DATA. A destination is written only when
// it is absent or a link to some root of the same plugin (for Antigravity, to
// that root's `--surface-dir`) -- whoever made that link. A real directory, a
// file, a dangling link or a link anywhere else is refused, named, and left
// exactly as it was, and the destination is inspected again right before the
// write, so one swapped in meanwhile is refused too. A marketplace install of the plugin from a marketplace the
// checkout does not publish is refused the same way, and so is a Codex
// marketplace of the same name pointed at another root.
//
// SETTINGS ARE NEVER EDITED. A declaration in Claude Code's `settings.json`
// that would bring a marketplace copy back on the next reload is reported as
// an ACTION the caller owes, with the command that clears it -- never written
// by this binary, and never run by it either (the maintainer's ruling on
// zheref/nen#298).
//
// EVERY TOOL OUTPUT IS READ WHOLE, IN TYPESCRIPT. The seam captures a child's
// complete stdout (../seam/exec.ts), so a 12,000-row `codex plugin list` is
// parsed to its end -- the shell this replaces died of SIGPIPE when an awk
// reader stopped early. A tool that could not be started, exited non-zero or
// was killed by a signal is reported as that, with its last line; nothing is
// swallowed into "not found".

import { randomBytes } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, sep } from "node:path";
import { lstatSync, mkdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmdirSync, statSync, symlinkSync, unlinkSync } from "node:fs";
import { VerbUsageError } from "../cli/command.js";
import { outputLines, redactRemoteCredentials, redactRemoteUrl, type Seams } from "../seam/exec.js";
import {
  classifyError,
  identityOf,
  inspectManifest,
  pluginManifest,
  readInstallRecord,
  resolveConfigDir,
  safe,
  sameIdentity,
  skillsDirKey,
  validateTrees,
  PluginCheckError,
  type CopySelector,
} from "./plugin.js";

export const INSTALL_CONTRACT = "nen.surface.install/v0.1";
export const STATUS_CONTRACT = "nen.surface.status/v0.1";

/** The surfaces a first-party install is known for. */
export const INSTALL_SURFACES = ["claude-code", "codex", "antigravity"] as const;
export type InstallSurface = (typeof INSTALL_SURFACES)[number];

/** Each surface's own CLI: a documented fact of the surface, like its skills path in ./rules.ts. */
export const SURFACE_CLI: Readonly<Record<InstallSurface, string>> = {
  "claude-code": "claude",
  codex: "codex",
  antigravity: "agy",
};

/** How a running session picks the change up, per surface (the first consumer's live record). */
export const APPLY_HINT: Readonly<Record<InstallSurface, string>> = {
  "claude-code": "type /reload-plugins in the running session, or open a new session",
  codex: "running sessions refresh after an external plugin upgrade; otherwise open a new session",
  antigravity: "open a new conversation",
};

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

/** `install`'s verdicts, each its own exit. A usage or wiring refusal is exit 2, on stderr. */
export type InstallVerdict = "ok" | "failed" | "refused" | "owed" | "tool missing";

export const INSTALL_EXIT: Readonly<Record<InstallVerdict, number>> = {
  ok: 0,
  failed: 1,
  refused: 3,
  owed: 4,
  "tool missing": 5,
};

/** `status`'s verdicts, each its own exit. */
export type StatusVerdict = "serving" | "mismatch" | "wiring" | "not installed" | "tool missing";

export const STATUS_EXIT: Readonly<Record<StatusVerdict, number>> = {
  serving: 0,
  mismatch: 1,
  wiring: 2,
  "not installed": 3,
  "tool missing": 5,
};

/** One thing the install did, or -- under --dry-run -- would do. */
export interface Step {
  readonly kind: "mkdir" | "link" | "re-point" | "run";
  readonly detail: string;
  /** True only once the step SUCCEEDED -- never for a planned or a failed one. */
  readonly done: boolean;
  /** `planned` (--dry-run), `ok`, or `failed`: a step that failed is shown as failed. */
  readonly outcome: "planned" | "ok" | "failed";
}

/** A step while it runs: its outcome is set once it is known. */
interface MutableStep {
  readonly kind: Step["kind"];
  readonly detail: string;
  done: boolean;
  outcome: Step["outcome"];
}

function settle(step: MutableStep, ok: boolean): void {
  step.done = ok;
  step.outcome = ok ? "ok" : "failed";
}

/** A change the caller owes, which this verb will not make (a settings declaration). */
export interface OwedAction {
  readonly what: string;
  /** The command that clears it, or null when there is none to name. */
  readonly command: string | null;
}

/** What a surface serves for the plugin, as the surface itself answered. */
export interface Served {
  readonly id: string;
  readonly version: string | null;
  readonly path: string | null;
  readonly enabled: boolean;
  readonly status: string | null;
}

/** Whether the read-back ran, and what it said. An unperformed read-back is never a clean one. */
export interface ReadBack {
  readonly checked: boolean;
  readonly detail: string;
}

export interface InstallReport {
  readonly surface: InstallSurface;
  readonly plugin: string;
  readonly root: string;
  readonly configDir: string;
  readonly dryRun: boolean;
  readonly destination: string | null;
  /** `linked`, `already linked`, `re-pointed`, or null where the surface takes no link (codex). */
  readonly link: string | null;
  /** The previous target of a re-pointed link. */
  readonly previous: string | null;
  readonly steps: readonly Step[];
  readonly actions: readonly OwedAction[];
  readonly readBack: ReadBack;
  readonly served: Served | null;
  readonly verdict: InstallVerdict;
  readonly reason: string;
  readonly apply: string;
}

// ---------------------------------------------------------------------------
// Small readers
// ---------------------------------------------------------------------------

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;
/** A marketplace name this verb will hand a CLI: no shell or flag meaning possible. */
const MARKETPLACE_NAME = /^(?!\.+$)[A-Za-z0-9_][A-Za-z0-9._-]*(?<!\.)$/;
const CONTROL_ALL = /[\x00-\x1f\x7f-\x9f]/g;

/** The last non-empty line of a tool's output, credentials redacted, control characters removed, capped at 200. */
export function lastLine(text: string): string {
  const lines = outputLines(text);
  const last = lines[lines.length - 1] ?? "(no output)";
  return last.replace(CONTROL_ALL, "").slice(0, 200);
}

/** A JSON object file: absent, read, or why it cannot be trusted. Only ENOENT is absence. */
export type JsonRead =
  | { readonly state: "absent" }
  | { readonly state: "read"; readonly value: Readonly<Record<string, unknown>> }
  | { readonly state: "bad"; readonly reason: string };

export function readJsonObject(path: string): JsonRead {
  const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "error";
  try {
    lstatSync(path);
  } catch (error) {
    if (classifyError(error) === "absent") return { state: "absent" };
    return { state: "bad", reason: `${safe(path)} could not be inspected (${code(error)})` };
  }
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    return { state: "bad", reason: `${safe(path)} is a link that does not resolve (${code(error)})` };
  }
  // Opened only when it is a regular file: a FIFO there must not hang the verb.
  if (!stats.isFile()) return { state: "bad", reason: `${safe(path)} is not a regular file` };
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return { state: "bad", reason: `${safe(path)} could not be read (${code(error)})` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return { state: "bad", reason: `${safe(path)} is not JSON` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { state: "bad", reason: `${safe(path)}'s top level is not an object` };
  }
  return { state: "read", value: parsed as Record<string, unknown> };
}

/** `record[key]` as an object, `{}` when absent; throws a reason when it is something else. */
function objectField(record: Readonly<Record<string, unknown>>, key: string, where: string): Readonly<Record<string, unknown>> {
  const value = record[key];
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new VerbUsageError(`${where}'s '${key}' is not an object: the verb cannot verify what it declares.`);
  }
  return value as Record<string, unknown>;
}

const own = (record: Readonly<Record<string, unknown>>, key: string): boolean => Object.prototype.hasOwnProperty.call(record, key);

/** A path's directory segments under `base`, each lstat'ed: a link anywhere on the way is not followed. */
function realDirectoryUnder(base: string, relative: string): boolean {
  let at = base;
  for (const part of relative.split("/")) {
    at = join(at, part);
    try {
      const stats = lstatSync(at);
      if (!stats.isDirectory()) return false;
    } catch {
      return false;
    }
  }
  return true;
}

/** A regular file reached with no link on the last step, parsed as a JSON object, or null. */
function regularJson(path: string): Readonly<Record<string, unknown>> | null {
  try {
    if (!lstatSync(path).isFile()) return null;
  } catch {
    return null;
  }
  const read = readJsonObject(path);
  return read.state === "read" ? read.value : null;
}

/** The checkout's marketplace name, from its own `.claude-plugin/marketplace.json`. */
export type MarketplaceRead =
  | { readonly state: "absent" }
  | { readonly state: "read"; readonly name: string; readonly listsPlugin: boolean | null }
  | { readonly state: "bad"; readonly reason: string };

export function readMarketplace(root: string, plugin: string): MarketplaceRead {
  const folder = join(root, ".claude-plugin");
  const path = join(folder, "marketplace.json");
  try {
    if (!lstatSync(folder).isDirectory()) return { state: "absent" };
    if (!lstatSync(path).isFile()) return { state: "bad", reason: `${safe(path)} is not a regular file` };
  } catch (error) {
    if (classifyError(error) === "absent") return { state: "absent" };
    return { state: "bad", reason: `${safe(path)} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  const read = readJsonObject(path);
  if (read.state === "absent") return { state: "absent" };
  if (read.state === "bad") return read;
  const name = read.value["name"];
  if (typeof name !== "string" || !MARKETPLACE_NAME.test(name)) {
    return {
      state: "bad",
      reason: `${safe(path)} carries no usable 'name' (only letters, digits, '.', '_' and '-', starting with a letter, digit or '_' and not ending in '.': it is passed to the surface's CLI as an argument)`,
    };
  }
  const plugins = read.value["plugins"];
  const listsPlugin = Array.isArray(plugins)
    ? plugins.some((entry): boolean => typeof entry === "object" && entry !== null && (entry as Record<string, unknown>)["name"] === plugin)
    : null;
  return { state: "read", name, listsPlugin };
}

/** A flat `plugin.json` (Antigravity's, at the plugin folder's root): its name and version, or null. */
function flatManifest(dir: string): { readonly name: string | null; readonly version: string | null } | null {
  const value = regularJson(join(dir, "plugin.json"));
  if (value === null) return null;
  return {
    name: typeof value["name"] === "string" ? value["name"] : null,
    version: typeof value["version"] === "string" ? value["version"] : null,
  };
}

/** The manifest Codex keys its plugin slot on: the `.codex-plugin` overlay, else the Claude manifest. */
export function codexManifest(root: string, plugin: string): { readonly path: string; readonly version: string } {
  const overlayDir = join(root, ".codex-plugin");
  let overlay = false;
  try {
    overlay = lstatSync(overlayDir).isDirectory() && lstatSync(join(overlayDir, "plugin.json")).isFile();
  } catch {
    overlay = false;
  }
  if (overlay) {
    const value = regularJson(join(overlayDir, "plugin.json"));
    const version = value === null ? null : value["version"];
    if (typeof version !== "string" || version === "") {
      throw new VerbUsageError(`${safe(join(overlayDir, "plugin.json"))} has no readable 'version': Codex keys its slot on it, so the read-back has nothing to compare.`);
    }
    return { path: ".codex-plugin/plugin.json", version };
  }
  const version = pluginManifest(root, plugin)?.version ?? null;
  if (version === null || version === "") {
    throw new VerbUsageError(`${safe(join(root, ".claude-plugin", "plugin.json"))} has no readable 'version' (and there is no .codex-plugin/plugin.json): the read-back has nothing to compare.`);
  }
  return { path: ".claude-plugin/plugin.json", version };
}

// ---------------------------------------------------------------------------
// Tool output, parsed whole
// ---------------------------------------------------------------------------

/** One entry of `claude plugin list --json`. */
export interface ClaudeListEntry {
  readonly id: string;
  readonly version: string | null;
  readonly enabled: boolean | null;
  readonly installPath: string | null;
}

/** `claude plugin list --json`: an array of objects, each with a string `id`. Anything else is a reason. */
export function parseClaudeList(stdout: string): readonly ClaudeListEntry[] | string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout) as unknown;
  } catch {
    return "its output is not JSON";
  }
  if (!Array.isArray(parsed)) return "its output is not a JSON array";
  const entries: ClaudeListEntry[] = [];
  for (const [index, element] of (parsed as unknown[]).entries()) {
    if (typeof element !== "object" || element === null || Array.isArray(element)) return `element ${index} is not an object`;
    const record = element as Record<string, unknown>;
    if (typeof record["id"] !== "string") return `element ${index} carries no string 'id'`;
    entries.push({
      id: record["id"],
      version: typeof record["version"] === "string" ? record["version"] : null,
      enabled: typeof record["enabled"] === "boolean" ? record["enabled"] : null,
      installPath: typeof record["installPath"] === "string" ? record["installPath"] : null,
    });
  }
  return entries;
}

/** One row of `codex plugin marketplace list` (`MARKETPLACE  ROOT`). */
export interface CodexMarketplaceRow {
  readonly name: string;
  readonly root: string;
}

/** Every row, read to the end of the output: never an early stop (the SIGPIPE lesson). */
export function parseCodexMarketplaces(stdout: string): readonly CodexMarketplaceRow[] {
  const rows: CodexMarketplaceRow[] = [];
  stdout
    .replace(/\r\n/g, "\n")
    .split("\n")
    .forEach((line, index): void => {
      if (index === 0 && /^MARKETPLACE\s/.test(line)) return;
      const match = /^(\S+)\s+(\S.*?)\s*$/.exec(line);
      if (match !== null) rows.push({ name: match[1] as string, root: match[2] as string });
    });
  return rows;
}

/** One row of `codex plugin list`: `<plugin>@<marketplace>  <status>  <version>  <path>`. */
export interface CodexPluginRow {
  readonly id: string;
  readonly status: string;
  readonly version: string | null;
  readonly path: string | null;
}

export function parseCodexPlugins(stdout: string): readonly CodexPluginRow[] {
  const rows: CodexPluginRow[] = [];
  for (const line of stdout.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^(\S+@\S+)\s+(\S.*?)\s*$/.exec(line);
    if (match === null) continue;
    const id = match[1] as string;
    const rest = match[2] as string;
    // The columns are padded with two or more spaces; a status may itself
    // carry ", " ("installed, enabled").
    const columns = rest.split(/\s{2,}/);
    if (columns.length >= 2) {
      rows.push({ id, status: columns[0] as string, version: columns[1] as string, path: columns.length > 2 ? columns.slice(2).join("  ") : null });
      continue;
    }
    const paired = /^([A-Za-z]+, [A-Za-z]+)(?:\s+(\S+))?(?:\s+(\S.*))?$/.exec(rest);
    if (paired !== null) {
      rows.push({ id, status: paired[1] as string, version: paired[2] ?? null, path: paired[3] ?? null });
      continue;
    }
    const [status, version, ...path] = rest.split(/\s+/);
    rows.push({ id, status: status as string, version: version ?? null, path: path.length > 0 ? path.join(" ") : null });
  }
  return rows;
}

/** True for a Codex status meaning installed and enabled. */
export function codexEnabled(status: string): boolean {
  const words = status.toLowerCase().split(/,\s*/);
  return words.includes("installed") && words.includes("enabled");
}

/** `Installed plugin root: <path>` from `codex plugin add`, read to the end. */
export function codexInstalledRoot(stdout: string): string | null {
  let found: string | null = null;
  for (const line of stdout.replace(/\r\n/g, "\n").split("\n")) {
    const match = /^Installed plugin root: (.+)$/.exec(line);
    if (match !== null && found === null) found = (match[1] as string).trim();
  }
  return found;
}

// ---------------------------------------------------------------------------
// Tools, through the seam
// ---------------------------------------------------------------------------

export interface ToolResult {
  readonly ok: boolean;
  readonly spawnFailed: boolean;
  readonly stdout: string;
  /** The last line of its output (or why it stopped), for a refusal. */
  readonly last: string;
}

function callTool(seams: Seams, cli: string, args: readonly string[], env: Readonly<Record<string, string>>): ToolResult {
  const result = seams.run(cli, args, { env });
  const killed = result.signal !== undefined && result.signal !== null;
  const last = result.spawnFailed
    ? `${cli} could not be started (${lastLine(result.stderr)})`
    : killed
      ? `killed by ${result.signal}: ${lastLine(`${result.stdout}\n${result.stderr}`)}`
      : lastLine(`${result.stdout}\n${result.stderr}`);
  return { ok: !result.spawnFailed && !killed && result.code === 0, spawnFailed: result.spawnFailed, stdout: result.stdout, last };
}

/** The one way a flow stops early: a verdict and the sentence that explains it. */
class Stop extends Error {
  constructor(
    readonly verdict: InstallVerdict,
    reason: string,
  ) {
    super(reason);
    this.name = "Stop";
  }
}

// ---------------------------------------------------------------------------
// Directories
// ---------------------------------------------------------------------------

/** `$HOME` from the invocation's environment, else the OS's answer. */
function homeOf(env: Readonly<Record<string, string | undefined>>): string {
  const home = env["HOME"];
  return home !== undefined && home !== "" ? home : homedir();
}

/** The surface's config directory: `--config-dir`, else its environment variable, else its default under `$HOME`. */
export function surfaceConfigDir(surface: InstallSurface, flag: string | null, env: Readonly<Record<string, string | undefined>>): string {
  if (surface === "claude-code") return resolveConfigDir(flag, env, homeOf(env));
  if (flag !== null) return flag;
  const variable = surface === "codex" ? "CODEX_HOME" : "GEMINI_CONFIG_DIR";
  const fromEnv = env[variable];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(homeOf(env), surface === "codex" ? ".codex" : ".gemini");
}

/** True when `--config-dir` or the surface's own variable named the directory: only then is it passed on. */
export function configDirIsExplicit(surface: InstallSurface, flag: string | null, env: Readonly<Record<string, string | undefined>>): boolean {
  if (flag !== null) return true;
  const variable = surface === "claude-code" ? "CLAUDE_CONFIG_DIR" : surface === "codex" ? "CODEX_HOME" : "GEMINI_CONFIG_DIR";
  const value = env[variable];
  return value !== undefined && value !== "";
}

/**
 * The environment a surface CLI is run with. The directory is passed ONLY
 * when the caller named it (--config-dir or the surface's variable): the
 * default is the CLI's own, and setting it would be a second source for it.
 */
function toolEnv(surface: InstallSurface, configDir: string, explicit: boolean): Readonly<Record<string, string>> {
  if (!explicit) return {};
  if (surface === "claude-code") return { CLAUDE_CONFIG_DIR: configDir };
  if (surface === "codex") return { CODEX_HOME: configDir };
  return {};
}

/** A command line a human can paste: every token quoted for a POSIX shell. */
export function commandText(tokens: readonly string[]): string {
  return tokens.map(shellQuote).join(" ");
}

/** A suggested command: the config directory named exactly when the CLI is run with it. */
function suggest(surface: InstallSurface, configDir: string, explicit: boolean, tokens: readonly string[]): string {
  const command = commandText(tokens);
  if (surface !== "claude-code" || !explicit) return command;
  return `CLAUDE_CONFIG_DIR=${shellQuote(configDir)} ${command}`;
}

export function shellQuote(text: string): string {
  // A leading '=' is quoted too: zsh expands `=cmd` to a command's path.
  return /^[A-Za-z0-9_./:@=+,-]+$/.test(text) && !text.startsWith("=") ? text : `'${text.replace(/'/g, `'\\''`)}'`;
}

// ---------------------------------------------------------------------------
// The checkout
// ---------------------------------------------------------------------------

/** The git probe environment: no hook's repository answers for the checkout. */
const GIT_PROBE_ENV: Readonly<Record<string, undefined>> = { GIT_DIR: undefined, GIT_WORK_TREE: undefined, GIT_INDEX_FILE: undefined };

/**
 * `--root`, validated: a directory holding a regular `.claude-plugin/plugin.json`
 * naming the plugin, never under a `plugins/cache/` path (a copy an install
 * made, which the next update replaces), and the toplevel of its own git
 * checkout. Returns the real path. Every refusal is exit 2.
 */
export function validateRoot(rootFlag: string, plugin: string, seams: Seams, forbidden: ForbiddenRoots = { insideOf: [], equalTo: [] }): string {
  if (CONTROL.test(rootFlag)) throw new VerbUsageError("--root carries a control character.");
  const id = identityOf(rootFlag);
  let isDir = false;
  try {
    isDir = id !== null && statSync(id.real).isDirectory();
  } catch {
    isDir = false;
  }
  if (id === null || !isDir) throw new VerbUsageError(`--root '${safe(rootFlag)}' is not a directory.`);
  const manifest = inspectManifest(id.real, plugin);
  if (manifest.state === "unreadable") throw new VerbUsageError(`--root '${safe(rootFlag)}' could not be inspected: ${manifest.reason}.`);
  if (manifest.state === "none") {
    throw new VerbUsageError(`--root '${safe(rootFlag)}' is not a root of '${plugin}' (no regular .claude-plugin/plugin.json naming it).`);
  }
  // F2 (Feitan): a checkout inside a surface's OWN directory is something an
  // install made there -- a cached copy, a cloned marketplace -- never one the
  // caller controls. Real-path containment, never a pattern.
  for (const dir of forbidden.insideOf) {
    const realDir = realOrNull(dir);
    if (realDir !== null && contains(realDir, id.real)) {
      throw new VerbUsageError(
        `--root '${safe(id.real)}' lies inside ${safe(realDir)}, an agent surface's own directory: what is there an install made, and the next update replaces it. A first-party install points at a checkout the caller controls.`,
      );
    }
  }
  for (const location of forbidden.equalTo) {
    const realLocation = realOrNull(location);
    if (realLocation !== null && realLocation === id.real) {
      throw new VerbUsageError(`--root '${safe(id.real)}' is the installLocation of a marketplace Claude Code cloned (known_marketplaces.json): a copy it manages, never a checkout the caller controls.`);
    }
  }
  if (/(^|\/)plugins\/cache\//.test(id.real.split(sep).join("/"))) {
    throw new VerbUsageError(
      `--root '${safe(id.real)}' lies under a plugins/cache/ path: that is a copy an install made, which the next update replaces out from under a link. A first-party install points at a checkout the caller controls.`,
    );
  }
  const top = seams.run("git", ["rev-parse", "--show-toplevel"], { cwd: id.real, env: GIT_PROBE_ENV });
  if (top.spawnFailed) throw new VerbUsageError(`git could not be started to prove --root '${safe(id.real)}' is a checkout.`);
  const topPath = top.stdout.split("\n")[0]?.trim() ?? "";
  if (top.code !== 0 || topPath === "") {
    throw new VerbUsageError(`--root '${safe(id.real)}' is not a git checkout (git rev-parse --show-toplevel failed: ${lastLine(top.stderr)}). A first-party install points at a checkout the caller controls.`);
  }
  const topId = identityOf(topPath);
  if (topId === null || !sameIdentity(topId, id)) {
    throw new VerbUsageError(`--root '${safe(id.real)}' is not the toplevel of its git checkout (the toplevel is ${safe(topPath)}): point --root at the checkout root.`);
  }
  return id.real;
}

/** Directories a --root may not lie inside, and paths it may not equal (F2). */
export interface ForbiddenRoots {
  readonly insideOf: readonly string[];
  readonly equalTo: readonly string[];
}

function realOrNull(path: string): string | null {
  try {
    return realpathSync.native(path);
  } catch {
    return null;
  }
}

/** `child` is `parent` or below it, both real paths. */
function contains(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || !(rel === ".." || rel.startsWith(`..${sep}`) || rel.startsWith("../") || isAbsolute(rel));
}

/**
 * Every surface's own directory (the one this run names, and each surface's
 * default from the environment), and every `installLocation` Claude Code's
 * known_marketplaces.json records: the places a --root may not be (F2).
 */
export function forbiddenRoots(
  surface: InstallSurface,
  configDir: string,
  explicit: boolean,
  env: Readonly<Record<string, string | undefined>>,
): ForbiddenRoots {
  const dirs = new Set<string>([configDir, ...INSTALL_SURFACES.map((each): string => surfaceConfigDir(each, null, env))]);
  // Which known_marketplaces.json to consult: this run's own for Claude Code;
  // for the other surfaces, Claude Code's DEFAULT only when this run named no
  // directory of its own -- a sandboxed run (--config-dir, or the surface's
  // variable) never reads the real home.
  const claudeDir = surface === "claude-code" ? configDir : explicit ? null : surfaceConfigDir("claude-code", null, env);
  const known = claudeDir === null ? ({ state: "absent" } as const) : readJsonObject(join(claudeDir, "plugins", "known_marketplaces.json"));
  const locations: string[] = [];
  if (known.state === "read") {
    for (const entry of Object.values(known.value)) {
      if (typeof entry !== "object" || entry === null) continue;
      // A DIRECTORY-source marketplace is a checkout the caller controls --
      // Claude Code may record it as its own installLocation, and that is the
      // hand-over case, never a managed clone. Only a clone is refused.
      if (knownSource(entry).kind === "directory") continue;
      const location = (entry as Record<string, unknown>)["installLocation"];
      if (typeof location === "string" && location !== "") locations.push(location);
    }
  }
  return { insideOf: [...dirs], equalTo: locations };
}

/** `--surface-dir`: one plain relative path inside the checkout, a real directory there with a plugin.json naming the plugin. */
export function validateSurfaceDir(root: string, surfaceDir: string, plugin: string): string {
  let relative: string;
  try {
    relative = validateTrees([surfaceDir], "--surface-dir")[0] as string;
  } catch (error) {
    if (error instanceof PluginCheckError) throw new VerbUsageError(error.message);
    /* c8 ignore next -- validateTrees raises nothing else */
    throw error;
  }
  if (!realDirectoryUnder(root, relative)) {
    throw new VerbUsageError(`--surface-dir '${safe(relative)}' is not a real directory in ${safe(root)} (every segment is lstat'ed; a link on the way is refused).`);
  }
  const manifest = flatManifest(join(root, ...relative.split("/")));
  if (manifest === null || manifest.name !== plugin) {
    throw new VerbUsageError(`--surface-dir '${safe(relative)}' holds no regular plugin.json naming '${plugin}': the checkout carries no generated Antigravity plugin there.`);
  }
  return relative;
}

// ---------------------------------------------------------------------------
// The destination link
// ---------------------------------------------------------------------------

export type LinkState =
  | { readonly kind: "absent" }
  | {
      readonly kind: "link";
      readonly raw: string;
      readonly real: string | null;
      readonly owner: string | null;
      /** The link's own lstat identity, so a swap between plan and write is seen. */
      readonly dev: number;
      readonly ino: number;
    }
  | { readonly kind: "directory" }
  | { readonly kind: "file" }
  | { readonly kind: "other" }
  | { readonly kind: "unreadable"; readonly reason: string };

/** `owner(real)`: the plugin root a link target belongs to, or null when the target is not ours. */
type Owner = (real: string) => string | null;

export function inspectDestination(dest: string, owner: Owner): LinkState {
  let stats;
  try {
    stats = lstatSync(dest);
  } catch (error) {
    if (classifyError(error) === "absent") return { kind: "absent" };
    return { kind: "unreadable", reason: `${safe(dest)} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  if (stats.isSymbolicLink()) {
    let raw: string;
    try {
      raw = readlinkSync(dest);
    } catch (error) {
      return { kind: "unreadable", reason: `the link ${safe(dest)} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
    let real: string | null = null;
    try {
      real = realpathSync.native(dest);
    } catch {
      real = null;
    }
    return { kind: "link", raw, real, owner: real === null ? null : owner(real), dev: stats.dev, ino: stats.ino };
  }
  if (stats.isDirectory()) return { kind: "directory" };
  if (stats.isFile()) return { kind: "file" };
  return { kind: "other" };
}

/** A sentence for a destination that is not ours. */
export function describeForeign(state: LinkState, plugin: string): string {
  switch (state.kind) {
    case "link":
      return state.real === null
        ? `a symlink to '${safe(state.raw)}' that does not resolve (dangling or looping)`
        : `a symlink to '${safe(state.raw)}' (resolving to ${safe(state.real)}), which is no root of '${plugin}'`;
    case "directory":
      return "a real directory";
    case "file":
      return "a file";
    case "other":
      return "neither a link, a directory nor a file";
    /* c8 ignore next 4 -- absent, unreadable and ours never reach a refusal */
    case "absent":
      return "absent";
    case "unreadable":
      return state.reason;
  }
}

function claudeOwner(plugin: string): Owner {
  return (real) => (inspectManifest(real, plugin).state === "plugin" ? real : null);
}

/** Antigravity: the link is ours when it lands on `<a root of the plugin>/<surfaceDir>`. */
function antigravityOwner(plugin: string, surfaceDir: string): Owner {
  const suffix = `${sep}${surfaceDir.split("/").join(sep)}`;
  return (real) => {
    if (!real.endsWith(suffix)) return null;
    const base = real.slice(0, real.length - suffix.length);
    return base !== "" && inspectManifest(base, plugin).state === "plugin" ? real : null;
  };
}

function linkType(platform: NodeJS.Platform): "junction" | "dir" {
  return platform === "win32" ? "junction" : "dir";
}

/**
 * The filesystem writes a link takes, injectable so a test can make one fail
 * -- the Windows fallback below is otherwise unreachable on a POSIX host.
 */
export interface LinkOps {
  readonly symlink: (target: string, path: string, type: "junction" | "dir") => void;
  readonly rename: (from: string, to: string) => void;
  readonly unlink: (path: string) => void;
  readonly rmdir: (path: string) => void;
}

export const FS_LINK_OPS: LinkOps = {
  symlink: (target, path, type): void => symlinkSync(target, path, type),
  rename: (from, to): void => renameSync(from, to),
  unlink: (path): void => unlinkSync(path),
  rmdir: (path): void => rmdirSync(path),
};

/** Remove a LINK (never data): a Windows junction is a directory entry, so it goes by rmdir, which is not recursive. */
function removeLink(path: string, platform: NodeJS.Platform, ops: LinkOps): void {
  if (platform === "win32") ops.rmdir(path);
  else ops.unlink(path);
}

const code = (error: unknown): string => (error as NodeJS.ErrnoException).code ?? "error";

/** Create the link at an absent `dest`. Throws Stop on a write that failed. */
function createLink(dest: string, target: string, platform: NodeJS.Platform, ops: LinkOps): void {
  try {
    ops.symlink(target, dest, linkType(platform));
  } catch (error) {
    // Something took the path between the re-check and this write: not ours,
    // and nothing of ours was written there.
    if (code(error) === "EEXIST") throw new Stop("refused", `${safe(dest)} appeared after it was inspected (EEXIST): refusing to replace it; nothing was written`);
    throw new Stop("failed", `could not create the link ${safe(dest)} (${code(error)})`);
  }
}

/** How many fresh temporary names are tried before a re-point gives up. */
const TEMPORARY_ATTEMPTS = 8;

/**
 * Re-point the link at `dest`: a fresh link beside it, renamed over it, so the
 * destination is never absent and the old link is replaced as an entry, never
 * followed. The temporary is `.<name>.nen-relink-<pid>-<random>`, created by
 * the symlink call itself -- EEXIST means another name, so there is never a
 * leftover to judge or remove (F5). The destination is lstat'ed once more
 * immediately before the rename; a same-user race in the microseconds after
 * that is NOT defended, and the help says so.
 */
function repointLink(dest: string, target: string, seen: Extract<LinkState, { kind: "link" }>, platform: NodeJS.Platform, ops: LinkOps): void {
  let temporary: string | null = null;
  for (let attempt = 0; attempt < TEMPORARY_ATTEMPTS && temporary === null; attempt += 1) {
    const candidate = join(dirname(dest), `.${basename(dest)}.nen-relink-${process.pid}-${randomBytes(6).toString("hex")}`);
    try {
      ops.symlink(target, candidate, linkType(platform));
      temporary = candidate;
    } catch (error) {
      if (code(error) !== "EEXIST") throw new Stop("failed", `could not create the link ${safe(candidate)} (${code(error)})`);
    }
  }
  if (temporary === null) throw new Stop("failed", `could not find a free temporary name beside ${safe(dest)} in ${TEMPORARY_ATTEMPTS} attempts`);
  const made = temporary;
  /** The temporary is ours: removed on every failure, so none is left behind. */
  const dropTemporary = (): void => {
    try {
      removeLink(made, platform, ops);
    } catch {
      /* already gone, or not removable: named by nothing, harmless */
    }
  };
  // Once more, immediately before the rename: still the very entry planned against.
  let last;
  try {
    last = lstatSync(dest);
  } catch {
    last = undefined;
  }
  if (last === undefined || !last.isSymbolicLink() || last.dev !== seen.dev || last.ino !== seen.ino) {
    dropTemporary();
    throw new Stop("refused", `${safe(dest)} changed immediately before the rename: refusing to replace it`);
  }
  try {
    ops.rename(made, dest);
  } catch (error) {
    if (platform !== "win32") {
      dropTemporary();
      throw new Stop("failed", `could not re-point ${safe(dest)} (${code(error)}); the previous link is left in place`);
    }
    // Windows will not rename over a junction: the old junction -- a link,
    // never data (rmdir is not recursive) -- goes first, then the rename.
    try {
      ops.rmdir(dest);
    } catch (second) {
      dropTemporary();
      throw new Stop("failed", `could not re-point ${safe(dest)} (${code(second)}); the previous link is left in place`);
    }
    try {
      ops.rename(made, dest);
    } catch (third) {
      // The old junction is gone and the new one did not land: TRY to put the
      // previous link back, with the target text it carried (N3), and read
      // that back before saying it was restored.
      dropTemporary();
      const previous = seen.raw !== "" ? seen.raw : (seen.real ?? "");
      let restored = false;
      try {
        ops.symlink(previous, dest, linkType(platform));
        restored = lstatSync(dest).isSymbolicLink() && readlinkSync(dest) === previous;
      } catch {
        restored = false;
      }
      throw new Stop(
        "failed",
        `could not re-point ${safe(dest)} (${code(third)}); ${restored ? `the previous link to ${safe(previous)} was put back` : `putting the previous link to ${safe(previous)} back also failed -- ${safe(dest)} is absent`}`,
      );
    }
  }
}

/** After a write: `dest` is a link and resolves to `target`. Anything else is a write that did not take: failed. */
function readBackLink(dest: string, target: string): void {
  let isLink = false;
  try {
    isLink = lstatSync(dest).isSymbolicLink();
  } catch {
    isLink = false;
  }
  if (!isLink) throw new Stop("failed", `${safe(dest)} is not a symlink after writing it`);
  const destId = identityOf(dest);
  const targetId = identityOf(target);
  if (destId === null || targetId === null || !sameIdentity(destId, targetId)) {
    throw new Stop("failed", `${safe(dest)} does not resolve to ${safe(target)} after writing it (it resolves to ${destId === null ? "nothing" : safe(destId.real)})`);
  }
}

/** One link to `target` at `dest`, by the ownership rule: made, already there, re-pointed -- or refused before anything is written. */
interface LinkPlan {
  readonly kind: "link" | "already" | "re-point";
  readonly previous: string | null;
  /** What the destination was when planned: re-checked right before the write. */
  readonly seen: LinkState;
}

function planLink(dest: string, target: string, state: LinkState, plugin: string): LinkPlan {
  if (state.kind === "unreadable") throw new VerbUsageError(`${state.reason}: the destination cannot be judged, so nothing is written.`);
  if (state.kind === "absent") return { kind: "link", previous: null, seen: state };
  if (state.kind === "link" && state.owner !== null && state.real !== null) {
    const targetId = identityOf(target);
    const currentId = identityOf(state.real);
    if (targetId !== null && currentId !== null && sameIdentity(targetId, currentId)) return { kind: "already", previous: null, seen: state };
    return { kind: "re-point", previous: state.real, seen: state };
  }
  throw new Stop("refused", `${safe(dest)} is ${describeForeign(state, plugin)}: refusing to replace it -- a first-party install never discards what it did not make`);
}

/** True when `now` is still exactly what the plan saw: absent, or the same link entry with the same target. */
function unchanged(seen: LinkState, now: LinkState): boolean {
  if (seen.kind === "absent") return now.kind === "absent";
  return seen.kind === "link" && now.kind === "link" && seen.dev === now.dev && seen.ino === now.ino && seen.raw === now.raw;
}

/** Carry out a link plan (or record it under --dry-run), reading the result back. */
function applyLink(dest: string, target: string, plan: LinkPlan, draft: Draft, inputs: InstallInputs, owner: Owner): void {
  if (plan.kind === "already") {
    draft.link = "already linked";
    return;
  }
  const mkdir = plan.kind === "link" ? draft.addStep("mkdir", dirname(dest)) : null;
  const link =
    plan.kind === "link" ? draft.addStep("link", `${dest} -> ${target}`) : draft.addStep("re-point", `${dest} -> ${target} (was ${plan.previous ?? "?"})`);
  draft.link = plan.kind === "link" ? "linked" : "re-pointed";
  draft.previous = plan.previous;
  if (inputs.dryRun) return;
  const platform = inputs.seams.platform;
  const ops: LinkOps = { ...FS_LINK_OPS, ...inputs.hooks?.linkOps };
  if (mkdir !== null) {
    try {
      mkdirSync(dirname(dest), { recursive: true });
      settle(mkdir, true);
    } catch (error) {
      settle(mkdir, false);
      throw new Stop("failed", `could not create ${safe(dirname(dest))} (${code(error)})`);
    }
  }
  inputs.hooks?.beforePlace?.();
  // CHECKED AGAIN RIGHT BEFORE THE WRITE: what was planned against is still
  // what is there -- absent, or the very link entry seen, with the same target.
  // Anything else (a file dropped in, a link swapped) is not ours: refused.
  const now = inspectDestination(dest, owner);
  if (!unchanged(plan.seen, now)) {
    settle(link, false);
    throw new Stop("refused", `${safe(dest)} changed after it was inspected (it is now ${describeLink(now, inputs.plugin)}): refusing to replace it`);
  }
  try {
    if (plan.kind === "link") createLink(dest, target, platform, ops);
    else {
      // A re-point is only ever planned from a link of ours (planLink).
      if (plan.seen.kind !== "link") throw new Error("internal: a re-point planned from something other than a link");
      repointLink(dest, target, plan.seen, platform, ops);
    }
    readBackLink(dest, target);
  } catch (error) {
    settle(link, false);
    throw error;
  }
  settle(link, true);
}

// ---------------------------------------------------------------------------
// install
// ---------------------------------------------------------------------------

export interface InstallInputs {
  readonly surface: InstallSurface;
  readonly plugin: string;
  /** The validated real path of --root. */
  readonly root: string;
  readonly configDir: string;
  /** --surface-dir, validated (antigravity only). */
  readonly surfaceDir: string | null;
  readonly dryRun: boolean;
  readonly seams: Seams;
  /** True when --config-dir or the surface's variable named configDir: only then is it passed to the CLI. */
  readonly configExplicit: boolean;
  /** Test seams: a moment between the plan and the write, and the link writes themselves. */
  readonly hooks?: {
    readonly beforePlace?: () => void;
    readonly linkOps?: Partial<LinkOps>;
  };
}

/** A read-back problem, and -- where an owed settings change accounts for it -- the install key that change is about. */
interface Problem {
  readonly text: string;
  readonly explainedBy: string | null;
}

interface Draft {
  destination: string | null;
  link: string | null;
  previous: string | null;
  steps: MutableStep[];
  actions: OwedAction[];
  /** The install keys the owed actions are about (an action explains a problem with the same key). */
  actionKeys: Set<string>;
  readBack: ReadBack;
  served: Served | null;
  problems: Problem[];
  /** Set when the surface's CLI could not be started and the install went ahead without it. */
  missing: string | null;
  addStep(kind: Step["kind"], detail: string): MutableStep;
}

function newDraft(destination: string | null): Draft {
  const steps: MutableStep[] = [];
  return {
    destination,
    link: null,
    previous: null,
    steps,
    actions: [],
    actionKeys: new Set<string>(),
    readBack: { checked: false, detail: "not reached" },
    served: null,
    problems: [],
    missing: null,
    addStep(kind, detail): MutableStep {
      const added: MutableStep = { kind, detail, done: false, outcome: "planned" };
      steps.push(added);
      return added;
    },
  };
}

function problem(draft: Draft, text: string, explainedBy: string | null = null): void {
  draft.problems.push({ text, explainedBy });
}

/** Run one tool step, recording it; a step that could not run or failed stops the flow. */
function step(draft: Draft, inputs: InstallInputs, args: readonly string[]): ToolResult {
  const cli = SURFACE_CLI[inputs.surface];
  const line = commandText([cli, ...args]);
  const recorded = draft.addStep("run", line);
  if (inputs.dryRun) return { ok: true, spawnFailed: false, stdout: "", last: "" };
  const result = callTool(inputs.seams, cli, args, toolEnv(inputs.surface, inputs.configDir, inputs.configExplicit));
  settle(recorded, result.ok);
  if (result.spawnFailed) throw new Stop("tool missing", result.last);
  if (!result.ok) throw new Stop("failed", `${line} failed: ${result.last}`);
  return result;
}

/** A read the verb needs even under --dry-run (it changes nothing): run, or stop on a tool that is missing or failed. */
function read(inputs: InstallInputs, args: readonly string[]): ToolResult {
  const cli = SURFACE_CLI[inputs.surface];
  const result = callTool(inputs.seams, cli, args, toolEnv(inputs.surface, inputs.configDir, inputs.configExplicit));
  if (result.spawnFailed) throw new Stop("tool missing", result.last);
  if (!result.ok) throw new Stop("failed", `${commandText([cli, ...args])} failed: ${result.last}`);
  return result;
}

export function install(inputs: InstallInputs): InstallReport {
  const destination =
    inputs.surface === "claude-code"
      ? join(inputs.configDir, "skills", inputs.plugin)
      : inputs.surface === "antigravity"
        ? join(inputs.configDir, "config", "plugins", inputs.plugin)
        : null;
  const draft = newDraft(destination);
  let verdict: InstallVerdict;
  let reason: string;
  try {
    if (inputs.surface === "claude-code") installClaudeCode(inputs, draft);
    else if (inputs.surface === "codex") installCodex(inputs, draft);
    else installAntigravity(inputs, draft);
    // A read-back problem an owed settings change accounts for -- the link is
    // in place, and settings.json disables it -- is owed, not failed.
    const unexplained = draft.problems.filter((entry): boolean => entry.explainedBy === null || !draft.actionKeys.has(entry.explainedBy));
    if (unexplained.length > 0) {
      verdict = "failed";
      reason = unexplained.map((entry): string => entry.text).join("; ");
    } else if (draft.actions.length > 0) {
      verdict = "owed";
      const owedCount = draft.actions.length === 1 ? "one change is" : `${draft.actions.length} changes are`;
      reason =
        draft.problems.length === 0
          ? `the install is in place, and ${owedCount} owed that this verb never makes`
          : `the install is in place, and ${owedCount} owed that this verb never makes, which also account${draft.actions.length === 1 ? "s" : ""} for the read-back: ${draft.problems.map((entry): string => entry.text).join("; ")}`;
    } else if (draft.missing !== null) {
      verdict = "tool missing";
      reason = draft.missing;
    } else {
      verdict = "ok";
      reason = inputs.dryRun ? "the plan is complete; nothing was changed (--dry-run)" : "installed, and read back";
    }
  } catch (error) {
    if (!(error instanceof Stop)) throw error;
    verdict = error.verdict;
    reason = error.message;
  }
  return {
    surface: inputs.surface,
    plugin: inputs.plugin,
    root: inputs.root,
    configDir: inputs.configDir,
    dryRun: inputs.dryRun,
    destination: draft.destination,
    link: draft.link,
    previous: draft.previous,
    steps: draft.steps.map((entry): Step => ({ ...entry })),
    actions: draft.actions,
    readBack: draft.readBack,
    served: draft.served,
    verdict,
    reason,
    apply: APPLY_HINT[inputs.surface],
  };
}

/** What Claude Code's own files say about the plugin: read in full, refused (exit 2) when a file cannot be trusted. */
interface ClaudeState {
  readonly recordKeys: readonly string[];
  /** EVERY install key the record holds, any plugin: who else depends on a marketplace (F1). */
  readonly allRecordKeys: readonly string[];
  readonly enabled: Readonly<Record<string, unknown>>;
  readonly extraMarketplaces: Readonly<Record<string, unknown>>;
  readonly known: Readonly<Record<string, unknown>>;
}

function readClaudeState(configDir: string, plugin: string): ClaudeState {
  const record = readInstallRecord(configDir);
  if (record.state === "unreadable") {
    throw new VerbUsageError(`${safe(join(configDir, "plugins", "installed_plugins.json"))} cannot be trusted (${record.reason}): which copies are installed cannot be verified, so nothing is changed.`);
  }
  const recordKeys = record.state === "read" ? Object.keys(record.plugins).filter((key): boolean => key.startsWith(`${plugin}@`)) : [];
  const settingsPath = join(configDir, "settings.json");
  const settings = readJsonObject(settingsPath);
  if (settings.state === "bad") throw new VerbUsageError(`${settings.reason}: its enabledPlugins and extraKnownMarketplaces cannot be verified, so nothing is changed.`);
  const settingsValue = settings.state === "read" ? settings.value : {};
  const knownPath = join(configDir, "plugins", "known_marketplaces.json");
  const known = readJsonObject(knownPath);
  if (known.state === "bad") throw new VerbUsageError(`${known.reason}: which marketplaces are known cannot be verified, so nothing is changed.`);
  return {
    recordKeys,
    allRecordKeys: record.state === "read" ? Object.keys(record.plugins) : [],
    enabled: objectField(settingsValue, "enabledPlugins", safe(settingsPath)),
    extraMarketplaces: objectField(settingsValue, "extraKnownMarketplaces", safe(settingsPath)),
    known: known.state === "read" ? known.value : {},
  };
}

/** An owed action, and the install key it is about (a read-back problem with that key is accounted for). */
interface PendingAction {
  readonly action: OwedAction;
  readonly key: string | null;
}

/** The settings declarations still standing, as actions the caller owes. */
function claudeActions(state: ClaudeState, inputs: InstallInputs, marketplace: string | null): PendingAction[] {
  const actions: PendingAction[] = [];
  const settings = join(inputs.configDir, "settings.json");
  const say = (tokens: readonly string[]): string => suggest(inputs.surface, inputs.configDir, inputs.configExplicit, tokens);
  const skills = skillsDirKey(inputs.plugin);
  for (const [key, value] of Object.entries(state.enabled)) {
    if (!key.startsWith(`${inputs.plugin}@`) || key === skills || value !== true) continue;
    if (CONTROL.test(key)) {
      // F6: never a command built from a key carrying a control character.
      actions.push({
        key,
        action: {
          what: `${settings} enables '${safe(key)}' in enabledPlugins, a key carrying a control character: flagged, and no command is suggested for it -- clear it by hand`,
          command: null,
        },
      });
      continue;
    }
    actions.push({
      key,
      action: {
        what: `${settings} enables ${key} in enabledPlugins: an enabled marketplace copy takes precedence over skills/${inputs.plugin}, and one that is not cached is downloaded again on the next reload`,
        command: say(["claude", "plugin", "disable", key, "--scope", "user"]),
      },
    });
  }
  if (state.enabled[skills] === false) {
    actions.push({
      key: skills,
      action: {
        what: `${settings} disables ${skills} in enabledPlugins: the link is in place and will not be loaded`,
        command: say(["claude", "plugin", "enable", skills, "--scope", "user"]),
      },
    });
  }
  if (marketplace !== null && own(state.extraMarketplaces, marketplace)) {
    actions.push({
      key: null,
      action: {
        what: `${settings} declares extraKnownMarketplaces.${marketplace}: Claude Code clones a declared marketplace again on the next reload, and with it the copy that shadows skills/${inputs.plugin}. The hand-over's own 'claude plugin marketplace remove' clears only the known entry; a SECOND remove, run by you, clears this declaration (the first consumer's live record, 2026-09-29)`,
        command: say(["claude", "plugin", "marketplace", "remove", marketplace]),
      },
    });
  }
  return actions;
}

function owe(draft: Draft, pending: readonly PendingAction[]): void {
  for (const entry of pending) {
    draft.actions.push(entry.action);
    if (entry.key !== null) draft.actionKeys.add(entry.key);
  }
}

/** Claude Code's files read again AFTER a change: one that cannot be trusted now is a failed step, with the report. */
function reread(configDir: string, plugin: string): ClaudeState {
  try {
    return readClaudeState(configDir, plugin);
  } catch (error) {
    if (error instanceof VerbUsageError) throw new Stop("failed", `after the handover, ${error.message}`);
    /* c8 ignore next -- readClaudeState raises nothing else */
    throw error;
  }
}

/** A known marketplace's recorded source, as Claude Code writes it in known_marketplaces.json. */
type KnownSource =
  | { readonly kind: "directory"; readonly path: string }
  | { readonly kind: "git"; readonly url: string }
  | { readonly kind: "unknown"; readonly shape: string };

function knownSource(entry: unknown): KnownSource {
  const source = typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>)["source"] : undefined;
  if (typeof source !== "object" || source === null) return { kind: "unknown", shape: "no recorded source" };
  const fields = source as Record<string, unknown>;
  const kind = fields["source"];
  if (kind === "directory" && typeof fields["path"] === "string") return { kind: "directory", path: fields["path"] };
  if ((kind === "git" || kind === "url") && typeof fields["url"] === "string") return { kind: "git", url: fields["url"] };
  if (kind === "github" && typeof fields["repo"] === "string") return { kind: "git", url: `https://github.com/${fields["repo"]}` };
  return { kind: "unknown", shape: `a '${safe(String(kind))}' source` };
}

/**
 * A recorded source, for a human or a --json reason. A git source is shown
 * ONLY as its normalised `host/path` -- which carries no user info, so a
 * `user:token@` in the recorded URL never reaches any output (F-A).
 */
function describeSource(source: KnownSource): string {
  if (source.kind === "directory") return `the directory ${safe(redactRemoteCredentials(source.path))}`;
  if (source.kind === "git") {
    const shown = normalizeRemote(source.url);
    return shown === null ? "a git source that is not a remote URL" : `the git source ${safe(shown)}`;
  }
  return source.shape;
}

/**
 * A git remote as `host/path`, or null when it is not a remote at all (F-C).
 * Two shapes are read: an absolute URL `scheme://[user[:secret]@]host[:port]/path`
 * -- user info dropped, and `:NN` a port only here -- and scp syntax
 * `user@host:path`. Anything else (a relative or local path) is null and never
 * matches. Only the HOST is lower-cased; a trailing `/` and `.git` are dropped.
 */
export function normalizeRemote(url: string): string | null {
  // The userinfo is dropped by the ONE reading of where it ends (SEC-5,
  // zheref/nen#373): this regex's authority stops at the first '/', so a
  // secret carrying one ('oauth2:tok/en@host') used to survive into the
  // host/path that describeSource prints.
  const text = redactRemoteUrl(url.trim());
  let host: string;
  let path: string;
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/([^/]*)(\/.*)?$/i.exec(text);
  const scp = /^[^@/\s:]+@([^:/\s]+):(.+)$/.exec(text);
  if (absolute !== null) {
    const authority = absolute[1] as string;
    const at = authority.lastIndexOf("@");
    host = (at === -1 ? authority : authority.slice(at + 1)).replace(/:\d+$/, "");
    path = absolute[2] ?? "";
  } else if (scp !== null) {
    host = scp[1] as string;
    path = scp[2] as string;
  } else {
    return null;
  }
  path = path.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "");
  if (host === "" || path === "") return null;
  return `${host.toLowerCase()}/${path}`;
}

/** A root or path a surface CLI reported, for output: credentials in a URL redacted (F-A), control characters made safe. */
function shownRoot(text: string): string {
  return safe(redactRemoteCredentials(text));
}

/** True when a known marketplace's source IS this checkout: its directory, or its remote. */
function sourceIsCheckout(source: KnownSource, root: string, seams: Seams): boolean {
  if (source.kind === "directory") {
    const real = realOrNull(source.path);
    return real !== null && real === root;
  }
  if (source.kind === "git") {
    const remote = seams.run("git", ["remote", "get-url", "origin"], { cwd: root, env: GIT_PROBE_ENV });
    if (remote.spawnFailed || remote.code !== 0) return false;
    const mine = normalizeRemote(remote.stdout.split("\n")[0]?.trim() ?? "");
    const recorded = normalizeRemote(source.url);
    return mine !== null && recorded !== null && mine === recorded;
  }
  return false;
}

function installClaudeCode(inputs: InstallInputs, draft: Draft): void {
  const { plugin, root, configDir } = inputs;
  const dest = draft.destination as string;
  const env = toolEnv("claude-code", configDir, inputs.configExplicit);
  // EVERY PRECONDITION IS READ BEFORE ANYTHING IS WRITTEN: a file that cannot
  // be trusted, a shadow from a foreign marketplace, a handover the CLI is
  // missing for, or a destination that is not ours changes nothing at all.
  const market = readMarketplace(root, plugin);
  if (market.state === "bad") throw new VerbUsageError(`${market.reason}: the marketplace whose copy is handed over cannot be named.`);
  const marketplace = market.state === "read" ? market.name : null;
  const ours = marketplace === null ? null : `${plugin}@${marketplace}`;
  const state = readClaudeState(configDir, plugin);
  const foreign = state.recordKeys.filter((key): boolean => key !== ours && key !== skillsDirKey(plugin));
  if (foreign.length > 0) {
    throw new Stop(
      "refused",
      `${foreign.join(", ")} ${foreign.length === 1 ? "is" : "are"} installed from a marketplace this checkout does not publish (${marketplace ?? "it publishes none"}); an installed copy takes precedence over skills/${plugin}, and removing it is not this verb's to do`,
    );
  }
  const installed = ours !== null && state.recordKeys.includes(ours);
  // F1 (Feitan): a known marketplace of the same NAME is removed only when it
  // is this checkout's (by its recorded source), this plugin is installed from
  // it, and no other plugin is -- removing a marketplace uninstalls everything
  // installed from it.
  const known = marketplace !== null && own(state.known, marketplace);
  let removeMarketplace = false;
  const handover: PendingAction[] = [];
  if (known && marketplace !== null) {
    const source = knownSource(state.known[marketplace]);
    if (!sourceIsCheckout(source, root, inputs.seams)) {
      throw new Stop(
        "refused",
        `the known Claude Code marketplace '${marketplace}' comes from ${describeSource(source)}, not this checkout: a marketplace of the same name that is not ours is never removed, and installing beside it is refused`,
      );
    }
    const dependents = state.allRecordKeys.filter((key): boolean => key.endsWith(`@${marketplace}`) && key !== ours);
    if (dependents.length > 0) {
      handover.push({
        key: null,
        action: {
          what: `the '${marketplace}' marketplace is also the source of ${dependents.join(", ")}: removing it would uninstall ${dependents.length === 1 ? "that plugin" : "those plugins"}, so it is left known`,
          command: suggest(inputs.surface, configDir, inputs.configExplicit, ["claude", "plugin", "marketplace", "remove", marketplace]),
        },
      });
    } else if (installed) {
      removeMarketplace = true;
    }
  }
  const pending = [...handover, ...claudeActions(state, inputs, marketplace)];
  // PLAN, THEN PROBE. Planning only reads, so a destination that is not ours
  // is refused (exit 3) before a missing CLI is (exit 5); the re-check right
  // before the write (applyLink) covers whatever the probe's moment allowed.
  const owner = claudeOwner(plugin);
  const plan = planLink(dest, root, inspectDestination(dest, owner), plugin);
  // The CLI's presence is asked before anything is WRITTEN, read-only: a
  // handover it cannot perform must not leave a link behind for the
  // marketplace copy to keep shadowing.
  const probe = callTool(inputs.seams, "claude", ["--version"], env);
  const owed = installed || removeMarketplace || pending.length > 0;
  if (probe.spawnFailed && owed) {
    throw new Stop(
      "tool missing",
      `claude could not be started, and a handover is owed (${[installed ? `${ours} is installed` : "", removeMarketplace ? `the ${marketplace} marketplace is known` : "", pending.length > 0 ? "a change is owed" : ""].filter((part): boolean => part !== "").join(", ")}); nothing was changed`,
    );
  }
  if (!probe.spawnFailed && !probe.ok) throw new Stop("failed", `claude --version failed: ${probe.last}`);
  applyLink(dest, root, plan, draft, inputs, owner);

  if (probe.spawnFailed) {
    draft.missing = `claude could not be started: ${inputs.dryRun ? "the link is planned, and" : "the link is in place, but"} the read-back (claude plugin list --json) cannot be performed`;
    draft.readBack = { checked: false, detail: "claude could not be started" };
    return;
  }
  if (installed && ours !== null) {
    step(draft, inputs, ["plugin", "uninstall", ours]);
    if (!inputs.dryRun) {
      const after = reread(configDir, plugin);
      if (after.recordKeys.includes(ours)) throw new Stop("failed", `${ours} is still recorded in installed_plugins.json after claude plugin uninstall`);
      // F-B: judged AGAIN from the re-read, immediately before the remove --
      // a plugin installed from the marketplace meanwhile, or a source that
      // changed, leaves it known and the removal owed.
      if (removeMarketplace && marketplace !== null) {
        const nowDependents = after.allRecordKeys.filter((key): boolean => key.endsWith(`@${marketplace}`) && key !== ours);
        const stillOurs = own(after.known, marketplace) && sourceIsCheckout(knownSource(after.known[marketplace]), root, inputs.seams);
        if (nowDependents.length > 0 || !stillOurs) {
          removeMarketplace = false;
          handover.push({
            key: null,
            action: {
              what:
                nowDependents.length > 0
                  ? `the '${marketplace}' marketplace became the source of ${nowDependents.join(", ")} during the hand-over: removing it would uninstall ${nowDependents.length === 1 ? "that plugin" : "those plugins"}, so it is left known`
                  : `the '${marketplace}' marketplace's recorded source changed during the hand-over (or it is no longer known): it is not removed`,
              command: suggest(inputs.surface, configDir, inputs.configExplicit, ["claude", "plugin", "marketplace", "remove", marketplace]),
            },
          });
        }
      }
    }
  }
  // ONE remove, for the KNOWN entry: that is the hand-over. A settings.json
  // declaration of the same marketplace survives it, and the second remove
  // that would clear it is an action owed by the caller (claudeActions).
  if (removeMarketplace && marketplace !== null) {
    step(draft, inputs, ["plugin", "marketplace", "remove", marketplace]);
    if (!inputs.dryRun && own(reread(configDir, plugin).known, marketplace)) {
      throw new Stop("failed", `known_marketplaces.json still records ${marketplace} after claude plugin marketplace remove`);
    }
  }
  if (inputs.dryRun) {
    owe(draft, pending);
    draft.readBack = { checked: false, detail: "--dry-run: nothing to read back" };
    return;
  }
  // What the handover left standing in settings.json is owed by the caller.
  owe(draft, [...handover, ...claudeActions(reread(configDir, plugin), inputs, marketplace)]);
  const listed = read(inputs, ["plugin", "list", "--json"]);
  const entries = parseClaudeList(listed.stdout);
  if (typeof entries === "string") throw new Stop("failed", `claude plugin list --json could not be read: ${entries}`);
  const skillsKey = skillsDirKey(plugin);
  const skills = entries.find((entry): boolean => entry.id === skillsKey);
  const rootVersion = pluginManifest(root, plugin)?.version ?? null;
  if (skills !== undefined) {
    draft.served = { id: skills.id, version: skills.version, path: skills.installPath, enabled: skills.enabled === true, status: null };
  }
  const shadows = entries.filter((entry): boolean => entry.id.startsWith(`${plugin}@`) && entry.id !== skillsKey && entry.enabled === true);
  if (skills === undefined) {
    problem(draft, `claude plugin list --json has no ${skillsKey} entry after linking ${dest}`);
  } else {
    if (skills.enabled !== true) problem(draft, `claude plugin list --json shows ${skillsKey} not enabled after linking ${dest}`, skillsKey);
    const servedId = skills.installPath === null ? null : identityOf(skills.installPath);
    const rootId = identityOf(root);
    if (servedId === null || rootId === null || !sameIdentity(servedId, rootId)) {
      problem(draft, `${skillsKey} is served from ${safe(skills.installPath ?? "no installPath")}, which is not ${safe(root)}`);
    }
    if (rootVersion === null) problem(draft, `${safe(root)}'s plugin.json carries no version, so the served version cannot be compared`);
    else if (skills.version === null) problem(draft, `claude plugin list --json reports no version for ${skillsKey}`);
    else if (skills.version !== rootVersion) problem(draft, `${skillsKey} serves version ${skills.version}, but ${safe(root)}'s plugin.json says ${rootVersion}`);
  }
  for (const shadow of shadows) problem(draft, `claude plugin list --json still shows ${shadow.id} enabled: the shadow was not cleared`, shadow.id);
  draft.readBack = { checked: true, detail: skills === undefined ? "no skills-directory entry" : `${skills.id} ${skills.enabled === true ? "enabled" : "not enabled"}, version ${skills.version ?? "?"}` };
}

function installCodex(inputs: InstallInputs, draft: Draft): void {
  const { plugin, root } = inputs;
  const market = readMarketplace(root, plugin);
  if (market.state === "absent") {
    throw new VerbUsageError(`${safe(root)} carries no .claude-plugin/marketplace.json: Codex installs a plugin from the checkout's own marketplace, so there is nothing to add.`);
  }
  if (market.state === "bad") throw new VerbUsageError(`${market.reason}.`);
  if (market.listsPlugin === false) {
    throw new VerbUsageError(`${safe(join(root, ".claude-plugin", "marketplace.json"))} lists no plugin named '${plugin}': Codex would install nothing by that name.`);
  }
  const marketplace = market.name;
  const id = `${plugin}@${marketplace}`;
  const compare = codexManifest(root, plugin);
  const rootId = identityOf(root);

  // An installed copy of the plugin from ANOTHER marketplace is not this
  // verb's to replace or to sit beside: refused before anything is added.
  const before = parseCodexPlugins(read(inputs, ["plugin", "list"]).stdout).filter(
    (row): boolean => row.id.startsWith(`${plugin}@`) && row.id !== id && row.status.toLowerCase().split(/,\s*/).includes("installed"),
  );
  if (before.length > 0) {
    throw new Stop("refused", `${before.map((row): string => row.id).join(", ")} ${before.length === 1 ? "is" : "are"} installed from a marketplace this checkout does not publish (${marketplace}); removing it is not this verb's to do`);
  }

  const listed = read(inputs, ["plugin", "marketplace", "list"]);
  const row = parseCodexMarketplaces(listed.stdout).find((entry): boolean => entry.name === marketplace);
  if (row !== undefined) {
    const rowId = identityOf(row.root);
    if (rowId === null || rootId === null || !sameIdentity(rowId, rootId)) {
      throw new Stop("refused", `the Codex marketplace '${marketplace}' already points at ${shownRoot(row.root)}, not ${safe(root)}: it is not this verb's to override`);
    }
  } else {
    step(draft, inputs, ["plugin", "marketplace", "add", root]);
    if (!inputs.dryRun) {
      const again = read(inputs, ["plugin", "marketplace", "list"]);
      const added = parseCodexMarketplaces(again.stdout).find((entry): boolean => entry.name === marketplace);
      const addedId = added === undefined ? null : identityOf(added.root);
      if (addedId === null || rootId === null || !sameIdentity(addedId, rootId)) {
        throw new Stop("failed", `codex plugin marketplace list does not show '${marketplace}' at ${safe(root)} after adding it`);
      }
    }
  }
  const added = step(draft, inputs, ["plugin", "add", id]);
  if (inputs.dryRun) {
    draft.readBack = { checked: false, detail: "--dry-run: nothing to read back" };
    return;
  }
  const cachePath = codexInstalledRoot(added.stdout);
  const plugins = parseCodexPlugins(read(inputs, ["plugin", "list"]).stdout);
  const mine = plugins.find((entry): boolean => entry.id === id);
  if (mine === undefined) {
    problem(draft, `codex plugin list has no ${id} row after installing it`);
    draft.readBack = { checked: true, detail: `no ${id} row` };
    return;
  }
  draft.served = { id, version: mine.version, path: mine.path ?? cachePath, enabled: codexEnabled(mine.status), status: mine.status };
  draft.readBack = { checked: true, detail: `${id} ${mine.status} ${mine.version ?? "?"} (compared against ${compare.path})` };
  if (!codexEnabled(mine.status)) problem(draft, `codex plugin list shows ${id} '${mine.status}', expected installed and enabled`);
  if (mine.version === null) problem(draft, `codex plugin list reports no version for ${id}`);
  else if (mine.version !== compare.version) problem(draft, `codex plugin list shows ${id} at ${mine.version}, but ${compare.path} says ${compare.version}`);
}

function installAntigravity(inputs: InstallInputs, draft: Draft): void {
  const { plugin, root } = inputs;
  const surfaceDir = inputs.surfaceDir as string;
  const dest = draft.destination as string;
  const target = join(root, ...surfaceDir.split("/"));
  const owner = antigravityOwner(plugin, surfaceDir);
  const plan = planLink(dest, target, inspectDestination(dest, owner), plugin);
  applyLink(dest, target, plan, draft, inputs, owner);
  if (inputs.dryRun) {
    draft.readBack = { checked: false, detail: "--dry-run: nothing to read back" };
    return;
  }
  const manifest = flatManifest(dest);
  draft.served = { id: plugin, version: manifest?.version ?? null, path: dest, enabled: true, status: null };
  if (manifest?.version === null || manifest === null) problem(draft, `the linked ${safe(join(dest, "plugin.json"))} carries no version`);
  const validate = callTool(inputs.seams, "agy", ["plugin", "validate", dest], {});
  if (validate.spawnFailed) {
    // The accepted rule: an unperformed read-back is never a clean one.
    draft.missing = `agy could not be started: the link is in place and its plugin.json reads version ${manifest?.version ?? "?"}, but agy plugin validate was not performed`;
    draft.readBack = { checked: false, detail: "agy could not be started: agy plugin validate NOT CHECKED" };
    return;
  }
  if (!validate.ok) problem(draft, `agy plugin validate ${dest} failed: ${validate.last}`);
  draft.readBack = { checked: true, detail: `linked plugin.json version ${manifest?.version ?? "?"}; agy plugin validate ${validate.ok ? "ok" : "failed"}` };
}

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------

export interface StatusInputs {
  readonly surface: InstallSurface;
  readonly plugin: string;
  /** The validated real path of --root, or null: then nothing is compared against a checkout. */
  readonly root: string | null;
  readonly configDir: string;
  readonly surfaceDir: string | null;
  readonly seams: Seams;
  /** As InstallInputs': the directory is passed to the CLI only when the caller named it. */
  readonly configExplicit: boolean;
}

export interface StatusReport {
  readonly surface: InstallSurface;
  readonly plugin: string;
  readonly root: string | null;
  readonly configDir: string;
  readonly destination: string | null;
  /** The destination, described: `absent`, `linked to <path>`, `a real directory`, ... */
  readonly link: string | null;
  /** Every entry the surface lists for the plugin, enabled or not. */
  readonly listed: readonly Served[];
  /** The entries the surface serves: listed and enabled. */
  readonly served: readonly Served[];
  readonly readBack: ReadBack;
  readonly warnings: readonly string[];
  readonly verdict: StatusVerdict;
  readonly reason: string;
}

function describeLink(state: LinkState, plugin: string): string {
  if (state.kind === "absent") return "absent";
  if (state.kind === "unreadable") return state.reason;
  if (state.kind === "link" && state.owner !== null && state.real !== null) return `linked to ${state.real}`;
  return describeForeign(state, plugin);
}

/**
 * Which recorded copies Claude Code SERVES (zheref/nen#298, deferred from
 * #339): a marketplace copy when settings.json's enabledPlugins enables it; the
 * skills-directory copy unless enabledPlugins disables it or an enabled
 * marketplace copy takes precedence over it (the first consumer's live record,
 * 2026-09-29: "the name is already taken by an installed plugin, which takes
 * precedence").
 */
export function servedSelector(plugin: string, recordKeys: readonly string[], enabled: Readonly<Record<string, unknown>>): CopySelector {
  const skills = skillsDirKey(plugin);
  const winners = recordKeys.filter((key): boolean => key !== skills && enabled[key] === true);
  return (key) => {
    if (key === skills) {
      if (enabled[skills] === false) return "disabled in settings.json enabledPlugins";
      if (winners.length > 0) return `not loaded: ${winners.join(", ")} is enabled and takes precedence over a skills-directory copy`;
      return null;
    }
    return enabled[key] === true ? null : "not enabled in settings.json enabledPlugins";
  };
}

/** Claude Code's settings, for the served selector: refused (exit 2) when they cannot be trusted. */
export function claudeSelector(configDir: string, plugin: string): CopySelector {
  const state = readClaudeState(configDir, plugin);
  return servedSelector(plugin, state.recordKeys, state.enabled);
}

export function status(inputs: StatusInputs): StatusReport {
  if (inputs.surface === "claude-code") return statusClaudeCode(inputs);
  if (inputs.surface === "codex") return statusCodex(inputs);
  return statusAntigravity(inputs);
}

function verdictOf(
  problems: readonly string[],
  readBack: ReadBack,
  served: readonly Served[],
  mismatch: string | null,
  servedReason: string,
): { verdict: StatusVerdict; reason: string } {
  if (problems.length > 0) return { verdict: "wiring", reason: problems.join("; ") };
  if (!readBack.checked) return { verdict: "tool missing", reason: readBack.detail };
  if (served.length === 0) return { verdict: "not installed", reason: servedReason };
  if (mismatch !== null) return { verdict: "mismatch", reason: mismatch };
  return { verdict: "serving", reason: `serves ${served.map((entry): string => `${entry.id} ${entry.version ?? "?"}`).join(", ")}` };
}

function statusClaudeCode(inputs: StatusInputs): StatusReport {
  const { plugin, root, configDir } = inputs;
  const dest = join(configDir, "skills", plugin);
  const link = inspectDestination(dest, claudeOwner(plugin));
  const problems: string[] = [];
  const warnings: string[] = [];
  const marketplaces = new Set<string>();
  if (root !== null) {
    const market = readMarketplace(root, plugin);
    if (market.state === "read") marketplaces.add(market.name);
  }
  const record = readInstallRecord(configDir);
  if (record.state === "unreadable") problems.push(`the install record cannot be trusted (${record.reason})`);
  const recordKeys = record.state === "read" ? Object.keys(record.plugins).filter((key): boolean => key.startsWith(`${plugin}@`)) : [];
  for (const key of recordKeys) if (key !== skillsDirKey(plugin)) marketplaces.add(key.slice(plugin.length + 1));
  const settings = readJsonObject(join(configDir, "settings.json"));
  if (settings.state === "bad") problems.push(`${settings.reason}: enabledPlugins cannot be verified`);
  const settingsValue = settings.state === "read" ? settings.value : {};
  const enabled = settingsValue["enabledPlugins"];
  const extra = settingsValue["extraKnownMarketplaces"];
  if (typeof enabled === "object" && enabled !== null && !Array.isArray(enabled)) {
    for (const [key, value] of Object.entries(enabled as Record<string, unknown>)) {
      if (key.startsWith(`${plugin}@`) && key !== skillsDirKey(plugin) && value === true) {
        warnings.push(`settings.json enables ${key}: an enabled marketplace copy takes precedence over skills/${plugin}, and is downloaded again on the next reload when it is not cached`);
        marketplaces.add(key.slice(plugin.length + 1));
      }
    }
  }
  if (typeof extra === "object" && extra !== null && !Array.isArray(extra)) {
    for (const name of [...marketplaces].sort()) {
      if (own(extra as Record<string, unknown>, name)) warnings.push(`settings.json declares extraKnownMarketplaces.${name}: Claude Code clones it again on the next reload`);
    }
  }
  let readBack: ReadBack;
  let listed: Served[] = [];
  const result = callTool(inputs.seams, "claude", ["plugin", "list", "--json"], toolEnv("claude-code", configDir, inputs.configExplicit));
  if (result.spawnFailed) {
    readBack = { checked: false, detail: `${result.last}: claude plugin list --json was not read, so nothing is known to be served` };
  } else if (!result.ok) {
    readBack = { checked: true, detail: "failed" };
    problems.push(`claude plugin list --json failed: ${result.last}`);
  } else {
    const entries = parseClaudeList(result.stdout);
    if (typeof entries === "string") {
      readBack = { checked: true, detail: "unreadable" };
      problems.push(`claude plugin list --json could not be read: ${entries}`);
    } else {
      listed = entries
        .filter((entry): boolean => entry.id.startsWith(`${plugin}@`))
        .map((entry): Served => ({ id: entry.id, version: entry.version, path: entry.installPath === null ? null : redactRemoteCredentials(entry.installPath), enabled: entry.enabled === true, status: null }));
      readBack = { checked: true, detail: `claude plugin list --json: ${listed.length} ${plugin}@ ${listed.length === 1 ? "entry" : "entries"}` };
    }
  }
  const served = listed.filter((entry): boolean => entry.enabled);
  if (served.length > 1) warnings.push(`${served.length} copies are enabled (${served.map((entry): string => entry.id).join(", ")}): one shadows the other`);
  let mismatch: string | null = null;
  if (root !== null && served.length > 0) {
    const rootId = identityOf(root);
    const rootVersion = pluginManifest(root, plugin)?.version ?? null;
    const fromRoot = served.find((entry): boolean => {
      const id = entry.path === null ? null : identityOf(entry.path);
      return id !== null && rootId !== null && sameIdentity(id, rootId);
    });
    if (fromRoot === undefined) mismatch = `serves ${served.map((entry): string => `${entry.id} from ${entry.path ?? "?"}`).join(", ")}, not ${root}`;
    else if (served.length > 1) mismatch = `serves ${root} as ${fromRoot.id}, but another enabled copy shadows it`;
    else if (rootVersion === null) mismatch = `${root}'s plugin.json carries no version, so the served version cannot be compared`;
    else if (fromRoot.version !== rootVersion) mismatch = `serves ${fromRoot.id} at version ${fromRoot.version ?? "(none reported)"}, but ${root}'s plugin.json says ${rootVersion}`;
  }
  const outcome = verdictOf(problems, readBack, served, mismatch, `claude plugin list --json lists no enabled ${plugin}@ entry`);
  return {
    surface: "claude-code",
    plugin,
    root,
    configDir,
    destination: dest,
    link: describeLink(link, plugin),
    listed,
    served,
    readBack,
    warnings,
    ...outcome,
  };
}

function statusCodex(inputs: StatusInputs): StatusReport {
  const { plugin, root, configDir } = inputs;
  const env = toolEnv("codex", configDir, inputs.configExplicit);
  const problems: string[] = [];
  let readBack: ReadBack;
  let listed: Served[] = [];
  const marketplaceRoots = new Map<string, string>();
  const result = callTool(inputs.seams, "codex", ["plugin", "list"], env);
  if (result.spawnFailed) {
    readBack = { checked: false, detail: `${result.last}: codex plugin list was not read, so nothing is known to be served` };
  } else if (!result.ok) {
    readBack = { checked: true, detail: "failed" };
    problems.push(`codex plugin list failed: ${result.last}`);
  } else {
    listed = parseCodexPlugins(result.stdout)
      .filter((row): boolean => row.id.startsWith(`${plugin}@`))
      .map((row): Served => ({ id: row.id, version: row.version, path: row.path === null ? null : redactRemoteCredentials(row.path), enabled: codexEnabled(row.status), status: row.status }));
    readBack = { checked: true, detail: `codex plugin list: ${listed.length} ${plugin}@ ${listed.length === 1 ? "row" : "rows"}` };
    const markets = callTool(inputs.seams, "codex", ["plugin", "marketplace", "list"], env);
    if (!markets.ok) problems.push(`codex plugin marketplace list failed: ${markets.last}`);
    else for (const row of parseCodexMarketplaces(markets.stdout)) marketplaceRoots.set(row.name, row.root);
  }
  const served = listed.filter((entry): boolean => entry.enabled);
  const warnings = served
    .map((entry): string => {
      const name = entry.id.slice(plugin.length + 1);
      const at = marketplaceRoots.get(name);
      return at === undefined ? `${entry.id}: no '${name}' marketplace is registered` : `${entry.id}: marketplace '${name}' at ${shownRoot(at)}`;
    });
  let mismatch: string | null =
    served.length > 1 ? `${served.length} rows are enabled (${served.map((entry): string => entry.id).join(", ")}): one plugin is installed from more than one marketplace` : null;
  if (mismatch === null && root !== null && served.length > 0) {
    const market = readMarketplace(root, plugin);
    if (market.state !== "read") {
      mismatch = `${root} carries no usable .claude-plugin/marketplace.json, so what Codex serves cannot be its install`;
    } else {
      const id = `${plugin}@${market.name}`;
      const mine = served.find((entry): boolean => entry.id === id);
      const at = marketplaceRoots.get(market.name);
      const atId = at === undefined ? null : identityOf(at);
      const rootId = identityOf(root);
      const compare = codexManifest(root, plugin);
      if (mine === undefined) mismatch = `serves ${served.map((entry): string => entry.id).join(", ")}, not ${id}`;
      else if (atId === null || rootId === null || !sameIdentity(atId, rootId)) mismatch = `the '${market.name}' marketplace is at ${at === undefined ? "nowhere" : shownRoot(at)}, not ${root}`;
      else if (mine.version !== compare.version) mismatch = `serves ${id} at ${mine.version ?? "?"}, but ${compare.path} says ${compare.version}`;
    }
  }
  const outcome = verdictOf(problems, readBack, served, mismatch, `codex plugin list shows no installed, enabled ${plugin}@ row`);
  return { surface: "codex", plugin, root, configDir, destination: null, link: null, listed, served, readBack, warnings, ...outcome };
}

function statusAntigravity(inputs: StatusInputs): StatusReport {
  const { plugin, root, configDir, surfaceDir } = inputs;
  const dest = join(configDir, "config", "plugins", plugin);
  const owner: Owner = surfaceDir === null ? (real): string | null => (flatManifest(real)?.name === plugin ? real : null) : antigravityOwner(plugin, surfaceDir);
  const link = inspectDestination(dest, owner);
  const problems: string[] = [];
  const warnings: string[] = [];
  let served: Served[] = [];
  let notServed = `${dest} is ${describeLink(link, plugin)}`;
  if (link.kind === "unreadable") problems.push(link.reason);
  const folder = link.kind === "link" ? link.real : link.kind === "directory" ? dest : null;
  if (folder !== null) {
    const manifest = flatManifest(folder);
    if (manifest !== null && manifest.name === plugin) {
      served = [{ id: plugin, version: manifest.version, path: folder, enabled: true, status: null }];
      if (link.kind === "directory") warnings.push(`${dest} is a real directory, a copy (agy plugin install copies); it is not a link to any checkout`);
    } else {
      notServed = `${dest} holds no plugin.json naming '${plugin}'`;
    }
  }
  let readBack: ReadBack = { checked: true, detail: served.length === 0 ? "nothing linked to validate" : `plugin.json version ${served[0]?.version ?? "?"}` };
  let mismatch: string | null = null;
  if (served.length > 0) {
    const validate = callTool(inputs.seams, "agy", ["plugin", "validate", dest], {});
    if (validate.spawnFailed) readBack = { checked: false, detail: `${readBack.detail}; agy could not be started, so agy plugin validate was not performed` };
    else if (!validate.ok) mismatch = `agy plugin validate ${dest} failed: ${validate.last}`;
    else readBack = { checked: true, detail: `${readBack.detail}; agy plugin validate ok` };
  }
  if (root !== null && surfaceDir !== null && served.length > 0 && mismatch === null) {
    const target = identityOf(join(root, ...surfaceDir.split("/")));
    const path = served[0]?.path ?? null;
    const current = path === null ? null : identityOf(path);
    if (link.kind !== "link" || target === null || current === null || !sameIdentity(target, current)) {
      mismatch = `serves ${served[0]?.path ?? "?"}, not ${join(root, ...surfaceDir.split("/"))}`;
    }
  }
  const outcome = verdictOf(problems, readBack, served, mismatch, notServed);
  return {
    surface: "antigravity",
    plugin,
    root,
    configDir,
    destination: dest,
    link: describeLink(link, plugin),
    listed: served,
    served,
    readBack,
    warnings,
    ...outcome,
  };
}
