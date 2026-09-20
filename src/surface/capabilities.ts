// src/surface/capabilities.ts -- what each agent surface can DO, as data
// (zheref/nen#216).
//
// WHY A TABLE. Eight skills in the consumer plugin branch by hand on which
// picker, subagent and hook primitive a surface has, and every one of them
// carries the answer as prose that was true the day it was written. Codex and
// Cursor both shipped a Stop hook after the prose said they had none. A row
// here is a fact with a citation; a caller reads it and branches on data.
//
// FACTS READ 2026-09-19, each row's `source` names the page. These are OTHER
// PEOPLE'S products and they move; when a row goes wrong the fix is to
// re-read the page and change the row, and nothing else.
//
// `claude-code` and `antigravity` ARE ROWS HERE AND NOT IN ./rules.ts. That
// table describes how nen MIRRORS a skills directory into a surface, and this
// binary mirrors into two; this table describes what a surface offers a
// running session, which is a question about all four. Adding the mirror rows
// for the other two is separate work and does not wait on this.

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
      decisionKey: "hookSpecificOutput.permissionDecision: allow|deny|ask",
    },
    worktreeIsolation: true,
    sandboxExtraRoots: false,
    artifact: true,
    notify: true,
    permissionsFile: ".claude/settings.local.json (permissions.allow)",
    agentModelKey: "model",
    source: "https://code.claude.com/docs/en/hooks",
    caveat: "a plugin cannot ship permissions; the allowlist is placed into the untracked settings.local.json by the consumer's own tooling",
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
      decisionKey: "permissionDecision: allow|deny",
    },
    worktreeIsolation: false,
    sandboxExtraRoots: true,
    artifact: false,
    notify: false,
    permissionsFile: ".codex/config.toml (approval_policy, sandbox_mode, sandbox_workspace_write.writable_roots)",
    agentModelKey: "model (in .codex/agents/<name>.toml)",
    source: "https://learn.chatgpt.com/docs/agent-configuration/hooks",
    caveat: "a project .codex/config.toml loads only for a project the user marked trusted; subagents inherit the parent model unless [agents] default_subagent_model is set",
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
    agentModelKey: "model (inherit or a Cursor model id)",
    source: "https://cursor.com/docs/agent/hooks",
    caveat: "a persona whose model is another provider's alias falls back; emit 'inherit' or a Cursor id",
  },
  {
    surface: "antigravity",
    ask: "ask_question",
    subagent: "invoke_subagent",
    hooks: {
      file: ".agents/hooks.json",
      stop: "Stop",
      preToolUse: "PreToolUse",
      sessionStart: "PreInvocation",
      decisionKey: "decision: allow|deny|deny_unless_prior_grant",
    },
    worktreeIsolation: true,
    sandboxExtraRoots: false,
    artifact: false,
    notify: false,
    permissionsFile: "per-agent commandExecutionPolicy (off|auto|eager|sandbox) in .agents/agents/<name>.md",
    agentModelKey: "model (inherit|flash|pro)",
    source: "https://antigravity.google/docs",
    caveat: "a rules file is limited to 12,000 characters; workspace mode reads .agents/agents/ for personas",
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
    `  agent model key:  ${row.agentModelKey ?? "none"}`,
    `  source:           ${row.source}`,
    ...(row.caveat === null ? [] : [`  caveat:           ${row.caveat}`]),
  ];
}
