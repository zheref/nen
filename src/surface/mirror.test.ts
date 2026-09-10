// src/surface/mirror.test.ts -- the generator and the drift check, over the
// fixture skills directory beside this file (two skills, one persona) and BOTH
// shipped surfaces.
//
// The fixture is deliberately awkward in the two ways a real skills directory
// is: `alpha` carries a wrapped `description:`, a block-style list and keys only
// one of the two surfaces reads; `beta` carries a one-line description and a
// second list. Between them every frontmatter shape ./frontmatter.ts claims to
// handle is exercised by a real file rather than by a string in a test.

import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { splitDocument } from "./frontmatter.js";
import {
  checkSurfaceMirror,
  generateSurfaceMirror,
  markerFor,
  mirrorReportOk,
  readMarker,
  readSourceAgents,
  readSourceSkills,
  rewriteInvocations,
  SurfaceMirrorError,
  universeFiles,
  writeSurfaceMirror,
  type GeneratedFile,
} from "./mirror.js";
import { findSurface, type SurfaceRow } from "./rules.js";

const FIXTURES = join(process.cwd(), "src", "surface", "fixtures");
const SKILLS = join(FIXTURES, "skills");
const AGENTS = join(FIXTURES, "agents");
const PREFIX = "demo:";

function row(name: string): SurfaceRow {
  const found = findSurface(name);
  if (found === undefined) throw new Error(`no row for ${name}`);
  return found;
}

function generate(surface: string, withAgents = true): readonly GeneratedFile[] {
  return generateSurfaceMirror({
    row: row(surface),
    skills: readSourceSkills(SKILLS),
    agents: withAgents ? readSourceAgents(AGENTS) : [],
    invocationPrefix: PREFIX,
  });
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "nen-surface-"));
}

/** Write a mirror, then hand back the directory it went into. */
function materialize(surface: string): { out: string; files: readonly GeneratedFile[] } {
  const out = tempDir();
  const files = generate(surface);
  writeSurfaceMirror(out, files, row(surface));
  return { out, files };
}

const at = (files: readonly GeneratedFile[], path: string): string => {
  const found = files.find((file): boolean => file.path === path);
  if (found === undefined) throw new Error(`no generated file at ${path}, only ${files.map((f): string => f.path).join(", ")}`);
  return found.content;
};

describe("reading the source", () => {
  it("finds every <name>/SKILL.md, sorted, and nothing else", () => {
    expect(readSourceSkills(SKILLS).map((skill): string => skill.name)).toEqual(["alpha", "beta"]);
  });

  it("refuses a directory with no SKILL.md rather than mirroring an empty set", () => {
    // An empty generation would delete the whole mirror as orphaned, so the one
    // plausible typo -- --source pointed one level too high -- must refuse.
    expect(() => readSourceSkills(FIXTURES)).toThrow(SurfaceMirrorError);
    expect(() => readSourceSkills(FIXTURES)).toThrow(/holds no <name>\/SKILL\.md/);
  });

  it("refuses a --source that is not there at all, naming the flag", () => {
    expect(() => readSourceSkills(join(tempDir(), "absent"))).toThrow(/--source/);
  });

  it("reads personas, taking the name from frontmatter and falling back to the filename", () => {
    expect(readSourceAgents(AGENTS).map((agent): string => `${agent.stem}=${agent.name}`)).toEqual(["scout=scout"]);
    const dir = tempDir();
    writeFileSync(join(dir, "no-frontmatter.md"), "just prose\n");
    writeFileSync(join(dir, "named.md"), "---\nname: Renamed\n---\nprose\n");
    writeFileSync(join(dir, "ignored.txt"), "not markdown");
    expect(readSourceAgents(dir).map((agent): string => agent.name)).toEqual(["Renamed", "no-frontmatter"]);
  });

  it("allows an EMPTY agents directory -- a repo with no personas is not an error", () => {
    expect(readSourceAgents(tempDir())).toEqual([]);
  });
});

