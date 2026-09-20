// src/surface/rules.ts -- ONE TABLE. Every difference between the surfaces
// nen can mirror a skills directory into is a FIELD OF A ROW here, and adding a
// surface is adding a row -- never a branch in ./mirror.ts.
//
// WHY THE TABLE IS THE DESIGN. The differences are small and numerous: one
// surface reads seven frontmatter keys and the other reads two; one spells an
// invocation `/name` and the other `$name`; one keeps personas as their own
// markdown files and the other has no markdown persona file at all. Written as
// code, that is four `if (surface === ...)` sites in three functions, and the
// fifth difference the next surface brings gets bolted onto whichever one its
// author happened to be reading. Written as a row, a surface is a thing you can
// READ, diff, and check against its own documentation -- which is the second
// reason for the shape: every row carries the URL each fact came from, so a
// claim about somebody else's product is a citation rather than a memory.
//
// FACTS READ 2026-09-10 (skills, personas) AND 2026-09-20 (hooks, rules,
// permissions, model maps; zheref/nen#227), and each row's `source`,
// `agentSource` and per-block `source` names the page. These are OTHER PEOPLE'S
// products and they move; when a row goes wrong the fix is to re-read the page
// in the row and change the row, and nothing else. A number a page does NOT
// state (the two description budgets) says so in its own `source` string:
// "measured" is not "documented", and a reader is entitled to the difference.
//
// WHAT IS *NOT* IN THE TABLE, deliberately: the SOURCE side's own conventions.
// The prefix a source repository spells its invocations with is that
// repository's name for itself -- `--invocation-prefix` is a flag for exactly
// the reason ../canon/command.ts's `--header-template` is one (§3: a binary
// hard-codes no system's vocabulary). The table says what a surface SPELLS an
// invocation AS, which is a documented fact about the surface; it does not say
// what the caller's own looks like. The same rule names the rules file after
// the SOURCE file's own stem and the summary key's content after the skill's
// own first sentence: nothing in a row is a word the caller's repository chose.

/** How a surface carries a persona definition. */
export type AgentRule =
  | {
      /** One markdown file per persona, in a directory the surface scans. */
      readonly kind: "files";
      /** Directory under `--out`, `/`-separated. */
      readonly dir: string;
      /** Appended to the persona's name to make the filename. */
      readonly extension: string;
      /** Frontmatter keys the surface documents for a persona file. */
      readonly keys: readonly string[];
      /** Of those, the ones without which the surface cannot load it. */
      readonly required: readonly string[];
    }
  | {
      /**
       * No per-persona file: every persona becomes a section of ONE markdown
       * document the surface reads as prose.
       */
      readonly kind: "appendix";
      /** The single file, relative to `--out`. */
      readonly file: string;
      /** `#` repeated this many times before a persona's name. */
      readonly headingLevel: number;
      /** Frontmatter is not a concept in this file; it is prose. */
      readonly keys: readonly string[];
      readonly required: readonly string[];
      /**
       * The size past which the surface documents that it stops READING the
       * document, in bytes, or null. Never a refusal -- the surface truncates,
       * it does not fail -- but the generate report names an appendix over it,
       * because a persona past the cut-off is a persona the surface never met.
       */
      readonly warnBytes: number | null;
    };

/**
 * How a surface's hook manifest is laid out, once the events are renamed.
 *
 * - `verbatim`: the input manifest IS the output, byte for byte (the row whose
 *   source is a Claude Code plugin has nothing to translate).
 * - `groups`: `{ "hooks": { "<Event>": [ { "matcher"?, "hooks": [ { "type",
 *   "command", "timeout"? } ] } ] } }` -- Claude Code's own grouping, which the
 *   surfaces that copied their hook design from it read too.
 * - `cursor-v1`: `{ "version": 1, "hooks": { "<event>": [ { "command" } ] } }`
 *   -- one flat command per entry, no matcher, no timeout.
 */
export type HookShape = "verbatim" | "groups" | "cursor-v1";

/** The permission-pack file shapes this binary knows how to write. */
export type PermissionShape = "claude-settings" | "codex-toml" | "cursor-cli-json";

