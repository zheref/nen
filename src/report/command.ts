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

import { basename } from "node:path";
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
import { assembleContext, deriveClock, type PrLookup, type ReportContext } from "./context.js";
import { assembleObjects, renderObjects } from "./objects.js";
import { assembleRegister, parseDesk, renderRegister, type NotationSource } from "./register.js";
import { openTaxonomy } from "../schema/taxonomy.js";
import { codeFor as productCodeFor, recordedRepoFor } from "../repo/resolve.js";
import { graphInjection, graphToMermaid, parseGraph, type GraphDocument } from "./graph.js";
import { renderReport } from "./render.js";

const USAGE = `nen report -- the facts an effort's report is made of, and the fill that turns them into one.

usage:
  nen report data --repo <path> --base <ref> [--lane <name>] [--tiers <file>] [--target <owner/name>] [--prs <n,...>] [--issues <n,...>] [--backlog] [--objects-from <file>] [--register <desk>] [--tz <zone>] [--open-stop] [--json]
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

  --tz <zone>      The IANA zone the local clock is read in, printed as ICU's
                   canonical name. It must be a COMPILED zone in this host's
                   zoneinfo database ($TZDIR, else /usr/share/zoneinfo,
                   /var/db/timezone/zoneinfo, /usr/lib/zoneinfo): a regular
                   file whose first four bytes are 'TZif'. Where no such
                   directory exists (win32), the runtime's ICU zone list
                   answers instead, and stderr says so. A misspelling, a case
                   mismatch, 'zone.tab' or a path is refused at exit 2 before
                   any GitHub read. Without it: $TZ, then the /etc/localtime
                   symlink's target, then /etc/timezone, then ICU's guess.
  --open-stop      A G5 stop is open this turn: effortStage is 'blocked'. The
                   only way to 'blocked' -- a .nen/last-stop.json on disk is a
                   record, not an open stop.

  THE DERIVED CONTEXT (zheref/nen#258) follows 'objects': worktree (the
  checkout's directory name when --git-dir and --git-common-dir differ, else
  'core'), effortStage / gate / stageClass, turnNumber (the 'report' entries
  of the ledger whose effort id is this branch's name), and generatedAtLocal
  / generatedDateLocal / timeZone. The stage: blocked 'G5 — yours' red
  (--open-stop); landed 'none — landed' ok (the matched PR merged); ready
  '<G2|G4> — yours' red and in review '<G2|G4> — pending' warn (the matched
  PR open, its readiness verdict 'ready' or not); authoring 'none — local'
  info (not on origin, no PR row in scope). The matched PR is the one
  'objects' row whose head is HEAD or refs/remotes/origin/<branch>; G2/G4 is
  the repository's role in --repo's nen/repos.json. A branch ON origin with
  no matched PR, a PR row matching neither head, an unread readiness, a
  closed PR or a detached HEAD is null -- so 'published' ("on origin, no PR")
  is not derived by any lookup this verb makes, none of which is exhaustive.
  'repo' is owner/name from a hosted origin (user@host: or scheme://host/),
  spelled as the registry records it when listed; a local-path or file://
  origin is null. EACH IS null, WITH THE REASON ON STDERR, WHEN IT CANNOT BE
  DERIVED; none is guessed. Under --register the register's own 'gate' and
  'generatedAtLocal' (the desk's, else generatedAt) keep their places and the
  other six follow the register keys; when the desk sets generatedAtLocal,
  timeZone and generatedDateLocal are null.

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

  --register <desk>
                   Emit the REGISTER document -- the backlog register shape
                   that 'report render --variant register|final' fills a
                   register page from. <desk> is the judgement half only --
                   { variant, title, scope, gate, gates[{ gate, label, cleared,
                   asks[{ kind, rank, title, why, pr?, options[], objects[] }] }],
                   rows?{ "pr#<n>"|"issue#<n>": { marks, gate, gateClass,
                   needs, session, lane, thought } }, legendRows?, efforts?,
                   spendNotes?, generatedAtLocal?, footerNote?,
                   architectureCaption? }. Every FACT is nen's: each row gains
                   notation (nen ref's <CODE>-<IS|PR>-#<N> from nen/repos.json,
                   else <owner>/<name>#<n> named in footerNote), verdict,
                   labelsLine, checksLine, threadsLine, linkedLine and head;
                   the five tallies, footerCount, spendEfforts (from phases[]
                   and usage[]) and empty graph keys are added after
                   'objects'. A VERDICT IS QUOTED, NEVER WRITTEN: every row's
                   and every ask's 'verdict' is the row's readiness.reason
                   verbatim ("" when no authority answered, with the reason
                   in the row's notes), and a desk that carries a 'verdict' --
                   or any key it does not read -- at any level is refused at
                   exit 2. On the live path that reason is the 'nen pr ready'
                   gate line or the head's readiness check run's verdict
                   line; under --objects-from it is whatever the caller's
                   file carried, and footerNote and each such row's notes say
                   'read from <file>, not from GitHub'. Rows and an ask's 'pr'
                   name objects as notation, <owner>/<name>#<n>, or bare
                   (pr#<n>, <n>) only when exactly one object in scope
                   answers; an ambiguous one is refused naming the
                   candidates. Every ask stars exactly one option.

  On the LIVE path a pull request's 'readiness' says which authority answered
  it: 'check' when the head carries a check run named 'readiness' (its
  output's verdict line is read), 'computed' when nen's own in-process CON-32
  gate decided it, and null -- with the reason on stderr and in the row's
  notes -- when neither could be read. Under --objects-from, 'readiness' is
  the caller's file's, validated for shape and never re-derived.

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
    values: ["base", "lane", "tiers", "target", "prs", "issues", "objects-from", "register", "tz"],
    booleans: ["backlog", "open-stop"],
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
/**
 * `--prs`/`--issues`, as POSITIVE whole numbers.
 *
 * `splitIntegerList` ADMITS ZERO, and zero is not an object (Copilot, #221):
 * GitHub numbers issues and pull requests from 1, the offline read seam already
 * refuses a row whose `number` is not positive, and `--prs 0` was reaching the
 * API to ask about a thing that cannot exist. Refused at the boundary, at exit
 * 2, before any call -- the same place and the same code every other malformed
 * flag in this family is refused at.
 */
function positiveNumbers(entries: readonly string[], flag: string): readonly number[] {
  const numbers = splitIntegerList(entries, flag);
  const zeroes = numbers.filter((number): boolean => number <= 0);
  if (zeroes.length > 0) {
    throw new VerbUsageError(
      `--${flag} names ${zeroes.length === 1 ? "the number 0, which is not" : "numbers that are not"} an object: GitHub numbers issues and pull requests from 1. Nothing was read.`,
    );
  }
  return numbers;
}

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
    prs: prsRaw === undefined ? [] : positiveNumbers(commaList(prsRaw), "prs"),
    issues: issuesRaw === undefined ? [] : positiveNumbers(commaList(issuesRaw), "issues"),
    backlog,
    from: null,
    repoRoot: root,
  };
}

/** `--tz`, or null for the host's zone; an empty value is refused like every other flag here. */
function readTz(context: CommandContext): string | null {
  const flag = context.args.values["tz"];
  if (flag === undefined) return null;
  if (flag.trim() === "") {
    throw new VerbUsageError("--tz was given an empty value. Omit it entirely to read the clock in the host's own zone.");
  }
  return flag.trim();
}

/** How the `objects` flags looked for pull requests -- the stage's evidence. */
function prLookupOf(options: { readonly prs: readonly number[]; readonly backlog: boolean; readonly from: unknown } | null): PrLookup {
  if (options === null) return "none";
  if (options.from !== null) return "file";
  if (options.prs.length > 0) return "prs";
  return options.backlog ? "backlog" : "issues-only";
}

/**
 * The context keys a register document carries AFTER its own: every one but
 * `gate` and `generatedAtLocal`, which the register already has (the desk's
 * page gate; the desk's local stamp, else `generatedAt`, exactly as before) in the places
 * NN-PR-#365 gave them. Re-spreading them would overwrite the desk's word with
 * the effort's, in a page about more than one effort.
 */
function registerTail(derived: ReportContext): Omit<ReportContext, "gate" | "generatedAtLocal"> {
  return {
    worktree: derived.worktree,
    effortStage: derived.effortStage,
    stageClass: derived.stageClass,
    turnNumber: derived.turnNumber,
    generatedDateLocal: derived.generatedDateLocal,
    timeZone: derived.timeZone,
  };
}

async function runData(context: CommandContext): Promise<number> {
  const root = assertRepoRoot({
    repoFlag: requireRepoFlag(context, "It names the working tree this report describes."),
  });
  const warn = (line: string): void => context.io.err(line);
  const tz = readTz(context);
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
    warn,
  );
  // THE CLOCK BEFORE THE NETWORK: a refused --tz costs no GitHub read. Read off
  // `generatedAt` itself, so the two stamps are one instant by construction.
  const clock = deriveClock(context.seams, tz, new Date(document.generatedAt), warn);
  const objectOptions = readObjectOptions(context, root);
  // `objects` IS APPENDED AT THE END OF THE KEY ORDER, deliberately and once:
  // every consumer reading the twelve v0.11 keys reads the same twelve here,
  // and the thirteenth is new information rather than a reshuffle
  // (./data.test.ts's key-order test pins both halves).
  const objects =
    objectOptions === null
      ? []
      : await assembleObjects(context.seams, objectOptions, warn);
  // THE CONTEXT KEYS (zheref/nen#258) come AFTER `objects` -- new information
  // after everything a v0.13 consumer already reads, on both paths.
  const derived = assembleContext(
    context.seams,
    {
      root,
      repo: document.repo,
      branch: document.branch,
      phases: document.phases,
      objects,
      prLookup: prLookupOf(objectOptions),
      openStop: context.args.booleans.has("open-stop"),
    },
    clock,
    warn,
  );
  const deskFlag = context.args.values["register"];
  if (deskFlag === undefined) {
    const full = { ...document, objects, ...derived };
    emit(context.io, context.json, full, [...renderData(document), ...renderObjects(objects)]);
    return 0;
  }
  if (deskFlag.trim() === "") {
    throw new VerbUsageError("--register was given an empty value. Omit it entirely to emit the report data without the register keys.");
  }
  const desk = parseDesk(
    readJsonFile<unknown>(
      deskFlag,
      root,
      "The desk is the judgement half of the register -- the title, the asks, what each row needs; there is no empty default for a file the caller named.",
    ),
    deskFlag,
  );
  const register = assembleRegister(desk, {
    generatedAt: document.generatedAt,
    objects,
    phases: document.phases,
    usage: document.usage,
    target: objectOptions?.target?.slug ?? null,
    codes: notationSource(root, warn),
    // THE FILE'S NAME, NEVER ITS PATH: footerNote is pasted into pull requests.
    verdictFile: objectOptions?.from === null || objectOptions?.from === undefined ? null : basename(objectOptions.from.display),
  });
  // `objects` STAYS WHERE IT WAS -- after `usage` -- and the register keys
  // follow it, so a consumer of the v0.13 document reads the same keys in the
  // same order and the register is new information after them; the derived
  // context follows the register.
  // A DESK THAT SETS THE CLOCK OWNS IT (N6): its `generatedAtLocal` is the
  // page's, so a derived zone and date beside it would describe a clock the
  // page does not show.
  const tail = registerTail(derived);
  if (desk.generatedAtLocal !== null && (tail.timeZone !== null || tail.generatedDateLocal !== null)) {
    warn("timeZone: the register desk set generatedAtLocal, so the desk owns the page's clock; generatedDateLocal and timeZone reported as null.");
  }
  const full = {
    ...document,
    ...register,
    ...(desk.generatedAtLocal === null ? tail : { ...tail, generatedDateLocal: null, timeZone: null }),
  };
  emit(context.io, context.json, full, [...renderData(document), ...renderObjects(objects), ...renderRegister(register)]);
  return 0;
}

/**
 * `owner/name` -> product code, from --repo's nen/repos.json.
 *
 * NO REGISTRY IS NOT A REFUSAL HERE. The page still renders, every row reads
 * `<owner>/<name>#<n>`, and footerNote names the failed resolution
 * (Hatsu PROCESS.md § Publishing a report) -- which is the rule for a display
 * field, where `nen ref format` refusing is the rule for a token typed by hand.
 */
