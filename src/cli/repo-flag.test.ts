// src/cli/repo-flag.test.ts -- "a verb that reads the repository says so in its
// own usage line", enforced (zheref/nen#56).
//
// WHY THIS FILE EXISTS. `--repo <path>` is a GLOBAL flag: accepted everywhere,
// defaulting to the current directory. That makes it easy to leave out of a
// usage block, and easy to leave out for a verb that CANNOT complete without
// it -- one that reads `nen/repos.json` or `nen/labels.json` off the root. A
// caller reading `--help` alone then learns of the flag only from an
// unexplained taxonomy-missing refusal on their first real attempt:
//
//     $ nen ref format --code BC --kind IS --number 877
//     nen ref: C:\\...\\schemas\\repos.json: no such file. ... --repo <path> ...
//
// `ref format` and `label apply` are the two the migration hit independently,
// which is what says this is a CLASS and not two oversights -- so the rule is a
// test rather than two corrected strings.
//
// HOW IT DECIDES, AND WHY IT IS DERIVED RATHER THAN LISTED. A family that reads
// the repository root does it through `context.repoFlag` -- that is the only
// route, because ../repo/root.ts's `resolveRepoRoot` takes it and nothing else
// resolves a root. So the question "does this verb read the repository" is
// answerable from the family's own source, and a hand-kept list of families
// would be one more thing to forget. A family that touches `repoFlag` must name
// `--repo` in its usage; one that does not is not asked to.
//
// THE RULE IS ONE-DIRECTIONAL on purpose: naming `--repo` in a usage block that
// does not need it is harmless (it IS accepted there), so this never complains
// about an extra mention.

import { describe, expect, it } from "vitest";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "./registry.js";

const ROOT = process.cwd();

/**
 * The family's own `command.ts`.
 *
 * FOUND BY THE NAME THE FILE DECLARES, not by directory, because one family is
 * not spelled like its directory: `nen parse` lives in `src/grammar/`. Looking
 * up by path would silently skip it, and a sweep that skips the one irregular
 * case is a sweep that proves the regular ones.
 */
function familySource(name: string): string | null {
  for (const directory of readdirSync(join(ROOT, "src"), { withFileTypes: true })) {
    if (!directory.isDirectory()) continue;
    const path = join(ROOT, "src", directory.name, "command.ts");
    if (!existsSync(path)) continue;
    const source = readFileSync(path, "utf8").replace(/\r\n/g, "\n");
    if (new RegExp(`name:\\s*"${name}"`).test(source)) return source;
  }
  return null;
}

/**
 * `--repo`, and NOT `--repo-slug`.
 *
 * They are different flags with deliberately different meanings -- a path on
 * disk versus an `owner/name` -- and `label apply`, one of the two verbs
 * zheref/nen#56 was filed about, names `--repo-slug` in its usage and not
 * `--repo`. A word-boundary test would read that as satisfied and report the
 * defect as absent, which is the failure mode of a check nobody re-reads.
 */
const NAMES_REPO_FLAG = /--repo(?![\w-])/;

describe("a verb that can read the repository names --repo in its own usage", () => {
  it("finds every registered family's source, so the sweep is not silently empty", () => {
    const missing = COMMANDS.filter((command): boolean => familySource(command.name) === null);
    expect(missing.map((command): string => command.name)).toEqual([]);
  });

  it("names --repo wherever the family reads the repository root", () => {
    const offences: string[] = [];
    for (const command of COMMANDS) {
      const source = familySource(command.name);
      if (source === null) continue;
      // `repoFlag` is the ONE route to a repository root (../repo/root.ts), so
      // its presence is the question "does this verb read the repository"
      // answered by the code rather than by a list somebody maintains.
      if (!source.includes("repoFlag")) continue;
      if (NAMES_REPO_FLAG.test(command.usage)) continue;
      offences.push(
        `${command.name}: reads the repository root but its usage never names --repo, so a caller reading --help alone meets the flag as a refusal instead`,
      );
    }
    expect(offences).toEqual([]);
  });
});