describe("the generated marker", () => {
  it("is the first MARKDOWN line, never line 1 -- the frontmatter fence must come first", () => {
    // A marker above the fence means the surface sees no frontmatter and does
    // not load the skill at all: a "do not edit" banner bought at the price of
    // the document.
    const content = at(generate("cursor"), "alpha/SKILL.md");
    expect(content.startsWith("---\n")).toBe(true);
    expect(splitDocument(content).body.split("\n")[0]).toBe(markerFor("cursor"));
  });

  it("IS line 1 of a document that has no frontmatter", () => {
    const content = at(generate("codex"), "AGENTS.md");
    expect(content.split("\n")[0]).toBe(markerFor("codex"));
  });

  it("is pure ASCII, so a Windows checkout compares byte for byte", () => {
    // An em dash or a smart quote is a drift class nobody asked for: this line
    // is written into somebody else's repository and read back byte for byte.
    expect(/^[\x20-\x7e]+$/.test(markerFor("codex"))).toBe(true);
  });

  it("reads its surface back out, and reports null for a file that carries none", () => {
    expect(readMarker(at(generate("codex"), "beta/SKILL.md"))).toBe("codex");
    expect(readMarker("---\nname: x\n---\n\nhand written\n")).toBeNull();
    expect(readMarker("plain prose")).toBeNull();
    // A marker-shaped line further DOWN is not the marker (../canon/mirror.ts's
    // own anchoring argument).
    expect(readMarker(`# title\n\n${markerFor("codex")}\n`)).toBeNull();
  });
});

describe("frontmatter is reduced to what the surface documents", () => {
  it("keeps only name and description for the surface that reads only those", () => {
    const front = splitDocument(at(generate("codex"), "alpha/SKILL.md")).entries.map((entry): string => entry.key);
    expect(front).toEqual(["name", "description"]);
  });

  it("keeps the richer surface's own documented keys, and drops the rest", () => {
    const front = splitDocument(at(generate("cursor"), "alpha/SKILL.md")).entries.map((entry): string => entry.key);
    expect(front).toEqual(["name", "description", "metadata"]);
    expect(front).not.toContain("allowed-tools");
    expect(front).not.toContain("license");
    expect(front).not.toContain("model");
  });

  it("keeps the body byte for byte under the marker", () => {
    const source = readFileSync(join(SKILLS, "beta", "SKILL.md"), "utf8");
    const sourceBody = splitDocument(source).body;
    const mirrored = splitDocument(at(generate("codex"), "beta/SKILL.md")).body;
    // The marker line plus the source's own body, with only the invocation
    // rewrite applied to it.
    expect(mirrored).toBe(`${markerFor("codex")}\n${sourceBody.replace(/demo:beta/g, "$beta")}`);
  });

  it("refuses a skill missing a key the surface documents as required", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "nameless"));
    writeFileSync(join(dir, "nameless", "SKILL.md"), "---\nname: nameless\n---\n\nno description\n");
    expect(() =>
      generateSurfaceMirror({
        row: row("codex"),
        skills: readSourceSkills(dir),
        agents: [],
        invocationPrefix: null,
      }),
    ).toThrow(/has no 'description'/);
  });

  it("refuses a SKILL.md with no frontmatter at all", () => {
    const dir = tempDir();
    mkdirSync(join(dir, "bare"));
    writeFileSync(join(dir, "bare", "SKILL.md"), "# bare\n");
    expect(() =>
      generateSurfaceMirror({ row: row("codex"), skills: readSourceSkills(dir), agents: [], invocationPrefix: null }),
    ).toThrow(/no '---' frontmatter block/);
  });
});

