// src/canon/command.ts -- `nen canon resolve`, and `nen canon mirror
// generate|check`: a consumer's canon mirror, rendered into every agent
// surface it declares (CON-13).
//
// TWO HALVES, ONE QUESTION EACH. `resolve` answers "which handbooks does this
// repository load" from the scenario its registry records. `mirror` renders
// the stack's rule set (a directory in a checkout of the canonical handbooks
// repository, at the tag the consumer pins) into the rules location of each
// surface the consumer uses, and `check` says whether the committed copies
// are still that rendering. Neither decides handbook CONTENT, fetches
// anything, or knows a repository by name: the source, the ref, the rules
// directory, the values and the surface list are all the caller's.
//
// THE SURFACE LIST IS THE CONSUMER'S DECLARATION, read from its canon-values
// file (`surfaces:`) or given as `--surfaces`; the set it may name is
// ../surface/rules.ts's rows -- adding a surface is a row there, never a
// change here. "Every supported surface" is deliberately NOT a default: a
// repository nobody uses with a given agent should not carry that agent's
// rules directory.
//
// THE PIN IS A TAG, ENFORCED. CON-13's pin discipline is "regenerated from a
// tag, never floating main" -- the incident it records is a consumer pinned
// to a tag that predated the canon, whose next regen wiped the mirror from an
// empty source. `--ref` is therefore refused unless it is tag-shaped
// (`v<major>.<minor>[.<patch>][-pre]`): a branch name or a bare SHA is not a
// pin a reader of the marker can reason about, and "cut the tag before
// repinning a consumer to it" is the rule this verb can hold a caller to.

import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { readTextFile, resolveAgainstRepo } from "../cli/inputs.js";
import { assertRepoRoot, looksLikeOwnerSlug } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { commaList } from "../cli/comma.js";
import { emit, requireRepoFlag, requireSubcommand, VerbUsageError, type Command, type CommandContext } from "../cli/command.js";
import { isContained } from "../repo/contain.js";
import { parseTarget } from "../github/target.js";
import { resolveScenario } from "../repo/scenario.js";
import { canonSurfaceNames, canonSurfaces, type SurfaceRow } from "../surface/rules.js";
import { resolveCanon } from "./resolve.js";
import {
  CanonMirrorError,
  checkSurface,
  guardSurface,
  parseCanonValues,
  readCanonSources,
  renderReportMarkdown,
  renderSurface,
  surfaceReportOk,
  writeSurface,
  type CanonPin,
  type SurfaceCheckReport,
  type SurfaceRendering,
} from "./mirror.js";

export const GENERATE_CONTRACT = "nen.canon.mirror.generate/v0.1";
export const CHECK_CONTRACT = "nen.canon.mirror.check/v0.1";

/** `v<major>.<minor>[.<patch>][-pre|+build]` -- the shape a canon tag has, and nothing that could float. */
const TAG_RE = /^v\d+\.\d+(?:\.\d+)?(?:[-+][0-9A-Za-z.-]+)?$/;

const SURFACE_LIST = canonSurfaces()
  .map((row): string => {
    const rule = row.canonMirror;
    /* c8 ignore next -- canonSurfaces() filters the null rows out */
    if (rule === null) return "";
    const where = rule.kind === "directory" ? `${rule.dir}/*${rule.extension} (one file per canon file)` : `${rule.file} (one managed block)`;
    return `    ${row.surface.padEnd(12)} ${where}`;
  })
  .join("\n");

