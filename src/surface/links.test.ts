// src/surface/links.test.ts -- the relative-link rewrite (zheref/nen#270): on
// strings, where the question is one link's spelling, and over the
// repository-shaped fixture beside this file (./fixtures/links), where the
// question is whether a whole mirror's links resolve.
//
// THE MIRROR-WIDE PROOF IS A PORT OF THE CONSUMER'S OWN GUARD. The defect was
// found by a link guard in the first consumer's tree, which reads three
// CommonMark forms in every generated `.md`, `.mdc` and `.toml` and resolves
// each target from the file's own directory. `danglingLinks` below reads the
// same forms the same way, so "nothing dangles" here is the claim that guard
// makes there. And it is run against the OLD generation as well -- `links:
// null`, byte for byte what a build before #270 wrote -- where it must find
// the defect in every class the issue's evidence table names, or a green
// here would prove nothing.

import { describe, expect, it } from "vitest";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { run, type Io } from "../index.js";
import { headingAnchor, LinkRewriter, maskLinksOutOfMirror, mirrorPathsOf, resolveLinkOptions, type MirrorLocation } from "./links.js";
import {
  checkSurfaceMirror,
  generateSurfaceMirrorReport,
  readSourceAgentsReport,
  readSourceSkills,
  writeSurfaceMirror,
  type GeneratedFile,
} from "./mirror.js";
import { readModelMaps, readRules } from "./packs.js";
import { ANTIGRAVITY_RULES_LIMIT, findSurface, type SurfaceRow } from "./rules.js";

const FIXTURE = join(process.cwd(), "src", "surface", "fixtures", "links");
const MODELS = join(process.cwd(), "src", "surface", "fixtures", "packs", "workflow.json");
const MIRRORED = ["codex", "cursor", "antigravity"] as const;

function row(name: string): SurfaceRow {
  const found = findSurface(name);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

/** A fresh copy of the fixture tree -- plus the one shell file this repository will not track (AK-11). */
function tree(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-links-")));
  cpSync(FIXTURE, root, { recursive: true });
  mkdirSync(join(root, "scripts"));
  writeFileSync(join(root, "scripts", "tool.sh"), "echo tool\n");
  return root;
}

async function capture(argv: readonly string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = {
    out: (line): void => {
      out.push(line);
    },
    err: (line): void => {
      err.push(line);
    },
  };
  return { code: await run(argv, io), out, err };
}

const json = (result: { out: string[] }): Record<string, unknown> => JSON.parse(result.out.join("\n")) as Record<string, unknown>;

/** Every input the fixture has, named the way a consumer's own script names them. */
const inputs = (root: string, surface: string): readonly string[] => [
  "--source",
  join(root, "plugin", "skills"),
  "--agents",
  join(root, "plugin", "agents"),
  "--surface",
  surface,
  "--invocation-prefix",
  "demo:",
  "--models",
  MODELS,
  "--rules",
  join(root, "plugin", "rules", "house.md"),
];

const generate = (root: string, surface: string, out: string, extra: readonly string[] = []): Promise<{ code: number; out: string[]; err: string[] }> =>
  capture(["surface", "mirror", "generate", ...inputs(root, surface), "--out", out, "--repo", root, ...extra]);

const check = (root: string, surface: string, out: string, extra: readonly string[] = []): Promise<{ code: number; out: string[]; err: string[] }> =>
  capture(["surface", "mirror", "check", ...inputs(root, surface), "--out", out, "--repo", root, "--json", ...extra]);

/**
 * The generation a build before #270 wrote: the same inputs, `links: null`.
 * Written to `out` exactly as that build's `generate` would have.
 */
function writeOldGeneration(root: string, surface: string, out: string, stamp: string | null = null): readonly GeneratedFile[] {
  const agents = readSourceAgentsReport(join(root, "plugin", "agents"));
  const files = generateSurfaceMirrorReport({
    row: row(surface),
    skills: readSourceSkills(join(root, "plugin", "skills")),
    agents: agents.agents,
    includes: agents.includes,
    invocationPrefix: "demo:",
    stamp,
    models: readModelMaps(MODELS, surface, "claude"),
    rules: readRules(join(root, "plugin", "rules", "house.md")),
    links: null,
  }).files;
  writeSurfaceMirror(out, files, row(surface));
  return files;
}

// ---------------------------------------------------------------------------
// The guard, ported
// ---------------------------------------------------------------------------

/** The link targets in `text`, read the way the consumer's guard reads them: inline (bracketed, titled) and reference definitions. */
function targetsOf(text: string): readonly string[] {
  const found: string[] = [];
  for (const line of text.split("\n")) {
    for (const match of line.matchAll(/\]\(([^)]*)\)/g)) {
      const inner = (match[1] ?? "").replace(/^\s+/, "");
      const bracketed = /^<([^>]*)>/.exec(inner);
      found.push(bracketed === null ? inner.replace(/\s+["'].*$/, "").replace(/\s+$/, "") : (bracketed[1] ?? ""));
    }
    const definition = /^\s*\[[^\]]+\]:\s*<?([^\s>]+)>?/.exec(line);
    if (definition?.[1] !== undefined) found.push(definition[1]);
  }
  return found;
}

function generatedFiles(dir: string): readonly string[] {
  return readdirSync(dir).flatMap((entry): readonly string[] => {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) return generatedFiles(path);
    return /\.(md|mdc|toml)$/.test(entry) ? [path] : [];
  });
}

