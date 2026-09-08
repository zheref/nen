// src/profiles/inertness.test.ts -- "the pack is a catalogue", enforced.
//
// THE INVARIANT, STATED ONCE: nothing that spawns a process reads the profiles
// pack. The pack may say what nen was TESTED against; it may never contribute a
// version, a URL or an argument to a command nen runs. The two functions that
// will build commands -- `renderInvocation` over a declaration, and
// `resolveInstall` over a declaration's toolchain entry -- take a declaration
// and nothing else, and neither exists yet, so the part of the invariant that
// CAN be enforced today is enforced here: an IMPORT-GRAPH property, swept out of
// the source in the style of ../taxonomy-purity.test.ts.
//
// WHY A SOURCE SWEEP RATHER THAN A TYPE. A type stops a function SIGNATURE from
// reaching the pack; it does not stop a module that spawns from importing the
// pack and reading a version out of it three lines above the spawn. The sweep
// does, and it fails the build rather than a review.
//
// THE ALLOWLIST IS EXPLICIT, AND SHORT ON PURPOSE. Adding a name to it is the
// review conversation this file exists to force: whoever adds one is claiming
// that a module reading the catalogue will never let it reach a command, and
// they are saying so in a diff a reviewer sees. Two of the three entries name
// modules that DO NOT EXIST YET -- the detection and toolchain-report verbs --
// and that is deliberate: the boundary is drawn before the code that will sit
// on it, not after.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const SRC = join(process.cwd(), "src");

// Repo-relative, `/`-separated, `.ts`-suffixed. The module under guard.
const PACK = "profiles/pack.ts";

// THE ONLY MODULES THAT MAY IMPORT THE PACK.
//
//   * `dev/matrix.ts`   -- the generator. It renders a page and spawns nothing.
//   * `shu/detect.ts`   -- (not yet written) proposes a DECLARATION a human
//                          reads and edits. It writes a file; it runs no verb.
//   * `shu/tools.ts`    -- (not yet written) reports an advisory `packMinimum`
//                          column beside what it probed. The probe argv and any
//                          install argv come from the DECLARATION; the pack
//                          contributes a string to a report and nothing else.
//                          This is the one narrowing of the invariant, and it
//                          is why the rule below is written in terms of the
//                          SEAM rather than in terms of this list alone.
const ALLOWED_IMPORTERS: readonly string[] = ["dev/matrix.ts", "shu/detect.ts", "shu/tools.ts"];

// The module every spawn in this repository goes through. A module that imports
// it is a module that can run a program.
const SEAM = "seam/exec.js";

function readSource(file: string): string {
  return readFileSync(file, "utf8").replace(/\r\n/g, "\n");
}

function shippedFiles(dir: string, found: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      if (entry === "fixtures") continue;
      shippedFiles(path, found);
      continue;
    }
    if (!entry.endsWith(".ts")) continue;
    // Tests may import anything: a test that could not name the pack could not
    // test it, and a test spawns nothing a user runs.
    if (entry.endsWith(".test.ts")) continue;
    found.push(path);
  }
  return found;
}

function name(file: string): string {
  return relative(SRC, file).split(sep).join("/");
}

// Every `from "..."` specifier in a module.
//
// LINE-BASED, AND COMMENT LINES ARE SKIPPED. These headers are long and cite
// module paths in prose constantly, so a sweep that read comments would report
// every file that MENTIONS the pack as a file that IMPORTS it -- and a rule
// with false positives is a rule somebody weakens. A line whose first non-space
// characters open or continue a comment is not code; anything else is.
function importSpecifiers(source: string): string[] {
  const found: string[] = [];
  for (const line of source.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) continue;
    const match = /from\s+["']([^"']+)["']/.exec(trimmed);
    if (match?.[1] !== undefined) found.push(match[1]);
  }
  return found;
}

interface Module {
  readonly name: string;
  readonly specifiers: readonly string[];
}

const MODULES: readonly Module[] = shippedFiles(SRC).map((file): Module => ({
  name: name(file),
  specifiers: importSpecifiers(readSource(file)),
}));

