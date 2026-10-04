// src/wc/mechanical.test.ts -- the pure half of `wc catch-up`'s conflict
// classes (zheref/nen#326): precedence, counts, the all-mechanical verdict,
// the per-strategy side flag, delete/modify on a manifest or changelog
// (hanten N1), literal pathspecs (N2), the root every step runs from (N3),
// the staged mirror path (N6) and the rendered commands (N8, N9). The
// real-git half is ./catchup.integration.test.ts.

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MechanicalBlock } from "../schema/contract.js";
import {
  classifyConflicts,
  displayPath,
  globPathspec,
  loadMechanical,
  renderClassification,
  renderCommand,
  type MechanicalDeclaration,
  type Sides,
} from "./mechanical.js";

const ROOT = "/work/repo";
const BLOCK: MechanicalBlock = {
  manifests: ["package.json", "**/plugin.json"],
  changelog: ["CHANGELOG.md"],
  mirrors: [
    { paths: ["surfaces/codex/**"], regenerate: ["nen", "surface", "mirror", "generate", "--surface", "codex"], raw: {} },
    { paths: ["surfaces/cursor/**"], regenerate: ["make", "mirrors"], raw: {} },
  ],
  raw: {},
};
const DECLARED: MechanicalDeclaration = { state: "declared", block: BLOCK, error: null };
const at = (path: string, sides: Sides = "both"): { path: string; sides: Sides } => ({ path, sides });
const lit = (path: string): string => `:(top,literal)${path}`;

