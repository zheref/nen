// src/surface/capabilities.ts -- what each agent surface can DO, as data
// (zheref/nen#216).
//
// WHY A TABLE. Eight skills in the consumer plugin branch by hand on which
// picker, subagent and hook primitive a surface has, and every one of them
// carries the answer as prose that was true the day it was written. Codex and
// Cursor both shipped a Stop hook after the prose said they had none. A row
// here is a fact with a citation; a caller reads it and branches on data.
//
// FACTS READ 2026-09-19 AND RE-READ 2026-09-20 (zheref/nen#227), each row's
// `source` names the page. These are OTHER PEOPLE'S products and they move;
// when a row goes wrong the fix is to re-read the page and change the row,
// and nothing else.
//
// THIS TABLE AND ./rules.ts ANSWER DIFFERENT QUESTIONS about the same four
// surfaces. That one describes how nen MIRRORS a skills directory into a
// surface (which keys survive, where a file goes) and is read by the
// generator; this one describes what a surface OFFERS A RUNNING SESSION and
// is read by a skill deciding how to ask, raise, hook or notify. The five
// facts both need -- the hook events, the rules file and its limit, the
// description budget, the permission shape -- are stated here as data a
// skill can print, and there as the row constants the generator enforces.

import { ANTIGRAVITY_TOOL_NAMES, type ToolNameMap } from "./rules.js";

/**
 * The read-only fact for a surface whose control is a `tools` list written in
 * the surface's own tool names (zheref/nen#505): honoured once a name map
 * exists, because the generator then writes only mapped names (an unmapped one
 * is dropped and reported); unverified while none does, because the list
 * would arrive in names the surface does not document.
 */
export function toolListControl(map: ToolNameMap | null, source: string): { readonly control: string; readonly source: string } {
  if (map === null || map.entries.length === 0) {
    return { control: "unverified (no map from the source's tool names to this surface's own; the list would arrive in names the page does not document)", source };
  }
  const pairs = map.entries.map((entry): string => `${entry.from} -> ${entry.to}`).join(", ");
  return { control: `honoured (the persona's tools list, mapped to this surface's names: ${pairs}; any other name is dropped and reported)`, source };
}

export interface SurfaceCapabilities {
  readonly surface: string;
  /** The tool a session asks a human a multiple-choice question with, or null. */
  readonly ask: string | null;
  /** The primitive that raises an in-session subagent, or null. */
  readonly subagent: string | null;
  readonly hooks: {
    readonly file: string | null;
    readonly stop: string | null;
    readonly preToolUse: string | null;
    readonly sessionStart: string | null;
    /** The JSON key a PreToolUse hook answers with, and its allow/deny values. */
    readonly decisionKey: string | null;
  };
  /** Whether a subagent can be isolated in its own git worktree by the surface itself. */
  readonly worktreeIsolation: boolean;
  /**
   * Whether a session in a LINKED worktree must declare the main checkout's
   * git directory as an extra writable root before git can write (Codex's
   * `--add-dir` / `writable_roots`). False where the sandbox has no such
   * boundary.
   */
  readonly sandboxExtraRoots: boolean;
  /** Whether the surface can publish a page (an Artifact) from a session. */
  readonly artifact: boolean;
  /** Whether the surface pushes a turn-complete notification on its own. */
  readonly notify: boolean;
  /** Where a permission allowlist lives for this surface, or null. */
  readonly permissionsFile: string | null;
  /** The per-agent model key in a persona file, or null. */
  readonly agentModelKey: string | null;
  /** Every hook event the surface documents, in the page's own spelling. */
  readonly hookEvents: readonly string[];
  /** Where a rules file lives, or null where the surface documents none. */
  readonly rulesFile: string | null;
  /** The documented ceiling on one rules file, in characters, or null. */
  readonly rulesLimit: number | null;
  /**
   * The length past which a skill description is not shown whole, in
   * characters, or null; `descriptionBudgetSource` says whether a page states
   * it or the hardening audit measured it.
   */
  readonly descriptionBudget: number | null;
  readonly descriptionBudgetSource: string | null;
  /** The shape of the permission pack this binary writes for the surface, or null where it writes none. */
  readonly permissionsShape: string | null;
  /**
   * Whether a read-only persona (a `tools` list with no write tool) stays
   * read-only here, and the page that says so (zheref/nen#473): `honoured`,
   * `honoured at <placement>; <placement> unverified`, or `none documented`.
   * ./rules.ts `readOnlyControl` is what the generator does about it.
   */
  readonly readOnly: { readonly control: string; readonly source: string };
  readonly source: string;
  readonly caveat: string | null;
}

