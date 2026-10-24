import { emit, refuseExtraPositionals, requireSubcommand, VerbUsageError, type Command } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { resolveRepoRoot } from "../repo/root.js";
import { assertEffortId } from "../ledger/effort.js";
import { legacyLine, locateEffortLedger, resolveEffortHome } from "../ledger/home.js";
import { appendSessionEntry, readSessionLedger, SESSION_CONTRACT, SESSION_LEDGER_DIR, type SessionEntry, type SessionLedger } from "./ledger.js";

const USAGE = `nen session record --effort <id> --surface <s> [--model <alias>] [--dial <level>] [--title <text>] [--id <text>] [--source <text>] [--repo <path>] [--json]
nen session show --effort <id> [--repo <path>] [--json]

Record one caller-reported session identity per invocation under
'<git-common-dir>/${SESSION_LEDGER_DIR}/<effort>.json' (under --repo outside
git), contract '${SESSION_CONTRACT}' -- the common dir every worktree shares,
so a cleanup never takes it. An older '<worktree>/${SESSION_LEDGER_DIR}/' copy is
read in place by 'show' and moved once by 'record' (fallback removed in 0.29.0).
The effort uses the one effort-id grammar; '/' is percent-encoded as '%2F'.
The invocation's clock supplies recordedAt. All other values are verbatim;
nen reads no title, id, model or dial from the environment or a harness.

  --effort <id>   Required: the effort the session delivered.
  --surface <s>   Required for record: the surface that ran the session.
  --model <alias> The caller's model alias; null when absent.
  --dial <level>  The surface's effort vocabulary; null when absent.
  --title <text>  The session title; null when absent.
  --id <text>     The session id; null when absent.
  --source <text> Where the caller read the identity; null when absent.
  --repo <path>   Target working-tree root; default: current directory.
  --json          record: { path, entry }; show: { contract, effort, entries }.
                  Each entry is { recordedAt, surface, model, dial, title,
                  id, source }. An absent ledger shows entries: [].

At least one of --title or --id must contain non-whitespace text; neither
identifies anything otherwise (exit 2, no write). An unreadable ledger is
refused, never overwritten (exit 1), including a dangling ledger link.
Stray positional arguments and passthrough tokens refuse at exit 2 before work. 'nen report data' merges sessions[].`;

export function renderSessions(ledger: SessionLedger): string[] {
  return [
    `effort: ${ledger.effort} (${ledger.entries.length} session entr${ledger.entries.length === 1 ? "y" : "ies"})`,
    ...ledger.entries.map((entry): string => `  ${[entry.recordedAt, entry.surface, entry.model, entry.dial, entry.title, entry.id, entry.source].filter((part): part is string => part !== null).map(plainLine).join(" · ")}`),
  ];
}

export const sessionCommand: Command = {
  name: "session",
  summary: "Record and show caller-reported session identities per effort.",
  usage: USAGE,
  subcommands: ["record", "show"],
  flags: { values: ["effort", "surface", "model", "dial", "title", "id", "source"], booleans: [] },
  run(context): number {
    const sub = requireSubcommand("session", context.args, ["record", "show"]);
    refuseExtraPositionals(context.args, 2);
    const effort = context.args.values["effort"];
    if (effort === undefined || effort.trim() === "") throw new VerbUsageError("--effort <id> is required.");
    assertEffortId(effort);
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const home = resolveEffortHome(root, "sessions", context.seams);
    if (sub === "show") {
      const located = locateEffortLedger(home, effort, "read");
      const note = legacyLine(located);
      if (note !== null) context.io.err(`nen session: ${note}`);
      const ledger = readSessionLedger(located.path, effort);
      emit(context.io, context.json, ledger, renderSessions(ledger));
      return 0;
    }
    const surface = context.args.values["surface"];
    if (surface === undefined || surface.trim() === "") throw new VerbUsageError("--surface <s> is required for 'record'.");
    const title = context.args.values["title"] ?? null;
    const id = context.args.values["id"] ?? null;
    if ((title?.trim() ?? "") === "" && (id?.trim() ?? "") === "") throw new VerbUsageError("at least one of --title <text> or --id <text> is required to identify a session.");
    const entry: SessionEntry = {
      recordedAt: context.seams.now().toISOString(), surface,
      model: context.args.values["model"] ?? null,
      dial: context.args.values["dial"] ?? null,
      title, id, source: context.args.values["source"] ?? null,
    };
    const located = locateEffortLedger(home, effort, "write");
    const moved = legacyLine(located);
    if (moved !== null) context.io.err(`nen session: ${moved}`);
    const path = located.path;
    appendSessionEntry(path, effort, entry, { warn: context.io.err });
    emit(context.io, context.json, { path, entry }, [`recorded session on '${effort}' -- ${path}`]);
    return 0;
  },
};
