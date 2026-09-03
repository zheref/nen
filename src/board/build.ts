// src/board/build.ts -- assembling the gate board's rows.
//
// PORTED, AT REDUCED FIDELITY, FROM bankai-core's `scripts/ichigo_board.sh`
// (1365 lines; bankai-core#653's Kurapika gate board). This module carries the
// board's DATA SHAPE and assembly discipline -- one row per effort, a stated
// colour and gate, nothing invented -- rather than that script's full section
// layout (per-repo headers, warm-up/staleness annotations inline in the
// board, the colour-precedence application it repeats per row). See
// ../board/command.ts's own header for the fidelity gap this is disclosing
// and why the remainder was out of reach at this scope.
//
// A ROW NAMES ITS OWN GATE AND COLOUR RATHER THAN DERIVING THEM: this module
// composes what ../gate/derive.ts and ../color/status.ts already computed
// (backlog-state §4's decision tree, backlog-state §6's colour precedence),
// exactly the way ../release/preflight.ts composes CON-33(c)'s completeness
// check rather than re-deriving it. A board that re-derived either inline
// would be a second, divergent implementation of a rule this repository
// already has one implementation of.

// THIS SHAPE IS ENFORCED AT THE JSON BOUNDARY, in ./command.ts's
// validateBoardRows (#32) -- not here. This module composes rows a TypeScript
// caller already typed; the boundary is where a `--rows-from` document, cast
// rather than checked, once let a string `refs` reach ./render.ts's
// `row.refs.join` as a raw TypeError instead of a refusal that names the row,
// the field and the expected shape. A second check here would be the same
// divergence risk this file's header refuses for gates and colours.
export interface BoardRow {
  /** The subject: an issue number, a PR-only effort's PR number, or a caller-chosen id. */
  readonly id: string;
  readonly title: string;
  /** Object-notation refs (../ref/notation.ts), ONE STRING PER REFERENCE, e.g. ["XX-IS-#12", "XX-PR-#34"] -- never a single pre-joined string. */
  readonly refs: readonly string[];
  /** null when this row carries no gate (in progress, owned by its author). */
  readonly gate: string | null;
  /** The rendered colour token, e.g. "🟡 blocked" -- from ../color/status.ts's resolution. */
  readonly status: string;
  /** One line: what this row needs next, or null when nothing is owed. */
  readonly needs: string | null;
}

export interface Board {
  readonly repo: string;
  /** ISO-8601. Always the caller's Seams.now(), never the live clock. */
  readonly generatedAt: string;
  readonly rows: readonly BoardRow[];
}

export function buildBoard(repo: string, generatedAt: string, rows: readonly BoardRow[]): Board {
  return { repo, generatedAt, rows };
}