/** Every relative link under `mirror` that does not resolve from its own file's directory, as `<file>\t<link>`. */
function danglingLinks(mirror: string): { total: number; dangling: readonly string[] } {
  let total = 0;
  const dangling: string[] = [];
  for (const file of generatedFiles(mirror)) {
    for (const link of targetsOf(readFileSync(file, "utf8"))) {
      const path = link.split("#")[0] ?? "";
      if (path === "" || /^(https?:|mailto:|\/)/.test(path)) continue;
      total += 1;
      if (!existsSync(join(dirname(file), path))) dangling.push(`${relative(mirror, file).split("\\").join("/")}\t${link}`);
    }
  }
  return { total, dangling: dangling.sort() };
}

// ---------------------------------------------------------------------------
// On strings
// ---------------------------------------------------------------------------

const R = resolve("/r");
const at = (...parts: string[]): string => join(R, ...parts);

/** A rewriter over a cursor-shaped mirror at `<R>/surfaces/cursor`, with two skills and two personas mirrored. */
function cursorLike(outDir = at("surfaces", "cursor")): LinkRewriter {
  const items = new Map<string, MirrorLocation>([
    [at("plugin", "skills", "warm", "SKILL.md"), { path: "warm/SKILL.md", fragment: null }],
    [at("plugin", "skills", "warm"), { path: "warm", fragment: null }],
    [at("plugin", "agents", "lead.md"), { path: "agents/lead.md", fragment: null }],
  ]);
  return new LinkRewriter({ root: R, outDir, items });
}

const WARM = at("plugin", "skills", "warm", "SKILL.md");
const LEAD = at("plugin", "agents", "lead.md");

describe("headingAnchor -- a persona's section on the appendix row", () => {
  it("is the renderer's slug: lowercased, punctuation dropped, spaces hyphenated, _ and - kept", () => {
    expect(headingAnchor("lead")).toBe("lead");
    expect(headingAnchor("_review-preamble")).toBe("_review-preamble");
    expect(headingAnchor("The Six Work-Modes!")).toBe("the-six-work-modes");
    expect(headingAnchor("  Café & Co  ")).toBe("café--co");
  });
});

