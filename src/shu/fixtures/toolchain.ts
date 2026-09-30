// src/shu/fixtures/toolchain.ts -- the toolchain names ../purity.test.ts
// forbids on the execution path, and the matcher that finds one in a line.
//
// TEST SUPPORT ONLY. It lives under `fixtures/` for the same reason
// ./paths.ts does: the shu purity sweep, ../../taxonomy-purity.test.ts and
// ../../profiles/inertness.test.ts all skip that directory. A file that names
// twenty-eight programs could not sit anywhere else under `src/shu/` without
// failing the rule it exists to enforce. No shipped module imports it, so
// `bun build --compile ./src/index.ts` never reaches it.
//
// IT IS A MODULE RATHER THAN AN EXPORT OF ../purity.test.ts, and the move is
// a fix (#280). ../detect.test.ts used to import `toolsNamedIn` straight out
// of ../purity.test.ts, and importing a test file registers its `describe`s a
// second time, differently in each runner:
//   * vitest isolates each file. purity's 11 tests ran inside detect.test.ts
//     AND again on their own: 376 for the pair.
//   * `bun test` shares one module cache. It registered them once, under
//     detect.test.ts, and never again when it reached purity.test.ts as an
//     entry: 365 for the pair, and nothing filed under purity.test.ts in its
//     junit report.
// So the two runners' totals differed by exactly those 11, and neither one
// reported what ran where. A test file another test file imports gets counted
// differently by each runner. The two files now share this module, and
// neither imports the other.

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
export const TOKEN_SPLIT = /[\s/\\=,:;()[\]{}<>|&"'`]+/;

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