export interface SurfaceRow {
  /** The `--surface` value that selects this row. */
  readonly surface: string;
  /** One line, for `--help` and for the refusal that lists the known surfaces. */
  readonly summary: string;
  /**
   * Where the surface reads a PROJECT's skills from. Documentation only -- nen
   * writes wherever `--out` says. It is carried so a caller can be told, in the
   * generate report, which directory the mirror it just produced belongs in.
   */
  readonly skillsPath: string;
  /**
   * The directory UNDER `--out` the `<name>/SKILL.md` files go in, `""` for the
   * root of `--out` itself. The three mirrored surfaces write skills at the
   * root because a consumer stages the mirror and places it; the `claude-code`
   * row writes `skills/` because its layout is the plugin's own and `--installed`
   * compares a whole plugin tree.
   */
  readonly skillsDir: string;
  /** Frontmatter keys the surface documents for a SKILL.md. Every other key is dropped. */
  readonly skillKeys: readonly string[];
  /** Of those, the ones the surface documents as required. A source missing one is refused. */
  readonly skillRequired: readonly string[];
  /**
   * How the surface spells "invoke the skill named <name>", with `{name}`
   * standing for the skill's own name -- or `null` where the surface documents
   * no explicit spelling, in which case an invocation mention is carried
   * through UNCHANGED rather than rewritten into a spelling nobody documented.
   */
  readonly invocation: string | null;
  readonly agents: AgentRule;
  /**
   * A second, machine-readable persona emission beside the appendix (Codex's
   * `.codex/agents/<name>.toml`), or null. Written only when `--models` is
   * given: the file's one field the appendix cannot carry is `model`, and a
   * model line copied from the source unmapped would be another surface's
   * alias handed to this one.
   */
  readonly agentToml: {
    readonly dir: string;
    readonly documentedPath: string;
    readonly source: string;
  } | null;
  /**
   * The surface's hook manifest, or null where the surface documents no hooks
   * (in which case `--hooks` emits nothing and the report says
   * `hooks: not supported`). `events` maps the three Claude-Code-shaped events
   * a `--hooks` manifest carries to the surface's own names; `known` is every
   * event the surface documents, for `nen surface capabilities`; `matcher` is
   * what a `PreToolUse` group's `Bash` matcher becomes, or null to drop it.
   */
  readonly hooks: {
    readonly file: string;
    readonly documentedPath: string;
    /**
     * Where the hook SCRIPTS a command references land under `--out`, so a
     * plugin-mode install (the mirror symlinked as the plugin root) resolves
     * them; null on the verbatim row, whose scripts are the source's own.
     */
    readonly scriptsDir: string | null;
    readonly events: { readonly Stop: string; readonly PreToolUse: string; readonly SessionStart: string };
    readonly known: readonly string[];
    readonly matcher: string | null;
    readonly decisionKey: string;
    readonly shape: HookShape;
    readonly source: string;
  } | null;
  /**
   * Whether a persona's `model: <tier>` is rewritten to `models.<surface>.<tier>`
   * from `--models <nen/workflow.json>`. False where the surface's persona
   * files carry no model key nen writes (the appendix).
   */
  readonly agentModelMap: boolean;
  /** Whether the surface documents `model: inherit`; a persona saying so is carried as-is where true and dropped, with a report line, where false. */
  readonly inheritModel: boolean;
  /**
   * The model values the surface documents, or null for an open id space. An
   * alias from `--models` outside this list is emitted verbatim -- the
   * repository's alias is its own -- and named in the generate report.
   */
  readonly modelAliases: readonly string[] | null;
  /**
   * A configuration FRAGMENT naming the default subagent model, or null. The
   * consumer merges it: this verb never writes a surface's live config file
   * (a marked fragment beside it, never `config.toml` itself).
   */
  readonly subagentModelFragment: {
    readonly file: string;
    readonly documentedPath: string;
    /** The tier of `models.<surface>` the default is read from. */
    readonly tier: string;
    readonly source: string;
  } | null;
  /**
   * The surface's rules file, or null. `--rules <source.md>` lands at
   * `<dir>/<source stem><extension>`; `frontmatter` (with `{name}` as the stem)
   * is prepended where the surface reads one; a rendering over `limit`
   * characters is REFUSED at exit 2, never truncated silently; `lineGuidance`
   * is advice the page gives, reported and never enforced.
   */
  readonly rules: {
    readonly dir: string;
    readonly extension: string;
    readonly documentedPath: string;
    readonly limit: number | null;
    readonly lineGuidance: number | null;
    readonly frontmatter: string | null;
    readonly source: string;
  } | null;
  /**
   * The length past which a skill's `description` is not shown whole, in
   * characters, or null. A longer description is kept AS-IS and a `summary:`
   * key holding its first sentence trimmed to the budget is ADDED (so
   * `summary` is in `skillKeys` wherever this is set); the generate report
   * lists each such skill in `truncated[]`. `descriptionBudgetSource` says
   * where the number came from -- and says "measured" where no page states it.
   */
  readonly descriptionBudget: number | null;
  readonly descriptionBudgetSource: string | null;
  /**
   * The permission pack, or null where the surface offers no allowlist file.
   * Written from `--permissions <contracts/permissions.json>` in the row's
   * shape at `<out>/<file>`.
   */
  readonly permissions: {
    readonly file: string;
    readonly documentedPath: string;
    readonly shape: PermissionShape;
    readonly source: string;
  } | null;
  /**
   * The surface's plugin manifest, or null. `--manifest <plugin.json>` reads a
   * Claude plugin manifest and emits `<out>/<file>` carrying `keys` from it;
   * `required` are the ones the surface documents as required.
   */
  readonly pluginManifest: {
    readonly file: string;
    readonly keys: readonly string[];
    readonly required: readonly string[];
    readonly source: string;
  } | null;
  /**
   * True for the one row whose generation is the IDENTITY: every key kept, no
   * marker inserted, nothing rewritten. It exists for `check --installed`
   * (an installed plugin copy compared against its source) and for a mirror
   * that IS the source; `generate` refuses it, because there is nothing to
   * generate and no marker to protect a destination with.
   */
  readonly verbatim: boolean;
  /** The page the skill half of this row was read from. */
  readonly source: string;
  /** The page the persona half was read from. */
  readonly agentSource: string;
  /**
   * A fact about this surface a caller should know that the fields above cannot
   * express -- printed with the generate report, never acted on.
   */
  readonly caveat: string;
}

