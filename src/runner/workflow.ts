// src/runner/workflow.ts -- `nen runner workflow`: the preflight workflow for
// one pool, rendered from a template the CALLER supplies.
//
// NEN CARRIES THE RENDERER, NOT THE TEMPLATE -- the split tenkai's
// `pr-readiness.yml` already has. The template is Hatsu's
// (`templates/runner-preflight.yml`); what nen owns is the substitution and
// the refusal: eight `@@NAME@@` placeholders, every one filled from the
// declaration, and any `@@X@@` left standing afterwards is exit 1 naming it --
// a workflow carrying a literal `@@RUNS_ON@@` would be a workflow GitHub
// rejects at the first push, or worse, one that parses and targets nothing.
// A template need not use every value: `@@MODE@@` (#333) arrived after the
// first templates shipped, and one that predates it still renders.
//
// THE RENDERED FILE MUST PARSE AS YAML. A template whose substitution produced
// a document the `yaml` reader refuses is refused here, before it lands on a
// branch and fails there.

import { parse } from "yaml";
import type { Target } from "../github/target.js";
import type { RunnerPool } from "../schema/workflow.js";

export const PLACEHOLDERS = ["REPO_SLUG", "RUNS_ON", "OS", "MODE", "TOOLS", "POOL_ID", "WORKFLOW_FILE", "RENDERED_BY"] as const;
const PLACEHOLDER = /@@([A-Za-z0-9_]+)@@/g;

export function workflowValues(pool: RunnerPool, target: Target, version: string): Readonly<Record<string, string>> {
  return {
    REPO_SLUG: target.slug,
    RUNS_ON: `[${pool.labels.join(", ")}]`,
    OS: pool.os,
    MODE: pool.mode,
    TOOLS: pool.tools.join(" "),
    POOL_ID: pool.id,
    WORKFLOW_FILE: pool.preflightWorkflow,
    RENDERED_BY: `nen ${version} runner workflow`,
  };
}

export interface RenderedWorkflow {
  readonly text: string;
  /** Every `@@X@@` still standing after substitution, once each, in order. */
  readonly leftovers: readonly string[];
  /** The YAML reader's refusal, or null when the document parses. */
  readonly yamlError: string | null;
}

export function renderWorkflow(template: string, values: Readonly<Record<string, string>>): RenderedWorkflow {
  const text = template.replace(PLACEHOLDER, (whole: string, name: string): string => values[name] ?? whole);
  const leftovers = [...new Set([...text.matchAll(PLACEHOLDER)].map((match): string => match[0]))];
  let yamlError: string | null = null;
  if (leftovers.length === 0) {
    try {
      parse(text);
    } catch (error) {
      yamlError = error instanceof Error ? error.message.split("\n")[0] ?? error.message : String(error);
    }
  }
  return { text, leftovers, yamlError };
}

/** How many lines of two texts differ, as a multiset: a count to name, not a diff to print. */
export function differingLines(before: string, after: string): number {
  const count = (text: string): Map<string, number> => {
    const map = new Map<string, number>();
    for (const line of text.replace(/\r\n/g, "\n").split("\n")) map.set(line, (map.get(line) ?? 0) + 1);
    return map;
  };
  const a = count(before);
  const b = count(after);
  let differ = 0;
  for (const line of new Set([...a.keys(), ...b.keys()])) differ += Math.abs((a.get(line) ?? 0) - (b.get(line) ?? 0));
  return differ;
}
