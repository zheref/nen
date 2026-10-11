// src/schema/declarations.test.ts -- the `$`-metadata guarantee, held per file
// (zheref/nen#338), and each row's `validate` held to its loader's verdict.
//
// THE GUARANTEE (./declarations.ts's header): a `$`-prefixed key, at any level
// of any declaration file, never fails validation and is never read as data.
// Proved two ways for every file a loader reads:
//
//   1. ./fixtures/metadata-repo/ carries a `$` key in EVERY object of every
//      file -- one named after the object's own first key (a near miss, the
//      shape a typo-guard could mistake for a misspelling) and a `$note` of a
//      different JSON type each time. It must load, and load to the SAME model
//      as a copy with every `$` key stripped.
//   2. The same injection, done here, over the other fixture repositories and
//      nen's own `nen/`, so the proof does not rest on one hand-picked file.
//
// A loader that starts reading a `$` key -- or refusing one -- turns this red.

import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DECLARATIONS, declarationFor, isMetadataKey, type Declaration } from "./declarations.js";
import { CONTRACT_FILE, DECISIONS_FILE } from "./source.js";
import { WORKFLOW_FILE } from "./workflow.js";
import { ALT_REPO, BANKAI_REPO, SHU_REPO } from "./fixtures/paths.js";

const METADATA_REPO = join(process.cwd(), "src", "schema", "fixtures", "metadata-repo");
const NEN_OWN = process.cwd();

const temps: string[] = [];
afterEach((): void => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempRoot(): string {
  const dir = mkdtempSync(join(tmpdir(), "nen-decl-"));
  temps.push(dir);
  mkdirSync(join(dir, "nen"));
  return dir;
}

/** The JSON value with every `$`-prefixed key removed, at every level. */
function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value === null || typeof value !== "object") return value;
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (!isMetadataKey(key)) out[key] = strip(item);
  }
  return out;
}

const NOTES: readonly unknown[] = ["an annotation", 7, true, null, { nested: ["x"], $deeper: 1 }, ["a", 2]];

/** The JSON value with a near-miss `$<first key>` and a `$note` added to every object. */
function inject(value: unknown, counter = { n: 0 }): unknown {
  if (Array.isArray(value)) return value.map((item): unknown => inject(item, counter));
  if (value === null || typeof value !== "object") return value;
  const entries = Object.entries(value as Record<string, unknown>);
  const first = entries.find(([key]): boolean => !isMetadataKey(key))?.[0];
  const out: Record<string, unknown> = {};
  if (first !== undefined) out[`$${first}`] = `metadata named after '${first}'`;
  for (const [key, item] of entries) out[key] = isMetadataKey(key) ? item : inject(item, counter);
  out["$note"] = NOTES[counter.n % NOTES.length];
  counter.n += 1;
  return out;
}

/** Every object in `value` carries at least one `$` key -- the fixture is as dense as it claims. */
function everyObjectAnnotated(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(everyObjectAnnotated);
  if (value === null || typeof value !== "object") return true;
  const entries = Object.entries(value as Record<string, unknown>);
  return (
    entries.some(([key]): boolean => isMetadataKey(key)) &&
    entries.every(([key, item]): boolean => isMetadataKey(key) || everyObjectAnnotated(item))
  );
}

/**
 * A model as data, comparable across two roots: functions dropped, RegExp,
 * Map and Set spelled out, every `raw` (the file's own preserved form, which
 * carries `$` keys by design) and every `path` dropped, and the root replaced.
 */
