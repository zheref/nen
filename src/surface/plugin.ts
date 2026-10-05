// src/surface/plugin.ts -- `nen surface mirror check --plugin <name>
// --installed <dir|auto>`: is the copy of a Claude Code plugin that the host
// SERVES still an image of the source it claims to be? (zheref/nen#339)
//
// WHY THIS IS NOT THE MIRROR CHECK. ./mirror.ts's `check --installed` diffs a
// target `.claude/` layout -- `skills/`, `agents/`, `hooks/hooks.json` -- and a
// plugin is never placed that way. Claude Code serves a plugin from its own
// layout: the plugin cache (`<config>/plugins/cache/<marketplace>/<plugin>/
// <version>`, recorded in `<config>/plugins/installed_plugins.json`) or a
// skills-directory install (`<config>/skills/<plugin>`, usually a link to a
// checkout). Pointed at a real cache the mirror check read every skill
// `missing`. So this module judges the plugin's OWN tree: the trees the
// caller names (`--trees`, caller data -- which directories a plugin ships is
// the plugin's fact, never a literal of this binary) and the two manifests
// Claude Code documents for a plugin root, byte for byte.
//
// THE REFERENCE BEHAVIOUR is zheref/hatsu's `scripts/plugin_cache_check.sh`
// and its fixture, which this module ports so the shell can be retired. Two
// differences, both in the direction of telling more truth: the install record
// is read as JSON by this binary, so "no jq" is no longer a case at all; and a
// name that is not valid UTF-8 is set aside like one carrying a control
// character, never compared under a decoded spelling it does not have.
//
// A COPY IS NEVER ITS OWN EVIDENCE. When the served copy and `--source` are
// the same real path, comparing them proves nothing, so a source named
// INDEPENDENTLY of the copy is looked for, in order: `--independent-source`;
// the `<plugin>@<marketplace>` entry's `directory` source in
// `known_marketplaces.json`; the checkout the caller stands in (`--repo`, else
// the working directory) -- but only when that checkout is on its trunk or on
// the branch the served copy is checked out at, because a feature branch is
// the change being authored, not what the host should serve. The first found
// is the source. When it IS the copy (a link to that checkout) and the copy is
// a git checkout, the copy is identical by link; with no independent source
// the copy is NOT COMPARABLE -- never identical.
//
// NOTHING IS EVER OPENED THAT IS NOT A REGULAR FILE. Every entry is `lstat`ed;
// a symlink is compared by its target string (`readlink`) and never followed,
// so a link to a FIFO cannot hang the check and a link out of the tree is
// never read. A FIFO, socket or device in a tree is not a shipped file and is
// not listed. `.DS_Store` is ignored on both sides.

import { existsSync, lstatSync, readdirSync, readFileSync, readlinkSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

/** The six verdicts, and the exit code each one is. */
export type PluginVerdict = "identical" | "different" | "wiring" | "not installed" | "not comparable" | "broken install";

export const VERDICT_EXIT: Readonly<Record<PluginVerdict, number>> = {
  identical: 0,
  different: 1,
  wiring: 2,
  "not installed": 3,
  "not comparable": 4,
  "broken install": 5,
};

/**
 * Worst first, for `--installed auto`'s overall verdict: a copy that could not
 * be read (wiring) outranks a stale one, a stale one a broken record, a broken
 * record an unjudgeable copy, and that an identical one -- the shell's
 * `2 > 1 > 5 > 4 > 0`. `not installed` is never ranked: it is the verdict only
 * when there was nothing to judge at all.
 */
const RANK: Readonly<Record<PluginVerdict, number>> = {
  wiring: 5,
  different: 4,
  "broken install": 3,
  "not comparable": 2,
  identical: 1,
  "not installed": 0,
};

/** The manifests Claude Code documents at a plugin root; always compared. */
export const PLUGIN_MANIFESTS: readonly string[] = [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"];

/** A refusal: the command layer turns it into exit 2 (wiring) on stderr. */
export class PluginCheckError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginCheckError";
  }
}

const CONTROL = /[\x00-\x1f\x7f-\x9f]/;

/** `text` with every control character as `?`: a name is never printed raw. */
export function safe(text: string): string {
  return text.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
}

/** Where Claude Code keeps its config: `--config-dir`, else `$CLAUDE_CONFIG_DIR`, else `~/.claude`. */
export function resolveConfigDir(
  flag: string | null,
  env: Readonly<Record<string, string | undefined>>,
  home: string = homedir(),
): string {
  if (flag !== null) return flag;
  const fromEnv = env["CLAUDE_CONFIG_DIR"];
  if (fromEnv !== undefined && fromEnv !== "") return fromEnv;
  return join(env["HOME"] !== undefined && env["HOME"] !== "" ? env["HOME"] : home, ".claude");
}

