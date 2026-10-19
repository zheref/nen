// src/cli/usage-contracts.test.ts -- docs/USAGE.md's list of contract ids, held
// to the code (zheref/nen#350).
//
// WHY THIS FILE EXISTS. At 02c76be USAGE said "Thirty-three shapes ... (thirty-
// five ids ...)" and the list beside it matched the sentence and not the
// binary: 39 of the 73 ids the code carries (`nen.pr.open/v0.1`,
// `nen.wc.publish/v0.1`, ...) were missing, and `nen.issue.edit-body` was listed
// at v0.2 where the code says v0.3. A number that agrees with the list beside
// it and with nothing else is a number nobody can tell is wrong, so this reads
// the two sides it must agree with.
//
// THE FAMILY COUNT IS NOT HERE. It is ./surface.test.ts's, defined there as
// COMMANDS.length plus the two pre-registry commands index.ts writes by hand;
// a second pin of it in this file could only disagree with the first.
//
// HOW IT DISCOVERS THE IDS. There is no registry of contract ids to read, and
// adding one would be a second list to keep in step with the first, which is
// the defect. So the code is the registry. It walks `src/` and `templates/`,
// skipping every `*.test.ts`, every `*.testkit.ts` (test support) and every
// directory named `fixtures` (a fixture is a test's input), and in each
// remaining file, with `//` and `/* */` comments blanked first:
//
//   * collects every QUOTED literal -- single, double or backtick, with no
//     interpolation -- that is exactly `nen.<name>/v<major>[.<minor>]`, the
//     name made of lower-case letters, digits, `.`, `-` and `_`. A `*_CONTRACT`
//     constant, a `contract:`/`$schema:`/`schema:` value and an id quoted whole
//     inside a help text all count: quoted whole is the test;
//   * collects every TEMPLATE literal with an interpolation anywhere in the
//     name (`nen.shu.${verb}/v0.1`, `nen.${family}/v0.1`), spelling each
//     `${x}` as `<x>` so the one id that stands for a family of strings has one
//     stable spelling in the doc;
//   * SWEEPS what is left: any other `nen.<...>/v<digit>` text, in code or in
//     a help string, whose id the two rules did not collect anywhere is
//     reported as unrecognised, with its file:line, and FAILS the test. A
//     mention of an id that IS collected elsewhere (the usual prose reference
//     to a constant) and a `<placeholder>` mention are accepted. So a spelling
//     these patterns do not understand cannot be silently skipped: it fails
//     here and a reviewer extends the patterns or quotes the id.
//
// WHAT IT CANNOT DO, said plainly. It does not run the verbs, so an id built
// from pieces (`"nen." + family + "/v0.1"`) has no `nen.<...>/v` text to sweep
// and would escape it. The comment stripper is a line-and-block scanner, not a
// parser: it will not blank a `//` that follows a quote character on the same
// line, and it treats `://` as a URL, not a comment.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = process.cwd();
const read = (...parts: readonly string[]): string => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

/** The non-test, non-fixture files of one tree, repo-relative and `/`-separated. */
function sourceFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "node_modules") found.push(...sourceFiles(path));
    } else if (!entry.name.endsWith(".test.ts") && !entry.name.endsWith(".testkit.ts")) {
      found.push(path);
    }
  }
  return found;
}

