import { afterAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { ScriptedSeams } from "../seam/scripted.js";
import { gateCommand } from "./command.js";
const root = mkdtempSync(join(tmpdir(), "nen-gate-declaration-")); afterAll(() => rmSync(root, { recursive: true, force: true }));
async function run(extra: string[], files = ["--files", "src/a.ts"]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await runFamily(gateCommand, ["gate", "derive", ...files, ...extra], root, true, { out: (line) => { out.push(line); }, err: (line) => { err.push(line); } }, new ScriptedSeams([]));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
describe("caller-declared gate path sets (#603)", () => {
  it("reads one declared row directly and refuses absent/inherited/malformed rows", async () => {
    writeFileSync(join(root, "paths.json"), JSON.stringify({ gateDerive: { "o/n": { policyPaths: ["nen/"], processPaths: ["src/"] }, malformed: { policyPaths: "src/", processPaths: [] } } }));
    const good = await run(["--paths-from", "paths.json", "--row", "o/n"]); expect(good.code, good.err).toBe(0); expect(JSON.parse(good.out).gate).toBe("G4");
    for (const row of ["missing", "constructor", "malformed"]) expect((await run(["--paths-from", "paths.json", "--row", row])).code).toBe(2);
    expect((await run(["--paths-from", "paths.json", "--row", "o/n", "--policy-paths", "src/"])).code).toBe(2);
  });
  it("preserves declared array members containing commas instead of hand-joining them", async () => {
    writeFileSync(join(root, "commas.json"), JSON.stringify({ gateDerive: { "o/n": { policyPaths: ["policy,comma.md"], processPaths: ["src/"] } } }));
    writeFileSync(join(root, "changed.txt"), "policy,comma.md\n");
    const result = await run(["--paths-from", "commas.json", "--row", "o/n"], ["--files-from", "changed.txt"]);
    expect(result.code, result.err).toBe(0); expect(JSON.parse(result.out).gate).toBe("G4");
  });
  it("keeps the absent-policy refusal unchanged and corrects the repo help", async () => {
    const absent = await run([]); expect(absent.code).toBe(2); expect(absent.err).toContain("--policy-paths is required. An absent flag would silently contribute zero hits");
    expect(gateCommand.usage).not.toContain("nen/gates.json supplies"); expect(gateCommand.usage).toContain("supplies no implicit path sets");
  });
});