describe("invocation rewriting", () => {
  it("rewrites every <prefix><name> mention into the surface's own spelling", () => {
    const cursor = at(generate("cursor"), "alpha/SKILL.md");
    expect(cursor).toContain("/alpha");
    expect(cursor).toContain("/beta");
    expect(cursor).not.toContain(PREFIX);
    expect(at(generate("codex"), "alpha/SKILL.md")).toContain("$beta");
  });

  it("rewrites inside the frontmatter too -- a description is read by the surface", () => {
    const description = splitDocument(at(generate("codex"), "alpha/SKILL.md")).entries[1];
    expect(description?.lines.join("\n")).toContain("$alpha");
  });

  it("leaves a bare word that merely LOOKS like a name alone", () => {
    expect(rewriteInvocations("alpha is a word", row("cursor"), PREFIX)).toBe("alpha is a word");
  });

  it("does not rewrite a prefix glued to a preceding word character", () => {
    expect(rewriteInvocations("xdemo:alpha", row("cursor"), PREFIX)).toBe("xdemo:alpha");
  });

  it("rewrites nothing without a prefix -- the source's namespace is caller data", () => {
    expect(rewriteInvocations("demo:alpha", row("cursor"), null)).toBe("demo:alpha");
    expect(rewriteInvocations("demo:alpha", row("cursor"), "")).toBe("demo:alpha");
  });

  it("leaves the mention UNCHANGED for a surface documenting no spelling", () => {
    // Never invent a syntax nobody documented.
    const silent: SurfaceRow = { ...row("codex"), invocation: null };
    expect(rewriteInvocations("demo:alpha", silent, PREFIX)).toBe("demo:alpha");
  });
});

describe("personas", () => {
  it("become one file apiece where the surface documents subagent files", () => {
    const content = at(generate("cursor"), "agents/scout.md");
    const keys = splitDocument(content).entries.map((entry): string => entry.key);
    expect(keys).toEqual(["name", "description", "model"]);
    // `tools` and `color` are not documented subagent keys on this surface.
    expect(keys).not.toContain("tools");
    expect(keys).not.toContain("color");
  });

  it("become sections of one prose document where the surface documents none", () => {
    const content = at(generate("codex"), "AGENTS.md");
    expect(content).toContain("## scout");
    // The persona's frontmatter is dropped WHOLE -- a stray fence in the middle
    // of a prose document renders as a horizontal rule.
    expect(content).not.toContain("model: sonnet");
    expect(content).not.toContain("\n---\n");
    expect(content).toContain("Scout reads and reports.");
  });

  it("are absent entirely when no --agents directory was given", () => {
    expect(generate("codex", false).map((file): string => file.path)).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
    expect(generate("cursor", false).map((file): string => file.path)).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
  });

  it("puts every generated path in a deterministic, sorted order", () => {
    expect(generate("codex").map((file): string => file.path)).toEqual([
      "AGENTS.md",
      "alpha/SKILL.md",
      "beta/SKILL.md",
    ]);
    expect(generate("cursor").map((file): string => file.path)).toEqual([
      "agents/scout.md",
      "alpha/SKILL.md",
      "beta/SKILL.md",
    ]);
  });
});

