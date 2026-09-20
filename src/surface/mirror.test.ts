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
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { splitDocument } from "./frontmatter.js";
import {
  checkSurfaceMirror,
  descriptionText,
  firstSentence,
  generateSurfaceMirror,
  generateSurfaceMirrorReport,
  markerFor,
  markerText,
  mirrorReportOk,
  readMarker,
  readSourceAgents,
  readSourceAgentsReport,
  readSourceSkills,
  rewriteInvocations,
  SurfaceMirrorError,
  universeFiles,
  withoutStamp,
  writeSurfaceMirror,
  type GeneratedFile,
} from "./mirror.js";
import { readHooksManifest, readPermissions, readRules } from "./packs.js";
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
    expect(readMarker(at(generate("codex"), "beta/SKILL.md"))).toEqual({ surface: "codex", stamp: null });
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
    // `summary` follows `description` because alpha's description is over
    // the row's measured budget (zheref/nen#227); beta's one-liner is not.
    expect(front).toEqual(["name", "description", "summary", "metadata"]);
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

  it("refuses a persona that would mirror to a file with NO frontmatter", () => {
    // Both roads to the same empty block are refused, because the file that
    // would be written is the same file: nothing for the surface to route on.
    const dir = tempDir();
    writeFileSync(join(dir, "prose.md"), "just prose, no fence\n");
    const bare = (): unknown =>
      generateSurfaceMirror({
        row: row("cursor"),
        skills: readSourceSkills(SKILLS),
        agents: readSourceAgents(dir),
        invocationPrefix: null,
      });
    expect(bare).toThrow(SurfaceMirrorError);
    expect(bare).toThrow(/no '---' frontmatter block at all/);

    const onlyForeign = tempDir();
    writeFileSync(join(onlyForeign, "toolsy.md"), "---\ntools: Read, Grep\ncolor: blue\n---\n\nprose\n");
    expect(() =>
      generateSurfaceMirror({
        row: row("cursor"),
        skills: readSourceSkills(SKILLS),
        agents: readSourceAgents(onlyForeign),
        invocationPrefix: null,
      }),
    ).toThrow(/holds none of the keys this surface reads/);
  });

  it("accepts the same prose persona for a surface whose personas ARE prose", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "prose.md"), "just prose, no fence\n");
    const files = generateSurfaceMirror({
      row: row("codex"),
      skills: readSourceSkills(SKILLS),
      agents: readSourceAgents(dir),
      invocationPrefix: null,
    });
    expect(at(files, "AGENTS.md")).toContain("## prose");
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

  it("does NOT delete an UNMARKED orphan, however exactly it sits where one would", () => {
    // The hole the first cut had (zheref/nen#149, review): the write path
    // refused to OVERWRITE an unmarked SKILL.md and then deleted one whose
    // source had gone. Same file, same hand, destroyed instead of protected
    // because it happened to be orphaned rather than shadowed.
    const { out, files } = materialize("codex");
    mkdirSync(join(out, "handmade"));
    writeFileSync(join(out, "handmade", "SKILL.md"), "---\nname: handmade\n---\n\nsomebody's own skill\n");
    const result = writeSurfaceMirror(out, files, row("codex"));
    expect(result.deleted).toEqual([]);
    expect(readFileSync(join(out, "handmade", "SKILL.md"), "utf8")).toContain("somebody's own skill");
    // And check agrees, because both read the same list: an `extra` a
    // regenerate could not clear would be drift nobody can fix.
    expect(checkSurfaceMirror(out, files, row("codex")).extra).toEqual([]);
  });

  it("DOES delete an orphan marked for ANOTHER surface -- still this generator's output", () => {
    const { out, files } = materialize("codex");
    mkdirSync(join(out, "gamma"));
    writeFileSync(join(out, "gamma", "SKILL.md"), `${markerFor("cursor")}\nfrom another run\n`);
    expect(writeSurfaceMirror(out, files, row("codex")).deleted).toEqual(["gamma/SKILL.md"]);
  });

  it("leaves an unmarked persona file alone too, for both agent shapes", () => {
    const cursor = materialize("cursor");
    writeFileSync(join(cursor.out, "agents", "handmade.md"), "---\nname: handmade\n---\n\nours\n");
    expect(writeSurfaceMirror(cursor.out, cursor.files, row("cursor")).deleted).toEqual([]);

    const codex = materialize("codex");
    // An AGENTS.md that is not ours is protected on BOTH paths: not overwritten
    // (the clobber guard) and not deleted (this one), whichever way the run
    // arrives at it.
    const noAgents = generateSurfaceMirror({
      row: row("codex"),
      skills: readSourceSkills(SKILLS),
      agents: [],
      invocationPrefix: PREFIX,
    });
    writeFileSync(join(codex.out, "AGENTS.md"), "# our project's own instructions\n");
    expect(writeSurfaceMirror(codex.out, noAgents, row("codex")).deleted).toEqual([]);
    expect(readFileSync(join(codex.out, "AGENTS.md"), "utf8")).toContain("our project's own");
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

  it("round-trips a CRLF source: generate, then check, with no drift", () => {
    // `* text=auto` means a Windows checkout hands the generator `\r\n`. The
    // marker is written with a bare `\n` and read back off a `split("\n")`, so
    // the one thing that must hold is that a fresh generation of a CRLF source
    // equals what was written -- otherwise every file on one platform would
    // read as hand-edited.
    const source = tempDir();
    mkdirSync(join(source, "windows"));
    writeFileSync(
      join(source, "windows", "SKILL.md"),
      "---\r\nname: windows\r\ndescription: written on a CRLF checkout\r\n---\r\n\r\n# windows\r\n",
    );
    const files = generateSurfaceMirror({
      row: row("codex"),
      skills: readSourceSkills(source),
      agents: [],
      invocationPrefix: null,
    });
    const out = tempDir();
    writeSurfaceMirror(out, files, row("codex"));
    expect(readMarker(readFileSync(join(out, "windows", "SKILL.md"), "utf8"))?.surface).toBe("codex");
    expect(mirrorReportOk(checkSurfaceMirror(out, files, row("codex")))).toBe(true);
  });

  it("creates the parent directory of a file it has never written", () => {
    const out = join(tempDir(), "not", "there", "yet");
    writeSurfaceMirror(out, generate("codex"), row("codex"));
    expect(readdirSync(dirname(join(out, "alpha", "SKILL.md")))).toEqual(["SKILL.md"]);
  });
});