/**
 * Every `--trees` entry checked as a plain relative path inside a plugin root.
 * An absolute path, a `..` segment or a control character is refused: a tree
 * is a directory the plugin ships, never a way out of it.
 */
export function validateTrees(trees: readonly string[]): readonly string[] {
  if (trees.length === 0) {
    throw new PluginCheckError(
      "--trees is required with --plugin: the directories the plugin ships (e.g. 'skills,agents,hooks'). Which trees a plugin ships is the plugin's own fact, never a guess of this binary.",
    );
  }
  const normalized: string[] = [];
  for (const tree of trees) {
    // Split on BOTH separators on every host: `..\x` is a way out on Windows
    // and a name nobody ships everywhere else, so it is refused everywhere.
    const parts = tree.split(/[\\/]/);
    if (
      isAbsolute(tree) ||
      CONTROL.test(tree) ||
      tree.includes(":") ||
      parts.some((part): boolean => part === ".." || part === "." || part === "")
    ) {
      throw new PluginCheckError(
        `--trees entry '${safe(tree)}' is not a plain relative path inside the plugin root (no leading '/' or '\\', no ':', no '.' or '..' segment, no empty segment, no control character).`,
      );
    }
    normalized.push(parts.join("/"));
  }
  return [...new Set(normalized)];
}

/** The real path of `path`, or null when it cannot be resolved (gone, dangling, looping, unreadable). */
function real(path: string): string | null {
  try {
    return realpathSync(path);
  } catch {
    return null;
  }
}

/** A file's identity: its real path, and its device and inode. */
export interface Identity {
  readonly real: string;
  readonly dev: number;
  readonly ino: number;
}

export function identityOf(path: string): Identity | null {
  const resolved = real(path);
  if (resolved === null) return null;
  try {
    const stats = statSync(resolved);
    return { real: resolved, dev: stats.dev, ino: stats.ino };
  } catch {
    return null;
  }
}

/** The same directory: the same real path, or the same device and inode (a bind mount, a case-folding host). */
export function sameIdentity(left: Identity, right: Identity): boolean {
  return left.real === right.real || (left.dev === right.dev && left.ino === right.ino);
}

/**
 * What an error met while INSPECTING a path means (Copilot on NN-PR-#378: an
 * inspection failure is not absence). Only ENOENT is absence; a loop or a
 * file where a directory belongs (ELOOP, ENOTDIR) is a broken path; anything
 * else -- EACCES, EIO, ... -- is a path that could not be read: wiring.
 */
export type InspectionFailure = "absent" | "broken" | "unreadable";

export function classifyError(error: unknown): InspectionFailure {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  if (code === "ENOENT") return "absent";
  if (code === "ELOOP" || code === "ENOTDIR") return "broken";
  return "unreadable";
}

/** The real path of `path`, or how resolving it failed. */
function resolveReal(path: string): { readonly real: string } | { readonly failure: InspectionFailure; readonly code: string } {
  try {
    return { real: realpathSync(path) };
  } catch (error) {
    return { failure: classifyError(error), code: (error as NodeJS.ErrnoException).code ?? "error" };
  }
}

/** A root of the plugin, a directory that is not one, or one whose manifest could not be READ. */
export type ManifestInspection =
  | { readonly state: "plugin"; readonly version: string | null }
  | { readonly state: "none" }
  | { readonly state: "unreadable"; readonly reason: string };

/**
 * `dir` inspected as a root of `plugin`. A manifest that is missing, a link,
 * not JSON or naming another plugin is `none`; one that could not be read
 * (EACCES and the like) is `unreadable` -- wiring, never "holds no plugin".
 */
