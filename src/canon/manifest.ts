// Manifest-aware handbook availability and directed port-pair selection.
import { lstatSync, readFileSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { containedOn } from "./paths.js";
import { SCENARIO_TOKEN } from "./resolve.js";

export interface HandbookManifest {
  readonly root: string;
  readonly path: string;
  readonly alwaysLoad: readonly string[];
  readonly scenarios: Readonly<Record<string, string>>;
}

export function checkedCanonFile(root: string, path: string): string {
  const absolute = resolve(root, path);
  if (!containedOn(root, absolute, process.platform) || !statSync(absolute).isFile()) throw new Error(`handbook '${path}' is not an existing file inside canon root '${root}'`);
  return absolute;
}

/** Reads the governing INDEX's Always load and exactly-one-stack tables. */
export function readHandbookManifest(root: string, path: string): HandbookManifest {
  const absolute = checkedCanonFile(root, path);
  const text = readFileSync(absolute, "utf8");
  let section = "";
  const alwaysLoad: string[] = [];
  const scenarios: Record<string, string> = {};
  const linked = (line: string): string | null => {
    const link = /\[[^\]]*\]\(([^)]+\.md)\)/.exec(line)?.[1];
    if (link === undefined) return null;
    const file = resolve(dirname(absolute), link);
    if (!containedOn(root, file, process.platform)) throw new Error(`manifest link '${link}' leaves canon root`);
    const rel = relative(root, file).replaceAll("\\", "/");
    checkedCanonFile(root, rel);
    return rel;
  };
  for (const line of text.split(/\r?\n/)) {
    if (/^#{1,6} /.test(line)) { section = line.replace(/^#+\s*/, "").toLowerCase(); continue; }
    if (!line.startsWith("|")) continue;
    if (section.startsWith("always load")) {
      const file = linked(line);
      if (file !== null) alwaysLoad.push(file);
    } else if (/exactly.*one stack/.test(section)) {
      const scenario = /^\|\s*`([^`]+)`\s*\|/.exec(line)?.[1];
      if (scenario === undefined) continue;
      if (!SCENARIO_TOKEN.test(scenario) || Object.hasOwn(scenarios, scenario)) throw new Error(`manifest has invalid or duplicate scenario '${scenario}'`);
      const file = linked(line);
      if (file === null) throw new Error(`manifest scenario '${scenario}' has no stack handbook link`);
      scenarios[scenario] = file;
    }
  }
  if (alwaysLoad.length === 0 || Object.keys(scenarios).length === 0) throw new Error(`manifest '${path}' has no Always load or exactly-one-stack table`);
  return { root, path: absolute, alwaysLoad: [...new Set(alwaysLoad)], scenarios };
}

export function portPair(root: string, portsDir: string, from: string, to: string, scenarios: readonly string[]): string | null {
  if (!SCENARIO_TOKEN.test(from) || !scenarios.includes(from)) throw new Error(`--port-from '${from}' is not a scenario in the governing stack set`);
  if (from === to) throw new Error(`--port-from '${from}' names the target's own scenario`);
  if (isAbsolute(portsDir) || !containedOn(root, resolve(root, portsDir), process.platform)) throw new Error("--ports-dir must stay inside canon root");
  const path = `${portsDir.replace(/\/+$/, "")}/${from}--${to}.md`;
  try { lstatSync(resolve(root, path)); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return null; throw error; }
  checkedCanonFile(root, path);
  return path;
}
