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
// WHERE IT LIVES. `<git-common-dir>/.nen/phases/<effort>.json` since
// zheref/nen#509 -- the git common directory, so a resumed effort finds its
// phases after its worktree was cleaned up -- and `<--repo>/.nen/phases/`
// only outside git (../ledger/home.ts). One file per effort, contract
// `nen.phase.ledger/v0.1`. The effort id is the caller's, held to the one
// grammar every nen ledger admits (../ledger/effort.ts).
//
// WALL CLOCK, FROM THE SEAM. Every instant is `seams.now()`, so a test pins
// it and a report's durations are reproducible. A phase's `durationMs` is
// `endedAt - startedAt` on that clock -- the same measure `shu` prints, so
// the two never disagree about what a second is.
//
// NOTHING IS SPAWNED. This family reads and writes one JSON file.

import { emit, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { resolveRepoRoot } from "../repo/root.js";
import { assertEffortId } from "../ledger/effort.js";
import { legacyLine, locateEffortLedger, resolveEffortHome } from "../ledger/home.js";

import {
  PHASE_CONTRACT,
  PHASE_LEDGER_DIR,
  readLedger,
  withLedgerLock,
  writeLedger,
  type PhaseEntry,
  type PhaseLedger,
  type PhaseStep,
} from "./ledger.js";
export { PHASE_CONTRACT, PHASE_LEDGER_DIR, readLedger };
export type { PhaseEntry, PhaseLedger, PhaseStep };

const USAGE = `nen phase begin --effort <id> --phase <name> [--resume] [--surface <s>] [--model <alias>] [--dial <level>] [--note <text>]
nen phase end   --effort <id> [--phase <name>] [--exit <code>] [--note <text>]
nen phase show  --effort <id> [--repo <path>] [--json]

Every form reads and writes the ledger of --repo's repository (default: the
current directory): '<git-common-dir>/${PHASE_LEDGER_DIR}/<effort>.json', the
git common directory every worktree shares, so a worktree cleanup never takes
an effort's phases with it. Outside git it is '<--repo>/${PHASE_LEDGER_DIR}/'.
A ledger an older build left at '<worktree>/${PHASE_LEDGER_DIR}/' is read in
place by 'show' (the old path is named) and moved once by 'begin' and 'end';
a copy in both places is refused, exit 1, naming both. That fallback is read
through the 0.28 line and removed in 0.29.0.

The per-phase timing ledger: one JSON file per effort (generated output),
contract
'${PHASE_CONTRACT}'. 'begin' opens an entry stamped with this invocation's
clock; 'end' closes the most recent OPEN entry -- the one named by --phase, or
the last opened when the flag is omitted -- and records the elapsed
milliseconds and the exit code the caller reports. 'show' prints the ledger.

  --effort <id>    The effort this phase belongs to: a branch slug, a PR
                   number, an issue ref. The one effort-id grammar: letters,
                   digits, '.', '_', '-', '/', '#' and ':', starting with a
                   letter or digit, no '.' or '..' segment. Percent-encoded
                   into the file name ('HA/85' -> 'HA%2F85.json'), so 'HA/85'
                   and 'HA-85' are two ledgers, never one.
  --phase <name>   The phase: 'breath', 'rasengan', 'kokusen', 'hanten',
                   'review', 'launch', 'report' -- the caller's vocabulary.
  --surface <s>    Which surface ran it (claude-code, codex, cursor,
                   antigravity). Recorded verbatim.
  --model <alias>  Which model tier or alias ran it. Recorded verbatim.
  --dial <level>   The effort level, in the surface's vocabulary. Recorded
                   verbatim; null when absent, including on older ledgers.
  --resume         For 'begin': an entry already OPEN with this --phase name
                   is continued, not refused -- this invocation's instant is
                   appended to its 'resumedAt' and nothing else changes, so a
                   phase re-entered after an interrupted run keeps one entry
                   and its original start. With nothing open at all it begins
                   a fresh entry. With ANOTHER phase open and this one not,
                   it is refused (exit 2), naming the open one: that is not a
                   resume, and which phase the run is in is the caller's.
                   'end' still measures from the original start, so a
                   resumed entry's durationMs spans the interruption; 'show'
                   prints its 'resumed at' instants under it.
  --exit <code>    The phase's exit code, for 'end'. Omitted = null.
  --note <text>    One free-text line kept on the entry.

Two open entries with the same phase name are refused: 'end' would not know
which one to close ('begin --resume' continues the open one instead). 'end' with nothing open is a usage error naming the
effort. 'nen report data' merges every ledger it finds as 'phases[]'.

An entry carries 'steps: []' from 'begin'. A 'nen shu <verb> --effort <id>'
run (or one with NEN_EFFORT in its environment) appends every step it ran --
{verb, argv, exitCode, durationMs, stalled} -- to the OPEN entry on that
effort, and writes nothing when none is open. 'show' renders them indented
under their phase.`;

function requireEffort(context: CommandContext): string {
  const effort = context.args.values["effort"];
  if (effort === undefined || effort.trim() === "") throw new VerbUsageError("--effort <id> is required.");
  return assertEffortId(effort);
}

export const phaseCommand: Command = {
  name: "phase",
  summary: "Record when a workflow phase began and ended, per effort.",
  usage: USAGE,
  subcommands: ["begin", "end", "show"],
  flags: { values: ["effort", "phase", "surface", "model", "dial", "exit", "note"], booleans: ["resume"] },
  run(context: CommandContext): number {
    const sub = requireSubcommand("phase", context.args, ["begin", "end", "show"]);
    const effort = requireEffort(context);
    const root = resolveRepoRoot({ repoFlag: context.repoFlag });
    const home = resolveEffortHome(root, "phases", context.seams);
    const now = context.seams.now();
    const note = context.args.values["note"] ?? null;

    const resume = context.args.booleans.has("resume");
    if (resume && sub !== "begin") throw new VerbUsageError(`--resume is read by 'phase begin' only; 'phase ${sub}' does not read it.`);

    if (sub === "show") {
      const located = locateEffortLedger(home, effort, "read");
      const ledger = readLedger(located.path, effort);
      const note = legacyLine(located);
      if (note !== null) context.io.err(`nen phase: ${note}`);
      emit(context.io, context.json, ledger, renderLedger(ledger));
      return 0;
    }

    // EVERY FLAG REFUSAL BEFORE THE LEDGER IS LOCATED (Nobunaga on #516): a
    // write-mode locate moves an older worktree-local ledger, and a refused
    // invocation must move nothing.
    if (sub === "begin" && (context.args.values["phase"] ?? "").trim() === "") throw new VerbUsageError("--phase <name> is required for 'begin'.");
    const exitFlag = context.args.values["exit"];
    if (sub === "end" && exitFlag !== undefined && (!Number.isInteger(Number(exitFlag)) || Number(exitFlag) < 0)) throw new VerbUsageError("--exit must be a non-negative integer.");
    const located = locateEffortLedger(home, effort, "write");
    const path = located.path;
    const moved = legacyLine(located);
    if (moved !== null) context.io.err(`nen phase: ${moved}`);

    // BEGIN AND END READ-MODIFY-WRITE UNDER THE SAME LOCK `nen shu --effort`'s
    // step append takes (Copilot review on zheref/nen#231), so an `end` that
    // races an append neither drops the appended steps nor is dropped by them.
    return withLedgerLock(path, (): number => {
      const ledger = readLedger(path, effort);

      if (sub === "begin") {
        const phase = context.args.values["phase"];
        if (phase === undefined || phase.trim() === "") throw new VerbUsageError("--phase <name> is required for 'begin'.");
        let sameIndex = -1;
        ledger.phases.forEach((entry, index): void => {
          if (entry.phase === phase && entry.endedAt === null) sameIndex = index;
        });
        if (sameIndex !== -1 && resume) {
          // THE RESUME (Hatsu SDD plan N6): the same entry, continued. Its
          // start, steps and every other field stay as they were -- only the
          // instant of this re-entry is appended -- so a run interrupted
          // mid-phase and picked up again reads as ONE phase, re-entered.
          const open = ledger.phases[sameIndex] as PhaseEntry;
          const resumed: PhaseEntry = { ...open, resumedAt: [...(open.resumedAt ?? []), now.toISOString()] };
          writeLedger(path, { ...ledger, phases: ledger.phases.map((entry, i): PhaseEntry => (i === sameIndex ? resumed : entry)) });
          emit(context.io, context.json, { path, entry: resumed, resumed: true }, [`resumed ${phase} on '${effort}' at ${now.toISOString()} (open since ${open.startedAt}) -- ${path}`]);
          return 0;
        }
        if (sameIndex !== -1) {
          throw new VerbUsageError(`phase '${phase}' is already open on effort '${effort}'. End it first, or continue it with --resume; two open entries with one name cannot be told apart.`);
        }
        if (resume) {
          const others = ledger.phases.filter((entry): boolean => entry.endedAt === null).map((entry): string => `'${entry.phase}'`);
          if (others.length > 0) {
            throw new VerbUsageError(`--resume continues an open '${phase}' entry, and none is open on effort '${effort}'; ${others.join(", ")} ${others.length === 1 ? "is" : "are"} open instead. Resume that phase, end it first, or begin '${phase}' without --resume.`);
          }
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
          // EMPTY, AND PRESENT. `nen shu <verb> --effort <id>` appends to this
          // list while the entry is open (zheref/nen#227); a reader of a fresh
          // entry sees the key and knows nothing has run yet, rather than
          // wondering whether this ledger predates it.
          steps: [],
          dial: context.args.values["dial"] ?? null,
        };
        const next: PhaseLedger = { ...ledger, phases: [...ledger.phases, entry] };
        writeLedger(path, next);
        emit(context.io, context.json, resume ? { path, entry, resumed: false } : { path, entry }, [`began ${phase} on '${effort}' at ${entry.startedAt}${resume ? " (--resume: nothing was open to continue)" : ""} -- ${path}`]);
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
    }, { warn: context.io.err });
  },
};

export function renderLedger(ledger: PhaseLedger): string[] {
  const lines = [`effort: ${ledger.effort} (${ledger.phases.length} phase entr${ledger.phases.length === 1 ? "y" : "ies"})`];
  for (const entry of ledger.phases) {
    const duration = entry.durationMs === null ? "open" : `${entry.durationMs}ms`;
    const tail = [entry.exitCode === null ? null : `exit ${entry.exitCode}`, entry.surface, entry.model, entry.dial === null ? null : plainLine(entry.dial)].filter((v): v is string => v !== null).join(" · ");
    lines.push(`  ${entry.phase.padEnd(14)} ${duration.padStart(9)}  ${entry.startedAt}${tail === "" ? "" : `  ${tail}`}`);
    // A RESUMED ENTRY SAYS SO (N6): its duration spans every interruption.
    if ((entry.resumedAt ?? []).length > 0) lines.push(`    resumed at ${(entry.resumedAt ?? []).join(", ")}`);
    // THE STEPS, INDENTED UNDER THE PHASE THEY RAN IN. A step is never a row
    // of its own at the phase's level: it is detail about that phase, and
    // rendering it flush left would read as a phase nobody began.
    for (const step of entry.steps ?? []) {
      lines.push(`    ${step.verb.padEnd(12)} ${renderStepOutcome(step).padStart(9)}  ${step.argv}`);
    }
  }
  return lines;
}

function renderStepOutcome(step: PhaseStep): string {
  if (step.stalled) return "STALLED";
  if (step.durationMs === null) return "no start";
  return `${step.durationMs}ms${step.exitCode === null ? "" : ` e${step.exitCode}`}`;
}
