// src/usage/command.ts -- `nen usage record|show`: the per-effort model-usage
// ledger (zheref/nen#227).
//
// WHY A LEDGER. `nen phase` records how long a phase took; nothing recorded
// what it COST -- which model, how many tokens, how many minutes -- and every
// surface exposes that differently (`claude /cost`, a Codex session log, an
// Actions timing) or not at all. This family is the one place those numbers
// land, in a shape `nen report data` can carry as `usage[]` beside `phases[]`.
//
// NEN READS NOTHING FROM A SURFACE. The caller types the numbers it obtained,
// and says in `--source` where it got them; a surface that offers none says
// `--not-reported`. The verb records what it was told and computes nothing --
// there is no price table here and never will be, because a price is a
// vendor's number that changes without a release.
//
// WHERE IT LIVES. `<git-common-dir>/.nen/usage/<effort>.json` since
// zheref/nen#509 (`<--repo>/.nen/usage/` outside git; ../ledger/home.ts), one
// file per effort, contract `nen.usage.ledger/v0.1` (./ledger.ts). One ENTRY
// per invocation, appended.

import { emit, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { resolveRepoRoot } from "../repo/root.js";
import { assertEffortId } from "../ledger/effort.js";
import { legacyLine, locateEffortLedger, resolveEffortHome } from "../ledger/home.js";
import {
  appendUsageEntry,
  readUsageLedger,
  USAGE_CONTRACT,
  USAGE_LEDGER_DIR,
  type UsageEntry,
  type UsageLedger,
} from "./ledger.js";

export { USAGE_CONTRACT, USAGE_LEDGER_DIR };

const USAGE = `nen usage record --effort <id> --surface <s> [--model <alias>] [--dial <level>]
                 [--input <n>] [--output <n>] [--cache-read <n>] [--cache-write <n>]
                 [--minutes <n>] [--source <text>] [--note <text>] [--not-reported]
nen usage show   --effort <id> [--repo <path>] [--json]

Every form reads and writes the ledger of --repo's repository (default: the
current directory): '<git-common-dir>/${USAGE_LEDGER_DIR}/<effort>.json', shared
by every worktree, so a worktree cleanup never takes an effort's spend with it.
Outside git it is '<--repo>/${USAGE_LEDGER_DIR}/'. A ledger an older build left at
'<worktree>/${USAGE_LEDGER_DIR}/' is read in place by 'show' (the old path is
named) and moved once by 'record'; a copy in both places is refused, exit 1.
That fallback is read through the 0.28 line and removed in 0.29.0.

The per-effort usage ledger: one JSON file per effort (generated output),
contract
'${USAGE_CONTRACT}'. 'record' appends ONE entry stamped with this invocation's
clock; 'show' prints the ledger and the totals per surface and model.

  --effort <id>      The effort this usage belongs to -- the one effort-id
                     grammar 'nen phase' takes, so one effort names both.
  --surface <s>      Which surface ran (claude-code, codex, cursor, antigravity).
                     Recorded verbatim.
  --model <alias>    Which model alias ran. Recorded verbatim; null when absent.
  --dial <level>     The surface's effort level, verbatim; null when absent,
                     including on older ledgers. It is not a usage number.
  --input <n>        Input tokens.           Non-negative whole number.
  --output <n>       Output tokens.          Non-negative whole number.
  --cache-read <n>   Cache-read tokens.      Non-negative whole number.
  --cache-write <n>  Cache-write tokens.     Non-negative whole number.
  --minutes <n>      Wall minutes spent.     Non-negative number.
  --source <text>    Where the numbers came from, in your own words:
                     'claude /cost', 'codex session log', 'gh actions timing'.
  --note <text>      One free-text line kept on the entry.
  --not-reported     This surface exposed no numbers. Every count is recorded
                     null and 'notReported' is true. Refused at exit 2 together
                     with ANY number: a surface either reported or it did not.

An entry with no number and no --not-reported is refused at exit 2: it would
record nothing about anything. Numbers are never computed, converted or priced
here; nen writes down what you typed and where you said it came from.

'nen report data' merges every ledger it finds as 'usage[]'.`;

const COUNT_FLAGS = ["input", "output", "cache-read", "cache-write"] as const;

function requireEffortFlag(context: CommandContext): string {
  const effort = context.args.values["effort"];
  if (effort === undefined || effort.trim() === "") throw new VerbUsageError("--effort <id> is required.");
  return assertEffortId(effort);
}

function ledgerPathFor(context: CommandContext, mode: "read" | "write"): { readonly effort: string; readonly path: string } {
  const effort = requireEffortFlag(context);
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const located = locateEffortLedger(resolveEffortHome(root, "usage", context.seams), effort, mode);
  const note = legacyLine(located);
  if (note !== null) context.io.err(`nen usage: ${note}`);
  return { effort, path: located.path };
}

function ledgerFor(context: CommandContext): { readonly effort: string; readonly path: string; readonly ledger: UsageLedger } {
  const { effort, path } = ledgerPathFor(context, "read");
  return { effort, path, ledger: readUsageLedger(path, effort) };
}

function readCount(context: CommandContext, flag: string): number | null {
  const raw = context.args.values[flag];
  if (raw === undefined) return null;
  if (!/^\d+$/.test(raw)) throw new VerbUsageError(`--${flag} takes a non-negative whole number of tokens, got '${raw}'.`);
  return Number.parseInt(raw, 10);
}

function readMinutes(context: CommandContext): number | null {
  const raw = context.args.values["minutes"];
  if (raw === undefined) return null;
  const value = Number(raw);
  if (raw.trim() === "" || !Number.isFinite(value) || value < 0) {
    throw new VerbUsageError(`--minutes takes a non-negative number, got '${raw}'.`);
  }
  return value;
}

function record(context: CommandContext): number {
  // THE PATH ONLY, HERE: the ledger is read inside the lock, in
  // `appendUsageEntry`, so what is appended to is what is on disk at the
  // moment of the write and not a copy taken before another run's.
  // Every refusal comes before the path is located, so a usage error never
  // moves an older worktree-local ledger (../ledger/home.ts).
  requireEffortFlag(context);
  const surface = context.args.values["surface"];
  if (surface === undefined || surface.trim() === "") throw new VerbUsageError("--surface <s> is required for 'record'.");
  const notReported = context.args.booleans.has("not-reported");
  const counts = COUNT_FLAGS.map((flag): number | null => readCount(context, flag));
  const minutes = readMinutes(context);
  const numbered = [...counts, minutes].some((value): boolean => value !== null);
  if (notReported && numbered) {
    throw new VerbUsageError(
      "--not-reported was given together with a number. A surface either reported its usage or it did not: drop the numbers, or drop the flag.",
    );
  }
  if (!notReported && !numbered) {
    throw new VerbUsageError(
      "no number was given and --not-reported was not. An entry with nothing in it records nothing about anything: give at least one of --input, --output, --cache-read, --cache-write, --minutes, or say --not-reported.",
    );
  }
  const [input, output, cacheRead, cacheWrite] = counts;
  const { effort, path } = ledgerPathFor(context, "write");
  const entry: UsageEntry = {
    recordedAt: context.seams.now().toISOString(),
    surface,
    model: context.args.values["model"] ?? null,
    input: input ?? null,
    output: output ?? null,
    cacheRead: cacheRead ?? null,
    cacheWrite: cacheWrite ?? null,
    minutes,
    source: context.args.values["source"] ?? null,
    note: context.args.values["note"] ?? null,
    notReported,
    dial: context.args.values["dial"] ?? null,
  };
  appendUsageEntry(path, effort, entry);
  emit(context.io, context.json, { path, entry }, [
    `recorded ${surface}${entry.model === null ? "" : `/${entry.model}`} on '${effort}'${notReported ? " (not reported)" : ""} -- ${path}`,
  ]);
  return 0;
}

export interface UsageTotal {
  readonly surface: string;
  readonly model: string | null;
  readonly entries: number;
  readonly notReported: number;
  readonly input: number;
  readonly output: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly minutes: number;
}

/** Totals per surface+model, in first-seen order. A null number adds nothing. */
export function totalsOf(ledger: UsageLedger): readonly UsageTotal[] {
  const totals = new Map<string, UsageTotal>();
  for (const entry of ledger.entries) {
    // A tuple, not a concatenation: `ab`+`c` and `a`+`bc` are two totals (Nobunaga N11).
    const key = JSON.stringify([entry.surface, entry.model]);
    const current = totals.get(key) ?? {
      surface: entry.surface,
      model: entry.model,
      entries: 0,
      notReported: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      minutes: 0,
    };
    totals.set(key, {
      ...current,
      entries: current.entries + 1,
      notReported: current.notReported + (entry.notReported ? 1 : 0),
      input: current.input + (entry.input ?? 0),
      output: current.output + (entry.output ?? 0),
      cacheRead: current.cacheRead + (entry.cacheRead ?? 0),
      cacheWrite: current.cacheWrite + (entry.cacheWrite ?? 0),
      minutes: current.minutes + (entry.minutes ?? 0),
    });
  }
  return [...totals.values()];
}

const n = (value: number | null): string => (value === null ? "-" : String(value));

export function renderUsage(ledger: UsageLedger): string[] {
  const lines = [`effort: ${ledger.effort} (${ledger.entries.length} usage entr${ledger.entries.length === 1 ? "y" : "ies"})`];
  for (const entry of ledger.entries) {
    const who = `${entry.surface}${entry.model === null ? "" : `/${entry.model}`}`;
    const detail = entry.notReported
      ? "not reported"
      : `in ${n(entry.input)}  out ${n(entry.output)}  cache r/w ${n(entry.cacheRead)}/${n(entry.cacheWrite)}  ${n(entry.minutes)} min`;
    lines.push(`  ${entry.recordedAt}  ${who.padEnd(24)} ${detail}${entry.source === null ? "" : `  (${entry.source})`}`);
  }
  const totals = totalsOf(ledger);
  if (totals.length > 0) lines.push("totals:");
  for (const total of totals) {
    const who = `${total.surface}${total.model === null ? "" : `/${total.model}`}`;
    lines.push(
      `  ${who.padEnd(24)} in ${total.input}  out ${total.output}  cache r/w ${total.cacheRead}/${total.cacheWrite}  ${total.minutes} min  (${total.entries} entr${total.entries === 1 ? "y" : "ies"}${total.notReported === 0 ? "" : `, ${total.notReported} not reported`})`,
    );
  }
  return lines;
}

export const usageCommand: Command = {
  name: "usage",
  summary: "Record what a surface and model spent on an effort; show the ledger and its totals.",
  usage: USAGE,
  subcommands: ["record", "show"],
  flags: {
    values: ["effort", "surface", "model", "dial", "input", "output", "cache-read", "cache-write", "minutes", "source", "note"],
    booleans: ["not-reported"],
  },
  run(context: CommandContext): number {
    const sub = requireSubcommand("usage", context.args, ["record", "show"]);
    if (sub === "record") return record(context);
    const { ledger } = ledgerFor(context);
    emit(context.io, context.json, { ...ledger, totals: totalsOf(ledger) }, renderUsage(ledger));
    return 0;
  },
};
