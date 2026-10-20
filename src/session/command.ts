import { emit, requireSubcommand, VerbUsageError, type Command } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { resolveRepoRoot } from "../repo/root.js";
import { EFFORT_ID } from "../usage/ledger.js";
import { appendSessionEntry, readSessionLedger, sessionLedgerPath, SESSION_CONTRACT, SESSION_LEDGER_DIR, type SessionEntry, type SessionLedger } from "./ledger.js";

const USAGE = `nen session record --effort <id> --surface <s> [--model <alias>] [--dial <level>] [--title <text>] [--id <text>] [--source <text>] [--repo <path>] [--json]
nen session show --effort <id> [--repo <path>] [--json]

Record one caller-reported session identity per invocation under
'${SESSION_LEDGER_DIR}/<effort>.json', contract '${SESSION_CONTRACT}'.
The effort uses phase/usage's id alphabet; '/' is percent-encoded as '%2F'.
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
refused, never overwritten (exit 1). 'nen report data' merges sessions[].`;

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
    const effort = context.args.values["effort"];
    if (effort === undefined || !EFFORT_ID.test(effort)) throw new VerbUsageError("--effort <id> is required: letters, digits, '.', '_', '-' and '/' only, starting with a letter or digit.");
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const path = sessionLedgerPath(root, effort);
    if (sub === "show") {
      const ledger = readSessionLedger(path, effort);
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
    appendSessionEntry(path, effort, entry, { warn: context.io.err });
    emit(context.io, context.json, { path, entry }, [`recorded session on '${effort}' -- ${path}`]);
    return 0;
  },
};