export const CAPABILITIES: readonly SurfaceCapabilities[] = [
  {
    surface: "claude-code",
    ask: "AskUserQuestion",
    subagent: "Agent",
    hooks: {
      file: "hooks/hooks.json (plugin) or .claude/settings.json",
      stop: "Stop",
      preToolUse: "PreToolUse",
      sessionStart: "SessionStart",
      decisionKey: "hookSpecificOutput.permissionDecision: allow|deny|ask|defer",
    },
    worktreeIsolation: true,
    sandboxExtraRoots: false,
    artifact: true,
    notify: true,
    permissionsFile: ".claude/settings.local.json (permissions.allow / permissions.deny)",
    agentModelKey: "model (sonnet|opus|haiku|fable|<full id>|inherit)",
    hookEvents: ["SessionStart", "UserPromptSubmit", "PreToolUse", "PostToolUse", "Notification", "Stop", "SubagentStop", "PreCompact", "SessionEnd"],
    rulesFile: null,
    rulesLimit: null,
    // "description" and "when_to_use" combined, documented.
    descriptionBudget: 1536,
    descriptionBudgetSource: "documented: https://code.claude.com/docs/en/skills",
    permissionsShape: "claude-settings",
    // "Tools the subagent can use ... Inherits every tool available to
    // subagents if omitted." Read 2026-10-22.
    readOnly: { control: "honoured (the persona's tools list)", source: "https://code.claude.com/docs/en/sub-agents" },
    source: "https://code.claude.com/docs/en/hooks",
    caveat: "a plugin cannot ship permissions (its settings.json carries only agent and subagentStatusLine); the allowlist is merged into the untracked settings.local.json by the consumer's own tooling",
  },
  {
    surface: "codex",
    ask: "request_user_input",
    subagent: "spawn_agent",
    hooks: {
      file: ".codex/hooks.json",
      stop: "Stop",
      preToolUse: "PreToolUse",
      sessionStart: "SessionStart",
      decisionKey: "hookSpecificOutput.permissionDecision: deny (ask is parsed but not supported yet)",
    },
    worktreeIsolation: false,
    sandboxExtraRoots: true,
    artifact: false,
    notify: false,
    permissionsFile: ".codex/config.toml (approval_policy, sandbox_mode, sandbox_workspace_write.writable_roots)",
    agentModelKey: "model (in .codex/agents/<name>.toml; a served id, no inherit token)",
    hookEvents: ["SessionStart", "SubagentStart", "PreToolUse", "PermissionRequest", "PostToolUse", "PreCompact", "PostCompact", "UserPromptSubmit", "SubagentStop", "Stop", "Interrupt", "SessionEnd"],
    // AGENTS.md is the prose surface; it is read up to project_doc_max_bytes (32 KiB by default).
    rulesFile: null,
    rulesLimit: null,
    descriptionBudget: 186,
    descriptionBudgetSource: "measured 2026-09-19, not documented (hardening audit)",
    permissionsShape: "codex-toml",
    readOnly: { control: "none documented (custom agents inherit the parent sandbox; sandbox_mode in an agent file does not override it)", source: "https://learn.chatgpt.com/docs/agent-configuration/subagents" },
    source: "https://learn.chatgpt.com/docs/hooks",
    caveat: "a project .codex/config.toml loads only for a project the user marked trusted; subagents inherit the parent model unless [agents] default_subagent_model is set; AGENTS.md is read up to project_doc_max_bytes (32768 by default)",
  },
  {
    surface: "cursor",
    ask: "AskQuestion",
    subagent: "subagent",
    hooks: {
      file: ".cursor/hooks.json",
      stop: "stop",
      preToolUse: "beforeShellExecution",
      sessionStart: "sessionStart",
      decisionKey: "permission: allow|deny|ask",
    },
    worktreeIsolation: false,
    sandboxExtraRoots: true,
    artifact: false,
    notify: false,
    permissionsFile: ".cursor/cli.json (permissions.allow / permissions.deny)",
    agentModelKey: "model (inherit, the default, or a Cursor model id; the mirror writes inherit for every persona -- a tier alias from models.cursor is not a documented id)",
    hookEvents: ["sessionStart", "sessionEnd", "preToolUse", "postToolUse", "beforeShellExecution", "afterShellExecution", "afterFileEdit", "stop"],
    // A plain .md under .cursor/rules is ignored; "Keep rules under 500 lines" is advice, not a limit.
    rulesFile: ".cursor/rules/<name>.mdc",
    rulesLimit: null,
    descriptionBudget: 30,
    descriptionBudgetSource: "measured 2026-09-19, not documented (hardening audit)",
    permissionsShape: "cursor-cli-json",
    readOnly: { control: "honoured at project placement (.cursor/agents/, readonly: true); plugin placement unverified (forum.cursor.com/t/173787)", source: "https://cursor.com/docs/subagents" },
    source: "https://cursor.com/docs/agent/hooks",
    caveat: "a persona whose model is another provider's alias falls back, and a tier alias is not a documented id, so the mirror writes 'inherit' for every persona and reports the tier (modelMapped). A rules file must be .mdc (a plain .md is ignored); the page advises under 500 lines",
  },
  {
    surface: "antigravity",
    ask: "ask_question",
    subagent: "invoke_subagent",
    hooks: {
      file: ".agents/hooks.json",
      stop: "Stop",
      preToolUse: "PreToolUse",
      sessionStart: "SessionStart",
      decisionKey: "decision: allow|deny|ask|force_ask|deny_unless_prior_grant (+ reason)",
    },
    worktreeIsolation: true,
    sandboxExtraRoots: false,
    artifact: false,
    notify: false,
    // No allowlist FILE: the per-persona policy is the only knob, and `auto`
    // approves arbitrary commands, so no pack is written for this surface.
    permissionsFile: "per-agent commandExecutionPolicy (off|auto|eager|sandbox, default sandbox) in .agents/agents/<name>.md",
    agentModelKey: "model (inherit|flash|pro)",
    hookEvents: ["SessionStart", "PreToolUse", "PostToolUse", "PreInvocation", "PostInvocation", "Stop"],
    rulesFile: ".agents/rules/<name>.md",
    // Re-read 2026-09-28 from https://antigravity.google/docs/rules: "truncates
    // any single rule file that exceeds 24,000 bytes" (the 2026-09-20 page
    // said 12,000 characters), and every rules file must open with frontmatter
    // declaring a `trigger` or is silently discarded.
    rulesLimit: 24_000,
    descriptionBudget: null,
    descriptionBudgetSource: null,
    permissionsShape: null,
    // The page's `tools` row: "Explicit list of tools permitted for this
    // subagent". Honoured only because the mirror writes the list in the
    // surface's own names (./rules.ts ANTIGRAVITY_TOOL_NAMES, zheref/nen#505);
    // derived from that map, so removing it reads unverified again.
    readOnly: toolListControl(ANTIGRAVITY_TOOL_NAMES, "https://antigravity.google/docs/subagents"),
    source: "https://antigravity.google/docs/hooks",
    caveat: "a rules file is truncated past 24,000 bytes and must open with frontmatter declaring a trigger (always_on | model_decision | glob | manual) or is silently discarded; personas live in .agents/agents/ and skills in .agents/skills/ (.agent/ is the back-compatibility spelling); workflows are deprecated (retired 2026-11-01); no permission pack is written because commandExecutionPolicy: auto would approve arbitrary commands",
  },
];

