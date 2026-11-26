// Caller-owned vocabulary: no section ids, job keys or family names live here.
import { requireArray, requireRecord, requireString, SchemaError } from "../schema/errors.js";
import type { ClassifyTaxonomy } from "../classify/taxonomy.js";
import type { BodyRequirement } from "./bodycheck.js";

export const SECTIONS_CONTRACT = "nen.pr.sections/v0.1";
export interface Section {
  readonly id: string;
  readonly title: string | Readonly<Record<string, string>>;
  readonly level: number;
  readonly pattern?: string;
  readonly when?: string;
}
export interface SectionCatalogue {
  readonly sections: readonly Section[];
  readonly footer: readonly Section[];
  readonly families: Readonly<Record<string, readonly string[]>>;
  readonly precedence: readonly string[];
  readonly variants: Readonly<Record<string, readonly string[]>>;
  readonly max: number;
}
function strings(path: string, pointer: string, raw: unknown): string[] {
  const result = requireArray(path, pointer, raw).map((value, index): string => requireString(path, `${pointer}[${index}]`, value));
  if (new Set(result).size !== result.length) throw new SchemaError(path, pointer, "duplicate entries");
  return result;
}
function section(path: string, pointer: string, raw: unknown): Section {
  const row = requireRecord(path, pointer, raw);
  const id = requireString(path, `${pointer}.id`, row.id);
  const title = typeof row.title === "string" ? row.title : Object.fromEntries(Object.entries(requireRecord(path, `${pointer}.title`, row.title)).map(([kind, value]): [string, string] => [kind, requireString(path, `${pointer}.title.${kind}`, value)]));
  if (typeof title === "string" ? title.length === 0 : Object.keys(title).length === 0) throw new SchemaError(path, `${pointer}.title`, "expected a nonempty title or kind-to-title map");
  const level = row.level ?? 2;
  if (level !== 1 && level !== 2) throw new SchemaError(path, `${pointer}.level`, "expected 1 or 2");
  const pattern = row.pattern === undefined ? undefined : requireString(path, `${pointer}.pattern`, row.pattern);
  if (pattern !== undefined) {
    try { new RegExp(pattern, "im"); } catch { throw new SchemaError(path, `${pointer}.pattern`, "invalid regular expression"); }
  }
  return { id, title, level, ...(pattern === undefined ? {} : { pattern }), ...(row.when === undefined ? {} : { when: requireString(path, `${pointer}.when`, row.when) }) };
}
export function parseSectionCatalogue(path: string, raw: unknown): SectionCatalogue {
  const root = requireRecord(path, "$", raw);
  const sections = requireArray(path, "sections", root.sections).map((value, index): Section => section(path, `sections[${index}]`, value));
  const footer = requireArray(path, "footer", root.footer).map((value, index): Section => section(path, `footer[${index}]`, value));
  const ids = [...sections, ...footer].map((entry): string => entry.id);
  if (ids.some((id): boolean => id.length === 0) || new Set(ids).size !== ids.length) throw new SchemaError(path, "sections/footer", "section ids must be nonempty and unique");
  if (sections.length === 0) throw new SchemaError(path, "sections", "expected at least one reader section");
  const families = Object.fromEntries(Object.entries(requireRecord(path, "families", root.families)).map(([key, value]): [string, string[]] => [key, strings(path, `families.${key}`, value)]));
  const precedence = strings(path, "precedence", root.precedence);
  if (precedence.length === 0 || precedence.length !== Object.keys(families).length || precedence.some((key): boolean => !Object.hasOwn(families, key))) throw new SchemaError(path, "precedence", "must list every family exactly once");
  const jobs = Object.values(families).flat();
  if (new Set(jobs).size !== jobs.length) throw new SchemaError(path, "families", "a job belongs to more than one family");
  const variants = Object.fromEntries(Object.entries(requireRecord(path, "variants", root.variants)).map(([key, value]): [string, string[]] => {
    const cell = strings(path, `variants.${key}`, value);
    if (!/^[^.]+\.[^.]+$/.test(key) || !Object.hasOwn(families, key.split(".")[1] as string)) throw new SchemaError(path, `variants.${key}`, "expected <kind>.<declared-family>");
    for (const id of cell) if (!sections.some((entry): boolean => entry.id === id)) throw new SchemaError(path, `variants.${key}`, `unknown reader section '${id}'`);
    return [key, cell];
  }));
  if (!Number.isSafeInteger(root.max) || (root.max as number) < 1) throw new SchemaError(path, "max", "expected a positive safe integer");
  return { sections, footer, families, precedence, variants, max: root.max as number };
}
function escapeRegex(value: string): string { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

export function resolveSections(catalogue: SectionCatalogue, kind: string, family: string, withFacts: readonly string[], overrides?: unknown): {
  contract: typeof SECTIONS_CONTRACT; kind: string; family: string; cell: string; overridden: boolean;
  sections: readonly { id: string; title: string; level: number }[]; footer: readonly { id: string; title: string; level: number }[];
  requirements: readonly BodyRequirement[]; max: number;
} {
  const cell = `${kind}.${family}`;
  let selected = catalogue.variants[cell];
  let overridden = false;
  let max = catalogue.max;
  if (overrides !== undefined) {
    const workflow = requireRecord("overrides", "$", overrides);
    const pr = workflow.pr === undefined ? {} : requireRecord("overrides", "pr", workflow.pr);
    if (pr.sections !== undefined) {
      const config = requireRecord("overrides", "pr.sections", pr.sections);
      const nested = Object.hasOwn(config, "variants") || Object.hasOwn(config, "max");
      if (nested) {
        for (const key of Object.keys(config)) {
          if (!key.startsWith("$") && key !== "max" && key !== "variants") throw new SchemaError("overrides", `pr.sections.${key}`, "unknown override envelope key; put cells under variants");
        }
        if (Object.hasOwn(config, "max")) {
          if (!Number.isSafeInteger(config.max) || (config.max as number) < 1 || (config.max as number) > catalogue.max) throw new SchemaError("overrides", "pr.sections.max", `expected a positive safe integer no greater than catalogue max ${catalogue.max}`);
          max = config.max as number;
        }
      }
      const pointer = nested ? "pr.sections.variants" : "pr.sections";
      const cells = nested ? (Object.hasOwn(config, "variants") ? requireRecord("overrides", pointer, config.variants) : {}) : config;
      // Validate every overridden cell, including cells not selected this run.
      for (const [key, value] of Object.entries(cells)) {
        if (key.startsWith("$")) continue;
        if (!Object.hasOwn(catalogue.variants, key)) throw new SchemaError("overrides", `${pointer}.${key}`, "unknown catalogue cell");
        const ids = strings("overrides", `${pointer}.${key}`, value);
        for (const id of ids) if (!catalogue.sections.some((row): boolean => row.id === id)) throw new SchemaError("overrides", `${pointer}.${key}`, `unknown reader section '${id}'`);
        if (key === cell) { selected = ids; overridden = true; }
      }
    }
  }
  if (selected === undefined) throw new SchemaError("catalogue", `variants.${cell}`, "no declared cell");
  for (const fact of withFacts) if (!catalogue.sections.some((row): boolean => row.when === fact) && !catalogue.footer.some((row): boolean => row.when === fact)) throw new SchemaError("catalogue", "--with", `unknown run fact '${fact}'`);
  const admitted = (row: Section): boolean => row.when === undefined || withFacts.includes(row.when);
  const readers = selected.map((id): Section => catalogue.sections.find((row): boolean => row.id === id) as Section).filter(admitted);
  // Conditional sections absent from the cell append in catalogue order.
  for (const row of catalogue.sections) if (row.when !== undefined && withFacts.includes(row.when) && !readers.includes(row)) readers.push(row);
  if (readers.length > max) throw new SchemaError("catalogue", `variants.${cell}`, `cell '${cell}' has ${readers.length} reader sections, over max ${max}`);
  const footer = catalogue.footer.filter(admitted);
  const resolved = (row: Section): { id: string; title: string; level: number } => {
    const title = typeof row.title === "string" ? row.title : row.title[kind];
    if (title === undefined || title.length === 0) throw new SchemaError("catalogue", row.id, `no title for kind '${kind}'`);
    return { id: row.id, title, level: row.level };
  };
  const requirements = [...readers, ...footer].map((row): BodyRequirement => ({ name: row.id, pattern: row.pattern ?? `^ {0,3}${"#".repeat(row.level)}[ \\t]+${escapeRegex(resolved(row).title)}[ \\t]*$` }));
  return { contract: SECTIONS_CONTRACT, kind, family, cell, overridden, sections: readers.map(resolved), footer: footer.map(resolved), requirements, max };
}

export function sectionFamily(catalogue: SectionCatalogue, taxonomy: ClassifyTaxonomy, jobs: readonly string[]): { contract: typeof SECTIONS_CONTRACT; family: string; counts: Readonly<Record<string, number>>; tied: readonly string[]; rule: string } {
  if (jobs.length === 0) throw new SchemaError("--jobs", null, "expected at least one job");
  const known = new Set(taxonomy.axes.job.keys.map((row): string => row.key));
  const counts = Object.fromEntries(catalogue.precedence.map((key): [string, number] => [key, 0]));
  for (const job of new Set(jobs)) {
    if (!known.has(job)) throw new SchemaError(taxonomy.path, "--jobs", `unknown job '${job}'`);
    const family = catalogue.precedence.find((key): boolean => catalogue.families[key]?.includes(job) === true);
    if (family === undefined) throw new SchemaError("catalogue", "families", `job '${job}' has no family`);
    counts[family] = (counts[family] ?? 0) + 1;
  }
  const most = Math.max(...Object.values(counts));
  const tied = catalogue.precedence.filter((key): boolean => counts[key] === most);
  return { contract: SECTIONS_CONTRACT, family: tied[0] as string, counts, tied, rule: tied.length > 1 ? `tie broken by catalogue precedence: ${catalogue.precedence.join(" > ")}` : "most jobs wins" };
}
