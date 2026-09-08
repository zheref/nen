// src/shu/purity.test.ts -- the family's own §3 rule, enforced the way
// ../taxonomy-purity.test.ts enforces the taxonomy one.
//
// THE RULE: no file on the EXECUTION path may name a toolchain executable.
// `nen shu build` runs what the target repository declared; the moment
// ./run.ts or ./render.ts knows what a package manager is called, "nen follows
// the repository's own declaration" has stopped being true for whichever stack
// it learned, and the failure is invisible -- the code still works, for that one
// stack, which is exactly how a discipline of this shape dies.
//
// THE EXECUTION PATH IS READ OFF THE DIRECTORY, NOT TYPED OUT. It was a hand
// list of five filenames, which is a sweep that silently narrows every time a
// module is added: a new `src/shu/install.ts` would have joined the execution
// path and no rule would have covered it, and nothing would have said so. So
// the list is `readdirSync(SHU)` minus an EXCLUSION list, and every exclusion
// below is an argument rather than an omission:
//
//   * `detect.ts` DOES name filenames and manifest keys, legitimately. A
//     FILENAME is a universal fact -- `next.config.mjs` means the same thing in
//     every repository on earth -- while an ARGV is a repository's own
//     vocabulary. The design draws that line explicitly (§2.6), and a sweep
//     that erased it would force the marker table out into data, where a
//     reviewer could no longer see the one piece of filesystem knowledge this
//     family is allowed to have. It is also the one module here that reads the
//     reference pack, and ../profiles/inertness.test.ts is what holds it to
//     spawning nothing.
//   * `*.test.ts` and `fixtures/` are not shipped code. A test naming a tool is
//     how the rule is PROVED (this file names twenty-six of them), and a
//     fixture naming one is test data.
//   * `install.ts` NAMES THE ONE INSTALLER NEN IMPLEMENTS, and it is the only
//     exclusion added since this sweep was written. `nen shu tools --install`
//     is the one verb in this family that spawns a program NEN chose rather
//     than one a declaration named: a declaration names an installer ID out of
//     ../schema/contract.ts's closed `INSTALLERS` set, and turning an id into a
//     command is knowledge nen has to carry itself -- there is no declaration
//     to read it from. Three things keep the exclusion narrow, and all three
//     are ASSERTED below rather than promised here:
//       1. every toolchain name that module carries is a member of that closed
//          set. It may name an installer id; it may not name an argv nen chose.
//       2. it BUILDS commands and runs none -- it imports no seam and no
//          `child_process` -- so the sweep's real subject, what reaches a
//          spawn, is still covered by the modules the sweep still reads:
//          ./probe.ts is what spawns, and it is swept.
//       3. the enabled set is exactly one id, so "the one installer" is a fact
//          this file checks and not a sentence a header makes.
//     An exclusion that only SUBTRACTS is one that widens silently the first
//     time somebody adds a second name to the excluded file. This one adds
//     three rules in exchange for the file it drops.
//
// Two other exclusions are outside this directory and stated here because a
// reader will look for them: ../schema/contract.ts names the closed INSTALLER
// set, also legitimately -- a loader that refuses an unknown installer id has
// to be able to list the known ones, and refusing by name is the opposite of
// deciding by name -- and ../../profiles/*.json is where every reference argv
// lives, as data, read only by `detect` and never by anything that spawns.

// COMMENTS ARE SWEPT TOO, unlike in ../taxonomy-purity.test.ts, and the
// asymmetry is deliberate rather than an oversight. That file must exempt
// comments because the names it forbids are the ones its comments EXIST to
// record -- each one names the production incident a branch is there for. This
// rule forbids nothing a comment here needs: these files describe what they do
// in category words ("a package manager", "a build system") precisely because
// they must not know the members. So the sweep is the plain text, which means
// the only way it can be wrong is a FALSE POSITIVE -- a reviewer quoting a tool
// in prose, told to rephrase -- and never a false negative, which is the
// direction a guard should fail in. It also means this file needs no scanner of
// its own, and two scanners are two chances to disagree about what a comment is.

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { PLACEHOLDERS } from "../profiles/pack.js";
import { INSTALLERS, type Installer } from "../schema/contract.js";
import { ENABLED_INSTALLERS } from "./install.js";
import { REFUSED_PLACEHOLDERS } from "./render.js";

