import { describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runFamily } from "../index.js";
import { defaultSeams, type Seams } from "../seam/exec.js";
import { checkTaxonomy } from "../schema/taxonomy.js";
import { loadContract } from "../schema/contract.js";
import { detect } from "../shu/detect.js";
import { scaffoldCommand } from "./command.js";
import { scaffoldMigrate } from "./migrate.js";
import { scaffoldHookOnly, scaffoldInit } from "./init.js";
import { executeNative } from "./native-exec.js";
import { scaffoldNew } from "./new.js";

const hook = { agentTrailer: "Fixture-Agent", runTrailer: null, markerEnvVar: "FIXTURE_AUTOMATED" };
const temp = (): string => mkdtempSync(join(tmpdir(), "nen-consumer-"));
const noSpawn = (): Seams => ({ ...defaultSeams(), run: (): never => { throw new Error("unexpected spawn"); }, platform: "linux", env: {} });
const policy = (root: string): void => { mkdirSync(join(root, "nen")); writeFileSync(join(root, "nen", "workflow.json"), JSON.stringify({ $schema: "nen.workflow/v0.1", commits: { allowedAttributionTrailers: ["Fixture-Agent"] } })); };

describe("confirmed documentation scaffolding", () => {
  it("proposes a Markdown-only tree, but init still requires confirmation", () => {
    const root = temp(); writeFileSync(join(root, "README.md"), "# Notes\n");
    mkdirSync(join(root, "nen"));
    writeFileSync(join(root, "nen", "labels.json"), JSON.stringify({ labels: [{ name: "fixture", color: "aabbcc", description: "Synthetic fixture" }] }));
    writeFileSync(join(root, "nen", "repos.json"), JSON.stringify({ consumers: [], product_codes: { FX: "example/fixture" } }));
    scaffoldMigrate({ root, dryRun: false });
    expect(detect(root, "linux").lanes.map(lane => lane.stack)).toEqual(["prose"]);
    expect(() => scaffoldInit({ root, platform: "linux", directories: [], hook })).toThrow(/stack/);
    const result = scaffoldInit({ root, platform: "linux", directories: [], hook, stack: "prose" });
    expect(result.exitCode).toBe(0);
    const contract = JSON.parse(readFileSync(join(root, "nen", "contract.json"), "utf8"));
    expect(contract.project.kind).toBeUndefined();
    const verbs = Object.values(contract.project.verbs)[0] as Record<string, { unsupported?: string }>;
    expect(Object.values(verbs).every(row => typeof row.unsupported === "string")).toBe(true);
    expect(loadContract(root).project).not.toBeNull();
    expect(checkTaxonomy({ repoFlag: root }).checks.filter(row => !row.ok)).toEqual([]);
    const ci = readFileSync(join(root, ".github", "workflows", "nen-shu.yml"), "utf8");
    expect(ci).toContain("pull_request:"); expect(ci).toContain("for verb in lint;"); expect(ci).not.toContain("for verb in build test lint;");
  });
  it("uses only the caller's explicit lint argv", () => {
    const root = temp(); writeFileSync(join(root, "README.md"), "# Notes\n");
    scaffoldInit({ root, platform: "linux", directories: [], hook, stack: "prose", lintArgv: ["node", "lint.mjs"] });
    const contract = loadContract(root);
    const raw = JSON.parse(readFileSync(join(root, "nen", "contract.json"), "utf8"));
    expect(Object.values(raw.project.verbs).map((verbs) => (verbs as Record<string, unknown>).lint)).toEqual([{ exe: "node", argv: ["lint.mjs"] }]);
    expect(contract.project).not.toBeNull();
  });
  it("does not propose documentation when a build marker or non-Markdown file exists", () => {
    const root = temp(); writeFileSync(join(root, "README.md"), "# Notes\n"); writeFileSync(join(root, "payload.txt"), "data");
    expect(detect(root, "linux").lanes).toEqual([]);
    mkdirSync(join(root, "handbooks")); writeFileSync(join(root, "handbooks", "INDEX.md"), "# Index\n");
    expect(detect(root, "linux").lanes.map(lane => lane.stack)).toEqual(["prose"]);
    writeFileSync(join(root, "build.gradle.kts"), "plugins { id(\"com.android.application\") }\n");
    expect(detect(root, "linux").lanes.some(lane => lane.stack === "prose")).toBe(false);
  });
});

