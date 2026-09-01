// src/repo/scenario.ts -- `nen repo scenario`: the caller workflow's scenario
// read straight off the target repository's own registry entry.
//
// A LOOKUP, NOT A COMPUTATION. `schemas/repos.json`'s consumer entries already
// carry a `scenario` field (../schema/repos.ts's ConsumerEntry) -- the value
// bankai-quality/-handbooks resolution reads to pick a tooling and rule set.
// This module's only job is naming the failure honestly when the lookup comes
// back empty: an unrecorded consumer or an unrecorded scenario are two
// DIFFERENT gaps, and conflating them into one generic "not found" would send
// a caller fixing the wrong file.

import type { RepoRegistry } from "../schema/repos.js";

export type ScenarioResult =
  | { readonly ok: true; readonly scenario: string }
  | { readonly ok: false; readonly reason: string };

export function resolveScenario(registry: RepoRegistry, repoSlug: string): ScenarioResult {
  const entry = registry.byRepo(repoSlug);
  if (entry === undefined) {
    return {
      ok: false,
      reason: `'${repoSlug}' is not a consumer in ${registry.path}. Its scenario cannot be read from a registry that does not know it.`,
    };
  }
  if (entry.scenario === null) {
    return {
      ok: false,
      reason: `'${repoSlug}' is a consumer in ${registry.path}, but its entry carries no 'scenario' field.`,
    };
  }
  return { ok: true, scenario: entry.scenario };
}
