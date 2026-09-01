// src/fanout/command.ts -- `nen fanout compute` and `nen fanout record`.

import { appendFileSync } from "node:fs";
import { isAbsolute, resolve as resolvePath } from "node:path";
import {
  emit,
  requireSubcommand,
  requireValue,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { GIT, must, outputLines } from "../seam/exec.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { computeFanout, type FanoutRow } from "./compute.js";

const USAGE = `nen fanout compute --range <vPrev>..<vNew> [--workflows-dir <dir>]
nen fanout record --range <vPrev>..<vNew> [--workflows-dir <dir>] [--ledger <path>]

compute:
  changed-workflows(vPrev..vNew) INTERSECT each registered consumer's
  'consumes'. Every consumer is a row: 'affected' with its matched workflow
  basenames, or an EXPLICIT 'n/a' with its basis -- an unstated N/A is
  indistinguishable from an unswept repo (getsuga SKILL.md §7).
  --workflows-dir <dir>  Defaults to .github/workflows.

record:
  The same computation, appended to a ledger for audit (one line per consumer,
  per invocation) -- this verb never opens a repin PR itself; it records the
  decision a caller then acts on.`;

const DEFAULT_WORKFLOWS_DIR = ".github/workflows";
const DEFAULT_LEDGER = "fanout-ledger.jsonl";

function basenamesInRange(context: CommandContext, range: string, workflowsDir: string, root: string): string[] {
  const result = must(context.seams, GIT, ["diff", "--name-only", range, "--", `${workflowsDir}/`], { cwd: root });
  const paths = outputLines(result.stdout);
  const prefix = `${workflowsDir}/`;
  return [...new Set(paths.filter((path): boolean => path.startsWith(prefix)).map((path): string => path.slice(prefix.length)))];
}

function rowsFor(context: CommandContext): { range: string; changedWorkflows: string[]; rows: FanoutRow[] } {
  const range = requireValue(context.args, "range", "The <vPrev>..<vNew> range.");
  const workflowsDir = context.args.values["workflows-dir"] ?? DEFAULT_WORKFLOWS_DIR;
  const root = openTaxonomy({ repoFlag: context.repoFlag }).root;
  const changedWorkflows = basenamesInRange(context, range, workflowsDir, root);
  const registry = openTaxonomy({ repoFlag: context.repoFlag }).repos();
  const rows = computeFanout(registry, changedWorkflows);
  return { range, changedWorkflows, rows };
}

function compute(context: CommandContext): number {
  const { range, changedWorkflows, rows } = rowsFor(context);
  const lines = [
    `changed workflows in ${range}: ${changedWorkflows.join(", ") || "(none)"}`,
    ...rows.map((row): string => `${row.status === "affected" ? "AFFECTED" : "n/a     "}  ${row.repo}${row.code === null ? "" : ` (${row.code})`}  -- ${row.basis}`),
  ];
  emit(context.io, context.json, { range, changedWorkflows, rows }, lines);
  return 0;
}

function record(context: CommandContext): number {
  const { range, changedWorkflows, rows } = rowsFor(context);
  const root = openTaxonomy({ repoFlag: context.repoFlag }).root;
  const ledgerRaw = context.args.values["ledger"] ?? DEFAULT_LEDGER;
  const ledgerPath = isAbsolute(ledgerRaw) ? ledgerRaw : resolvePath(root, ledgerRaw);
  const now = context.seams.now().toISOString();

  const text = rows.map((row): string => JSON.stringify({ range, at: now, ...row })).join("\n") + "\n";
  appendFileSync(ledgerPath, text, "utf8");

  const lines = [`recorded ${rows.length} row(s) to ${ledgerPath}`];
  emit(context.io, context.json, { range, changedWorkflows, rows, ledgerPath }, lines);
  return 0;
}

export const fanoutCommand: Command = {
  name: "fanout",
  summary: "Compute or record the CON-22 fan-out set for a release range.",
  usage: USAGE,
  flags: { values: ["range", "workflows-dir", "ledger"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("fanout", context.args, ["compute", "record"]);
    return subcommand === "compute" ? compute(context) : record(context);
  },
};
