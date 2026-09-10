// src/report/command.ts -- `nen report data` and `nen report render`: the two
// halves of a rich effort report, split at the line every other pair in this
// repository is split at.
//
// WHY TWO VERBS AND NOT ONE. A verb that gathered the facts AND filled a
// template would be a verb whose output you cannot inspect, cannot diff and
// cannot re-render from -- the data would exist only inside the rendering that
// consumed it. Splitting them means `data` is a document a caller can read,
// store beside the report, or feed to a template nen never saw; and `render` is
// a pure fill that takes any JSON, so a caller who assembles their own facts is
// not locked out of the templating. It is the same shape `nen board build` /
// `nen board render` already has, for the same reason.
//
// NEITHER VERB DECIDES ANYTHING. `data` reports what is on the branch and what
// artifacts are on disk; `render` fills a template with it. No coverage bar is
// applied, no readiness is computed, nothing is published. The exit codes say
// only whether the reading and the filling worked.

import { emit, requireRepoFlag, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { readJsonFile } from "../cli/inputs.js";
import { assertRepoRoot } from "../repo/root.js";
import { openDeclaration } from "../shu/declaration.js";
import { assembleData, parseTiers, renderData, type TierTable } from "./data.js";
import { renderReport } from "./render.js";

const USAGE = `nen report -- the facts an effort's report is made of, and the fill that turns them into one.

usage:
  nen report data --repo <path> --base <ref> [--lane <name>] [--tiers <file>] [--json]
  nen report render --template <file> --data <file> --out <file> [--dry-run] [--repo <path>] [--json]

data      One document describing this branch against --base: the commits, the
          changed files (with a tier from --tiers, or null), the evidence rows
          (empty in this release -- 'nen shu evidence' owns them), the lane's
          coverage report if one is on disk, the build proof, and the last
          recorded stop. READ-ONLY: it runs git and opens files, and writes
          nothing, ever.

  --base <ref>     Required. What this branch is measured against -- the trunk,
                   or the commit the effort was cut from. Commits are
                   '<base>..HEAD'; files are '<base>...HEAD' (three dots, the
                   merge-base diff a pull request shows). A ref that does not
                   resolve is refused by name at exit 2.
  --lane <name>    Which declared lane's coverage report and build proof to
                   read. Defaults to the declaration's own 'defaultLane'; with
                   neither, both fields are null.
  --tiers <file>   A JSON object mapping a tier name to its paths:
                   { "<tier>": ["<path prefix or glob>", ...] }. The file's key
                   order is the precedence -- the first tier whose patterns
                   match a path wins. Without it every file's tier is null.

render    Fills a template with a data document and writes the result. The whole
          template language is '{{token}}' (HTML-escaped), '{{{token}}}' (raw),
          '{{#each <list>}}...{{/each}}' (nested; '{{.}}' is a scalar item and
          '{{@index}}' its position) and '{{#if <key>}}...{{/if}}'. There are no
          helpers, no partials and no expressions. A token the data document has
          not got is refused at exit 2 NAMING IT -- a blank cell in a published
          report reads as a fact.

  --template <file>  The template to fill. Read raw: its own line endings survive.
  --data <file>      The JSON document every token is answered from.
  --out <file>       Where to write. Must resolve INSIDE --repo (symlinks
                     resolved); anywhere else is refused at exit 2.
  --dry-run          Print every token the template names and write nothing.

Exit codes: 0 both verbs on success; 1 a git command that failed for a reason
other than the flags (no repository, an unreadable object); 2 a missing or
unresolvable flag, a template this language does not have, or a token the data
has not got.`;

/** Per-subcommand flags, so a flag meant for the other verb is refused, not ignored. */
const SUBCOMMAND_FLAGS: Readonly<Record<string, { values: readonly string[]; booleans: readonly string[] }>> = {
  data: { values: ["base", "lane", "tiers"], booleans: [] },
  render: { values: ["template", "data", "out"], booleans: ["dry-run"] },
};

const SUBCOMMANDS: readonly string[] = ["data", "render"];

const FAMILY_VALUES = [
  ...new Set(Object.values(SUBCOMMAND_FLAGS).flatMap((spec): readonly string[] => spec.values)),
].sort();
const FAMILY_BOOLEANS = [
  ...new Set(Object.values(SUBCOMMAND_FLAGS).flatMap((spec): readonly string[] => spec.booleans)),
].sort();

/**
 * A flag the FAMILY accepts and this subcommand does not read.
 *
 * Refused rather than ignored, on ../shu/command.ts's own argument: the ignored
 * thing is the instruction you gave. `nen report data --out x.html` looks like
 * it was told where to write, and this verb never writes anywhere.
 */
function refuseForeignFlags(subcommand: string, context: CommandContext): void {
  const spec = SUBCOMMAND_FLAGS[subcommand];
  /* c8 ignore next -- requireSubcommand already refused an unknown name */
  if (spec === undefined) return;
  const known = new Set([...FAMILY_VALUES, ...FAMILY_BOOLEANS]);
  const mine = new Set([...spec.values, ...spec.booleans]);
  const foreign = [...Object.keys(context.args.values), ...context.args.booleans].filter(
    (flag): boolean => known.has(flag) && !mine.has(flag),
  );
  if (foreign.length === 0) return;
  throw new VerbUsageError(
    `--${[...new Set(foreign)].sort().join(", --")} ${foreign.length === 1 ? "is" : "are"} not read by 'report ${subcommand}'. A flag accepted and ignored is worse than one refused: the ignored thing is the instruction you gave.`,
  );
}

/** A required `--flag <value>` for this family, refused by name when absent. */
function required(context: CommandContext, flag: string, why: string): string {
  const value = context.args.values[flag];
  if (value === undefined || value.trim() === "") {
    throw new VerbUsageError(`--${flag} is required. ${why}`);
  }
  return value;
}

/**
 * The lane whose coverage report and build proof are read.
 *
 * AN EXPLICIT `--lane` IS NEVER CROSS-CHECKED AGAINST THE DECLARATION HERE, and
 * a repository with no declaration at all is not a refusal: `report data` is
 * useful on a checkout that has never declared anything (the commits and the
 * files are pure git), and the two fields a lane feeds are already `null` when
 * there is nothing to read. `nen shu coverage` is the verb that refuses an
 * unknown lane by name, with the lane list.
 */
function resolveLane(context: CommandContext, root: string): string | null {
  const flag = context.args.values["lane"];
  if (flag !== undefined && flag.trim() !== "") return flag;
  if (flag !== undefined) {
    throw new VerbUsageError(
      `--lane was given an empty value. Omit it entirely to use the declaration's own 'defaultLane'.`,
    );
  }
  try {
    return openDeclaration(root).project.defaultLane;
  } catch {
    // No declaration, or one with no project block. Both mean "this repository
    // has not told nen about any lanes", which is an absence rather than a
    // failure for a report verb: coverage and proof are null and the document
    // is otherwise complete.
    return null;
  }
}

function readTiers(context: CommandContext, root: string): TierTable | null {
  const flag = context.args.values["tiers"];
  if (flag === undefined) return null;
  if (flag.trim() === "") {
    throw new VerbUsageError(
      `--tiers was given an empty value. Omit it entirely to leave every file's tier null.`,
    );
  }
  return parseTiers(
    readJsonFile<unknown>(
      flag,
      root,
      "The tier table is what every changed file's 'tier' is answered from; there is no empty default for it.",
    ),
    flag,
  );
}

function runData(context: CommandContext): number {
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It names the working tree this report describes."),
  });
  const document = assembleData(
    context.seams,
    root,
    {
      base: required(
        context,
        "base",
        "It names the ref this branch is measured against -- the trunk, or the commit the effort was cut from.",
      ),
      tiers: readTiers(context, root),
      lane: resolveLane(context, root),
    },
    (line): void => context.io.err(line),
  );
  emit(context.io, context.json, document, renderData(document));
  return 0;
}

function runRender(context: CommandContext): number {
  // `--repo` is BRACKETED on this verb's usage line, so the cwd default is the
  // right meaning: `--out` is checked against whatever tree the caller is
  // standing in, which is the tree the report belongs to.
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const result = renderReport(root, {
    template: required(context, "template", "It names the file whose tokens are filled."),
    data: required(context, "data", "It names the JSON document every token is answered from."),
    out: required(context, "out", "It names where the filled report is written, inside --repo."),
    dryRun: context.args.booleans.has("dry-run"),
  });
  emit(context.io, context.json, result.report, result.lines);
  return 0;
}

export const reportCommand: Command = {
  name: "report",
  summary: "Assemble an effort's report data, and fill a template with it.",
  usage: USAGE,
  flags: { values: FAMILY_VALUES, booleans: FAMILY_BOOLEANS },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("report", context.args, SUBCOMMANDS);
    refuseForeignFlags(subcommand, context);
    return subcommand === "data" ? runData(context) : runRender(context);
  },
};