/**
 * The documented rules-file ceiling on Antigravity: "Rules files are limited to
 * 12,000 characters each." Read 2026-09-20 from
 * https://antigravity.google/docs/rules-workflows.
 */
export const ANTIGRAVITY_RULES_LIMIT = 12_000;

/**
 * The two description budgets no page states. Measured 2026-09-19 in the
 * hardening audit (the length at which each surface's skill picker cut the
 * description off), not documented by either vendor -- which is why they are
 * constants with this comment rather than facts with a URL.
 */
export const CODEX_DESCRIPTION_BUDGET = 186;
export const CURSOR_DESCRIPTION_BUDGET = 30;
const MEASURED = "measured 2026-09-19, not documented (hardening audit)";

/** Codex's `project_doc_max_bytes` default: the AGENTS.md read stops here. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32_768;

export const SURFACES: readonly SurfaceRow[] = [
  {
    surface: "codex",
    summary: "SKILL.md under .agents/skills/<name>/, personas folded into one AGENTS.md",
    skillsPath: ".agents/skills/<name>/SKILL.md",
    skillsDir: "",
    // "The SKILL.md file must include name and description" -- and the page
    // documents no other frontmatter key at all. Everything a richer surface
    // carries in frontmatter is dropped rather than passed through: an
    // undocumented key is a key whose handling is undocumented too. `summary`
    // is nen's own addition under `descriptionBudget` (an extra key the
    // surface ignores, holding the sentence its picker would otherwise cut).
    skillKeys: ["name", "description", "summary"],
    skillRequired: ["name", "description"],
    // "run /skills or type $ to mention a skill" -- the documented explicit
    // spelling is `$<name>`.
    invocation: "${name}",
    agents: {
      kind: "appendix",
      file: "AGENTS.md",
      headingLevel: 2,
      keys: [],
      required: [],
      warnBytes: CODEX_PROJECT_DOC_MAX_BYTES,
    },
    agentToml: {
      dir: "agents",
      documentedPath: ".codex/agents/<name>.toml",
      source: "https://learn.chatgpt.com/docs/agent-configuration/subagents",
    },
    hooks: {
      file: "hooks.json",
      documentedPath: ".codex/hooks.json",
      scriptsDir: "hooks",
      events: { Stop: "Stop", PreToolUse: "PreToolUse", SessionStart: "SessionStart" },
      known: [
        "SessionStart",
        "SubagentStart",
        "PreToolUse",
        "PermissionRequest",
        "PostToolUse",
        "PreCompact",
        "PostCompact",
        "UserPromptSubmit",
        "SubagentStop",
        "Stop",
        "Interrupt",
        "SessionEnd",
      ],
      // The page's own example is `{ "hooks": { "PreToolUse": [ { "matcher":
      // "Bash", "hooks": [ ... ] } ] } }` -- Claude Code's grouping under a
      // `hooks` wrapper, matcher `Bash`. Verified against the page 2026-09-20.
      matcher: "Bash",
      decisionKey: "hookSpecificOutput.permissionDecision: deny (ask is parsed but not supported yet)",
      shape: "groups",
      source: "https://learn.chatgpt.com/docs/hooks",
    },
    agentModelMap: false,
    inheritModel: false,
    modelAliases: null,
    subagentModelFragment: {
      file: "config.toml.fragment",
      documentedPath: ".codex/config.toml ([agents] default_subagent_model)",
      tier: "fast",
      source: "https://learn.chatgpt.com/docs/config-file/config-reference",
    },
    rules: null,
    descriptionBudget: CODEX_DESCRIPTION_BUDGET,
    descriptionBudgetSource: MEASURED,
    permissions: {
      file: "config.toml",
      documentedPath: ".codex/config.toml",
      shape: "codex-toml",
      source: "https://learn.chatgpt.com/docs/config-file/config-reference",
    },
    pluginManifest: null,
    verbatim: false,
    source: "https://learn.chatgpt.com/docs/build-skills",
    agentSource: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
    caveat:
      "personas land in AGENTS.md as prose; the per-agent .codex/agents/<name>.toml files (name, description, developer_instructions, model) are written only with --models, because model is the one field the appendix cannot carry. A project .codex/config.toml loads only for a project the user marked trusted. See https://learn.chatgpt.com/docs/agent-configuration/subagents",
  },
  {
    surface: "cursor",
    summary: "SKILL.md under .cursor/skills/<name>/, one markdown subagent file per persona",
    skillsPath: ".cursor/skills/<name>/SKILL.md",
    skillsDir: "",
    // The documented frontmatter table, whole: two required and five optional.
    // `globs` is carried alongside `paths` because the page names it as the
    // still-accepted legacy alias -- dropping it would silently unscope a
    // skill that used the older spelling. `summary` is nen's addition (see codex).
    skillKeys: ["name", "description", "paths", "globs", "disable-model-invocation", "icon", "color", "metadata", "summary"],
    skillRequired: ["name", "description"],
    // "you explicitly type /skill-name in chat".
    invocation: "/{name}",
    agents: {
      kind: "files",
      dir: "agents",
      extension: ".md",
      // "Each subagent is a markdown file with YAML frontmatter", and the
      // documented keys are these five. Note what is NOT here: `color` and a
      // tool list are skill/other-surface concepts, so a persona file carrying
      // them arrives here with them dropped.
      keys: ["name", "description", "model", "readonly", "is_background"],
      // The page gives every subagent key a default (`name` falls back to the
      // filename), so none of them is required to load the file.
      required: [],
    },
    agentToml: null,
    hooks: {
      file: "hooks.json",
      documentedPath: ".cursor/hooks.json",
      scriptsDir: "hooks",
      events: { Stop: "stop", PreToolUse: "beforeShellExecution", SessionStart: "sessionStart" },
      known: [
        "sessionStart",
        "sessionEnd",
        "preToolUse",
        "postToolUse",
        "beforeShellExecution",
        "afterShellExecution",
        "afterFileEdit",
        "stop",
      ],
      matcher: null,
      decisionKey: "permission: allow|deny|ask",
      shape: "cursor-v1",
      source: "https://cursor.com/docs/agent/hooks",
    },
    agentModelMap: true,
    // "model: inherit" is valid and the default.
    inheritModel: true,
    modelAliases: null,
    subagentModelFragment: null,
    rules: {
      dir: "rules",
      // A plain .md under .cursor/rules is ignored; only .mdc is read.
      extension: ".mdc",
      documentedPath: ".cursor/rules/<stem>.mdc",
      limit: null,
      // "Keep rules under 500 lines" -- advice, not a ceiling.
      lineGuidance: 500,
      frontmatter: "---\ndescription: {name}\nalwaysApply: true\n---\n",
      source: "https://cursor.com/docs/context/rules",
    },
    descriptionBudget: CURSOR_DESCRIPTION_BUDGET,
    descriptionBudgetSource: MEASURED,
    permissions: {
      file: "cli.json",
      documentedPath: ".cursor/cli.json",
      shape: "cursor-cli-json",
      source: "https://cursor.com/docs/cli/reference/permissions",
    },
    pluginManifest: null,
    verbatim: false,
    source: "https://cursor.com/docs/context/skills",
    agentSource: "https://cursor.com/docs/agent/subagents",
    caveat:
      "this surface documents that a skill's `name` must be lowercase letters, numbers and hyphens and must match its folder name; nen mirrors the folder name and the `name` line it was given, and refuses neither",
  },
  {
    surface: "antigravity",
    summary: "SKILL.md under .agents/skills/<name>/, one markdown subagent file per persona",
    // ".agent/skills" is the back-compatibility spelling; the documented one is
    // `.agents/skills`.
    skillsPath: ".agents/skills/<name>/SKILL.md",
    skillsDir: "",
    // The page documents `description` as required and `name` as optional.
    skillKeys: ["name", "description"],
    skillRequired: ["description"],
    invocation: "/{name}",
    agents: {
      kind: "files",
      dir: "agents",
      extension: ".md",
      // The documented persona frontmatter, whole. `tools` is a list on this
      // surface; a source spelling it as one comma-joined line arrives as that
      // line, because this mirror carries a kept key verbatim (./frontmatter.ts).
      keys: ["name", "description", "tools", "mainAgent", "subagent", "model", "commandExecutionPolicy", "mcpServers", "skills"],
      required: ["description"],
    },
    agentToml: null,
    hooks: {
      file: "hooks.json",
      documentedPath: ".agents/hooks.json",
      scriptsDir: "hooks",
      // No SessionStart event exists here; PreInvocation is the closest
      // documented moment, and is what the consumer's own generator used.
      events: { Stop: "Stop", PreToolUse: "PreToolUse", SessionStart: "PreInvocation" },
      known: ["PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"],
      matcher: "run_command",
      decisionKey: "decision: allow|deny|ask|force_ask|deny_unless_prior_grant (+ reason)",
      shape: "groups",
      source: "https://antigravity.google/docs/hooks",
    },
    agentModelMap: true,
    inheritModel: true,
    // "Model tier used when invoked (inherit, flash, or pro)".
    modelAliases: ["inherit", "flash", "pro"],
    subagentModelFragment: null,
    rules: {
      dir: "rules",
      extension: ".md",
      documentedPath: ".agents/rules/<stem>.md",
      limit: ANTIGRAVITY_RULES_LIMIT,
      lineGuidance: null,
      frontmatter: null,
      source: "https://antigravity.google/docs/rules-workflows",
    },
    descriptionBudget: null,
    descriptionBudgetSource: null,
    // No allowlist file exists, and a per-persona `commandExecutionPolicy:
    // auto` would approve ARBITRARY commands rather than the declared set --
    // the first consumer's own review refused emitting it, and this
    // row keeps that: the pack on this surface is the hooks.
    permissions: null,
    // "plugin.json (required; $schema, name, description)"; version is
    // carried because a plugin without one cannot be told from its last.
    pluginManifest: {
      file: "plugin.json",
      keys: ["name", "version", "description"],
      required: ["name", "description"],
      source: "https://antigravity.google/docs/plugins",
    },
    verbatim: false,
    source: "https://antigravity.google/docs/skills",
    agentSource: "https://antigravity.google/docs/subagents",
    caveat:
      "this surface has no permission allowlist; `commandExecutionPolicy: auto` in a persona would approve arbitrary commands and is deliberately never emitted -- the first consumer's own review ruled so. Workflows are deprecated (retired 2026-11-01); the rules file is the prose surface",
  },
  {
    surface: "claude-code",
    summary: "the source's own plugin layout, copied verbatim -- for `check --installed`",
    skillsPath: ".claude/skills/<name>/SKILL.md",
    skillsDir: "skills",
    // VERBATIM: every key is kept, so the list is consulted only for the
    // required check. The two required keys are the documented ones.
    skillKeys: [],
    skillRequired: ["name", "description"],
    invocation: null,
    agents: {
      kind: "files",
      dir: "agents",
      extension: ".md",
      keys: [],
      required: [],
    },
    agentToml: null,
    hooks: {
      file: "hooks/hooks.json",
      documentedPath: "hooks/hooks.json (plugin) or .claude/settings.json",
      scriptsDir: null,
      events: { Stop: "Stop", PreToolUse: "PreToolUse", SessionStart: "SessionStart" },
      known: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "PreCompact", "SessionEnd"],
      matcher: "Bash",
      decisionKey: "hookSpecificOutput.permissionDecision: allow|deny|ask|defer",
      shape: "verbatim",
      source: "https://code.claude.com/docs/en/hooks",
    },
    agentModelMap: false,
    inheritModel: true,
    modelAliases: ["sonnet", "opus", "haiku", "fable", "inherit"],
    subagentModelFragment: null,
    rules: null,
    // The page documents 1,536 characters for description + when_to_use
    // combined, but a verbatim row adds no summary key: the number lives in
    // ./capabilities.ts, where it is a fact and not an instruction.
    descriptionBudget: null,
    descriptionBudgetSource: null,
    // "a plugin cannot ship permissions": the allowlist is the consumer's own
    // untracked settings.local.json, MERGED by the consumer's tooling. A whole
    // file is what this verb can write, so it writes one beside the mirror
    // for the consumer to merge.
    permissions: {
      file: "settings.local.json",
      documentedPath: ".claude/settings.local.json (permissions.allow / permissions.deny; merged, never placed)",
      shape: "claude-settings",
      source: "https://code.claude.com/docs/en/permissions",
    },
    pluginManifest: null,
    verbatim: true,
    source: "https://code.claude.com/docs/en/skills",
    agentSource: "https://code.claude.com/docs/en/sub-agents",
    caveat:
      "a plugin ships the same tree as skills/<name>/SKILL.md and agents/<name>.md at its root. This row is the identity: generate refuses it (nothing to generate, no marker to guard a destination with); check compares bytes, and check --installed compares an installed plugin copy against its source",
  },
];

export function findSurface(name: string): SurfaceRow | undefined {
  return SURFACES.find((row): boolean => row.surface === name);
}

/** Every surface name, for a refusal that lists what it would have accepted. */
export function surfaceNames(): readonly string[] {
  return SURFACES.map((row): string => row.surface);
}

/**
 * `row.invocation` with `{name}` filled in, or null where the surface documents
 * no spelling.
 */
export function invocationFor(row: SurfaceRow, name: string): string | null {
  return row.invocation === null ? null : row.invocation.replace("{name}", name);
}

/** `<skillsDir>/<name>/SKILL.md`, or `<name>/SKILL.md` when the row's skills sit at the root. */
export function skillPath(row: SurfaceRow, name: string): string {
  return row.skillsDir === "" ? `${name}/SKILL.md` : `${row.skillsDir}/${name}/SKILL.md`;
}
