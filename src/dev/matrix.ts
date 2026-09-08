// src/dev/matrix.ts -- renders `docs/STACK-MATRIX.md` from the profiles pack.
//
// A REPOSITORY SCRIPT, NOT A VERB. `bun run matrix` runs this file; `nen dev`'s
// subcommand list is untouched, the verb table gains no row, and the izanami
// exhaustiveness test -- which keys on registry family names, not on files --
// never sees it. That is deliberate: the matrix is REFERENCE MATERIAL, and a
// committed page is a better target for a consumer than a verb was, because it
// can be read by a plugin on a machine where nen is not installed.
//
// IT LIVES IN `src/dev/` because that directory is already "this repository's
// own dev loop", which is exactly what a repo-local generator is. And it is
// TypeScript rather than a shell script because `bootstrap/nen.sh` is the one
// shell file this repository ships -- the purity sweep fails the build on a
// second one's tell-tale literals for the same reason.
//
// THE RENDERER IS A PURE FUNCTION over the pack (`renderStackMatrix`), called
// by both the entry point below and by `matrix.test.ts`. The drift test renders
// in memory and compares to the committed file byte for byte, so the page can
// be stale for exactly as long as it takes CI to run -- the failure mode its
// ancestor died of (a 688-line hand-maintained table, no generator, no check).
//
// DETERMINISM IS A REQUIREMENT, NOT A COURTESY, because a drift test over a
// non-deterministic render is a test that fails at random and gets deleted. So:
// profiles in the pack index's own (sorted) order, verbs in the index's own
// column order, every other map's keys sorted explicitly, LF endings, and NO
// TIMESTAMP AND NO VERSION STAMP anywhere in the output. The version stamp is
// the notable omission and it is a decision: byte-for-byte drift checking
// already makes "stale" impossible, so stamping the version would buy nothing
// and would turn every release bump into a red build until somebody re-ran a
// generator whose INPUT had not changed.
//
// THE TABLES ARE NOT PADDED, and that is also a decision rather than an
// oversight. ../cli/table.ts pads every column to its widest cell, which is
// right for a four-column board and wrong here: one `why` cell in this document
// runs past 700 characters, and padding would widen every other row in its
// column to match, producing a file that is mostly spaces. The part of that
// module that MATTERS is reused -- `escapeCell`, so a `|` inside a citation
// cannot shift a column and a stray newline cannot end a row mid-table.
//
// NO STACK ID, NO VERB NAME AND NO TOOLCHAIN NAME IS WRITTEN IN THIS FILE. Both
// lists come from `profiles/index.json` through the pack loader. That is what
// keeps ../taxonomy-purity.test.ts's sweep meaningful over this module, and it
// is why adding a stack is a data change with no code change at all.

import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { escapeCell } from "../cli/table.js";
import {
  loadProfilesPack,
  verbCell,
  type ProfilesPack,
  type ProfileVerb,
  type StackProfile,
} from "../profiles/pack.js";

/** Where the generated page is committed, relative to the repository root. */
export const MATRIX_PATH = "docs/STACK-MATRIX.md";

/** The command that regenerates it. Printed in the page's own header. */
export const MATRIX_COMMAND = "bun run matrix";

/** The failure message the drift test prints. Stated once, used twice. */
export const MATRIX_DRIFT_MESSAGE = `${MATRIX_PATH} is out of date -- run \`${MATRIX_COMMAND}\` and commit the result.`;

// ── cells ───────────────────────────────────────────────────────────────────

const YES = "✓";
const NO = "—";

function code(text: string): string {
  return `\`${text}\``;
}

function commandLine(exe: string, argv: readonly string[]): string {
  return [exe, ...argv].join(" ");
}

// Every rendering of a cell's COMMAND, shared by the grid and the per-stack
// tables so the two can never disagree about what a profile says.
function renderCommand(cell: ProfileVerb): string {
  switch (cell.kind) {
    case "command":
      return cell.invocation.kind === "command"
        ? code(commandLine(cell.invocation.exe, cell.invocation.argv))
        : "";
    case "steps":
      return cell.invocation.kind === "steps"
        ? cell.invocation.steps
            .map((step): string => code(commandLine(step.exe, step.argv)))
            .join(" then ")
        : "";
    case "delegated":
      return `delegates to ${cell.delegatesTo.map(code).join(", ")}`;
    case "declared-only":
      return "declared-only";
    case "unsupported":
      return "unsupported";
  }
}

