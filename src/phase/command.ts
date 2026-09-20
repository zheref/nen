// src/phase/command.ts -- `nen phase begin|end|show`: the per-phase timing
// ledger (zheref/nen#216).
//
// WHY A LEDGER AND NOT A PRINTED NUMBER. `nen shu` already measures how long
// every step took (../seam/exec.ts's `durationMs`) and prints it -- and the
// number is gone the moment the terminal scrolls. Nothing recorded when a
// workflow PHASE (warm-up, authoring, checkpoint, review, launch, report)
// began or ended, so "what is slow" was inference. This family writes that
// fact once, deterministically, on every surface, so a report can render it
// and a later reader can compare runs.
//
// WHERE IT LIVES. `.nen/phases/<effort>.json`, generated output under the
// dot-prefixed directory (../schema/source.ts's rule), one file per effort,
// contract `nen.phase.ledger/v0.1`. An effort id is the caller's -- a branch
// slug, a PR number, a session id -- and is used as the filename after the
// same sanitising ../loop/command.ts applies to its own ledger ids.
//
// WALL CLOCK, FROM THE SEAM. Every instant is `seams.now()`, so a test pins
// it and a report's durations are reproducible. A phase's `durationMs` is
// `endedAt - startedAt` on that clock -- the same measure `shu` prints, so
// the two never disagree about what a second is.
//
// NOTHING IS SPAWNED. This family reads and writes one JSON file.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { emit, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { resolveRepoRoot } from "../repo/root.js";

import { PHASE_CONTRACT, PHASE_LEDGER_DIR } from "./ledger.js";
export { PHASE_CONTRACT, PHASE_LEDGER_DIR };

export interface PhaseEntry {
  readonly phase: string;
  readonly startedAt: string;
  readonly endedAt: string | null;
  readonly durationMs: number | null;
  readonly exitCode: number | null;
  readonly surface: string | null;
  readonly model: string | null;
  readonly note: string | null;
}

export interface PhaseLedger {
  readonly contract: string;
  readonly effort: string;
  readonly phases: readonly PhaseEntry[];
}

const USAGE = `nen phase begin --effort <id> --phase <name> [--surface <s>] [--model <alias>] [--note <text>]
nen phase end   --effort <id> [--phase <name>] [--exit <code>] [--note <text>]
nen phase show  --effort <id> [--repo <path>] [--json]

Every form reads and writes the ledger under --repo (default: the current
directory).

The per-phase timing ledger: one JSON file per effort under
'${PHASE_LEDGER_DIR}/<effort>.json' (generated output, gitignored), contract
'${PHASE_CONTRACT}'. 'begin' opens an entry stamped with this invocation's
clock; 'end' closes the most recent OPEN entry -- the one named by --phase, or
the last opened when the flag is omitted -- and records the elapsed
milliseconds and the exit code the caller reports. 'show' prints the ledger.

  --effort <id>    The effort this phase belongs to: a branch slug, a PR
                   number, a session id. Letters, digits, '.', '_', '-' and
                   '/' (a '/' is percent-encoded as '%2F' in the filename, so
                   'HA/85' and 'HA-85' are two ledgers, never one).
  --phase <name>   The phase: 'breath', 'rasengan', 'kokusen', 'hanten',
                   'review', 'launch', 'report' -- the caller's vocabulary.
  --surface <s>    Which surface ran it (claude-code, codex, cursor,
                   antigravity). Recorded verbatim.
  --model <alias>  Which model tier or alias ran it. Recorded verbatim.
  --exit <code>    The phase's exit code, for 'end'. Omitted = null.
  --note <text>    One free-text line kept on the entry.

Two open entries with the same phase name are refused: 'end' would not know
which one to close. 'end' with nothing open is a usage error naming the
effort. 'nen report data' merges every ledger it finds as 'phases[]'.`;

const EFFORT = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function ledgerPath(root: string, effort: string): string {
  // encodeURIComponent is INJECTIVE on the id alphabet: '/' -> '%2F' and
  // every other admitted character is left as itself, so no two effort ids
  // share a file. A '/' -> '-' substitution was not (Copilot review on
  // zheref/nen#217): 'HA/85' and 'HA-85' appended to the same ledger.
  return join(root, ...PHASE_LEDGER_DIR.split("/"), `${encodeURIComponent(effort)}.json`);
}

export function readLedger(path: string, effort: string): PhaseLedger {
  if (!existsSync(path)) return { contract: PHASE_CONTRACT, effort, phases: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`'${path}' is not readable JSON (${error instanceof Error ? error.message : String(error)}). A phase ledger nen cannot read is not rewritten over; move it aside.`);
  }
  if (typeof parsed !== "object" || parsed === null || (parsed as { contract?: unknown }).contract !== PHASE_CONTRACT) {
    throw new Error(`'${path}' does not carry contract '${PHASE_CONTRACT}'. A ledger written by something else is not appended to.`);
  }
  const phases = (parsed as { phases?: unknown }).phases;
  if (!Array.isArray(phases)) throw new Error(`'${path}': 'phases' is not an array.`);
  return { contract: PHASE_CONTRACT, effort, phases: phases as PhaseEntry[] };
}

