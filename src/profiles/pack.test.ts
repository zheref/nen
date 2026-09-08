import { describe, expect, it } from "vitest";
import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SchemaError } from "../schema/errors.js";
import {
  bundledProfileFiles,
  loadProfilesPack,
  PACK_DIRECTORY,
  PACK_INDEX_FILE,
  parsePackIndex,
  parseProfile,
  PLACEHOLDERS,
  profileById,
  spellOnHost,
  verbCell,
  type ProfileVerb,
} from "./pack.js";

const AT = "/fake/profiles/example.json";

function refusal(run: () => unknown): SchemaError {
  try {
    run();
  } catch (error) {
    if (error instanceof SchemaError) return error;
    throw error;
  }
  throw new Error("expected a SchemaError, got a successful parse");
}

// A profile that VALIDATES, so each refusal below can change exactly one thing.
// Two verbs, because a fixture with one cannot show the "exactly these verbs"
// check doing anything.
const VERBS = ["build", "test"] as const;

function profile(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "example",
    displayName: "Example",
    markers: [{ pattern: "example.config.js", contains: null, why: "the config file" }],
    hosts: { "*": ["darwin", "linux", "win32"] },
    hostNote: "any",
    scaffoldTemplate: null,
    scaffoldNote: "none",
    verbs: {
      build: { exe: "example", argv: ["build"], why: "the repository's own", source: "a/b.md:1" },
      test: { unsupported: "no runner", summary: "no runner", source: "a/b.md:2" },
    },
    toolchain: {},
    ...overrides,
  };
}

describe("the bundled profiles pack", () => {
  const pack = loadProfilesPack();

  it("loads and validates every profile the index lists", () => {
    expect(pack.ids.length).toBeGreaterThan(0);
    for (const id of pack.ids) {
      const found = profileById(pack, id);
      expect(found.id).toBe(id);
      expect(found.displayName).not.toBe("");
      expect(found.markers.length).toBeGreaterThan(0);
      expect(Object.keys(found.hosts).length).toBeGreaterThan(0);
    }
    expect(Object.keys(pack.profiles).sort()).toEqual([...pack.ids].sort());
  });

  it("holds every profile to exactly the index's verbs, in the index's order", () => {
    expect(pack.verbs.length).toBeGreaterThan(0);
    for (const id of pack.ids) {
      expect(Object.keys(profileById(pack, id).verbs).sort()).toEqual([...pack.verbs].sort());
    }
  });

  it("gives every cell a citation, and every command cell a reason", () => {
    for (const id of pack.ids) {
      const found = profileById(pack, id);
      for (const verb of pack.verbs) {
        const cell: ProfileVerb = verbCell(found, verb);
        expect(cell.source, `${id}.${verb}`).not.toBe("");
        if (cell.kind === "command" || cell.kind === "steps") {
          // The pack tightens the declaration's optional `why` into a required
          // one: a catalogue row with no reason is the row that outlives the
          // fact it recorded.
          expect(cell.invocation.kind === "unsupported" ? "" : cell.invocation.why, `${id}.${verb}`)
            .not.toBeNull();
        }
      }
    }
  });

  it("lists its ids sorted, so the rendered page's row order is stable", () => {
    expect([...pack.ids]).toEqual([...pack.ids].sort());
  });

  it("reports its origin as the binary rather than a path", () => {
    // Inside a compiled binary there is no `profiles/` directory to name, so an
    // origin that looked like a path would be a path nobody can open.
    expect(pack.origin).toBe("<bundled>");
  });
});

describe("the bundled import list", () => {
  // A BUNDLER CANNOT FOLLOW A DIRECTORY READ, so `pack.ts` names each document
  // in a static import. That list is the one thing in this design that can
  // silently fall behind the data, and the failure it produces is the worst
  // available: a stack that exists in a checkout and is absent from every
  // shipped binary. These three assertions are why that cannot happen quietly.
  const directory = join(process.cwd(), PACK_DIRECTORY);
  const onDisk = readdirSync(directory)
    .filter((file): boolean => file.endsWith(".json") && file !== PACK_INDEX_FILE)
    .sort();

  it("names every file in profiles/", () => {
    expect([...bundledProfileFiles()].sort()).toEqual(onDisk);
  });

  it("matches the index, so no listed profile is missing from the binary", () => {
    const index = parsePackIndex(
      join(directory, PACK_INDEX_FILE),
      JSON.parse(readFileSync(join(directory, PACK_INDEX_FILE), "utf8")) as unknown,
    );
    expect(index.ids.map((id): string => `${id}.json`).sort()).toEqual(onDisk);
  });

  it("has no file on disk that the index does not list", () => {
    const pack = loadProfilesPack();
    expect(onDisk).toEqual(pack.ids.map((id): string => `${id}.json`).sort());
  });
});