const SHU = join(process.cwd(), "src", "shu");

/** The one module allowed to turn an installer id into a command. */
const INSTALLER_MODULE = "install.ts";

/**
 * Files under `src/shu/` that are NOT on the execution path, each for the
 * reason this file's header states. Every name here must exist, or the
 * exclusion is a typo silently widening the sweep's blind spot.
 */
const NOT_EXECUTION_PATH: readonly string[] = ["detect.ts", INSTALLER_MODULE];

/** The files a `nen shu` invocation goes through on its way to a subprocess. */
const EXECUTION_PATH: readonly string[] = readdirSync(SHU)
  .filter(
    (entry): boolean =>
      entry.endsWith(".ts") && !entry.endsWith(".test.ts") && !NOT_EXECUTION_PATH.includes(entry),
  )
  .sort();

/**
 * Toolchain EXECUTABLES. The match is a WHOLE TOKEN inside a quoted literal,
 * not a whole literal and not a bare substring, and the difference is the
 * finding this rule was rewritten for: `"android/gradlew"` is a wrapper path
 * spelled inside a longer string, and the old whole-literal form passed it
 * while the header claimed no false negatives.
 *
 * A SUBSTRING RULE WOULD BE THE OTHER MISTAKE -- `next.config.mjs` is a
 * FILENAME and `const next = ...` is an identifier, and reporting either proves
 * nothing. So a literal is split on the characters that separate tokens in a
 * path, an argv or a flag, and each piece is compared whole.
 */
const TOOLCHAIN: readonly string[] = [
  "xcodebuild",
  "xcrun",
  "gradle",
  "gradlew",
  "gradlew.bat",
  "fastlane",
  "expo",
  "eas",
  "next",
  "gatsby",
  "vercel",
  "gh-pages",
  "npx",
  "npm",
  "yarn",
  "pnpm",
  "corepack",
  "turbo",
  "swiftlint",
  "biome",
  "vitest",
  "playwright",
  "maestro",
  "storybook",
  "dotnet",
  "msbuild",
  "pod",
  "cocoapods",
];

const TOOLS: ReadonlySet<string> = new Set(TOOLCHAIN);

/** Every quoted literal on a line: single, double and backtick alike. */
const QUOTED = /"([^"\n]*)"|'([^'\n]*)'|`([^`\n]*)`/g;

