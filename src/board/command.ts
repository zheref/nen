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
  VerbUsageError,
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
  of BoardRow: { id, title, refs, gate, status, needs }. 'refs' is an ARRAY
  of ref strings, one per reference -- never a single pre-joined string.

render:
  Renders a Board (a 'board build --json' result) as the padded-markdown
  table this port's source repository established.

diff:
  Field-level diff of two Board snapshots, by row id -- for a caller
  re-rendering the board on every state change and wanting to say what
  changed, not re-announce the whole board.`;

// EVERY ROW IS VALIDATED AT THE JSON BOUNDARY, NOT CAST PAST IT (#32).
// `readJsonFile<readonly BoardRow[]>` was a compile-time assertion about
// runtime data: a caller who reshaped `refs` as ONE joined string -- the
// reading the field's own plural name invites, and exactly what
// zheref/hatsu's backlog-loop reached for -- sailed straight through the
// cast and crashed downstream, inside ../board/render.ts, as a raw
// "row.refs.join is not a function" TypeError that names no row, no field
// and no expected shape. So the shape is refused HERE, up front, in this
// CLI's own voice -- by row, by field, expected and got -- mirroring
// ../pr/command.ts's validateWakes, this repository's exemplar for exactly
// this crash class. The check covers every field, not just `refs`: each of
// the others read off unvalidated JSON also reaches a consumer that calls
// string methods on it (render's padding, diff's comparisons) and would
// throw the same undesigned TypeError one field over.

const ROW_SHAPE = "{ id, title, refs, gate, status, needs }";

// The "got" half of a refusal. Bare `typeof` is not enough: `typeof null`
// is "object", an array is "object" too, and a missing field would print as
// the grammatically hostile "undefined" -- each sends the caller hunting
// for a mistake they did not make.
function describeValue(value: unknown): string {
  if (value === undefined) return "nothing (the field is missing)";
  if (value === null) return "null";
  if (Array.isArray(value)) return "an array";
  if (typeof value === "string") return `the string '${value}'`;
  return `a ${typeof value}`;
}

// A refusal that cannot say WHICH row it refuses sends the caller back to
// bisecting the file by hand. The row's own id is used whenever it is a
// usable name; the index is the fallback, not the default.
function rowLabel(row: Readonly<Record<string, unknown>>, index: number): string {
  const id = row["id"];
  return typeof id === "string" && id !== "" ? `row '${id}'` : `row at index ${index}`;
}

function validateBoardRows(raw: unknown, path: string): readonly BoardRow[] {
  if (!Array.isArray(raw)) {
    throw new VerbUsageError(
      `'${path}' must be a JSON ARRAY of BoardRow ${ROW_SHAPE}, got ${describeValue(raw)}. A single row is a one-element array, never a bare object.`,
    );
  }
  return raw.map((item: unknown, index: number): BoardRow => {
    if (typeof item !== "object" || item === null || Array.isArray(item)) {
      throw new VerbUsageError(
        `'${path}': row at index ${index} is ${describeValue(item)}, not a BoardRow object ${ROW_SHAPE}.`,
      );
    }
    const row = item as Record<string, unknown>;
    const label = rowLabel(row, index);

    const id = row["id"];
    if (typeof id !== "string") {
      throw new VerbUsageError(
        `'${path}': ${label} needs a string 'id' (an issue number, a PR-only effort's PR number, or a caller-chosen id), got ${describeValue(id)}. The id is how 'board diff' -- and every refusal here -- addresses a row.`,
      );
    }
    const title = row["title"];
    if (typeof title !== "string") {
      throw new VerbUsageError(
        `'${path}': ${label} needs a string 'title', got ${describeValue(title)}.`,
      );
    }
    // THE FIELD #32 WAS FILED FOR. A pre-joined string cannot be split back
    // into refs without guessing at its separator, so it is refused rather
    // than rendered as-is -- and the refusal spells out the one-element-array
    // form, because "I have one ref" is exactly the case that invites the
    // bare string.
    const refs = row["refs"];
    if (!Array.isArray(refs)) {
      throw new VerbUsageError(
        `'${path}': ${label} has the wrong shape for 'refs': expected an ARRAY of ref strings, one per reference (e.g. ["XX-IS-#12", "XX-PR-#34"]; a row with one reference sends a one-element array), got ${describeValue(refs)}.`,
      );
    }
    const badRefs = refs.flatMap((entry: unknown, refIndex: number): string[] =>
      typeof entry === "string" ? [] : [`refs[${refIndex}] is ${describeValue(entry)}`],
    );
    if (badRefs.length > 0) {
      // Every wrong entry is named at once, not just the first -- the same
      // "report the whole problem" idiom as ../cli/command.ts's
      // splitIntegerList, because fixing one entry per round trip is the
      // exact cost this CLI designs against elsewhere.
      throw new VerbUsageError(
        `'${path}': ${label} has non-string entr${badRefs.length === 1 ? "y" : "ies"} in 'refs': ${badRefs.join(", ")}. Each entry is ONE pre-formatted ref string ('nen ref format' output).`,
      );
    }
    const gate = row["gate"];
    if (gate !== null && typeof gate !== "string") {
      throw new VerbUsageError(
        `'${path}': ${label} has the wrong shape for 'gate': expected a string, or null for a row that carries no gate, got ${describeValue(gate)}. An omitted field is not the same statement as null -- only null says out loud that nobody owes this row a gate.`,
      );
    }
    const status = row["status"];
    if (typeof status !== "string") {
      throw new VerbUsageError(
        `'${path}': ${label} needs a string 'status' (the ALREADY-RENDERED colour token from 'nen color status'), got ${describeValue(status)}. This verb composes the colour; it never derives one.`,
      );
    }
    const needs = row["needs"];
    if (needs !== null && typeof needs !== "string") {
      throw new VerbUsageError(
        `'${path}': ${label} has the wrong shape for 'needs': expected one line as a string, or null when nothing is owed, got ${describeValue(needs)}.`,
      );
    }
    // Rebuilt to the DECLARED shape rather than passed through, so the
    // emitted --json carries exactly the six BoardRow fields in their
    // declared order -- an undeclared extra field echoed back would be a
    // --json surface nobody promised.
    return { id, title, refs: refs.map((entry): string => entry as string), gate, status, needs };
  });
}

function build(context: CommandContext): number {
  const repo = requireValue(context.args, "repo-slug", "The repository this board is for.");
  const rowsPath = requireValue(context.args, "rows-from", "The already-computed rows to assemble.");
  const root = resolveRepoRoot({ repoFlag: context.repoFlag });
  const rows = validateBoardRows(readJsonFile<unknown>(rowsPath, root), rowsPath);
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
