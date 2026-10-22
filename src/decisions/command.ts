// src/decisions/command.ts -- `nen decisions summary`: the counts a canon's
// prose would otherwise carry about its own decision matrix.
//
// WHY A VERB FOR A COUNT. A sentence like "fourteen rows stop for a person,
// ten of them at G5" is true on the day it is written and wrong the day a row
// lands; the number has one source, `nen/decisions.json`, and every copy of it
// in prose is a second source that drifts (zheref/hatsu ruling HR-13's ratchet
// exists for exactly that class of defect). So the prose cites this verb and
// the verb reads the file: rows per class, rows per gate, and the ids of the
// G5 rows (the "kinds" a G5 stop may be), in the file's own order.
//
// IT DECIDES NOTHING. It validates the file through the same loader
// `nen schema check` uses (../schema/decisions.ts) and counts. "Could not
// read" is never "nothing found": an absent file is exit 1, not an empty
// summary at exit 0, and a malformed one is exit 1 naming the pointer.

import { emit, refuseExtraPositionals, requireSubcommand, type Command, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadDecisions, type DecisionMatrix } from "../schema/decisions.js";

export const DECISIONS_SUMMARY_CONTRACT = "nen.decisions.summary/v0.1";

const CLASSES = ["autonomous", "ask-once-per-run", "human-gate"] as const;
const GATES = ["G1", "G1-M", "G2", "G3", "G4", "G5"] as const;

const USAGE = `nen decisions summary [--repo <path>] [--json]

The counts of a repository's decision matrix, nen/decisions.json, read from
the file so prose never carries them: rows per class (autonomous,
ask-once-per-run, human-gate), rows per gate (G1, G1-M, G2, G3, G4, G5, and
'none' for a row with no gate), and the ids of the G5 rows in file order.
Reads one file; writes nothing; decides nothing.

Exit 0 with the summary; 1 when nen/decisions.json is absent or does not
validate (the loader's pointer is named) -- an absent matrix is never an
empty summary; 2 a usage error.

--json shape (key order as listed):
  { contract: "${DECISIONS_SUMMARY_CONTRACT}", repo, path, rows, classes, gates, g5 }`;

export interface DecisionsSummary {
  readonly contract: typeof DECISIONS_SUMMARY_CONTRACT;
  readonly repo: string;
  readonly path: string;
  readonly rows: number;
  readonly classes: Readonly<Record<(typeof CLASSES)[number], number>>;
  readonly gates: Readonly<Record<(typeof GATES)[number] | "none", number>>;
  readonly g5: readonly string[];
}

export function summarizeDecisions(repo: string, matrix: DecisionMatrix): DecisionsSummary {
  const classes = { autonomous: 0, "ask-once-per-run": 0, "human-gate": 0 };
  const gates = { G1: 0, "G1-M": 0, G2: 0, G3: 0, G4: 0, G5: 0, none: 0 };
  for (const row of matrix.rows) {
    classes[row.class]++;
    gates[row.gate ?? "none"]++;
  }
  return {
    contract: DECISIONS_SUMMARY_CONTRACT,
    repo,
    path: matrix.path,
    rows: matrix.rows.length,
    classes,
    gates,
    g5: matrix.rows.filter((row): boolean => row.gate === "G5").map((row): string => row.id),
  };
}

export function renderDecisionsSummary(summary: DecisionsSummary): string[] {
  return [
    `decisions: ${summary.path}`,
    `rows: ${summary.rows}`,
    `classes: ${CLASSES.map((klass): string => `${klass} ${summary.classes[klass]}`).join(" · ")}`,
    `gates: ${[...GATES, "none" as const].map((gate): string => `${gate} ${summary.gates[gate]}`).join(" · ")}`,
    `g5: ${summary.g5.length === 0 ? "(none)" : summary.g5.join(", ")}`,
  ];
}

export const decisionsCommand: Command = {
  name: "decisions",
  subcommands: ["summary"],
  summary: "Count a repository's decision matrix (nen/decisions.json) so prose never carries the numbers.",
  usage: USAGE,
  flags: {},
  run(context: CommandContext): number {
    requireSubcommand("decisions", context.args, ["summary"]);
    refuseExtraPositionals(context.args, 2);
    const repo = assertRepoRoot({ repoFlag: context.repoFlag });
    const matrix = loadDecisions(repo);
    if (!matrix.present) {
      context.io.err(`nen decisions summary: ${matrix.path} is absent. There is no matrix to count, and an absent file is never an empty summary.`);
      return 1;
    }
    const summary = summarizeDecisions(repo, matrix);
    emit(context.io, context.json, summary, renderDecisionsSummary(summary));
    return 0;
  },
};
