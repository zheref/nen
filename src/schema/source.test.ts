import { describe, expect, it } from "vitest";
import { chmodSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BANKAI_REPO, LEGACY_REPO } from "./fixtures/paths.js";
import { SchemaError } from "./errors.js";
import {
  COLORS_FILE,
  CONTRACT_FILE,
  GATES_FILE,
  inspectShadow,
  LABELS_FILE,
  readSchemaFile,
  readSchemaJson,
  resolveSchemaFile,
  schemaPath,
} from "./source.js";
import { ABSENT_FILE_MARKER } from "./taxonomy.js";

// The POSIX-only cases below build entries that CANNOT be built on Windows: a
// self-referential symlink (ELOOP) needs the developer-mode privilege Windows
// gates symlink creation behind, and `chmod 000` is a no-op on a filesystem
// with no POSIX mode bits. They are skipped there rather than weakened,
// because a weakened version of each would assert nothing anywhere.
const POSIX = process.platform !== "win32";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "nen-source-"));
}

function write(root: string, relative: string, text: string): string {
  const path = schemaPath(root, relative);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
  return path;
}

describe("the five canonical constants", () => {
  it("all name the nen/ directory", () => {
    // The constants ARE the contract; a stray `schemas/` here would silently
    // make one file's canonical location the legacy one.
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE, CONTRACT_FILE]) {
      expect(file.startsWith("nen/")).toBe(true);
    }
  });
});

describe("resolveSchemaFile", () => {
  it("prefers nen/ when only nen/ is there", () => {
    const root = scratch();
    const canonical = write(root, LABELS_FILE, "{}");
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.path).toBe(canonical);
    expect(resolved.relative).toBe("nen/labels.json");
    expect(resolved.legacy?.present).toBe(false);
  });

  it("falls back to schemas/ when only schemas/ is there", () => {
    const root = scratch();
    const legacy = write(root, "schemas/labels.json", "{}");
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.location).toBe("schemas");
    expect(resolved.path).toBe(legacy);
    expect(resolved.relative).toBe("schemas/labels.json");
    expect(resolved.canonical.present).toBe(false);
  });

  it("nen/ WINS when both are there -- the order is the whole point of the map", () => {
    // MUTATION GUARD. Swap the precedence in `resolveSchemaFile` and this is
    // the assertion that goes red: a repository that has migrated but not yet
    // deleted the old copy must be served the NEW file, or the migration
    // silently does nothing.
    const root = scratch();
    const canonical = write(root, LABELS_FILE, '{"which":"nen"}');
    write(root, "schemas/labels.json", '{"which":"schemas"}');
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.path).toBe(canonical);
    expect(readSchemaFile(root, LABELS_FILE).text).toBe('{"which":"nen"}');
  });

  it("answers the CANONICAL path when neither is there, because that is the one to create", () => {
    const root = scratch();
    const resolved = resolveSchemaFile(root, GATES_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.path).toBe(schemaPath(root, GATES_FILE));
    expect(resolved.canonical.present).toBe(false);
    expect(resolved.legacy?.present).toBe(false);
  });

  it("gives the FOUR taxonomy files a legacy location and the contract NONE", () => {
    // The legacy map is a record of what released versions of nen actually
    // read, not a naming convention applied to every file in the directory.
    // `nen/contract.json` is new in this line; no release ever looked for it
    // under `schemas/`, so it has no legacy path and every message about it
    // names exactly one location.
    const root = scratch();
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE]) {
      const resolved = resolveSchemaFile(root, file);
      expect(resolved.canonical.relative).toBe(file);
      expect(resolved.legacy, file).not.toBeNull();
      expect(resolved.legacy?.relative.startsWith("schemas/")).toBe(true);
    }
    const contract = resolveSchemaFile(root, CONTRACT_FILE);
    expect(contract.canonical.relative).toBe(CONTRACT_FILE);
    expect(contract.legacy).toBeNull();
  });

  it("claims NOTHING in schemas/ on the contract's behalf, so a foreign file there is not read", () => {
    // REGRESSION GUARD, and the failure it guards is a consumer-facing one.
    // Mapping `nen/contract.json` to a `schemas/` name does not preserve
    // compatibility with anything -- it INVENTS a claim over a filename nen
    // never read -- and a repository that happens to carry its own file of that
    // name would have it parsed as a nen contract and be failed for it, having
    // changed nothing. Whatever else is in `schemas/`, the contract resolves to
    // `nen/contract.json` and is absent.
    const root = scratch();
    write(root, "schemas/stack.json", '{"this":"is not a nen contract"}');
    const resolved = resolveSchemaFile(root, CONTRACT_FILE);
    expect(resolved.location).toBe("nen");
    expect(resolved.relative).toBe(CONTRACT_FILE);
    expect(resolved.legacy).toBeNull();
    expect(resolved.canonical.present).toBe(false);
  });

  it("reads the un-migrated fixture repository entirely through the fallback", () => {
    // The `legacy-repo` fixture is the only thing in this tree keeping the old
    // layout alive; when the map goes in v0.5.0, this test goes with it.
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE]) {
      const resolved = resolveSchemaFile(LEGACY_REPO, file);
      expect(resolved.location, file).toBe("schemas");
      expect(resolved.relative, file).toBe(resolved.legacy?.relative);
    }
  });

  it("reads the migrated fixture repositories entirely from nen/", () => {
    for (const file of [LABELS_FILE, "nen/repos.json", COLORS_FILE, GATES_FILE, CONTRACT_FILE]) {
      expect(resolveSchemaFile(BANKAI_REPO, file).location, file).toBe("nen");
    }
  });
});