// ---------------------------------------------------------------------------
// zheref/nen#227: the stamped marker, the summary key, the shared include
// ---------------------------------------------------------------------------

describe("the stamped marker", () => {
  it("reads both forms back, and masks the stamp for a comparison that did not ask", () => {
    expect(readMarker(`${markerFor("codex", "0.43.0")}\n`)).toEqual({ surface: "codex", stamp: "0.43.0" });
    expect(readMarker(`# ${markerText("codex", "1.2.3")}\n[agents]\n`)).toEqual({ surface: "codex", stamp: "1.2.3" });
    expect(readMarker(`{"$generated": ${JSON.stringify(markerText("cursor"))}, "version": 1}`)).toEqual({ surface: "cursor", stamp: null });
    expect(readMarker('{"version": 1}')).toBeNull();
    expect(readMarker("{ not json")).toBeNull();
    expect(withoutStamp(`a\n${markerFor("codex", "0.43.0")}\nb`)).toBe(`a\n${markerFor("codex")}\nb`);
  });

  it("classes a file by its stamp only when check is given one", () => {
    const stamped = generateSurfaceMirror({ row: row("codex"), skills: readSourceSkills(SKILLS), agents: [], invocationPrefix: PREFIX, stamp: "0.42.0" });
    const out = tempDir();
    writeSurfaceMirror(out, stamped, row("codex"));
    const unstamped = generate("codex", false);
    expect(mirrorReportOk(checkSurfaceMirror(out, unstamped, row("codex")))).toBe(true);
    expect(checkSurfaceMirror(out, stamped, row("codex"), "0.42.0").ok).toHaveLength(2);
    const older = checkSurfaceMirror(out, stamped, row("codex"), "0.43.0");
    expect(older.stale).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
    expect(older.handEdited).toEqual([]);
  });

  it("reports a stamp that is not a version as stale, naming the file, rather than exiting 2 (N14)", () => {
    const stamped = generateSurfaceMirror({ row: row("codex"), skills: readSourceSkills(SKILLS), agents: [], invocationPrefix: PREFIX, stamp: "0.43.0" });
    const out = tempDir();
    writeSurfaceMirror(out, stamped, row("codex"));
    const path = join(out, "alpha", "SKILL.md");
    writeFileSync(path, readFileSync(path, "utf8").replace(markerFor("codex", "0.43.0"), markerFor("codex", "garbage")));
    expect(() => checkSurfaceMirror(out, stamped, row("codex"), "0.43.0")).not.toThrow();
    const report = checkSurfaceMirror(out, stamped, row("codex"), "0.43.0");
    expect(report.stale).toEqual(["alpha/SKILL.md"]);
    expect(report.ok).toEqual(["beta/SKILL.md"]);
    // Without --stamp the stamp is masked and it is not drift at all.
    expect(mirrorReportOk(checkSurfaceMirror(out, generate("codex", false), row("codex")))).toBe(true);
  });
});

