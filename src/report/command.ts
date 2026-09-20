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

import {
  emit,
  requireRepoFlag,
  requireSubcommand,
  splitIntegerList,
  VerbUsageError,
  type Command,
  type CommandContext,
} from "../cli/command.js";
import { commaList } from "../cli/comma.js";
import { readJsonFile } from "../cli/inputs.js";
import { parseTarget, TargetError, type Target } from "../github/target.js";
import { assertRepoRoot } from "../repo/root.js";
import { loadWorkflow, type ReportSection } from "../schema/workflow.js";
import { openDeclaration } from "../shu/declaration.js";
import { assembleData, parseTiers, renderData, type TierTable } from "./data.js";
import { assembleObjects, renderObjects } from "./objects.js";
import { graphInjection, graphToMermaid, parseGraph, type GraphDocument } from "./graph.js";
import { renderReport } from "./render.js";

const USAGE = `nen report -- the facts an effort's report is made of, and the fill that turns them into one.

usage:
  nen report data --repo <path> --base <ref> [--lane <name>] [--tiers <file>] [--target <owner/name>] [--prs <n,...>] [--issues <n,...>] [--backlog] [--objects-from <file>] [--json]
  nen report render --template <file> --data <file> --out <file> [--variant <name>] [--graph <file>] [--dry-run] [--repo <path>] [--json]
  nen report mermaid --graph <file>

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

  The 'objects' REGISTER -- the issues and pull requests this effort is about
  -- is [] unless one of the five flags below is given, which keeps this
  verb's default local, network-free shape exactly what it always was.

  --target <o/n>   The GitHub side. --repo names a checkout on disk and is
                   never used to address the API. The reads here go through
                   'gh', which uses its own stored credential -- but a
                   readiness of source 'computed' is nen's in-process gate,
                   which reads GitHub over its OWN transport and needs
                   GH_TOKEN (or --token-env's variable) in the environment.
                   Without it the gh reads still answer and readiness is null
                   with the reason on stderr.
  --prs <n,...>    Pull requests to read, by number.
  --issues <n,...> Issues to read, by number.
  --backlog        Every OPEN issue and pull request of --target.
  --objects-from <file>
                   A JSON array of rows already in the published 'objects'
                   shape -- the offline path. VALIDATED at the read seam and
                   refused BY ROW INDEX at exit 2; it is never mixed with the
                   live flags.

  A pull request's 'readiness' says which authority answered it: 'check' when
  the head carries a check run named 'readiness' (its output's verdict line is
  read), 'computed' when nen's own in-process CON-32 gate decided it, and null
  -- with the reason on stderr -- when neither could be read.

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
  --variant <name>   A variant declared under 'reports.sections' in --repo's
                     nen/workflow.json. Injects 'sections' (a presence flag per
                     declared block, so a template writes
                     '{{#if sections.desk}}...{{/if}}') and 'sectionList' (the
                     block names, in the file's own order) into the data
                     document before the fill, and NOTHING else. An undeclared
                     variant is refused at exit 2 naming the declared ones; a
                     --data document whose own 'variant' key disagrees is
                     refused too. Without the flag nothing is injected.
  --graph <file>     A '{ contract: "nen.report.graph/v0.1", caption, nodes[],
                     edges[] }' document. Validated (every edge endpoint must
                     name a declared node) and injected as 'graphJson' (the
                     re-serialised document, for a raw
                     '<script type="application/json">' block), 'graphMermaid',
                     'graphNodes' and 'graphEdges'. All four are injected
                     together, always.

mermaid   Prints the mermaid text for a --graph document and nothing else: no
          file is read beyond it, nothing is written, and no template is
          involved. Deterministic and in document order, so two runs over an
          unchanged document are byte-identical.

Exit codes: 0 both verbs on success; 1 a git command that failed for a reason
other than the flags (no repository, an unreadable object); 2 a missing or
unresolvable flag, a template this language does not have, or a token the data
has not got.`;

/** Per-subcommand flags, so a flag meant for the other verb is refused, not ignored. */
const SUBCOMMAND_FLAGS: Readonly<Record<string, { values: readonly string[]; booleans: readonly string[] }>> = {
  data: {
    values: ["base", "lane", "tiers", "target", "prs", "issues", "objects-from"],
    booleans: ["backlog"],
  },
  render: { values: ["template", "data", "out", "variant", "graph"], booleans: ["dry-run"] },
  mermaid: { values: ["graph"], booleans: [] },
};

const SUBCOMMANDS: readonly string[] = ["data", "render", "mermaid"];

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

