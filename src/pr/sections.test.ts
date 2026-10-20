import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSectionCatalogue, resolveSections, sectionFamily } from "./sections.js";
import { checkBody } from "./bodycheck.js";
import { parseClassifyTaxonomy } from "../classify/taxonomy.js";
import { runFamily } from "../index.js";
import { prCommand } from "./command.js";
import { ScriptedSeams } from "../seam/scripted.js";

const catalogue = {
  sections: [
    { id: "changes", title: "✨ Changes", level: 1 },
    { id: "why", title: "Why" }, { id: "how", title: "How" },
    { id: "improves", title: "Improvements" },
    { id: "verify", title: { process: "Guards", library: "Consumer" } },
    { id: "across", title: "Across" },
    { id: "economics", title: "Economics", when: "economics" },
  ],
  footer: [{ id: "attribution", title: "Attribution" }],
  families: { maintain: ["build"], canon: ["test"] },
  precedence: ["maintain", "canon"],
  variants: { "process.canon": ["changes", "why", "how", "improves", "verify", "across"], "library.canon": ["changes", "verify"] },
  max: 7,
};
const parse = (raw: unknown = catalogue): ReturnType<typeof parseSectionCatalogue> => parseSectionCatalogue("catalogue.json", raw);
const taxonomy = parseClassifyTaxonomy("taxonomy.json", JSON.parse(readFileSync("src/classify/fixtures/mini.taxonomy.json", "utf8")) as unknown);
const dirs: string[] = [];
afterEach((): void => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });

