// src/surface/packs.ts -- the files a surface mirror carries BESIDE the skills
// and personas: a hook manifest, a rules file, a permission pack, a default-
// subagent-model fragment (zheref/nen#227). Each is read from ONE caller-named
// source and rendered in the shape the row in ./rules.ts documents.
//
// NOTHING HERE DECIDES A POLICY. `--permissions` transcribes an allowlist the
// caller wrote; `--hooks` renames the events of a manifest the caller wrote;
// `--models` copies an alias the caller's workflow declares. The renderers
// know a SHAPE (where the vendor's page says a command goes) and never a
// VALUE (which command). That is the same line ../canon/mirror.ts draws
// between a template and its bindings.
//
// THE MARKER, PER FILE TYPE. Every emitted file carries the generation marker
// so ./mirror.ts's `check` and `generate` treat it as their own (the universe
// rule): as an HTML comment in markdown, as a `# ` line-1 comment in TOML, and
// in JSON -- which has no comment -- as a top-level `"$generated"` key holding
// the marker's text. `$`-prefixed keys are the convention every consumer of
// these files already ignores (`$schema`, `$comment`), so the key is read by
// nen and by nobody else. ./mirror.ts's `readMarker` reads all three.

import { readFileSync } from "node:fs";
import { basename, extname } from "node:path";
import { parseModels } from "../schema/workflow.js";
import { hasValue, inlineValue, type FrontmatterEntry } from "./frontmatter.js";
import type { SurfaceRow } from "./rules.js";

/** A refusal this module raises; ./mirror.ts re-raises it and the command layer exits 2. */
export class SurfacePackError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfacePackError";
  }
}

