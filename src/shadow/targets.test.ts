import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { buildCandidates, type Targets } from "./run.js";

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

// zheref/nen#80. `src/schema/source.ts` states the convention -- "a $-prefixed
// key is METADATA, not data" -- and names the obligation it creates: "the next
// loader that key-walks a data map inherits this same obligation". The
// closed-oracle map was the last key-walked map in shipped code that had not
// applied it, and `targets.json` documented the hazard in PROSE instead. Prose
// beside a walk is a note about a defect rather than a guard against it.
describe("buildCandidates -- a $-prefixed key is metadata, not a repository", () => {
  function targets(closed: Record<string, readonly number[]>): Targets {
    return {
      openPrRepos: [],
      oracleRepo: "o/oracle",
      identityFixture: "src/schema/fixtures/bankai-repo",
      closedOraclePrs: closed,
      knownReasonDivergence: "",
    };
  }

  it("skips a $comment placed INSIDE the map, and keeps every real entry", () => {
    const candidates = buildCandidates(
      targets({
        $comment: [] as unknown as readonly number[],
        "o/one": [1, 2],
        "o/two": [3],
      }),
      null,
    );
    expect(candidates.map((entry): string => `${entry.repo}#${entry.number}`)).toEqual([
      "o/one#1",
      "o/one#2",
      "o/two#3",
    ]);
  });

  it("would otherwise have tried to fetch pull requests from a repository named '$comment'", () => {
    // The failure this closes, stated as the thing that would have happened:
    // the walk hands each key to the fetch as a repo slug.
    const candidates = buildCandidates(targets({ $note: [9] as readonly number[] }), null);
    expect(candidates).toEqual([]);
  });

  it("leaves an ordinary key that merely CONTAINS a $ alone", () => {
    // The convention is about a key that STARTS with `$`; a slug carrying one
    // elsewhere is a repository name like any other.
    const candidates = buildCandidates(targets({ "o/we$rd": [4] }), null);
    expect(candidates.map((entry): string => entry.repo)).toEqual(["o/we$rd"]);
  });
});