const USAGE = `nen canon -- resolve a repo's handbook set, or render/check its canon mirror on every surface it uses.

usage:
  nen canon resolve --repo <path> --target <owner/name>
                    --always-load <path,path,...> --stack-dir <dir>
                    [--leaf architecture.md]
      Always-load + exactly one stack handbook. --always-load is caller data
      (the repository's own canon manifest); the stack path is derived
      directly from the scenario, never looked up in a table. --always-load
      is REQUIRED and refused if it names no paths -- an omitted flag must
      never read as "this repository loads nothing unconditionally". A
      resolved scenario that is empty or path-shaped ('.', '..', contains
      '/') is refused too, since the stack path is built directly from it.
      --repo is REQUIRED the same way (exit 2), never defaulted to the
      current directory: it names the checkout whose nen/repos.json
      maps --target to its scenario, and a cwd default surfaced as that
      directory's missing-or-unrelated registry instead of the forgotten
      flag (zheref/nen#28).

  nen canon mirror generate --repo <consumer> --rules-dir <dir>
                            --canon-values <path> --source <owner/name> --ref <tag>
                            [--surfaces <a,b,...>] [--scenario <name>]
                            [--not-mirrored <a,b>] [--dry-run] [--json]
      Renders every rule file in --rules-dir (each .md, minus --not-mirrored:
      the canon directory's own README and placeholder index), with every
      {{TOKEN}} bound from --canon-values, into the rules location of EACH
      surface named -- the consumer's own root is --repo, and the location is
      the surface's documented one:
${SURFACE_LIST}
      Every file carries a generated-from marker naming --source@--ref, the
      scenario and the canon file; a document surface gets ONE block between
      a BEGIN and an END marker, and the consumer's own prose outside it is
      preserved byte for byte. Only files whose bytes changed are written; a
      marked file whose canon source is gone is deleted as an orphan.

      THE MARKER IS THE OWNERSHIP CLAIM. A destination that exists and carries
      no marker was written by hand: the whole run is REFUSED (exit 2) before
      the first byte is written on any surface, naming the file -- move or
      rename the consumer's own rule, or drop it for the canon one. An
      unmarked file in a rules directory with no canon source is the
      consumer's own: never deleted, listed as 'foreign', never drift.

      --repo is REQUIRED: this verb writes into the consumer's tree, and a
      cwd default would render a mirror into whatever directory the shell
      happened to be in. --rules-dir and --canon-values resolve against it
      (an absolute value is used as-is). --surfaces overrides the
      canon-values file's own 'surfaces:' key (inline 'a, b' or a '- a' list);
      one of the two is required. --scenario overrides its 'scenario:' key the
      same way. --ref must be tag-shaped (v1.2, v1.2.3, v1.2.3-rc1): the pin
      discipline is "from a tag, never floating main", and cut the tag BEFORE
      repinning a consumer to it. --dry-run reports every write and performs
      none.

  nen canon mirror check --repo <consumer> --rules-dir <dir>
                         --canon-values <path> --source <owner/name> --ref <tag>
                         [--surfaces <a,b,...>] [--scenario <name>]
                         [--not-mirrored <a,b>] [--markdown-out <path>] [--json]
      Renders the same mirror in memory and diffs every surface's committed
      copy against it, writing nothing (the CI half). Per surface, a file is
      ok, MISSING (canon has it, the mirror does not), EXTRA (marked, no canon
      source -- an orphan), STALE (its marker names another source, ref or
      scenario: generated, but never regenerated after the pin moved), or
      HAND-EDITED (marked for this pin, bytes differ -- or no marker at all);
      an unmarked sourceless file is FOREIGN and is not drift. On a document
      surface the block's sections are classified one canon file at a time; a
      block with a broken marker pair reads hand-edited whole, and a document
      with no block reads missing whole. Exit 1 iff any surface has drift.
      --markdown-out also writes the drift as a table (Surface | File | Issue).`;

export const canonCommand: Command = {
  name: "canon",
  subcommands: ["resolve", "mirror"],
  summary: "Resolve a repo's handbook set, or render/check its canon-rule mirror on every surface it uses.",
  usage: USAGE,
  flags: {
    values: [
      "target",
      "always-load",
      "stack-dir",
      "leaf",
      "rules-dir",
      "canon-values",
      "source",
      "ref",
      "scenario",
      "surfaces",
      "not-mirrored",
      "markdown-out",
    ],
    booleans: ["dry-run"],
  },
  // The flags the one-directory shape of `canon mirror` took, refused by name
  // with where their meaning went (../index.ts's runFamily prints the hint
  // beside the parser's own refusal). A caller scripted against the old
  // shape must hear that the location is now each surface's own and the
  // header is nen's marker -- not merely "unknown option".
  hints: {
    "--out-dir": "the mirror's location is now each surface's own rules location under --repo; name the surfaces with --surfaces (or a 'surfaces:' key in the canon-values file) instead of a directory.",
    "--mirror-dir": "the mirror's location is now each surface's own rules location under --repo; 'check' reads them from there. Name the surfaces with --surfaces (or a 'surfaces:' key in the canon-values file).",
    "--header-template": "the generated-from marker is nen's own now and is not a template; it names --source@--ref, the scenario and the canon file. Pass --source and --ref.",
    "--header-pattern": "the marker is read back by nen itself now; there is no pattern to give. Pass --source and --ref, and 'check' tells stale from hand-edited on its own.",
  },
  run(context: CommandContext): number {
    const subcommand = requireSubcommand("canon", context.args, ["resolve", "mirror"]);
    if (subcommand === "resolve") return resolveVerb(context);
    return mirror(context, context.args.positionals[2]);
  },
};