// The summary grid's cell: a glyph, plus the shortest true thing. A `-` cell
// carries the SHORT reason; the full one, with its citation, is in the stack's
// own section. Abbreviating there instead of here is what keeps a 63-cell grid
// readable without any cell being a lie.
function renderGridCell(cell: ProfileVerb): string {
  switch (cell.kind) {
    case "command":
    case "steps":
    case "delegated":
      return `${YES} ${renderCommand(cell)}`;
    case "declared-only":
      return `D declared-only (${cell.summary})`;
    case "unsupported":
      return `${NO} ${cell.summary}`;
  }
}

// The per-stack table's reason column: the cell's own sentence, then its
// citation. A command's reason is its `why`; a refusal's reason is the refusal.
function renderWhy(cell: ProfileVerb): string {
  switch (cell.kind) {
    case "command":
    case "steps":
      return cell.invocation.kind === "unsupported" ? "" : (cell.invocation.why ?? "");
    case "delegated":
      return cell.why;
    case "declared-only":
      return cell.reason;
    case "unsupported":
      return cell.invocation.kind === "unsupported" ? cell.invocation.reason : "";
  }
}

// ── tables ──────────────────────────────────────────────────────────────────

// An UNPADDED markdown pipe table -- see this file's header for why padding is
// wrong for this document. `escapeCell` is ../cli/table.ts's, so the pipe and
// newline discipline is the repository's one implementation of it.
function table(header: readonly string[], rows: readonly (readonly string[])[]): string[] {
  const line = (cells: readonly string[]): string =>
    `| ${cells.map((cell): string => escapeCell(cell)).join(" | ")} |`;
  return [
    line(header),
    `| ${header.map((): string => "---").join(" | ")} |`,
    ...rows.map(line),
  ];
}

// ── the page ────────────────────────────────────────────────────────────────

function heading(profile: StackProfile): string {
  return `## \`${profile.id}\` -- ${profile.displayName}`;
}

function renderProfileSection(pack: ProfilesPack, profile: StackProfile): string[] {
  const hostRows = Object.keys(profile.hosts)
    .sort()
    .map((verb): string[] => [code(verb), (profile.hosts[verb] ?? []).map(code).join(", ")]);

  const verbRows = pack.verbs.map((verb): string[] => {
    const cell = verbCell(profile, verb);
    const reason = renderWhy(cell);
    const source = cell.source;
    return [code(verb), renderCommand(cell), `${reason} *(source: ${source})*`];
  });

  const markerRows = profile.markers.map((marker): string[] => [
    code(marker.pattern),
    marker.contains === null ? "" : code(marker.contains),
    marker.why,
  ]);

  const toolRows = Object.keys(profile.toolchain)
    .sort()
    .map((tool): string[] => {
      const entry = profile.toolchain[tool];
      if (entry === undefined) return [code(tool), "", "", "", "", ""];
      return [
        code(tool),
        entry.minimum === null ? "presence only" : code(entry.minimum),
        code(commandLine(entry.probe[0] ?? "", entry.probe.slice(1))),
        code(entry.versionFrom),
        code(entry.installer),
        `${entry.why} *(source: ${entry.source})*`,
      ];
    });

  const lines: string[] = [
    heading(profile),
    "",
    `**Host:** ${profile.hostNote}`,
    "",
    `**Scaffold template:** ${profile.scaffoldTemplate === null ? "none" : code(profile.scaffoldTemplate)} -- ${profile.scaffoldNote}`,
    "",
    "### Verbs",
    "",
    ...table(["verb", "command", "why / source"], verbRows),
    "",
    "### Host allowlist",
    "",
    ...table(["verb", "platforms"], hostRows),
    "",
    "### Detection markers",
    "",
    ...table(["pattern", "must contain", "why"], markerRows),
    "",
  ];

  if (toolRows.length > 0) {
    lines.push(
      "### Toolchain minimums (advisory)",
      "",
      "What nen has been *tested* against, never what it installs: the pin an install would use is the target repository's own, and this column can never contribute one.",
      "",
      ...table(
        ["tool", "pack minimum", "probe", "version from", "installer", "why / source"],
        toolRows,
      ),
      "",
    );
  }

  if (profile.notes.length > 0) {
    lines.push("### Notes", "");
    for (const note of profile.notes) lines.push(`- ${note}`);
    lines.push("");
  }

  return lines;
}

