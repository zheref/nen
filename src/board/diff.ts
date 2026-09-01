// src/board/diff.ts -- a field-level diff of two Board snapshots.
//
// FOR "EVERY STATE-CHANGE MODE" (the issue's own phrase): a caller re-renders
// the board on an interval or on a webhook and wants to know WHAT CHANGED,
// not just the new state -- an unchanged board re-announced in full is noise
// a human stops reading. Matched by `id`; a row present in one snapshot and
// absent in the other is `added`/`removed` rather than a change with a blank
// side, so a reader is never asked to infer which half is missing.

import type { Board, BoardRow } from "./build.js";

export interface FieldChange {
  readonly field: keyof BoardRow;
  readonly before: string;
  readonly after: string;
}

export interface RowDiff {
  readonly id: string;
  readonly kind: "added" | "removed" | "changed";
  readonly changes: readonly FieldChange[];
}

export interface BoardDiff {
  readonly rows: readonly RowDiff[];
  readonly changed: boolean;
}

function fieldsOf(row: BoardRow): Record<keyof BoardRow, string> {
  return {
    id: row.id,
    title: row.title,
    refs: row.refs.join(","),
    gate: row.gate ?? "",
    status: row.status,
    needs: row.needs ?? "",
  };
}

export function diffBoards(before: Board, after: Board): BoardDiff {
  const beforeById = new Map(before.rows.map((row): [string, BoardRow] => [row.id, row]));
  const afterById = new Map(after.rows.map((row): [string, BoardRow] => [row.id, row]));
  const rows: RowDiff[] = [];

  for (const row of before.rows) {
    if (!afterById.has(row.id)) rows.push({ id: row.id, kind: "removed", changes: [] });
  }
  for (const row of after.rows) {
    const prior = beforeById.get(row.id);
    if (prior === undefined) {
      rows.push({ id: row.id, kind: "added", changes: [] });
      continue;
    }
    const priorFields = fieldsOf(prior);
    const nextFields = fieldsOf(row);
    const changes: FieldChange[] = [];
    for (const field of Object.keys(nextFields) as (keyof BoardRow)[]) {
      if (priorFields[field] !== nextFields[field]) {
        changes.push({ field, before: priorFields[field], after: nextFields[field] });
      }
    }
    if (changes.length > 0) rows.push({ id: row.id, kind: "changed", changes });
  }

  return { rows, changed: rows.length > 0 };
}
