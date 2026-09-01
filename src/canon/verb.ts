// src/canon/verb.ts -- `nen canon resolve` and `nen canon mirror
// generate|check`, sync_canon.py's port.

import { readFileSync, writeFileSync } from "node:fs";
import { assertRepoRoot } from "../repo/root.js";
import { loadRepoRegistry } from "../schema/repos.js";
import { usage, type Verb, type VerbContext } from "../cli/verb.js";
import { parseTarget } from "../github/target.js";
import { resolveScenario } from "../repo/scenario.js";
import { resolveCanon } from "./resolve.js";
import {
  checkMirror,
  generateMirror,
  mirrorReportOk,
  parseCanonValues,
  renderReportMarkdown,
  writeMirror,
  type HeaderTemplate,
} from "./mirror.js";

function commaList(value: string | undefined): readonly string[] {
  if (value === undefined) return [];
  return value
    .split(",")
    .map((item): string => item.trim())
    .filter((item): boolean => item !== "");
}

const USAGE = `nen canon -- resolve a repo's handbook set, or generate/check its rule mirror.

usage:
  nen canon resolve --repo <path> --target <owner/name>
                    --always-load <path,path,...> --stack-dir <dir>
                    [--leaf architecture.md]
      Always-load + exactly one stack handbook. --always-load is caller data
      (the repository's own canon manifest); the stack path is derived
      directly from the scenario, never looked up in a table.

  nen canon mirror generate --rules-dir <dir> --canon-values <path>
                            --out-dir <dir> --ref <ref>
                            --header-template <template> --not-mirrored <a,b>
                            [--scenario <name>]
      Ported from scripts/sync_canon.py: substitutes every {{TOKEN}} in each
      canonical rule file (every .md in --rules-dir except --not-mirrored),
      prepends a generated-file header, and writes only files whose content
      changed -- deleting an orphaned mirror file whose canon source is gone.
      --header-template takes {ref}/{scenario}/{file} placeholders, and is
      caller data: the header text is this system's own convention, never a
      literal shipped here.

  nen canon mirror check --rules-dir <dir> --canon-values <path>
                         --mirror-dir <dir> --ref <ref>
                         --header-template <template> --header-pattern <regex>
                         --not-mirrored <a,b>
                         [--scenario <name>] [--markdown-out <path>]
      Regenerates from the same inputs and diffs against --mirror-dir without
      writing anything. Exits 1 (drift) iff missing/extra/stale/hand-edited is
      non-empty. --header-template regenerates the comparison copy (same
      template 'generate' used); --header-pattern is a JS regex with named
      groups (?<ref>...) (?<scenario>...) (?<file>...) that reads the ref back
      out of the COMMITTED mirror's own header, to tell 'stale' from
      'hand-edited'.`;

export const canonVerb: Verb = {
  name: "canon",
  summary: "Resolve a repo's handbook set, or generate/check its canon-rule mirror.",
  usage: USAGE,
  flags: {
    values: [
      "target",
      "always-load",
      "stack-dir",
      "leaf",
      "rules-dir",
      "canon-values",
      "out-dir",
      "ref",
      "scenario",
      "header-template",
      "header-pattern",
      "not-mirrored",
      "mirror-dir",
      "markdown-out",
    ],
    booleans: [],
  },
  run(context: VerbContext): number {
    const [subcommand, mirrorSub] = context.args;
    switch (subcommand) {
      case "resolve":
        return resolve(context);
      case "mirror":
        return mirror(context, mirrorSub);
      default:
        return usage(context.io, `unknown 'canon' subcommand '${subcommand ?? "(none)"}'. Run 'nen canon --help'.`);
    }
  },
};