export function findCapabilities(surface: string): SurfaceCapabilities | undefined {
  return CAPABILITIES.find((row): boolean => row.surface === surface);
}

export function capabilityNames(): readonly string[] {
  return CAPABILITIES.map((row): string => row.surface);
}

export function renderCapabilities(row: SurfaceCapabilities): string[] {
  const yn = (value: boolean): string => (value ? "yes" : "no");
  return [
    `surface: ${row.surface}`,
    `  ask:              ${row.ask ?? "none"}`,
    `  subagent:         ${row.subagent ?? "none"}`,
    `  hooks:            ${row.hooks.file ?? "none"}`,
    `    stop:           ${row.hooks.stop ?? "none"}`,
    `    preToolUse:     ${row.hooks.preToolUse ?? "none"}`,
    `    sessionStart:   ${row.hooks.sessionStart ?? "none"}`,
    `    decision key:   ${row.hooks.decisionKey ?? "none"}`,
    `  worktree isolation: ${yn(row.worktreeIsolation)}`,
    `  sandbox extra roots: ${yn(row.sandboxExtraRoots)}`,
    `  artifact:         ${yn(row.artifact)}`,
    `  notify:           ${yn(row.notify)}`,
    `  permissions file: ${row.permissionsFile ?? "none"}`,
    `  permissions shape: ${row.permissionsShape ?? "none"}`,
    `  agent model key:  ${row.agentModelKey ?? "none"}`,
    `  hook events:      ${row.hookEvents.join(", ")}`,
    `  rules file:       ${row.rulesFile ?? "none"}${row.rulesLimit === null ? "" : ` (limit ${row.rulesLimit} bytes)`}`,
    `  read-only persona: ${row.readOnly.control} (${row.readOnly.source})`,
    `  description budget: ${row.descriptionBudget === null ? "none" : `${row.descriptionBudget} chars (${row.descriptionBudgetSource ?? ""})`}`,
    `  source:           ${row.source}`,
    ...(row.caveat === null ? [] : [`  caveat:           ${row.caveat}`]),
  ];
}