function resolveVerb(context: CommandContext): number {
  // FIRST, in usage-line order: --repo is listed unbracketed, so its absence
  // is refused at the parser exactly like --target/--stack-dir/--always-load
  // below, never patched over with the call site's cwd (zheref/nen#28).
  const repoFlag = requireRepoFlag(
    context,
    "It is the checkout whose nen/repos.json maps --target to the scenario this handbook set derives from; defaulting to the current directory reported that directory's missing-or-unrelated registry instead of the forgotten flag.",
  );
  const targetRaw = context.args.values["target"];
  if (targetRaw === undefined) throw new VerbUsageError("--target owner/name is required.");
  const stackDir = context.args.values["stack-dir"];
  if (stackDir === undefined) throw new VerbUsageError("--stack-dir <dir> is required.");
  const alwaysLoadRaw = context.args.values["always-load"];
  if (alwaysLoadRaw === undefined) {
    throw new VerbUsageError("--always-load <path,path,...> is required -- see 'nen canon resolve --help'.");
  }

  let root: string;
  let target;
  try {
    root = assertRepoRoot({ repoFlag });
    target = parseTarget(targetRaw);
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }

  const registry = loadRepoRegistry(root);
  const scenarioResult = resolveScenario(registry, target.slug);
  if (!scenarioResult.ok) {
    context.io.err(`nen: ${scenarioResult.reason}`);
    return 1;
  }

  const alwaysLoad = commaList(alwaysLoadRaw);
  if (alwaysLoad.length === 0) {
    throw new VerbUsageError(
      "--always-load named no paths. Omit it entirely only if you truly mean an empty always-load set is impossible -- this flag has no meaningful empty form.",
    );
  }

  const result = resolveCanon({
    scenario: scenarioResult.scenario,
    alwaysLoad,
    stackDir,
    leaf: context.args.values["leaf"],
  });
  if (!result.ok) {
    context.io.err(`nen: ${result.reason}`);
    return 1;
  }
  const resolution = result.value;

  if (context.json) {
    context.io.out(JSON.stringify(resolution, null, 2));
    return 0;
  }
  context.io.out(`scenario: ${resolution.scenario}`);
  context.io.out(`always load: ${resolution.alwaysLoad.join(", ")}`);
  context.io.out(`stack handbook: ${resolution.stackHandbook}`);
  return 0;
}

/** A required `--flag <value>`, refused by name when absent or empty. */
function required(context: CommandContext, flag: string, why: string): string {
  const value = context.args.values[flag];
  if (value === undefined || value.trim() === "") throw new VerbUsageError(`--${flag} is required. ${why}`);
  return value;
}

/** Everything both mirror subcommands read before they diverge. */
interface MirrorInputs {
  readonly root: string;
  readonly rulesDir: string;
  readonly pin: CanonPin;
  readonly rows: readonly SurfaceRow[];
  readonly renderings: readonly SurfaceRendering[];
  readonly sources: ReturnType<typeof readCanonSources>;
}