describe("LinkRewriter, on strings", () => {
  it("re-aims a link to a file on disk for the destination's depth, keeping its fragment and title", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "antigravity"), items: new Map() });
    const text = 'See [the guide](../../../docs/guide.md#setup "Guide") and ![d](../../../docs/d.svg).';
    expect(rewriter.rewrite(text, WARM, "skills/warm/SKILL.md")).toBe(
      'See [the guide](../../../../docs/guide.md#setup "Guide") and ![d](../../../../docs/d.svg).',
    );
    expect(rewriter.rewritten).toBe(2);
  });

  it("re-aims every suffix alike -- a page, a template, a script, a JSON file", () => {
    const persona = cursorLike();
    expect(persona.rewrite("[a](../../x.md) [b](../../t/g.json) [c](../../s/t.sh) [d](../../t/r.html)", LEAD, "agents/lead.md")).toBe(
      "[a](../../../x.md) [b](../../../t/g.json) [c](../../../s/t.sh) [d](../../../t/r.html)",
    );
    expect(persona.rewritten).toBe(4);
  });

  it("points a link to a MIRRORED item at the item's copy, a directory link keeping its slash", () => {
    const rewriter = cursorLike();
    expect(rewriter.rewrite("[w](../skills/warm/SKILL.md) [d](../skills/warm/) [n](../skills/warm)", LEAD, "agents/lead.md")).toBe(
      "[w](../warm/SKILL.md) [d](../warm/) [n](../warm)",
    );
    // The reverse: a skill naming a persona finds the persona's copy.
    expect(rewriter.rewrite("[l](../../agents/lead.md#duties)", WARM, "warm/SKILL.md")).toBe("[l](../agents/lead.md#duties)");
  });

  it("on the appendix row points a persona link at its section, keeping a fragment the source gave instead", () => {
    const items = new Map<string, MirrorLocation>([
      [LEAD, { path: "AGENTS.md", fragment: "lead" }],
      [at("plugin", "agents", "scout.md"), { path: "AGENTS.md", fragment: "scout" }],
    ]);
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "codex"), items });
    expect(rewriter.rewrite("[l](../../agents/lead.md) [d](../../agents/lead.md#duties)", WARM, "warm/SKILL.md")).toBe(
      "[l](../AGENTS.md#lead) [d](../AGENTS.md#duties)",
    );
    // Inside the appendix itself the anchor alone is the link.
    expect(rewriter.rewrite("[s](scout.md) [d](lead.md#duties)", LEAD, "AGENTS.md")).toBe("[s](#scout) [d](#duties)");
    // And from a persona TOML one directory down.
    expect(rewriter.rewrite("[s](scout.md)", LEAD, "agents/lead.toml")).toBe("[s](../AGENTS.md#scout)");
  });

  it("keeps the angle-bracketed form and re-aims a reference definition, bracketed or titled", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "antigravity"), items: new Map() });
    const text = [
      "[t](<../../../scripts/tool.sh>)",
      '[ref]: ../../../docs/guide.md "Guide"',
      "  [bracketed]: <../../../docs/guide.md>",
    ].join("\n");
    expect(rewriter.rewrite(text, WARM, "skills/warm/SKILL.md")).toBe(
      ["[t](<../../../../scripts/tool.sh>)", '[ref]: ../../../../docs/guide.md "Guide"', "  [bracketed]: <../../../../docs/guide.md>"].join("\n"),
    );
  });

  it("re-aims a link inside a fence too: a copied dangling path dangles the same", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "antigravity"), items: new Map() });
    expect(rewriter.rewrite("```text\n[g](../../../docs/guide.md)\n```\n", WARM, "skills/warm/SKILL.md")).toBe(
      "```text\n[g](../../../../docs/guide.md)\n```\n",
    );
  });

  it("carries every form that is not a relative path exactly as written, and counts none", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "antigravity"), items: new Map() });
    const carried = [
      "[a site](https://example.com/x.md)",
      "[plain](http://example.com)",
      "[mail](mailto:someone@example.com)",
      "[other scheme](vscode:extension/x)",
      "[fragment](#top)",
      "[system file](/etc/hosts)",
      "[home file](~/notes.md)",
      "a pattern: `grep -o '\\]([^)]*)'`",
      "[not a link](a b)",
      "[placeholder](${ROOT}/x.md)",
      "[glob](docs/*.md)",
      "[empty]()",
      "[^1]: A footnote is not a link definition.",
      "[label]: not a target, prose after it",
      // Code that only looks like a link (Nobunaga, the #270 review): a call
      // through an index, a bracket after `)` or `]`, an escaped bracket.
      "handlers[name](event);",
      "const y = xs[0](value);",
      "f(a)[i](b.md) and grid[a][b](c.md)",
      "\\[escaped](x.md)",
      // Nothing inside an inline code span, whatever its backtick count.
      "`[x](y.md)` and ``a ` [x](y.md) ``",
      "`[multi-line\nspan](y.md)`",
      // A fence is code: its reference-definition-shaped lines are log lines.
      "```text",
      "[warn]: deprecated",
      "[1]: first",
      "handlers[name](event);",
      "```",
      "~~~",
      "[2]: second",
      "~~~",
    ].join("\n");
    expect(rewriter.rewrite(carried, WARM, "skills/warm/SKILL.md")).toBe(carried);
    expect(rewriter.rewritten).toBe(0);
    expect(rewriter.verbatim).toEqual([]);
  });

  it("still reads every real link around the code it now leaves alone", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "antigravity"), items: new Map() });
    // One paragraph apiece: a backtick run closes on the next run of its
    // length anywhere in its paragraph (an "escaped" one included -- inside a
    // span a backslash is literal), so cases that share a paragraph would
    // test each other rather than the rule.
    const paragraphs = (guide: string, svg: string, tool: string): string =>
      [
        `[\`tool.sh\`](${tool}) -- a code span as the label`,
        `(see [the guide](${guide}))`,
        `[the\nguide](${guide}) wraps a line`,
        `[![d](${svg})](${guide}) is an image inside a link`,
        `a stray \` backtick never closes, so [g](${guide}) is prose`,
        `\\\`[g](${guide}) -- an escaped backtick opens no span`,
        `\`opens here\n\n[g](${guide}) but a blank line ends the paragraph\``,
        `[ref]: ${guide}`,
        ["```text", `[fenced](${guide})`, "[ref]: ../../../docs/guide.md", "```"].join("\n"),
      ].join("\n\n");
    const source = paragraphs("../../../docs/guide.md", "../../../docs/d.svg", "../../../scripts/tool.sh");
    expect(rewriter.rewrite(source, WARM, "skills/warm/SKILL.md")).toBe(
      // Every link re-aimed -- except the definition-shaped line inside the
      // fence, which is code and is carried (the helper writes it literally).
      paragraphs("../../../../docs/guide.md", "../../../../docs/d.svg", "../../../../scripts/tool.sh"),
    );
    expect(rewriter.rewritten).toBe(10);
  });

  it("reads a destination and a title the way CommonMark does -- parentheses included (Cursor Bugbot on #285)", () => {
    // From a persona one level deeper in the copy than in the source: every
    // form below must reach the rewrite, or it dangles at the copy's depth.
    const rewriter = cursorLike();
    const written = [
      // A quoted title may hold parentheses.
      '[x](../../docs/a.md "title (with parens)")',
      "[x](../../docs/a.md 'single (quoted)')",
      // A title may itself be parenthesised.
      "[x](../../docs/a.md (a parenthesised title))",
      // A bracketed destination may hold spaces and parentheses.
      "[x](<../../docs/a (b).md>)",
      // A bare destination may hold BALANCED parentheses, nested too.
      "[x](../../docs/a(b).md)",
      "[x](../../docs/a((b)).md#frag)",
    ];
    expect(rewriter.rewrite(written.join("\n"), LEAD, "agents/lead.md")).toBe(written.map((line): string => line.replace("../../docs/", "../../../docs/")).join("\n"));
    expect(rewriter.rewritten).toBe(written.length);
  });

  it("still refuses what CommonMark does not read as a link, and every code-sample protection holds", () => {
    const rewriter = cursorLike();
    const carried = [
      // Unbalanced parentheses in a bare destination: not a link.
      "[x](../../docs/a(b.md)",
      // A title that never closes, or a parenthesised title holding a `(`.
      '[x](../../docs/a.md "never closed)',
      "[x](../../docs/a.md (nested (paren)))",
      // A title must be separated from the destination by whitespace.
      "[x](../../docs/a.md\"glued\")",
      // A bracketed destination may not hold `<` or cross a line.
      "[x](<../../docs/a<b.md>)",
      "[x](<../../docs/a\nb.md>)",
      // The code-sample protections (Nobunaga, the #270 review).
      "handlers[name](event(1));",
      "f(a)[i](b(c).md)",
      "`[x](../../docs/a(b).md)`",
      "```text\n[warn]: deprecated (see log)\n```",
    ].join("\n");
    expect(rewriter.rewrite(carried, LEAD, "agents/lead.md")).toBe(carried);
    expect(rewriter.rewritten).toBe(0);
  });

  it("does not let a label run across a blank line", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "antigravity"), items: new Map() });
    const text = "an [unclosed label\n\nthen](../../../docs/guide.md)";
    expect(rewriter.rewrite(text, WARM, "skills/warm/SKILL.md")).toBe(text);
  });

  it("does not count a link already right for its destination", () => {
    const rewriter = cursorLike();
    // A skill-to-skill link stays inside the mirror, whose flat layout keeps the
    // source's sibling spelling: it is already right.
    expect(rewriter.rewrite("[w](../warm/SKILL.md)", at("plugin", "skills", "ship", "SKILL.md"), "ship/SKILL.md")).toBe("[w](../warm/SKILL.md)");
    expect(rewriter.rewritten).toBe(0);
  });

  it("brackets a bare target that picks up whitespace on the way, or it would stop being a link", () => {
    const rewriter = new LinkRewriter({ root: R, outDir: at("surfaces", "cursor"), items: new Map() });
    const source = at("my plugin", "skills", "warm", "SKILL.md");
    expect(rewriter.rewrite("[n](references/n.md)", source, "warm/SKILL.md")).toBe("[n](<../../../my plugin/skills/warm/references/n.md>)");
  });

  it("LEAVES a link that would leave the tree as written, and names it -- a mirrored item is still re-aimed", () => {
    // --out outside the root: an installed surface.
    const installed = cursorLike(resolve("/elsewhere/cursor"));
    const text = "[g](../../docs/guide.md) [w](../skills/warm/SKILL.md)";
    expect(installed.rewrite(text, LEAD, "agents/lead.md")).toBe("[g](../../docs/guide.md) [w](../warm/SKILL.md)");
    expect(installed.verbatim).toEqual(["agents/lead.md: ../../docs/guide.md"]);
    expect(installed.rewritten).toBe(1);

    // The target outside the root, the copy inside it.
    const inside = cursorLike();
    expect(inside.rewrite("[x](../../../../outside/x.md)", WARM, "warm/SKILL.md")).toBe("[x](../../../../outside/x.md)");
    expect(inside.verbatim).toEqual(["warm/SKILL.md: ../../../../outside/x.md"]);
  });

  it("masks only the links that leave the mirror -- the ones spelled for where it was generated", () => {
    const inside = mirrorPathsOf(["agents/lead.md", "warm/SKILL.md", "AGENTS.md"]);
    expect([...inside].sort()).toEqual([".", "AGENTS.md", "agents", "agents/lead.md", "warm", "warm/SKILL.md"]);
    const here = "[w](../warm/SKILL.md) [d](../warm/) [a](../AGENTS.md#x) [g](../../../docs/guide.md) [s](https://x.io) [f](#top)";
    const there = "[w](../warm/SKILL.md) [d](../warm/) [a](../AGENTS.md#x) [g](../../docs/guide.md) [s](https://x.io) [f](#top)";
    expect(maskLinksOutOfMirror(here, "agents/lead.md", inside)).toBe(maskLinksOutOfMirror(there, "agents/lead.md", inside));
    // A link INSIDE the mirror is never masked, so an edit to one still differs.
    const moved = there.replace("../warm/SKILL.md", "../ship/SKILL.md");
    expect(maskLinksOutOfMirror(here, "agents/lead.md", inside)).not.toBe(maskLinksOutOfMirror(moved, "agents/lead.md", inside));
    // Nor is the prose around a masked link.
    expect(maskLinksOutOfMirror(`${here}!`, "agents/lead.md", inside)).not.toBe(maskLinksOutOfMirror(there, "agents/lead.md", inside));
  });

  it("names a declined link once per file, sorted", () => {
    const installed = cursorLike(resolve("/elsewhere/cursor"));
    installed.rewrite("[g](../../docs/b.md) [g](../../docs/b.md) [a](../../docs/a.md)", LEAD, "agents/lead.md");
    expect(installed.verbatim).toEqual(["agents/lead.md: ../../docs/a.md", "agents/lead.md: ../../docs/b.md"]);
  });
});

