// src/cli/surface.test.ts -- "the docs describe THIS binary's surface", enforced.
//
// WHY THIS FILE EXISTS. Three places state how big nen is, and before this they
// disagreed: docs/USAGE.md's header said 34 command families and 70 verbs, its
// own verb index said 83, and README.md said 35 and 83. Every one of those
// numbers is a promise a reader checks a document against, and three answers
// means at least two documents were describing a binary that no longer exists.
//
// WHICH ONE IS AUTHORITATIVE, AND THE ARGUMENT FOR IT.
//
//   * THE FAMILY COUNT IS THE REGISTRY'S, computed: ../cli/registry.ts's
//     `COMMANDS` plus the two PRE-REGISTRY commands ../index.ts writes out by
//     hand. That is exactly what `nen --help` lists, because `nen --help`
//     renders that same list, so the number in the docs is the number on
//     screen by construction rather than by somebody counting.
//   * THE VERB COUNT IS docs/USAGE.md's OWN SECTION COUNT, cross-checked
//     against the registry. A verb list cannot be computed from the registry
//     the way the family list can -- a family's subcommands live inside its
//     `run()`, in a `requireSubcommand` call, and three families (`parse`,
//     `stop`, `warmup`) have no subcommand at all -- so a "computed" count
//     would have been a second parser of the same source with its own
//     opinions. What CAN be computed, and is, is the FAMILY SET behind those
//     sections: every registry family must have at least one documented verb
//     and every documented verb must name a real family. That is the property
//     that actually goes wrong (a family ships undocumented), and with it the
//     section count is a number the document proves about itself.
//
// So: a new verb changes one number in two files and this test says which.

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { COMMANDS } from "./registry.js";

const ROOT = process.cwd();
const USAGE = readFileSync(join(ROOT, "docs", "USAGE.md"), "utf8");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

/**
 * The two commands ../index.ts spells out above the registry listing.
 *
 * They are named here rather than counted because they are named there: both
 * predate ../cli/registry.ts and each carries its own usage block, which is the
 * whole reason they are not `Command` objects. A third one would have to be
 * added to both places, and this list is the place a reviewer sees it.
 */
const PRE_REGISTRY: readonly string[] = ["bootstrap", "schema"];

/** Every `### \`nen <family> [verb]\`` heading in docs/USAGE.md. */
const SECTIONS = [...USAGE.matchAll(/^### `nen ([a-z][a-z-]*)/gm)].map(
  (match): string => match[1] as string,
);

describe("the documented surface is this binary's surface", () => {
  it("documents every registered family, and invents none", () => {
    const documented = [...new Set(SECTIONS)].sort();
    const real = [...COMMANDS.map((command): string => command.name), ...PRE_REGISTRY].sort();
    expect(documented).toEqual(real);
  });

  it("states the SAME family count in both documents, and it is the registry's", () => {
    const families = COMMANDS.length + PRE_REGISTRY.length;
    expect(USAGE).toContain(`${families} command\nfamilies`);
    expect(README).toContain(`lists every command family (${families})`);
  });

  it("states the SAME verb count in both documents, and it is the section count", () => {
    // Three statements of one number: USAGE's header, USAGE's verb index, and
    // README's pointer at it. A new verb updates all three or fails here.
    expect(SECTIONS.length).toBeGreaterThan(50);
    expect(USAGE).toContain(`${SECTIONS.length} verbs, every flag`);
    expect(USAGE).toContain(`All ${SECTIONS.length} verbs, grouped`);
    expect(README).toContain(`documents all\n${SECTIONS.length} verbs outside the binary`);
  });

  it("names no count that contradicts those two", () => {
    // The failure this catches is the one that happened: a stale "34 command
    // families" left behind in a header nobody re-read. Any OTHER
    // "<n> command families" or "<n> verbs" in either document is a second
    // answer to a question that has one.
    const families = COMMANDS.length + PRE_REGISTRY.length;
    for (const [document, text] of [
      ["docs/USAGE.md", USAGE],
      ["README.md", README],
    ] as const) {
      for (const match of text.matchAll(/(\d+)\s+command\s*\n?\s*families/g)) {
        expect(Number(match[1]), `${document} states ${match[1]} command families`).toBe(families);
      }
      for (const match of text.matchAll(/(?:all|All)\s*\n?\s*(\d+) verbs/g)) {
        expect(Number(match[1]), `${document} states ${match[1]} verbs`).toBe(SECTIONS.length);
      }
    }
  });

  it("gives each documented verb an anchor a link can reach", () => {
    // A heading is only a reference if the cross-links above it resolve; the
    // repository's own tables link to `#nen-<family>-<verb>`.
    for (const heading of USAGE.matchAll(/^### `nen ([a-z][a-z -]*[a-z])`/gm)) {
      const anchor = `#nen-${(heading[1] as string).replace(/ /g, "-")}`;
      expect(USAGE.includes(anchor), `${heading[0]} has no inbound link at ${anchor}`).toBe(true);
    }
  });
});