/**
 * The five `objects` flags, resolved into one options bag, or null when the
 * caller gave none.
 *
 * `--objects-from` IS EXCLUSIVE, AND THE REFUSAL IS THE POINT. The offline path
 * and the live path answer the same question from two different authorities,
 * and a run that mixed them would publish one register whose rows came from a
 * file and whose other rows came from GitHub -- with nothing in the document
 * saying which was which. One source per run.
 */
function readObjectOptions(
  context: CommandContext,
  root: string,
): { readonly target: Target | null; readonly prs: readonly number[]; readonly issues: readonly number[]; readonly backlog: boolean; readonly from: { document: unknown; display: string } | null; readonly repoRoot: string } | null {
  const from = context.args.values["objects-from"];
  const targetRaw = context.args.values["target"];
  const prsRaw = context.args.values["prs"];
  const issuesRaw = context.args.values["issues"];
  const backlog = context.args.booleans.has("backlog");
  const live = targetRaw !== undefined || prsRaw !== undefined || issuesRaw !== undefined || backlog;

  if (from !== undefined) {
    if (from.trim() === "") {
      throw new VerbUsageError("--objects-from was given an empty value. Omit it entirely to leave 'objects' empty.");
    }
    if (live) {
      throw new VerbUsageError(
        "--objects-from reads the register from a file and --target/--prs/--issues/--backlog read it from GitHub. Give one or the other: a register whose rows came from two authorities says nothing about which row came from which.",
      );
    }
    return {
      target: null,
      prs: [],
      issues: [],
      backlog: false,
      from: {
        document: readJsonFile<unknown>(
          from,
          root,
          "The object rows are what the report's register is made of; there is no empty default for a file the caller named.",
        ),
        display: from,
      },
      repoRoot: root,
    };
  }
  if (!live) return null;
  if (targetRaw === undefined || targetRaw.trim() === "") {
    throw new VerbUsageError(
      "--target owner/name is required to read objects from GitHub. --prs, --issues and --backlog name WHAT to read; --target names WHERE, and --repo is a checkout on disk that never addresses the API.",
    );
  }
  let target: Target;
  try {
    target = parseTarget(targetRaw);
  } catch (error) {
    if (error instanceof TargetError) throw new VerbUsageError(error.message);
    /* c8 ignore next -- parseTarget throws nothing else */
    throw error;
  }
  return {
    target,
    prs: prsRaw === undefined ? [] : splitIntegerList(commaList(prsRaw), "prs"),
    issues: issuesRaw === undefined ? [] : splitIntegerList(commaList(issuesRaw), "issues"),
    backlog,
    from: null,
    repoRoot: root,
  };
}

async function runData(context: CommandContext): Promise<number> {
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
  const objectOptions = readObjectOptions(context, root);
  // `objects` IS APPENDED AT THE END OF THE KEY ORDER, deliberately and once:
  // every consumer reading the twelve v0.11 keys reads the same twelve here,
  // and the thirteenth is new information rather than a reshuffle
  // (./data.test.ts's key-order test pins both halves).
  const objects =
    objectOptions === null
      ? []
      : await assembleObjects(context.seams, objectOptions, (line): void => context.io.err(line));
  const full = { ...document, objects };
  emit(context.io, context.json, full, [...renderData(document), ...renderObjects(objects)]);
  return 0;
}

/**
 * `--variant <name>`, resolved against `--repo`'s own policy.
 *
 * REFUSED BY NAME, WITH THE DECLARED LIST. A variant nen does not find is
 * either a typo or a variant somebody has not written yet, and both are fixed
 * in one edit by a caller who can see what IS declared -- which is the same
 * shape every refusal in this family takes.
 */
function resolveVariant(
  context: CommandContext,
  root: string,
): { readonly name: string; readonly section: ReportSection; readonly declared: Readonly<Record<string, ReportSection>> } | null {
  const name = context.args.values["variant"];
  if (name === undefined) return null;
  if (name.trim() === "") {
    throw new VerbUsageError("--variant was given an empty value. Omit it entirely to inject nothing, which is this verb's v0.11 behaviour byte for byte.");
  }
  const loaded = loadWorkflow(root);
  const declared = loaded.workflow.reports.sections;
  const section = declared[name];
  if (section === undefined) {
    const names = Object.keys(declared);
    throw new VerbUsageError(
      `--variant '${name}' is not declared by ${loaded.path}. ${
        names.length === 0
          ? "That file declares no 'reports.sections' at all, so there is no variant to render: a report's blocks are the repository's configuration, and nen renders none it was not told about."
          : `Declared: ${names.join(", ")}.`
      }`,
    );
  }
  return { name, section, declared };
}

