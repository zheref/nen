// src/scaffold/templates.test.ts -- the scaffold template pack, held to the
// three properties a bundled data directory has to have.
//
//   1. IT EMBEDS. `bun build --compile` follows a static import and cannot
//      follow a directory read, so the import list in ./templates.ts is the one
//      thing here that can fall behind the data -- and the failure it produces
//      is the worst available: a stack that has a template in a checkout and
//      none in every shipped binary. Three assertions in both directions.
//   2. IT AGREES WITH THE PROFILES PACK. `scaffoldTemplate` is a NAME, and a
//      name pointing at a template that does not exist is a stack every
//      scaffold refuses at run time, on a user's machine, for a fact that was
//      knowable at build time.
//   3. NO MODULE OF THIS FAMILY NAMES A TOOLCHAIN. The CI file is data for
//      exactly this reason; the sweep below is ../shu/purity.test.ts's rule,
//      pointed at `src/scaffold/`.

import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadProfilesPack, profileById } from "../profiles/pack.js";
import { VerbUsageError } from "../cli/command.js";
import { VERSION } from "../version.js";
import {
  TEMPLATE_DIRECTORY,
  TEMPLATE_FILE,
  TEMPLATE_INDEX_FILE,
  TemplateError,
  assertWritablePath,
  bundledTemplateNames,
  compareNenRefs,
  freshTreeSupport,
  indexedTemplateNames,
  knownStacks,
  minimumNenRef,
  resolveStackId,
  stackHosts,
  substitute,
  templateForStack,
} from "./templates.js";

const ROOT = process.cwd();
const TEMPLATES = join(ROOT, TEMPLATE_DIRECTORY);

/**
 * A filesystem or path module, in every spelling Node and bun accept: with or
 * without `node:`, and any subpath (`fs/promises`, `path/posix`, `path/win32`).
 * The fixed list this replaced had the `node:` subpaths and not the bare ones,
 * so `import { readFile } from "fs/promises"` bound nothing.
 */
const PATH_MODULE = String.raw`(?:node:)?(?:fs|path)(?:/[a-z0-9]+)?`;
const IDENTIFIER = String.raw`[A-Za-z_$][\w$]*`;
/** The quoted specifier of a filesystem or path module, `"node:fs"` and the rest. */
const PATH_SPECIFIER = String.raw`["']${PATH_MODULE}["']`;

/** Every local name a `{ a, b as c }` import clause or a `{ a, b: c }` pattern binds. */
function localNames(clause: string): readonly string[] {
  return clause
    .split(",")
    .map((part): string => part.trim().replace(/^type\s+/, "").split(/\s+as\s+|\s*:\s*/).at(-1)?.trim() ?? "")
    .filter((name): boolean => new RegExp(`^${IDENTIFIER}$`).test(name));
}

/**
 * Every callee IN ONE FILE that could compose or read a path, ALIASES INCLUDED.
 *
 * A fixed name list is defeated by one rename (`readFileSync as _rfs`), which
 * is exactly the mutation that survived the first draft of this sweep. Reading
 * the file's own bindings closes that: a binding renamed on the way in is still
 * bound to the module it came from, and the local name is what the call site
 * has to use. Two kinds of binding, read five ways:
 *
 *   * a FUNCTION, bound by a named import (`import { cpSync as cp }`) or a
 *     destructured `require()` / `await import()`. The call is the name itself.
 *   * a MODULE OBJECT, bound by a namespace import (`import * as fs`), a
 *     default import (`import fs from`), `const fs = require(...)` or
 *     `await import(...)`, or `import fs = require(...)`. ANY member call on it
 *     counts (`fs.cpSync(`, `fs.promises.readFile(`), never a fixed method
 *     list: the list is what `cpSync` walked past.
 *
 * The fixed names below stay in as well, for a caller that reaches `join` or
 * `readFileSync` through some other module.
 */
function pathCallers(source: string): RegExp {
  const functions = new Set([
    "join",
    "resolve",
    "readFileSync",
    "readdirSync",
    "existsSync",
    "statSync",
    "lstatSync",
    "openSync",
  ]);
  const objects = new Set<string>();
  const imports = new RegExp(`\\bimport\\s+(?!type\\b)([^;]*?)\\s*\\bfrom\\s*${PATH_SPECIFIER}`, "g");
  for (const match of source.matchAll(imports)) {
    const clause = match[1] ?? "";
    for (const named of clause.matchAll(/\{([^}]*)\}/g)) for (const name of localNames(named[1] ?? "")) functions.add(name);
    const namespace = new RegExp(`\\*\\s*as\\s+(${IDENTIFIER})`).exec(clause)?.[1];
    if (namespace !== undefined) objects.add(namespace);
    const defaulted = new RegExp(`^(${IDENTIFIER})\\s*(?:,|$)`).exec(clause.trim())?.[1];
    if (defaulted !== undefined) objects.add(defaulted);
  }
  const loaded = String.raw`(?:await\s+)?(?:require|import)\s*\(\s*${PATH_SPECIFIER}\s*\)`;
  for (const match of source.matchAll(new RegExp(`\\b(?:const|let|var)\\s+(${IDENTIFIER})\\s*=\\s*${loaded}`, "g"))) {
    if (match[1] !== undefined) objects.add(match[1]);
  }
  for (const match of source.matchAll(new RegExp(`\\bimport\\s+(${IDENTIFIER})\\s*=\\s*require\\s*\\(\\s*${PATH_SPECIFIER}\\s*\\)`, "g"))) {
    if (match[1] !== undefined) objects.add(match[1]);
  }
  for (const match of source.matchAll(new RegExp(`\\b(?:const|let|var)\\s*\\{([^}]*)\\}\\s*=\\s*${loaded}`, "g"))) {
    for (const name of localNames(match[1] ?? "")) functions.add(name);
  }
  const members = objects.size === 0 ? "" : `|\\b(?:${[...objects].join("|")})(?:\\.${IDENTIFIER})+`;
  return new RegExp(`(?:\\b(?:${[...functions].join("|")})${members}|Bun\\.file)\\s*\\(`);
}

