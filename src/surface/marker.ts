import { lstatSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { emit, VerbUsageError, type CommandContext } from "../cli/command.js";
import { plainLine } from "../cli/plain.js";
import { assertRepoRoot } from "../repo/root.js";
import { splitDocument } from "./frontmatter.js";
import { readMarker } from "./mirror.js";
import { findSurface, surfaceNames } from "./rules.js";

const RETIRED = "<!-- GENERATED for surface: antigravity -- do not edit; edit the source and regenerate -->";

/** Current marker recognition stays with the generator; retired recognition cannot authorize a refresh. */
export function inspectMarker(text: string): { generated: boolean; grammar: string | null; surface: string | null; stamp: string | null } {
  const marker = readMarker(text);
  if (marker !== null) return { generated: true, grammar: "nen-surface-mirror", ...marker };
  let retired = (splitDocument(text).body.split("\n")[0] ?? "").replace(/\r$/, "") === RETIRED;
  if (text.startsWith("#!")) retired = (text.split("\n")[1] ?? "").replace(/\r$/, "") === `# ${RETIRED}`;
  if (!retired && text.trimStart().startsWith("{")) {
    try {
      const document = JSON.parse(text) as Record<string, unknown> | null;
      retired = document !== null && document["description"] === RETIRED;
    } catch { /* Invalid JSON is an ungenerated document, not a filesystem failure. */ }
  }
  return { generated: false, grammar: retired ? "retired-antigravity" : null, surface: retired ? "antigravity" : null, stamp: null };
}

export function runMarker(context: CommandContext): number {
  const values = context.args.values;
  const file = values["file"]; const under = values["under"]; const surface = values["surface"];
  if (context.args.positionals.length !== 2 || context.args.passthrough.length !== 0 || (file === undefined) === (under === undefined)) {
    throw new VerbUsageError("surface marker requires exactly one of --file <path> or --under <directory> --surface <name>.");
  }
  for (const key of [...Object.keys(values), ...context.args.booleans]) {
    if (!["file", "under", "surface", "repo", "json"].includes(key)) throw new VerbUsageError(`--${key} is not used by surface marker.`);
  }
  if (file !== undefined && surface !== undefined) throw new VerbUsageError("--surface belongs to marker --under, not --file.");
  if (under !== undefined && (surface === undefined || findSurface(surface) === undefined)) {
    throw new VerbUsageError(`marker --under requires --surface: ${surfaceNames().join(", ")}.`);
  }
  const input = file ?? under ?? "";
  if (input.trim() === "") throw new VerbUsageError("surface marker requires a non-empty path.");
  const path = resolve(context.repoFlag === null ? process.cwd() : assertRepoRoot({ repoFlag: context.repoFlag }), input);
  try {
    // Resolve the caller's boundary once (e.g. macOS /tmp); never follow a link
    // found inside it, including a symlink supplied as the boundary itself.
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error("symlink input is not followed");
    if (file !== undefined) {
      if (!stat.isFile()) throw new Error("--file must name a regular file");
      const result = { contract: "nen.surface.marker/v0.1", file: path, ...inspectMarker(readFileSync(path, "utf8")) };
      emit(context.io, context.json, result, [
        `file: ${plainLine(path)}`, `generated: ${result.generated ? "yes" : "no"}`,
        `surface: ${plainLine(result.surface ?? "(none)")}`, `grammar: ${result.grammar ?? "(none)"}`, `stamp: ${plainLine(result.stamp ?? "(none)")}`,
      ]);
      return result.generated ? 0 : 1;
    }
    if (!stat.isDirectory()) throw new Error("--under must name a directory");
    const root = realpathSync(path);
    const matches: string[] = [];
    const skipped: string[] = [];
    function visit(directory: string, prefix: string): void {
      for (const name of readdirSync(directory).sort()) {
        const child = join(directory, name); const relative = prefix + name;
        const entry = lstatSync(child);
        if (entry.isSymbolicLink()) { skipped.push(relative); continue; }
        if (entry.isDirectory()) visit(child, `${relative}/`);
        else if (entry.isFile()) {
          const marker = readMarker(readFileSync(child, "utf8"));
          if (marker?.surface === surface) matches.push(relative);
        } else skipped.push(relative);
      }
    }
    visit(root, "");
    const result = { contract: "nen.surface.marker/v0.1", under: path, surface, generated: matches.length > 0, matches, skipped };
    emit(context.io, context.json, result, [`under: ${plainLine(path)}`, `surface: ${surface}`, `generated: ${result.generated ? "yes" : "no"}`, ...matches.map((match) => `  ${plainLine(match)}`)]);
    return result.generated ? 0 : 1;
  } catch (error) {
    throw new VerbUsageError(`surface marker could not read '${plainLine(path)}': ${plainLine(error instanceof Error ? error.message : String(error))}`);
  }
}
