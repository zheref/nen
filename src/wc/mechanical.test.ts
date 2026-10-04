// src/wc/mechanical.test.ts -- the pure half of `wc catch-up`'s conflict
// classes (zheref/nen#326): precedence, counts, the all-mechanical verdict,
// the per-strategy side flag and the rendered commands. The real-git half
// is ./catchup.integration.test.ts.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MechanicalBlock } from "../schema/contract.js";
import { classifyConflicts, loadMechanical, renderClassification, renderCommand, type MechanicalDeclaration } from "./mechanical.js";

const BLOCK: MechanicalBlock = {
  manifests: ["package.json", "**/plugin.json"],
  changelog: ["CHANGELOG.md"],
  mirrors: [
    { paths: ["surfaces/codex/**"], regenerate: ["nen", "surface", "mirror", "generate", "--surface", "codex"], raw: {} },
    { paths: ["surfaces/**"], regenerate: ["make", "mirrors"], raw: {} },
  ],
  raw: {},
};
const DECLARED: MechanicalDeclaration = { state: "declared", block: BLOCK, error: null };
const at = (path: string, baseSide = true): { path: string; baseSide: boolean } => ({ path, baseSide });

describe("classifyConflicts", () => {
  it("classes each path by precedence -- manifest, changelog, then each mirror in declared order -- and counts them", () => {
    const result = classifyConflicts(
      [at("package.json"), at(".claude-plugin/plugin.json"), at("CHANGELOG.md"), at("surfaces/codex/a.md"), at("surfaces/cursor/b.mdc"), at("src/x.ts")],
      DECLARED,
      "merge",
    );
    expect(Object.fromEntries(result.classes)).toEqual({
      "package.json": "manifest",
      ".claude-plugin/plugin.json": "manifest",
      "CHANGELOG.md": "changelog",
      "surfaces/codex/a.md": "mirror",
      "surfaces/cursor/b.mdc": "mirror",
      "src/x.ts": "other",
    });
    expect(result.counts).toEqual({ manifest: 2, changelog: 1, mirror: 2, other: 1 });
    expect(result.mechanical).toBe(false);
    // One group per class, and one per declared mirror that conflicted: the
    // codex file is the FIRST mirror's even though the second's glob matches it too.
    expect(result.resolve.map((g) => [g.class, g.globs, g.paths])).toEqual([
      ["manifest", [], ["package.json", ".claude-plugin/plugin.json"]],
      ["changelog", [], ["CHANGELOG.md"]],
      ["mirror", ["surfaces/codex/**"], ["surfaces/codex/a.md"]],
      ["mirror", ["surfaces/**"], ["surfaces/cursor/b.mdc"]],
    ]);
  });

  it("is mechanical only when the block was read and every path is in it", () => {
    expect(classifyConflicts([at("package.json"), at("surfaces/codex/a.md")], DECLARED, "merge").mechanical).toBe(true);
    expect(classifyConflicts([], DECLARED, "merge").mechanical).toBe(false);
    for (const state of ["absent", "unreadable", "not-read"] as const) {
      const none = classifyConflicts([at("package.json")], { state, block: null, error: state === "unreadable" ? "bad" : null }, "merge");
      expect(none.mechanical).toBe(false);
      expect(none.counts).toEqual({ manifest: 0, changelog: 0, mirror: 0, other: 1 });
      expect(none.resolve).toEqual([]);
    }
  });

  it("names the BASE's side by strategy -- --theirs on a merge, --ours on a rebase -- and 'git rm' where the base deleted the path", () => {
    const merge = classifyConflicts([at("surfaces/codex/a.md"), at("surfaces/codex/gone.md", false)], DECLARED, "merge");
    expect(merge.resolve[0]?.steps).toEqual([
      ["git", "checkout", "--theirs", "--", "surfaces/codex/a.md"],
      ["git", "rm", "--quiet", "--", "surfaces/codex/gone.md"],
      ["nen", "surface", "mirror", "generate", "--surface", "codex"],
      ["git", "add", "-A", "--", ":(glob)surfaces/codex/**"],
    ]);
    const rebase = classifyConflicts([at("surfaces/codex/a.md")], DECLARED, "rebase");
    expect(rebase.resolve[0]?.steps[0]).toEqual(["git", "checkout", "--ours", "--", "surfaces/codex/a.md"]);
  });
});

describe("rendering", () => {
  it("quotes only what a shell would split or expand", () => {
    expect(renderCommand(["git", "add", "-A", "--", ":(glob)surfaces/**", "sp ace.md", "it's"])).toBe(
      "git add -A -- ':(glob)surfaces/**' 'sp ace.md' 'it'\\''s'",
    );
  });

  it("states why every path is 'other' when nothing was declared or the file could not be read", () => {
    const absent: MechanicalDeclaration = { state: "absent", block: null, error: null };
    const lines = renderClassification(classifyConflicts([at("a.ts")], absent, "merge"), absent, ["a.ts"]);
    expect(lines[0]).toBe("classes: 0 manifest, 0 changelog, 0 mirror, 1 other -- nen/contract.json declares no 'mechanical' block, so every path is 'other'");
    expect(lines).toContain("  other (1): a judgement nen does not make -- a.ts");
    const broken: MechanicalDeclaration = { state: "unreadable", block: null, error: "boom" };
    expect(renderClassification(classifyConflicts([at("a.ts")], broken, "merge"), broken, ["a.ts"])[0]).toContain("could not be read (boom)");
  });
});

describe("loadMechanical", () => {
  const repo = (contract: string | null): string => {
    const root = mkdtempSync(join(tmpdir(), "nen-wc-mechanical-"));
    if (contract !== null) {
      mkdirSync(join(root, "nen"));
      writeFileSync(join(root, "nen", "contract.json"), contract);
    }
    return root;
  };

  it("reads absent for no file and for a file with no block, declared for a block, unreadable for a bad file -- never throws", () => {
    expect(loadMechanical(repo(null)).state).toBe("absent");
    expect(loadMechanical(repo(JSON.stringify({ project: { lanes: { web: { stack: "nextjs", cwd: "." } }, verbs: { web: { build: { exe: "pnpm", argv: ["run", "build"] } } } } }))).state).toBe("absent");
    const declared = loadMechanical(repo(JSON.stringify({ mechanical: { changelog: ["CHANGELOG.md"] } })));
    expect(declared.state).toBe("declared");
    expect(declared.block?.changelog).toEqual(["CHANGELOG.md"]);
    const broken = loadMechanical(repo(JSON.stringify({ mechanical: { mirror: [] } })));
    expect(broken.state).toBe("unreadable");
    expect(broken.error).toContain("mechanical.mirror");
  });
});