describe("a malformed pack file is refused, naming the file and the field", () => {
  it("refuses a verb map that is not exactly the index's verbs", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", [...VERBS, "lint"], profile()),
    );
    expect(error.path).toBe(AT);
    expect(error.pointer).toBe("verbs");
    expect(error.message).toContain("missing [lint]");
    expect(error.message).toContain(`${PACK_DIRECTORY}/${PACK_INDEX_FILE}`);
  });

  it("refuses a verb the index does not list", () => {
    const extra = profile({
      verbs: {
        ...(profile()["verbs"] as Record<string, unknown>),
        publish: { unsupported: "nothing", summary: "nothing", source: "x" },
      },
    });
    const error = refusal(() => parseProfile(AT, "example", VERBS, extra));
    expect(error.pointer).toBe("verbs");
    expect(error.message).toContain("unknown [publish]");
  });

  it("refuses a cell with no source", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: { build: { exe: "e", argv: ["a"], why: "w" }, test: { unsupported: "n", summary: "n", source: "s" } },
      })),
    );
    expect(error.pointer).toBe("verbs.build.source");
  });

  it("refuses a command cell with no reason, which the declaration would allow", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { exe: "e", argv: ["a"], source: "s" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.build.why");
    expect(error.message).toContain("a catalogue entry may not");
  });

  it("refuses an unsupported cell with no summary for the grid", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { exe: "e", argv: ["a"], why: "w", source: "s" },
          test: { unsupported: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.test.summary");
  });

  it("PRESERVES an unknown key rather than refusing it, as the declaration does", () => {
    // ONE POLICY ACROSS THE FAMILY. ../schema/contract.ts preserves unknown
    // keys on `raw`, skips `$`-prefixed commentary, and therefore does not
    // detect a misspelling of a known key. This loader now behaves the same
    // way. An earlier draft refused a stray `summary` on a cell the grid never
    // abbreviates -- the only key in the family treated that way -- which
    // taught a reader a rule the file they were about to write does not follow.
    const parsed = parseProfile(AT, "example", VERBS, profile({
      verbs: {
        build: { exe: "e", argv: ["a"], why: "w", source: "s", summary: "never read", $note: "x" },
        test: { unsupported: "n", summary: "n", source: "s" },
      },
    }));
    expect(parsed.verbs["build"]?.kind).toBe("command");
    // Preserved, not silently dropped: the whole document is on `raw`.
    const verbs = parsed.raw["verbs"] as Record<string, Record<string, unknown>>;
    expect(verbs["build"]?.["summary"]).toBe("never read");
    expect(verbs["build"]?.["$note"]).toBe("x");
  });

  it("refuses a cell declaring two forms at once", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { declaredOnly: "d", summary: "s", exe: "e", argv: ["a"], source: "s" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.build");
    expect(error.message).toContain("exactly one form");
  });

  // Every stray key a `declaredOnly` cell could carry, refused ONE AT A TIME.
  // `argv` and `why` are the two the review found missing from the original
  // check -- it enumerated `exe`, `steps`, `unsupported` and `delegatesTo` but
  // not the two keys that belong to `command`, `steps` and `delegatesTo`
  // themselves -- and the other four are re-asserted here so the shared table
  // (`CELL_FORMS` in pack.ts) is pinned key by key, not just for the one
  // combination ("declaredOnly" + "exe") the test above already covers.
  const DECLARED_ONLY_STRAYS: readonly (readonly [string, Record<string, unknown>])[] = [
    ["argv", { declaredOnly: "d", summary: "s", argv: ["a"], source: "s" }],
    ["why", { declaredOnly: "d", summary: "s", why: "w", source: "s" }],
    ["exe", { declaredOnly: "d", summary: "s", exe: "e", source: "s" }],
    ["steps", { declaredOnly: "d", summary: "s", steps: [{ exe: "e", argv: ["x"] }], source: "s" }],
    ["unsupported", { declaredOnly: "d", summary: "s", unsupported: "n", source: "s" }],
    ["delegatesTo", { declaredOnly: "d", summary: "s", delegatesTo: ["test"], source: "s" }],
  ];
  for (const [key, cell] of DECLARED_ONLY_STRAYS) {
    it(`refuses a declaredOnly cell that also carries '${key}'`, () => {
      const error = refusal(() =>
        parseProfile(AT, "example", VERBS, profile({
          verbs: { build: cell, test: { unsupported: "n", summary: "n", source: "s" } },
        })),
      );
      expect(error.pointer).toBe("verbs.build");
      expect(error.message).toContain("exactly one form");
      expect(error.message).toContain(`'${key}'`);
    });
  }

  // The same, for `delegatesTo` -- except `why`, which `delegatesTo` legitimately
  // carries itself (every shipped delegation does; see the pack's own `warmup`
  // row), so `why` is not one of `delegatesTo`'s stray keys.
  const DELEGATES_TO_STRAYS: readonly (readonly [string, Record<string, unknown>])[] = [
    ["argv", { delegatesTo: ["test"], why: "w", argv: ["a"], source: "s" }],
    ["exe", { delegatesTo: ["test"], why: "w", exe: "e", source: "s" }],
    ["steps", { delegatesTo: ["test"], why: "w", steps: [{ exe: "e", argv: ["x"] }], source: "s" }],
    ["unsupported", { delegatesTo: ["test"], why: "w", unsupported: "n", source: "s" }],
    ["declaredOnly", { delegatesTo: ["test"], why: "w", declaredOnly: "d", source: "s" }],
  ];
  for (const [key, cell] of DELEGATES_TO_STRAYS) {
    it(`refuses a delegatesTo cell that also carries '${key}'`, () => {
      const error = refusal(() =>
        parseProfile(AT, "example", VERBS, profile({
          verbs: { build: cell, test: { unsupported: "n", summary: "n", source: "s" } },
        })),
      );
      expect(error.pointer).toBe("verbs.build");
      expect(error.message).toContain("exactly one form");
      expect(error.message).toContain(`'${key}'`);
    });
  }

  it("shares the mixed-form check across all five forms, not just the two catalogue-only ones", () => {
    // The gap this check closes is not particular to `declaredOnly` and
    // `delegatesTo`: an `unsupported` cell carrying a stray `why` -- a key no
    // form of THIS shape reads -- is the same authoring mistake, and the
    // shared table catches it too, with zero code written specifically for
    // `unsupported`. That is the point of routing all five forms through one
    // table: a sixth form added to it is checked, and checked against, from
    // the same place.
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { exe: "e", argv: ["a"], why: "w", source: "s" },
          test: { unsupported: "n", summary: "n", why: "w", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.test");
    expect(error.message).toContain("exactly one form");
    expect(error.message).toContain("'why'");
  });

  it("refuses a delegation to nothing", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { delegatesTo: [], why: "w", source: "s" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.build.delegatesTo");
  });

  it("refuses an argv written as a shell string", () => {
    // Borrowed verbatim from the declaration's own reader, which is the point
    // of borrowing it: one rule, one message, two files.
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { exe: "e", argv: "e build", why: "w", source: "s" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.build.argv");
    expect(error.message).toContain("argv ARRAY");
  });

  it("refuses a toolchain entry with no minimum key at all", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        toolchain: {
          node: { probe: ["node", "--version"], versionFrom: "first-semver-on-stdout", installer: "verify-only", why: "w", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("toolchain.node.minimum");
    expect(error.message).toContain("or null");
  });

  it("accepts a null minimum, which means presence only", () => {
    const parsed = parseProfile(AT, "example", VERBS, profile({
      toolchain: {
        node: { minimum: null, probe: ["node", "--version"], versionFrom: "first-semver-on-stdout", installer: "verify-only", why: "w", source: "s" },
      },
    }));
    expect(parsed.toolchain["node"]?.minimum).toBeNull();
  });

  it("refuses an installer outside the declaration's closed set", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        toolchain: {
          node: { minimum: "1", probe: ["node"], versionFrom: "first-semver-on-stdout", installer: "homebrew", why: "w", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("toolchain.node.installer");
    expect(error.message).toContain("CLOSED set");
  });

  it("refuses a profile whose id disagrees with the file it was read as", () => {
    const error = refusal(() => parseProfile(AT, "other", VERBS, profile()));
    expect(error.pointer).toBe("id");
    expect(error.message).toContain("read as 'other'");
  });

  it("refuses a profile with no marker", () => {
    const error = refusal(() => parseProfile(AT, "example", VERBS, profile({ markers: [] })));
    expect(error.pointer).toBe("markers");
  });

  it("refuses an empty host allowlist for a verb", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({ hosts: { build: [] } })),
    );
    expect(error.pointer).toBe("hosts.build");
  });

  it("refuses a platform name outside process.platform's closed set", () => {
    // AN ALLOWLIST FAILS SILENTLY WHEN IT IS WRONG. `"macos"` is not a value
    // `process.platform` returns, so a verb gated on it never runs anywhere --
    // and nothing errors, because an allowlist that matches nothing is a legal
    // allowlist. This is the only place the typo is visible. The rule lives in
    // ../schema/contract.ts, so the declaration's own `project.hosts` gained it
    // at the same time and by the same line.
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({ hosts: { "*": ["macos"] } })),
    );
    expect(error.pointer).toBe("hosts.*[0]");
    expect(error.message).toContain("CLOSED set");
    expect(error.message).toContain("darwin");
  });

  it("refuses a delegation to a verb the index does not list", () => {
    // A DELEGATION IS A POINTER AT A ROW OF THIS SAME TABLE. One that names no
    // column renders as a plausible `delegates to \`x\`` in the grid -- wrong,
    // and formatted exactly like right, which is the failure worth refusing.
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { delegatesTo: ["nonexistent-verb"], why: "w", source: "s" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.build.delegatesTo[0]");
    expect(error.message).toContain("nonexistent-verb");
    expect(error.message).toContain("build, test");
  });

  it("accepts a delegation to a verb the index does list", () => {
    const parsed = parseProfile(AT, "example", VERBS, profile({
      verbs: {
        build: { delegatesTo: ["test"], why: "w", source: "s" },
        test: { unsupported: "n", summary: "n", source: "s" },
      },
    }));
    const cell = parsed.verbs["build"];
    expect(cell?.kind).toBe("delegated");
  });

  it("refuses a commandVerbs entry that is not one of the index's verbs", () => {
    const error = refusal(() =>
      parsePackIndex(AT, { profiles: ["a"], verbs: ["build"], commandVerbs: ["deploy"] }),
    );
    expect(error.pointer).toBe("commandVerbs[0]");
    expect(error.message).toContain("not one of the verbs this index lists");
  });

  it("refuses an index listing no profile, and one listing no verb", () => {
    expect(refusal(() => parsePackIndex(AT, { profiles: [], verbs: ["build"], commandVerbs: ["build"] })).pointer).toBe("profiles");
    expect(refusal(() => parsePackIndex(AT, { profiles: ["a"], verbs: [], commandVerbs: [] })).pointer).toBe("verbs");
  });

  it("refuses a duplicated id or verb in the index", () => {
    expect(
      refusal(() => parsePackIndex(AT, { profiles: ["a", "a"], verbs: ["build"], commandVerbs: ["build"] })).message,
    ).toContain("'a' more than once");
    expect(
      refusal(() => parsePackIndex(AT, { profiles: ["a"], verbs: ["build", "build"], commandVerbs: ["build"] })).message,
    ).toContain("'build' more than once");
  });
});