describe("the description budget", () => {
  it("adds a summary of the first sentence, trimmed to the budget, and keeps the description whole", () => {
    const front = splitDocument(at(generate("cursor"), "alpha/SKILL.md")).entries;
    const summary = front.find((entry): boolean => entry.key === "summary");
    expect(summary?.lines).toEqual(["summary: Warm a working copy and cut"]);
    expect(front.find((entry): boolean => entry.key === "description")?.lines).toHaveLength(2);
    // Codex's budget is wider than either fixture description: no summary.
    const codex = splitDocument(at(generate("codex"), "alpha/SKILL.md")).entries;
    expect(codex.find((entry): boolean => entry.key === "summary")).toBeUndefined();
    const wide = generateSurfaceMirrorReport({ row: row("codex"), skills: readSourceSkills(SKILLS), agents: [], invocationPrefix: null });
    expect(wide.truncated).toEqual([]);
  });

  it("takes the first sentence, or the whole text when there is no sentence end", () => {
    expect(firstSentence("One. Two.", 100)).toBe("One.");
    expect(firstSentence("Is it? Yes", 100)).toBe("Is it?");
    expect(firstSentence("no terminal punctuation here", 100)).toBe("no terminal punctuation here");
    expect(firstSentence("a-very-long-single-token", 5)).toBe("a-ver");
    expect(descriptionText(splitDocument("---\ndescription: a\n  b\n---\n").entries)).toBe("a b");
  });

  it("leaves a summary the source already carries alone, and lists nothing", () => {
    const source = tempDir();
    mkdirSync(join(source, "own"));
    writeFileSync(join(source, "own", "SKILL.md"), `---\nname: own\ndescription: ${"long ".repeat(20)}\nsummary: mine\n---\nbody\n`);
    const report = generateSurfaceMirrorReport({ row: row("cursor"), skills: readSourceSkills(source), agents: [], invocationPrefix: null });
    expect(report.truncated).toEqual([]);
    expect(at(report.files, "own/SKILL.md")).toContain("summary: mine");
  });
});