function readJsonFile(flag: string, path: string): unknown {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    throw new SurfacePackError(
      `--${flag} '${path}' could not be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}.`,
    );
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (error) {
    throw new SurfacePackError(`--${flag} '${path}' is not JSON: ${(error as Error).message}.`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Versions (the stamp)
// ---------------------------------------------------------------------------

const VERSION_RE = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

/** A stamp is `MAJOR.MINOR.PATCH`, optionally with a `-pre`/`+build` tail that is ignored. */
export function isVersion(value: string): boolean {
  return VERSION_RE.test(value);
}

/** -1, 0 or 1 over the three numeric components; the tail is ignored. */
export function compareVersions(left: string, right: string): number {
  const parse = (value: string): readonly number[] => {
    const match = VERSION_RE.exec(value);
    if (match === null) throw new SurfacePackError(`'${value}' is not a MAJOR.MINOR.PATCH version.`);
    return [Number(match[1]), Number(match[2]), Number(match[3])];
  };
  const a = parse(left);
  const b = parse(right);
  for (let index = 0; index < 3; index += 1) {
    const l = a[index] ?? 0;
    const r = b[index] ?? 0;
    if (l !== r) return l < r ? -1 : 1;
  }
  return 0;
}

// ---------------------------------------------------------------------------
// Hooks
// ---------------------------------------------------------------------------

export interface HookCommand {
  readonly command: string;
  readonly timeout: number | null;
}

export interface HookGroup {
  readonly matcher: string | null;
  readonly hooks: readonly HookCommand[];
}

/** The three events a Claude-Code-shaped manifest carries that every row maps. */
export const HOOK_EVENTS = ["Stop", "PreToolUse", "SessionStart"] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export interface HooksManifest {
  /** The file's own bytes, for the row whose shape is `verbatim`. */
  readonly text: string;
  readonly events: Readonly<Record<HookEvent, readonly HookGroup[]>>;
  /** Events the manifest carried that no row maps, named in the report. */
  readonly unmapped: readonly string[];
}

/**
 * Read a Claude-Code-shaped hooks manifest: `{ "hooks": { "<Event>": [ {
 * "matcher"?, "hooks": [ { "type": "command", "command", "timeout"? } ] } ] } }`
 * -- or the same object without the `hooks` wrapper, which is how the three
 * events appear inside a settings file.
 */
export function readHooksManifest(path: string): HooksManifest {
  const text = readFileSync(path, "utf8");
  const root = readJsonFile("hooks", path);
  if (!isRecord(root)) throw new SurfacePackError(`--hooks '${path}': the document is not an object.`);
  const table = isRecord(root["hooks"]) ? root["hooks"] : root;
  const events: Record<HookEvent, readonly HookGroup[]> = { Stop: [], PreToolUse: [], SessionStart: [] };
  const unmapped: string[] = [];
  for (const [event, groupsRaw] of Object.entries(table)) {
    if (event.startsWith("$") || event === "description") continue;
    if (!(HOOK_EVENTS as readonly string[]).includes(event)) {
      unmapped.push(event);
      continue;
    }
    if (!Array.isArray(groupsRaw)) {
      throw new SurfacePackError(`--hooks '${path}': hooks.${event} is not an array.`);
    }
    events[event as HookEvent] = groupsRaw.map((groupRaw, groupIndex): HookGroup => {
      const pointer = `hooks.${event}[${groupIndex}]`;
      if (!isRecord(groupRaw)) throw new SurfacePackError(`--hooks '${path}': ${pointer} is not an object.`);
      const matcher = groupRaw["matcher"];
      if (matcher !== undefined && typeof matcher !== "string") {
        throw new SurfacePackError(`--hooks '${path}': ${pointer}.matcher is not a string.`);
      }
      const hooksRaw = groupRaw["hooks"];
      if (!Array.isArray(hooksRaw) || hooksRaw.length === 0) {
        throw new SurfacePackError(`--hooks '${path}': ${pointer}.hooks is not a non-empty array.`);
      }
      const hooks = hooksRaw.map((hookRaw, hookIndex): HookCommand => {
        const at = `${pointer}.hooks[${hookIndex}]`;
        if (!isRecord(hookRaw)) throw new SurfacePackError(`--hooks '${path}': ${at} is not an object.`);
        const command = hookRaw["command"];
        if (typeof command !== "string" || command.trim() === "") {
          throw new SurfacePackError(`--hooks '${path}': ${at}.command is not a non-empty string.`);
        }
        const timeout = hookRaw["timeout"];
        if (timeout !== undefined && (typeof timeout !== "number" || !Number.isInteger(timeout) || timeout <= 0)) {
          throw new SurfacePackError(`--hooks '${path}': ${at}.timeout is not a positive integer.`);
        }
        return { command, timeout: typeof timeout === "number" ? timeout : null };
      });
      return { matcher: typeof matcher === "string" ? matcher : null, hooks };
    });
  }
  return { text, events, unmapped: unmapped.sort() };
}

type HooksRule = NonNullable<SurfaceRow["hooks"]>;

/** The manifest in the row's shape, as file content. */
export function renderHooks(rule: HooksRule, manifest: HooksManifest, marker: string): string {
  if (rule.shape === "verbatim") return manifest.text;
  const rendered: Record<string, unknown> = {};
  for (const event of HOOK_EVENTS) {
    const groups = manifest.events[event];
    if (groups.length === 0) continue;
    const name = rule.events[event];
    if (rule.shape === "cursor-v1") {
      rendered[name] = groups.flatMap((group): readonly Record<string, unknown>[] =>
        group.hooks.map((hook): Record<string, unknown> => ({ command: hook.command })),
      );
      continue;
    }
    rendered[name] = groups.map((group): Record<string, unknown> => ({
      ...(group.matcher !== null && rule.matcher !== null ? { matcher: rule.matcher } : {}),
      hooks: group.hooks.map((hook): Record<string, unknown> => ({
        type: "command",
        command: hook.command,
        ...(hook.timeout === null ? {} : { timeout: hook.timeout }),
      })),
    }));
  }
  const document: Record<string, unknown> =
    rule.shape === "cursor-v1"
      ? { $generated: marker, version: 1, hooks: rendered }
      : { $generated: marker, hooks: rendered };
  return `${JSON.stringify(document, null, 2)}\n`;
}

// ---------------------------------------------------------------------------
// Permissions
// ---------------------------------------------------------------------------

export interface PermissionRule {
  readonly exe: string;
  readonly args: string;
}

export interface PermissionsSource {
  readonly allow: readonly PermissionRule[];
  readonly deny: readonly PermissionRule[];
}

/** `{ "allow": [ { "exe", "args" } ], "deny": [ ... ] }`; every other key is ignored. */
export function readPermissions(path: string): PermissionsSource {
  const root = readJsonFile("permissions", path);
  if (!isRecord(root)) throw new SurfacePackError(`--permissions '${path}': the document is not an object.`);
  const list = (key: "allow" | "deny"): readonly PermissionRule[] => {
    const raw = root[key];
    if (raw === undefined) return [];
    if (!Array.isArray(raw)) throw new SurfacePackError(`--permissions '${path}': ${key} is not an array.`);
    return raw.map((entry, index): PermissionRule => {
      const pointer = `${key}[${index}]`;
      if (!isRecord(entry)) throw new SurfacePackError(`--permissions '${path}': ${pointer} is not an object.`);
      const exe = entry["exe"];
      const args = entry["args"];
      if (typeof exe !== "string" || exe.trim() === "") {
        throw new SurfacePackError(`--permissions '${path}': ${pointer}.exe is not a non-empty string.`);
      }
      if (typeof args !== "string") {
        throw new SurfacePackError(`--permissions '${path}': ${pointer}.args is not a string.`);
      }
      return { exe, args };
    });
  };
  return { allow: list("allow"), deny: list("deny") };
}

const pattern = (tool: string, rule: PermissionRule): string =>
  `${tool}(${rule.args === "" ? rule.exe : `${rule.exe} ${rule.args}`})`;

const NOT_ROOT_SCOPED =
  "Patterns, not roots: this surface has no root-scoping syntax. Scope = this file lives in this checkout and applies to sessions opened here; an allowed command pointed at another checkout is not refused by it.";

type PermissionsRule = NonNullable<SurfaceRow["permissions"]>;

/** The pack in the row's shape, as file content. */
export function renderPermissions(rule: PermissionsRule, source: PermissionsSource, marker: string): string {
  switch (rule.shape) {
    case "claude-settings":
      return `${JSON.stringify(
        {
          $generated: marker,
          $comment: NOT_ROOT_SCOPED,
          permissions: {
            allow: source.allow.map((entry): string => pattern("Bash", entry)),
            deny: source.deny.map((entry): string => pattern("Bash", entry)),
          },
        },
        null,
        2,
      )}\n`;
    case "cursor-cli-json":
      return `${JSON.stringify(
        {
          $generated: marker,
          $comment: NOT_ROOT_SCOPED,
          permissions: {
            allow: [...source.allow.map((entry): string => pattern("Shell", entry)), "Read(./**)", "Write(./**)"],
            deny: source.deny.map((entry): string => pattern("Shell", entry)),
          },
        },
        null,
        2,
      )}\n`;
    case "codex-toml":
      // The allow/deny rows have no Codex spelling: its boundary is the
      // sandbox, not a command pattern, so the pack states the sandbox and the
      // roots are left for the consumer to fill (they are the consumer's
      // checkout paths, which this verb does not know).
      return [
        `# ${marker}`,
        "# LOADS ONLY FOR A PROJECT THE USER MARKED TRUSTED (projects.<path>.trust_level).",
        "# approval_policy 'on-failure' prompts only when a command the sandbox refused",
        "# needs to run outside it; inside the writable roots nothing prompts.",
        'approval_policy = "on-failure"',
        'sandbox_mode = "workspace-write"',
        "",
        "[sandbox_workspace_write]",
        "# The working tree, every linked worktree, and the git common directory.",
        'writable_roots = ["<the working tree>", "<each linked worktree>", "<the git common dir>"]',
        "network_access = true",
        "",
      ].join("\n");
  }
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

export interface RulesSource {
  /** The source file's stem, which names the rules file. */
  readonly stem: string;
  readonly text: string;
}

export function readRules(path: string): RulesSource {
  try {
    return { stem: basename(path, extname(path)), text: readFileSync(path, "utf8") };
  } catch (error) {
    throw new SurfacePackError(
      `--rules '${path}' could not be read: ${(error as NodeJS.ErrnoException).code ?? String(error)}.`,
    );
  }
}

type RulesRule = NonNullable<SurfaceRow["rules"]>;

export interface RenderedRules {
  readonly path: string;
  readonly content: string;
  readonly chars: number;
  readonly lines: number;
}

/**
 * The rules file at `<dir>/<stem><extension>`, frontmatter (if the row has
 * one) then marker then the source verbatim. Over the row's `limit` it is
 * REFUSED with the two numbers: the surface would truncate it silently, and
 * a rules file whose tail the surface never reads is a rule nobody enforces.
 */
export function renderRules(rule: RulesRule, source: RulesSource, marker: string): RenderedRules {
  const front = rule.frontmatter === null ? "" : rule.frontmatter.replace("{name}", source.stem);
  const content = `${front}<!-- ${marker} -->\n${source.text}`;
  const chars = content.length;
  const path = `${rule.dir}/${source.stem}${rule.extension}`;
  if (rule.limit !== null && chars > rule.limit) {
    throw new SurfacePackError(
      `--rules '${source.stem}' renders to ${chars} characters at ${path}, over the ${rule.limit}-character limit the surface documents (${rule.source}). The surface would truncate it silently; shorten the source instead -- nen never cuts a rules file.`,
    );
  }
  return { path, content, chars, lines: content.split("\n").length };
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

export interface ModelMaps {
  /** `models.<surface>`: tier -> the TARGET surface's alias. */
  readonly target: Readonly<Record<string, string>>;
  /** The target surface's name, for a pointer. */
  readonly surface: string;
  /**
   * `models.<source-surface>`: tier -> the alias the SOURCE personas carry,
   * or null when the file declares none for that surface (refused only when a
   * persona actually needs the reverse lookup).
   */
  readonly source: Readonly<Record<string, string>> | null;
  readonly sourceSurface: string;
  /** Every surface the file declares, for the refusal that names them. */
  readonly known: readonly string[];
}

/**
 * `models.<surface>` and `models.<source-surface>` of the workflow file.
 *
 * WHY TWO MAPS. A canonical persona file is read directly by the surface it
 * was written for, so its `model:` carries THAT surface's alias (`opus`), not
 * a tier name -- rewriting the source to tiers would break the surface that
 * reads it unmirrored. The mirror therefore resolves a value in two steps:
 * alias -> tier through the source surface's row of the same matrix, then
 * tier -> alias through the target's. A tier name written directly is
 * accepted as-is, so a persona may say either.
 */
export function readModelMaps(path: string, surface: string, sourceSurface: string): ModelMaps {
  const root = readJsonFile("models", path);
  if (!isRecord(root)) throw new SurfacePackError(`--models '${path}': the document is not an object.`);
  let policy;
  try {
    policy = parseModels(path, root["models"]);
  } catch (error) {
    throw new SurfacePackError(`--models '${path}': ${(error as Error).message}`);
  }
  const known = Object.keys(policy.surfaces);
  const target = policy.surfaces[surface];
  if (target === undefined) {
    throw new SurfacePackError(
      `--models '${path}' declares no 'models.${surface}' -- the tier-to-alias map this surface's personas are rewritten through. Known surfaces in the file: ${known.join(", ") || "(none)"}.`,
    );
  }
  return { target, surface, source: policy.surfaces[sourceSurface] ?? null, sourceSurface, known };
}

export interface ModelRewrite {
  /** The entries with `model:` rewritten, or removed. */
  readonly entries: readonly FrontmatterEntry[];
  /** The alias written, `inherit`, or null when the key was absent or dropped. */
  readonly alias: string | null;
  /** True when `model: inherit` was dropped because the row documents no inherit. */
  readonly droppedInherit: boolean;
  /** An alias outside the row's documented set, or null. */
  readonly undocumentedAlias: string | null;
}

/**
 * The tier a persona's `model:` value names: the value itself when it is a
 * tier of the target map, else the ONE tier of the source surface's map whose
 * alias it is. Refused by pointer when it is neither, or when the alias sits
 * under more than one tier (the source row is ambiguous, and picking one
 * would be nen choosing a model).
 */
export function resolveTier(maps: ModelMaps, value: string, relative: string): string {
  if (maps.target[value] !== undefined) return value;
  if (maps.source === null) {
    throw new SurfacePackError(
      `'${relative}' says 'model: ${value}', which is not a tier of 'models.${maps.surface}' (${Object.keys(maps.target).join(", ")}), and --models declares no 'models.${maps.sourceSurface}' to read it back through as an alias (--source-surface). Known surfaces in the file: ${maps.known.join(", ")}.`,
    );
  }
  const tiers = Object.entries(maps.source)
    .filter(([, alias]): boolean => alias === value)
    .map(([tier]): string => tier);
  if (tiers.length === 1) return tiers[0] ?? value;
  if (tiers.length > 1) {
    throw new SurfacePackError(
      `'${relative}' says 'model: ${value}', which 'models.${maps.sourceSurface}' lists under ${tiers.length} tiers (${tiers.join(", ")}); an alias has to name exactly one tier to be read back. Fix the workflow or write the tier in the persona.`,
    );
  }
  throw new SurfacePackError(
    `'${relative}' says 'model: ${value}', which is neither a tier of 'models.${maps.surface}' (${Object.keys(maps.target).join(", ")}) nor an alias under 'models.${maps.sourceSurface}' (${Object.values(maps.source).join(", ") || "(none)"}). Add it to the workflow or fix the persona; nen does not guess a model.`,
  );
}

/**
 * A persona's `model:` through the maps: alias or tier -> tier -> the target
 * surface's alias. `inherit` is carried where the row documents it and
 * dropped otherwise; anything unresolvable is refused by pointer.
 */
export function rewriteModel(
  row: SurfaceRow,
  maps: ModelMaps,
  entries: readonly FrontmatterEntry[],
  relative: string,
): ModelRewrite {
  const entry = entries.find((candidate): boolean => candidate.key === "model");
  if (entry === undefined || !hasValue(entries, "model")) {
    return { entries, alias: null, droppedInherit: false, undocumentedAlias: null };
  }
  const value = inlineValue(entry);
  if (value === "inherit") {
    if (row.inheritModel) return { entries, alias: "inherit", droppedInherit: false, undocumentedAlias: null };
    return {
      entries: entries.filter((candidate): boolean => candidate !== entry),
      alias: null,
      droppedInherit: true,
      undocumentedAlias: null,
    };
  }
  const tier = resolveTier(maps, value, relative);
  const alias = maps.target[tier];
  /* c8 ignore next 3 -- resolveTier returns only a key of the target map */
  if (alias === undefined) {
    throw new SurfacePackError(`'${relative}': tier '${tier}' has no 'models.${row.surface}.${tier}'.`);
  }
  const rewritten = entries.map((candidate): FrontmatterEntry =>
    candidate === entry ? { key: "model", lines: [`model: ${alias}`] } : candidate,
  );
  const documented = row.modelAliases === null || row.modelAliases.includes(alias);
  return { entries: rewritten, alias, droppedInherit: false, undocumentedAlias: documented ? null : alias };
}

// ---------------------------------------------------------------------------
// TOML
// ---------------------------------------------------------------------------

/** A TOML basic string, one line: `\`, `"` and control characters escaped. */
export function tomlString(value: string): string {
  let out = '"';
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === '"') out += '\\"';
    else if (char === "\\") out += "\\\\";
    else if (char === "\n") out += "\\n";
    else if (char === "\t") out += "\\t";
    else if (char === "\r") out += "\\r";
    else if (code < 0x20 || code === 0x7f) out += `\\u${code.toString(16).padStart(4, "0")}`;
    else out += char;
  }
  return `${out}"`;
}

/**
 * A TOML multi-line basic string carrying `value` line for line. Only `\` and
 * a run of three quotes need escaping inside `"""`; a control character other
 * than newline and tab is escaped as in `tomlString`.
 */
export function tomlMultiline(value: string): string {
  let body = "";
  for (const char of value) {
    const code = char.charCodeAt(0);
    if (char === "\\") body += "\\\\";
    else if (char === "\n" || char === "\t") body += char;
    else if (code < 0x20 || code === 0x7f) body += `\\u${code.toString(16).padStart(4, "0")}`;
    else body += char;
  }
  body = body.replace(/"""/g, '""\\"');
  return `"""\n${body}${body.endsWith("\n") ? "" : "\n"}"""`;
}