describe("--profiles <dir>", () => {
  function writePack(contents: Record<string, unknown>): string {
    const dir = mkdtempSync(join(tmpdir(), "nen-profiles-"));
    for (const [file, value] of Object.entries(contents)) {
      writeFileSync(join(dir, file), `${JSON.stringify(value, null, 2)}\n`);
    }
    return dir;
  }

  it("loads an override directory instead of the bundled pack", () => {
    const dir = writePack({
      [PACK_INDEX_FILE]: { profiles: ["example"], verbs: [...VERBS], commandVerbs: [...VERBS] },
      "example.json": profile(),
    });
    const pack = loadProfilesPack(dir);
    expect(pack.ids).toEqual(["example"]);
    expect(pack.verbs).toEqual([...VERBS]);
    expect(pack.origin).toBe(dir);
    expect(profileById(pack, "example").displayName).toBe("Example");
  });

  it("validates an override exactly as it validates the bundled pack", () => {
    const dir = writePack({
      [PACK_INDEX_FILE]: { profiles: ["example"], verbs: [...VERBS, "lint"], commandVerbs: [...VERBS] },
      "example.json": profile(),
    });
    const error = refusal(() => loadProfilesPack(dir));
    expect(error.path).toBe(join(dir, "example.json"));
    expect(error.pointer).toBe("verbs");
    expect(error.message).toContain("missing [lint]");
  });

  it("names the missing file when a listed profile is not there", () => {
    const dir = writePack({ [PACK_INDEX_FILE]: { profiles: ["absent"], verbs: [...VERBS], commandVerbs: [...VERBS] } });
    const error = refusal(() => loadProfilesPack(dir));
    expect(error.path).toBe(join(dir, "absent.json"));
    expect(error.message).toContain("could not be read");
  });

  it("names the file when it is not valid JSON", () => {
    const dir = mkdtempSync(join(tmpdir(), "nen-profiles-"));
    writeFileSync(join(dir, PACK_INDEX_FILE), "{ not json");
    const error = refusal(() => loadProfilesPack(dir));
    expect(error.path).toBe(join(dir, PACK_INDEX_FILE));
    expect(error.message).toContain("is not valid JSON");
  });

  it("refuses a profile file the index does not list, as the bundled pin does", () => {
    // SYMMETRY WITH THE BUNDLED PACK, which is pinned against `profiles/` in
    // BOTH directions by the suite above. Before this rule an override
    // directory had no such check: drop a file in, forget the index line, and
    // the pack loads cleanly with your stack missing from every row. The only
    // symptom was an absence, which is the failure shape that survives review.
    const dir = writePack({
      [PACK_INDEX_FILE]: { profiles: ["example"], verbs: [...VERBS], commandVerbs: [...VERBS] },
      "example.json": profile(),
      "forgotten.json": { ...profile(), id: "forgotten" },
    });
    const error = refusal(() => loadProfilesPack(dir));
    expect(error.pointer).toBe("profiles");
    expect(error.message).toContain("forgotten.json");
    expect(error.message).toContain("List it, or delete the file");
  });
});