describe("inspectShadow", () => {
  it("is 'none' when only one location carries the file", () => {
    const root = scratch();
    write(root, LABELS_FILE, "{}");
    expect(inspectShadow(resolveSchemaFile(root, LABELS_FILE))).toEqual({
      state: "none",
      errno: null,
    });
  });

  it("is 'identical' for a byte-identical leftover", () => {
    const root = scratch();
    write(root, LABELS_FILE, '{"a":1}');
    write(root, "schemas/labels.json", '{"a":1}');
    expect(inspectShadow(resolveSchemaFile(root, LABELS_FILE)).state).toBe("identical");
  });

  it("is 'different' for a leftover whose bytes drifted", () => {
    // MUTATION GUARD. Make the comparison always answer `identical` (or drop
    // it) and this goes red -- the whole reason the check exists is a
    // repository where somebody is still editing the file nen no longer reads.
    const root = scratch();
    write(root, LABELS_FILE, '{"a":1}');
    write(root, "schemas/labels.json", '{"a":2}');
    expect(inspectShadow(resolveSchemaFile(root, LABELS_FILE)).state).toBe("different");
  });

  it("treats whitespace as a difference, because bytes are what nen compared", () => {
    const root = scratch();
    write(root, COLORS_FILE, "categories:\n");
    write(root, "schemas/colors.yml", "categories:\n\n");
    expect(inspectShadow(resolveSchemaFile(root, COLORS_FILE)).state).toBe("different");
  });

  it("treats a CRLF/LF difference as a difference, because the comparison is byte-exact", () => {
    // The state a git checkout produces on its own, via `core.autocrlf` or a
    // `.gitattributes` that covers one directory and not the other. Two files
    // that differ only in line endings are still two files, and calling them
    // identical would tell an operator the deletion is free on evidence that
    // does not support it.
    const root = scratch();
    write(root, COLORS_FILE, "categories:\n");
    write(root, "schemas/colors.yml", "categories:\r\n");
    expect(inspectShadow(resolveSchemaFile(root, COLORS_FILE)).state).toBe("different");
  });
});