/**
 * `templates` as a PATH SEGMENT: next to a separator on at least one side, so
 * `templates/x`, `../../templates/x` and `../../templates` all match. The bare
 * word `templates`, with no separator either side, is rule 3's business.
 */
const TEMPLATE_SEGMENT = /[\\/]templates(?:[\\/]|$)|^templates[\\/]/;
/** One quoted literal inside one statement, its body captured: '…', "…" or `…`. */
const QUOTED_LITERAL = /(["'`])((?:\\.|(?!\1)[^\\\n])*)\1/g;
/** A statement that is a comment, which can name a path but never reads one. */
const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;
/** A static import or re-export clause: the one route a bundler follows and embeds. */
const STATIC_SPECIFIER =
  /^\s*(?:(?:import|export)\b[^("'`]*?\bfrom|\}\s*from|import)\s*["'][^"'\n]+["']\s*(?:with\s*\{[^}]*\}\s*)?$/;
/** A literal holding whitespace is a sentence, and a sentence names a path without reading it. */
const PROSE = /\s/;
/** A web address, which names a page about the directory rather than the directory. */
const WEB_URL = /^https?:\/\//i;

/**
 * Does this module reach `templates/` by anything other than a static import?
 *
 * A read like `readFileSync(join(root, "templates", ...))` works in a checkout
 * and finds nothing inside a compiled binary, where there is no `templates/`
 * directory to open. The sweep splits the module into lines, then statements,
 * and applies three rules to each:
 *
 *   1. A FILESYSTEM or PATH call in the same statement as `"templates"` or
 *      `TEMPLATE_DIRECTORY`. The callees come from `pathCallers`, which reads
 *      the file's own bindings: named, namespace and default imports,
 *      `require()` and `await import()`.
 *   2. A quoted literal naming a path at or under the directory
 *      (`"../../templates/full/template.json"`, `"../../templates"`,
 *      `` `${root}/templates/x` ``). This catches the path wherever it goes
 *      next: a variable, a `new URL`, a dynamic `import()`.
 *   3. The bare name `templates` quoted in a module that imports a filesystem
 *      or path module, where it can only be headed for a path. Elsewhere it is
 *      a label: the loader passes it to its own error type and imports neither.
 *
 * WHAT IS LEFT ALONE, on purpose, because the real tree does each of these and
 * none of them reads a path:
 *   * a static import specifier, which is how `templates/` is SUPPOSED to be
 *     reached, since a bundler follows it;
 *   * a comment, judged by its LINE, so a `;` inside one does not split off a
 *     piece that looks like code;
 *   * a quoted literal holding whitespace, which is prose: an error message
 *     such as "templates/index.json lists no template by that name", or a line
 *     of help text;
 *   * an `http(s)://` address, a page ABOUT the directory;
 *   * for rule 3 only, a `case "templates":` label or an `=== "templates"`
 *     comparison, which test a value and compose no path.
 * A quoted mention of a `templates/` path that is none of those, such as a
 * one-word `"templates/index.json"` in an error message, IS flagged. The sweep
 * cannot tell a bare path in a message from a bare path about to be opened, so
 * it errs toward reporting.
 *
 * WHAT IT STILL CANNOT SEE. Each of these reads `templates/` and passes, and
 * each is pinned below as a known gap, so a change that closes one has to say so:
 *   * A path built through an IDENTIFIER: `const d = TEMPLATE_DIRECTORY`,
 *     then `join(root, d)`, or any computed string. Statement by statement,
 *     that looks like the constant quoted in an error message, which the real
 *     tree contains.
 *   * A call and its `TEMPLATE_DIRECTORY` argument on DIFFERENT lines. Rule 1
 *     works one line at a time. A quoted `"templates"` split off the same way
 *     is still caught by rule 3.
 *   * A path literal that holds whitespace: the prose exemption above.
 *   * Filesystem access that goes around this file's own fs/path bindings:
 *     a wrapper imported from another nen module, `Bun.` APIs other than
 *     `Bun.file`, a spawned `cp` or `cat`.
 * The loader is covered anyway: "does not let the LOADER import a filesystem
 * or a path module at all" below forbids it every such import. Closing the
 * rest needs a parser and a data-flow pass, not a pattern.
 *
 * THE CALLEE PATTERN IS BUILT ONCE PER MODULE, NEVER ONCE PER STATEMENT. It is a
 * pure function of `source` and carries no `g` flag. Building it per statement
 * rescanned the whole module for every statement: quadratic, 1.9-2.7s on an
 * idle machine and 5.3-13.6s under load, which made `bun test` fail this sweep
 * for overrunning its 5000ms default (#280).
 */
function offends(source: string): boolean {
  const callers = pathCallers(source);
  const opensPaths = new RegExp(`(?:\\bfrom|\\b(?:require|import)\\s*\\()\\s*${PATH_SPECIFIER}`).test(source);
  return source.split("\n").some((line): boolean => {
    const commentLine = COMMENT.test(line);
    return line.split(";").some((statement): boolean => {
      if (callers.test(statement) && /(["'`]templates["'`]|TEMPLATE_DIRECTORY)/.test(statement)) return true;
      if (commentLine || COMMENT.test(statement) || STATIC_SPECIFIER.test(statement)) return false;
      for (const literal of statement.matchAll(QUOTED_LITERAL)) {
        const body = literal[2] ?? "";
        if (PROSE.test(body) || WEB_URL.test(body)) continue;
        if (TEMPLATE_SEGMENT.test(body)) return true;
        if (opensPaths && body === "templates") {
          const before = statement.slice(0, literal.index);
          const after = statement.slice((literal.index ?? 0) + literal[0].length);
          const tested = /\bcase\s*$|[=!]==?\s*$/.test(before) || /^\s*[=!]==?/.test(after);
          if (!tested) return true;
        }
      }
      return false;
    });
  });
}

const onDisk = readdirSync(TEMPLATES, { withFileTypes: true })
  .filter((entry): boolean => entry.isDirectory())
  .map((entry): string => entry.name)
  .sort();

describe("the bundled template list", () => {
  it("names every template directory in templates/", () => {
    expect([...bundledTemplateNames()].sort()).toEqual(onDisk);
  });

  it("matches templates/index.json, so no listed template is missing from the binary", () => {
    expect([...indexedTemplateNames()].sort()).toEqual(onDisk);
  });

  it("has a template.json in every directory it names", () => {
    for (const name of bundledTemplateNames()) {
      expect(readdirSync(join(TEMPLATES, name))).toContain(TEMPLATE_FILE);
    }
  });

  it("carries the documents' real content, not an empty module", () => {
    // The way a JSON import silently degrades under a bundler is an empty
    // object, which every accessor below would then read as "absent". Comparing
    // the embedded body to the file on disk is what makes "it embedded" an
    // observation: this assertion is exactly the one that fails if the import
    // resolves to nothing.
    for (const name of bundledTemplateNames()) {
      const disk = JSON.parse(
        readFileSync(join(TEMPLATES, name, TEMPLATE_FILE), "utf8"),
      ) as { ci: { body: string } };
      const stack = knownStacks().find(
        (id): boolean => profileById(loadProfilesPack(), id).scaffoldTemplate === name,
      );
      expect(stack, `no stack points at '${name}'`).toBeDefined();
      const template = templateForStack(stack as string);
      expect(template?.ci.body).toBe(disk.ci.body);
      expect((template?.ci.body ?? "").length).toBeGreaterThan(200);
    }
  });

  it("names its index and document files as this module spells them", () => {
    expect(readdirSync(TEMPLATES)).toContain(TEMPLATE_INDEX_FILE);
  });

  it("does not let the LOADER import a filesystem or a path module at all", () => {
    // THE PROPERTY, STATED AS THE PROPERTY rather than as a pattern over call
    // sites. The sweep below asks "does any statement call a path function AND
    // name `templates`", and a one-line mutation defeats it:
    //
    //     import { readFileSync as _rfs } from "node:fs";
    //     const doc = JSON.parse(_rfs(_j(process.cwd(), "templates", ...)));
    //
    // -- the call names neither `readFileSync` nor `join`, and the sweep is
    // green while the loader reads from disk. The real property is simpler and
    // cannot be aliased around: THIS module has no business touching a
    // filesystem or composing a path in the first place. It reads two bundled
    // JSON documents and the profiles pack, and nothing else. So the import
    // list is the assertion, and the alias goes with the import it renames.
    const source = readFileSync(join(ROOT, "src", "scaffold", "templates.ts"), "utf8");
    // Every specifier this module imports, static and dynamic, by the only
    // syntax that can name one -- a bare `"path"` inside an expression is a
    // JSON field name, not a module, and matching it would make the rule
    // unreadable rather than strict.
    const specifiers = [
      ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
      ...source.matchAll(/\b(?:import|require)\s*\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match): string => match[1] ?? "");
    expect(specifiers.length, "the specifier scan must actually see this module's imports").toBeGreaterThan(3);
    const forbidden = specifiers.filter((specifier): boolean =>
      /^(?:node:)?(?:fs|path|os|child_process)(?:\/|$)/.test(specifier) || specifier === "bun",
    );
    expect(
      forbidden,
      "src/scaffold/templates.ts neither reads a file nor composes a path: it imports two bundled JSON documents and the profiles pack",
    ).toEqual([]);
    expect(source).not.toMatch(/Bun\s*\.\s*file/);
    expect(source).not.toMatch(/process\s*\.\s*cwd/);
  });

  it("is reached by STATIC IMPORT ONLY -- no shipped module reads templates/ by path", () => {
    // THE PROPERTY THAT MAKES EMBEDDING WORK, checked the way
    // ../profiles/inertness.test.ts checks the same one for `profiles/`: a
    // `readFileSync(join(root, "templates", ...))` works perfectly in a
    // checkout and finds nothing inside a compiled binary, where there is no
    // `templates/` directory to open. A test that only counted the import list
    // would pass while the loader quietly read from disk.
    const offenders: string[] = [];
    const walk = (directory: string): void => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== "fixtures") walk(path);
          continue;
        }
        if (!entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) continue;
        if (offends(readFileSync(path, "utf8"))) offenders.push(path);
      }
    };
    walk(join(ROOT, "src"));
    expect(offenders).toEqual([]);
  });

  // THE SWEEP'S REACH, PINNED BY THE SAME PREDICATE THE SWEEP RUNS. Each mutant
  // is one way a module could reach templates/ without a static import. The
  // first two were caught before #280; the aliased one is what beat the
  // sweep's first draft. The next six beat the sweep as it stood at 16bedbb.
  // The last five beat it at 4d0919b. Reviews of both commits found them. A
  // mutant that stops being caught is a hole the sweep has opened, so it fails
  // here by name.
  it("catches every path-read shape a draft of the sweep once missed", () => {
    const mutants: Readonly<Record<string, string>> = {
      "an ALIASED import (the first draft's defeat)": [
        'import { readFileSync as _rfs } from "node:fs";',
        'import { join as _j } from "node:path";',
        'const document = JSON.parse(_rfs(_j(process.cwd(), "templates", "full", "template.json"), "utf8"));',
      ].join("\n"),
      "a namespace import": [
        'import * as fs from "node:fs";',
        'export const d = fs.readFileSync(TEMPLATE_DIRECTORY + "/index.json", "utf8");',
      ].join("\n"),
      "a URL relative to the module": 'export const u = new URL("../../templates/full/template.json", import.meta.url);',
      "Bun.file on such a URL": 'export const f = Bun.file(new URL("../../templates/index.json", import.meta.url));',
      "a dynamic import of a computed path":
        'export const load = (x: string) => import(`../../templates/${x}/template.json`);',
      "a path held in a variable": [
        'import { readFileSync } from "node:fs";',
        'const where = "../../templates/full/template.json";',
        'export const d = readFileSync(where, "utf8");',
      ].join("\n"),
      "the bare directory held in a variable": [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const dir = "templates";',
        'export const d = readFileSync(join(process.cwd(), dir, "index.json"), "utf8");',
      ].join("\n"),
      "a template-literal path": [
        'import { readFileSync } from "node:fs";',
        'export const d = readFileSync(`${process.cwd()}/templates/index.json`, "utf8");',
      ].join("\n"),
      "the directory itself, relative, with no trailing separator": [
        'import { resolve } from "node:path";',
        'export const dir = resolve(import.meta.dir, "../../templates");',
      ].join("\n"),
      "a URL of the directory itself": 'export const u = new URL("../../templates", import.meta.url);',
      "a member call on a DEFAULT import": [
        'import fs from "node:fs";',
        "export const copy = (to: string) => fs.cpSync(TEMPLATE_DIRECTORY, to, { recursive: true });",
      ].join("\n"),
      "a named import from bare fs/promises": [
        'import { readFile } from "fs/promises";',
        'export const d = await readFile(TEMPLATE_DIRECTORY + "/index.json", "utf8");',
      ].join("\n"),
      "a module object from require()": [
        'const fs = require("node:fs");',
        'export const d = fs.readFile(TEMPLATE_DIRECTORY + "/index.json", () => undefined);',
      ].join("\n"),
    };
    expect(Object.keys(mutants)).toHaveLength(13);
    for (const [shape, source] of Object.entries(mutants)) {
      expect(offends(source), `${shape} must be caught`).toBe(true);
    }
  });

  // AND ITS LIMIT ON THE OTHER SIDE. A static import is how templates/ is
  // SUPPOSED to be reached. The directory named in a comment, in prose, in a
  // web address, through `TEMPLATE_DIRECTORY` in an error message, or as a
  // value a `case` or a comparison tests names a path without reading one. The
  // real tree carries most of these shapes, so a rule that flagged them would
  // fail the sweep above rather than guard anything. The last four are
  // plausible shapes it does not carry yet.
  it("leaves alone a static import, and the directory named in prose", () => {
    const legitimate: Readonly<Record<string, string>> = {
      "a static import specifier": 'import fullTemplate from "../../templates/full/template.json";',
      "a multi-line static import": ["import {", "  a,", "  b,", '} from "../../templates/pack.js";'].join("\n"),
      "comments naming the directory": [
        "// the body is a data file under `templates/full/`",
        "/** The names `templates/index.json` lists. */",
        " * `templates/workflow.json`'s `$defaultAgentTrailer` is read once",
        "// has to name; that body is a data file under `templates/`, versioned with nen",
        'readSomething(); // a trailing `templates/index.json` comment',
      ].join("\n"),
      "the constant in an error, in a module that opens paths": [
        'import { readFileSync } from "node:fs";',
        "throw new Error(`${TEMPLATE_DIRECTORY}/${TEMPLATE_INDEX_FILE} names no such template`);",
      ].join("\n"),
      "help prose inside a template literal": [
        "const help = `",
        "writes the greater of this binary's own version and the minimum",
        "templates/index.json declares (the first release carrying the 'nen shu' verbs",
        "`;",
      ].join("\n"),
      "the bare name, in a module that opens no path": 'throw new TemplateError(path, "templates", "a message");',
      "a one-line error message naming a templates/ path": [
        'import { readFileSync } from "node:fs";',
        'throw new Error("templates/index.json lists no template by that name");',
      ].join("\n"),
      "a web address of the directory": [
        'import { join } from "node:path";',
        'export const DOCS = "https://github.com/zheref/nen/tree/main/templates/full";',
      ].join("\n"),
      "a case label, in a module that imports node:path": [
        'import { join } from "node:path";',
        "switch (family) {",
        '  case "templates":',
        "    return 1;",
        "}",
      ].join("\n"),
      "a comparison, in a module that imports node:path": [
        'import { join } from "node:path";',
        'export const isTemplates = (family: string): boolean => family === "templates";',
      ].join("\n"),
    };
    expect(Object.keys(legitimate)).toHaveLength(10);
    for (const [shape, source] of Object.entries(legitimate)) {
      expect(offends(source), `${shape} must not be flagged`).toBe(false);
    }
  });

  // AND WHAT IT CANNOT SEE, pinned rather than promised. Each of these reads
  // templates/ and passes the sweep. Every one is listed in `offends`'s
  // docstring. A change that closes one turns this case red, so the docstring
  // gets updated in the same change.
  it("does not see the gaps its docstring lists", () => {
    const gaps: Readonly<Record<string, string>> = {
      "a path built through an identifier": [
        'import { readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const d = TEMPLATE_DIRECTORY;",
        'export const x = readFileSync(join(process.cwd(), d, "index.json"), "utf8");',
      ].join("\n"),
      "a call and its TEMPLATE_DIRECTORY argument on different lines": [
        'import { readFileSync } from "node:fs";',
        "export const x = readFileSync(",
        '  TEMPLATE_DIRECTORY + "/index.json",',
        '  "utf8",',
        ");",
      ].join("\n"),
      "a path literal that holds whitespace": [
        'import { readFileSync } from "node:fs";',
        'export const x = readFileSync("../../templates/my notes/x.json", "utf8");',
      ].join("\n"),
      "a wrapper imported from another module": [
        'import { readText } from "../text.js";',
        "export const x = readText(TEMPLATE_DIRECTORY);",
      ].join("\n"),
      "a spawned copy": 'export const p = Bun.spawn(["cp", "-r", TEMPLATE_DIRECTORY, out]);',
    };
    for (const [gap, source] of Object.entries(gaps)) {
      expect(offends(source), `${gap}: closed? then update offends's docstring`).toBe(false);
    }
  });
});

describe("the template pack agrees with the profiles pack", () => {
  const pack = loadProfilesPack();

  it("has a template directory for every stack the catalogue names one for", () => {
    // THE MUTATION THIS CATCHES: a stack gains `scaffoldTemplate: "x"` and no
    // `templates/x/` is added. Without this the failure is a runtime throw on
    // whichever machine first types `--stack <that one>`.
    const named = pack.ids
      .map((id): string | null => profileById(pack, id).scaffoldTemplate)
      .filter((name): name is string => name !== null);
    expect(named.length).toBeGreaterThan(0);
    for (const name of new Set(named)) expect(onDisk).toContain(name);
  });

  it("resolves a template for every stack with a template name, and null for the rest", () => {
    for (const id of pack.ids) {
      const expected = profileById(pack, id).scaffoldTemplate;
      const template = templateForStack(id);
      if (expected === null) {
        expect(template, id).toBeNull();
        continue;
      }
      expect(template?.template, id).toBe(expected);
      expect(template?.stack, id).toBe(id);
      expect(template?.runner, id).not.toBe("");
    }
  });

  it("gives every stack with a template EITHER a fresh tree OR a stated reason it has none", () => {
    for (const id of pack.ids) {
      const template = templateForStack(id);
      if (template === null) continue;
      if (template.noFreshTree === null) {
        expect(template.freshTree.length, id).toBeGreaterThan(0);
      } else {
        expect(template.freshTree, id).toEqual([]);
        expect(template.noFreshTree.length, id).toBeGreaterThan(40);
      }
    }
  });

  it("writes a CI workflow under .github/workflows for every template", () => {
    for (const name of bundledTemplateNames()) {
      const stack = knownStacks().find(
        (id): boolean => profileById(pack, id).scaffoldTemplate === name,
      ) as string;
      expect(templateForStack(stack)?.ci.path).toMatch(/^\.github\/workflows\/[a-z0-9-]+\.yml$/);
    }
  });

  it("runs build, test and lint through `nen shu`, dry-run first, and names no tool", () => {
    for (const name of bundledTemplateNames()) {
      const stack = knownStacks().find(
        (id): boolean => profileById(pack, id).scaffoldTemplate === name,
      ) as string;
      const body = templateForStack(stack)?.ci.body ?? "";
      expect(body).toContain("shu tools --repo .");
      expect(body).toContain("--dry-run");
      for (const verb of ["build", "test", "lint"]) expect(body).toContain(verb);
      // The dry run has to come FIRST in the file, or "dry-run-first" is a
      // claim the template does not make.
      expect(body.indexOf("--dry-run")).toBeLessThan(body.lastIndexOf("shu"));
    }
  });
});

describe("--stack is validated by shape first and membership second", () => {
  it("accepts every id the catalogue lists", () => {
    for (const id of knownStacks()) expect(resolveStackId(id)).toBe(id);
  });

  it("refuses a path-shaped value before it ever reaches a lookup", () => {
    expect((): unknown => resolveStackId("../../etc")).toThrow(VerbUsageError);
    expect((): unknown => resolveStackId("")).toThrow(VerbUsageError);
    expect((): unknown => resolveStackId("a b")).toThrow(VerbUsageError);
  });

  it("refuses an unknown id, listing the known ones", () => {
    expect((): unknown => resolveStackId("not-a-stack")).toThrow(/Known: .*nextjs/);
  });
});

describe("stackHosts", () => {
  it("is the catalogue's own map, verbatim", () => {
    const pack = loadProfilesPack();
    for (const id of pack.ids) expect(stackHosts(id)).toEqual(profileById(pack, id).hosts);
  });
});

describe("substitute", () => {
  it("replaces every occurrence of a token it was given", () => {
    expect(substitute("{{name}}/{{name}}", { name: "kro" }, "x")).toBe("kro/kro");
  });

  it("REFUSES an unsubstituted token rather than writing the placeholder to disk", () => {
    // A file written with `{{name}}` still in it looks scaffolded and is not,
    // and the caller finds out from whatever reads it next instead of from nen.
    expect((): unknown => substitute("{{name}} {{org}}", { name: "kro" }, "the x template")).toThrow(
      /\{\{org\}\}/,
    );
    expect((): unknown => substitute("{{org}}", {}, "the x template")).toThrow(VerbUsageError);
  });

  it("leaves text with no token alone, byte for byte", () => {
    const body = "name: nen shu\non:\n  pull_request:\n";
    expect(substitute(body, {}, "x")).toBe(body);
  });
});

// ── the family's own purity rule ────────────────────────────────────────────
//
// ../shu/purity.test.ts's rule, pointed at this directory: no module here may
// name a toolchain executable. `nen scaffold` writes a CI file whose every
// command is `nen shu <verb>`; the moment a module here knows what a package
// manager is called, "the CI file is data" has stopped being true for whichever
// stack it learned -- and the code still works, for that one stack, which is
// how a discipline of this shape dies.
//
// COMMENTS ARE SWEPT TOO, for ../shu/purity.test.ts's own reason: nothing a
// comment here needs to say requires a member name, so the only way this can be
// wrong is a false positive -- a reviewer told to rephrase -- and never a false
// negative.
const TOOLCHAIN_NAMES: readonly string[] = [
  "xcodebuild",
  "xcrun",
  "gradle",
  "gradlew",
  "fastlane",
  "eas-cli",
  "expo",
  "swiftlint",
  "msbuild",
  "dotnet",
  "turbo",
  "biome",
  "playwright",
  "maestro",
  "vercel",
  "npx",
  "npm",
  "pnpm",
  "yarn",
  "corepack",
  "gatsby",
  "storybook",
  "vitest",
  "cocoapods",
  "sdkmanager",
  "winget",
  "brew",
];

describe("no module of the scaffold family names a toolchain", () => {
  const modules = readdirSync(join(ROOT, "src", "scaffold"))
    .filter((file): boolean => file.endsWith(".ts") && !file.endsWith(".test.ts"))
    .sort();

  it("sweeps a non-empty module list", () => {
    expect(modules.length).toBeGreaterThan(3);
    expect(modules).toContain("templates.ts");
    expect(modules).toContain("init.ts");
    expect(modules).toContain("new.ts");
    expect(modules).toContain("command.ts");
  });

  for (const file of readdirSync(join(ROOT, "src", "scaffold"))
    .filter((name): boolean => name.endsWith(".ts") && !name.endsWith(".test.ts"))
    .sort()) {
    it(`src/scaffold/${file} names none of the ${TOOLCHAIN_NAMES.length}`, () => {
      const source = readFileSync(join(ROOT, "src", "scaffold", file), "utf8").toLowerCase();
      const hits = TOOLCHAIN_NAMES.filter((name): boolean =>
        new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(source),
      );
      expect(hits, `${file} names a toolchain; the CI template is DATA for this reason`).toEqual([]);
    });
  }

  it("proves the sweep can fail, on a string that really is in the data", () => {
    // The rule is worth nothing if the pattern matches nothing anywhere. The
    // template BODY is where such a name is allowed to live, so it is also the
    // proof that the matcher works.
    const body = "run: pnpm install\n".toLowerCase();
    expect(
      TOOLCHAIN_NAMES.filter((name): boolean =>
        new RegExp(`(?<![a-z0-9_])${name}(?![a-z0-9_])`).test(body),
      ),
    ).toContain("pnpm");
  });
});

// ── a template writes INSIDE the tree it was pointed at ─────────────────────

describe("a template's paths are validated at LOAD time", () => {
  // WHY LOAD TIME AND NOT WRITE TIME. Every byte of a template ships inside the
  // binary, so a `files` key of `../ESCAPED.txt` is a file nen writes one
  // directory ABOVE `--dir`, reported by the key it was written from, at exit
  // 0. The containment checks in ./init.ts guard a path a CALLER typed; this
  // guards a path the DATA states, and a bad one must fail this repository's
  // own suite rather than a user's scaffold.
  const escapes = [
    "../ESCAPED.txt",
    "a/../../ESCAPED.txt",
    "/etc/hosts",
    "./relative.txt",
    ".",
    "..",
    "a//b.txt",
    "a\\b.txt",
    "C:/x.txt",
    "",
  ];
  for (const value of escapes) {
    it(`refuses '${value}' as a template path`, () => {
      expect((): string => assertWritablePath(value, "<doc>", "files.x")).toThrow(TemplateError);
    });
  }

  it("accepts the shapes a real template uses", () => {
    for (const value of ["package.json", ".gitignore", ".github/workflows/nen-shu.yml", "app.json"]) {
      expect(assertWritablePath(value, "<doc>", "files.x")).toBe(value);
    }
  });

  it("every bundled template's own paths pass it", () => {
    // The rule applied to the shipped data, so the two cannot come apart: a
    // template that gained an escaping key fails HERE, in this suite.
    for (const stack of knownStacks()) {
      const template = templateForStack(stack);
      if (template === null) continue;
      expect(assertWritablePath(template.ci.path, "<bundled>", "ci.path")).toBe(template.ci.path);
      for (const file of template.freshTree) {
        expect(assertWritablePath(file.path, "<bundled>", "files")).toBe(file.path);
      }
    }
  });
});

// ── substitution reads OWN properties only ──────────────────────────────────

describe("substitute", () => {
  it("refuses an INHERITED property name instead of substituting the prototype's", () => {
    // `values["constructor"]` is not undefined on a plain object: it is
    // `Object`, whose `String()` is the source of a native function. A template
    // body carrying `{{constructor}}` used to have that spliced into a
    // generated file at exit 0.
    for (const token of ["constructor", "toString", "valueOf", "hasOwnProperty"]) {
      expect((): string => substitute(`x {{${token}}} y`, { name: "kro" }, "<doc>")).toThrow(
        VerbUsageError,
      );
      expect((): string => substitute(`x {{${token}}} y`, { name: "kro" }, "<doc>")).toThrow(
        `{{${token}}}`,
      );
    }
  });

  it("still substitutes an own property, including one whose value is empty", () => {
    expect(substitute("a {{name}} b", { name: "kro" }, "<doc>")).toBe("a kro b");
    expect(substitute("a {{name}} b", { name: "" }, "<doc>")).toBe("a  b");
  });
});

// ── the ref a generated workflow may pin nen at ─────────────────────────────

describe("templates/index.json's minimumNenRef", () => {
  // `* text=auto` in .gitattributes leaves the working-tree line ending to the
  // platform, so a Windows checkout hands this file CRLF and a heading captured
  // by `(.+)$` below would carry a trailing `\r`. Normalise once, here, for the
  // same reason ../cli/surface.test.ts does.
  const CHANGELOG = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8").replace(/\r\n/g, "\n");

  /**
   * Every released heading, newest first. Headings read `## vX.Y.Z — <date>`
   * (an em dash, not `--`, separates the version from the date), but the
   * regex below keys only on the `## vX.Y.Z` prefix -- what follows it,
   * separator included, is not part of what this parses.
   */
  const released = [...CHANGELOG.matchAll(/^## (v\d+\.\d+\.\d+)/gm)].map(
    (match): string => match[1] as string,
  );

  /** Every `## ` section in document order (newest first): its title and body. */
  const heads = [...CHANGELOG.matchAll(/^## (.+)$/gm)];
  const sections = heads.map((head, index): { title: string; body: string } => ({
    title: (head[1] as string).trim(),
    body: CHANGELOG.slice(
      (head.index as number) + head[0].length,
      index + 1 < heads.length
        ? ((heads[index + 1] as RegExpMatchArray).index as number)
        : CHANGELOG.length,
    ),
  }));

  /** Newest first, so the LAST section naming the family is the earliest one. */
  const carriers = sections.filter((section): boolean =>
    section.body.includes("new family `nen shu`"),
  );

  it("is a well-formed tag with a reason beside it", () => {
    const minimum = minimumNenRef();
    expect(minimum.ref).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(minimum.why.length).toBeGreaterThan(80);
  });

  it("names a PUBLISHED release, no newer than this build's own version", () => {
    // THE RULE, AND WHY IT CHANGED IN v0.3.0. The question the minimum answers
    // is "which release first carried the verbs these templates call", and this
    // repository has exactly one artifact that records when a verb SHIPPED:
    // CHANGELOG.md, whose `## vX.Y.Z` headings are the published releases and
    // whose `## Unreleased` section is what has not shipped yet. A constant in
    // src/shu/command.ts was the alternative and is worse twice over -- it is a
    // second place to write a fact that already has a place, and it would record
    // what a developer TYPED rather than what was RELEASED, which is the fact
    // the bootstrap actually depends on. `git ls-tree v0.3.0` is the direct
    // evidence and is not available to a test: this suite runs on three
    // platforms, on a checkout that may be shallow, with no network.
    //
    // WHAT THIS USED TO ASSERT, AND WHY THAT WAS TEMPORARY. Until v0.3.0 was
    // cut, `nen shu` sat under `## Unreleased` and the minimum named a version
    // that did not exist yet, so the rule was "STRICTLY NEWER than every
    // released heading". That rule expires the moment the release it names is
    // rolled into the CHANGELOG -- it would demand the minimum step forward to a
    // version nobody has built, on every release, forever. The durable
    // invariant is the one the minimum actually means: it names a version this
    // binary can be (`minimum <= VERSION`) and, in the test below, the FIRST
    // release whose section carries the family. `>` became `<=` against
    // `v${VERSION}` and `toContain` against the released headings; nothing about
    // templates/index.json's data moved.
    expect(released.length, "the changelog must carry released headings").toBeGreaterThan(0);
    expect(released, "the minimum must name a release the CHANGELOG has published").toContain(
      minimumNenRef().ref,
    );
    expect(
      compareNenRefs(minimumNenRef().ref, `v${VERSION}`),
      `${minimumNenRef().ref} must not be newer than this build's own v${VERSION}`,
    ).toBeLessThanOrEqual(0);
  });

  it("is justified: it names the FIRST release whose section carries the `shu` family", () => {
    expect(carriers.length, "some section must announce the family").toBeGreaterThan(0);
    // Sections are newest first, so the earliest announcement is the last one.
    const earliest = carriers[carriers.length - 1] as { title: string; body: string };
    expect(earliest.title, "the family must be announced under a release, not `Unreleased`").toMatch(
      /^v\d+\.\d+\.\d+/,
    );
    // Only the heading's version token has to equal the minimum -- not the
    // whole `## vX.Y.Z — <date>` shape, which is incidental formatting the
    // parser above does not depend on either. `startsWith(`${ref} `)` would
    // reject a dateless `## vX.Y.Z` heading outright; comparing tokens does
    // not.
    const versionToken = (title: string): string => title.split(/\s+/)[0] ?? "";
    expect(versionToken(earliest.title)).toBe(minimumNenRef().ref);
    // A dateless heading -- `## vX.Y.Z` with nothing after it -- must satisfy
    // the same check.
    expect(versionToken(minimumNenRef().ref)).toBe(minimumNenRef().ref);
    // ...and nowhere in a section OLDER than that one, which is what makes "this
    // is the first release carrying these verbs" an observation, not a claim.
    const older = sections.slice(sections.indexOf(earliest) + 1);
    for (const section of older) {
      expect(section.body, `${section.title} must not announce the family`).not.toContain(
        "new family `nen shu`",
      );
    }
  });

  it("compares refs NUMERICALLY, field by field", () => {
    // `"v0.10.0" < "v0.9.0"` as strings, and a minimum compared that way would
    // accept a ref older than itself.
    expect(compareNenRefs("v0.10.0", "v0.9.0")).toBeGreaterThan(0);
    expect(compareNenRefs("v0.2.0", "v0.3.0")).toBeLessThan(0);
    expect(compareNenRefs("v1.0.0", "v0.99.99")).toBeGreaterThan(0);
    expect(compareNenRefs("v0.3.0", "v0.3.0")).toBe(0);
    expect(compareNenRefs("v0.3.1", "v0.3.0")).toBeGreaterThan(0);
  });
});

// ── which stacks have a fresh-tree form ─────────────────────────────────────

describe("freshTreeSupport", () => {
  it("partitions every known stack exactly once", () => {
    const support = freshTreeSupport();
    const all = [...support.freshTree, ...support.initOnly, ...support.noTemplate].sort();
    expect(all).toEqual([...knownStacks()].sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it("agrees with what each template actually says", () => {
    const support = freshTreeSupport();
    expect(support.freshTree.length).toBeGreaterThan(0);
    expect(support.initOnly.length).toBeGreaterThan(0);
    for (const stack of support.freshTree) {
      const template = templateForStack(stack);
      expect(template?.noFreshTree).toBeNull();
      expect(template?.freshTree.length).toBeGreaterThan(0);
    }
    for (const stack of support.initOnly) {
      const template = templateForStack(stack);
      expect(typeof template?.noFreshTree).toBe("string");
      expect(template?.freshTree).toEqual([]);
      // The refusal has to name the way forward, or it is a dead end.
      expect(template?.noFreshTree).toContain("scaffold init");
    }
    for (const stack of support.noTemplate) {
      expect(templateForStack(stack)).toBeNull();
    }
  });
});

// ── the generated workflow's own shape ──────────────────────────────────────

describe("every bundled CI body", () => {
  const bodies = (): readonly string[] =>
    bundledTemplateNames().map((name): string => {
      const stack = knownStacks().find(
        (id): boolean => profileById(loadProfilesPack(), id).scaffoldTemplate === name,
      );
      return templateForStack(stack as string)?.ci.body ?? "";
    });

  it("declares a read-only token", () => {
    // A generated workflow that declares no `permissions:` inherits whatever
    // the repository's default is -- write, in many repositories. This one
    // fetches a pinned release and runs read-only verbs against a checkout.
    for (const body of bodies()) {
      expect(body, "a workflow body declares no permissions block").toContain("permissions:");
      expect(body).toContain("contents: read");
    }
  });

  it("spells every workflow expression with spaces, so no token reads as a placeholder", () => {
    // `${{env.X}}` does NOT match PLACEHOLDER (`{{` + `[A-Za-z][A-Za-z0-9]*` +
    // `}}`, immediately closed -- src/scaffold/templates.ts): the `.` between
    // `env` and `}}` breaks the token, so `substitute()` leaves it untouched
    // rather than refusing the template. This is a readability guardrail, not a
    // refusal check -- `${{env.X}}` sits one character from `{{token}}`, and a
    // human skimming a generated workflow can misread which grammar they are
    // looking at. So every bundled body spells the GitHub Actions expression
    // with spaces (`${{ env.X }}`) to keep the two grammars visually apart.
    for (const body of bodies()) expect(body).not.toMatch(/\$\{\{[A-Za-z]/);
  });
});
