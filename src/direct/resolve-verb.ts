// src/direct/resolve-verb.ts -- `nen direct resolve`.
//
// The deterministic half of `direct`: given an issue's classification (its
// languages and jobs, from the classify family) and what kind of repository it
// is, say which model should do the work, on which surface, at which effort.
// Hatsu's ruling of 2026-10-04 is in ./resolve.ts's header; what this module owns
// is the command boundary: flags, the three files it reads (the registry, the
// taxonomy, the consumer's nen/workflow.json through the existing loader), the
// exit codes, the rendering, and the optional record.
//
// EXIT CODES (docs/USAGE.md, "Exit codes"): 0 an answer -- a mismatch with the
// running session IS an answer and still exits 0, and so is `undirectable` (an
// empty job axis: the caller carries on on its own session); 1 a failure (an
// invalid registry or taxonomy, an unreadable workflow, a registry that cannot route
// what the taxonomy names); 2 a usage error (a missing flag, an unknown language or
// job key, a surface or level outside the registry's -- each names the valid set --
// or a refused --record).
//
// KIND AND ROLE ARE THE FLAGS' VERBATIM VALUES, as `nen repo classify --json` printed
// them; the verb never re-derives them from --repo, which only names the checkout the
// workflow is read from and the root every path resolves against.
//
// EVERY PATH FLAG resolves against --repo's root (zheref/nen#100); --repo is
// REQUIRED here because the consumer's workflow is read from it, and a silent cwd
// default would read the wrong repository's models block with a confident answer.

import { commaList } from "../cli/comma.js";
import { requireRepoFlag, requireValue, type CommandContext } from "../cli/command.js";
import { renderPipeTable } from "../cli/table.js";
import { loadClassifyTaxonomy } from "../classify/taxonomy.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadWorkflow } from "../schema/workflow.js";
import { recordPath, writeRecord } from "./record.js";
import { loadDirectRegistry } from "./registry.js";
import {
  parseInputs,
  parseSession,
  renderEffort,
  resolveDirection,
  UNSPELLED,
  type Mismatch,
  type Resolution,
  type ResolvedSide,
} from "./resolve.js";

export const RESOLVE_CONTRACT = "nen.direct.resolve/v0.1";

function sideRow(label: string, side: ResolvedSide): string[] {
  const where = side.surface === null ? "-" : `${side.surface}${side.tier === null ? "" : `/${side.tier}`}`;
  return [label, side.alias, where, side.surfaceAlias === null ? "-" : side.surfaceAlias, side.restart ?? "-"];
}

function mismatchLine(mismatch: Mismatch): string {
  const parts = mismatch.compares.map((compare): string => {
    if (compare.verdict === "match") return `${compare.field} match`;
    if (compare.verdict === "unread") return `${compare.field} unread`;
    return `${compare.field} ${compare.session} != ${compare.recommended ?? "-"}`;
  });
  return `mismatch: ${mismatch.match ? "no" : "yes"} (${parts.join("; ")}); within ${mismatch.within}`;
}

