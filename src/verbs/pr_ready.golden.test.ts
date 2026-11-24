// src/verbs/pr_ready.golden.test.ts -- the maintainer's ruling on
// zheref/nen#663, proved byte for byte: a repository that has NOT opted in to
// the version-collision gate reads exactly as it did on origin/main, including
// when the default tip's nen/gates.json cannot be read, parsed or validated.
// The goldens under ./fixtures/non-opted-in-main/ came from origin/main (its
// README names the commit), through the SAME scenario kit this test runs
// (./fixtures/pr_ready.golden-scenarios.ts).

import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { goldenFiles, runScenario, SCENARIOS } from "./fixtures/pr_ready.golden-scenarios.js";

const GOLDENS = join(process.cwd(), "src", "verbs", "fixtures", "non-opted-in-main");

describe("pr ready without the version-collision opt-in is byte-identical to origin/main (zheref/nen#663)", () => {
  it("every golden belongs to a scenario, and every scenario has its four goldens", () => {
    const expected = Object.keys(SCENARIOS).flatMap((name): string[] => [`${name}.exit.json`, `${name}.explain.txt`, `${name}.json`, `${name}.txt`]);
    expect(readdirSync(GOLDENS).filter((file): boolean => file !== "README.md").sort()).toEqual(expected.sort());
  });

  it.each(Object.keys(SCENARIOS))("%s", async (name) => {
    for (const [file, text] of Object.entries(goldenFiles(name, await runScenario(name)))) {
      // The GOLDEN's line endings are read as LF: .gitattributes pins these
      // files to LF, and this guards a checkout that ignored it (Git for
      // Windows' autocrlf). The product's own output is compared untouched.
      expect(text, file).toBe(readFileSync(join(GOLDENS, file), "utf8").replaceAll("\r\n", "\n"));
    }
  });
});