describe("writing", () => {
  it("writes everything the first time and nothing the second", () => {
    const { out, files } = materialize("cursor");
    expect(readdirSync(out).sort()).toEqual(["agents", "alpha", "beta"]);
    const again = writeSurfaceMirror(out, files, row("cursor"));
    expect(again.written).toEqual([]);
    expect(again.unchanged).toEqual(["agents/scout.md", "alpha/SKILL.md", "beta/SKILL.md"]);
  });

  it("rewrites only the file whose content changed", () => {
    const { out, files } = materialize("codex");
    writeFileSync(join(out, "beta", "SKILL.md"), `${markerFor("codex")}\ntampered\n`);
    const result = writeSurfaceMirror(out, files, row("codex"));
    expect(result.written).toEqual(["beta/SKILL.md"]);
    expect(result.unchanged).toEqual(["AGENTS.md", "alpha/SKILL.md"]);
  });

  it("deletes an orphan, and the directory it emptied", () => {
    const { out, files } = materialize("codex");
    mkdirSync(join(out, "ghost"));
    writeFileSync(join(out, "ghost", "SKILL.md"), `${markerFor("codex")}\ngone upstream\n`);
    const result = writeSurfaceMirror(out, files, row("codex"));
    expect(result.deleted).toEqual(["ghost/SKILL.md"]);
    expect(readdirSync(out).sort()).toEqual(["AGENTS.md", "alpha", "beta"]);
  });

  it("leaves a skill directory that still holds something else", () => {
    const { out, files } = materialize("codex");
    mkdirSync(join(out, "ghost"));
    writeFileSync(join(out, "ghost", "SKILL.md"), `${markerFor("codex")}\ngone\n`);
    writeFileSync(join(out, "ghost", "reference.md"), "somebody else's file\n");
    writeSurfaceMirror(out, files, row("codex"));
    expect(readdirSync(join(out, "ghost"))).toEqual(["reference.md"]);
  });

  it("never touches a file outside the mirror's own filename universe", () => {
    const { out, files } = materialize("codex");
    writeFileSync(join(out, "README.md"), "hand written, and not a SKILL.md\n");
    mkdirSync(join(out, "notes"));
    writeFileSync(join(out, "notes", "thoughts.md"), "also not a SKILL.md\n");
    const result = writeSurfaceMirror(out, files, row("codex"));
    expect(result.deleted).toEqual([]);
    expect(readFileSync(join(out, "README.md"), "utf8")).toContain("hand written");
  });

  it("REFUSES to overwrite a destination that carries no marker, before writing anything", () => {
    const out = tempDir();
    mkdirSync(join(out, "alpha"));
    writeFileSync(join(out, "alpha", "SKILL.md"), "hand written\n");
    const files = generate("codex");
    expect(() => writeSurfaceMirror(out, files, row("codex"))).toThrow(SurfaceMirrorError);
    // Nothing else was written either -- the guard runs over every destination
    // first, so a half-written mirror is not a possible outcome.
    expect(readdirSync(out)).toEqual(["alpha"]);
    expect(readFileSync(join(out, "alpha", "SKILL.md"), "utf8")).toBe("hand written\n");
  });

  it("refuses a hand-written AGENTS.md, which is the case the guard exists for", () => {
    const out = tempDir();
    writeFileSync(join(out, "AGENTS.md"), "# our project's own instructions\n");
    expect(() => writeSurfaceMirror(out, generate("codex"), row("codex"))).toThrow(/AGENTS\.md/);
  });

  it("OVERWRITES a marked file freely, hand edits included -- that is the self-healing", () => {
    const { out, files } = materialize("codex");
    writeFileSync(join(out, "AGENTS.md"), `${markerFor("codex")}\n\n## somebody's edit\n`);
    expect(writeSurfaceMirror(out, files, row("codex")).written).toEqual(["AGENTS.md"]);
    expect(readFileSync(join(out, "AGENTS.md"), "utf8")).toContain("## scout");
  });

  it("computes the same three lists on --dry-run and writes nothing", () => {
    const out = tempDir();
    const files = generate("cursor");
    const dry = writeSurfaceMirror(out, files, row("cursor"), true);
    expect(dry.written).toEqual(["agents/scout.md", "alpha/SKILL.md", "beta/SKILL.md"]);
    expect(readdirSync(out)).toEqual([]);
    // And a dry run over an existing mirror reports the orphan it would delete
    // without deleting it.
    writeSurfaceMirror(out, files, row("cursor"));
    mkdirSync(join(out, "ghost"));
    writeFileSync(join(out, "ghost", "SKILL.md"), `${markerFor("cursor")}\ngone\n`);
    expect(writeSurfaceMirror(out, files, row("cursor"), true).deleted).toEqual(["ghost/SKILL.md"]);
    expect(readdirSync(join(out, "ghost"))).toEqual(["SKILL.md"]);
  });
});

describe("universeFiles -- what the mirror considers its own", () => {
  it("is empty for a directory that does not exist", () => {
    expect(universeFiles(join(tempDir(), "absent"), row("codex"))).toEqual([]);
  });

  it("collects the skill files and the row's own persona location, and nothing else", () => {
    const { out } = materialize("cursor");
    writeFileSync(join(out, "README.md"), "not mine\n");
    writeFileSync(join(out, "agents", "notes.txt"), "not a .md\n");
    expect(universeFiles(out, row("cursor"))).toEqual(["agents/scout.md", "alpha/SKILL.md", "beta/SKILL.md"]);
  });

  it("collects the appendix document for the row that has one", () => {
    const { out } = materialize("codex");
    expect(universeFiles(out, row("codex"))).toEqual(["AGENTS.md", "alpha/SKILL.md", "beta/SKILL.md"]);
  });
});

