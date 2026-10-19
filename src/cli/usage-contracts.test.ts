// src/cli/usage-contracts.test.ts -- docs/USAGE.md's list of contract ids and
// the family count in README.md and USAGE, held to the code (zheref/nen#350).
//
// WHY THIS FILE EXISTS. USAGE said "Thirty shapes qualify today" and the list
// beside it matched the sentence and not the binary: about nineteen ids the
// code stamps (`nen.pr.open/v0.1`, `nen.wc.publish/v0.1`, ...) were missing,
// and README and USAGE both said 41 command families while COMMANDS held 39. A
// number that agrees with the list beside it and with nothing else is a
// number nobody can tell is wrong, so this reads the two sides it must agree
// with.
//
// HOW IT DISCOVERS THE IDS. There is no registry of contract ids to read, and
// adding one would be a second list to keep in step with the first, which is
// the defect. So the code is the registry. It walks `src/` and `templates/` --
// the files the compiled binary is built from, the latter static-imported by
// src/scaffold/templates.ts -- skipping every `*.test.ts` and every directory
// named `fixtures` (a fixture is a test's input, not something the binary
// emits), and collects:
//
//   * every QUOTED literal that is exactly `nen.<name>/v<n>.<n>`: a
//     `*_CONTRACT` constant, a `contract:`/`$schema:`/`schema:` value, a JSON
//     `"$schema"` in a template. Quoted WHOLE is the test -- a mention inside a
//     comment, or inside a help line's longer sentence, is not an emission;
//   * every TEMPLATE literal `nen.<family>.${name}/v<n>.<n>` (src/shu/run.ts's
//     `contractName`), spelled `nen.<family>.<name>/v<n>.<n>` so the one id
//     that stands for a family of strings has one stable spelling in the doc.
//
// WHAT IT CANNOT DO, said plainly. It does not run the verbs, so an id built
// from pieces (`"nen." + family + ...`) would escape it; nothing in the tree
// builds one that way today, and the template-literal rule above is the one
// dynamic form that exists. Adding a third form means extending this file's
// two patterns, which is the point at which a reviewer reads the claim above.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { COMMANDS } from "./registry.js";

const ROOT = process.cwd();
const read = (...parts: readonly string[]): string => readFileSync(join(ROOT, ...parts), "utf8").replace(/\r\n/g, "\n");

/** Every file the binary is built from, repo-relative and `/`-separated. */
function binaryFiles(directory: string): readonly string[] {
  const found: string[] = [];
  for (const entry of readdirSync(join(ROOT, directory), { withFileTypes: true })) {
    const path = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name !== "fixtures" && entry.name !== "node_modules") found.push(...binaryFiles(path));
    } else if (!entry.name.endsWith(".test.ts")) {
      found.push(path);
    }
  }
  return found;
}

const QUOTED_ID = /["'](nen\.[a-z][a-z0-9.-]*\/v\d+\.\d+)["']/g;
const TEMPLATE_ID = /`nen\.([a-z][a-z0-9.-]*)\.\$\{([A-Za-z]+)\}\/(v\d+\.\d+)`/g;

/** Each emitted id, with the first file that carries it. */
function emittedIds(): ReadonlyMap<string, string> {
  const ids = new Map<string, string>();
  for (const file of [...binaryFiles("src"), ...binaryFiles("templates")]) {
    const text = read(file);
    for (const match of text.matchAll(QUOTED_ID)) if (!ids.has(match[1] as string)) ids.set(match[1] as string, file);
    for (const match of text.matchAll(TEMPLATE_ID)) {
      const id = `nen.${match[1]}.<${match[2]}>/${match[3]}`;
      if (!ids.has(id)) ids.set(id, file);
    }
  }
  return ids;
}

const USAGE = read("docs", "USAGE.md");
const README = read("README.md");

/** The ids USAGE lists between its two markers, in document order. */
function listedIds(): readonly string[] {
  const begin = USAGE.indexOf("<!-- contract-ids:begin -->");
  const end = USAGE.indexOf("<!-- contract-ids:end -->");
  expect(begin, "USAGE.md lost its <!-- contract-ids:begin --> marker").toBeGreaterThan(-1);
  expect(end, "USAGE.md lost its <!-- contract-ids:end --> marker").toBeGreaterThan(begin);
  return [...USAGE.slice(begin, end).matchAll(/`(nen\.[^`\s]+\/v\d+\.\d+)`/g)].map((match): string => match[1] as string);
}

const shapeOf = (id: string): string => id.slice(0, id.indexOf("/"));

describe("docs/USAGE.md's contract list is the binary's", () => {
  const emitted = emittedIds();
  const listed = listedIds();

  it("finds the ids at all, so an empty walk cannot pass for an empty list", () => {
    expect(emitted.size).toBeGreaterThan(50);
    expect(emitted.get("nen.pr.ready/v0.1")).toBe("src/verbs/pr_ready.ts");
    expect(emitted.get("nen.shu.<verb>/v0.1")).toBe("src/shu/run.ts");
    expect(emitted.get("nen.workflow/v0.1")).toBe("templates/workflow.json");
  });

  it("skips what is not the binary's own: test files and fixtures", () => {
    // The fixture trees carry `nen.contract/v0.1`-shaped documents on purpose;
    // none of them may be how an id is found.
    for (const file of emitted.values()) {
      expect(file).not.toMatch(/\.test\.ts$/);
      expect(file).not.toMatch(/(^|\/)fixtures\//);
    }
  });

  it("lists every id the binary emits", () => {
    const missing = [...emitted.keys()].filter((id): boolean => !listed.includes(id)).sort();
    expect(
      missing,
      `docs/USAGE.md's contract list is missing ${missing.length} id(s) the binary emits ` +
        `(first found in: ${missing.map((id): string => `${id} <- ${emitted.get(id)}`).join("; ")}). ` +
        "Add each to the list between the contract-ids markers and move the two stated counts.",
    ).toEqual([]);
  });

  it("lists no id the binary does not emit", () => {
    const stale = listed.filter((id): boolean => !emitted.has(id)).sort();
    expect(stale, "docs/USAGE.md lists id(s) no file under src/ or templates/ carries any more; remove or rename them").toEqual([]);
  });

  it("lists each id once", () => {
    const repeated = listed.filter((id, index): boolean => listed.indexOf(id) !== index);
    expect(repeated).toEqual([]);
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

describe("the command-family count is COMMANDS'", () => {
  it("is the same in README.md and USAGE.md as the registry holds", () => {
    const readme = /lists every command family \((\d+)\)/.exec(README);
    const usage = /(\d+) command\s+families,/.exec(USAGE);
    expect(readme, "README.md must say `nen --help` lists every command family (N)").not.toBeNull();
    expect(usage, "USAGE.md must say N command families, M verbs").not.toBeNull();
    expect(Number(readme?.[1])).toBe(COMMANDS.length);
    expect(Number(usage?.[1])).toBe(COMMANDS.length);
  });

  it("has distinct names, so the count is of families and not of entries", () => {
    expect(new Set(COMMANDS.map((command): string => command.name)).size).toBe(COMMANDS.length);
  });
});
