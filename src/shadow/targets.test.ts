import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// THE ONE THING IN `targets.json` THAT IS A PATH RATHER THAN A NAME, and
// therefore the one thing in it that can go stale without anybody noticing.
//
// `src/shadow/run.ts` reads `identityFixture` and joins it to `--repo`; nothing
// else in the tree references it, it has no type-level connection to the
// fixture it names, and the script itself only runs against the network during
// a shadow window. So when zheref/nen#108 moved the bundled fixtures from
// `schemas/` to `nen/`, this string kept pointing at a file that no longer
// existed and every check stayed green. One assertion closes that.
describe("src/shadow/targets.json", () => {
  it("names an identity fixture that is actually on disk", () => {
    const targets = JSON.parse(
      readFileSync(join(process.cwd(), "src", "shadow", "targets.json"), "utf8"),
    ) as { identityFixture: string };
    // Split on "/" and re-join, exactly as run.ts does, so this passes on
    // Windows for the same reason the script does.
    const path = join(process.cwd(), ...targets.identityFixture.split("/"));
    expect(existsSync(path), `${targets.identityFixture} does not exist`).toBe(true);
  });
});