/** The separators between tokens in a path, an argv, a flag or a sentence. */
const TOKEN_SPLIT = /[\s/\\=,:;()[\]{}<>|&"'`]+/;

/** Every toolchain name a line spells as a whole token inside a quote. */
export function toolsNamedIn(line: string): readonly string[] {
  const found: string[] = [];
  for (const match of line.matchAll(QUOTED)) {
    const content = match[1] ?? match[2] ?? match[3] ?? "";
    for (const token of content.split(TOKEN_SPLIT)) {
      if (TOOLS.has(token.toLowerCase())) found.push(token);
    }
  }
  return found;
}

describe("§3 for the shu family: the executor decides with no toolchain name", () => {
  it("sweeps the files it claims to, and every exclusion names a real file", () => {
    // A sweep whose file list had drifted to nothing would pass forever, and
    // one whose exclusion list had a typo in it would quietly sweep one file
    // fewer than the header says.
    expect(EXECUTION_PATH).toContain("run.ts");
    expect(EXECUTION_PATH).toContain("render.ts");
    expect(EXECUTION_PATH.length).toBeGreaterThan(3);
    const present = readdirSync(SHU);
    for (const excluded of NOT_EXECUTION_PATH) expect(present).toContain(excluded);
    for (const file of EXECUTION_PATH) {
      expect(readFileSync(join(SHU, file), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("finds no toolchain executable named in the execution path", () => {
    const offences: string[] = [];
    for (const file of EXECUTION_PATH) {
      const code = readFileSync(join(SHU, file), "utf8").replace(/\r\n/g, "\n");
      code.split("\n").forEach((line, index): void => {
        for (const tool of toolsNamedIn(line)) {
          offences.push(`shu/${file}:${index + 1}: ${tool} -- in: ${line.trim()}`);
        }
      });
    }
    expect(offences).toEqual([]);
  });

  // ── the one excluded module, held to three rules instead of none ─────────

  it("names, in the installer module, only ids from the contract's closed set", () => {
    // AN EXCLUSION THAT ONLY SUBTRACTS WIDENS SILENTLY. This is the positive
    // half: whatever toolchain names that file carries, every one of them is an
    // installer ID the contract already publishes -- a name nen refuses an
    // unknown of, which is the opposite of a name nen decided to spawn.
    const named = [
      ...new Set(
        readFileSync(join(SHU, INSTALLER_MODULE), "utf8")
          .replace(/\r\n/g, "\n")
          .split("\n")
          .flatMap(toolsNamedIn)
          .map((tool): string => tool.toLowerCase()),
      ),
    ].sort();
    expect(named.filter((name): boolean => !INSTALLERS.includes(name as Installer))).toEqual([]);
    // And it names some, so the exclusion is not quietly covering an empty file
    // while the real names moved somewhere the sweep does read.
    expect(named).toEqual(["corepack", "npx"]);
  });

  it("keeps the installer module a BUILDER: it imports no seam and no child_process", () => {
    // The sweep's real subject is what reaches a spawn. This file is excluded
    // from the name rule precisely because it cannot spawn: ./probe.ts is what
    // runs an install plan, and ./probe.ts is swept like everything else.
    const code = readFileSync(join(SHU, INSTALLER_MODULE), "utf8");
    expect(code).not.toContain("seam/exec");
    expect(code).not.toContain("child_process");
  });

  it("enables exactly one installer, which is what 'the one installer' means", () => {
    expect(ENABLED_INSTALLERS).toEqual(["corepack"]);
    // Every enabled id is a member of the contract's closed set -- an installer
    // nen runs that the loader would refuse to read is not reachable at all.
    expect(ENABLED_INSTALLERS.every((id): boolean => INSTALLERS.includes(id))).toBe(true);
  });

  // The counterpart assertion, without which the rule above could be satisfied
  // by a pack that had quietly stopped carrying anything: the reference argv IS
  // in the pack, so "the names live in data" is a fact rather than an absence.
  it("finds the reference argv in the pack, where it belongs", () => {
    const pack = readFileSync(join(process.cwd(), "profiles", "nextjs.json"), "utf8");
    expect(pack.split("\n").flatMap(toolsNamedIn).length).toBeGreaterThan(0);
  });

  describe("the matcher itself", () => {
    // Every rule above is exactly as trustworthy as this. The first case is the
    // false negative the review found; the rest are the false positives a
    // substring rule would have produced instead.
    it("catches a tool spelled as one segment of a longer quoted string", () => {
      expect(toolsNamedIn('const wrapper = "android/gradlew";')).toEqual(["gradlew"]);
      expect(toolsNamedIn('const argv = ["turbo", "run", "build"];')).toEqual(["turbo"]);
      expect(toolsNamedIn('run("pnpm exec vitest run");')).toEqual(["pnpm", "vitest"]);
      expect(toolsNamedIn("const exe = `npx`;")).toEqual(["npx"]);
    });

    it("does not report a filename, an identifier or an unquoted word", () => {
      expect(toolsNamedIn('const marker = "next.config.mjs";')).toEqual([]);
      expect(toolsNamedIn("for (const next of entries) { }")).toEqual([]);
      expect(toolsNamedIn("// the package manager runs the build")).toEqual([]);
    });
  });
});

// ── the placeholder set, pinned across the seam ─────────────────────────────

describe("the executor refuses exactly the reference pack's placeholder tokens", () => {
  // ./render.ts RESTATES the closed set rather than importing it, because
  // importing it would put the pack on the execution path and
  // ../profiles/inertness.test.ts would (correctly) fail the build. This is the
  // pin that makes the copy safe: a token added to the catalogue and not to the
  // executor would otherwise reach a spawn as a literal argument.
  it("names the same tokens the pack does, in the same order", () => {
    expect(REFUSED_PLACEHOLDERS).toEqual(
      PLACEHOLDERS.map((placeholder): string => placeholder.token),
    );
  });

  it("is a set, not a list with a duplicate in it", () => {
    expect(new Set(REFUSED_PLACEHOLDERS).size).toBe(REFUSED_PLACEHOLDERS.length);
  });
});