describe("the shared include", () => {
  const read = readSourceAgentsReport(AGENTS);
  const withIncludes = (surface: string): readonly GeneratedFile[] =>
    generateSurfaceMirror({ row: row(surface), skills: readSourceSkills(SKILLS), agents: read.agents, includes: read.includes, invocationPrefix: PREFIX });

  it("is read as an include, never as a persona (zheref/nen#223), and nothing else is skipped", () => {
    expect(read.includes.map((include): string => include.relative)).toEqual(["_shared.md"]);
    expect(read.skipped).toEqual([]);
    expect(read.agents.map((agent): string => agent.stem)).toEqual(["scout"]);
    // Without the includes handed over, nothing is emitted for it.
    expect(generate("cursor").map((file): string => file.path)).not.toContain("agents/_shared.md");
  });

  it("is carried beside the personas on a files row: marker, body verbatim, no persona-shaped refusal (S11)", () => {
    const files = withIncludes("cursor");
    const include = at(files, "agents/_shared.md");
    // The fixture include has no frontmatter, which a PERSONA would be refused for.
    expect(include).toBe(`${markerFor("cursor")}\n## Shared preamble\n\nThis file is pulled into every persona by reference. It is an include, not a\npersona: it has no frontmatter and names nobody.\n`);
    const report = generateSurfaceMirrorReport({ row: row("cursor"), skills: readSourceSkills(SKILLS), agents: read.agents, includes: read.includes, invocationPrefix: null });
    expect(report.includes).toEqual(["_shared.md"]);
  });

  it("follows the personas as a ## _<stem> section on the appendix row", () => {
    const appendix = at(withIncludes("codex"), "AGENTS.md");
    expect(appendix.indexOf("## scout")).toBeLessThan(appendix.indexOf("## _shared"));
    expect(appendix).toContain("## _shared\n\n## Shared preamble\n");
    // Never a TOML persona for it.
    expect(withIncludes("codex").map((file): string => file.path)).not.toContain("agents/_shared.toml");
  });

  it("is inside the universe like any persona file, so a stale copy is an orphan and a fresh one is ok", () => {
    const out = tempDir();
    writeSurfaceMirror(out, withIncludes("cursor"), row("cursor"));
    expect(universeFiles(out, row("cursor"))).toContain("agents/_shared.md");
    expect(mirrorReportOk(checkSurfaceMirror(out, withIncludes("cursor"), row("cursor")))).toBe(true);
    const without = writeSurfaceMirror(out, generate("cursor"), row("cursor"));
    expect(without.deleted).toEqual(["agents/_shared.md"]);
  });
});

describe("hook scripts: symlinks and modes (S4, N6)", () => {
  const withHooks = (): readonly GeneratedFile[] =>
    generateSurfaceMirror({ row: row("antigravity"), skills: readSourceSkills(SKILLS), agents: [], invocationPrefix: null, hooks: readHooksManifest(join(FIXTURES, "packs", "hooks.json")) });

  it("refuses a destination that is a symbolic link before writing anything", () => {
    const out = tempDir();
    const elsewhere = join(tempDir(), "victim");
    writeFileSync(elsewhere, "not mine\n");
    mkdirSync(join(out, "hooks"));
    symlinkSync(elsewhere, join(out, "hooks", "bell.hook"));
    expect(() => writeSurfaceMirror(out, withHooks(), row("antigravity"))).toThrow(/refusing to write through a symbolic link.*hooks\/bell\.hook/);
    expect(readFileSync(elsewhere, "utf8")).toBe("not mine\n");
    expect(existsSync(join(out, "alpha", "SKILL.md"))).toBe(false);
  });

  it("re-applies a declared mode on unchanged bytes, and check calls a wrong mode hand-edited", () => {
    const out = tempDir();
    const files = withHooks();
    writeSurfaceMirror(out, files, row("antigravity"));
    const script = join(out, "hooks", "bell.hook");
    expect(statSync(script).mode & 0o777).toBe(0o755);
    chmodSync(script, 0o644);
    const drifted = checkSurfaceMirror(out, files, row("antigravity"));
    expect(drifted.handEdited).toEqual(["hooks/bell.hook"]);
    // A regenerate repairs the mode without rewriting the bytes, and reports the file written.
    const repaired = writeSurfaceMirror(out, files, row("antigravity"));
    expect(repaired.written).toEqual(["hooks/bell.hook"]);
    expect(statSync(script).mode & 0o777).toBe(0o755);
    expect(mirrorReportOk(checkSurfaceMirror(out, files, row("antigravity")))).toBe(true);
    // --dry-run reports it and touches nothing.
    chmodSync(script, 0o644);
    expect(writeSurfaceMirror(out, files, row("antigravity"), true).written).toEqual(["hooks/bell.hook"]);
    expect(statSync(script).mode & 0o777).toBe(0o644);
  });
});