export function inspectManifest(dir: string, plugin: string): ManifestInspection {
  const step = (path: string): { readonly stats: ReturnType<typeof lstatSync> } | ManifestInspection => {
    try {
      return { stats: lstatSync(path) };
    } catch (error) {
      const failure = classifyError(error);
      return failure === "unreadable"
        ? { state: "unreadable", reason: `${safe(path)} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "error"})` }
        : { state: "none" };
    }
  };
  try {
    if (!statSync(dir).isDirectory()) return { state: "none" };
  } catch (error) {
    if (classifyError(error) === "unreadable") {
      return { state: "unreadable", reason: `${safe(dir)} could not be inspected (${(error as NodeJS.ErrnoException).code ?? "error"})` };
    }
    return { state: "none" };
  }
  // Segment by segment: a `.claude-plugin` that is a link is never followed.
  const folder = step(join(dir, ".claude-plugin"));
  if ("state" in folder) return folder;
  if (folder.stats === undefined || !folder.stats.isDirectory()) return { state: "none" };
  const file = join(dir, ".claude-plugin", "plugin.json");
  const manifest = step(file);
  if ("state" in manifest) return manifest;
  if (manifest.stats === undefined || !manifest.stats.isFile()) return { state: "none" };
  let text: string;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    return { state: "unreadable", reason: `${safe(file)} could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})` };
  }
  try {
    const parsed = JSON.parse(text) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { state: "none" };
    const record = parsed as Record<string, unknown>;
    if (record["name"] !== plugin) return { state: "none" };
    return { state: "plugin", version: typeof record["version"] === "string" ? record["version"] : null };
  } catch {
    return { state: "none" };
  }
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The manifest of `dir` when it is a root of `plugin`: a REGULAR
 * `.claude-plugin/plugin.json` (never opened through a link) whose `name` is
 * the plugin's. Null otherwise.
 */
export function pluginManifest(dir: string, plugin: string): { readonly version: string | null } | null {
  const inspected = inspectManifest(dir, plugin);
  return inspected.state === "plugin" ? { version: inspected.version } : null;
}

// ---------------------------------------------------------------------------
// Listing and comparing one tree pair
// ---------------------------------------------------------------------------

type EntryKind = "file" | "link";

interface Listing {
  readonly entries: ReadonlyMap<string, EntryKind>;
  /** Names set aside, already made safe: a control character, or bytes that are not UTF-8. */
  readonly unexpected: readonly string[];
}

/** A directory that could not be listed, or a file that could not be read: the copy is not judged. */
export class Unreadable extends Error {}

/** A `--trees` entry that is not a real directory in a source: wiring, never an empty tree. */
class TreeNotInSource extends PluginCheckError {}

/**
 * `relative` under `base`, walked ONE SEGMENT AT A TIME with lstat (zheref/nen
 * #339, N2): a link anywhere on the way -- `claude` linked into the source --
 * stops the walk there and is the entry, compared by its target and never
 * descended into; so is a file where a directory was expected (N7).
 */
type Walked =
  | { readonly kind: "absent" }
  | { readonly kind: "dir" }
  | { readonly kind: "other" }
  | { readonly kind: "entry"; readonly at: string; readonly entry: EntryKind; readonly final: boolean };

function walkSegments(base: string, relative: string): Walked {
  const parts = relative.split("/");
  for (let index = 0; index < parts.length; index += 1) {
    const prefix = parts.slice(0, index + 1).join("/");
    const final = index === parts.length - 1;
    let stats;
    try {
      stats = lstatSync(join(base, ...parts.slice(0, index + 1)));
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
      throw new Unreadable(prefix);
    }
    if (stats.isSymbolicLink()) return { kind: "entry", at: prefix, entry: "link", final };
    if (stats.isFile()) return { kind: "entry", at: prefix, entry: "file", final };
    if (!stats.isDirectory()) return { kind: "other" };
    if (final) return { kind: "dir" };
  }
  /* c8 ignore next -- a validated tree has at least one segment */
  return { kind: "absent" };
}

/** Throws TreeNotInSource unless every tree is a real directory under `source`, every segment lstat'ed. */
export function assertTreesInSource(source: string, trees: readonly string[]): void {
  for (const tree of trees) {
    // An Unreadable segment propagates: it is a wiring REPORT, never a
    // claim that the tree is missing (Copilot on NN-PR-#378).
    const walked = walkSegments(source, tree);
    if (walked.kind !== "dir") {
      const why =
        walked.kind === "absent"
          ? "does not exist"
          : walked.kind === "entry" && walked.entry === "link"
            ? `reaches a symbolic link at '${walked.at}'`
            : walked.kind === "entry"
              ? `reaches a file at '${walked.at}'`
              : "is not a directory";
      throw new TreeNotInSource(
        `--trees entry '${tree}' ${why} in the source ${safe(source)}: a tree that is not a real directory there would compare as empty and read identical`,
      );
    }
  }
}