function readMirrorInputs(context: CommandContext): MirrorInputs {
  const repoFlag = requireRepoFlag(
    context,
    "It is the CONSUMER repository this mirror is rendered into, and a cwd default would render a mirror into whatever directory the shell was standing in.",
  );
  const root = assertRepoRoot({ repoFlag });
  const rulesDirFlag = required(context, "rules-dir", "It names the stack's rules/ directory inside a checkout of the canonical handbooks repository at the pinned tag.");
  const canonValuesPath = required(context, "canon-values", "It names the consumer's own {{TOKEN}} bindings (and, optionally, its 'scenario:' and 'surfaces:').");
  const source = required(context, "source", "It names the canonical handbooks repository as owner/name, recorded in every mirror file's marker.");
  const ref = required(context, "ref", "It is the tag of --source the mirror is rendered from, recorded in every mirror file's marker.");
  if (!looksLikeOwnerSlug(source)) {
    throw new VerbUsageError(`--source '${source}' is not an owner/name slug. It names the canonical handbooks repository the marker cites, e.g. --source owner/handbooks.`);
  }
  if (!TAG_RE.test(ref)) {
    throw new VerbUsageError(
      `--ref '${ref}' is not tag-shaped (v<major>.<minor>[.<patch>][-pre]). A canon mirror is rendered from a TAG of --source, never a branch or a bare commit: cut the tag first, then pin the consumer to it (CON-13's pin discipline).`,
    );
  }

  // READ THROUGH THE SHARED READER, so an unreadable --canon-values is the
  // named exit-2 refusal every other path flag gives rather than exit 1
  // (zheref/nen#101): without it there is no mirror to render and nothing to
  // check one against, which is a question that was never asked rather than
  // a comparison that came out negative.
  const valuesText = readTextFile(
    resolveAgainstRepo(root, canonValuesPath),
    root,
    "--canon-values names the vocabulary every mirrored rule is keyed by, so an unreadable one is refused rather than mirrored against nothing.",
  );
  const values = parseCanonValues(valuesText);

  const scenario = context.args.values["scenario"] ?? values.scenario;
  if (scenario === null || scenario === undefined || scenario.trim() === "") {
    throw new VerbUsageError("--scenario not given and the canon-values file has no 'scenario:' field.");
  }

  const surfacesFlag = context.args.values["surfaces"];
  if (surfacesFlag !== undefined && surfacesFlag.trim() === "") {
    throw new VerbUsageError(`--surfaces was given an empty value. Name the surfaces this consumer uses; known: ${canonSurfaceNames().join(", ")}.`);
  }
  const named = surfacesFlag === undefined ? values.surfaces : [...commaList(surfacesFlag)];
  if (named === null) {
    throw new VerbUsageError(
      `--surfaces not given and the canon-values file has no 'surfaces:' field. Which agent surfaces a repository is used with is that repository's own declaration, never a default; known: ${canonSurfaceNames().join(", ")}.`,
    );
  }
  if (named.length === 0) {
    throw new VerbUsageError(`the surface list names no surfaces. Known: ${canonSurfaceNames().join(", ")}.`);
  }
  const rows: SurfaceRow[] = [];
  for (const name of [...new Set(named)]) {
    const row = canonSurfaces().find((candidate): boolean => candidate.surface === name);
    if (row === undefined) {
      throw new VerbUsageError(
        `surface '${name}' is not one a canon mirror can be rendered into. Known: ${canonSurfaceNames().join(", ")}. A surface nen has not read the documentation for cannot be guessed at: adding one is a row in src/surface/rules.ts carrying the page every field was read from.`,
      );
    }
    rows.push(row);
  }

  const rulesDir = resolveAgainstRepo(root, rulesDirFlag);
  // A --rules-dir that IS a rendered location would mirror the mirror: the
  // second run would read its own output, marker and all, as canon.
  for (const row of rows) {
    const rule = row.canonMirror;
    if (rule === null || rule.kind !== "directory") continue;
    if (isContained(resolve(root, ...rule.dir.split("/")), resolve(rulesDir))) {
      throw new VerbUsageError(
        `--rules-dir '${rulesDirFlag}' resolves inside '${row.surface}''s rules location (${rule.dir}/) under --repo. The canon would be read from the mirror it renders, and the next run would mirror its own output. Point --rules-dir at the canonical handbooks checkout.`,
      );
    }
  }

  const pin: CanonPin = { source, ref, scenario };
  try {
    const sources = readCanonSources(rulesDir, values.values, new Set(commaList(context.args.values["not-mirrored"])));
    const renderings = rows.map((row): SurfaceRendering => renderSurface(row, sources, pin));
    return { root, rulesDir, pin, rows, renderings, sources };
  } catch (error) {
    // A refusal the mirror raised is a refusal the CALLER made -- an unbound
    // token, an empty rules directory, a file over a surface's limit. It
    // exits 2 like every other "you asked for something that cannot be done",
    // carrying its own message whole.
    if (error instanceof CanonMirrorError) throw new VerbUsageError(error.message);
    throw error;
  }
}

const listOr = (items: readonly string[]): string => (items.length === 0 ? "(none)" : items.join(", "));

function pinLine(pin: CanonPin): string {
  return `source: ${pin.source}@${pin.ref} (scenario ${pin.scenario})`;
}