describe("checking -- the four drift classes", () => {
  it("reports OK for a mirror straight out of generate", () => {
    const { out, files } = materialize("codex");
    const report = checkSurfaceMirror(out, files, row("codex"));
    expect(mirrorReportOk(report)).toBe(true);
    expect(report).toEqual({
      surface: "codex",
      ok: ["AGENTS.md", "alpha/SKILL.md", "beta/SKILL.md"],
      missing: [],
      extra: [],
      stale: [],
      handEdited: [],
    });
  });

  it("MISSING -- the source has it and the mirror does not", () => {
    const { out, files } = materialize("cursor");
    rmSync(join(out, "beta", "SKILL.md"));
    const report = checkSurfaceMirror(out, files, row("cursor"));
    expect(report.missing).toEqual(["beta/SKILL.md"]);
    expect(mirrorReportOk(report)).toBe(false);
  });

  it("EXTRA -- the mirror has it and the source does not", () => {
    const { out, files } = materialize("cursor");
    mkdirSync(join(out, "gamma"));
    writeFileSync(join(out, "gamma", "SKILL.md"), `${markerFor("cursor")}\nremoved upstream\n`);
    expect(checkSurfaceMirror(out, files, row("cursor")).extra).toEqual(["gamma/SKILL.md"]);
  });

  it("STALE -- generated, but for a different surface", () => {
    // The surface plays the role ../canon/mirror.ts's --ref plays: the mirror
    // really was generated, and really is not this one. Calling it hand-edited
    // would send its maintainer looking for an edit nobody made.
    const { out } = materialize("codex");
    const report = checkSurfaceMirror(out, generate("cursor"), row("cursor"));
    expect(report.stale).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
    expect(report.handEdited).toEqual([]);
  });

  it("HAND_EDITED -- marked for this surface, and not what a fresh generation says", () => {
    const { out, files } = materialize("codex");
    const path = join(out, "alpha", "SKILL.md");
    writeFileSync(path, `${readFileSync(path, "utf8")}\nsomebody's paragraph\n`);
    expect(checkSurfaceMirror(out, files, row("codex")).handEdited).toEqual(["alpha/SKILL.md"]);
  });

  it("HAND_EDITED -- the marker itself was deleted", () => {
    const { out, files } = materialize("codex");
    const path = join(out, "beta", "SKILL.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(`${markerFor("codex")}\n`, ""));
    expect(checkSurfaceMirror(out, files, row("codex")).handEdited).toEqual(["beta/SKILL.md"]);
  });

  it("reports a directory where a SKILL.md should be as missing, not as a crash", () => {
    const { out, files } = materialize("codex");
    rmSync(join(out, "alpha", "SKILL.md"));
    mkdirSync(join(out, "alpha", "SKILL.md"));
    expect(checkSurfaceMirror(out, files, row("codex")).missing).toEqual(["alpha/SKILL.md"]);
  });

  it("writes NOTHING, whatever it finds", () => {
    const { out, files } = materialize("codex");
    rmSync(join(out, "beta"), { recursive: true });
    const before = readdirSync(out).sort();
    checkSurfaceMirror(out, files, row("codex"));
    expect(readdirSync(out).sort()).toEqual(before);
  });

  it("regenerating heals every class at once", () => {
    const { out, files } = materialize("cursor");
    rmSync(join(out, "beta", "SKILL.md"));
    writeFileSync(join(out, "alpha", "SKILL.md"), `${markerFor("cursor")}\nedited\n`);
    mkdirSync(join(out, "gamma"));
    writeFileSync(join(out, "gamma", "SKILL.md"), `${markerFor("cursor")}\norphan\n`);
    writeSurfaceMirror(out, files, row("cursor"));
    expect(mirrorReportOk(checkSurfaceMirror(out, files, row("cursor")))).toBe(true);
  });

  it("creates the parent directory of a file it has never written", () => {
    const out = join(tempDir(), "not", "there", "yet");
    writeSurfaceMirror(out, generate("codex"), row("codex"));
    expect(readdirSync(dirname(join(out, "alpha", "SKILL.md")))).toEqual(["SKILL.md"]);
  });
});