function listSide(base: string, trees: readonly string[]): Listing {
  const entries = new Map<string, EntryKind>();
  const unexpected: string[] = [];
  const visit = (relative: string): void => {
    const absolute = join(base, ...relative.split("/"));
    let names: Buffer[];
    try {
      names = readdirSync(absolute, { encoding: "buffer" });
    } catch {
      throw new Unreadable(relative);
    }
    for (const raw of names) {
      const name = raw.toString("utf8");
      const child = `${relative}/${name}`;
      if (CONTROL.test(name) || !Buffer.from(name, "utf8").equals(raw)) {
        unexpected.push(safe(child));
        continue;
      }
      if (name === ".DS_Store") continue;
      let stats;
      try {
        stats = lstatSync(join(absolute, name));
      } catch {
        throw new Unreadable(child);
      }
      if (stats.isSymbolicLink()) entries.set(child, "link");
      else if (stats.isFile()) entries.set(child, "file");
      else if (stats.isDirectory()) visit(child);
      // A FIFO, socket or device is not a shipped file: never listed, never opened.
    }
  };
  for (const tree of trees) {
    const walked = walkSegments(base, tree);
    if (walked.kind === "dir") visit(tree);
    else if (walked.kind === "entry") entries.set(walked.at, walked.entry);
  }
  for (const manifest of PLUGIN_MANIFESTS) {
    const walked = walkSegments(base, manifest);
    if (walked.kind === "entry") entries.set(walked.at, walked.entry);
  }
  return { entries, unexpected: unexpected.sort() };
}

/** How one path differs, by side. */
export interface Difference {
  readonly kind: "only-in-source" | "only-in-copy" | "differs" | "differs-symlink" | "unexpected-in-copy" | "unexpected-in-source";
  readonly path: string;
}

type Comparison = { readonly ok: true; readonly differences: readonly Difference[] } | { readonly ok: false; readonly reason: string };

function compareTrees(source: string, copy: string, trees: readonly string[]): Comparison {
  let left: Listing;
  let right: Listing;
  try {
    assertTreesInSource(source, trees);
    left = listSide(source, trees);
  } catch (error) {
    if (error instanceof TreeNotInSource) return { ok: false, reason: error.message };
    if (error instanceof Unreadable) return { ok: false, reason: `unreadable: ${safe(error.message)} under the source ${safe(source)} could not be listed or read` };
    throw error;
  }
  try {
    right = listSide(copy, trees);
  } catch (error) {
    if (error instanceof Unreadable) return { ok: false, reason: `unreadable: ${safe(error.message)} under the copy ${safe(copy)} could not be listed or read` };
    throw error;
  }
  const differences: Difference[] = [
    ...right.unexpected.map((path): Difference => ({ kind: "unexpected-in-copy", path })),
    ...left.unexpected.map((path): Difference => ({ kind: "unexpected-in-source", path })),
  ];
  // A link on one side where the other holds a directory of files (the copy's
  // `claude` linked into the source): ONE differs-symlink at the link, and
  // the files under it are not listed again path by path.
  const shadowed = (mine: ReadonlyMap<string, EntryKind>, theirs: ReadonlyMap<string, EntryKind>): readonly string[] =>
    [...mine]
      .filter(([path, kind]): boolean => kind === "link" && !theirs.has(path) && [...theirs.keys()].some((other): boolean => other.startsWith(`${path}/`)))
      .map(([path]): string => path);
  const links = [...shadowed(right.entries, left.entries), ...shadowed(left.entries, right.entries)];
  const underLink = (path: string): boolean => links.some((link): boolean => path.startsWith(`${link}/`));
  const paths = [...new Set([...left.entries.keys(), ...right.entries.keys()])].sort();
  for (const path of paths) {
    if (underLink(path)) continue;
    const a = left.entries.get(path);
    const b = right.entries.get(path);
    if (links.includes(path)) differences.push({ kind: "differs-symlink", path });
    else if (b === undefined) differences.push({ kind: "only-in-source", path });
    else if (a === undefined) differences.push({ kind: "only-in-copy", path });
    else if (a === "link" || b === "link") {
      // Never opened: two links with the same target string are equal, anything else differs.
      try {
        const same =
          a === "link" &&
          b === "link" &&
          readlinkSync(join(source, ...path.split("/")), { encoding: "buffer" }).equals(
            readlinkSync(join(copy, ...path.split("/")), { encoding: "buffer" }),
          );
        if (!same) differences.push({ kind: "differs-symlink", path });
      } catch {
        return { ok: false, reason: `unreadable: the link ${path} could not be read` };
      }
    } else {
      let bytesA: Buffer;
      let bytesB: Buffer;
      try {
        bytesA = readFileSync(join(source, ...path.split("/")));
        bytesB = readFileSync(join(copy, ...path.split("/")));
      } catch {
        return { ok: false, reason: `unreadable: ${path} could not be read` };
      }
      if (!bytesA.equals(bytesB)) differences.push({ kind: "differs", path });
    }
  }
  return { ok: true, differences };
}

// ---------------------------------------------------------------------------
// The independence rule
// ---------------------------------------------------------------------------

/** One git call: the code and the trimmed first line of stdout. */
export type GitProbe = (cwd: string, args: readonly string[]) => { readonly code: number; readonly stdout: string };