function notationSource(root: string, warn: (line: string) => void): NotationSource {
  try {
    const registry = openTaxonomy({ repoFlag: root }).repos();
    // A PRODUCT-CODE VALUE IS CANONICALISED TO THE REPOSITORY THE FILE
    // RECORDS (Copilot, NN-PR-#365), through src/repo/resolve.ts's own rule
    // rather than a second reading of it: `KP: "KroApple"` beside a consumer
    // `zheref/KroApple` means `zheref/KroApple`, so the code a row is written
    // in resolves back to the row it came from. A bare value nothing claims is
    // carried as recorded; `codeFor` and the register's own name-half match
    // still pair it with a slug, because inventing an owner is a guess.
    const slugs = new Map<string, string>();
    for (const [code, name] of Object.entries(registry.productCodes)) {
      slugs.set(code, recordedRepoFor(registry, name) ?? name);
    }
    for (const entry of registry.consumers) {
      if (entry.code !== null && !slugs.has(entry.code)) slugs.set(entry.code, entry.repo);
    }
    const consumerCode = (slug: string): string | null =>
      registry.consumers.find((entry): boolean => entry.code !== null && entry.repo.toLowerCase() === slug.toLowerCase())?.code ?? null;
    return {
      codeFor: (slug): string | null => productCodeFor(registry, slug) ?? consumerCode(slug),
      slugFor: (code): string | null => slugs.get(code) ?? null,
      unavailable: null,
    };
  } catch (error) {
    // THE REAL REASON GOES TO STDERR (Nobunaga N12) -- a malformed registry is
    // a thing the operator must be able to fix -- and NOT INTO THE PAGE: a
    // registry error names the absolute path it looked at, and footerNote is
    // pasted into pull requests (./data.ts's own rule for `repo`).
    warn(`register: object notation falls back to <owner>/<name>#<n>: ${error instanceof Error ? error.message : String(error)}`);
    return { codeFor: (): null => null, slugFor: (): null => null, unavailable: "no readable nen/repos.json in --repo" };
  }
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
 * `--variant`'s declared template against the `--template` actually being filled.
 *
 * THE POLICY SAYS WHICH TEMPLATE A VARIANT IS FOR, AND IT WAS BEING VALIDATED
 * AND THEN IGNORED (Copilot, #221). `--variant turn --template
 * spiritual-message.html` succeeded and injected the turn blocks into the
 * template the policy reserves for another variant -- producing a page that
 * looks finished and is wrong, which is the one outcome this whole family
 * refuses everywhere else (a blank cell reads as a fact; so does a filled one
 * in the wrong page).
 *
 * THE COMPARISON IS ON THE BASENAME WITHOUT ITS EXTENSION, because that is what
 * `reports.template` has always named: a slug identifying one of this
 * repository's own templates, never a path (../schema/workflow.ts holds it to
 * exactly that shape). So `templates/rikugan.html`, `./rikugan.html` and
 * `rikugan` all satisfy a variant declaring `rikugan`, and nothing about where
 * the caller keeps their templates is nen's business.
 */
function assertVariantTemplate(variantName: string, declared: string, template: string): void {
  const basename = (template.split(/[\\/]/).at(-1) ?? template).replace(/\.[^.]*$/, "");
  if (basename === declared) return;
  throw new VerbUsageError(
    `--variant '${variantName}' declares template '${declared}', and --template '${template}' is '${basename}'. The variant's own policy says which template its blocks are written for, so filling a different one produces a report that looks finished and shows the wrong page. Point --template at '${declared}', or render the variant that names '${basename}'.`,
  );
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
  // A NULL-PROTOTYPE MAP (Copilot, #221). `sections.<block>` is keyed by a name
  // the REPOSITORY chose, and `__proto__` assigned on a plain object invokes
  // the prototype setter instead of creating an own flag -- so a block the
  // policy declared would be missing from the very map that exists to say it
  // was declared, and ./template.ts's `Object.hasOwn` would refuse the render.
  // ../schema/workflow.ts refuses that name at load as well; this is what makes
  // it impossible rather than merely reported.
  const sections: Record<string, boolean> = Object.create(null) as Record<string, boolean>;
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
  const template = required(context, "template", "It names the file whose tokens are filled.");
  if (variant !== null) assertVariantTemplate(variant.name, variant.section.template, template);
  const result = renderReport(root, {
    template,
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
