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
// WHY THE SWEEP IS SCOPED TO THREE FILES RATHER THAN TO `src/`, and why that is
// the honest scope rather than a convenient one:
//
//   * ./detect.ts DOES name filenames and manifest keys, legitimately. A
//     FILENAME is a universal fact -- `next.config.mjs` means the same thing in
//     every repository on earth -- while an ARGV is a repository's own
//     vocabulary. The design draws that line explicitly (§2.6), and a sweep that
//     erased it would force the marker table out into data, where a reviewer
//     could no longer see the one piece of filesystem knowledge this family is
//     allowed to have.
//   * ../schema/contract.ts names the closed INSTALLER set, also legitimately: a
//     loader that refuses an unknown installer id has to be able to list the
//     known ones, and refusing by name is the opposite of deciding by name.
//   * ../../profiles/*.json is where every reference argv lives -- data, read
//     only by `detect`, and never by anything that spawns a process.
//
// So the sweep names the files where the rule bites, and every exclusion above
// is an argument rather than an omission. Widening it is a review conversation,
// not an edit.

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
import { readFileSync } from "node:fs";
import { join } from "node:path";

const SHU = join(process.cwd(), "src", "shu");

/** The files a `nen shu` invocation goes through on its way to a subprocess. */
const EXECUTION_PATH: readonly string[] = ["command.ts", "declaration.ts", "exit.ts", "render.ts", "run.ts"];

/**
 * Toolchain EXECUTABLES, as whole quoted literals -- the same shape
 * ../taxonomy-purity.test.ts's D16 rule uses, and for the same reason: `next`
 * and `pod` are ordinary identifiers in code, and a substring rule would report
 * a scanner's own `const next = ...` as a violation while proving nothing.
 */
const TOOLCHAIN =
  /["'`](xcodebuild|xcrun|gradle|gradlew|fastlane|expo|eas|next|gatsby|vercel|gh-pages|npx|npm|yarn|pnpm|turbo|swiftlint|biome|vitest|playwright|maestro|storybook|dotnet|msbuild|pod|cocoapods)["'`]/i;

describe("§3 for the shu family: the executor decides with no toolchain name", () => {
  it("sweeps the files it claims to", () => {
    // A sweep whose file list had drifted to nothing would pass forever.
    for (const file of EXECUTION_PATH) {
      expect(readFileSync(join(SHU, file), "utf8").length).toBeGreaterThan(0);
    }
  });

  it("finds no toolchain executable named in the execution path", () => {
    const offences: string[] = [];
    for (const file of EXECUTION_PATH) {
      const code = readFileSync(join(SHU, file), "utf8").replace(/\r\n/g, "\n");
      code.split("\n").forEach((line, index): void => {
        const match = TOOLCHAIN.exec(line);
        if (match !== null) offences.push(`shu/${file}:${index + 1}: ${match[0]} -- in: ${line.trim()}`);
      });
    }
    expect(offences).toEqual([]);
  });

  // The counterpart assertion, without which the rule above could be satisfied
  // by a pack that had quietly stopped carrying anything: the reference argv IS
  // in the pack, so "the names live in data" is a fact rather than an absence.
  it("finds the reference argv in the pack, where it belongs", () => {
    const pack = readFileSync(join(process.cwd(), "profiles", "nextjs.json"), "utf8");
    expect(TOOLCHAIN.test(pack)).toBe(true);
  });
});