describe("placeholders", () => {
  const pack = loadProfilesPack();

  // Every `exe`, `argv` and `probe` string in the shipped pack, with the field
  // it came from -- which is the whole point: a token in a `toolchain.probe` is
  // as much an interface as one in a verb's argv, and the first draft of this
  // pack documented neither.
  function shippedArgvStrings(): { where: string; text: string }[] {
    const out: { where: string; text: string }[] = [];
    for (const id of pack.ids) {
      const profile = profileById(pack, id);
      for (const verb of pack.verbs) {
        const cell = verbCell(profile, verb);
        if (cell.kind === "command" && cell.invocation.kind === "command") {
          out.push({ where: `${id}.verbs.${verb}.exe`, text: cell.invocation.exe });
          for (const [index, item] of cell.invocation.argv.entries()) {
            out.push({ where: `${id}.verbs.${verb}.argv[${index}]`, text: item });
          }
        }
        if (cell.kind === "steps" && cell.invocation.kind === "steps") {
          for (const [stepIndex, step] of cell.invocation.steps.entries()) {
            out.push({ where: `${id}.verbs.${verb}.steps[${stepIndex}].exe`, text: step.exe });
            for (const [index, item] of step.argv.entries()) {
              out.push({
                where: `${id}.verbs.${verb}.steps[${stepIndex}].argv[${index}]`,
                text: item,
              });
            }
          }
        }
      }
      for (const [tool, entry] of Object.entries(profile.toolchain)) {
        for (const [index, item] of entry.probe.entries()) {
          out.push({ where: `${id}.toolchain.${tool}.probe[${index}]`, text: item });
        }
      }
    }
    return out;
  }

  it("documents every token any shipped argv or probe uses", () => {
    // THE ASSERTION THE REVIEW ASKED FOR, walked over the real data rather than
    // over a list somebody maintains by hand. Eight of the fifteen tokens that
    // shipped were explained nowhere -- including every one of the five in the
    // iOS profile, and one sitting inside a `toolchain.probe`.
    const known = new Set(PLACEHOLDERS.map((placeholder): string => placeholder.token));
    const undocumented: string[] = [];
    let seen = 0;
    for (const { where, text } of shippedArgvStrings()) {
      for (const match of text.matchAll(/\{[^{}]*\}/g)) {
        seen += 1;
        if (!known.has(match[0])) undocumented.push(`${where}: ${match[0]}`);
      }
    }
    expect(undocumented).toEqual([]);
    // A sweep that found nothing would pass forever, and this pack templates
    // heavily enough that finding nothing would mean the walker is broken.
    expect(seen).toBeGreaterThan(20);
  });

  it("documents nothing the pack does not actually use", () => {
    // The other direction: a closed set that accumulates entries nobody writes
    // is a table a reader has to check against the data themselves.
    const bundledDirectory = join(process.cwd(), PACK_DIRECTORY);
    const text = readdirSync(bundledDirectory)
      .filter((file): boolean => file.endsWith(".json"))
      .map((file): string => readFileSync(join(bundledDirectory, file), "utf8"))
      .join("\n");
    const unused = PLACEHOLDERS.filter(
      (placeholder): boolean => !text.includes(placeholder.token),
    ).map((placeholder): string => placeholder.token);
    expect(unused).toEqual([]);
  });

  it("gives every token a kind and a one-line meaning, and no duplicates", () => {
    const tokens = PLACEHOLDERS.map((placeholder): string => placeholder.token);
    expect(new Set(tokens).size).toBe(tokens.length);
    expect([...tokens]).toEqual([...tokens].sort());
    for (const placeholder of PLACEHOLDERS) {
      expect(placeholder.token, placeholder.token).toMatch(/^\{[A-Za-z][A-Za-z0-9]*\}$/);
      expect(placeholder.meaning.length, placeholder.token).toBeGreaterThan(20);
      expect(["host-conditional", "declaration-supplied"]).toContain(placeholder.kind);
    }
    // EXACTLY ONE is host-conditional, and a second would be a design change
    // rather than a data change: every other difference between hosts is a
    // difference between repositories, and a repository states its own.
    expect(
      PLACEHOLDERS.filter((placeholder): boolean => placeholder.kind === "host-conditional").length,
    ).toBe(1);
  });

  // ── the host-conditional token's two spellings, as data ───────────────────
  //
  // They are the ONE value this file may contribute to a command, and only
  // because they are not a value at all in the sense `kind` forbids: they are
  // how one host spells a file the repository itself committed. `../shu/
  // detect.ts` reads them so that the two spellings live in one place, cited,
  // rather than being typed a second time into the module that substitutes
  // them -- where they would be a build-system literal in the one file the
  // family lets carry filesystem knowledge.

  it("gives a spelling to EXACTLY the host-conditional tokens, and to no other", () => {
    for (const placeholder of PLACEHOLDERS) {
      expect(placeholder.hostSpelling !== undefined, placeholder.token).toBe(
        placeholder.kind === "host-conditional",
      );
    }
  });

  it("gives that spelling two different words and a source", () => {
    for (const placeholder of PLACEHOLDERS) {
      const spelling = placeholder.hostSpelling;
      if (spelling === undefined) continue;
      // TWO DIFFERENT WORDS IS THE POINT. A `hostSpelling` whose halves agreed
      // would be a token that is not host-conditional at all, and the one
      // mutant a POSIX-only suite cannot see is exactly the one that makes them
      // agree.
      expect(spelling.posix, placeholder.token).not.toBe(spelling.win32);
      for (const value of [spelling.posix, spelling.win32]) {
        expect(value.length, placeholder.token).toBeGreaterThan(0);
        // A spelling is a word to RUN, never a token to substitute again.
        expect(value, placeholder.token).not.toMatch(/[{}]/);
      }
      expect(spelling.source.length, placeholder.token).toBeGreaterThan(20);
      // And the meaning must still SAY both, because the rendered page shows
      // the meaning and a reader of it never sees this field.
      expect(placeholder.meaning, placeholder.token).toContain(spelling.posix);
      expect(placeholder.meaning, placeholder.token).toContain(spelling.win32);
    }
  });

  it("answers win32 with one spelling and every other platform with the other", () => {
    for (const placeholder of PLACEHOLDERS) {
      const spelling = placeholder.hostSpelling;
      if (spelling === undefined) {
        expect(spellOnHost(placeholder, "linux"), placeholder.token).toBeNull();
        continue;
      }
      expect(spellOnHost(placeholder, "win32")).toBe(spelling.win32);
      // THE SPLIT IS WINDOWS VERSUS EVERYTHING ELSE, not a list of three names
      // -- a list would answer nothing on the fourth platform Node reports.
      for (const platform of ["darwin", "linux", "freebsd", "openbsd", "aix"]) {
        expect(spellOnHost(placeholder, platform), platform).toBe(spelling.posix);
      }
    }
  });

  it("refuses an unknown token in an argv, naming the file, the field and it", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: {
            exe: "e",
            argv: ["--out", "{someUnknownPlaceholder}"],
            why: "w",
            source: "s",
          },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.path).toBe(AT);
    expect(error.pointer).toBe("verbs.build.argv[1]");
    expect(error.message).toContain("{someUnknownPlaceholder}");
    expect(error.message).toContain("CLOSED set");
    // It lists the set, which is the answer to "then what should I have written".
    expect(error.message).toContain("{gw}");
  });

  it("refuses an unknown token in an exe, a step and a toolchain probe", () => {
    // ALL THREE POSITIONS, because the review found one in a `toolchain.probe`
    // and a rule that only covered verb argvs would have missed it.
    expect(
      refusal(() =>
        parseProfile(AT, "example", VERBS, profile({
          verbs: {
            build: { exe: "{nope}", argv: ["--version"], why: "w", source: "s" },
            test: { unsupported: "n", summary: "n", source: "s" },
          },
        })),
      ).pointer,
    ).toBe("verbs.build.exe");

    expect(
      refusal(() =>
        parseProfile(AT, "example", VERBS, profile({
          verbs: {
            build: {
              steps: [{ exe: "e", argv: ["{nope}"] }],
              why: "w",
              source: "s",
            },
            test: { unsupported: "n", summary: "n", source: "s" },
          },
        })),
      ).pointer,
    ).toBe("verbs.build.steps[0].argv[0]");

    expect(
      refusal(() =>
        parseProfile(AT, "example", VERBS, profile({
          toolchain: {
            node: {
              minimum: null,
              probe: ["node", "{nope}"],
              versionFrom: "first-semver-on-stdout",
              installer: "verify-only",
              why: "w",
              source: "s",
            },
          },
        })),
      ).pointer,
    ).toBe("toolchain.node.probe[1]");
  });

  it("accepts a documented token, and leaves an unmatched brace alone", () => {
    const parsed = parseProfile(AT, "example", VERBS, profile({
      verbs: {
        build: { exe: "{gw}", argv: ["id={simUdid}"], why: "w", source: "s" },
        test: { unsupported: "n", summary: "n", source: "s" },
      },
    }));
    const cell = parsed.verbs["build"];
    expect(cell?.kind).toBe("command");
    // An argv is DATA, not a template language: a lone `{` is a brace some tool
    // wanted, and refusing it would be this loader inventing syntax for shells
    // it does not run.
    expect(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { exe: "awk", argv: ["{ print $1 "], why: "w", source: "s" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    ).not.toThrow();
  });

  it("does not hold a marker's brace GLOB to the placeholder set", () => {
    // `settings.gradle{,.kts}` and `*.config.{js,mjs,ts}` are globs -- a
    // different language that happens to share a delimiter. Three shipped
    // markers use one, and refusing them would enforce a rule about commands
    // against something that is not a command.
    const parsed = parseProfile(AT, "example", VERBS, profile({
      markers: [{ pattern: "settings.gradle{,.kts}", contains: null, why: "the build file" }],
    }));
    expect(parsed.markers[0]?.pattern).toBe("settings.gradle{,.kts}");
  });
});

describe("profileById", () => {
  it("names every id it does carry when asked for one it does not", () => {
    const pack = loadProfilesPack();
    const error = refusal(() => profileById(pack, "no-such-stack"));
    expect(error.message).toContain("no-such-stack");
    for (const id of pack.ids) expect(error.message).toContain(id);
  });
});