describe("a markerless hook script (N12)", () => {
  const nodeHooks = (): ReturnType<typeof readHooksManifest> => {
    const dir = tempDir();
    writeFileSync(join(dir, "hooks.json"), '{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"${CLAUDE_PLUGIN_ROOT}/hooks/bell.js"}]}]}}');
    writeFileSync(join(dir, "bell.js"), "#!/usr/bin/env node\nconsole.log('bell');\n");
    return readHooksManifest(join(dir, "hooks.json"));
  };
  const files = (): ReturnType<typeof generateSurfaceMirrorReport> =>
    generateSurfaceMirrorReport({ row: row("antigravity"), skills: readSourceSkills(SKILLS), agents: [], invocationPrefix: null, hooks: nodeHooks() });

  it("is carried byte for byte, noted in the report, written and re-written without a marker guard, and checked by bytes", () => {
    const report = files();
    const script = report.files.find((file): boolean => file.path === "hooks/bell.js");
    expect(script).toMatchObject({ content: "#!/usr/bin/env node\nconsole.log('bell');\n", mode: 0o755, markerless: true });
    expect(report.notes).toContain("hooks/bell.js carries no marker: its interpreter does not read # comments, and the manifest beside it carries the marker");
    const out = tempDir();
    writeSurfaceMirror(out, report.files, row("antigravity"));
    expect(mirrorReportOk(checkSurfaceMirror(out, report.files, row("antigravity")))).toBe(true);
    // A second generate over it is not a clobber refusal: the manifest beside it is the guarded file.
    expect(writeSurfaceMirror(out, report.files, row("antigravity")).unchanged).toContain("hooks/bell.js");
    writeFileSync(join(out, "hooks", "bell.js"), "#!/usr/bin/env node\nconsole.log('changed');\n");
    expect(checkSurfaceMirror(out, report.files, row("antigravity")).handEdited).toEqual(["hooks/bell.js"]);
    // Outside the orphan universe: with the manifest gone it is neither extra nor deleted.
    expect(universeFiles(out, row("antigravity"))).not.toContain("hooks/bell.js");
  });
});

describe("the report's not-supported paths", () => {
  it("say so for a row with no hooks, rules or permissions, and write nothing for them", () => {
    const bare: SurfaceRow = { ...row("cursor"), hooks: null, rules: null, permissions: null };
    const report = generateSurfaceMirrorReport({
      row: bare,
      skills: readSourceSkills(SKILLS),
      agents: [],
      invocationPrefix: null,
      hooks: readHooksManifest(join(FIXTURES, "packs", "hooks.json")),
      rules: readRules(join(FIXTURES, "packs", "rules.md")),
      permissions: readPermissions(join(FIXTURES, "packs", "permissions.json")),
    });
    expect(report.hooks).toBe("not supported");
    expect(report.rules).toBe("not supported");
    expect(report.permissions).toBe("not supported");
    expect(report.files.map((file): string => file.path)).toEqual(["alpha/SKILL.md", "beta/SKILL.md"]);
  });

  it("names an appendix past the surface's documented read limit", () => {
    const agents = tempDir();
    writeFileSync(join(agents, "big.md"), `---\nname: big\n---\n${"prose ".repeat(6_000)}\n`);
    const report = generateSurfaceMirrorReport({ row: row("codex"), skills: readSourceSkills(SKILLS), agents: readSourceAgents(agents), invocationPrefix: null });
    expect(report.notes[0]).toMatch(/AGENTS\.md is \d+ bytes, past the 32768-byte read limit/);
  });

  it("refuses a models fragment whose tier the map lacks", () => {
    expect(() =>
      generateSurfaceMirrorReport({ row: row("codex"), skills: readSourceSkills(SKILLS), agents: [], invocationPrefix: null, models: { target: { frontier: "x" }, surface: "codex", source: null, sourceSurface: "claude", known: ["codex"], surfaces: { codex: { frontier: "x" } } } }),
    ).toThrow(/no 'models\.codex\.fast'/);
  });
});