function canon(value: unknown, file: string, at: readonly string[] = []): unknown {
  const down = (key: string, item: unknown): unknown => canon(item, file, [...at, key]);
  if (value instanceof RegExp) return `/${value.source}/${value.flags}`;
  if (value instanceof Map) return [...value.entries()].map(([key, item]): unknown => [key, down(String(key), item)]);
  if (value instanceof Set) return [...value].map((item): unknown => down("*", item));
  if (Array.isArray(value)) return value.map((item, index): unknown => down(String(index), item));
  if (typeof value === "function") return undefined;
  if (value === null || typeof value !== "object") return value;
  // A BLOCK THE LOADER KEEPS VERBATIM AND NO VERB READS carries its `$` keys
  // with it, exactly as `raw` does: compared with them stripped.
  if (VERBATIM.some((pattern): boolean => matches(pattern, file, at))) return strip(value);
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    if (key === "raw" || key === "path") continue;
    // THE DOCUMENTED ECHO: a string `$schema` at the root of nen/contract.json
    // or nen/workflow.json is surfaced as the model's `schema` -- metadata
    // about the document, never a value a verb acts on. Asserted on its own.
    if (ECHOES_SCHEMA.includes(file) && at.length === 0 && key === "schema") continue;
    out[key] = down(key, item);
  }
  return out;
}

const ECHOES_SCHEMA: readonly string[] = [CONTRACT_FILE, WORKFLOW_FILE];

/** The unread blocks a loader keeps verbatim, as `<file>` + a path whose `*` matches any one step. */
const VERBATIM: readonly (readonly [string, readonly string[]])[] = [
  [CONTRACT_FILE, ["project", "profiles"]],
  [DECISIONS_FILE, ["rows", "*", "surfaces", "*"]],
];

function matches([file, pattern]: readonly [string, readonly string[]], actual: string, at: readonly string[]): boolean {
  return file === actual && pattern.length === at.length && pattern.every((step, index): boolean => step === "*" || step === at[index]);
}

function model(row: Declaration, root: string): string {
  return JSON.stringify(canon(row.load(root), row.file)).split(root).join("<root>");
}

/** The file's text with every `$` key removed: JSON re-serialised, YAML by its `$` lines. */
function strippedText(row: Declaration, text: string): string {
  if (row.format === "json") return `${JSON.stringify(strip(JSON.parse(text)), null, 2)}\n`;
  return text
    .split("\n")
    .filter((line): boolean => !/^\s*\$/.test(line))
    .join("\n");
}

describe("the $-metadata guarantee -- one fixture per declaration file", () => {
  it("covers every declaration file a loader reads, and nothing else", () => {
    expect(DECLARATIONS.map((row): string => row.file).sort()).toEqual([
      "nen/colors.yml",
      "nen/contract.json",
      "nen/decisions.json",
      "nen/gates.json",
      "nen/labels.json",
      "nen/repos.json",
      "nen/workflow.json",
    ]);
    for (const row of DECLARATIONS) {
      expect(existsSync(join(METADATA_REPO, ...row.file.split("/"))), row.file).toBe(true);
      expect(declarationFor(row.file)).toBe(row);
    }
    expect(declarationFor("nen/other.json")).toBeUndefined();
  });

  for (const row of DECLARATIONS) {
    describe(row.file, () => {
      const text = readFileSync(join(METADATA_REPO, ...row.file.split("/")), "utf8");

      if (row.format === "json") {
        it("carries a $ key in every object (the fixture is as dense as it says)", () => {
          expect(everyObjectAnnotated(JSON.parse(text))).toBe(true);
        });
      } else {
        it("carries a $ key at the root, in categories, in a category, in values and in a value", () => {
          const dollars = text.split("\n").filter((line): boolean => /^\s*\$/.test(line));
          expect(new Set(dollars.map((line): number => line.length - line.trimStart().length))).toEqual(new Set([0, 2, 4, 6, 8]));
        });
      }

      it("validates: no $ key fails the loader", () => {
        expect((): unknown => row.load(METADATA_REPO)).not.toThrow();
        expect((): unknown => row.validate(join(METADATA_REPO, ...row.file.split("/")), text)).not.toThrow();
      });

      it("is ignored: the model equals the model of the same file with every $ key stripped", () => {
        const root = tempRoot();
        writeFileSync(join(root, ...row.file.split("/")), strippedText(row, text));
        const stripped = model(row, root);
        expect(stripped).not.toBe("{}");
        expect(model(row, METADATA_REPO)).toBe(stripped);
      });
    });
  }

  it("nen/contract.json and nen/workflow.json echo a string $schema as metadata and nothing else", () => {
    expect((declarationFor(CONTRACT_FILE)?.load(METADATA_REPO) as { schema: string | null }).schema).toBe("nen.contract/v0.1");
    expect((declarationFor(WORKFLOW_FILE)?.load(METADATA_REPO) as { schema: string | null }).schema).toBe("nen.workflow/v0.1");
  });

  it("colour vocabulary: no $ key becomes a category, a value or an extra field", () => {
    const row = declarationFor("nen/colors.yml");
    const loaded = row?.load(METADATA_REPO) as { categories: { name: string; values: { name: string; extra: Record<string, unknown> }[] }[] };
    for (const category of loaded.categories) {
      expect(isMetadataKey(category.name)).toBe(false);
      for (const value of category.values) {
        expect(isMetadataKey(value.name)).toBe(false);
        expect(Object.keys(value.extra).filter(isMetadataKey)).toEqual([]);
      }
    }
  });
});