describe("caller-owned PR section catalogue", () => {
  it("resolves six readers, a footer outside the cap, and consumable requirements", () => {
    const report = resolveSections(parse(), "process", "canon", []);
    expect(report.sections.map((row): string => row.id)).toEqual(catalogue.variants["process.canon"]);
    const body = [...report.sections, ...report.footer].map((row): string => `${"#".repeat(row.level)} ${row.title}\ncontent`).join("\n");
    expect(checkBody(body, report.requirements, { exact: true }).ok).toBe(true);
    const extra = resolveSections(parse(), "process", "canon", ["economics"]);
    expect(extra.sections.at(-1)?.id).toBe("economics");
    expect(extra.footer).toHaveLength(1);
    expect(resolveSections(parse(), "library", "canon", []).sections[1]?.title).toBe("Consumer");
  });
  it("validates ids in every cell, unique ids/jobs and complete precedence", () => {
    expect(() => parse({ ...catalogue, variants: { "process.canon": ["missing"] } })).toThrow(/unknown reader section 'missing'/);
    expect(() => parse({ ...catalogue, footer: [catalogue.sections[0]] })).toThrow(/unique/);
    expect(() => parse({ ...catalogue, families: { maintain: ["build"], canon: ["build"] } })).toThrow(/more than one family/);
    expect(() => parse({ ...catalogue, precedence: ["canon"] })).toThrow(/every family/);
    expect(() => parse({ ...catalogue, max: 0 })).toThrow(/positive/);
    expect(() => parse({ ...catalogue, sections: [{ id: "bad", title: "Bad", pattern: "(" }] })).toThrow(/regular expression/);
  });
  it("names an over-cap cell, even when a conditional addition caused it", () => {
    expect(() => resolveSections(parse({ ...catalogue, max: 5 }), "process", "canon", [])).toThrow(/process.canon.*6.*max 5/);
    expect(() => resolveSections(parse({ ...catalogue, max: 6 }), "process", "canon", ["economics"])).toThrow(/process.canon.*7.*max 6/);
  });
  it("reads overrides, validates unselected overrides and refuses unknown cells/facts", () => {
    const report = resolveSections(parse(), "process", "canon", [], { pr: { sections: { "process.canon": ["changes", "verify"] } } });
    expect(report.overridden).toBe(true);
    expect(report.sections).toHaveLength(2);
    expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { "library.canon": ["absent"] } } })).toThrow(/unknown reader/);
    expect(() => resolveSections(parse(), "unknown", "canon", [])).toThrow(/no declared cell/);
    expect(() => resolveSections(parse(), "process", "canon", ["typo"])).toThrow(/unknown run fact/);
    expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { "missing.canon": [] } } })).toThrow(/unknown catalogue cell/);
  });
  it("counts distinct known jobs and declares the tie rule", () => {
    expect(sectionFamily(parse(), taxonomy, ["build", "build"]).counts.maintain).toBe(1);
    const report = sectionFamily(parse(), taxonomy, ["build", "test"]);
    expect(report.family).toBe("maintain");
    expect(report.rule).toContain("tie broken by catalogue precedence");
    expect(() => sectionFamily(parse(), taxonomy, ["missing"])).toThrow(/unknown job/);
    expect(() => sectionFamily(parse(), taxonomy, [])).toThrow(/at least one/);
    expect(() => sectionFamily(parse({ ...catalogue, families: { maintain: [], canon: [] } }), taxonomy, ["build"])).toThrow(/no family/);
  });
  it("resolves the full consumer envelope identically with and without provenance", () => {
    const sections = { max: 3, variants: { "process.canon": ["changes", "verify"] } };
    const unstamped = resolveSections(parse(), "process", "canon", [], { pr: { sections } });
    const stamped = resolveSections(parse(), "process", "canon", [], { pr: { sections: { ...sections, $canon: { contract: "hatsu.pr-sections/v1", sha256: "f".repeat(64) }, $comment: "metadata" }, $sections: "options" } });
    expect(stamped).toEqual(unstamped);
    expect(stamped.max).toBe(3);
    expect(stamped.overridden).toBe(true);
    expect(stamped.sections.map((row): string => row.id)).toEqual(["changes", "verify"]);
    expect(resolveSections(parse(), "process", "canon", ["economics"], { pr: { sections } }).sections).toHaveLength(3);
    expect(() => resolveSections(parse(), "process", "canon", ["economics"], { pr: { sections: { ...sections, max: 2 } } })).toThrow(/process.canon.*3.*max 2/);
    expect(resolveSections(parse(), "library", "canon", [], { pr: { sections: { max: 2 } } }).overridden).toBe(false);
    expect(resolveSections(parse(), "process", "canon", [], { pr: { sections: { variants: sections.variants } } }).max).toBe(7);
  });
  it("validates nested caps and all nested cells at their actual pointers", () => {
    for (const max of [0, -1, 1.5, "3", null, 8, Number.MAX_SAFE_INTEGER + 1]) {
      expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { max } } })).toThrow(/pr.sections.max/);
    }
    for (const variants of [null, [], "bad"]) {
      expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { variants } } })).toThrow(/pr.sections.variants/);
    }
    expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { variants: { "library.canon": ["absent"] } } } })).toThrow(/pr.sections.variants.library.canon.*unknown reader/);
    expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { variants: { "missing.canon": [] } } } })).toThrow(/pr.sections.variants.missing.canon.*unknown catalogue cell/);
    expect(() => resolveSections(parse(), "process", "canon", [], { pr: { sections: { max: 7, "process.canon": ["changes"] } } })).toThrow(/pr.sections.process.canon.*put cells under variants/);
    expect(resolveSections(parse(), "library", "canon", [], { pr: { sections: { $canon: {}, "library.canon": ["verify"] } } }).sections).toHaveLength(1);
  });
  it("wires both actions through the real dispatcher without network calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-sections-")); dirs.push(dir);
    const file = join(dir, "catalogue.json"); writeFileSync(file, JSON.stringify(catalogue));
    const capture = async (args: string[]): Promise<{ code: number; out: string[]; err: string[] }> => {
      const out: string[] = []; const err: string[] = [];
      const code = await runFamily(prCommand, args, process.cwd(), false, { out: (line): void => { out.push(line); }, err: (line): void => { err.push(line); } }, new ScriptedSeams([]));
      return { code, out, err };
    };
    const result = await capture(["pr", "sections", "resolve", "--catalogue", file, "--kind", "process", "--family", "canon", "--json"]);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out.join("\n"))).toMatchObject({ contract: "nen.pr.sections/v0.1", cell: "process.canon" });
    const workflow = join(dir, "workflow.json");
    writeFileSync(workflow, JSON.stringify({ pr: { sections: { max: 2, variants: { "process.canon": ["changes", "verify"] }, $canon: { sha256: "stamp" } } } }));
    const overridden = await capture(["pr", "sections", "resolve", "--catalogue", file, "--kind", "process", "--family", "canon", "--overrides", workflow, "--json"]);
    expect(overridden.code).toBe(0);
    expect(JSON.parse(overridden.out.join("\n"))).toMatchObject({ max: 2, overridden: true, sections: [{ id: "changes" }, { id: "verify" }] });
    const family = await capture(["pr", "sections", "family", "--catalogue", file, "--taxonomy", "src/classify/fixtures/mini.taxonomy.json", "--jobs", "build,test"]);
    expect(family.code).toBe(0); expect(family.out.join("\n")).toContain("tie broken");
    expect((await capture(["pr", "sections", "nope", "--catalogue", file])).code).toBe(2);
    expect((await capture(["pr", "sections", "resolve", "--catalogue", file, "--jobs", "build"])).code).toBe(2);
  });
});
