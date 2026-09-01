// src/fanout/compute.ts -- CON-22's fan-out computation: changed-workflows
// (prev..new) INTERSECT each consumer's `consumes`, with an EXPLICIT N/A row
// for every consumer the intersection misses.
//
// PORTED FROM getsuga SKILL.md §7: "Compute the affected set factually:
// changed-workflows INTERSECT consumes, where changed-workflows is the
// .github/workflows/** diff across <vPrev>..<newTag> and consumes comes from
// schemas/repos.json. Record every unaffected consumer as an explicit N/A
// with its basis -- an unstated N/A is indistinguishable from an unswept
// repo."
//
// THE SET OPERATION ITSELF IS ../schema/repos.ts's `affectedBy()` -- this
// module's own addition is making the MISSES explicit rather than merely not
// returning them, which is the whole point getsuga §7 is making.

import type { ConsumerEntry, RepoRegistry } from "../schema/repos.js";

export interface FanoutRow {
  readonly repo: string;
  readonly code: string | null;
  readonly status: "affected" | "n/a";
  /** Changed workflow basenames this consumer's own `consumes` names. */
  readonly matchedWorkflows: readonly string[];
  readonly basis: string;
}

export function computeFanout(
  registry: RepoRegistry,
  changedWorkflows: readonly string[],
): FanoutRow[] {
  const changed = new Set(changedWorkflows);
  return registry.consumers.map((entry: ConsumerEntry): FanoutRow => {
    const matched = entry.consumes.filter((name): boolean => changed.has(name));
    if (matched.length > 0) {
      return {
        repo: entry.repo,
        code: entry.code,
        status: "affected",
        matchedWorkflows: matched,
        basis: `consumes ${matched.join(", ")}, which changed in this range`,
      };
    }
    return {
      repo: entry.repo,
      code: entry.code,
      status: "n/a",
      matchedWorkflows: [],
      basis:
        entry.consumes.length === 0
          ? "declares no consumed workflows"
          : `consumes ${entry.consumes.join(", ")}, none of which changed in this range`,
    };
  });
}