describe("the $-metadata guarantee -- injected into every other declaration nen has a fixture for", () => {
  const sources: readonly [string, string][] = [
    ["bankai-repo", BANKAI_REPO],
    ["alt-repo", ALT_REPO],
    ["shu-repo", SHU_REPO],
    ["nen's own nen/", NEN_OWN],
  ];
  for (const [name, source] of sources) {
    for (const row of DECLARATIONS.filter((entry): boolean => entry.format === "json")) {
      const path = join(source, ...row.file.split("/"));
      if (!existsSync(path)) continue;
      it(`${name} ${row.file}: a $ key in every object changes nothing`, () => {
        const original = tempRoot();
        const annotated = tempRoot();
        const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
        writeFileSync(join(original, ...row.file.split("/")), `${JSON.stringify(strip(value), null, 2)}\n`);
        writeFileSync(join(annotated, ...row.file.split("/")), `${JSON.stringify(inject(value), null, 2)}\n`);
        expect(model(row, annotated)).toBe(model(row, original));
      });
    }
  }
});

describe("each row's validate is its loader's verdict", () => {
  for (const row of DECLARATIONS) {
    it(`${row.file}: the same model on a valid file, the same refusal on a broken one`, () => {
      const root = tempRoot();
      const target = join(root, ...row.file.split("/"));
      const path = join(METADATA_REPO, ...row.file.split("/"));
      const text = readFileSync(path, "utf8");
      writeFileSync(target, text);
      expect(JSON.stringify(canon(row.validate(target, text), row.file))).toBe(JSON.stringify(canon(row.load(root), row.file)));

      const broken = row.format === "json" ? "{ not json" : "categories: [";
      writeFileSync(target, broken);
      let fromLoader = "";
      let fromValidate = "";
      try {
        row.load(root);
      } catch (error) {
        fromLoader = error instanceof Error ? error.message : String(error);
      }
      try {
        row.validate(target, broken);
      } catch (error) {
        fromValidate = error instanceof Error ? error.message : String(error);
      }
      expect(fromLoader).not.toBe("");
      expect(fromValidate).toBe(fromLoader);

      const wrong = row.format === "json" ? "[]\n" : "- a\n";
      writeFileSync(target, wrong);
      let shapeLoader = "";
      let shapeValidate = "";
      try {
        row.load(root);
      } catch (error) {
        shapeLoader = error instanceof Error ? error.message : String(error);
      }
      try {
        row.validate(target, wrong);
      } catch (error) {
        shapeValidate = error instanceof Error ? error.message : String(error);
      }
      expect(shapeLoader).not.toBe("");
      expect(shapeValidate).toBe(shapeLoader);
    });
  }
});
