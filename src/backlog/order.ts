// src/backlog/order.ts -- the backlog-loop §2 priority order, applied to a
// pre-fetched set of rows.
//
// PORTED FROM the backlog-loop skill §2, verbatim:
//
//   Severity first: critical -> high -> medium -> low.
//   Within a severity, order by:
//     1. blocks another issue -- unblocking multiplies throughput;
//     2. affects consumer behaviour or developer experience;
//     3. age -- oldest first, so nothing rots.
//
// THE SEVERITY ORDER IS A PARAMETER, never a literal. `critical`/`high`/
// `medium`/`low` are this repository's OWN severity vocabulary
// (schemas/labels.json's `severity` family); a binary that hard-coded them
// would rank a repository with a different severity vocabulary by names it
// does not have. The caller states the order (`--severity-order`), naming
// its own repository's severities in its own priority order; a row whose
// severity is not in that list ranks LAST, after every named severity --
// unlabelled/untriaged work does not silently jump the queue.
//
// "BLOCKS ANOTHER ISSUE" AND "AFFECTS CONSUMER BEHAVIOUR" ARE JUDGEMENT
// CALLS the skill makes by reading the issue, not facts derivable from a
// label alone -- so they arrive as caller-supplied per-row flags rather than
// being inferred here. This module is the ARITHMETIC of the ordering; the
// judgement stays the caller's, exactly as it stays the skill's.

export interface OrderableRow {
  /** An opaque identity, echoed back in the ordered result -- never interpreted. */
  readonly id: string;
  /** null when the row carries no recognised severity label. */
  readonly severity: string | null;
  readonly blocksOther: boolean;
  readonly affectsConsumers: boolean;
  readonly createdAt: string;
  /** The final, deterministic tie-break once every other key ties. */
  readonly number: number;
}

export interface OrderedRow extends OrderableRow {
  /** The severity's index in --severity-order, or null when unranked (sorts last). */
  readonly severityRank: number | null;
}

export function orderBacklog(
  rows: readonly OrderableRow[],
  severityOrder: readonly string[],
): OrderedRow[] {
  const rank = new Map(severityOrder.map((name, index): [string, number] => [name, index]));
  const withRank: OrderedRow[] = rows.map((row): OrderedRow => ({
    ...row,
    severityRank: row.severity === null ? null : (rank.get(row.severity) ?? null),
  }));

  return withRank.slice().sort((a, b): number => {
    const severityCompare = compareRank(a.severityRank, b.severityRank);
    if (severityCompare !== 0) return severityCompare;

    // "blocks another issue" -- true outranks false.
    if (a.blocksOther !== b.blocksOther) return a.blocksOther ? -1 : 1;

    // "affects consumer behaviour or developer experience" -- true outranks false.
    if (a.affectsConsumers !== b.affectsConsumers) return a.affectsConsumers ? -1 : 1;

    // age -- OLDEST first, so nothing rots.
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? -1 : 1;

    // Final deterministic tie-break: lower number first.
    return a.number - b.number;
  });
}

// null (unranked) sorts LAST -- after every named severity, never interleaved
// among them: untriaged work does not silently jump a triaged queue.
function compareRank(a: number | null, b: number | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return a - b;
}
