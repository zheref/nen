import { plainLine } from "../cli/plain.js";
// Registry + classification + bidirectional declaration parity, read-only.
import { accessSync, constants, lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { emit, requireRepoFlag, requireValue, VerbUsageError, type CommandContext } from "../cli/command.js";
import { assertRepoRoot } from "../repo/root.js";
import { realContainment } from "../repo/contain.js";
import { loadDirectRegistry } from "../direct/registry.js";
import { loadClassifyTaxonomy, validatePhaseCoverage } from "../classify/taxonomy.js";
import { compareDeclaration, notLanded } from "../classify/install.js";
import { loadLabelTaxonomy } from "../schema/labels.js";
import { LABELS_FILE } from "../schema/source.js";

export function runCanonCheck(context: CommandContext): number {
  const root = realpathSync.native(assertRepoRoot({ repoFlag: requireRepoFlag(context, "It declares the label set being compared, read only.") }));
  const registryPath = requireValue(context.args, "registry", "Name the independent model/phase registry.");
  const taxonomyPath = requireValue(context.args, "taxonomy", "Name the classification taxonomy.");
  if (context.args.positionals.length !== 2 || context.args.passthrough.length > 0) throw new VerbUsageError("canon check takes no positional arguments.");
  for (const flag of Object.keys(context.args.values)) if (!["repo", "registry", "taxonomy"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by canon check.`);
  for (const flag of context.args.booleans) if (!["json", "help"].includes(flag)) throw new VerbUsageError(`--${flag} is not read by canon check; it never installs or writes.`);
  // Match the wrapper's preflight: no symlinked files/parents, no parsing an
  // unreadable or missing path as an empty successful contract.
  for (const file of [registryPath, taxonomyPath, LABELS_FILE]) {
    const path = resolve(root, file);
    const containment = realContainment(root, path);
    if (!containment.contained || containment.link !== null) throw new VerbUsageError(`canon check input '${file}' must stay inside --repo without symlinks.`);
    try { if (!lstatSync(path).isFile()) throw new Error("not a regular file"); accessSync(path, constants.R_OK); }
    catch { throw new VerbUsageError(`canon check input '${file}' is missing or not a regular file.`); }
  }
  const checks: { name: string; ok: boolean; detail: string }[] = [];
  let registry: ReturnType<typeof loadDirectRegistry> | undefined;
  let taxonomy: ReturnType<typeof loadClassifyTaxonomy> | undefined;
  let parity: ReturnType<typeof compareDeclaration> | null = null;
  const read = (name: string, action: () => string): void => {
    try { checks.push({ name, ok: true, detail: action() }); }
    catch (error) { checks.push({ name, ok: false, detail: error instanceof Error ? error.message : String(error) }); }
  };
  read("direct registry", () => { registry = loadDirectRegistry(root, registryPath); return "valid"; });
  read("classify labels", () => {
    taxonomy = loadClassifyTaxonomy(root, taxonomyPath);
    validatePhaseCoverage(taxonomy, registry === undefined ? undefined : Object.keys(registry.phases));
    return registry === undefined ? "valid taxonomy; independent registry unavailable" : "valid with independent phase coverage";
  });
  read("labels parity", () => {
    const parsed = taxonomy ?? loadClassifyTaxonomy(root, taxonomyPath);
    parity = compareDeclaration(parsed, loadLabelTaxonomy(root));
    const absentOrDrifted = notLanded(parity);
    if (absentOrDrifted.length > 0 || parity.foreign.length > 0) throw new Error(`${absentOrDrifted.length} absent/drifted taxonomy labels; ${parity.foreign.length} foreign axis-prefixed labels`);
    return "both sets agree; no write or sync";
  });
  const exitCode = checks.every((check) => check.ok) ? 0 : 1;
  emit(context.io, context.json, { contract: "nen.canon.check/v0.1", checks, parity, exitCode }, checks.map((check) => plainLine(`${check.ok ? "ok" : "FAIL"} ${check.name}: ${check.detail}`)));
  return exitCode;
}
