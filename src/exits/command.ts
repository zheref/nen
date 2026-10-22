// src/exits/command.ts -- `nen exits [<family> [<verb>]]`: the exit vocabulary,
// verb -> code -> meaning, as data (Hatsu SDD plan N5, finding B3).
//
// WHY A VERB. Every code above 2 is per verb, and the same number means
// different things in different verbs (`3` is "unsupported host" on `shu`,
// "a tree is dirty" on `wc swap`, "conflict, nothing written" on `issue
// edit-body`). Until this verb the only copy of that vocabulary was a prose
// table in docs/USAGE.md, so an unattended caller branching on a code had to
// read a sentence -- the moment it starts guessing. Now each family states its
// own codes on its `Command` (../cli/command.ts `exits`), this verb renders the
// union, and ./exits.test.ts holds USAGE's table to it row for row, so the
// document and the binary cannot disagree without a red build.
//
// IT REPORTS AND NEVER CHOOSES. It says what a code means; what a caller does
// about it is the caller's.
//
// A VERB MAY RESTATE 2. The shared 2 is "you typed it wrong"; a verb that also
// returns 2 for something that is not a typo -- a wiring fault, a ledger that
// cannot be established -- declares its own meaning of 2 as a row of its own
// (`code: 2`), and this verb prints it beside the scheme (delivery round on
// zheref/nen#498, reading 9). A retry wrapper branching on 2 reads it here.

import { emit, VerbUsageError, type Command, type CommandContext, type ExitCode } from "../cli/command.js";
import { COMMANDS } from "../cli/registry.js";
import { BootstrapExit } from "../supply/bootstrap.js";

export const EXITS_CONTRACT = "nen.exits/v0.1";

/** The three codes every verb shares; USAGE § Exit codes states why 1 and 2 are not one code. */
export const SHARED_SCHEME: readonly ExitCode[] = [
  { verb: "*", code: 0, meaning: "success" },
  { verb: "*", code: 1, meaning: "the verb's own refusal or failure: the thing you asked for did not work" },
  { verb: "*", code: 2, meaning: "a usage error: you typed it wrong (a missing or malformed flag, --target included)" },
];

/**
 * The two entries that are not registry families: `bootstrap`, which relays
 * bootstrap/nen.sh's published codes unchanged, and the release row's script,
 * which runs the private-name guard. Named here because they are named in
 * USAGE's table, and a generated table silently missing them would be a
 * second answer to "what does this code mean".
 */
export const OUTSIDE_REGISTRY: readonly ExitCode[] = [
  { verb: "bootstrap", code: BootstrapExit.UNSUPPORTED_HOST, meaning: "unsupported host: no binary published for this OS/arch" },
  { verb: "bootstrap", code: BootstrapExit.DOWNLOAD, meaning: "download failure -- the only retryable bootstrap code" },
  { verb: "bootstrap", code: BootstrapExit.CHECKSUM, meaning: "checksum mismatch or unverifiable -- SECURITY, never retry" },
  { verb: "bootstrap", code: BootstrapExit.MANIFEST, meaning: "manifest (SHA256SUMS) unfetchable, missing, malformed or silent -- never retry" },
  { verb: "bootstrap", code: BootstrapExit.WRAPPER, meaning: "the wrapper could not run bootstrap/nen.sh at all" },
  { verb: "release-publish", code: 4, meaning: "a private repository named in text bound for a PUBLIC target; nothing written (the private-name guard)" },
];

/** Every code above 2, and every verb's own meaning of 2, registry first, in verb then code order. */
export function exitTable(commands: readonly Command[] = COMMANDS): ExitCode[] {
  const rows = [...commands.flatMap((command): readonly ExitCode[] => command.exits ?? []), ...OUTSIDE_REGISTRY];
  return rows.sort((a, b): number => a.verb.localeCompare(b.verb) || a.code - b.code);
}

/** Whether `row` answers for `family` (and, when given, `verb`). */
function matches(row: ExitCode, family: string, verb: string | undefined): boolean {
  const [rowFamily, ...rest] = row.verb.split(" ");
  if (rowFamily !== family) return false;
  if (verb === undefined || rest[0] === "*") return true;
  return rest.join(" ") === verb || rest.join(" ").startsWith(`${verb} `);
}

export interface ExitsReport {
  readonly contract: typeof EXITS_CONTRACT;
  readonly filter: string | null;
  readonly scheme: readonly ExitCode[];
  readonly verbs: readonly ExitCode[];
}

const USAGE = `nen exits [<family> [<verb>]] [--json]

Every exit code above the shared 0/1/2 scheme, verb -> code -> meaning, read
from the registry: each family states its own codes, and docs/USAGE.md's exit
table is held to this output by a test. The same number means different
things in different verbs, so a caller branching on a code above 2 reads it
here for the verb it invoked.

  <family> [<verb>]  Only the rows for that family (and verb). A row spelled
                     '<family> *' answers for every verb of the family. An
                     unknown family, or a verb the family does not declare,
                     is exit 2 naming what it does declare; a verb with no row
                     of its own returns only 0, 1 and 2, and prints the scheme
                     alone. A row with code 2 is that verb's own meaning of
                     2, restating the shared one.

Reads nothing outside the binary. --json prints
  { contract: "${EXITS_CONTRACT}", filter, scheme: [{verb, code, meaning}],
    verbs: [{verb, code, meaning}] }.

Exit codes: 0 printed; 2 usage (an unknown family or verb, a third positional).`;

export const exitsCommand: Command = {
  name: "exits",
  summary: "Every exit code above 0/1/2, verb -> code -> meaning, read from the registry.",
  usage: USAGE,
  flags: {},
  run(context: CommandContext): number {
    const [, family, verb, extra] = context.args.positionals;
    if (extra !== undefined) throw new VerbUsageError(`'exits' takes at most <family> <verb>; unexpected '${extra}'.`);
    // `schema` is the other pre-registry command; it returns only 0, 1 and 2.
    const known = new Set([...COMMANDS.map((command): string => command.name), ...OUTSIDE_REGISTRY.map((row): string => row.verb), "schema"]);
    if (family !== undefined && !known.has(family)) {
      throw new VerbUsageError(`unknown family '${family}'. Run 'nen --help' for the families this binary carries.`);
    }
    const command = COMMANDS.find((entry): boolean => entry.name === family);
    if (verb !== undefined && command?.subcommands !== undefined && !command.subcommands.includes(verb)) {
      throw new VerbUsageError(`'${family}' has no verb '${verb}'; it declares ${command.subcommands.join(", ")}.`);
    }
    const all = exitTable();
    const verbs = family === undefined ? all : all.filter((row): boolean => matches(row, family, verb));
    const report: ExitsReport = {
      contract: EXITS_CONTRACT,
      filter: family === undefined ? null : [family, verb].filter((part): part is string => part !== undefined).join(" "),
      scheme: SHARED_SCHEME,
      verbs,
    };
    const width = Math.max(4, ...verbs.map((row): number => row.verb.length));
    const restated = verbs.some((row): boolean => row.code === 2);
    const lines = [
      "every verb:",
      ...SHARED_SCHEME.map((row): string => `  ${String(row.code)}  ${row.meaning}`),
      verbs.length === 0 ? "above 2: none -- this verb returns only 0, 1 and 2." : restated ? "its own codes (a 2 here restates the shared one for that verb), and above 2:" : "above 2:",
      ...verbs.map((row): string => `  ${row.verb.padEnd(width)}  ${String(row.code)}  ${row.meaning}`),
    ];
    emit(context.io, context.json, report, lines);
    return 0;
  },
};
