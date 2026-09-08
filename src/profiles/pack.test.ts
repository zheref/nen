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
  profileById,
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

  it("refuses a summary on a cell the grid never abbreviates", () => {
    const error = refusal(() =>
      parseProfile(AT, "example", VERBS, profile({
        verbs: {
          build: { exe: "e", argv: ["a"], why: "w", source: "s", summary: "never read" },
          test: { unsupported: "n", summary: "n", source: "s" },
        },
      })),
    );
    expect(error.pointer).toBe("verbs.build.summary");
    expect(error.message).toContain("would never be read");
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

  it("refuses an index listing no profile, and one listing no verb", () => {
    expect(refusal(() => parsePackIndex(AT, { profiles: [], verbs: ["build"] })).pointer).toBe("profiles");
    expect(refusal(() => parsePackIndex(AT, { profiles: ["a"], verbs: [] })).pointer).toBe("verbs");
  });

  it("refuses a duplicated id or verb in the index", () => {
    expect(
      refusal(() => parsePackIndex(AT, { profiles: ["a", "a"], verbs: ["build"] })).message,
    ).toContain("'a' more than once");
    expect(
      refusal(() => parsePackIndex(AT, { profiles: ["a"], verbs: ["build", "build"] })).message,
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
      [PACK_INDEX_FILE]: { profiles: ["example"], verbs: [...VERBS] },
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
      [PACK_INDEX_FILE]: { profiles: ["example"], verbs: [...VERBS, "lint"] },
      "example.json": profile(),
    });
    const error = refusal(() => loadProfilesPack(dir));
    expect(error.path).toBe(join(dir, "example.json"));
    expect(error.pointer).toBe("verbs");
    expect(error.message).toContain("missing [lint]");
  });

  it("names the missing file when a listed profile is not there", () => {
    const dir = writePack({ [PACK_INDEX_FILE]: { profiles: ["absent"], verbs: [...VERBS] } });
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
});

describe("profileById", () => {
  it("names every id it does carry when asked for one it does not", () => {
    const pack = loadProfilesPack();
    const error = refusal(() => profileById(pack, "no-such-stack"));
    expect(error.message).toContain("no-such-stack");
    for (const id of pack.ids) expect(error.message).toContain(id);
  });
});
