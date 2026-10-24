// src/run/issue.ts -- one issue spelling per run manifest, `<owner/name>#<N>`
// (Nobunaga and Bugbot on zheref/nen#516). Shared by `run append`, `run park`
// and `run import`, so the three cannot record one issue two ways.

import { VerbUsageError } from "../cli/command.js";
import { resolveToken } from "../repo/resolve.js";
import { loadRepoRegistry } from "../schema/repos.js";
import type { RunManifest, RunParked, RunPr } from "./manifest.js";

/**
 * ONE SPELLING PER ISSUE IN A MANIFEST (Nobunaga on #516): `<owner/name>#<N>`.
 * A `<CODE>#<N>` is resolved through --repo's nen/repos.json (the registry `nen
 * ref` reads), so a run that appends `HA#12` and an import that wrote
 * `zheref/hatsu#12` name one issue. A code the registry does not resolve to an
 * `owner/name` is exit 2: inventing an owner is a guess.
 */
export function normaliseIssue(root: string, issue: string): string {
  const hash = issue.lastIndexOf("#");
  const scope = issue.slice(0, hash);
  if (scope.includes("/")) return issue;
  let registry;
  try {
    registry = loadRepoRegistry(root);
  } catch (error) {
    throw new VerbUsageError(`--issue '${issue}' is a code form and --repo's nen/repos.json could not resolve it (${error instanceof Error ? error.message : String(error)}). Pass <owner/name>#<N>.`);
  }
  let hits;
  try {
    hits = resolveToken(registry, scope);
  } catch (error) {
    throw new VerbUsageError(`--issue '${issue}': the code '${scope}' does not resolve in nen/repos.json (${error instanceof Error ? error.message : String(error)}). Pass <owner/name>#<N>.`);
  }
  const repo = hits[0]?.repo;
  if (hits.length !== 1 || repo === undefined || !repo.includes("/")) throw new VerbUsageError(`--issue '${issue}': the code '${scope}' resolves to no single owner/name in nen/repos.json. Pass <owner/name>#<N>.`);
  return `${repo}${issue.slice(hash)}`;
}


/** The same, never throwing: an unresolvable spelling is kept as written (for rows a manifest already holds). */
export function normaliseLenient(root: string, issue: string): string {
  try {
    return normaliseIssue(root, issue);
  } catch {
    return issue;
  }
}

/**
 * A manifest with every recorded issue in the one spelling, parked rows that
 * collapse to the same issue and row deduplicated (the earliest kept), and
 * whether anything changed. Rows written before the spelling was fixed (a
 * `<CODE>#<N>`) would otherwise be parked twice by an import.
 */
export function normaliseManifest(root: string, manifest: RunManifest): { manifest: RunManifest; changed: boolean } {
  const prs = manifest.prs.map((row): RunPr => (row.issue === null ? row : { ...row, issue: normaliseLenient(root, row.issue) }));
  const parked: RunParked[] = [];
  for (const row of manifest.parked) {
    const issue = normaliseLenient(root, row.issue);
    if (parked.some((kept): boolean => kept.issue === issue && kept.row === row.row)) continue;
    parked.push({ ...row, issue });
  }
  const next = { ...manifest, prs, parked };
  return { manifest: next, changed: JSON.stringify(next) !== JSON.stringify(manifest) };
}