// Matches `./pack.js`, `../profiles/pack.js`, and the `.ts` spellings, while
// NOT matching a module that merely happens to end in the same four letters
// (`unpack.js`) -- the character before `pack` must be a path separator.
//
// EXPORTED SHAPE, TESTED SEPARATELY. The sweep below is only as trustworthy as
// this predicate, and the sweep's own result is (correctly) EMPTY whenever
// nothing has yet been allowed to import the pack -- so an assertion over the
// real tree could not prove the scanner works. Its cases are its own, in the
// style of ../taxonomy-purity.test.ts's `stripComments` suite.
export function specifiersImportPack(from: string, specifiers: readonly string[]): boolean {
  return specifiers.some((specifier): boolean =>
    /(^|\/)profiles\/pack\.(js|ts)$/.test(specifier) ||
    (from.startsWith("profiles/") && /^\.\/pack\.(js|ts)$/.test(specifier)),
  );
}

function importsPack(module: Module): boolean {
  return specifiersImportPack(module.name, module.specifiers);
}

function importsSeam(module: Module): boolean {
  return module.specifiers.some((specifier): boolean => specifier.endsWith(SEAM));
}

describe("the profiles pack is inert", () => {
  it("sweeps a non-trivial number of shipped modules, including the pack itself", () => {
    // A sweep that silently matched nothing would pass forever.
    expect(MODULES.length).toBeGreaterThan(10);
    expect(MODULES.map((module): string => module.name)).toContain(PACK);
    // Every module the sweep read parsed into at least one import, or the
    // scanner is silently returning nothing and both rules below are vacuous.
    expect(MODULES.filter((module): boolean => module.specifiers.length > 0).length).toBeGreaterThan(
      10,
    );
    // And the allowlist itself carries no duplicate, which is how a list like
    // this quietly grows a second entry for the same module.
    expect(new Set(ALLOWED_IMPORTERS).size).toBe(ALLOWED_IMPORTERS.length);
  });

  it("is imported only by the modules named here", () => {
    const importers = MODULES.filter(importsPack).map((module): string => module.name);
    const unexpected = importers.filter((module): boolean => !ALLOWED_IMPORTERS.includes(module));
    expect(unexpected).toEqual([]);
  });

  it("is imported by no module that can spawn a process", () => {
    // COMPUTED, not listed -- so it stays true even if the allowlist above is
    // one day widened by someone who did not think about the seam. This is the
    // assertion the invariant is actually about; the allowlist is the review
    // gate in front of it.
    const offences = MODULES.filter(
      (module): boolean => importsPack(module) && importsSeam(module),
    ).map((module): string => module.name);
    expect(offences).toEqual([]);
  });

  it("cannot spawn anything itself", () => {
    const pack = MODULES.find((module): boolean => module.name === PACK);
    expect(pack).toBeDefined();
    const specifiers = pack?.specifiers ?? [];
    expect(specifiers.filter((specifier): boolean => specifier.endsWith(SEAM))).toEqual([]);
    // `node:child_process` never appears in this repository outside the seam;
    // asserting it here as well means the pack does not become the exception.
    expect(specifiers.filter((specifier): boolean => specifier.includes("child_process"))).toEqual(
      [],
    );
  });
});

describe("the import scanner", () => {
  // The rules above are only as trustworthy as this, and their real-tree result
  // is legitimately empty while no verb reads the pack -- so the predicate is
  // pinned here instead, including the two cases that would make a violation
  // invisible and the one that would make a non-violation a false positive.
  it("sees the pack imported by path, from anywhere in the tree", () => {
    expect(specifiersImportPack("dev/matrix.ts", ["../profiles/pack.js"])).toBe(true);
    expect(specifiersImportPack("shu/tools.ts", ["../profiles/pack.ts"])).toBe(true);
    expect(specifiersImportPack("a/b/c.ts", ["../../profiles/pack.js"])).toBe(true);
  });

  it("sees it imported from beside itself", () => {
    expect(specifiersImportPack("profiles/other.ts", ["./pack.js"])).toBe(true);
  });

  it("does not mistake a module whose name merely ends the same way", () => {
    expect(specifiersImportPack("a.ts", ["../profiles/unpack.js"])).toBe(false);
    expect(specifiersImportPack("a.ts", ["./pack.js"])).toBe(false);
    expect(specifiersImportPack("a.ts", ["node:fs", "../schema/contract.js"])).toBe(false);
  });

  it("reads specifiers out of code and not out of prose", () => {
    const source = [
      '// a header that says: import x from "../profiles/pack.js"',
      ' * and a block-comment line quoting from "../seam/exec.js"',
      'import { loadProfilesPack } from "../profiles/pack.js";',
    ].join("\n");
    expect(importSpecifiers(source)).toEqual(["../profiles/pack.js"]);
  });
});
