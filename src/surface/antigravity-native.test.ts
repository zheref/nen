// Native format regression for #543. Offline fixtures assert the documented
// shape; only the opt-in test below claims live native-validator evidence.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkSurfaceMirror, generateSurfaceMirror, markerText, mirrorReportOk, readMarker, universeFiles, writeSurfaceMirror } from "./mirror.js";
import { readHooksManifest, renderHooks } from "./packs.js";
import { findSurface } from "./rules.js";

const PACKS = join(process.cwd(), "src/surface/fixtures/packs");
const row = findSurface("antigravity")!;
const hooks = readHooksManifest(join(PACKS, "hooks.json"));
const stamp = "0.143.1";
const marker = markerText("antigravity", stamp);
const fixture = (name: string): string => readFileSync(join(PACKS, name), "utf8");
const generate = (version: string | null = stamp, root = "/opt/demo"): ReturnType<typeof generateSurfaceMirror> =>
  generateSurfaceMirror({ row, skills: [], agents: [], invocationPrefix: null, hooks, hooksRoot: root, stamp: version });
const withMirror = (run: (out: string) => void): void => {
  const out = mkdtempSync(join(tmpdir(), "nen-native-hooks-"));
  try { run(out); } finally { rmSync(out, { recursive: true, force: true }); }
};

describe("Antigravity native hook format (#543)", () => {
  it("matches the complete documented named-definition fixture, retaining every mapped command", () => {
    expect(generate().find((file): boolean => file.path === "hooks.json")?.content).toBe(fixture("antigravity-native-hooks.json"));
    expect(row.hooks?.events.SessionStart).toBe("SessionStart");
    expect(row.hooks?.known).toContain("SessionStart");
  });

  it("keeps all lifecycle handlers in order across groups, with their own timeouts", () => {
    const command = (name: string, timeout: number | null): { command: string; timeout: number | null } => ({ command: name, timeout });
    const source = { ...hooks, events: { ...hooks.events, Stop: [
      { matcher: "ignored", hooks: [command("first", 4), command("second", null)] },
      { matcher: null, hooks: [command("third", 8)] },
    ], SessionStart: [{ matcher: "ignored", hooks: [command("start", 3), command("ready", null)] }] } };
    const doc = JSON.parse(renderHooks(row.hooks!, source, marker)) as Record<string, Record<string, unknown>>;
    expect(doc[marker]?.["Stop"]).toEqual([
      { type: "command", command: "first", timeout: 4 },
      { type: "command", command: "second" },
      { type: "command", command: "third", timeout: 8 },
    ]);
    expect(doc[marker]?.["SessionStart"]).toEqual([
      { type: "command", command: "start", timeout: 3 }, { type: "command", command: "ready" },
    ]);
  });

  it("recognizes native ownership only on a top-level object definition, and still reads legacy ownership", () => {
    expect(readMarker(fixture("antigravity-native-hooks.json"))).toEqual({ surface: "antigravity", stamp });
    expect(readMarker(fixture("antigravity-legacy-hooks.json"))).toEqual({ surface: "antigravity", stamp });
    for (const value of [null, "text", [], 1]) expect(readMarker(JSON.stringify({ [marker]: value }))).toBeNull();
    expect(readMarker(JSON.stringify({ unrelated: { [marker]: {} } }))).toBeNull();
  });

  it("checks a fresh generation, ignores an unrequested stamp and detects a requested stamp change", () => withMirror((out): void => {
    writeSurfaceMirror(out, generate(), row);
    expect(mirrorReportOk(checkSurfaceMirror(out, generate(), row, stamp))).toBe(true);
    expect(mirrorReportOk(checkSurfaceMirror(out, generate(null), row))).toBe(true);
    expect(checkSurfaceMirror(out, generate("0.144.0"), row, "0.144.0").stale).toContain("hooks.json");
  }));

  it("reports exact pre-543 output stale, upgrades it through generation, and deletes its orphan", () => withMirror((out): void => {
    const files = generate();
    writeSurfaceMirror(out, files, row);
    writeFileSync(join(out, "hooks.json"), fixture("antigravity-legacy-hooks.json"));
    const report = checkSurfaceMirror(out, files, row, stamp);
    expect(report.stale).toEqual(["hooks.json"]);
    expect(report.handEdited).toEqual([]);
    expect(writeSurfaceMirror(out, files, row).written).toEqual(["hooks.json"]);
    expect(mirrorReportOk(checkSurfaceMirror(out, files, row, stamp))).toBe(true);
    expect(universeFiles(out, row)).toContain("hooks.json");
    expect(writeSurfaceMirror(out, [], row).deleted).toContain("hooks.json");
  }));

  it("does not call edited legacy bytes stale and refuses to overwrite an unowned native file", () => withMirror((out): void => {
    const files = generate();
    writeSurfaceMirror(out, files, row);
    writeFileSync(join(out, "hooks.json"), fixture("antigravity-legacy-hooks.json").replace("echo warm", "echo edited"));
    expect(checkSurfaceMirror(out, files, row, stamp).handEdited).toEqual(["hooks.json"]);
    writeFileSync(join(out, "hooks.json"), '{"my-hooks":{"SessionStart":[{"command":"echo mine"}]}}\n');
    expect(checkSurfaceMirror(out, files, row, stamp).handEdited).toEqual(["hooks.json"]);
    expect(() => writeSurfaceMirror(out, files, row)).toThrow(/refusing|refuse/i);
  }));

  // Opt-in: missing CLI is a failing check once requested, not a hidden skip.
  it.skipIf(process.env["NEN_TEST_AGY"] !== "1")("live agy accepts a fresh complete configuration and rejects the historical string marker", () => withMirror((out): void => {
    const version = spawnSync("agy", ["--version"], { encoding: "utf8", timeout: 10_000 });
    expect(version.status, `${version.error?.message ?? ""}\n${version.stderr}`).toBe(0);
    console.info(`Native Antigravity validator: ${version.stdout.trim()}`);
    // Minimal native plugin wrapper; hooks and scripts are Nen's fresh output.
    writeFileSync(join(out, "plugin.json"), JSON.stringify({ name: "nen-hook-fixture", description: "Native hooks regression fixture" }));
    const files = generate(stamp, out);
    writeSurfaceMirror(out, files, row);
    expect(mirrorReportOk(checkSurfaceMirror(out, files, row, stamp))).toBe(true);
    const valid = spawnSync("agy", ["plugin", "validate", out, "--json"], { encoding: "utf8", timeout: 20_000 });
    console.info(valid.stdout, valid.stderr);
    expect(valid.status, `${valid.error?.message ?? ""}\n${valid.stdout}\n${valid.stderr}`).toBe(0);
    expect(JSON.parse(valid.stdout)).toMatchObject({ components: { hooks: 1 }, findings: [] });
    writeFileSync(join(out, "hooks.json"), fixture("antigravity-legacy-hooks.json"));
    const invalid = spawnSync("agy", ["plugin", "validate", out, "--json"], { encoding: "utf8", timeout: 20_000 });
    console.info(invalid.stdout, invalid.stderr);
    expect(invalid.error).toBeUndefined();
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.stdout)).toMatchObject({ components: { hooks: 0 }, findings: [
      { severity: "error", file: "hooks.json" },
    ] });
    expect(`${invalid.stdout}\n${invalid.stderr}`).toMatch(/hooks\.json.*(?:parse|unmarshal)|(?:parse|unmarshal).*hooks\.json/s);
  }));
});
