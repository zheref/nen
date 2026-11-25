import { describe, expect, it } from "vitest";
import { mkdirSync, readFileSync, readdirSync, symlinkSync, writeFileSync } from "node:fs";
import { makeTempDir } from "../testing/tempdir.js";
import { join } from "node:path";
import { run } from "../index.js";
import { markerFor, markerText, readMarker } from "./mirror.js";

const temp = (): string => makeTempDir("nen-marker-");
async function invoke(args: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = []; const err: string[] = [];
  const code = await run(["surface", "marker", ...args], { out: (s) => { out.push(s); }, err: (s) => { err.push(s); } });
  return { code, out: out.join("\n"), err: err.join("\n") };
}
async function inspect(text: string): Promise<Awaited<ReturnType<typeof invoke>>> {
  const file = join(temp(), "placed"); writeFileSync(file, text);
  return invoke(["--file", file, "--json"]);
}

describe("surface marker (NN#658)", () => {
  it.each([
    markerFor("codex", "1.2.3"),
    `---\r\nname: demo\r\n---\r\n${markerFor("cursor")}\r\nbody`,
    `# ${markerText("codex")}\n`,
    `#!/bin/sh\r\n# ${markerText("codex")}\r\n`,
    JSON.stringify({ other: true, $generated: markerText("antigravity") }),
    JSON.stringify({ [markerText("antigravity")]: { enabled: true } }),
  ])("reports the existing reader's marker and grammar (AC-1): %s", async (text) => {
    const result = await inspect(text);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.out)).toMatchObject({ generated: true, grammar: "nen-surface-mirror", ...readMarker(text) });
  });
  it.each(["plain", `quoted\n${markerFor("codex")}`, `\n${markerFor("codex")}`, JSON.stringify({ nested: { $generated: markerText("codex") } }), "{ malformed", `---\n${markerFor("codex")}`])("does not treat body quotes as generation (AC-2): %s", async (text) => {
    const result = await inspect(text);
    expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ generated: false, grammar: null, surface: null });
  });
  it("distinguishes missing, directory and invalid requests from ungenerated files (AC-2)", async () => {
    const root = temp();
    for (const args of [["--file", join(root, "missing")], ["--file", root], [], ["--under", root], ["--under", root, "--surface", "unknown"], ["--file", root, "--under", root], ["--file", root, "--stamp", "1.0.0"]]) {
      const result = await invoke(args); expect(result.code).toBe(2); expect(result.out).toBe("");
    }
  });
  it("prints a human-readable answer", async () => {
    const file = join(temp(), "placed"); writeFileSync(file, markerFor("codex"));
    const result = await invoke(["--file", file]);
    expect(result.code).toBe(0); expect(result.out).toContain("surface: codex"); expect(result.out).toContain("grammar: nen-surface-mirror");
  });
  it("refuses passthrough and resolves relative inputs against --repo", async () => {
    const root = temp(); writeFileSync(join(root, "placed"), markerFor("codex"));
    expect((await invoke(["--file", "placed", "--repo", root])).code).toBe(0);
    expect((await invoke(["--file", "placed", "--repo", root, "--", "extra"])).code).toBe(2);
  });
  const retired = "<!-- GENERATED for surface: antigravity -- do not edit; edit the source and regenerate -->";
  it.each([retired, `---\nname: old\n---\n${retired}`, `#!/bin/sh\r\n# ${retired}\r\n`, JSON.stringify({ version: 1, description: retired })])("reports retired grammar without claiming current generation (AC-4)", async (text) => {
    const result = await inspect(text); expect(result.code).toBe(1);
    expect(JSON.parse(result.out)).toMatchObject({ generated: false, grammar: "retired-antigravity", surface: "antigravity" });
  });
  it("searches recursively, excludes retired files and never follows symlinks (AC-3)", async () => {
    const root = temp(); const outside = temp();
    writeFileSync(join(outside, "marker"), markerFor("codex"));
    symlinkSync(outside, join(root, "escape"), process.platform === "win32" ? "junction" : "dir");
    writeFileSync(join(root, "old"), retired);
    let result = await invoke(["--under", root, "--surface", "codex", "--json"]);
    expect(result.code).toBe(1); expect(JSON.parse(result.out).matches).toEqual([]);
    mkdirSync(join(root, "nested")); writeFileSync(join(root, "nested", "ours"), markerFor("codex"));
    result = await invoke(["--under", root, "--surface", "codex", "--json"]);
    expect(result.code).toBe(0); expect(JSON.parse(result.out).matches).toEqual(["nested/ours"]);
    expect((await invoke(["--under", join(root, "escape"), "--surface", "codex"])).code).toBe(2);
  });
  it.each(["codex", "cursor", "antigravity"])("agrees with every emitted %s file (SC-1)", async (surface) => {
    const out = temp(); const lines: string[] = [];
    const code = await run(["surface", "mirror", "generate", "--source", "src/surface/fixtures/skills", "--agents", "src/surface/fixtures/agents", "--surface", surface, "--out", out, "--json"], { out: (s) => { lines.push(s); }, err: () => {} });
    expect(code).toBe(0);
    const files = readdirSync(out, { recursive: true, withFileTypes: true }).filter((file) => file.isFile());
    expect(files.length).toBeGreaterThan(0);
    for (const file of files) {
      const path = join(file.parentPath, file.name);
      const expected = readMarker(readFileSync(path, "utf8"));
      const result = await invoke(["--file", path, "--json"]);
      expect(JSON.parse(result.out)).toMatchObject({ generated: expected !== null, surface: expected?.surface ?? null });
    }
  });
});