/**
 * The two keys a variant injects.
 *
 * `sections` CARRIES A FLAG FOR EVERY BLOCK THE FILE DECLARES ANYWHERE -- `true`
 * for the ones THIS variant carries, `false` for the rest -- and that width is
 * the whole point rather than generosity. One template serves several variants
 * (hatsu's `rikugan.html` is `turn`, `turn-fast` and `landing`), so it names
 * every block any of them can show; and ./template.ts refuses an UNKNOWN token
 * by name, which is exactly right for a typo and exactly wrong for
 * `{{#if sections.landed}}` under a variant that legitimately does not show
 * `landed`. A map of only this variant's blocks would make the two
 * indistinguishable and refuse the render. A block no variant declares is still
 * an unknown token, so the typo is still caught.
 *
 * `sectionList` IS THIS VARIANT'S OWN BLOCKS, in the file's order -- the list,
 * not the map, is what a template iterates when it wants to say what it showed.
 */
function sectionInjection(
  section: ReportSection,
  declared: Readonly<Record<string, ReportSection>>,
): Readonly<Record<string, unknown>> {
  const mine = new Set(section.blocks);
  const sections: Record<string, boolean> = {};
  for (const variant of Object.values(declared)) {
    for (const block of variant.blocks) sections[block] = mine.has(block);
  }
  return { sections, sectionList: [...section.blocks] };
}

/** `--graph <file>`, read and validated, or null. */
function readGraph(context: CommandContext, root: string): GraphDocument | null {
  const flag = context.args.values["graph"];
  if (flag === undefined) return null;
  if (flag.trim() === "") {
    throw new VerbUsageError("--graph was given an empty value. Omit it entirely to render a report with no architecture delta.");
  }
  return parseGraph(
    readJsonFile<unknown>(
      flag,
      root,
      "The graph document is what the delta diagram is drawn from; there is no empty default for a file the caller named.",
    ),
    flag,
  );
}

function runMermaid(context: CommandContext): number {
  // `--json` IS REFUSED BY NAME, NOT IGNORED (Nobunaga N8). This verb's whole
  // output is the mermaid text, so there is no document to emit -- and this
  // family's own rule, two screens up, is that a flag accepted and ignored is
  // worse than one refused: the ignored thing is the instruction you gave. A
  // caller who typed it was expecting a document and would otherwise have got
  // text that looks like success.
  if (context.json) {
    throw new VerbUsageError(
      "--json is not read by 'report mermaid'. The mermaid text IS this verb's output -- there is no document to wrap it in, and wrapping it would make every caller unwrap it before pasting it where it was printed for. Drop the flag; redirect stdout if you want the text in a file.",
    );
  }
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const graph = readGraph(context, root);
  if (graph === null) {
    throw new VerbUsageError("--graph <file> is required. It names the nodes and edges this mermaid is printed from; there is nothing to draw without it.");
  }
  // NO `--json` DOCUMENT, AND THAT IS THE VERB. The mermaid text IS the output,
  // so wrapping it in an object would make every caller unwrap it before
  // pasting it into the page or the pull-request body it was printed for.
  for (const line of graphToMermaid(graph).split("\n")) context.io.out(line);
  return 0;
}

function runRender(context: CommandContext): number {
  // `--repo` is BRACKETED on this verb's usage line, so the cwd default is the
  // right meaning: `--out` is checked against whatever tree the caller is
  // standing in, which is the tree the report belongs to.
  const root = assertRepoRoot({ repoFlag: context.repoFlag });
  const variant = resolveVariant(context, root);
  const graph = readGraph(context, root);
  const result = renderReport(root, {
    template: required(context, "template", "It names the file whose tokens are filled."),
    data: required(context, "data", "It names the JSON document every token is answered from."),
    out: required(context, "out", "It names where the filled report is written, inside --repo."),
    dryRun: context.args.booleans.has("dry-run"),
    variant: variant === null ? null : variant.name,
    inject: {
      ...(variant === null ? {} : sectionInjection(variant.section, variant.declared)),
      ...(graph === null ? {} : graphInjection(graph)),
    },
  });
  emit(context.io, context.json, result.report, result.lines);
  return 0;
}

export const reportCommand: Command = {
  name: "report",
  subcommands: SUBCOMMANDS,
  summary: "Assemble an effort's report data, and fill a template with it.",
  usage: USAGE,
  flags: { values: FAMILY_VALUES, booleans: FAMILY_BOOLEANS },
  run(context: CommandContext): number | Promise<number> {
    const subcommand = requireSubcommand("report", context.args, SUBCOMMANDS);
    refuseForeignFlags(subcommand, context);
    if (subcommand === "data") return runData(context);
    if (subcommand === "mermaid") return runMermaid(context);
    return runRender(context);
  },
};