/**
 * Render the whole page. PURE: the same pack renders the same bytes, always.
 *
 * The return value ends with exactly one newline and contains no `\r`, so the
 * drift test's comparison is a byte comparison and not a normalisation dance.
 */
export function renderStackMatrix(pack: ProfilesPack): string {
  const gridHeader = ["stack", ...pack.verbs.map(code)];
  const gridRows = pack.ids.map((id): string[] => {
    const profile = pack.profiles[id];
    if (profile === undefined) return [code(id)];
    return [code(id), ...pack.verbs.map((verb): string => renderGridCell(verbCell(profile, verb)))];
  });

  let carried = 0;
  let declaredOnly = 0;
  let unsupported = 0;
  for (const id of pack.ids) {
    const profile = pack.profiles[id];
    if (profile === undefined) continue;
    for (const verb of pack.verbs) {
      const cell = verbCell(profile, verb);
      if (cell.kind === "declared-only") declaredOnly += 1;
      else if (cell.kind === "unsupported") unsupported += 1;
      else carried += 1;
    }
  }
  const total = carried + declaredOnly + unsupported;

  const lines: string[] = [
    `<!-- GENERATED FILE -- DO NOT EDIT. Run \`${MATRIX_COMMAND}\` and commit the result. -->`,
    "",
    "# Stack matrix",
    "",
    `**This page is generated.** \`${MATRIX_COMMAND}\` renders it from \`profiles/*.json\`, the bundled profiles pack, and a test in this repository's own suite re-renders it and compares byte for byte -- so it cannot quietly go stale, and a hand edit fails the build. Change the pack, not the page.`,
    "",
    "**What it is.** For each stack the pack knows, the reference command each verb has *in the product repositories the inventory read*, cited to a file and a line. It is a CATALOGUE, not an authority: the only thing nen ever executes is the target repository's own `nen/contract.json`, and this page exists so that whoever writes one has somewhere honest to start. For the question *\"what does THIS checkout support\"*, ask `nen shu detect --repo <path>`; this page answers *\"what does the pack know\"*.",
    "",
    "**Empty cells are first-class.** A verb no repository in the inventory implements is `unsupported` with the reason it is, never a plausible command nobody has run.",
    "",
    "## Legend",
    "",
    `| cell | meaning |`,
    `| --- | --- |`,
    `| ${YES} \`command\` | the pack carries a reference command for this verb |`,
    `| ${YES} delegates to ... | the verb's work is another verb's, named -- only \`warmup\` does this, and only for its verification half |`,
    `| D declared-only (...) | the verb is REAL for this stack and the observed repositories disagree about what it means, so the pack proposes NO default and the declaration must say |`,
    `| ${NO} ... | unsupported, with the short reason. The full reason and its citation are in the stack's own section |`,
    "",
    "## Summary grid",
    "",
    ...table(gridHeader, gridRows),
    "",
    `**Read it honestly.** Of the ${total} stack × verb cells, **${unsupported} are unsupported**, ${declaredOnly} are declared-only, and ${carried} carry an answer. That is what the ecosystem actually looks like today; a full grid would be a grid of aspirations.`,
    "",
    "---",
    "",
  ];

  for (const id of pack.ids) {
    const profile = pack.profiles[id];
    if (profile === undefined) continue;
    lines.push(...renderProfileSection(pack, profile), "---", "");
  }

  // One trailing newline, no more: the file is compared byte for byte.
  return `${lines.join("\n").replace(/\n+$/, "")}\n`;
}

if (import.meta.main) {
  const pack = loadProfilesPack();
  const path = join(process.cwd(), MATRIX_PATH);
  writeFileSync(path, renderStackMatrix(pack), "utf8");
  process.stdout.write(`wrote ${MATRIX_PATH} (${pack.ids.length} stacks, ${pack.verbs.length} verbs)\n`);
}