describe("inspectShadow, when the comparison cannot be made at all", () => {
  // THE STATE THAT USED TO LIE. A failed read answered `different`, which made
  // `nen schema check` assert three things it did not know -- that the bytes
  // differ, that nen read the `nen/` copy, and that the `schemas/` one is the
  // one to delete. In every case below at least one of those is false, and in
  // the first two the file being nominated for deletion is the only readable
  // copy the repository has left.

  it("answers 'unknown' with an errno when the LEGACY copy will not open", () => {
    const root = scratch();
    write(root, LABELS_FILE, "{}");
    mkdirSync(schemaPath(root, "schemas/labels.json"), { recursive: true });
    const verdict = inspectShadow(resolveSchemaFile(root, LABELS_FILE));
    expect(verdict.state).toBe("unknown");
    // The errno is carried, whatever the host calls it -- it is what turns
    // "could not compare" into something an operator can act on.
    expect(verdict.errno).not.toBeNull();
    if (POSIX) expect(verdict.errno).toBe("EISDIR");
  });

  it("a STRAY FILE named nen is an ABSENCE, uniformly, and never an unknown comparison", () => {
    // THE CASE THAT LOOKS LIKE THE ONES ABOVE AND IS NOT, pinned so the
    // difference is a decision on the record rather than an accident of Node's
    // API. `throwIfNoEntry: false` suppresses ENOTDIR alongside ENOENT, so a
    // path whose `nen` component is a FILE reads as "nothing is there" -- which
    // is the honest answer, since nothing can live under it -- and the fallback
    // answers normally. The same holds on Windows, which reports
    // ERROR_PATH_NOT_FOUND (mapped to ENOENT) where POSIX reports ENOTDIR: two
    // errnos, one behaviour, no platform divergence to account for.
    const root = scratch();
    write(root, "schemas/labels.json", '{"labels":[]}');
    writeFileSync(join(root, "nen"), "not a directory");
    const resolved = resolveSchemaFile(root, LABELS_FILE);
    expect(resolved.canonical.present).toBe(false);
    expect(resolved.location).toBe("schemas");
    expect(inspectShadow(resolved).state).toBe("none");
    expect(readSchemaFile(root, LABELS_FILE).text).toBe('{"labels":[]}');
  });

  it.skipIf(!POSIX)("answers 'unknown' for a symlink that points at itself", () => {
    const root = scratch();
    write(root, "schemas/labels.json", "{}");
    mkdirSync(join(root, "nen"), { recursive: true });
    symlinkSync("labels.json", schemaPath(root, LABELS_FILE));
    const verdict = inspectShadow(resolveSchemaFile(root, LABELS_FILE));
    expect(verdict.state).toBe("unknown");
    expect(verdict.errno).toBe("ELOOP");
  });

  it.skipIf(!POSIX)("answers 'unknown' when the CANONICAL copy is unreadable (EACCES)", () => {
    // chmod is a no-op for root; the assertion is guarded on the mode having
    // actually taken rather than being skipped blind, so it still runs for an
    // ordinary developer and is honest about a root-owned CI container.
    const root = scratch();
    const path = write(root, LABELS_FILE, "{}");
    write(root, "schemas/labels.json", "{}");
    chmodSync(path, 0o000);
    let verdict;
    try {
      verdict = inspectShadow(resolveSchemaFile(root, LABELS_FILE));
    } finally {
      chmodSync(path, 0o644);
    }
    if (verdict.state !== "identical") {
      expect(verdict.state).toBe("unknown");
      expect(verdict.errno).toBe("EACCES");
    }
  });
});