describe("resolveLinkOptions", () => {
  it("resolves every end through symlinks, an --out that does not exist yet included", () => {
    const root = tree();
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-links-alias-"))), "alias");
    symlinkSync(root, link);
    const options = resolveLinkOptions({
      root: link,
      sourceDir: join(link, "plugin", "skills"),
      agentsDir: null,
      rulesFile: join(link, "plugin", "rules", "house.md"),
      outDir: join(link, "surfaces", "not-yet", "cursor"),
    });
    expect(options).toEqual({
      root,
      sourceDir: join(root, "plugin", "skills"),
      agentsDir: null,
      rulesFile: join(root, "plugin", "rules", "house.md"),
      outDir: join(root, "surfaces", "not-yet", "cursor"),
    });
  });
});

// ---------------------------------------------------------------------------
// A whole mirror, over the fixture tree
// ---------------------------------------------------------------------------

describe("a whole mirror at the depth a consumer commits it at", () => {
  for (const surface of MIRRORED) {
    it(`${surface}: every relative link in every generated file resolves`, async () => {
      const root = tree();
      const out = join(root, "surfaces", surface);
      const result = await generate(root, surface, out);
      expect(result.code).toBe(0);
      const verdict = danglingLinks(out);
      expect(verdict.dangling).toEqual([]);
      expect(verdict.total).toBeGreaterThan(10);
    });
  }

  it("the OLD generation dangles in every class the issue's evidence table names -- so the guard port can see the defect", () => {
    const root = tree();
    const dangling = new Map<string, readonly string[]>();
    for (const surface of MIRRORED) {
      const out = join(root, "surfaces", surface);
      writeOldGeneration(root, surface, out);
      dangling.set(surface, danglingLinks(out).dangling);
    }
    // antigravity: the nested skills are one directory deeper than the source.
    expect(dangling.get("antigravity")).toContain("skills/warm/SKILL.md\t../../../docs/guide.md");
    expect(dangling.get("antigravity")).toContain("skills/warm/SKILL.md\t../../../scripts/tool.sh");
    expect(dangling.get("antigravity")).toContain("skills/warm/SKILL.md\t../../../templates/graph.example.json");
    // cursor and antigravity agents: at another depth than the source (one
    // level deeper here), and no skills/ in a flat mirror.
    expect(dangling.get("cursor")).toContain("agents/lead.md\t../../docs/guide.md");
    expect(dangling.get("cursor")).toContain("agents/lead.md\t../skills/warm/SKILL.md");
    expect(dangling.get("antigravity")).toContain("agents/lead.md\t../../docs/guide.md");
    // codex: AGENTS.md at the root, and the persona bodies in the TOML files.
    expect(dangling.get("codex")).toContain("AGENTS.md\t../skills/warm/SKILL.md");
    expect(dangling.get("codex")).toContain("agents/lead.toml\t../skills/warm/SKILL.md");
    expect(dangling.get("codex")).toContain("agents/lead.toml\t../../docs/guide.md");
    // the flat skills' persona links, on both flat rows.
    expect(dangling.get("codex")).toContain("ship/SKILL.md\t../../agents/scout.md");
    expect(dangling.get("cursor")).toContain("ship/SKILL.md\t../../agents/scout.md");
    // the rules file: its copy sits at another depth than its source, and the
    // skills it names are no longer under a skills/ directory.
    expect(dangling.get("cursor")).toContain("rules/house.mdc\t../skills/warm/SKILL.md");
  });

  it("codex: the flat skills, the AGENTS.md sections and the persona TOML bodies, each spelled for its own depth", async () => {
    const root = tree();
    const out = join(root, "surfaces", "codex");
    await generate(root, "codex", out);
    const warm = readFileSync(join(out, "warm", "SKILL.md"), "utf8");
    // `plugin/skills/<name>` and `surfaces/codex/<name>` sit equally deep in
    // this layout, so a link out of the mirror keeps its spelling here.
    expect(warm).toContain("[the guide](../../../docs/guide.md)");
    // A persona has no file on this row; its copy is its AGENTS.md section.
    expect(warm).toContain("[the lead](../AGENTS.md#duties)");
    expect(warm).toContain("[the preamble](../AGENTS.md#_preamble)");
    // Codex has no rules file, so a link to one lands on the source on disk.
    expect(warm).toContain("[the house rules](../../../plugin/rules/house.md)");
    // A note beside the skill in the source is reached where it is.
    expect(warm).toContain("[notes](../../../plugin/skills/warm/references/notes.md)");
    const appendix = readFileSync(join(out, "AGENTS.md"), "utf8");
    expect(appendix).toContain("[warm](warm/SKILL.md)");
    expect(appendix).toContain("[the scout](#scout)");
    expect(appendix).toContain("[the lead](#duties)");
    expect(appendix).toContain("[ship](ship/SKILL.md)");
    const toml = readFileSync(join(out, "agents", "lead.toml"), "utf8");
    expect(toml).toContain("[warm](../warm/SKILL.md)");
    expect(toml).toContain("[the guide](../../../docs/guide.md)");
    expect(toml).toContain("[the scout](../AGENTS.md#scout)");
  });

  it("cursor: the personas, the rules file and the skills that point at both", async () => {
    const root = tree();
    const out = join(root, "surfaces", "cursor");
    await generate(root, "cursor", out);
    const lead = readFileSync(join(out, "agents", "lead.md"), "utf8");
    expect(lead).toContain("[warm](../warm/SKILL.md)");
    expect(lead).toContain("[the guide](../../../docs/guide.md)");
    expect(lead).toContain("[the scout](scout.md)");
    expect(readFileSync(join(out, "agents", "_preamble.md"), "utf8")).toContain("[the guide](../../../docs/guide.md)");
    const rules = readFileSync(join(out, "rules", "house.mdc"), "utf8");
    expect(rules).toContain("[warm](../warm/SKILL.md)");
    expect(rules).toContain("[guide](../../../docs/guide.md#setup)");
    const warm = readFileSync(join(out, "warm", "SKILL.md"), "utf8");
    expect(warm).toContain("[the lead](../agents/lead.md#duties)");
    expect(warm).toContain("[the house rules](../rules/house.mdc)");
    expect(warm).toContain("[directory](../ship/)");
  });

  it("antigravity: the nested skills, every form and every suffix, and what is carried as written", async () => {
    const root = tree();
    const out = join(root, "surfaces", "antigravity");
    await generate(root, "antigravity", out);
    const warm = readFileSync(join(out, "skills", "warm", "SKILL.md"), "utf8");
    for (const expected of [
      "[the guide](../../../../docs/guide.md)",
      "[setup](../../../../docs/guide.md#setup)",
      '[a template](../../../../templates/graph.example.json "the template")',
      "[`tool.sh`](<../../../../scripts/tool.sh>)",
      "![diagram](../../../../docs/diagram.svg)",
      "[ship](../ship/SKILL.md)",
      "[directory](../ship/)",
      "[the lead](../../agents/lead.md#duties)",
      "[the preamble](../../agents/_preamble.md)",
      "[the house rules](../../rules/house.md)",
      "[guide-ref]: ../../../../docs/guide.md",
      "[fenced](../../../../docs/guide.md)",
      "[a site](https://example.com/x.md)",
      "[mail](mailto:someone@example.com)",
      "[this page](#warm)",
      "[a system file](/etc/hosts)",
    ]) {
      expect(warm).toContain(expected);
    }
  });

  it("reports the count, the tree and the (empty) list under --json, appended after every earlier key", async () => {
    const root = tree();
    const result = await generate(root, "cursor", join(root, "surfaces", "cursor"), ["--json"]);
    const document = json(result);
    expect(Object.keys(document).slice(-4)).toEqual(["includes", "linkRoot", "linksRewritten", "linksVerbatim"]);
    expect(document["linkRoot"]).toBe(root);
    expect(document["linksRewritten"]).toBeGreaterThan(0);
    expect(document["linksVerbatim"]).toEqual([]);
    const text = await generate(root, "cursor", join(root, "surfaces", "cursor-text"));
    expect(text.out.filter((line): boolean => line.startsWith("links"))).toEqual([
      `links re-aimed for this mirror's depth: ${String(document["linksRewritten"])}`,
    ]);
  });
});

