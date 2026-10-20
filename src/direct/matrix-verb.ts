// src/direct/matrix-verb.ts -- `nen direct matrix`.
//
// The whole routing table in one call (zheref/nen#426): every job in every domain
// in every language column, each cell answered by the resolver `nen direct resolve`
// runs (./matrix.ts's header says how, and why it owns no rule). What this module
// owns is the command boundary: the flags, the three files it reads (the registry,
// the taxonomy, the consumer's nen/workflow.json through the existing loader), the
// exit codes and the rendering.
//
// EXIT CODES (docs/USAGE.md, "Exit codes"): 0 the matrix; 1 a failure -- an invalid
// registry or taxonomy, an unreadable workflow, a registry that cannot route a job
// the taxonomy names, a job with no weight (the same refusals, by the same names,
// `resolve` gives); 2 a usage error -- a missing flag, an unknown or empty --job or
// --domain filter (each names the valid set).
//
// --repo is REQUIRED for the reason it is on `resolve`: the consumer's workflow is
// read from it, and a cwd default would spell another repository's aliases.

import { commaList } from "../cli/comma.js";
import { requireRepoFlag, requireValue, type CommandContext } from "../cli/command.js";
import { renderPipeTable } from "../cli/table.js";
import { loadClassifyTaxonomy } from "../classify/taxonomy.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadWorkflow } from "../schema/workflow.js";
import { buildMatrix, type Matrix, type MatrixCell } from "./matrix.js";
import { loadDirectRegistry } from "./registry.js";
import { renderEffort } from "./resolve.js";

export const MATRIX_CONTRACT = "nen.direct.matrix/v0.1";

function sideText(alias: string | null, substituted: string | null): string {
  if (alias === null) return "-";
  return substituted === null ? alias : `${alias} (for ${substituted})`;
}

function cellRow(job: string, domain: string, routed: string, phase: string, cell: MatrixCell): string[] {
  const winner = cell.skipped ? `skipped (${cell.pair.winner.alias}, a reviewer with no stand-in)` : sideText(cell.winner?.alias ?? null, cell.winner?.substituted ?? null);
  const runnerUp = cell.skipped ? "-" : cell.runnerUp === null ? "none distinct" : sideText(cell.runnerUp.alias, cell.runnerUp.substituted);
  return [job, domain, routed, phase, cell.lang, cell.cell, winner, runnerUp, renderEffort(cell.effort)];
}

export function renderMatrix(matrix: Matrix): string[] {
  const rows: string[][] = [["job", "domain", "routed on", "phase", "lang", "cell", "winner", "runner-up", "effort"]];
  for (const job of matrix.jobs) {
    for (const entry of job.domains) {
      if (!entry.reachable) {
        rows.push([job.job, entry.domain, "unreachable", "-", "-", "-", "-", "-", "-"]);
        continue;
      }
      const routed = entry.fallbackFrom === null ? (entry.routedOn ?? "-") : `${entry.routedOn ?? "-"} (fallback)`;
      for (const cell of entry.cells) rows.push(cellRow(job.job, entry.domain, routed, entry.phase ?? "-", cell));
    }
  }
  const lines = renderPipeTable(rows);
  const { counts } = matrix;
  lines.push(
    `${counts.jobs} job(s) x ${counts.domains} domain(s): ${counts.reachable} reachable, ${counts.unreachable} unreachable; ${counts.cells} cell(s), ${counts.skipped} skipped`,
  );
  return lines;
}

export function runMatrix(context: CommandContext): number {
  const args = context.args;
  const registryFlag = requireValue(args, "registry", "It is the model-direction registry file (relative paths resolve against --repo).");
  const taxonomyFlag = requireValue(args, "taxonomy", "It is the classification taxonomy file the languages, jobs and domains are read from (relative paths resolve against --repo).");
  const repoFlag = requireRepoFlag(context, "It is the checkout whose nen/workflow.json spells the model aliases per surface.");
  const root = assertRepoRoot({ repoFlag });

  const registry = loadDirectRegistry(root, registryFlag);
  const taxonomy = loadClassifyTaxonomy(root, taxonomyFlag);
  const loaded = loadWorkflow(root);

  const jobs = args.values["job"];
  const domains = args.values["domain"];
  const matrix = buildMatrix(
    { registry, taxonomy, models: loaded.workflow.models.surfaces },
    { jobs: jobs === undefined ? null : commaList(jobs), domains: domains === undefined ? null : commaList(domains) },
  );

  if (context.json) {
    const document = {
      contract: MATRIX_CONTRACT,
      inputs: {
        registry: registry.path,
        taxonomy: taxonomy.path,
        jobs: jobs === undefined ? null : commaList(jobs),
        domains: domains === undefined ? null : commaList(domains),
      },
      ...matrix,
    };
    context.io.out(JSON.stringify(document, null, 2));
    return 0;
  }
  for (const line of renderMatrix(matrix)) context.io.out(line);
  return 0;
}