describe("readSchemaFile", () => {
  it("reads a file that is there", () => {
    const root = scratch();
    write(root, LABELS_FILE, "{}");
    const result = readSchemaFile(root, LABELS_FILE);
    expect(result.text).toBe("{}");
    expect(result.path).toBe(schemaPath(root, LABELS_FILE));
    expect(result.location).toBe("nen");
    expect(result.legacy).toBe(false);
  });

  it("records that a read came from the LEGACY location", () => {
    const root = scratch();
    write(root, "schemas/labels.json", "{}");
    const result = readSchemaFile(root, LABELS_FILE);
    expect(result.text).toBe("{}");
    expect(result.path).toBe(schemaPath(root, "schemas/labels.json"));
    expect(result.location).toBe("schemas");
    expect(result.legacy).toBe(true);
  });

  it("phrases an ABSENT file with the marker checkTaxonomy branches on", () => {
    // LOAD-BEARING WORDING, not prose. `checkTaxonomy` distinguishes "the file
    // is not there" (tolerable for an optional schema) from "the file is there
    // and is wrong" (never tolerable) by looking for this marker. If the ENOENT
    // message is ever reworded without updating ABSENT_FILE_MARKER, a CORRUPT
    // optional schema would start reporting as merely absent and stop failing
    // the report -- silently, which is the whole failure class this repository's
    // loaders exist to avoid.
    //
    // TWO CANDIDATE PATHS, STILL ONE SENTENCE. The fallback added a second
    // place to look; it must not add a second ENOENT message, or the marker
    // stops being a reliable discriminator.
    const root = scratch();
    try {
      readSchemaFile(root, LABELS_FILE);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      const message = (error as SchemaError).message;
      expect(message).toContain(ABSENT_FILE_MARKER);
      expect(message.split(ABSENT_FILE_MARKER).length - 1).toBe(1);
      // BOTH locations are named, so an operator who has not migrated is not
      // told to create a file they already have.
      expect(message).toContain("'nen/labels.json'");
      expect(message).toContain("'schemas/labels.json'");
      expect(message).toContain("v0.5.0");
      // and it stays actionable
      expect(message).toMatch(/--repo/);
      expect(message).toMatch(/no built-in copy/);
      // The path the error CARRIES is the canonical one -- the file to add.
      expect((error as SchemaError).path).toBe(schemaPath(root, LABELS_FILE));
    }
  });

  it("does NOT carry the absent marker for a file that is present but unreadable", () => {
    // A directory where a file belongs: present, unreadable, and therefore a
    // different finding from absent.
    const root = scratch();
    mkdirSync(schemaPath(root, LABELS_FILE), { recursive: true });
    try {
      readSchemaFile(root, LABELS_FILE);
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(SchemaError);
      expect((error as SchemaError).message).not.toContain(ABSENT_FILE_MARKER);
    }
  });

  it("does NOT fall through to schemas/ when nen/ is present and broken", () => {
    // `nen/` winning means winning even when it loses: a directory (or an
    // unreadable file) where `nen/labels.json` belongs is a defect to report,
    // not a reason to quietly serve the legacy copy.
    const root = scratch();
    mkdirSync(schemaPath(root, LABELS_FILE), { recursive: true });
    write(root, "schemas/labels.json", "{}");
    try {
      readSchemaFile(root, LABELS_FILE);
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).message).toMatch(/found a directory/);
      expect((error as SchemaError).path).toBe(schemaPath(root, LABELS_FILE));
    }
  });

  it.skipIf(!POSIX)(
    "A THROW COUNTS AS PRESENT: an unreadable nen/ copy fails loudly, it does not fall back",
    () => {
      // THE MUTATION GUARD FOR THE FALLBACK'S SAFETY, not for `isPresent`'s
      // catch specifically -- `lstatSync` does not follow a symlink, so a
      // SELF-REFERENTIAL `nen/labels.json` is stat'able (it exists, as a
      // symlink) and `isPresent` answers `true` from its SUCCESS branch, not
      // its catch. What this still guards is what happens next: the cycle is
      // still there, so the read below still throws ELOOP, and that failure
      // must stay loud rather than being swallowed and re-routed to
      // `schemas/`. (The DANGLING-symlink test below is the one that actually
      // exercises `isPresent`'s catch branch and its ENOTDIR fold-in.)
      //
      // Route `isPresent` back through `statSync` and nothing else in the
      // suite notices -- while a repository whose `nen/labels.json` is an
      // ELOOP symlink starts being served the STALE `schemas/` taxonomy,
      // silently, at exit 0. That is the exact failure the fallback was most
      // likely to introduce and the one it was designed not to have: a broken
      // canonical file is a defect to report, never a reason to quietly read
      // the old one.
      //
      // A SELF-REFERENTIAL SYMLINK is the cheapest portable way to build an
      // entry whose READ, not whose stat, fails with a cycle. Windows is
      // skipped because creating a symlink there needs a privilege ordinary CI
      // does not hold.
      const root = scratch();
      const legacy = write(root, "schemas/labels.json", '{"which":"stale schemas copy"}');
      mkdirSync(join(root, "nen"), { recursive: true });
      symlinkSync("labels.json", schemaPath(root, LABELS_FILE));

      const resolved = resolveSchemaFile(root, LABELS_FILE);
      expect(resolved.canonical.present).toBe(true);
      expect(resolved.location).toBe("nen");
      expect(resolved.path).not.toBe(legacy);

      try {
        readSchemaFile(root, LABELS_FILE);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaError);
        const message = (error as SchemaError).message;
        // The real errno, not an absence -- and emphatically not the legacy
        // file's contents returned as though nothing were wrong.
        expect(message).toContain("ELOOP");
        expect(message).not.toContain(ABSENT_FILE_MARKER);
        expect((error as SchemaError).path).toBe(schemaPath(root, LABELS_FILE));
      }
    },
  );

  it.skipIf(!POSIX)(
    "A DANGLING symlink counts as present too: it fails loudly with ENOENT, it does not fall back",
    () => {
      // THE FAILURE THIS FIX CLOSES, alongside the ELOOP case above. `statSync`
      // follows a symlink to its target; a `nen/labels.json` that points at a
      // file which does not exist resolved, under `statSync`, to a plain ENOENT
      // on the TARGET -- suppressed by `throwIfNoEntry: false` exactly like a
      // genuinely missing entry, so the dangling symlink read as ABSENT and the
      // resolver silently served the stale `schemas/` copy: the exact
      // stale-taxonomy failure the "a throw counts as present" rule exists to
      // prevent, reached by a path that rule did not cover. `lstatSync` stats
      // the symlink ITSELF, which is there no matter what it points to, so it
      // now counts as present and `nen/` still wins; the read below is what
      // follows the link, and it still reports the real ENOENT -- loudly,
      // naming `nen/labels.json`, and still actionable (`--repo`, "add the
      // file") rather than silently returning the legacy text.
      //
      // Revert `isPresent` to `statSync` and this goes red: `resolved.location`
      // becomes `"schemas"`, and `readSchemaFile` returns the stale legacy text
      // instead of throwing.
      //
      // Windows is skipped for the same reason as the ELOOP test above:
      // creating a symlink there needs a privilege ordinary CI does not hold.
      const root = scratch();
      write(root, "schemas/labels.json", '{"which":"stale schemas copy"}');
      mkdirSync(join(root, "nen"), { recursive: true });
      symlinkSync("does-not-exist.json", schemaPath(root, LABELS_FILE));

      const resolved = resolveSchemaFile(root, LABELS_FILE);
      expect(resolved.canonical.present).toBe(true);
      expect(resolved.location).toBe("nen");

      try {
        readSchemaFile(root, LABELS_FILE);
        expect.unreachable();
      } catch (error) {
        expect(error).toBeInstanceOf(SchemaError);
        const message = (error as SchemaError).message;
        // Loud and actionable, not a silent fallback: the standard "no such
        // file" phrasing, naming the nen/ path, still pointing at --repo.
        expect(message).toContain(ABSENT_FILE_MARKER);
        expect(message).toContain("'nen/labels.json'");
        expect(message).toMatch(/--repo/);
        expect((error as SchemaError).path).toBe(schemaPath(root, LABELS_FILE));
      }
    },
  );

  it("reports an unreadable file by its errno rather than as an absence", () => {
    // chmod is a no-op for root and on Windows; the assertion below only runs
    // where the mode actually takes.
    const root = scratch();
    const path = write(root, LABELS_FILE, "{}");
    chmodSync(path, 0o000);
    let message: string | null = null;
    try {
      readSchemaFile(root, LABELS_FILE);
    } catch (error) {
      message = (error as SchemaError).message;
    } finally {
      chmodSync(path, 0o644);
    }
    if (message !== null) {
      expect(message).toContain("could not be read");
      expect(message).not.toContain(ABSENT_FILE_MARKER);
    }
  });
});

describe("readSchemaJson", () => {
  it("reports malformed JSON as itself, not as an absent file", () => {
    const root = scratch();
    write(root, "nen/repos.json", "{ not json");
    try {
      readSchemaJson(root, "nen/repos.json");
      expect.unreachable();
    } catch (error) {
      expect((error as SchemaError).message).toMatch(/not valid JSON/);
      expect((error as SchemaError).message).not.toContain(ABSENT_FILE_MARKER);
    }
  });

  it("carries the read's location through to the caller", () => {
    const root = scratch();
    write(root, "schemas/repos.json", "{}");
    expect(readSchemaJson(root, "nen/repos.json").location).toBe("schemas");
  });
});