export function renderResolution(resolution: Resolution, recorded: string | null): string[] {
  const { winner, runnerUp, domain, effort } = resolution;
  if (resolution.undirectable !== null || winner === null || domain === null || effort === null) {
    const lines = [`undirectable: ${resolution.undirectable ?? "nothing to direct"}`];
    if (recorded !== null) lines.push(`recorded ${recorded}`);
    return lines;
  }
  const lines = renderPipeTable([
    ["", "alias", "surface/tier", "model alias", "restart"],
    sideRow("winner", winner),
    ...(runnerUp === null ? [] : [sideRow("runner-up", runnerUp)]),
    ...(resolution.recommended === null ? [] : [sideRow("recommended", resolution.recommended)]),
  ]);
  if (runnerUp === null) lines.push("runner-up: none distinct");
  for (const side of [winner, runnerUp]) {
    if (side !== null && side.substituted !== null) lines.push(`note: ${side.alias} stands in for ${side.substituted}`);
  }
  // One line per tool: the entries are sentences, and a sentence in a table cell
  // would set the width of the whole column.
  for (const entry of winner.interactive) lines.push(`interactive: ${entry}`);
  if (winner.snapshot !== null) {
    const quote = winner.snapshot;
    lines.push(
      `snapshot ${quote.asOf}: ${quote.primary}${quote.modelId === null ? "" : ` (${quote.modelId})`}; fallback ${quote.fallback}`,
    );
  }
  if (winner.liveLookup !== null) {
    lines.push(`live lookup (${winner.provider}): ${[winner.liveLookup.cli, ...winner.liveLookup.docs].filter((entry): boolean => entry !== null).join("; ")}`);
  }
  if (winner.surfaceAlias === UNSPELLED) {
    lines.push(`note: nen/workflow.json spells no alias for ${winner.alias} on ${winner.surface ?? "-"} (models block missing or without tier ${winner.tier ?? "-"}); the restart line keeps its placeholder.`);
  }
  for (const pair of resolution.pairs) {
    const phase = `${pair.phase} ${pair.phaseName}`;
    lines.push(
      `pair ${pair.job} x ${pair.lang}: ${pair.winner.alias}${pair.winner.substituted === null ? "" : ` (for ${pair.winner.substituted})`}, runner-up ${pair.runnerUp.alias}${pair.runnerUp.substituted === null ? "" : ` (for ${pair.runnerUp.substituted})`}${pair.companion ? `, companion ${pair.role ?? "-"}` : ""}  [${pair.domain}, ${phase}, cell ${pair.cell}]`,
    );
  }
  for (const skip of resolution.aggregate?.skipped ?? []) {
    lines.push(`skipped: ${skip.job} x ${skip.lang}, winner ${skip.alias} is a reviewer with no stand-in`);
  }
  lines.push(`domain: ${domain.domain} (rule ${domain.rule}${domain.because === null ? "" : `: ${domain.because}`})`);
  lines.push(...domain.fallbacks);
  lines.push(`effort: ${renderEffort(effort)}${effort.surfaceEffort === null ? "" : ` (${winner.surface ?? "-"}: ${effort.surfaceEffort})`}`);
  if (resolution.mismatch !== null) lines.push(mismatchLine(resolution.mismatch));
  if (recorded !== null) lines.push(`recorded ${recorded}`);
  return lines;
}

export function runResolve(context: CommandContext): number {
  const args = context.args;
  const registryFlag = requireValue(args, "registry", "It is the model-direction registry file (relative paths resolve against --repo).");
  const taxonomyFlag = requireValue(args, "taxonomy", "It is the classification taxonomy file the languages, jobs and domains are read from (relative paths resolve against --repo).");
  const kind = requireValue(args, "kind", "It is the repository's kind, exactly as 'nen repo classify --json' printed it.");
  const repoFlag = requireRepoFlag(context, "It is the checkout whose nen/workflow.json spells the model aliases per surface.");
  const root = assertRepoRoot({ repoFlag });
  const record = args.values["record"];
  // Refused BEFORE anything is read or resolved: a traversal is a typo, and
  // "you typed it wrong" outranks every failure the files could produce.
  const target = record === undefined ? null : recordPath(root, record);

  const registry = loadDirectRegistry(root, registryFlag);
  const taxonomy = loadClassifyTaxonomy(root, taxonomyFlag);
  const loaded = loadWorkflow(root);

  // --job and --lang may be empty or omitted: an empty axis is an ANSWER (see ./resolve.ts).
  const inputs = parseInputs(taxonomy, {
    langs: commaList(args.values["lang"]),
    jobs: commaList(args.values["job"]),
    kind,
    role: args.values["role"] ?? null,
    labels: commaList(args.values["labels"]),
  });
  const session = parseSession(registry, {
    surface: args.values["surface"] ?? null,
    model: args.values["model"] ?? null,
    effort: args.values["effort"] ?? null,
  });

  const resolution = resolveDirection({ registry, taxonomy, models: loaded.workflow.models.surfaces }, inputs, session);

  const document = {
    contract: RESOLVE_CONTRACT,
    inputs: {
      langs: inputs.langs,
      jobs: inputs.jobs,
      kind: inputs.kind,
      role: inputs.role,
      labels: inputs.labels,
      surface: session.surface,
      model: session.model,
      effort: session.effort,
    },
    undirectable: resolution.undirectable,
    domain: resolution.domain,
    pairs: resolution.pairs,
    aggregate: resolution.aggregate,
    winner: resolution.winner,
    runnerUp: resolution.runnerUp,
    recommended: resolution.recommended,
    effort: resolution.effort,
    mismatch: resolution.mismatch,
    effortId: record ?? null,
    record: target,
  };

  if (target !== null) {
    writeRecord(root, target, { ...document, recordedAt: context.seams.now().toISOString() });
  }

  if (context.json) {
    context.io.out(JSON.stringify(document, null, 2));
    return 0;
  }
  for (const line of renderResolution(resolution, target)) context.io.out(line);
  return 0;
}