function resolve(context: VerbContext): number {
  const targetRaw = context.values["target"];
  if (targetRaw === undefined) return usage(context.io, "--target owner/name is required.");
  const stackDir = context.values["stack-dir"];
  if (stackDir === undefined) return usage(context.io, "--stack-dir <dir> is required.");

  let root: string;
  let target;
  try {
    root = assertRepoRoot({ repoFlag: context.repoFlag });
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

  const resolution = resolveCanon({
    scenario: scenarioResult.scenario,
    alwaysLoad: commaList(context.values["always-load"]),
    stackDir,
    leaf: context.values["leaf"],
  });

  if (context.json) {
    context.io.out(JSON.stringify(resolution, null, 2));
    return 0;
  }
  context.io.out(`scenario: ${resolution.scenario}`);
  context.io.out(`always load: ${resolution.alwaysLoad.join(", ") || "(none)"}`);
  context.io.out(`stack handbook: ${resolution.stackHandbook}`);
  return 0;
}

function readCanonValuesInputs(
  context: VerbContext,
): { rulesDir: string; canonValuesPath: string; ref: string; notMirrored: ReadonlySet<string> } | null {
  const rulesDir = context.values["rules-dir"];
  const canonValuesPath = context.values["canon-values"];
  const ref = context.values["ref"];
  if (rulesDir === undefined || canonValuesPath === undefined || ref === undefined) {
    usage(context.io, "canon mirror takes --rules-dir, --canon-values and --ref.");
    return null;
  }
  return { rulesDir, canonValuesPath, ref, notMirrored: new Set(commaList(context.values["not-mirrored"])) };
}

function resolveScenarioArg(context: VerbContext, valuesText: string): string | null {
  const explicit = context.values["scenario"];
  if (explicit !== undefined) return explicit;
  const match = /^scenario:\s*(\S+)\s*$/m.exec(valuesText);
  if (match?.[1] === undefined) {
    context.io.err("nen: --scenario not given and the canon-values file has no 'scenario:' field.");
    return null;
  }
  return match[1];
}

function mirror(context: VerbContext, mirrorSub: string | undefined): number {
  if (mirrorSub !== "generate" && mirrorSub !== "check") {
    return usage(context.io, `unknown 'canon mirror' subcommand '${mirrorSub ?? "(none)"}'. Try 'generate' or 'check'.`);
  }
  const inputs = readCanonValuesInputs(context);
  if (inputs === null) return 2;

  let valuesText: string;
  try {
    valuesText = readFileSync(inputs.canonValuesPath, "utf8");
  } catch (error) {
    context.io.err(`nen: could not read --canon-values '${inputs.canonValuesPath}': ${String(error)}`);
    return 1;
  }
  const { values } = parseCanonValues(valuesText);
  const scenario = resolveScenarioArg(context, valuesText);
  if (scenario === null) return 2;

  if (mirrorSub === "generate") {
    const template = context.values["header-template"];
    const outDir = context.values["out-dir"];
    if (template === undefined || outDir === undefined) {
      return usage(context.io, "canon mirror generate takes --header-template and --out-dir.");
    }
    const header: HeaderTemplate = { template, pattern: /(?:)/ };
    let generated;
    try {
      generated = generateMirror(inputs.rulesDir, values, inputs.ref, scenario, header, inputs.notMirrored);
    } catch (error) {
      context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
    const result = writeMirror(outDir, generated, inputs.notMirrored);
    if (context.json) {
      context.io.out(JSON.stringify(result, null, 2));
      return 0;
    }
    context.io.out(`written: ${result.written.join(", ") || "(none)"}`);
    context.io.out(`unchanged: ${result.unchanged.join(", ") || "(none)"}`);
    context.io.out(`deleted (orphaned): ${result.deleted.join(", ") || "(none)"}`);
    return 0;
  }

  const patternRaw = context.values["header-pattern"];
  const templateRaw = context.values["header-template"];
  const mirrorDir = context.values["mirror-dir"];
  if (patternRaw === undefined || templateRaw === undefined || mirrorDir === undefined) {
    return usage(
      context.io,
      "canon mirror check takes --header-pattern, --header-template and --mirror-dir -- the template regenerates a fresh comparison copy, the pattern reads the committed mirror's own ref back out of it.",
    );
  }
  const header: HeaderTemplate = { template: templateRaw, pattern: new RegExp(patternRaw) };
  let report;
  try {
    report = checkMirror(inputs.rulesDir, values, mirrorDir, inputs.ref, scenario, header, inputs.notMirrored);
  } catch (error) {
    context.io.err(`nen: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const markdownOut = context.values["markdown-out"];
  if (markdownOut !== undefined) {
    writeFileSync(markdownOut, renderReportMarkdown(report), "utf8");
  }
  if (context.json) {
    context.io.out(JSON.stringify(report, null, 2));
    return mirrorReportOk(report) ? 0 : 1;
  }
  context.io.out(`ok: ${report.ok.length}`);
  context.io.out(`missing: ${report.missing.join(", ") || "(none)"}`);
  context.io.out(`extra: ${report.extra.join(", ") || "(none)"}`);
  context.io.out(`stale: ${report.stale.join(", ") || "(none)"}`);
  context.io.out(`hand-edited: ${report.handEdited.join(", ") || "(none)"}`);
  return mirrorReportOk(report) ? 0 : 1;
}
