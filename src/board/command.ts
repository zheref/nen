// src/board/command.ts -- `nen board build`, `nen board render`, `nen board
// diff`.
//
// FIDELITY GAP, DISCLOSED: this ports bankai-core's `scripts/ichigo_board.sh`
// (bankai-core#653) at reduced scope. The source is 1365 lines assembling its
// OWN per-row gate and colour from a live fetch, with per-repository section
// headers and inline warm-up/staleness annotations. This port instead takes
// ALREADY-COMPUTED rows (each row's gate from 'nen gate derive', its colour
// from 'nen color status') and does the board's remaining job: hold them as
// one shape, render them as bankai-core#653's padded markdown table, and diff
// two snapshots. The full script's section layout and its warm-up-sweep
// integration are not reproduced here -- see 'nen warmup' for the sweep
// itself, run separately rather than folded into the board's own output.

import {
  emit,
  requireSubcommand,
  requireValue,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { readJsonFile } from "../cli/inputs.js";
import { resolveRepoRoot } from "../repo/root.js";
import { buildBoard, type Board, type BoardRow } from "./build.js";
import { diffBoards } from "./diff.js";
import { renderBoard } from "./render.js";

const USAGE = `nen board build --repo-slug <owner/name> --rows-from <path>
nen board render --board-from <path>
nen board diff --before <path> --after <path>

build:
  Assembles a Board from already-computed rows (a row's gate from 'nen gate
  derive', its colour from 'nen color status'). --rows-from is a JSON array
  of BoardRow: { id, title, refs, gate, status, needs }.

render:
  Renders a Board (a 'board build --json' result) as the padded-markdown
  table this port's source repository established.

diff:
  Field-level diff of two Board snapshots, by row id -- for a caller
  re-rendering the board on every state change and wanting to say what
  changed, not re-announce the whole board.`;

function build(context: CommandContext): number {
  const repo = requireValue(context.args, "repo-slug", "The repository this board is for.");
  const rowsPath = requireValue(context.args, "rows-from", "The already-computed rows to assemble.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const rows = readJsonFile<readonly BoardRow[]>(rowsPath, root);
  const board = buildBoard(repo, context.seams.now().toISOString(), rows);
  emit(context.io, context.json, board, renderBoard(board));
  return 0;
}

function render(context: CommandContext): number {
  const boardPath = requireValue(context.args, "board-from", "The board JSON to render.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const board = readJsonFile<Board>(boardPath, root);
  const lines = renderBoard(board);
  emit(context.io, context.json, board, lines);
  return 0;
}

function diff(context: CommandContext): number {
  const beforePath = requireValue(context.args, "before", "The earlier board snapshot.");
  const afterPath = requireValue(context.args, "after", "The later board snapshot.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const before = readJsonFile<Board>(beforePath, root);
  const after = readJsonFile<Board>(afterPath, root);
  const result = diffBoards(before, after);

  const lines = result.changed
    ? result.rows.map((row): string =>
        row.kind === "changed"
          ? `changed  ${row.id}: ${row.changes.map((c): string => `${c.field} '${c.before}' -> '${c.after}'`).join(", ")}`
          : `${row.kind}  ${row.id}`,
      )
    : ["no change"];
  emit(context.io, context.json, result, lines);
  return 0;
}

export const boardCommand: Command = {
  name: "board",
  summary: "Assemble, render, or diff the gate board.",
  usage: USAGE,
  flags: { values: ["repo-slug", "rows-from", "board-from", "before", "after"] },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("board", context.args, ["build", "render", "diff"]);
    if (subcommand === "build") return build(context);
    if (subcommand === "render") return render(context);
    return diff(context);
  },
};
