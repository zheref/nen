import { classifyCommand } from "../classify/command.js";
import { describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { REAL_REGISTRY, REAL_TAXONOMY } from "../direct/fixtures/harness.js";
import { loadClassifyTaxonomy, taxonomyLabels } from "../classify/taxonomy.js";
import { canonCommand } from "./command.js";

function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), "nen-canon-check-")); mkdirSync(join(root, "nen"));
  cpSync(REAL_REGISTRY, join(root, "registry.json")); cpSync(REAL_TAXONOMY, join(root, "taxonomy.json"));
  writeFileSync(join(root, "nen", "labels.json"), JSON.stringify({ labels: taxonomyLabels(loadClassifyTaxonomy(root, "taxonomy.json")).map(({ name, color, description }) => ({ name, color, description })) }));
  return root;
}
async function run(root: string, flags: string[] = []): Promise<{ code: number; out: string[]; err: string[]; calls: number }> {
  const out: string[] = []; const err: string[] = []; const seams = new ScriptedSeams([]);
  const code = await runFamily(canonCommand, ["canon", "check", "--registry", "registry.json", "--taxonomy", "taxonomy.json", "--json", ...flags], root, false, { out: (line) => void out.push(line), err: (line) => void err.push(line) }, seams);
  return { code, out, err, calls: seams.calls.length };
}
describe("canon check -- the three read-only contract verdicts", () => {
  it("checks the registry, independent phase coverage and exact label parity with no write/spawn", async () => {
    const root = fixture(); const before = readFileSync(join(root, "nen", "labels.json"), "utf8");
    const result = await run(root); expect(result.code, result.err.join("\n")).toBe(0); expect(result.calls).toBe(0);
    expect(JSON.parse(result.out.join("\n")).checks.map((row: { ok: boolean }) => row.ok)).toEqual([true, true, true]);
    expect(readFileSync(join(root, "nen", "labels.json"), "utf8")).toBe(before);
  });
  it.each(["absent", "drift", "foreign"])("refuses %s declaration parity without rewriting it", async (kind) => {
    const root = fixture(); const path = join(root, "nen", "labels.json"); const doc = JSON.parse(readFileSync(path, "utf8"));
    if (kind === "absent") doc.labels.shift();
    if (kind === "drift") doc.labels[0].color = "ffffff";
    if (kind === "foreign") { const prefix = loadClassifyTaxonomy(root, "taxonomy.json").axes.job.prefix; doc.labels.push({ name: prefix + "unknown-job", color: "ffffff", description: "foreign" }); }
    const bytes = JSON.stringify(doc); writeFileSync(path, bytes); const result = await run(root);
    const install: string[] = [];
    await runFamily(classifyCommand, ["classify", "install", "--taxonomy", "taxonomy.json", "--dry-run", "--json"], root, false, { out: (line) => void install.push(line), err: () => {} }, new ScriptedSeams([]));
    const planned = JSON.parse(install.join("\n"));
    expect(JSON.parse(result.out.join("\n")).parity).toEqual({ entries: planned.entries, foreign: planned.foreign });
    expect(result.code).toBe(1); expect(result.calls).toBe(0); expect(readFileSync(path, "utf8")).toBe(bytes);
  });
  it("reports each invalid contract and refuses missing wiring or write flags", async () => {
    const root = fixture(); writeFileSync(join(root, "registry.json"), "{}");
    expect((await run(root)).code).toBe(1);
    expect((await run(root, ["--write"])).code).toBe(2);
    expect((await run(root, ["--dry-run"])).code).toBe(2);
    const missing = mkdtempSync(join(tmpdir(), "nen-canon-missing-")); expect((await run(missing)).code).toBe(2);
  });
  it.skipIf(process.platform === "win32")("refuses symlinked inputs before parsing them", async () => {
    const root = fixture(); const other = join(root, "alias.json"); symlinkSync(join(root, "registry.json"), other);
    const out: string[] = []; const err: string[] = [];
    expect(await runFamily(canonCommand, ["canon", "check", "--registry", other, "--taxonomy", "taxonomy.json"], root, false, { out: (line) => void out.push(line), err: (line) => void err.push(line) }, new ScriptedSeams([]))).toBe(2);
    expect(out).toEqual([]);
  });
});