function writeLedger(path: string, ledger: PhaseLedger): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, "utf8");
}

function requireEffort(context: CommandContext): string {
  const effort = context.args.values["effort"];
  if (effort === undefined || effort.trim() === "") throw new VerbUsageError("--effort <id> is required.");
  if (!EFFORT.test(effort)) throw new VerbUsageError(`--effort '${effort}' is not a ledger id: letters, digits, '.', '_', '-' and '/' only.`);
  return effort;
}

export const phaseCommand: Command = {
  name: "phase",
  summary: "Record when a workflow phase began and ended, per effort.",
  usage: USAGE,
  subcommands: ["begin", "end", "show"],
  flags: { values: ["effort", "phase", "surface", "model", "exit", "note"], booleans: [] },
  run(context: CommandContext): number {
    const sub = requireSubcommand("phase", context.args, ["begin", "end", "show"]);
    const effort = requireEffort(context);
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const path = ledgerPath(root, effort);
    const ledger = readLedger(path, effort);
    const now = context.seams.now();
    const note = context.args.values["note"] ?? null;

    if (sub === "show") {
      emit(context.io, context.json, ledger, renderLedger(ledger));
      return 0;
    }

    if (sub === "begin") {
      const phase = context.args.values["phase"];
      if (phase === undefined || phase.trim() === "") throw new VerbUsageError("--phase <name> is required for 'begin'.");
      if (ledger.phases.some((entry): boolean => entry.phase === phase && entry.endedAt === null)) {
        throw new VerbUsageError(`phase '${phase}' is already open on effort '${effort}'. End it first; two open entries with one name cannot be told apart.`);
      }
      const entry: PhaseEntry = {
        phase,
        startedAt: now.toISOString(),
        endedAt: null,
        durationMs: null,
        exitCode: null,
        surface: context.args.values["surface"] ?? null,
        model: context.args.values["model"] ?? null,
        note,
      };
      const next: PhaseLedger = { ...ledger, phases: [...ledger.phases, entry] };
      writeLedger(path, next);
      emit(context.io, context.json, { path, entry }, [`began ${phase} on '${effort}' at ${entry.startedAt} -- ${path}`]);
      return 0;
    }

    // end
    const named = context.args.values["phase"] ?? null;
    const openIndexes = ledger.phases
      .map((entry, index): number => (entry.endedAt === null && (named === null || entry.phase === named) ? index : -1))
      .filter((index): boolean => index >= 0);
    const index = openIndexes.at(-1);
    if (index === undefined) {
      throw new VerbUsageError(
        named === null
          ? `no open phase on effort '${effort}'. 'begin' one first.`
          : `phase '${named}' is not open on effort '${effort}'.`,
      );
    }
    const exitRaw = context.args.values["exit"];
    const exitCode = exitRaw === undefined ? null : Number(exitRaw);
    if (exitCode !== null && (!Number.isInteger(exitCode) || exitCode < 0)) {
      throw new VerbUsageError("--exit must be a non-negative integer.");
    }
    const open = ledger.phases[index] as PhaseEntry;
    const endedAt = now.toISOString();
    const closed: PhaseEntry = {
      ...open,
      endedAt,
      durationMs: Math.max(0, now.getTime() - Date.parse(open.startedAt)),
      exitCode,
      note: note ?? open.note,
    };
    const phases = ledger.phases.map((entry, i): PhaseEntry => (i === index ? closed : entry));
    writeLedger(path, { ...ledger, phases });
    emit(context.io, context.json, { path, entry: closed }, [
      `ended ${closed.phase} on '${effort}' after ${closed.durationMs}ms${exitCode === null ? "" : ` (exit ${exitCode})`} -- ${path}`,
    ]);
    return 0;
  },
};

export function renderLedger(ledger: PhaseLedger): string[] {
  const lines = [`effort: ${ledger.effort} (${ledger.phases.length} phase entr${ledger.phases.length === 1 ? "y" : "ies"})`];
  for (const entry of ledger.phases) {
    const duration = entry.durationMs === null ? "open" : `${entry.durationMs}ms`;
    const tail = [entry.exitCode === null ? null : `exit ${entry.exitCode}`, entry.surface, entry.model].filter((v): v is string => v !== null).join(" · ");
    lines.push(`  ${entry.phase.padEnd(14)} ${duration.padStart(9)}  ${entry.startedAt}${tail === "" ? "" : `  ${tail}`}`);
  }
  return lines;
}