export interface JudgeContext {
  readonly plugin: string;
  readonly trees: readonly string[];
  /** `--source`, as a real path. */
  readonly source: string;
  /** `--source`'s identity: a copy IS the source when either its real path or its device and inode match. */
  readonly sourceId: Identity;
  /** `--independent-source`, as given, or null. */
  readonly independentSource: string | null;
  readonly configDir: string;
  /** The checkout the caller stands in: `--repo`, else the working directory. */
  readonly standIn: string;
  readonly git: GitProbe;
}

export type SourceOrigin = "source" | "independent-source" | "marketplace" | "checkout";

/** The parsed install record, or why it is not one. */
type RecordRead =
  | { readonly state: "absent" }
  | { readonly state: "read"; readonly plugins: Readonly<Record<string, unknown>> }
  | {
      readonly state: "unreadable";
      readonly reason: string;
      /** A record that is there and malformed is broken (5); one that could not be READ is wiring (2). */
      readonly verdict: "broken install" | "wiring";
    };

function readJsonFile(path: string): unknown {
  // Opened only when it is a regular file: a FIFO there must not hang the check.
  if (!statSync(path).isFile()) throw new Error("not a regular file");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

export function readInstallRecord(configDir: string): RecordRead {
  const path = join(configDir, "plugins", "installed_plugins.json");
  const broken = (reason: string): RecordRead => ({ state: "unreadable", reason, verdict: "broken install" });
  const unread = (error: unknown): RecordRead => ({
    state: "unreadable",
    reason: `it could not be read (${(error as NodeJS.ErrnoException).code ?? "error"})`,
    verdict: "wiring",
  });
  // Only ENOENT is absence (Copilot on NN-PR-#378): a loop or a file where
  // <config>/plugins belongs is a broken install, a permission error wiring.
  let isLink: boolean;
  try {
    isLink = lstatSync(path).isSymbolicLink();
  } catch (error) {
    const failure = classifyError(error);
    if (failure === "absent") return { state: "absent" };
    return failure === "broken" ? broken(`its path cannot be resolved (${(error as NodeJS.ErrnoException).code ?? "error"})`) : unread(error);
  }
  let stats;
  try {
    stats = statSync(path);
  } catch (error) {
    // A record that is a dangling or looping link is there and unusable: a
    // broken install, never "not installed" (zheref/nen#339, N9).
    if (classifyError(error) !== "unreadable") return broken(isLink ? "it is a dangling or looping link" : "it cannot be resolved");
    return unread(error);
  }
  // Opened only when it is a regular file: a FIFO there must not hang the check.
  if (!stats.isFile()) return broken("it is not a regular file");
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    return unread(error);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return broken("it is not JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return broken("its top level is not an object");
  const plugins = (parsed as Record<string, unknown>)["plugins"] ?? {};
  if (typeof plugins !== "object" || plugins === null || Array.isArray(plugins)) return broken("its 'plugins' is not an object");
  return { state: "read", plugins: plugins as Record<string, unknown> };
}

/** Every `<plugin>@<marketplace>` key in the record, in order. */
function pluginKeys(plugins: Readonly<Record<string, unknown>>, plugin: string): readonly string[] {
  return Object.keys(plugins).filter((key): boolean => key.startsWith(`${plugin}@`));
}

/** The trunk of a checkout: its nen/workflow.json `branch.base`, else origin/HEAD, else `main`. */
function trunkOf(dir: string, git: GitProbe): string {
  try {
    const workflow = readJsonFile(join(dir, "nen", "workflow.json")) as Record<string, unknown>;
    const branch = workflow["branch"];
    if (typeof branch === "object" && branch !== null) {
      const base = (branch as Record<string, unknown>)["base"];
      if (typeof base === "string" && base !== "") return base;
    }
  } catch {
    /* no workflow, or not one this rule can read: the next fallback */
  }
  const head = git(dir, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0 && head.stdout !== "") return head.stdout.replace(/^origin\//, "");
  return "main";
}

interface IndependentFound {
  readonly found: true;
  readonly how: SourceOrigin;
  readonly path: string;
  readonly id: Identity;
}
interface IndependentNone {
  readonly found: false;
  /** The branch a stand-in checkout was skipped for, when one was. */
  readonly skippedBranch: string | null;
}

function marketplaceCandidate(context: JudgeContext): string | null {
  const record = readInstallRecord(context.configDir);
  if (record.state !== "read") return null;
  let known: unknown;
  try {
    known = readJsonFile(join(context.configDir, "plugins", "known_marketplaces.json"));
  } catch {
    return null;
  }
  if (typeof known !== "object" || known === null || Array.isArray(known)) return null;
  for (const key of pluginKeys(record.plugins, context.plugin)) {
    const marketplace = key.slice(context.plugin.length + 1);
    const entry = (known as Record<string, unknown>)[marketplace];
    if (typeof entry !== "object" || entry === null) continue;
    const source = (entry as Record<string, unknown>)["source"];
    if (typeof source !== "object" || source === null) continue;
    const fields = source as Record<string, unknown>;
    const path = fields["path"];
    if (fields["source"] !== "directory" || typeof path !== "string" || path === "" || CONTROL.test(path)) continue;
    if (pluginManifest(path, context.plugin) !== null) return path;
  }
  return null;
}

export function independentSource(copy: string, copyId: Identity, context: JudgeContext): IndependentFound | IndependentNone {
  let skippedBranch: string | null = null;
  const accept = (candidate: string | null, how: SourceOrigin): IndependentFound | null => {
    if (candidate === null || pluginManifest(candidate, context.plugin) === null) return null;
    const id = identityOf(candidate);
    return id === null ? null : { found: true, how, path: id.real, id };
  };
  const explicit = accept(context.independentSource, "independent-source");
  if (explicit !== null) return explicit;
  const market = accept(marketplaceCandidate(context), "marketplace");
  if (market !== null) return market;
  const top = context.git(context.standIn, ["rev-parse", "--show-toplevel"]);
  if (top.code === 0 && top.stdout !== "" && pluginManifest(top.stdout, context.plugin) !== null) {
    const branch = context.git(top.stdout, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    const current = branch.code === 0 && branch.stdout !== "" ? branch.stdout : null;
    // The served copy's own branch -- asked only of a copy that IS a checkout,
    // so a copy sitting inside some other repository never borrows its branch.
    const served = existsSync(join(copy, ".git")) ? context.git(copy, ["symbolic-ref", "--quiet", "--short", "HEAD"]) : null;
    const servedBranch = served !== null && served.code === 0 && served.stdout !== "" ? served.stdout : null;
    // When the stand-in IS the copy, its branch is trivially the served one;
    // only its trunk makes it the source (N8) -- a feature branch checked out
    // in the served checkout is what is wrongly served, never its own evidence.
    const topId = identityOf(top.stdout);
    const isCopy = topId !== null && sameIdentity(topId, copyId);
    const trunk = trunkOf(top.stdout, context.git);
    if (current !== null && (current === trunk || (!isCopy && current === servedBranch))) {
      const checkout = accept(top.stdout, "checkout");
      if (checkout !== null) return checkout;
    } else {
      skippedBranch = current ?? "a detached HEAD";
    }
  }
  return { found: false, skippedBranch };
}

// ---------------------------------------------------------------------------
// Judging
// ---------------------------------------------------------------------------

export interface CopyJudgement {
  /** What named the copy: `--installed`, `the <plugin>@<marketplace> installPath`, `skills/<plugin>`. */
  readonly label: string;
  /** The path as recorded or given, made safe. */
  readonly path: string;
  readonly verdict: PluginVerdict;
  /** The real path the copy was compared against, or null when it was not. */
  readonly source: string | null;
  readonly namedBy: SourceOrigin | null;
  /** True when the copy is the source itself, a git checkout: identical by link. */
  readonly byLink: boolean;
  readonly sourceVersion: string | null;
  readonly copyVersion: string | null;
  readonly differences: readonly Difference[];
  /** One sentence: why this verdict. */
  readonly reason: string;
}

const NONE = { source: null, namedBy: null, byLink: false, sourceVersion: null, copyVersion: null, differences: [] } as const;

/** One copy, already resolved to a real path and known to be a root of the plugin. */
export function judgeCopy(label: string, path: string, copyId: Identity, context: JudgeContext): CopyJudgement {
  const copy = copyId.real;
  let source = context.source;
  let namedBy: SourceOrigin = "source";
  const shown = safe(path);
  if (sameIdentity(copyId, context.sourceId)) {
    const found = independentSource(copy, copyId, context);
    if (!found.found) {
      const skipped =
        found.skippedBranch === null
          ? ""
          : `; the checkout stood in is on ${safe(found.skippedBranch)}, a feature branch -- the change being authored, not what should be served`;
      return {
        label,
        path: shown,
        verdict: "not comparable",
        ...NONE,
        reason: `${shown} is the served copy AND the source given; no source named independently of it (--independent-source, a directory marketplace, or a checkout of the plugin on its trunk stood in)${skipped}`,
      };
    }
    source = found.path;
    namedBy = found.how;
    if (sameIdentity(found.id, copyId)) {
      // Proof the copy IS a git checkout: git's own toplevel for it resolves
      // to the copy. An empty .git, or a repository enclosing the copy, is
      // not that proof (Copilot on NN-PR-#378).
      const top = context.git(copy, ["rev-parse", "--show-toplevel"]);
      const topId = top.code === 0 && top.stdout !== "" ? identityOf(top.stdout) : null;
      if (topId !== null && sameIdentity(topId, copyId)) {
        return {
          label,
          path: shown,
          verdict: "identical",
          ...NONE,
          source,
          namedBy,
          byLink: true,
          reason: `${shown} is served by link to the source named by ${namedBy} (a git checkout)`,
        };
      }
      return {
        label,
        path: shown,
        verdict: "not comparable",
        ...NONE,
        reason: `${shown} is named by ${namedBy} but git does not answer for it as the toplevel of a checkout (an empty .git, or a repository enclosing it, is no proof), so it is no independent source`,
      };
    }
  }
  const sourceVersion = pluginManifest(source, context.plugin)?.version ?? null;
  const copyVersion = pluginManifest(copy, context.plugin)?.version ?? null;
  const compared = compareTrees(source, copy, context.trees);
  const by = namedBy === "source" ? "" : ` (named by ${namedBy})`;
  if (!compared.ok) {
    return { label, path: shown, verdict: "wiring", ...NONE, source, namedBy, sourceVersion, copyVersion, reason: compared.reason };
  }
  const identical = compared.differences.length === 0;
  return {
    label,
    path: shown,
    verdict: identical ? "identical" : "different",
    source,
    namedBy,
    byLink: false,
    sourceVersion,
    copyVersion,
    differences: compared.differences,
    reason: identical
      ? `${shown} (plugin ${copyVersion ?? "?"}) matches the source ${safe(source)}${by} (plugin ${sourceVersion ?? "?"})`
      : `${shown} (plugin ${copyVersion ?? "?"}) is not the source ${safe(source)}${by} (plugin ${sourceVersion ?? "?"})`,
  };
}

/** --independent-source is consulted only for a copy that IS --source; given otherwise, it is refused (N4). */
const INDEPENDENT_UNREAD =
  "--independent-source is consulted only when a judged copy IS --source (a copy is never its own evidence), and no copy here is: it would be accepted and ignored. Drop it, or point --source at the served copy.";

export interface PluginCheckReport {
  readonly verdict: PluginVerdict;
  /** The install record's state: `read`, `absent`, `unreadable`, or `not read` (an explicit --installed). */
  readonly record: "read" | "absent" | "unreadable" | "not read";
  readonly copies: readonly CopyJudgement[];
}

function broken(label: string, path: string, reason: string): CopyJudgement {
  return { label, path: safe(path), verdict: "broken install", ...NONE, reason };
}

/** A recorded path or record that could not be inspected: nothing is known about it, so it is wiring (2). */
function wiringCopy(label: string, path: string, reason: string): CopyJudgement {
  return { label, path: safe(path), verdict: "wiring", ...NONE, reason };
}

/** The verdict over many judgements: the worst one, or `not installed` when there were none. */
export function overallVerdict(copies: readonly CopyJudgement[]): PluginVerdict {
  let worst: PluginVerdict = "not installed";
  for (const copy of copies) if (RANK[copy.verdict] > RANK[worst]) worst = copy.verdict;
  return worst;
}

/** `--installed <dir>`: one copy the caller names. Refusals are PluginCheckError (exit 2). */
export function checkExplicitCopy(installed: string, context: JudgeContext): PluginCheckReport {
  if (CONTROL.test(installed)) throw new PluginCheckError("--installed carries a control character.");
  if (!isDirectory(installed)) throw new PluginCheckError(`--installed '${safe(installed)}' is not a directory.`);
  const copy = identityOf(installed);
  if (copy === null || pluginManifest(copy.real, context.plugin) === null) {
    throw new PluginCheckError(
      `--installed '${safe(installed)}' is not a copy of '${context.plugin}' (no regular .claude-plugin/plugin.json naming it). A copy of another plugin is never judged as drift.`,
    );
  }
  if (context.independentSource !== null && !sameIdentity(copy, context.sourceId)) {
    throw new PluginCheckError(INDEPENDENT_UNREAD);
  }
  const judgement = judgeCopy("--installed", installed, copy, context);
  return { verdict: judgement.verdict, record: "not read", copies: [judgement] };
}

/**
 * `--installed auto`: every copy the host has recorded for the plugin -- each
 * installPath of each `<plugin>@<marketplace>` entry of the install record,
 * and `<config>/skills/<plugin>` when it exists -- each judged once by real
 * path.
 */
export function checkRecordedCopies(context: JudgeContext): PluginCheckReport {
  const copies: CopyJudgement[] = [];
  const judged = new Set<string>();
  let sawSource = false;
  // An inspection failure is not absence (Copilot on NN-PR-#378): a recorded
  // path that is gone (ENOENT), loops (ELOOP) or runs through a file
  // (ENOTDIR) is a broken install; one that could not be inspected (EACCES
  // and the like) is wiring -- nothing is known about it either way.
  const judgePath = (path: string, label: string): void => {
    let linkStats;
    try {
      linkStats = lstatSync(path);
    } catch (error) {
      const failure = classifyError(error);
      const code = (error as NodeJS.ErrnoException).code ?? "error";
      if (failure === "absent") copies.push(broken(label, path, `${label} ${safe(path)} does not exist (a stale record)`));
      else if (failure === "broken") copies.push(broken(label, path, `${label} ${safe(path)} cannot be resolved (${code}: a loop, or a file where a directory belongs)`));
      else copies.push(wiringCopy(label, path, `${label} ${safe(path)} could not be inspected (${code})`));
      return;
    }
    const resolvedPath = resolveReal(path);
    if ("failure" in resolvedPath) {
      if (resolvedPath.failure === "unreadable") {
        copies.push(wiringCopy(label, path, `${label} ${safe(path)} could not be resolved (${resolvedPath.code})`));
      } else {
        copies.push(
          broken(label, path, linkStats.isSymbolicLink() ? `${label} ${safe(path)} is a dangling or looping link` : `${label} ${safe(path)} cannot be resolved (${resolvedPath.code})`),
        );
      }
      return;
    }
    const id = identityOf(resolvedPath.real);
    if (id === null) {
      copies.push(wiringCopy(label, path, `${label} ${safe(path)} could not be inspected`));
      return;
    }
    const resolved = id.real;
    if (!isDirectory(resolved)) {
      copies.push(broken(label, path, `${label} ${safe(path)} is not a directory`));
      return;
    }
    const manifest = inspectManifest(resolved, context.plugin);
    if (manifest.state === "unreadable") {
      copies.push(wiringCopy(label, path, `${label} ${safe(path)}: ${manifest.reason}`));
      return;
    }
    if (manifest.state === "none") {
      copies.push(broken(label, path, `${label} ${safe(path)} holds no '${context.plugin}' plugin (a regular .claude-plugin/plugin.json naming it)`));
      return;
    }
    // The same copy reached twice is judged once, by device and inode.
    const key = `${id.dev}:${id.ino}`;
    if (judged.has(key) || judged.has(resolved)) return;
    judged.add(key);
    judged.add(resolved);
    if (sameIdentity(id, context.sourceId)) sawSource = true;
    copies.push(judgeCopy(label, path, id, context));
  };

  const record = readInstallRecord(context.configDir);
  if (record.state === "unreadable") {
    const recordPath = join(context.configDir, "plugins", "installed_plugins.json");
    const reason = `the install record is not usable: ${record.reason}`;
    copies.push(record.verdict === "wiring" ? wiringCopy("the install record", recordPath, reason) : broken("the install record", recordPath, reason));
  } else if (record.state === "read") {
    for (const key of pluginKeys(record.plugins, context.plugin)) {
      const label = `the ${safe(key)} installPath`;
      const installs = record.plugins[key];
      if (!Array.isArray(installs) || installs.length === 0) {
        copies.push(broken(`the ${safe(key)} entry`, "", `the ${safe(key)} entry carries no usable installPath`));
        continue;
      }
      for (const install of installs as unknown[]) {
        const path = typeof install === "object" && install !== null ? (install as Record<string, unknown>)["installPath"] : undefined;
        if (typeof path !== "string" || path === "") {
          copies.push(broken(`the ${safe(key)} entry`, "", `the ${safe(key)} entry carries no usable installPath`));
        } else if (CONTROL.test(path)) {
          // One install, refused whole: never split at the control character, never read.
          copies.push(broken(label, path, `the ${safe(key)} entry's installPath carries a control character; never read`));
        } else {
          judgePath(path, label);
        }
      }
    }
  }
  // The first-party skills-directory install: usually a link to a checkout.
  const skills = join(context.configDir, "skills", context.plugin);
  // Only ENOENT is absence here too: a loop or a malformed path is broken,
  // a permission error wiring -- judgePath's own lstat says which.
  let present = true;
  try {
    lstatSync(skills);
  } catch (error) {
    present = classifyError(error) !== "absent";
  }
  if (present) judgePath(skills, `skills/${context.plugin}`);
  if (context.independentSource !== null && !sawSource) throw new PluginCheckError(INDEPENDENT_UNREAD);
  return { verdict: overallVerdict(copies), record: record.state, copies };
}