/** `//` and block comments replaced by spaces, newlines kept so line numbers hold. */
function blankComments(text: string): string {
  const spaces = (match: string): string => match.replace(/[^\n]/g, " ");
  return text.replace(/\/\*[\s\S]*?\*\//g, spaces).replace(/(?<![:\w"'`/\\])\/\/.*$/gm, spaces);
}

const ID_BODY = "[a-z][a-z0-9._-]*";
const VERSION = "v\\d+(?:\\.\\d+)?";
/** A quote, the whole id, the SAME quote. `$` and `{` are not in the name class, so a template never matches. */
const FIXED_ID = new RegExp(`(["'\`])(nen\\.${ID_BODY}/${VERSION})\\1`, "g");
/** A backtick literal whose name holds at least one `${name}`. */
const TEMPLATE_ID = new RegExp("`(nen\\.[a-z0-9._${}A-Z-]*\\$\\{[A-Za-z]+\\}[a-z0-9._${}A-Z-]*/" + VERSION + ")`", "g");
/** Any `nen.<...>/v<digit>` text at all: the sweep for what the two rules above did not understand. */
const ANY_ID_TEXT = /nen\.[^\s"'`]*\/v\d[\d.]*/g;

export interface Scan {
  readonly ids: ReadonlyMap<string, number>;
  readonly mentions: readonly { readonly text: string; readonly line: number }[];
}

const lineOf = (text: string, index: number): number => text.slice(0, index).split("\n").length;
const spell = (template: string): string => template.replace(/\$\{([A-Za-z]+)\}/g, "<$1>");

/** What one file's text carries: the collected ids (with first line) and every other id-shaped mention. */
function scan(raw: string, isCode: boolean): Scan {
  const text = isCode ? blankComments(raw) : raw;
  const ids = new Map<string, number>();
  for (const match of text.matchAll(FIXED_ID)) {
    if (!ids.has(match[2] as string)) ids.set(match[2] as string, lineOf(text, match.index));
  }
  for (const match of text.matchAll(TEMPLATE_ID)) {
    const id = spell(match[1] as string);
    if (!ids.has(id)) ids.set(id, lineOf(text, match.index));
  }
  const mentions = [...text.matchAll(ANY_ID_TEXT)].map((match) => ({
    text: spell(match[0].replace(/[.]+$/, "")),
    line: lineOf(text, match.index),
  }));
  return { ids, mentions };
}

/** Each carried id with the first `file:line` that holds it, and every mention nothing collected. */
function discover(): { readonly ids: ReadonlyMap<string, string>; readonly unrecognised: readonly string[] } {
  const ids = new Map<string, string>();
  const mentions: { file: string; text: string; line: number }[] = [];
  for (const file of [...sourceFiles("src"), ...sourceFiles("templates")]) {
    const found = scan(read(file), file.endsWith(".ts"));
    for (const [id, line] of found.ids) if (!ids.has(id)) ids.set(id, `${file}:${line}`);
    for (const mention of found.mentions) mentions.push({ file, ...mention });
  }
  const unrecognised = mentions
    .filter((mention): boolean => !ids.has(mention.text) && !mention.text.includes("<"))
    .map((mention): string => `${mention.file}:${mention.line} ${mention.text}`);
  return { ids, unrecognised };
}

const USAGE = read("docs", "USAGE.md");

/** The ids USAGE lists between its two markers, in document order. */
function listedIds(): readonly string[] {
  const begin = USAGE.indexOf("<!-- contract-ids:begin -->");
  const end = USAGE.indexOf("<!-- contract-ids:end -->");
  expect(begin, "USAGE.md lost its <!-- contract-ids:begin --> marker").toBeGreaterThan(-1);
  expect(end, "USAGE.md lost its <!-- contract-ids:end --> marker").toBeGreaterThan(begin);
  return [...USAGE.slice(begin, end).matchAll(/`(nen\.[^`\s]+\/v\d+(?:\.\d+)?)`/g)].map((match): string => match[1] as string);
}

const shapeOf = (id: string): string => id.slice(0, id.indexOf("/"));

describe("the id scan understands every spelling it claims to", () => {
  const ids = (text: string): string[] => [...scan(text, true).ids.keys()].sort();

  it("collects quoted literals of all three quote styles, including a backtick with no interpolation", () => {
    expect(ids('const A = "nen.a.b/v0.1"; const B = \'nen.c/v1.2\';')).toEqual(["nen.a.b/v0.1", "nen.c/v1.2"]);
    expect(ids("const A = `nen.wc.future/v0.1`;")).toEqual(["nen.wc.future/v0.1"]);
  });

  it("collects an underscore in the name and a major-only version", () => {
    expect(ids('x = "nen.shu.test_report/v0.1"')).toEqual(["nen.shu.test_report/v0.1"]);
    expect(ids('x = "nen.pr.x/v1"')).toEqual(["nen.pr.x/v1"]);
  });

  it("collects a template with an interpolation anywhere, spelled with <placeholders>", () => {
    expect(ids("x = `nen.shu.${verb}/v0.1`")).toEqual(["nen.shu.<verb>/v0.1"]);
    expect(ids("x = `nen.${family}/v0.1`")).toEqual(["nen.<family>/v0.1"]);
    expect(ids("x = `nen.${family}.${verb}/v2`")).toEqual(["nen.<family>.<verb>/v2"]);
  });

  it("does not collect an id that sits only in a comment, and does not mention it either", () => {
    const found = scan('// "nen.only.comment/v0.1"\n/* `nen.block/v0.1`\n */\nconst x = 1;', true);
    expect([...found.ids.keys()]).toEqual([]);
    expect(found.mentions).toEqual([]);
  });

  it("collects an id quoted whole inside a help string", () => {
    expect(ids("const HELP = `--json: '{ contract: \"nen.pr.threads/v0.1\", target }'`;")).toEqual(["nen.pr.threads/v0.1"]);
  });

  it("reports, with its line, an id-shaped mention no rule collects, rather than skipping it", () => {
    const found = scan('const a = 1;\nconst HELP = "returns nen.future.thing/v0.1 as its contract";\n', true);
    expect([...found.ids.keys()]).toEqual([]);
    expect(found.mentions).toEqual([{ text: "nen.future.thing/v0.1", line: 2 }]);
  });

  it("keeps a URL's // from blanking the rest of its line", () => {
    expect(ids('x = "https://example.test/a"; y = "nen.after.url/v0.1";')).toEqual(["nen.after.url/v0.1"]);
  });
});

describe("docs/USAGE.md's contract list is the binary's", () => {
  const { ids: emitted, unrecognised } = discover();
  const listed = listedIds();

  it("finds the ids at all, so an empty walk cannot pass for an empty list", () => {
    expect(emitted.size).toBeGreaterThan(50);
    expect(emitted.get("nen.pr.ready/v0.1")).toMatch(/^src\/verbs\/pr_ready\.ts:\d+$/);
    expect(emitted.get("nen.shu.<verb>/v0.1")).toMatch(/^src\/shu\/run\.ts:\d+$/);
    expect(emitted.get("nen.workflow/v0.1")).toMatch(/^templates\/workflow\.json:\d+$/);
  });

  it("leaves no id-shaped text that no rule understood", () => {
    expect(
      unrecognised,
      "id-shaped text no scan rule collected (file:line id). Quote the id whole, or extend FIXED_ID / TEMPLATE_ID in this file " +
        "and list it in docs/USAGE.md if it is a contract id",
    ).toEqual([]);
  });

  it("skips what is not the binary's own: test files, test support and fixtures", () => {
    for (const where of emitted.values()) {
      expect(where).not.toMatch(/\.test\.ts:/);
      expect(where).not.toMatch(/\.testkit\.ts:/);
      expect(where).not.toMatch(/(^|\/)fixtures\//);
    }
  });

  it("lists every id the binary carries", () => {
    const missing = [...emitted.keys()].filter((id): boolean => !listed.includes(id)).sort();
    expect(
      missing,
      `docs/USAGE.md's contract list is missing ${missing.length} id(s) the binary carries ` +
        `(${missing.map((id): string => `${id} <- ${emitted.get(id)}`).join("; ")}). ` +
        "Add each to the list between the contract-ids markers and move the two stated counts.",
    ).toEqual([]);
  });

  it("lists no id the binary does not carry", () => {
    const stale = listed.filter((id): boolean => !emitted.has(id)).sort();
    expect(stale, "docs/USAGE.md lists id(s) no file under src/ or templates/ carries any more; remove or rename them").toEqual([]);
  });

  it("lists each id once", () => {
    const repeated = [...new Set(listed.filter((id, index): boolean => listed.indexOf(id) !== index))].sort();
    expect(repeated, `docs/USAGE.md's contract list names these ids more than once: ${repeated.join(", ")}. Keep one of each.`).toEqual([]);
  });

  it("states a shape count and an id count that match the list", () => {
    const shapes = /\*\*(\d+) shapes\*\*/.exec(USAGE);
    const ids = /\*\*(\d+) ids\*\*/.exec(USAGE);
    expect(shapes, "USAGE.md must state the shape count as **N shapes**").not.toBeNull();
    expect(ids, "USAGE.md must state the id count as **N ids**").not.toBeNull();
    expect(Number(ids?.[1])).toBe(new Set(listed).size);
    expect(Number(shapes?.[1])).toBe(new Set(listed.map(shapeOf)).size);
  });
});
