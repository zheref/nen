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
// FACTS READ 2026-09-10, and each row's `source`/`agentSource` names the page.
// These are OTHER PEOPLE'S products and they move; when a row goes wrong the fix
// is to re-read the page in the row and change the row, and nothing else.
//
// WHAT IS *NOT* IN THE TABLE, deliberately: the SOURCE side's own conventions.
// The prefix a source repository spells its invocations with is that
// repository's name for itself -- `--invocation-prefix` is a flag for exactly
// the reason ../canon/command.ts's `--header-template` is one (§3: a binary
// hard-codes no system's vocabulary). The table says what a surface SPELLS an
// invocation AS, which is a documented fact about the surface; it does not say
// what the caller's own looks like.

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
    };

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

export const SURFACES: readonly SurfaceRow[] = [
  {
    surface: "codex",
    summary: "SKILL.md under .agents/skills/<name>/, personas folded into one AGENTS.md",
    skillsPath: ".agents/skills/<name>/SKILL.md",
    // "The SKILL.md file must include name and description" -- and the page
    // documents no other frontmatter key at all. Everything a richer surface
    // carries in frontmatter is dropped rather than passed through: an
    // undocumented key is a key whose handling is undocumented too.
    skillKeys: ["name", "description"],
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
    },
    source: "https://learn.chatgpt.com/docs/build-skills",
    agentSource: "https://learn.chatgpt.com/docs/agent-configuration/agents-md",
    caveat:
      "this surface ALSO documents standalone per-agent TOML files under .codex/agents/ (name, description, developer_instructions), which this verb does not write: it mirrors markdown to markdown, and a persona lands in AGENTS.md as prose. See https://learn.chatgpt.com/docs/agent-configuration/subagents",
  },
  {
    surface: "cursor",
    summary: "SKILL.md under .cursor/skills/<name>/, one markdown subagent file per persona",
    skillsPath: ".cursor/skills/<name>/SKILL.md",
    // The documented frontmatter table, whole: two required and five optional.
    // `globs` is carried alongside `paths` because the page names it as the
    // still-accepted legacy alias -- dropping it would silently unscope a
    // skill that used the older spelling.
    skillKeys: ["name", "description", "paths", "globs", "disable-model-invocation", "icon", "color", "metadata"],
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
    source: "https://cursor.com/docs/skills",
    agentSource: "https://cursor.com/docs/agent/subagents",
    caveat:
      "this surface documents that a skill's `name` must be lowercase letters, numbers and hyphens and must match its folder name; nen mirrors the folder name and the `name` line it was given, and refuses neither",
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