describe("the tree a rewritten link may reach", () => {
  it("leaves a link out of the mirror AS WRITTEN when --out is outside --repo, names it, and still re-aims links between mirrored items", async () => {
    const root = tree();
    const installed = realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-links-installed-")));
    const result = await generate(root, "cursor", installed, ["--json"]);
    expect(result.code).toBe(0);
    const verbatim = json(result)["linksVerbatim"] as readonly string[];
    expect(verbatim).toContain("agents/lead.md: ../../docs/guide.md");
    expect(verbatim).toContain("warm/SKILL.md: ../../../docs/guide.md#setup");
    expect(verbatim).toContain("warm/SKILL.md: references/notes.md");
    const lead = readFileSync(join(installed, "agents", "lead.md"), "utf8");
    expect(lead).toContain("[the guide](../../docs/guide.md)");
    expect(lead).toContain("[warm](../warm/SKILL.md)");
    // Nothing that crosses between two mirrored items dangles, installed or not.
    for (const entry of danglingLinks(installed).dangling) {
      expect(verbatim.some((declined): boolean => entry === declined.replace(": ", "\t"))).toBe(true);
    }
    const text = await generate(root, "cursor", installed);
    expect(text.out.some((line): boolean => line.startsWith(`links left as written (the target or the copy is outside ${root}, the tree --repo names): `))).toBe(true);
  });

  it("without --repo the working directory is the tree", async () => {
    const root = tree();
    const out = join(root, "surfaces", "cursor");
    const result = await capture(["surface", "mirror", "generate", ...inputs(root, "cursor"), "--out", out, "--json"]);
    expect(result.code).toBe(0);
    expect(json(result)["linkRoot"]).toBe(realpathSync(process.cwd()));
    // The fixture tree sits outside this checkout, so every link out of the mirror is carried as written.
    expect(readFileSync(join(out, "agents", "lead.md"), "utf8")).toContain("[the guide](../../docs/guide.md)");
    expect(json(result)["linksVerbatim"]).toContain("agents/lead.md: ../../docs/guide.md");
  });

  it("a mirror reached through a symlink regenerates to the committed bytes, so check --installed on it is clean", async () => {
    const root = tree();
    const committed = join(root, "surfaces", "antigravity");
    await generate(root, "antigravity", committed);
    const link = join(realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-links-plugin-"))), "plugin");
    symlinkSync(committed, link);
    const result = await capture([
      "surface", "mirror", "check", ...inputs(root, "antigravity"), "--installed", link, "--repo", root, "--json",
    ]);
    expect(result.code).toBe(0);
    expect(json(result)["handEdited"]).toEqual([]);
  });

  it("a COPIED install, fresh from generate, is stale (links aimed from elsewhere) and never hand-edited", async () => {
    // Nobunaga's repro: `cp -R surfaces/antigravity <elsewhere>` right after a
    // regeneration read handEdited for every file whose links leave the mirror.
    const root = tree();
    const committed = join(root, "surfaces", "antigravity");
    await generate(root, "antigravity", committed);
    const installed = join(realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-links-copy-"))), "installed-ag");
    cpSync(committed, installed, { recursive: true });
    const args = ["surface", "mirror", "check", ...inputs(root, "antigravity"), "--installed", installed, "--repo", root];
    const result = await capture([...args, "--json"]);
    expect(result.code).toBe(1);
    const report = json(result);
    expect(report["handEdited"]).toEqual([]);
    // Exactly the files with a link OUT of the mirror; the rest are byte-identical.
    expect(report["stale"]).toEqual(["agents/_preamble.md", "agents/lead.md", "rules/house.md", "skills/warm/SKILL.md"]);
    expect(report["ok"]).toEqual(["agents/scout.md", "skills/ship/SKILL.md"]);
    // The reason is text only: the --json shape is the contract's, unchanged.
    expect(Object.keys(report)).toEqual(["contract", "surface", "ok", "missing", "extra", "stale", "handEdited", "installed", "stamp"]);
    const text = await capture(args);
    expect(text.out).toContain(
      "stale because their links out of the mirror are aimed from another location (a copied install, or a generate run from another root or --repo; regenerate here to heal): agents/_preamble.md, agents/lead.md, rules/house.md, skills/warm/SKILL.md",
    );

    // A real edit in the copy is still a hand edit -- to the prose, or to a
    // link INSIDE the mirror, which reads the same wherever the mirror sits.
    const lead = join(installed, "agents", "lead.md");
    writeFileSync(lead, readFileSync(lead, "utf8").replace("[warm](../skills/warm/SKILL.md)", "[warm](../skills/ship/SKILL.md)"));
    const scout = join(installed, "agents", "scout.md");
    writeFileSync(scout, `${readFileSync(scout, "utf8")}an edit\n`);
    const edited = json(await capture([...args, "--json"]));
    expect(edited["handEdited"]).toEqual(["agents/lead.md", "agents/scout.md"]);
  });

  it("a check run from another root than the generate calls the moved files stale, naming why in text", async () => {
    const root = tree();
    const out = join(root, "surfaces", "cursor");
    await generate(root, "cursor", out);
    // No --repo: the working directory (this checkout) is the tree, so the
    // fresh generation carries every link out of the mirror as written.
    const args = ["surface", "mirror", "check", ...inputs(root, "cursor"), "--out", out];
    const result = await capture([...args, "--json"]);
    expect(result.code).toBe(1);
    expect(json(result)["handEdited"]).toEqual([]);
    expect(json(result)["stale"]).toContain("agents/lead.md");
    expect(Object.keys(json(result))).not.toContain("relocated");
    expect((await capture(args)).out.some((line): boolean => line.startsWith("stale because their links out of the mirror are aimed from another location"))).toBe(true);
    // From the same root it is clean.
    expect((await check(root, "cursor", out)).code).toBe(0);
  });

  it("the verbatim claude-code row rewrites nothing: an installed plugin copy is its source, links and all", async () => {
    const root = tree();
    const installed = realpathSync(mkdtempSync(join(tmpdir(), "nen-surface-links-claude-")));
    cpSync(join(root, "plugin", "skills"), join(installed, "skills"), { recursive: true });
    cpSync(join(root, "plugin", "agents"), join(installed, "agents"), { recursive: true });
    const result = await capture([
      "surface", "mirror", "check", "--source", join(root, "plugin", "skills"), "--agents", join(root, "plugin", "agents"),
      "--surface", "claude-code", "--installed", installed, "--repo", root, "--json",
    ]);
    expect(result.code).toBe(0);
  });

  it("refuses a --repo that does not exist, or is empty, at exit 2", async () => {
    const root = tree();
    const missing = await capture([
      "surface", "mirror", "generate", ...inputs(root, "cursor"), "--out", join(root, "surfaces", "cursor"), "--repo", join(root, "absent"),
    ]);
    expect(missing.code).toBe(2);
    expect(missing.err.join("\n")).toMatch(/does not exist/);
    const empty = await capture(["surface", "mirror", "generate", ...inputs(root, "cursor"), "--out", join(root, "surfaces", "cursor"), "--repo", ""]);
    expect(empty.code).toBe(2);
    expect(empty.err.join("\n")).toMatch(/--repo was given an empty value/);
    expect(existsSync(join(root, "surfaces", "cursor"))).toBe(false);
  });

  it("applies the rules limit to the RE-AIMED bytes, refusing a file its links pushed over it", async () => {
    const root = tree();
    // Twenty links that each gain one `../` in antigravity's rules/ directory,
    // padded to sit 30 bytes under the row's limit (bytes: the unit the page
    // states it in) as the source spells them -- the row's own frontmatter
    // and the marker counted, all ASCII so a byte is a character.
    const links = Array.from({ length: 20 }, (_, index): string => `- [g${index}](../../docs/guide.md)`).join("\n");
    const front = (row("antigravity").rules?.frontmatter ?? "").replace("{name}", "house");
    const marker = "<!-- GENERATED by nen surface mirror (surface: antigravity) -- do not edit; edit the source and regenerate -->\n";
    const pad = ANTIGRAVITY_RULES_LIMIT - 30 - front.length - marker.length - links.length - 2;
    writeFileSync(join(root, "plugin", "rules", "house.md"), `${"x".repeat(pad)}\n${links}\n`);
    const result = await generate(root, "antigravity", join(root, "surfaces", "antigravity"));
    expect(result.code).toBe(2);
    expect(result.err.join("\n")).toContain(
      `renders to ${ANTIGRAVITY_RULES_LIMIT + 30} bytes at rules/house.md, over the ${ANTIGRAVITY_RULES_LIMIT}-byte limit`,
    );
  });
});

// ---------------------------------------------------------------------------
// check, against a mirror an older build wrote
// ---------------------------------------------------------------------------

describe("check against a mirror a build before #270 wrote", () => {
  it("calls every file whose links now move STALE -- regeneration forced, and not hand-edited", async () => {
    for (const surface of MIRRORED) {
      const root = tree();
      const out = join(root, "surfaces", surface);
      const old = writeOldGeneration(root, surface, out);
      const result = await check(root, surface, out);
      expect(result.code).toBe(1);
      const report = json(result);
      expect(report["handEdited"]).toEqual([]);
      expect(report["missing"]).toEqual([]);
      expect(report["extra"]).toEqual([]);
      const stale = report["stale"] as readonly string[];
      expect(stale.length).toBeGreaterThan(0);
      // Exactly the files whose bytes the re-aimed links change; the rest are ok.
      const ok = report["ok"] as readonly string[];
      expect([...stale, ...ok].sort()).toEqual(old.map((file): string => file.path).sort());
      for (const path of stale) expect(readFileSync(join(out, ...path.split("/")), "utf8")).toContain("](");

      // Regenerating heals it.
      expect((await generate(root, surface, out)).code).toBe(0);
      expect((await check(root, surface, out)).code).toBe(0);
    }
  });

  it("is stale under --stamp as well, where the stamp itself matches", async () => {
    const root = tree();
    const out = join(root, "surfaces", "cursor");
    writeOldGeneration(root, "cursor", out, "1.2.3");
    const result = await check(root, "cursor", out, ["--stamp", "1.2.3"]);
    expect(result.code).toBe(1);
    expect(json(result)["stale"]).toContain("agents/lead.md");
    expect(json(result)["handEdited"]).toEqual([]);
  });

  it("still calls an old file that was ALSO edited by hand hand-edited", async () => {
    const root = tree();
    const out = join(root, "surfaces", "cursor");
    writeOldGeneration(root, "cursor", out);
    const path = join(out, "agents", "lead.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}an edit\n`);
    const report = json(await check(root, "cursor", out));
    expect(report["handEdited"]).toEqual(["agents/lead.md"]);
    expect(report["stale"]).not.toContain("agents/lead.md");
  });

  it("carries the old bytes only on a file whose links moved, and none without link options", () => {
    const root = tree();
    const agents = readSourceAgentsReport(join(root, "plugin", "agents"));
    const base = {
      row: row("cursor"),
      skills: readSourceSkills(join(root, "plugin", "skills")),
      agents: agents.agents,
      includes: agents.includes,
      invocationPrefix: "demo:",
    };
    const without = generateSurfaceMirrorReport(base);
    expect(without.files.every((file): boolean => file.beforeLinkRewrite === undefined)).toBe(true);
    expect(without.linksRewritten).toBe(0);
    expect(without.linksVerbatim).toEqual([]);

    const out = join(root, "surfaces", "cursor");
    const withLinks = generateSurfaceMirrorReport({
      ...base,
      links: resolveLinkOptions({ root, sourceDir: join(root, "plugin", "skills"), agentsDir: join(root, "plugin", "agents"), rulesFile: null, outDir: out }),
    });
    const moved = withLinks.files.filter((file): boolean => file.beforeLinkRewrite !== undefined).map((file): string => file.path);
    expect(moved).toEqual(["agents/_preamble.md", "agents/lead.md", "agents/scout.md", "ship/SKILL.md", "warm/SKILL.md"]);
    // The old bytes are exactly the generation without links.
    for (const file of withLinks.files) {
      const before = without.files.find((candidate): boolean => candidate.path === file.path);
      expect(file.beforeLinkRewrite ?? file.content).toBe(before?.content);
    }
    // And checkSurfaceMirror reads them.
    writeSurfaceMirror(out, without.files, row("cursor"));
    expect(checkSurfaceMirror(out, withLinks.files, row("cursor")).stale).toEqual(moved);
  });
});
