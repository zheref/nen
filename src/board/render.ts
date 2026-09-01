// src/board/render.ts -- rendering a Board as a padded markdown table
// (bankai-core#653's convention -- see ../cli/table.ts and ../stop/command.ts,
// which share it).

import { renderPipeTable } from "../cli/table.js";
import type { Board } from "./build.js";

const HEADER = ["Effort", "Refs", "Status (gate)", "Needs"];

export function renderBoard(board: Board): string[] {
  const rows = board.rows.map((row): string[] => [
    row.title,
    row.refs.join(", "),
    row.gate === null ? row.status : `${row.status} (${row.gate})`,
    row.needs ?? "",
  ]);
  return [
    `${board.repo} -- generated ${board.generatedAt}`,
    "",
    ...renderPipeTable([HEADER, ...rows]),
  ];
}