describe("hook-only existing policy", () => {
  it("requires existing policy, creates no lane and refuses a missing declared trailer", () => {
    const root = temp(); expect(() => scaffoldHookOnly({ root, hook })).toThrow(/existing/); policy(root);
    expect(scaffoldHookOnly({ root, hook }).exitCode).toBe(0);
    expect(readdirSync(join(root, "nen"))).toEqual(["workflow.json"]);
    expect(existsSync(join(root, ".github"))).toBe(false);
    if (process.platform !== "win32") {
      const message = join(root, "message"); writeFileSync(message, "fix: fixture\n");
      const result = defaultSeams().run("sh", [join(root, ".git", "hooks", "commit-msg"), message], { cwd: root, env: { FIXTURE_AUTOMATED: "1" } });
      expect(result.code).not.toBe(0);
      writeFileSync(message, "fix: fixture\n\nFixture-Agent: synthetic\n");
      expect(defaultSeams().run("sh", [join(root, ".git", "hooks", "commit-msg"), message], { cwd: root, env: { FIXTURE_AUTOMATED: "1" } }).code).toBe(0);
    }
  });
  it.skipIf(process.platform === "win32")("refuses hook, parent and backup symlinks without outside writes", () => {
    for (const kind of ["hook", "parent", "backup"]) {
      const root = temp(); policy(root); const outside = temp(); const target = join(outside, "guard"); writeFileSync(target, "outside sentinel\n");
      if (kind === "parent") symlinkSync(outside, join(root, "redirect"));
      else symlinkSync(target, join(root, kind === "hook" ? "guard" : "guard.bak"));
      expect(() => scaffoldHookOnly({ root, hook, hookPath: kind === "parent" ? "redirect/guard" : "guard", force: true })).toThrow(/redirected|symlink/);
      expect(readFileSync(target, "utf8")).toBe("outside sentinel\n");
    }
  });
  it("backs up only with force, and dry-run creates nothing", () => {
    const root = temp(); policy(root); const path = join(root, "custom-hook"); writeFileSync(path, "foreign\n");
    expect(scaffoldHookOnly({ root, hook, hookPath: "custom-hook" }).exitCode).not.toBe(0);
    expect(readFileSync(path, "utf8")).toBe("foreign\n");
    expect(scaffoldHookOnly({ root, hook, hookPath: "custom-hook", force: true, dryRun: true }).writes[0]?.action).toBe("would-create");
    expect(existsSync(path + ".bak")).toBe(false);
    expect(scaffoldHookOnly({ root, hook, hookPath: "custom-hook", force: true }).exitCode).toBe(0);
    expect(readFileSync(path + ".bak", "utf8")).toBe("foreign\n");
  });
});

describe("declared native handoffs", () => {
  it.each(["gradle-android", "xcode-ios", "compose-desktop", "dotnet-winui"])("plans %s without a marker or process", (stack) => {
    const dir = join(temp(), "new-project");
    const result = scaffoldNew({ stack, name: "Fixture", dir, platform: "linux", dryRun: true });
    expect(result.path).toBe("native-handoff"); expect(result.writes).toEqual([]); expect(result.postSteps).toHaveLength(2);
    expect(result.postSteps[1]).toContain("scaffold init");
    expect(result.postSteps[0]).toContain(dir); expect(existsSync(dir)).toBe(false);
  });
  it("probes capabilities then runs only explicitly selected Android generator", () => {
    const calls: string[][] = []; const dir = join(temp(), "project");
    const seams: Seams = { ...noSpawn(), run: (exe, args) => { calls.push([exe, ...args]); return { code: 0, stdout: "--name --output", stderr: "", spawnFailed: false }; } };
    const result = scaffoldNew({ stack: "gradle-android", name: "Fixture", dir, platform: "linux", runNative: true });
    expect(result.nativeExecution).toBeDefined();
    expect(executeNative(result.nativeExecution!, seams).exitCode).toBe(0); expect(calls).toEqual([["android", "create", "--help"], ["android", "create", "--name=Fixture", `--output=${dir}`, "empty-activity-compose"]]);
    expect(existsSync(join(dir, "nen"))).toBe(false);
  });
  it("refuses missing tools, incompatible hosts and manual execution", () => {
    const dir = join(temp(), "project");
    const seams: Seams = { ...noSpawn(), run: () => ({ code: 127, stdout: "", stderr: "", spawnFailed: true }) };
    expect(executeNative(scaffoldNew({ stack: "gradle-android", name: "Fixture", dir, platform: "linux", runNative: true }).nativeExecution!, seams).exitCode).toBe(5);
    expect(scaffoldNew({ stack: "dotnet-winui", name: "Fixture", dir, platform: "linux", runNative: true }).exitCode).toBe(3);
    expect(() => scaffoldNew({ stack: "xcode-ios", name: "Fixture", dir, platform: "darwin", runNative: true })).toThrow(/manual/);
  });
  it("exposes native path and ordered steps through the public JSON command", async () => {
    const out: string[] = []; const err: string[] = []; const dir = join(temp(), "project");
    const code = await runFamily(scaffoldCommand, ["scaffold", "new", "--stack", "compose-desktop", "--name", "Fixture", "--dir", dir, "--dry-run", "--json"], null, true, { out: line => out.push(line), err: line => err.push(line) }, noSpawn());
    expect(code, err.join("\n")).toBe(0); expect(JSON.parse(out.join("\n"))).toMatchObject({ path: "native-handoff", writes: [], postSteps: expect.any(Array) });
  });
});