function mirror(context: CommandContext, mirrorSub: string | undefined): number {
  if (mirrorSub !== "generate" && mirrorSub !== "check") {
    throw new VerbUsageError(`unknown 'canon mirror' subcommand '${mirrorSub ?? "(none)"}'. Try 'generate' or 'check'.`);
  }
  if (mirrorSub === "check" && context.args.booleans.has("dry-run")) {
    throw new VerbUsageError("--dry-run is not read by 'canon mirror check': check writes nothing to begin with. A flag accepted and ignored is worse than one refused.");
  }
  if (mirrorSub === "generate" && context.args.values["markdown-out"] !== undefined) {
    throw new VerbUsageError("--markdown-out is not read by 'canon mirror generate': it renders a drift table, and generate reports writes. Use it with 'check'.");
  }
  const inputs = readMirrorInputs(context);
  for (const row of inputs.rows) {
    const rule = row.canonMirror;
    if (rule !== null) context.io.err(`nen: note: ${row.surface}: ${rule.caveat}.`);
  }
  return mirrorSub === "generate" ? generate(context, inputs) : check(context, inputs);
}

function generate(context: CommandContext, inputs: MirrorInputs): number {
  const dryRun = context.args.booleans.has("dry-run");

  // THE GUARD RUNS OVER EVERY SURFACE BEFORE THE FIRST WRITE ON ANY OF THEM.
  const refusals = inputs.renderings.flatMap((rendering): string[] =>
    guardSurface(inputs.root, rendering).map((message): string => `${rendering.surface}: ${message}`),
  );
  if (refusals.length > 0) {
    throw new VerbUsageError(
      `refusing to write the mirror -- nothing was written on any surface:\n  ${refusals.join("\n  ")}`,
    );
  }

  const results = inputs.renderings.map((rendering) => writeSurface(inputs.root, rendering, dryRun));
  const lines: string[] = [pinLine(inputs.pin), `root: ${inputs.root}${dryRun ? " (--dry-run: nothing written)" : ""}`];
  for (const result of results) {
    lines.push(
      `surface: ${result.surface} -> ${result.location}`,
      `  written: ${listOr(result.written)}`,
      `  unchanged: ${listOr(result.unchanged)}`,
      `  deleted (orphaned): ${listOr(result.deleted)}`,
      ...(result.foreign.length === 0 ? [] : [`  foreign (the consumer's own, left alone): ${result.foreign.join(", ")}`]),
      ...result.notes.map((note): string => `  note: ${note}`),
    );
  }
  emit(
    context.io,
    context.json,
    {
      contract: GENERATE_CONTRACT,
      source: inputs.pin.source,
      ref: inputs.pin.ref,
      scenario: inputs.pin.scenario,
      root: inputs.root,
      dryRun,
      surfaces: results,
    },
    lines,
  );
  return 0;
}

function check(context: CommandContext, inputs: MirrorInputs): number {
  const reports: SurfaceCheckReport[] = inputs.renderings.map((rendering): SurfaceCheckReport =>
    checkSurface(inputs.root, rendering, inputs.pin, inputs.sources),
  );
  const drift = reports.some((report): boolean => !surfaceReportOk(report));
  const markdownOut = context.args.values["markdown-out"];
  if (markdownOut !== undefined) {
    if (markdownOut.trim() === "") throw new VerbUsageError("--markdown-out was given an empty value. Omit it, or name the file to write the drift table to.");
    writeFileSync(resolveAgainstRepo(inputs.root, markdownOut), renderReportMarkdown(reports), "utf8");
  }
  const lines: string[] = [pinLine(inputs.pin), `root: ${inputs.root}`];
  for (const report of reports) {
    lines.push(
      `surface: ${report.surface} -> ${report.location}`,
      `  ok: ${report.ok.length}`,
      `  missing: ${listOr(report.missing)}`,
      `  extra: ${listOr(report.extra)}`,
      `  stale: ${listOr(report.stale)}`,
      `  hand-edited: ${listOr(report.handEdited)}`,
      ...(report.foreign.length === 0 ? [] : [`  foreign (the consumer's own, not drift): ${report.foreign.join(", ")}`]),
    );
  }
  lines.push(drift ? "drift: yes" : "drift: none");
  emit(
    context.io,
    context.json,
    {
      contract: CHECK_CONTRACT,
      source: inputs.pin.source,
      ref: inputs.pin.ref,
      scenario: inputs.pin.scenario,
      root: inputs.root,
      drift,
      surfaces: reports,
    },
    lines,
  );
  return drift ? 1 : 0;
}