describe("classifyConflicts", () => {
  it("classes each path by precedence -- manifest, changelog, then each mirror in declared order -- and counts them", () => {
    const result = classifyConflicts(
      [at("package.json"), at(".claude-plugin/plugin.json"), at("CHANGELOG.md"), at("surfaces/codex/a.md"), at("surfaces/cursor/b.mdc"), at("src/x.ts")],
      DECLARED,
      "merge",
      ROOT,
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
    expect(result.resolve.map((g) => [g.class, g.globs, g.paths, g.cwd])).toEqual([
      ["manifest", [], ["package.json", ".claude-plugin/plugin.json"], ROOT],
      ["changelog", [], ["CHANGELOG.md"], ROOT],
      ["mirror", ["surfaces/codex/**"], ["surfaces/codex/a.md"], ROOT],
      ["mirror", ["surfaces/cursor/**"], ["surfaces/cursor/b.mdc"], ROOT],
    ]);
    // Every git step names the root and every path literally (N2, N3).
    expect(result.resolve[0]?.steps).toEqual([["git", "-C", ROOT, "add", "--", lit("package.json"), lit(".claude-plugin/plugin.json")]]);
  });

  it("is mechanical only when the block was read and every path is in it", () => {
    expect(classifyConflicts([at("package.json"), at("surfaces/codex/a.md")], DECLARED, "merge", ROOT).mechanical).toBe(true);
    expect(classifyConflicts([], DECLARED, "merge", ROOT).mechanical).toBe(false);
    for (const state of ["absent", "unreadable", "not-read"] as const) {
      const none = classifyConflicts([at("package.json")], { state, block: null, error: state === "unreadable" ? "bad" : null }, "merge", ROOT);
      expect(none.mechanical).toBe(false);
      expect(none.counts).toEqual({ manifest: 0, changelog: 0, mirror: 0, other: 1 });
      expect(none.resolve).toEqual([]);
    }
  });

  it("classes a delete/modify conflict on a manifest or changelog as OTHER -- whether the file exists is a judgement (N1)", () => {
    for (const sides of ["base-deleted", "branch-deleted"] as const) {
      const result = classifyConflicts([at("package.json", sides), at("CHANGELOG.md", sides), at("surfaces/codex/a.md", sides)], DECLARED, "merge", ROOT);
      expect(Object.fromEntries(result.classes)).toEqual({ "package.json": "other", "CHANGELOG.md": "other", "surfaces/codex/a.md": "mirror" });
      expect(result.mechanical).toBe(false);
      expect(result.resolve.map((g) => g.class)).toEqual(["mirror"]);
    }
    // A staged path (a leftover marker) still has both sides behind it.
    expect(classifyConflicts([at("package.json", "staged")], DECLARED, "merge", ROOT).classes.get("package.json")).toBe("manifest");
  });

  it("names the BASE's side by strategy -- --theirs on a merge, --ours on a rebase, MERGE_HEAD / HEAD for a staged path -- and 'git rm' where the base deleted it", () => {
    const merge = classifyConflicts(
      [at("surfaces/codex/a.md"), at("surfaces/codex/mine.md", "branch-deleted"), at("surfaces/codex/s.md", "staged"), at("surfaces/codex/gone.md", "base-deleted")],
      DECLARED,
      "merge",
      ROOT,
    );
    expect(merge.resolve[0]?.steps).toEqual([
      ["git", "-C", ROOT, "checkout", "--theirs", "--", lit("surfaces/codex/a.md"), lit("surfaces/codex/mine.md")],
      ["git", "-C", ROOT, "checkout", "MERGE_HEAD", "--", lit("surfaces/codex/s.md")],
      ["git", "-C", ROOT, "rm", "--quiet", "--", lit("surfaces/codex/gone.md")],
      ["nen", "surface", "mirror", "generate", "--surface", "codex"],
      ["git", "-C", ROOT, "add", "-A", "--", ":(top,glob)surfaces/codex/**"],
    ]);
    expect(merge.resolve[0]?.note).toContain(`runs from ${ROOT}`);
    const rebase = classifyConflicts([at("surfaces/codex/a.md"), at("surfaces/codex/s.md", "staged")], DECLARED, "rebase", ROOT);
    expect(rebase.resolve[0]?.steps.slice(0, 2)).toEqual([
      ["git", "-C", ROOT, "checkout", "--ours", "--", lit("surfaces/codex/a.md")],
      ["git", "-C", ROOT, "checkout", "HEAD", "--", lit("surfaces/codex/s.md")],
    ]);
  });
});

describe("rendering", () => {
  it("quotes what a shell would split or expand, and a first token carrying '=' (N8)", () => {
    expect(renderCommand(["git", "add", "-A", "--", ":(top,glob)surfaces/**", "sp ace.md", "it's", "k=v"])).toBe(
      "git add -A -- ':(top,glob)surfaces/**' 'sp ace.md' 'it'\\''s' k=v",
    );
    expect(renderCommand(["FOO=bar", "x"])).toBe("'FOO=bar' x");
  });

  it("escapes a tab or newline in a path rather than dropping it (N9)", () => {
    expect(renderCommand(["git", "add", "--", "a\tb\nc'd"])).toBe("git add -- $'a\\tb\\nc\\'d'");
    expect(displayPath("a\tb")).toBe("$'a\\tb'");
    expect(displayPath("docs/ünï.md")).toBe("docs/ünï.md");
  });

  it("escapes a C1 control -- CSI, U+009B -- as \\u009b rather than sending it to a terminal (Copilot, NN-PR-#368)", () => {
    expect(displayPath("a\u009bb")).toBe("$'a\\u009bb'");
    expect(renderCommand(["git", "add", "--", "x\u0085y"])).toBe("git add -- $'x\\u0085y'");
  });

  it("sanitises an unreadable declaration's error at the rendering boundary (Copilot, NN-PR-#368)", () => {
    const broken: MechanicalDeclaration = { state: "unreadable", block: null, error: "/repo\u001b[31m/nen\u009b/contract.json: bad" };
    const line = renderClassification(classifyConflicts([at("a.ts")], broken, "merge", ROOT), broken, ["a.ts"])[0] ?? "";
    expect(line).toContain("could not be read (/repo[31m/nen/contract.json: bad)");
    expect(/[\u0000-\u001f\u007f-\u009f]/.test(line)).toBe(false);
  });

  it("states the root, and why every path is 'other' when nothing was declared or the file could not be read", () => {
    const declared = renderClassification(classifyConflicts([at("package.json")], DECLARED, "merge", ROOT), DECLARED, []);
    expect(declared).toContain(`  run from ${ROOT} (every git step also says so with -C; the regenerate commands run from there too):`);
    const absent: MechanicalDeclaration = { state: "absent", block: null, error: null };
    const lines = renderClassification(classifyConflicts([at("a.ts")], absent, "merge", ROOT), absent, ["a.ts"]);
    expect(lines[0]).toBe("classes: 0 manifest, 0 changelog, 0 mirror, 1 other -- nen/contract.json declares no 'mechanical' block, so every path is 'other'");
    expect(lines).toContain("  other (1): a judgement nen does not make -- a.ts");
    const broken: MechanicalDeclaration = { state: "unreadable", block: null, error: "boom" };
    expect(renderClassification(classifyConflicts([at("a.ts")], broken, "merge", ROOT), broken, ["a.ts"])[0]).toContain("could not be read (boom)");
  });
});

describe("globPathspec -- nen's glob, spelled in git's grammar with the same meaning (Copilot, NN-PR-#368)", () => {
  it("escapes the brackets nen reads literally and git would read as a class", () => {
    expect(globPathspec("generated/[ab].txt")).toBe(":(top,glob)generated/\\[ab\\].txt");
    expect(globPathspec("surfaces/**/*.md")).toBe(":(top,glob)surfaces/**/*.md");
  });

  const probe = spawnSync("git", ["--version"], { encoding: "utf8" });
  it.skipIf(probe.error !== undefined || probe.status !== 0)("stages the literal '[ab].txt' and never 'a.txt', in a real repository", () => {
    const root = mkdtempSync(join(tmpdir(), "nen-wc-pathspec-"));
    const git = (...args: string[]): string => {
      const result = spawnSync("git", ["-C", root, "-c", "core.autocrlf=false", ...args], { encoding: "utf8" });
      if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
      return result.stdout;
    };
    git("init", "--quiet");
    mkdirSync(join(root, "generated"));
    writeFileSync(join(root, "generated", "[ab].txt"), "literal\n");
    writeFileSync(join(root, "generated", "a.txt"), "class member\n");
    git("add", "-A", "--", globPathspec("generated/[ab].txt"));
    expect(git("-c", "core.quotePath=false", "diff", "--cached", "--name-only").trim().split("\n")).toEqual(["generated/[ab].txt"]);
  }, 20_000);
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
